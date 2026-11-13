import { createServer } from 'http';
import { createRequire } from 'module';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import session from 'express-session';
import { loadConfig } from '../core/config.js';
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
import { initHubAgent, stopHubAgent } from './lib/hubAgent.js';

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

const { dashboardPort, dashboardBindAddress } = loadConfig();
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

// Static files - disable index serving so EJS handles root
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

// Render EJS template for all other routes
app.use((req, res) => res.render('index'));

// ─── HTTP server + Socket.io ──────────────────────────────────────────────────

const httpServer = createServer(app);
initSocket(httpServer, sessionMiddleware, currentBinding);

// Start hub agent if a link is configured
initHubAgent();

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
    try { stopHubAgent(); } catch { /* not linked */ }
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

export { app, httpServer, whenListening, shutdown };
