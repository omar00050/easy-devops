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
import { startJobs } from '../jobs/index.js';
import { startIpcServer } from './ipc.js';
import { inspect } from './lock.js';
import { watchForStop } from './stopRequest.js';
import { getHubAgentStatus } from '../hub/agent.js';
import { subscribe } from '../jobs/bus.js';
import { writeDaemonState, removeDaemonState } from './stateFile.js';
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
} = {}) {
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
  writeDaemonState({ dataDir, pid: process.pid, version, hub: agent });
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
    const code = await ensureSetupCode({ config: loadConfig() });
    if (code.pending) for (const line of describeSetupCode(code)) log(line);
  } catch (err) {
    log(`  setup code     : unavailable (${err.message})`);
  }

  log('');
  log('Running. Background jobs are owned by this process.');

  let stopping = null;

  const handle = {
    ok: true,
    ipcPath: ipc?.path ?? null,
    state: () => ({
      ...jobs.state(),
      version,
      pid: process.pid,
      ipcPath: ipc?.path ?? null,
      hub: getHubAgentStatus(),
    }),

    /** Idempotent: a second signal while shutting down must not run it twice. */
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        log('Stopping...');
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
  // The file is deliberately NOT cleared here: it is what keeps the supervisor
  // from starting another daemon. The logon bootstrap and `ezz service start`
  // clear it, which is what makes a stop temporary rather than permanent.
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

  // Checked once immediately: a daemon started while a stop is still pending
  // must not sit there running. Only reachable if something started it without
  // clearing the request, which `start` and the logon bootstrap both do.
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
