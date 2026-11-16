/**
 * core/service/legacy.js
 *
 * Finding and removing what the previous background-service design left behind.
 *
 * Easy DevOps used to keep itself running through PM2, with three different
 * boot hooks depending on platform and mode:
 *
 *   - a PM2 app named `ez-dashboard` (or `ez-dashboard-dev`)
 *   - a Windows Task Scheduler task `EasyDevOps-PM2`, which needed the user's
 *     password — the reason the whole approach was replaced
 *   - a Windows Startup-folder launcher `easy-devops-pm2.cmd`
 *
 * None of these are created any more. They are still DETECTED, because an
 * upgrade finds them on a machine that used the old design, and leaving them
 * in place means two things trying to run the dashboard at boot.
 *
 * ── The rule that matters ──────────────────────────────────────────────────
 *
 * **Only our own PM2 apps are ever touched.** `runner.js` still exists and the
 * Processes page still manages the user's own applications, which is a
 * supported feature. An over-eager cleanup that stopped or deleted somebody's
 * production app while "uninstalling our service" would be unforgivable, so
 * every PM2 operation here is by exact name from `EZ_APP_NAMES` and nothing
 * iterates over the full app list to decide what to remove.
 *
 * Removal is also never automatic: install and uninstall OFFER it. The user
 * may have reasons for what is on their machine.
 */

import fs from 'fs';

import * as runner from '../runner.js';
import {
  isWindows,
  getStartupFolder,
  WINDOWS_BOOT_TASK,
  WINDOWS_STARTUP_FILE,
  windowsBootTaskDeleteCmd,
  windowsBootTaskQueryCmd,
} from '../platform.js';
import { run as shellRun } from '../shell.js';
import path from 'path';

/**
 * Everything from the old design that is still present.
 *
 * Deliberately read-only and cheap: it is called by `status`, by install and
 * by uninstall, and a status read must never change anything — nor start the
 * PM2 daemon, which every pm2 command would (see runner.isDaemonRunning).
 *
 * @param {Object} [overrides]
 * @param {Function} [overrides.run]
 * @param {string|null} [overrides.startupDir]
 * @returns {Promise<{ found: boolean, items: Array<{ kind: string, name: string, detail: string, removal: string }> }>}
 */
export async function detectLegacy(overrides = {}) {
  const run = overrides.run ?? shellRun;
  const startupDir = overrides.startupDir ?? getStartupFolder();

  const items = [];

  // ── The PM2 app ───────────────────────────────────────────────────────────
  //
  // Only asked if the daemon is already up. If PM2 is not running then no PM2
  // app is running either, and starting its daemon to discover that would be a
  // side effect in a status read.
  try {
    if (runner.isDaemonRunning()) {
      const pm2 = await runner.detect({ probeVersion: false });
      if (pm2.installed) {
        const listed = await runner.list({ pm2Path: pm2.path ?? 'pm2' });
        if (listed.ok) {
          for (const app of listed.apps ?? []) {
            if (!runner.isEzApp(app.name)) continue;
            items.push({
              kind: 'pm2-app',
              name: app.name,
              detail: `PM2 app "${app.name}" (${app.status ?? 'unknown'}) — the old way of keeping the dashboard running.`,
              removal: `pm2 delete ${app.name} && pm2 save`,
            });
          }
        }
      }
    }
  } catch { /* PM2 absent or unreadable: nothing to report */ }

  if (isWindows) {
    // ── The scheduled task ──────────────────────────────────────────────────
    try {
      const task = await run(windowsBootTaskQueryCmd(), { timeout: 15_000 });
      if (task.success && new RegExp(WINDOWS_BOOT_TASK, 'i').test(task.stdout)) {
        items.push({
          kind: 'scheduled-task',
          name: WINDOWS_BOOT_TASK,
          detail: `Task Scheduler task "${WINDOWS_BOOT_TASK}" starts the old PM2 service at boot. `
            + 'It holds a stored password, which is why this mode was removed.',
          removal: `schtasks /Delete /TN "${WINDOWS_BOOT_TASK}" /F`,
        });
      }
    } catch { /* schtasks missing: nothing to report */ }

    // ── The Startup launcher ────────────────────────────────────────────────
    const launcher = startupDir ? path.join(startupDir, WINDOWS_STARTUP_FILE) : null;
    if (launcher && fs.existsSync(launcher)) {
      items.push({
        kind: 'startup-file',
        name: WINDOWS_STARTUP_FILE,
        path: launcher,
        detail: `${launcher} runs \`pm2 resurrect\` when you log in.`,
        removal: `del "${launcher}"`,
      });
    }
  }

  return { found: items.length > 0, items };
}

/**
 * Removes the legacy items it is given.
 *
 * Takes the detected items rather than re-detecting, so the user is acting on
 * exactly what they were shown.
 *
 * @param {Object} opts
 * @param {Array} opts.items From detectLegacy()
 * @param {Function} [opts.run]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ ok: boolean, removed: string[], failed: Array<{ name: string, reason: string }> }>}
 */
export async function removeLegacy({ items = [], run = shellRun, log = () => {} } = {}) {
  const removed = [];
  const failed = [];

  for (const item of items) {
    try {
      if (item.kind === 'pm2-app') {
        // Guarded again at the point of deletion, not only at detection: this
        // function can be called with a list from anywhere, and deleting a PM2
        // app that is not ours must be impossible rather than merely unlikely.
        if (!runner.isEzApp(item.name)) {
          failed.push({ name: item.name, reason: 'refusing to delete a PM2 app that is not ours' });
          continue;
        }

        const pm2 = await runner.detect({ probeVersion: false });
        const pm2Path = pm2.path ?? 'pm2';

        const del = await runner.del(item.name, { pm2Path });
        if (!del.ok) {
          failed.push({ name: item.name, reason: del.output || 'pm2 delete failed' });
          continue;
        }

        // `pm2 save` rewrites the resurrect list. Without it the app comes back
        // on the next `pm2 resurrect` — and crucially, saving also PRESERVES
        // every other app the user has, which is why the whole list is saved
        // rather than the entry being edited out of the dump file.
        await runner.save({ pm2Path });

        removed.push(item.name);
        log(`  removed PM2 app ${item.name}`);
        continue;
      }

      if (item.kind === 'scheduled-task') {
        // `--%` is the PowerShell stop-parsing token. Without it PowerShell
        // mangles the quotes around the task name before schtasks sees them —
        // measured against a stand-in executable that printed its argv.
        const result = await run(windowsBootTaskDeleteCmd(), { timeout: 20_000 });
        if (!result.success) {
          const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
          failed.push({
            name: item.name,
            reason: /access is denied/i.test(output)
              ? 'deleting a scheduled task needs an Administrator PowerShell'
              : output.trim().slice(0, 300) || 'schtasks failed',
          });
          continue;
        }
        removed.push(item.name);
        log(`  removed scheduled task ${item.name}`);
        continue;
      }

      if (item.kind === 'startup-file') {
        if (!item.path) {
          failed.push({ name: item.name, reason: 'the item carries no launcher path' });
          continue;
        }
        const launcher = item.path;
        fs.rmSync(launcher, { force: true });
        removed.push(item.name);
        log(`  removed startup launcher ${launcher}`);
        continue;
      }

      failed.push({ name: item.name, reason: `unknown legacy item kind: ${item.kind}` });
    } catch (err) {
      failed.push({ name: item.name, reason: err.message });
    }
  }

  return { ok: failed.length === 0, removed, failed };
}

/** A short human summary for a prompt. */
export function describeLegacy(items) {
  if (!items?.length) return 'Nothing from the old PM2-based service was found.';

  return [
    'The old PM2-based service is still set up on this machine:',
    ...items.map((i) => `  • ${i.detail}`),
    '',
    'Leaving it in place means two things try to run Easy DevOps at boot.',
    'Your own PM2 applications are never touched.',
  ].join('\n');
}
