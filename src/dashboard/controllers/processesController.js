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
 *   2. Installing the service is NOT exposed on Windows when the user wants
 *      the at-boot mode: that needs an elevated, interactive terminal, because
 *      Windows itself prompts for the account password. The dashboard reports
 *      the state and points at `ezz service install` instead.
 */

import { isWindows } from '../../core/platform.js';
import * as runner from '../../core/runner.js';
import * as service from '../../core/service.js';

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
   * Whether the dashboard runs as a background service, and whether it will
   * come back after a reboot.
   */
  async status(req, res) {
    try {
      const s = await service.status();
      res.json({
        ...s,
        // The dashboard cannot create the Windows at-boot task: schtasks must
        // prompt for the password on a real console, under elevation.
        canInstallFromDashboard: !isWindows,
        cliHint: isWindows
          ? 'Run `ezz service install` in an Administrator PowerShell to set up the service.'
          : 'Run `ezz service install` to set up the service.',
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /api/service/restart
   * Restarting an already-installed service needs no elevation and no prompt,
   * so it is safe from here on both platforms.
   */
  async restart(req, res) {
    try {
      const result = await service.restart();
      if (!result.ok) {
        return res.status(500).json({ error: 'Could not restart the service', output: result.output });
      }
      res.json({ ok: true, output: result.output });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export default ProcessesController;
