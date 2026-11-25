/**
 * core/daemon/run.js
 *
 * `ezz daemon` — the long-running background process.
 *
 * Runs in the FOREGROUND and, by default, opens NO HTTP port. Both are
 * deliberate:
 *
 *  - Foreground, because every service manager this project targets (Windows
 *    Services via WinSW, systemd, and the Startup-folder supervisor) wants a
 *    process it can start, watch and stop. A process that daemonises itself is
 *    one the manager immediately believes has exited.
 *  - No port, because the daemon does monitoring, not serving. A port would
 *    need its own bind policy, authentication and firewall story; the
 *    dashboard already has all three and is started on demand. Live events
 *    reach it over the local IPC channel instead (core/daemon/ipc.js).
 *
 *    The one exception is opt-in: the deploy hook (core/deploy/hookServer.js),
 *    which a CI job calls to trigger a deployment and which therefore has to
 *    be there when the dashboard is not. It is off until switched on, binds
 *    to loopback unless told otherwise, serves only /.ez-deploy/, and carries
 *    its own bind policy and per-app token — the "own story" the paragraph
 *    above says a port needs. It is started with the jobs, not here.
 *
 * What it owns while it runs: the single-instance lock, the monitors, the
 * revision watcher, the hub agent, and the IPC server that feeds an open
 * dashboard.
 */

import { createRequire } from 'module';

import { getDataDir } from '../platform.js';
import { dbGet } from '../db.js';
import { startJobs } from '../jobs/index.js';
import { startIpcServer } from './ipc.js';
import { inspect } from './lock.js';
import { watchForStop, readStopRequest, clearStopRequest } from './stopRequest.js';
import { getHubAgentStatus } from '../hub/agent.js';
import { subscribe, publish } from '../jobs/bus.js';
import { writeDaemonState, removeDaemonState } from './stateFile.js';
import { assessStartup, runVersionDriftCheck, DRIFT_CHECK_MS } from '../service/versionDrift.js';
import { loadConfig } from '../config.js';
import { ensureCode as ensureSetupCode, describe as describeSetupCode } from '../setupCode.js';

const require = createRequire(import.meta.url);
const { version } = require('../../../package.json');

/**
 * Starts the daemon and resolves when it is up.
 *
 * It does NOT resolve when the daemon stops — the caller keeps the process
 * alive; `stop()` on the returned handle is for tests and for the signal
 * handlers installed by runDaemon().
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {Object} [opts.intervals] Monitor interval overrides, for tests
 * @param {boolean} [opts.hub] Start the hub agent (default true)
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ ok: true, stop: () => Promise<void>, ipcPath: string, state: () => Object }
 *          | { ok: false, reason: string, lock: Object|null }>}
 */
export async function startDaemon({
  dataDir = getDataDir(),
  intervals = {},
  hub = true,
  log = (line) => process.stdout.write(`${line}\n`),
  // Lets a test drive the stop-request path without taking its own process
  // down. Production always wants the exit: it is the signal the supervisor
  // reads to decide not to restart.
  exitOnStop = true,
  // Injected for tests: the start-up assessment and the notifications it can
  // raise. Production uses the platform defaults.
  deps = {},
} = {}) {
  // ── Start-up tolerance (Part 2.6) ─────────────────────────────────────────
  // A service installed by an OLD updater can start this version with its
  // protections, unit or runtime copy missing or half-applied. That is not a
  // reason to refuse: it is a reason to say so and keep working. The only
  // refusal is a state that is actively unsafe, which is decided narrowly in
  // assessStartup() (a data directory inside the package folder).
  const pendingStop = readStopRequest({ dataDir });

  let record = null;
  try {
    record = dbGet('service-state') ?? null;
  } catch {
    // A missing or unreadable record is itself something to report below, not
    // a crash on the way up.
  }

  let startup;
  try {
    startup = (deps.assessStartup ?? assessStartup)({
      dataDir,
      version,
      record,
      staleStopRequest: pendingStop.requested,
      deps: deps.startup ?? {},
    });
  } catch (error) {
    startup = {
      ok: true,
      refused: false,
      warnings: [`the start-up check failed: ${error.message}`],
      applied: [],
      drift: null,
    };
  }

  if (startup?.refused) {
    log(`Refusing to start: ${startup.reason}`);
    return { ok: false, reason: startup.reason, unsafe: true, startup };
  }

  const jobs = startJobs({ role: 'daemon', dataDir, version, intervals, hub });

  // startJobs() returns a failure object rather than throwing when another
  // daemon holds the lock: that is an ordinary outcome, not an error, and the
  // caller decides how to report it.
  if (jobs.ok === false) {
    return { ok: false, reason: jobs.reason, lock: jobs.lock };
  }

  log(`Easy DevOps daemon v${version}`);
  log(`  data directory : ${dataDir}`);
  log(`  pid            : ${process.pid}`);

  // This process holds the lock, so a stop request written BEFORE now is
  // spent: it belongs to a daemon that has already gone. Clearing it here is
  // what covers a start this CLI did not perform — `sc.exe start`,
  // `systemctl start`, a supervisor restart, or a hand-run `ezz daemon` — and
  // it is what keeps `ezz service status` from saying "stopped by you" while
  // this daemon is running (finding A5). The explicit start paths clear it too,
  // before they ask the manager to start anything.
  //
  // It must happen BEFORE stopWatch.check() below, which would otherwise
  // answer a spent request by exiting immediately.
  if (pendingStop.requested) {
    clearStopRequest({ dataDir });
    log('  stop request   : cleared - this start supersedes it');
  }

  // Everything the start-up check could not fix without elevation is reported
  // and then left alone. Status, the Hub payload and the dashboard banner
  // re-derive the same warnings; this daemon keeps running.
  for (const warning of startup.warnings ?? []) {
    log(`  warning        : ${warning}`);
  }

  // The lock is taken by now, which is what an open dashboard watches for. It
  // stands down immediately; this waits until it actually has, so the Hub
  // never sees two agents for one server. Bounded — see core/jobs/owner.js.
  await jobs.ready();

  let ipc = null;
  try {
    ipc = await startIpcServer({
      dataDir,
      // A dashboard that connects mid-flight has missed every event so far.
      // The hello frame gives it the daemon's identity immediately, so it can
      // show the "background service is running" banner without waiting for
      // the next poll to come round.
      hello: () => ({
        version,
        pid: process.pid,
        startedAt: inspect({ dataDir }).lock?.startedAt ?? Date.now(),
        hub: getHubAgentStatus(),
      }),
    });
    log(`  event channel  : ${ipc.path}`);
  } catch (err) {
    // The daemon is still useful without IPC: monitoring and notifications do
    // not depend on it, only the live view in an open dashboard does. Failing
    // to start entirely would trade all of that for one feature.
    log(`  event channel  : unavailable (${err.message})`);
    log('    The dashboard will fall back to polling. Background work continues.');
  }

  // The hub agent is NOT started here: startJobs() owns it, because it must
  // start and stop with job ownership rather than with this process. See the
  // comment in core/jobs/index.js — two agents on one pairing would execute
  // every Hub command twice.
  const agent = getHubAgentStatus();
  log(`  hub agent      : ${agent?.status ?? 'unknown'}`);

  // The same agent state, in the data directory, for a CLI that cannot open
  // the pipe — in Windows Server mode it belongs to NT SERVICE\EasyDevOps. See
  // core/daemon/stateFile.js. Rewritten on every transition the bus carries.
  //
  // A failure is logged by writeDaemonState() (once per failure streak) and
  // named here too, because the first write is the one a user reads at start:
  // dropping it silently is what made a running daemon look stopped.
  if (!writeDaemonState({ dataDir, pid: process.pid, version, hub: agent })) {
    log('  daemon state   : could not be written; the daemon keeps running and retries on the next change');
  }
  const unsubscribeState = subscribe('hub:agentState', (payload) => {
    writeDaemonState({ dataDir, pid: process.pid, version, hub: payload });
  });

  // The first-run setup code, while the dashboard still has no password.
  // The daemon's stdout IS the service log (WinSW, systemd, the Startup
  // supervisor all capture it), which is the second of the two places the
  // code is allowed to appear - the other being a local terminal. Whichever
  // of the daemon and the dashboard starts first issues it; the other says
  // one is outstanding, because nothing stores the cleartext to re-print.
  try {
    const code = await ensureSetupCode({ config: loadConfig });
    if (code.pending) for (const line of describeSetupCode(code)) log(line);
  } catch (err) {
    log(`  setup code     : unavailable (${err.message})`);
  }

  log('');
  log('Running. Background jobs are owned by this process.');

  // A newer package installed with npm on a Windows Server updates only the
  // CLI. Compare this daemon's own version with the installed package at start
  // and every six hours, and announce a newer one once per version pair. It
  // never repairs anything: the banner and the notification name
  // `ezz service repair`.
  const runDriftCheck = async () => {
    try {
      const result = await (deps.runVersionDriftCheck ?? runVersionDriftCheck)({
        dataDir,
        version,
        deps: { ...(deps.drift ?? {}), publish: deps.publish ?? publish },
      });
      if (result?.notified) {
        log(`  version check  : service v${result.serviceVersion}, installed v${result.installedVersion} - reported once`);
      }
      return result;
    } catch (error) {
      log(`  version check  : failed (${error.message})`);
      return null;
    }
  };

  await runDriftCheck();
  const driftTimer = setInterval(() => { runDriftCheck(); }, DRIFT_CHECK_MS);

  let stopping = null;

  const handle = {
    ok: true,
    ipcPath: ipc?.path ?? null,
    startup,
    state: () => ({
      ...jobs.state(),
      version,
      pid: process.pid,
      ipcPath: ipc?.path ?? null,
      hub: getHubAgentStatus(),
      startupWarnings: startup.warnings ?? [],
    }),

    /** Idempotent: a second signal while shutting down must not run it twice. */
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        log('Stopping...');
        clearInterval(driftTimer);
        stopWatch.stop();
        try { unsubscribeState?.(); } catch { /* best effort */ }
        removeDaemonState({ dataDir, pid: process.pid });
        if (ipc) {
          try { await ipc.close(); } catch { /* best effort */ }
        }
        await jobs.stop();
        log('Stopped.');
      })();
      return stopping;
    },
  };

  // `ezz service stop` has no service manager to go through in Windows
  // Personal mode, so it writes a request file and the daemon answers it by
  // exiting with code 0. The supervisor treats 0 as "asked to stop" and does
  // not restart — which is what makes a stop actually stick.
  //
  // The STOP ITSELF is never cleared here (the onStop handler below must leave
  // the file for the supervisor). The START was handled above: a request that
  // existed when this daemon took the lock is spent and was removed before this
  // watcher was created.
  const stopWatch = watchForStop({
    dataDir,
    onStop(request) {
      log(`Stop requested${request.reason ? ` (${request.reason})` : ''}. Exiting.`);
      // Exit code 0 is the signal: the supervisor reads it as "asked to stop"
      // and does not restart. A non-zero exit would be restarted.
      handle.stop().then(
        () => { if (exitOnStop) process.exit(0); },
        () => { if (exitOnStop) process.exit(0); },
      );
    },
  });

  // Checked once immediately: a request written after this start still must
  // stop the daemon, and the check costs one read.
  stopWatch.check();

  return handle;
}

/**
 * The CLI entry: starts the daemon, installs signal handlers, and keeps the
 * process alive until it is told to stop.
 *
 * @param {Object} [opts] Passed through to startDaemon()
 * @returns {Promise<number>} Process exit code
 */
export async function runDaemon(opts = {}) {
  const started = await startDaemon(opts);

  if (!started.ok) {
    process.stderr.write(
      `\nAnother Easy DevOps daemon is already running.\n` +
      `  ${started.reason}\n\n` +
      `Only one may own the background jobs at a time.\n` +
      `  ezz service status    see what is running\n` +
      `  ezz service restart   restart the installed service\n\n`,
    );
    return 1;
  }

  let code = 0;

  const shutdown = async (signal) => {
    process.stdout.write(`\nReceived ${signal}.\n`);
    await started.stop();
    process.exit(code);
  };

  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });

  // Windows service managers stop a console process by closing its console,
  // which Node surfaces as SIGHUP. Without this the process is killed outright
  // and the lock file is left behind for the next start to recover.
  process.on('SIGHUP', () => { shutdown('SIGHUP'); });

  // An unexpected throw must not leave a daemon that holds the lock but runs
  // nothing. Release and exit non-zero so the service manager restarts it.
  process.on('uncaughtException', async (err) => {
    process.stderr.write(`\n[daemon] uncaught exception: ${err.stack || err.message}\n`);
    code = 1;
    await started.stop();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    // Logged, not fatal: a rejected push to the Hub or a failed status read is
    // not a reason to take down monitoring.
    process.stderr.write(`[daemon] unhandled rejection: ${reason?.stack || reason}\n`);
  });

  // Nothing further to do on this stack. The monitors' intervals and the IPC
  // server keep the event loop alive.
  return new Promise(() => {});
}
