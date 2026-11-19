/**
 * core/deploy/status.js
 *
 * Where each deployed app stands right now: its record, the live release, the
 * last run, whether a deployment is in progress, and its PM2 process.
 *
 * Shared by the dashboard's Deployments page and the Hub agent, so the two
 * cannot describe the same app differently. The only thing that differs is
 * the `view`: the dashboard gets dashboardApp() (environment values included,
 * behind its own login), the Hub gets publicApp() (names only, no secrets).
 */

import * as defaultRunner from '../runner.js';
import { listApps, getApp, dashboardApp, pm2Name } from './apps.js';
import { settingsWarnings } from './ezfile.js';
import { describeRelease } from './engine.js';
import { listRuns, readState, listReleases, lockHolder } from './store.js';

/**
 * PM2's view of every process, keyed by name — or an empty map.
 *
 * Read only when PM2's daemon is already running: a status read must never be
 * the thing that starts a PM2 daemon on a machine that was not running one.
 *
 * @returns {Promise<Map<string, Object>>}
 */
export async function pm2Statuses({ runner = defaultRunner } = {}) {
  const byName = new Map();
  if (!runner.isDaemonRunning()) return byName;
  try {
    const pm2 = await runner.detect({ probeVersion: false });
    if (!pm2.installed) return byName;
    const listed = await runner.list({ pm2Path: pm2.path ?? 'pm2' });
    if (listed.ok) {
      for (const app of listed.apps) {
        const existing = byName.get(app.name);
        if (existing) {
          existing.instances.push(app);
          if (app.status === 'online') existing.instancesOnline += 1;
        } else {
          byName.set(app.name, {
            ...app,
            instances: [app],
            instancesOnline: app.status === 'online' ? 1 : 0,
          });
        }
      }
    }
  } catch { /* status is decoration; the list still renders */ }
  return byName;
}

/**
 * One app with its current standing.
 *
 * @param {Object} app A registry record
 * @param {Map<string, Object>} processes From pm2Statuses()
 * @param {(app: Object) => Object} [view] dashboardApp (default) or publicApp
 */
export function describeApp(app, processes, view = dashboardApp) {
  const state = readState(app.id);
  const runs = listRuns(app.id, { limit: 1 });
  const holder = lockHolder(app.id);
  const proc = processes.get(pm2Name(app.id)) ?? null;
  const live = state.current ? describeRelease(app.id, state.current) : null;
  const execMode = live?.execMode ?? app.settings?.execMode ?? 'fork';
  const warnings = [...(view(app).warnings ?? [])];
  for (const w of settingsWarnings({ execMode })) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  return {
    ...view(app),
    currentRelease: state.current,
    previousRelease: state.previous,
    deploying: Boolean(holder),
    activeRunId: holder?.runId ?? null,
    lastRun: runs[0] ?? null,
    /** Advisory notes for the UI; empty unless the app runs a cluster. */
    warnings,
    /** What the live release was started with; settings when it never ran. */
    execMode,
    instances: live?.instances ?? app.settings?.instances ?? 1,
    instancesOnline: proc?.instancesOnline ?? (proc?.status === 'online' ? 1 : 0),
    process: proc
      ? {
        status: proc.status, pid: proc.pid, cpu: proc.cpu, memoryBytes: proc.memoryBytes,
        uptimeMs: proc.uptimeMs, restarts: proc.restarts,
      }
      : null,
  };
}

/** Every app, described. */
export async function describeApps({ view = dashboardApp, runner = defaultRunner } = {}) {
  const processes = await pm2Statuses({ runner });
  return listApps().map((app) => describeApp(app, processes, view));
}

/**
 * One app with its recent runs and the releases on disk, or null.
 */
export async function describeAppDetail(appId, { view = dashboardApp, runner = defaultRunner } = {}) {
  const app = getApp(appId);
  if (!app) return null;

  const processes = await pm2Statuses({ runner });
  const state = readState(app.id);

  return {
    ...describeApp(app, processes, view),
    runs: listRuns(app.id, { limit: 20 }),
    releases: listReleases(app.id)
      .map((id) => describeRelease(app.id, id))
      .filter(Boolean)
      .map((r) => ({ ...r, current: r.id === state.current, previous: r.id === state.previous })),
  };
}
