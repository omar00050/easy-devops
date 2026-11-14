import { createServer } from 'http';
import { createRequire } from 'module';
import express from 'express';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import session from 'express-session';
import { loadConfig, UI_MODES } from '../core/config.js';
import { dbGet, dbSet, closeDb } from '../core/db.js';
import { getDataDir, isDevDataDir } from '../core/platform.js';
import authRouter from './routes/auth.js';
import domainsRouter from './routes/domains.js';
import sslRouter from './routes/ssl.js';
import nginxRouter from './routes/nginx.js';
import settingsRouter from './routes/settings.js';
import hubRouter from './routes/hub.js';
import processesRouter from './routes/processes.js';
import { stopSslController } from './controllers/sslController.js';
import { initSocket, stopSocket } from './socketManager.js';
import { requireLocalRequest } from './lib/localRequest.js';
import { startJobs } from '../core/jobs/index.js';
import { startDaemonBridge, daemonStatus } from './lib/daemonBridge.js';

const require = createRequire(import.meta.url);
const FileStore = require('session-file-store')(session);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// EJS view engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json({ limit: '1mb' }));

// ─── Session secret — generated once, persisted in SQLite ────────────────────
let sessionSecret = dbGet('session_secret');
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  dbSet('session_secret', sessionSecret);
}

// Sessions stored on disk so they survive restarts. Same data directory as the
// database and logs — see getDataDir() in core/platform.js.
const SESSION_DIR = path.join(getDataDir(), 'sessions');

// Kept in a variable so shutdown() can stop its expired-session reaper, which
// is an un-unref'd setInterval that would otherwise hold the event loop open.
const sessionStore = new FileStore({ path: SESSION_DIR, retries: 1, logFn() {} });

// Kept in a variable so Socket.io can run the SAME middleware and therefore
// see the same session. Without it, a socket connection has no session to
// authenticate against and the dashboard's live data would be unprotected
// even though every HTTP route is not.
const sessionMiddleware = session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
  },
});

app.use(sessionMiddleware);

// ─── Listener configuration ───────────────────────────────────────────────────

const startupConfig = loadConfig();
const { dashboardPort, dashboardBindAddress } = startupConfig;
const port = Number(process.env.DASHBOARD_PORT) || dashboardPort;

// Which interfaces to accept connections on. New Linux installs default to
// loopback only; existing installs keep listening on every interface, so an
// upgrade cannot silently cut off a dashboard someone reaches over the
// network. See core/config.js.
const bindAddress = process.env.DASHBOARD_BIND_ADDRESS?.trim() || dashboardBindAddress;

/** The port actually bound, known only once listening (tests may pass 0). */
let boundPort = null;

/**
 * What the local-request guard should enforce right now.
 *
 * The bind address is re-read from the config on every call rather than taken
 * from the startup value, so changing it in Settings takes effect for the
 * guard immediately instead of waiting for a restart. When the two disagree —
 * the setting has changed but the listener has not been rebound yet — the
 * config value is the user's stated intent, and erring toward the stricter
 * loopback rule is the safe direction.
 */
function currentBinding() {
  let configured = bindAddress;
  try {
    configured = loadConfig().dashboardBindAddress ?? bindAddress;
  } catch { /* unreadable config: fall back to what we started with */ }

  return { port: boundPort ?? port, bindAddress: configured };
}

// ─── Which UI is served at / ─────────────────────────────────────────────────
//
// The React build in dist/ui is THE dashboard. The classic EJS + Vue page is
// kept only as a temporary fallback, reachable by `--classic-ui` for one run
// or `dashboardUi: "classic"` as a setting. The flag wins, being the one-run
// override.
//
// This reverses the earlier default. It changed because the new UI is now the
// one being developed against docs/api-contract.md, and leaving the old page
// as the default meant every new install started on the implementation that is
// no longer maintained. The EJS files stay in the tree: an operator who hits a
// regression in the new UI needs a working dashboard in the same minute, not
// in the next release.
//
// The build is produced at publish time (npm run build:ui) and is not required
// to run from a source checkout, so a MISSING build falls back to classic with
// the build command printed, rather than failing to start. Falling back keeps
// the dashboard reachable, which matters most in the middle of an upgrade.
const uiDistDir = process.env.EASY_DEVOPS_UI_DIST?.trim() ||
  path.resolve(__dirname, '..', '..', 'dist', 'ui');
const uiIndexFile = path.join(uiDistDir, 'index.html');

const classicFlagRequested = process.env.EASY_DEVOPS_CLASSIC_UI === '1';
const classicRequested = classicFlagRequested || startupConfig.dashboardUi === UI_MODES.CLASSIC;
const classicRequestedBy = classicFlagRequested ? '--classic-ui' : 'the dashboardUi setting';

const uiBuilt = fs.existsSync(uiIndexFile);
const servingNewUi = !classicRequested && uiBuilt;

if (classicRequested) {
  process.stdout.write(
    `\nServing the classic dashboard (requested by ${classicRequestedBy}).\n` +
    '  It is a temporary fallback and will be removed in a future release.\n\n'
  );
} else if (!uiBuilt) {
  process.stderr.write(
    '\nThe dashboard UI is not built:\n' +
    `  ${uiIndexFile}\n` +
    '  Build it with: npm run build:ui\n' +
    '  Serving the classic dashboard for this run.\n\n'
  );
}

// Static files - disable index serving so the classic EJS page handles root.
// Kept in both modes: the React build reuses /img assets from here.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/**
 * Host / Origin / X-EZ-Request checks, on EVERY /api route including the
 * public auth ones.
 *
 * Mounted before the routers so no endpoint can be added later that misses
 * it, and above requireAuth because it answers a different question: not
 * "who are you" but "may this request be made from where it came from".
 * A password never defended against a hostile page in another browser tab;
 * this does, in both auth modes.
 *
 * The binding is read per request so a settings change does not leave a stale
 * rule in place until restart.
 */
app.use('/api', requireLocalRequest(currentBinding));

app.use('/api', authRouter);
app.use('/api/domains', domainsRouter);
app.use('/api/ssl', sslRouter);
app.use('/api/nginx', nginxRouter);
app.use('/api', settingsRouter);
app.use('/api/hub', hubRouter);
app.use('/api', processesRouter);

if (servingNewUi) {
  // Hashed Vite assets are immutable; index.html is served with no-cache
  // below, so a rebuilt bundle is picked up on the next page load.
  app.use(express.static(uiDistDir, { index: false, maxAge: '1y', immutable: true }));

  // Client-side routes such as /#/domains arrive here as GET / and are
  // handled by the static index. A real path (/domains/example.com) gets the
  // same index.html so the app can resolve it. Static files above win first,
  // and /api and /socket.io never reach this point with a routed request.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile(uiIndexFile, { headers: { 'Cache-Control': 'no-cache' } });
  });
} else {
  // Render EJS template for all other routes
  app.use((req, res) => res.render('index'));
}

// ─── HTTP server + Socket.io ──────────────────────────────────────────────────

const httpServer = createServer(app);
initSocket(httpServer, sessionMiddleware, currentBinding);

// ─── Background jobs ──────────────────────────────────────────────────────────
//
// The dashboard is a STANDBY runner: it does the monitoring, notifications and
// Hub work only while no daemon is running, and hands them over within one
// poll of one appearing (core/jobs/index.js). The hub agent is part of that
// hand-over, which is why it is no longer started here — two agents on one
// pairing would execute every Hub command twice.
//
// The bridge is started unconditionally: when a daemon exists it carries the
// daemon's events onto this process's bus, and when one does not it retries
// quietly and connects if the user installs the service later.
// The bridge starts FIRST so the jobs' first ownership change can already be
// announced to the browser through it. It also means the lock watcher is in
// place before anything else looks at the lock.
const daemonLink = startDaemonBridge();

const jobs = startJobs({
  role: 'dashboard',
  onChange(state) {
    process.stdout.write(
      state.running
        ? `Background jobs: running in this dashboard (${state.reason})\n`
        : `Background jobs: not run here - ${state.reason}\n`,
    );

    // Who owns the jobs is part of the state the UI shows, so a hand-over in
    // either direction reaches open tabs immediately rather than on their next
    // poll of GET /api/service.
    daemonLink.announce();
  },
});

// ─── Start ────────────────────────────────────────────────────────────────────

// Resolved above the router mounts, which need them for the local-request
// guard. `boundPort` is filled in once the server is listening, because a
// port of 0 (tests) is only known then.

/** Resolves with the port actually bound, once the server is listening. */
const whenListening = new Promise((resolve, reject) => {
  httpServer.once('error', reject);
  httpServer.listen(port, bindAddress, () => {
    const bound = httpServer.address()?.port ?? port;
    boundPort = bound;
    if (isDevDataDir()) {
      process.stdout.write(`DEV MODE (data: ${getDataDir()})\n`);
    }
    process.stdout.write(`Dashboard running on port ${bound} (bound to ${bindAddress})\n`);
    process.stdout.write(
      servingNewUi
        ? `Dashboard UI: new (${uiDistDir})\n`
        : 'Dashboard UI: classic (EJS)\n'
    );
    resolve(bound);
  });
});

// ─── Shutdown ─────────────────────────────────────────────────────────────────

let shutdownPromise = null;

/**
 * Releases everything this module started: the HTTP server, the Socket.io
 * polling intervals and log tails, the hub agent, and the SQLite handle.
 *
 * Idempotent — concurrent or repeated calls (a second Ctrl+C during shutdown)
 * return the same promise and never double-close.
 *
 * @returns {Promise<void>}
 */
function shutdown() {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    // Stop accepting connections first so nothing new arrives mid-teardown.
    await new Promise((resolve) => {
      if (!httpServer.listening) return resolve();
      httpServer.close(() => resolve());
    });

    try { await stopSocket(); } catch { /* already down */ }
    try { daemonLink.stop(); } catch { /* never connected */ }
    // Stops the monitors, the revision watcher and the hub agent together, and
    // is a no-op when a daemon owns them.
    try { await jobs.stop(); } catch { /* already stopped */ }
    try { stopSslController(); } catch { /* nothing pending */ }

    // session-file-store schedules an expired-session reaper with setInterval
    // and offers no stop API; the handle is exposed on its options.
    try {
      const reaper = sessionStore?.options?.reapIntervalObject;
      if (reaper) {
        clearInterval(reaper);
        sessionStore.options.reapIntervalObject = null;
      }
    } catch { /* nothing to clear */ }

    try { closeDb(); } catch { /* already closed */ }
  })();

  return shutdownPromise;
}

export { app, httpServer, whenListening, shutdown, daemonStatus };
