import { createServer } from 'http';
import express from 'express';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import session from 'express-session';
import { loadConfig, UI_MODES, BIND_LOOPBACK, isLoopbackBind } from '../core/config.js';
import { dbGet, dbSet, closeDb } from '../core/db.js';
import { getDataDir, isDevDataDir, TEST_MODE_ENV } from '../core/platform.js';
import authRouter from './routes/auth.js';
import domainsRouter from './routes/domains.js';
import sslRouter from './routes/ssl.js';
import nginxRouter from './routes/nginx.js';
import settingsRouter from './routes/settings.js';
import hubRouter from './routes/hub.js';
import processesRouter from './routes/processes.js';
import deploymentsRouter from './routes/deployments.js';
import updateRouter from './routes/update.js';
import { ensureCode as ensureSetupCode, describe as describeSetupCode } from '../core/setupCode.js';
import { warmProbes } from './controllers/processesController.js';
import { stopSslController } from './controllers/sslController.js';
import { initSocket, stopSocket } from './socketManager.js';
import { requireLocalRequest, isLoopbackAddress } from './lib/localRequest.js';
import { SessionFileStore } from './lib/sessionStore.js';
import { startJobs } from '../core/jobs/index.js';
import { startDaemonBridge, daemonStatus } from './lib/daemonBridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// EJS view engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json({ limit: '1mb' }));

// ─── Listener configuration ───────────────────────────────────────────────────

const startupConfig = loadConfig();
const { dashboardPort, dashboardBindAddress } = startupConfig;
const port = Number(process.env.DASHBOARD_PORT) || dashboardPort;
const requestedBindAddress = process.env.DASHBOARD_BIND_ADDRESS?.trim() || dashboardBindAddress;

// The dashboard has no TLS listener of its own. It therefore always binds to
// loopback; remote operators reach it through an HTTPS reverse proxy or secure
// tunnel running on this machine. Ignoring a stale service environment value
// as well as a stale database keeps this true after an upgrade.
const bindAddress = isLoopbackBind(requestedBindAddress) ? requestedBindAddress : BIND_LOOPBACK;
const droppedUnsafeBind = requestedBindAddress !== bindAddress;

// Only a loopback peer is a trusted TLS terminator. This lets express-session,
// req.secure, the login rate limiter and the local-request guard see the real
// HTTPS scheme and client address from a local proxy without allowing a direct
// remote client to spoof X-Forwarded-* headers.
app.set('trust proxy', (address) => isLoopbackAddress(address));

// ─── Session secret — generated once, persisted in SQLite ────────────────────
let sessionSecret = dbGet('session_secret');
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  dbSet('session_secret', sessionSecret);
}

// Sessions stored on disk so they survive restarts. Same data directory as the
// database and logs — see getDataDir() in core/platform.js. Same folder, file
// name and JSON shape as session-file-store, so sessions written before this
// store existed keep loading; only the write goes through core/atomicState.js,
// which retries the Windows EPERM/EBUSY/EACCES a rename meets here.
const SESSION_DIR = path.join(getDataDir(), 'sessions');

// Kept in a variable so shutdown() can clear its expired-session reaper.
const sessionStore = new SessionFileStore({ path: SESSION_DIR, retries: 1, logFn() {} });

// Kept in a variable so Socket.io can run the SAME middleware and therefore
// see the same session. Without it, a socket connection has no session to
// authenticate against and the dashboard's live data would be unprotected
// even though every HTTP route is not.
const sessionMiddleware = session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // express-session emits Secure when req.secure is true. `auto` therefore
    // protects proxied HTTPS without making loopback HTTP development unusable.
    secure: 'auto',
  },
});

app.use(sessionMiddleware);

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
  return { port: boundPort ?? port, bindAddress };
}

// ─── Which UI is served at / ─────────────────────────────────────────────────
//
// The React build in dist/ui is THE dashboard. The classic EJS + Vue page is
// kept only as a temporary fallback, reachable by `--classic-ui` for one run
// or `dashboardUi: "classic"` as a setting. The flag wins, being the one-run
// override.
//
// This reverses the earlier default. It changed because the new UI is now the
// one being developed against API-CONTRACT.md, and leaving the old page
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

// Static files for the classic page (its Vue bundle, /img assets). Index
// serving is off in both modes so the route that serves root decides which UI
// answers. The React build reuses /img assets from here.
//
// No maxAge: the default is `public, max-age=0`, which makes a browser
// revalidate on every use. These files carry no content hash, so a long cache
// would keep serving an old bundle after an upgrade.
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
app.use('/api/deployments', deploymentsRouter);
app.use('/api', updateRouter);

/**
 * True for a build asset whose NAME carries a content hash.
 *
 * Vite writes `assets/index-4f3a9c2b.js`, and the hash changes when the bytes
 * do — which is the only thing that makes a one-year cache safe. Everything
 * else in the build keeps its name across releases (a favicon copied into
 * assets/, and index.html itself) and must be revalidated instead.
 *
 * @param {string} filePath Absolute path the static middleware is serving
 * @returns {boolean}
 */
function isHashedAsset(filePath) {
  const rel = path.relative(uiDistDir, filePath);
  if (!rel.startsWith(`assets${path.sep}`)) return false;
  return /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(path.basename(rel));
}

if (servingNewUi) {
  // Only hashed assets are immutable; every other file in the build (including
  // index.html, requested directly) gets `no-cache`, so a rebuilt bundle is
  // picked up on the next page load. The route below serves index.html for the
  // SPA with the same policy.
  app.use(express.static(uiDistDir, {
    index: false,
    setHeaders(res, filePath) {
      res.setHeader(
        'Cache-Control',
        isHashedAsset(filePath)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      );
    },
  }));

  // Client-side routes such as /#/domains arrive here as GET / and are
  // handled by the static index. A real path (/domains/example.com) gets the
  // same index.html so the app can resolve it. Static files above win first,
  // and /api and /socket.io never reach this point with a routed request.
  //
  // `root` is load-bearing: with an absolute path, send() walks every segment
  // of it as a potential dotfile and answers 404 for any that starts with a
  // dot — a global Bun install lives under ~/.bun, so the built UI would
  // never be served there. Root-relative parts contain no dot segments.
  //
  // A build that disappears after startup would otherwise reach Express's
  // default error handler, which prints a stack trace in the browser. Fall
  // back to the classic page instead, and report it once, not per request.
  let indexErrorReported = false;
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile('index.html', {
      root: uiDistDir,
      headers: { 'Cache-Control': 'no-cache' },
    }, (err) => {
      if (!err) return;
      // Client gone, or the body already started: nothing left to render.
      if (res.headersSent || err.code === 'ECONNABORTED' || err.syscall === 'write') return;
      if (!indexErrorReported) {
        indexErrorReported = true;
        process.stderr.write(
          '\nThe dashboard UI could not be served:\n' +
          `  ${uiIndexFile}\n` +
          `  ${err.message}\n` +
          '  Serving the classic dashboard until it can.\n\n'
        );
      }
      res.render('index', (renderErr, html) => {
        if (renderErr) return next(renderErr);
        res.send(html);
      });
    });
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

/**
 * Prints the first-run setup code, if one is outstanding.
 *
 * Issues one when none is valid, so a dashboard left at the first-run screen
 * for a day is still completable. Prints the cleartext only when THIS process
 * issued it: nothing stores the cleartext, which is the point.
 */
async function announceSetupCode() {
  const state = await ensureSetupCode({ config: loadConfig });
  if (!state.pending) return;
  for (const line of describeSetupCode(state)) process.stdout.write(`${line}\n`);
}

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
    if (droppedUnsafeBind) {
      process.stdout.write(
        `Ignoring non-loopback dashboard bind ${requestedBindAddress}; listening on ${bindAddress}. `
        + 'Use a local HTTPS reverse proxy or secure tunnel for remote access.\n',
      );
    }
    if (startupConfig.dashboardAuthMigration) {
      process.stdout.write(
        'Dashboard authentication was tightened during upgrade: this installation previously '
        + 'allowed network access, so a password is now required. Use the one-time setup code '
        + 'printed below or run `ezz dashboard setup-code`.\n',
      );
    }
    process.stdout.write(`Dashboard running on port ${bound} (bound to ${bindAddress})\n`);
    process.stdout.write(
      servingNewUi
        ? `Dashboard UI: new (${uiDistDir})\n`
        : 'Dashboard UI: classic (EJS)\n'
    );

    // The first-run setup code, while setup is still pending. Printed here
    // because this is the local terminal (or the log file a detached
    // dashboard writes to) - the one place it is allowed to appear. It is
    // never in an API response, a socket event, or anything sent to the Hub.
    //
    // Not awaited: hashing the code takes scrypt-time and the server must not
    // delay listening for it. A failure is reported and nothing else, because
    // a dashboard that cannot print a code must still start.
    // Fill the status probes now, so the first page load finds them already
    // measured. Each one costs a subprocess - about a second each on Windows -
    // and paying for them while someone watches a spinner is what made
    // GET /api/service feel broken. Not awaited: the server is already
    // listening and a warm-up is not a precondition for serving.
    //
    // Not under EZ_TEST. A suite starts and kills dashboards in seconds and
    // never reads a warm answer, so the half-dozen subprocesses per start are
    // pure cost there - and measurably so: they slowed the suite enough to
    // push a latency assertion in another suite over its deadline. The warm
    // path itself is exercised directly in e2e/service-speed.test.mjs.
    if (process.env[TEST_MODE_ENV] !== '1') warmProbes();

    announceSetupCode().catch((err) => {
      process.stderr.write(`[setup] could not prepare the setup code: ${err.message}\n`);
    });

    resolve(bound);
  });
});

// ─── Shutdown ─────────────────────────────────────────────────────────────────

let shutdownPromise = null;

/** How long one step may hold the rest of the teardown up. */
const SHUTDOWN_SOCKET_MS = 1500;
const SHUTDOWN_HTTP_MS = 1000;
const SHUTDOWN_JOBS_MS = 700;

/** Grace for an in-flight request before every connection is dropped. */
const SHUTDOWN_FORCE_CLOSE_MS = 500;

/** A timer that never keeps the process alive by itself. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Runs one teardown step, giving up on it after `ms`.
 *
 * The step is not cancelled — nothing here can cancel socket.io's own close —
 * but the shutdown moves on, so one wedged client cannot use up the CLI's five
 * seconds and end the process with "Shutdown timed out".
 *
 * @param {() => (void|Promise<void>)} step
 * @param {number} ms
 * @param {string} label Named in the log line, so the next report says which step
 */
async function timeBox(step, ms, label) {
  let run;
  try {
    // Started NOW, not on a microtask: the caller relies on socket.io being
    // told to close before anything else touches the listener.
    run = Promise.resolve(step()).catch(() => { /* already down */ });
  } catch {
    run = Promise.resolve();
  }

  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => {
      process.stderr.write(
        `[shutdown] ${label} did not finish within ${ms} ms; stopping the rest anyway.\n`,
      );
      resolve();
    }, ms);
    timer.unref?.();
  });

  try {
    await Promise.race([run, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Closes the listener and whatever is still connected to it.
 *
 * Node's `server.close()` only stops new connections: an idle keep-alive
 * connection (Node 18, the engines floor) or a request whose body never
 * arrives keeps it pending forever. `closeIdleConnections()` drops the first at
 * once; `closeAllConnections()` after a short grace drops the second, so a
 * stalled upload cannot outlive the operator's patience.
 *
 * `listening` is already false when socket.io got here first — its own
 * `io.close()` closes the listener it was attached to — but the connections
 * that close is waiting for still have to go, so the connection sweep runs
 * whether or not the listener is still ours to close.
 */
async function closeListener() {
  const closed = new Promise((resolve) => {
    if (!httpServer.listening) return resolve();
    httpServer.close(() => resolve());
  });

  try { httpServer.closeIdleConnections?.(); } catch { /* not on this Node */ }

  const force = setTimeout(() => {
    try { httpServer.closeAllConnections?.(); } catch { /* not on this Node */ }
  }, SHUTDOWN_FORCE_CLOSE_MS);
  force.unref?.();

  await Promise.race([closed, delay(SHUTDOWN_HTTP_MS)]);
  clearTimeout(force);

  // The listener may have belonged to socket.io's own close; make certain no
  // connection is left holding whatever finish callback it is waiting on.
  try { httpServer.closeAllConnections?.(); } catch { /* not on this Node */ }
}

/**
 * Stops the expired-session reaper session-file-store scheduled.
 *
 * It is `.unref()`ed in session-file-store 1.5.0, so it never held the event
 * loop open — the interval is cleared here only so no reap runs against a store
 * that is being closed. Called first, synchronously: the old place for it was
 * after the awaited listener close, which is exactly the await that hung, so it
 * never ran on the shutdown this bug report is about.
 */
function stopSessionReaper() {
  try {
    const reaper = sessionStore?.options?.reapIntervalObject;
    if (!reaper) return;
    clearInterval(reaper);
    sessionStore.options.reapIntervalObject = null;
  } catch { /* nothing to clear */ }
}

/**
 * Releases everything this module started: the Socket.io server and its log
 * tails, the HTTP listener, the daemon bridge, the background jobs, and the
 * SQLite handle.
 *
 * Idempotent — concurrent or repeated calls (a second Ctrl+C during shutdown)
 * return the same promise and never double-close. Every await is time-boxed, so
 * the whole teardown finishes well inside the CLI's five-second force exit.
 *
 * @returns {Promise<void>}
 */
function shutdown() {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    stopSessionReaper();

    // Socket.io FIRST. A browser tab holds an UPGRADED socket, and Node's
    // `server.close()` never closes an upgraded socket: it waits for the
    // connection to end, which a connected tab has no reason to do. The call
    // that disconnects those clients (`io.close()`) used to come afterwards, so
    // this await hung until the CLI's five-second timer printed "Shutdown timed
    // out — exiting anyway".
    //
    // Both halves are needed and must overlap. `io.close()` disconnects every
    // client and then closes the listener it was attached to, but that listener
    // close cannot finish while some OTHER connection is still open — a stalled
    // request, an idle keep-alive on Node 18 — so the connection sweep below
    // runs while socket.io is still closing, and is what unblocks it.
    const socketStep = timeBox(stopSocket, SHUTDOWN_SOCKET_MS, 'socket.io');
    await closeListener();
    await socketStep;

    try { daemonLink.stop(); } catch { /* never connected */ }
    // Stops the monitors, the revision watcher and the hub agent together, and
    // is a no-op when a daemon owns them.
    await timeBox(() => jobs.stop(), SHUTDOWN_JOBS_MS, 'background jobs');
    try { stopSslController(); } catch { /* nothing pending */ }

    try { closeDb(); } catch { /* already closed */ }
  })();

  return shutdownPromise;
}

export { app, httpServer, whenListening, shutdown, daemonStatus };
