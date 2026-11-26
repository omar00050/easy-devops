/**
 * dashboard/controllers/processesController.js
 *
 * The Processes page and the service status panel.
 *
 * Two rules shape this controller:
 *
 *   1. PM2 apps that Easy DevOps did not create are listed but never acted on
 *      implicitly. A request naming one is honoured — the user clicked it —
 *      but nothing here iterates over "all apps" and restarts them.
 *   2. The dashboard never installs, elevates or prompts. Installing the
 *      Windows service in Server mode needs an Administrator context, and
 *      systemd needs sudo; neither can be obtained from inside a web request.
 *      So those answers name the exact command instead. No password is
 *      involved in any mode.
 */

import { isWindows, isDevDataDir, getDataDir } from '../../core/platform.js';
import * as runner from '../../core/runner.js';
import * as service from '../../core/service/index.js';
import { MODES } from '../../core/service/index.js';
import { daemonStatus } from '../lib/daemonBridge.js';
import { invalidate as invalidateProbe, probe } from '../../core/probeCache.js';

const SERVER_MODE = MODES.SERVER;

/**
 * PM2 detection, cached beside the service probes.
 *
 * `where.exe pm2` measured at about 2 s on the machine that reported this
 * endpoint as slow, and `pm2 --version` at about 4 s. Whether PM2 is installed
 * changes when the user installs PM2, so a minute is a long time to be wrong
 * and a short time to be slow. The `service:` prefix means
 * `invalidateProbes()` drops this too.
 */
const PM2_PROBE_KEY = 'service:pm2';
const PM2_TTL_MS = 60_000;

/** Produces the PM2 detection result. One place, so the warm-up matches the read. */
const detectPm2 = () => runner.detect({ probeVersion: runner.isDaemonRunning() });

/**
 * Fills every probe `GET /api/service` reads, so the next request is warm.
 *
 * It has to cover the PM2 probe as well as core's three: warming only core's
 * left this endpoint's first call waiting on `where.exe pm2` and answering
 * `pending: true` anyway, which defeated the warm-up entirely. Measured, not
 * reasoned about - that is exactly what happened the first time.
 *
 * Never awaited by a request. Called when the dashboard starts and again after
 * any lifecycle action, so a user who just pressed Start finds the new state
 * already measured rather than paying for the probes on their next poll.
 *
 * @returns {Promise<void>}
 */
export async function warmProbes() {
  await Promise.allSettled([
    service.warmProbes(),
    probe(PM2_PROBE_KEY, detectPm2, { ttlMs: PM2_TTL_MS, coldWaitMs: 60_000 }),
  ]);
}

/**
 * What to tell a client that cannot install or elevate by itself.
 *
 * Machine-readable, because the UI must show the command rather than pretend
 * it can elevate. No password is involved in any mode: the Windows service
 * runs as the virtual account `NT SERVICE\EasyDevOps`, and sudo asks for its
 * own on the user's terminal.
 */
function installGuidance(mode) {
  const needsElevation = isWindows && mode === SERVER_MODE;
  return {
    command: 'ezz service install',
    needsElevation,
    shell: needsElevation ? 'Administrator PowerShell' : null,
  };
}

/**
 * Runs one lifecycle action and answers in a shape the UI can act on.
 *
 * An action the dashboard cannot perform is NOT a 500: it is a 403 naming the
 * exact command and the shell to run it in. Windows Server mode needs an
 * Administrator context and systemd needs sudo, and neither can be obtained
 * from inside a web request — so the honest answer is the command, never a
 * password prompt.
 */
async function runLifecycle(res, action, fn) {
  try {
    const result = await fn();

    // The cached probes describe what just changed. core/service/ invalidates
    // them before it acts, which keeps a concurrent read honest; this second
    // call is for after, so the next GET /api/service measures the new state
    // rather than whatever was true mid-operation.
    service.invalidateProbes();

    // And re-measure immediately, without the client waiting: a UI that just
    // pressed Start polls within a second or two, and this is what makes that
    // poll fast instead of making it pay for the probes.
    warmProbes().catch(() => { /* the next request probes anyway */ });

    if (result.ok) {
      return res.json({
        ok: true,
        action,
        output: result.detail ?? null,
        backgroundService: daemonStatus(),
      });
    }

    if (result.needsElevation) {
      const elevated = isWindows
        ? { command: `ezz service ${action}`, shell: 'Administrator PowerShell' }
        : { command: `sudo systemctl ${action} easy-devops`, shell: 'a terminal with sudo' };

      return res.status(403).json({
        error: 'elevation_required',
        action,
        message: result.reason,
        ...elevated,
        backgroundService: daemonStatus(),
      });
    }

    // "Nothing is installed" is a precondition, not a server fault.
    if (/not installed/i.test(result.reason ?? '')) {
      return res.status(409).json({
        error: 'not_installed',
        action,
        message: result.reason,
        command: 'ezz service install',
        backgroundService: daemonStatus(),
      });
    }

    if (result.alreadyRunning) {
      return res.status(409).json({
        error: 'already_running',
        action,
        message: result.reason,
        backgroundService: daemonStatus(),
      });
    }

    return res.status(500).json({
      error: 'action_failed',
      action,
      message: result.reason ?? `could not ${action} the service`,
      backgroundService: daemonStatus(),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/** Actions a request may ask for, mapped to the runner function. */
const ACTIONS = {
  start: runner.restart, // PM2 "start" for an existing app is a restart
  restart: runner.restart,
  stop: runner.stop,
  reload: runner.reload,
};

/**
 * True while one `npm i -g pm2` is running in this process.
 *
 * One install at a time, and the request that finds one running is refused
 * with 409 `in_progress` rather than starting a second npm. Two concurrent
 * installs into the same global prefix corrupt it.
 */
let pm2InstallInFlight = false;

/**
 * The version inside npm's own install output (`+ pm2@6.0.14`), or null.
 *
 * Read from the output rather than by running `pm2 --version`: that command
 * STARTS the PM2 daemon, and a just-finished install is not a reason to bring
 * one to life on a machine that does not use PM2 yet.
 *
 * @param {string} output
 * @returns {string|null}
 */
function versionFromInstallOutput(output) {
  const match = String(output ?? '').match(/pm2@(\d+\.\d+\.\d+)/i);
  return match ? match[1] : null;
}

/**
 * The PM2 probes this dashboard caches, dropped after an install attempt.
 *
 * `service.invalidateProbes()` covers the `service:` prefix, which is where
 * this controller keeps its own `service:pm2` detection. Both are dropped so
 * the next Processes page and `GET /api/service` measure the new state instead
 * of replaying "not installed" from before the install.
 */
function invalidatePm2Probes() {
  try { service.invalidateProbes(); } catch { /* nothing cached */ }
  try { invalidateProbe(PM2_PROBE_KEY); } catch { /* nothing cached */ }
}

class ProcessesController {
  /**
   * @param {{ runner?: Object, invalidate?: Function }} [deps] Injected by
   *   tests, so an install can be proved against a stub npm and never runs the
   *   real one. Production uses the real runner and drops the real probes.
   */
  constructor({ runner: runnerApi = runner, invalidate = invalidatePm2Probes } = {}) {
    this.runner = runnerApi;
    this.invalidate = invalidate;
  }

  /**
   * GET /api/processes
   * The PM2 app list plus enough service context for the page header.
   */
  async list(req, res) {
    try {
      const pm2 = await runner.detect();
      if (!pm2.installed) {
        return res.json({
          pm2: { installed: false, version: null, path: null },
          apps: [],
          currentUser: runner.currentUser(),
          hint: 'PM2 is not installed. Run `ezz service install` to set up the background service.',
        });
      }

      const listed = await runner.list({ pm2Path: pm2.path ?? 'pm2' });
      if (!listed.ok) {
        return res.status(502).json({ error: 'Could not read the PM2 process list', detail: listed.error });
      }

      res.json({
        pm2: { installed: true, version: pm2.version, path: pm2.path },
        apps: listed.apps,
        currentUser: runner.currentUser(),
        pm2Home: runner.pm2Home(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /api/processes/:name/:action
   * action ∈ start | stop | restart | reload
   *
   * Acting on an app Easy DevOps did not create is allowed, because reaching
   * this endpoint means the user clicked that row's button. It is recorded in
   * the response so the UI can be explicit about what it just did.
   */
  async action(req, res) {
    try {
      const { name, action } = req.params;
      const fn = ACTIONS[action];
      if (!fn) {
        return res.status(400).json({ error: `Unknown action: ${action}` });
      }
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'A process name is required' });
      }

      const pm2 = await runner.detect();
      if (!pm2.installed) {
        return res.status(409).json({ error: 'PM2 is not installed' });
      }
      const pm2Path = pm2.path ?? 'pm2';

      // Only act on something PM2 actually knows, so a typo cannot be
      // reported as a success.
      const listed = await runner.list({ pm2Path });
      const app = listed.ok ? listed.apps.find((a) => a.name === name) : null;
      if (!app) {
        return res.status(404).json({ error: `PM2 has no process named "${name}"` });
      }

      // PM2 is per-user: another account's app is visible in some setups but
      // cannot be controlled from here, and would fail confusingly.
      if (app.user && app.user !== runner.currentUser()) {
        return res.status(409).json({
          error: `"${name}" belongs to OS user "${app.user}", not "${runner.currentUser()}".`,
          hint: 'PM2 keeps a separate process list per user. Sign in as that user to control it.',
        });
      }

      const result = await fn(name, { pm2Path });
      if (!result.ok) {
        return res.status(500).json({ error: `pm2 ${action} failed`, output: result.output });
      }

      res.json({ ok: true, name, action, managed: app.managed, output: result.output });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * GET /api/processes/:name/logs?lines=200
   */
  async logs(req, res) {
    try {
      const { name } = req.params;
      const lines = Number(req.query.lines) || 200;

      const pm2 = await runner.detect();
      if (!pm2.installed) {
        return res.status(409).json({ error: 'PM2 is not installed' });
      }

      const result = await runner.logs(name, { lines, pm2Path: pm2.path ?? 'pm2' });
      res.json({ name, lines: result.lines });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /api/pm2/install
   *
   * Installs the standard PM2 — `npm i -g pm2` — for the account this
   * dashboard runs as. That is the whole model: no PM2_HOME, no second daemon,
   * no sudo and no elevation. The dashboard cannot elevate, and a password is
   * never involved.
   *
   * The request body is ignored on purpose: there is nothing to configure, so
   * nothing a caller sends can change the command. Answers:
   *
   *   403 { ok:false, reason:'service_account', message, fix } — this process
   *       may not use PM2 at all (the Windows service); installing here would
   *       create a service-owned PM2 daemon.
   *   409 { ok:false, reason:'already_installed' } — nothing to do.
   *   409 { ok:false, reason:'in_progress' } — one install at a time.
   *   200 { ok:true, version, output }
   *   500 { ok:false, reason:'install_failed', output, command }
   *
   * Every answer drops the cached PM2 probes, so the next read measures again.
   */
  async installPm2(req, res) {
    // `req` is deliberately not read: there is no body to accept, so nothing a
    // caller sends can change the command.
    const access = this.runner.pm2Access();
    if (!access.ok) {
      return res.status(403).json({
        ok: false,
        reason: access.reason ?? 'service_account',
        message: access.message,
        fix: access.fix,
      });
    }

    if (pm2InstallInFlight) {
      return res.status(409).json({
        ok: false,
        reason: 'in_progress',
        message: 'A PM2 install is already running. Wait for it to finish.',
        fix: 'npm i -g pm2',
      });
    }

    pm2InstallInFlight = true;
    try {
      // "Already installed" is a precondition, not a failure. `probeVersion:
      // false` so this check cannot start the PM2 daemon.
      const detected = await this.runner.detect({ probeVersion: false });
      if (detected?.installed) {
        return res.status(409).json({
          ok: false,
          reason: 'already_installed',
          message: 'PM2 is already installed.',
          version: detected.version ?? null,
          path: detected.path ?? null,
        });
      }

      const installed = await this.runner.install();
      this.invalidate();

      if (!installed.ok) {
        return res.status(500).json({
          ok: false,
          reason: 'install_failed',
          output: installed.output ?? '',
          command: 'npm i -g pm2',
        });
      }

      return res.json({
        ok: true,
        version: versionFromInstallOutput(installed.output),
        output: installed.output ?? '',
      });
    } catch (err) {
      this.invalidate();
      return res.status(500).json({
        ok: false,
        reason: 'install_failed',
        output: err?.message ?? String(err),
        command: 'npm i -g pm2',
      });
    } finally {
      pm2InstallInFlight = false;
    }
  }

  /**
   * GET /api/service
   *
   * `backgroundService` is the single authority on the native daemon. The
   * PM2-era top-level fields are gone: on a machine where the daemon WAS
   * running they said `installed: false, running: false`, so a client reading
   * them rendered "Not installed" over a working service. They described a PM2
   * app that no longer exists.
   *
   * What remains at the top level is only what is still true and still used:
   * `pm2` and the Processes page beneath it (the user's OWN apps), the dev
   * badge, the data directory, and the per-mode install guidance.
   */
  async status(req, res) {
    try {
      const [native, pm2] = await Promise.all([
        // `cache: true`: the cheap lock-based state is read fresh every time,
        // and the three probes that each cost a subprocess come from the cache
        // and refresh behind the response. See core/probeCache.js for the
        // measurements that made this necessary - this endpoint took about 20
        // seconds on Windows, where one spawn costs about a second.
        service.status({ cache: true }),
        // Cached for the same reason, and under the same `service:` prefix so
        // one invalidation covers it. `probeVersion: false` unless PM2's daemon
        // is already up, and no daemon start: reporting must never bring a PM2
        // daemon to life on a machine that does not use one.
        probe(PM2_PROBE_KEY, detectPm2, { ttlMs: PM2_TTL_MS }),
      ]);

      // The cheap, synchronous state plus `connected` — the same object the
      // `service:changed` socket event carries, so the UI has one shape.
      const live = daemonStatus();

      res.json({
        // ── The native background service ────────────────────────────────
        backgroundService: {
          ...live,

          // From the full status: these need the service manager and the
          // runtime probes, so they are not in the cheap state.
          state: native.service?.state ?? null,
          enabledOnBoot: native.service?.enabledOnBoot ?? null,
          restarts: native.service?.restarts ?? 0,
          crashLooping: Boolean(native.service?.crashLooping),
          warnings: native.warnings ?? [],
          runtime: native.runtime ?? null,

          // The service's own package version next to the CLI's, so the banner
          // can say which is behind (Windows Server keeps a runtime copy).
          serviceVersion: native.serviceVersion ?? null,
          cliVersion: native.cliVersion ?? null,
          versionDrift: native.versionDrift === true,
        },

        // ── Still true, still used ────────────────────────────────────────
        pm2: {
          installed: pm2.value?.installed ?? null,
          version: pm2.value?.version ?? null,
          path: pm2.value?.path ?? null,
        },

        // How old the measured parts are, and whether anything is still being
        // measured. A client can render immediately and ask again rather than
        // waiting for a probe it cannot see.
        probes: {
          ageMs: Math.max(native.probes?.ageMs ?? 0, pm2.ageMs ?? 0),
          fresh: Boolean(native.probes?.fresh) && Boolean(pm2.fresh),
          pending: Boolean(native.probes?.pending) || Boolean(pm2.pending),
          refreshing: Boolean(native.probes?.refreshing) || Boolean(pm2.refreshing),
        },
        dev: isDevDataDir(),
        dataDir: getDataDir(),

        // Per-mode guidance for a client that cannot elevate itself.
        install: installGuidance(native.mode),
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /** POST /api/service/start */
  async start(req, res) {
    return runLifecycle(res, 'start', () => service.start({}));
  }

  /** POST /api/service/stop */
  async stop(req, res) {
    return runLifecycle(res, 'stop', () => service.stop({}));
  }

  /**
   * POST /api/service/restart
   *
   * Clears the "stopped by you" marker, so a restart from the UI behaves like
   * one from the CLI.
   */
  async restart(req, res) {
    return runLifecycle(res, 'restart', () => service.restart({}));
  }
}

export default ProcessesController;
