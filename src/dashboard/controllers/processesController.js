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

const SERVER_MODE = MODES.SERVER;

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

class ProcessesController {
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
        service.status(),
        // `probeVersion: false` and no daemon start: reporting must never bring
        // a PM2 daemon to life on a machine that does not use one.
        runner.detect({ probeVersion: runner.isDaemonRunning() }),
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
        },

        // ── Still true, still used ────────────────────────────────────────
        pm2: { installed: pm2.installed, version: pm2.version, path: pm2.path },
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
