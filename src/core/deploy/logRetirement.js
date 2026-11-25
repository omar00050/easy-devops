/**
 * Retires deployment history written before secret-safe logging existed.
 *
 * Pre-1.4.5 run records and log files cannot be reconstructed safely: the
 * values that were sensitive at write time are not known, and an app value
 * removed or rotated since then cannot prove that an old line is harmless.
 * Reads already fail closed for those runs. This migration removes the
 * remaining bytes so they are not copied by purge backups or exposed to a
 * process with filesystem access.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getDataDir } from '../platform.js';
import { acquireArtifactLockSync } from '../ssl/artifact-lock.js';
import { listApps } from './apps.js';
import {
  acquireLockAt,
  appPaths,
  isId,
  listRunsAt,
  pathsIn,
  deployRoot,
  writeRunAt,
} from './store.js';
import {
  isRedactedDeployRun,
} from './logSecurity.js';
import {
  directoryStillMatches,
  snapshotDirectory,
  unlinkVerifiedChild,
} from '../safe-file.js';

export const LOG_SECURITY_RETIRED_V1 = 'retired-v1';
export const LOG_RETIREMENT_LOCK = 'deploy-log-retirement';
export const LEGACY_DIAGNOSTIC_REDACTED =
  'Diagnostic text was removed during the Easy DevOps 1.4.5 log-security migration.';

function validLogIds(logsDir) {
  const directory = canonicalDirectorySnapshot(logsDir);
  if (!directory) return { ids: [], directory: null };
  const ids = fs.readdirSync(logsDir)
    .filter((name) => name.endsWith('.log') && isId(name.slice(0, -4)))
    .map((name) => name.slice(0, -4));
  if (!directoryStillMatches(directory)) {
    throw new Error(`The deployment log folder changed while it was listed: ${logsDir}`);
  }
  return { ids, directory };
}

function pathKey(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Snapshot a directory only when every path component is its real, non-linked
 * pathname. External deployment roots are operator settings, so they are
 * allowed, but a junction or an alias cannot redirect the retirement scan.
 */
function canonicalDirectorySnapshot(directory) {
  const snapshot = snapshotDirectory(directory);
  if (!snapshot) return null;
  const canonical = fs.realpathSync.native(snapshot.path);
  if (pathKey(canonical) !== pathKey(snapshot.path)) {
    throw new Error(`Refusing a linked or aliased directory: ${snapshot.path}`);
  }
  return snapshot;
}

function orphanAppFolders(dataDir, result) {
  const folders = [];
  const roots = new Map([
    [path.join(dataDir, 'ez_deploys'), path.join(dataDir, 'ez_deploys')],
    [path.join(dataDir, 'deploy'), path.join(dataDir, 'deploy')],
  ]);
  try {
    const configured = deployRoot(dataDir);
    roots.set(configured, configured);
  } catch (error) {
    result.errors.push({
      path: dataDir,
      reason: `Could not resolve the configured deployment root: ${error.message}`,
    });
  }

  for (const root of roots.values()) {
    let rootSnapshot;
    try {
      rootSnapshot = canonicalDirectorySnapshot(root);
    } catch (error) {
      result.errors.push({
        path: root,
        reason: error.message,
      });
      continue;
    }
    if (!rootSnapshot) continue;

    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      result.errors.push({ path: root, reason: error.message });
      continue;
    }
    if (!directoryStillMatches(rootSnapshot)) {
      result.errors.push({ path: root, reason: 'The deployment root changed while it was listed.' });
      continue;
    }

    for (const entry of entries) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(entry.name)) continue;
      const appFolder = path.join(root, entry.name);
      let appSnapshot;
      try {
        appSnapshot = canonicalDirectorySnapshot(appFolder);
      } catch (error) {
        result.errors.push({ path: appFolder, reason: error.message });
        continue;
      }
      if (!appSnapshot) continue;
      if (!directoryStillMatches(rootSnapshot) || !directoryStillMatches(appSnapshot)) {
        result.errors.push({ path: appFolder, reason: 'The deployment app folder changed while it was listed.' });
        continue;
      }
      folders.push({
        appId: entry.name,
        orphan: true,
        paths: pathsIn(appFolder),
        rootSnapshot: appSnapshot,
      });
    }
  }
  return folders;
}

function hasLegacyDiagnostics(run) {
  if (!run || isRedactedDeployRun(run) || run.logSecurity === LOG_SECURITY_RETIRED_V1) return false;
  return true;
}

function scrubbedLegacyRun(run, now) {
  const hasError = typeof run.error === 'string' && run.error.length > 0;
  const hasReason = typeof run.reason === 'string' && run.reason.length > 0;
  const hasWarnings = Array.isArray(run.warnings) && run.warnings.length > 0;
  const hasTail = Array.isArray(run.logTail) && run.logTail.length > 0;

  return {
    ...run,
    logSecurity: LOG_SECURITY_RETIRED_V1,
    logRetired: true,
    logRetiredAt: new Date(now).toISOString(),
    legacyDiagnosticsRemoved: hasError || hasReason || hasWarnings || hasTail,
    error: hasError ? LEGACY_DIAGNOSTIC_REDACTED : (run.error ?? null),
    reason: hasReason ? LEGACY_DIAGNOSTIC_REDACTED : (run.reason ?? null),
    warnings: hasWarnings ? [LEGACY_DIAGNOSTIC_REDACTED] : (run.warnings ?? []),
    logTail: [],
  };
}

/**
 * Registry roots are app-specific, so an app moved before the configurable
 * deploy root existed still needs retirement. Accept only an absolute
 * directory whose final component is that app's validated id.
 */
function registeredAppFolder(appId, paths) {
  if (!path.isAbsolute(paths.root) || path.basename(paths.root) !== appId) {
    throw new Error('The recorded deployment app folder is not the app id.');
  }
  const rootSnapshot = canonicalDirectorySnapshot(paths.root);
  if (!rootSnapshot) return { appId, orphan: false, paths, rootSnapshot: null };
  return { appId, orphan: false, paths, rootSnapshot };
}

function retireLog(file, directory) {
  try {
    return unlinkVerifiedChild(file, {
      expectedDirectory: path.dirname(file),
      expectedDirectoryIdentity: directory?.stat ?? null,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Retires all unmarked deployment logs and their free-form diagnostics.
 *
 * The per-app deploy lock is the same lock a deployment takes before it
 * creates a logger. Taking it here is what makes "skip an active deployment"
 * race-free: either this migration runs first, or the deployment does.
 */
export function retireLegacyDeployLogs({
  dataDir = getDataDir(),
  deps = {},
  now = Date.now,
} = {}) {
  if (!path.isAbsolute(String(dataDir ?? ''))) {
    throw new Error('Legacy deploy-log retirement requires an absolute data directory.');
  }

  const listAppsFn = deps.listApps ?? listApps;
  const acquireLockFn = deps.acquireLockAt ?? acquireLockAt;
  const appPathsFn = deps.appPaths ?? appPaths;
  const listRunsFn = deps.listRunsAt ?? listRunsAt;
  const writeRunFn = deps.writeRunAt ?? writeRunAt;

  const result = {
    ok: true,
    appsScanned: 0,
    orphanAppsScanned: 0,
    activeApps: [],
    retiredRuns: 0,
    removedLogs: 0,
    skippedLogs: 0,
    errors: [],
  };

  const migrationLock = acquireArtifactLockSync({
    dataDir,
    key: LOG_RETIREMENT_LOCK,
    timeoutMs: 10_000,
  });

  try {
    const apps = listAppsFn();
    if (!Array.isArray(apps)) throw new Error('The deployment app registry is not an array.');

    const targets = new Map();
    for (const app of apps) {
      if (typeof app?.id !== 'string' || !app.id) continue;
      try {
        const paths = appPathsFn(app.id, dataDir);
        const target = registeredAppFolder(app.id, paths);
        targets.set(pathKey(paths.root), target);
      } catch (error) {
        result.errors.push({ appId: app.id, reason: error.message });
      }
    }

    for (const folder of orphanAppFolders(dataDir, result)) {
      const key = pathKey(folder.paths.root);
      if (!targets.has(key)) targets.set(key, folder);
    }

    for (const target of targets.values()) {
      const {
        appId,
        orphan,
        paths,
        rootSnapshot,
      } = target;
      result.appsScanned += 1;
      if (orphan) result.orphanAppsScanned += 1;
      if (!rootSnapshot) continue;

      let runs;
      let logs;
      try {
        if (!directoryStillMatches(rootSnapshot)) {
          throw new Error('The deployment app folder changed before retirement.');
        }
        runs = listRunsFn(paths, { limit: Number.MAX_SAFE_INTEGER });
        logs = validLogIds(paths.logs);
      } catch (error) {
        result.errors.push({ appId, path: paths.root, reason: error.message });
        continue;
      }

      const marked = new Set(
        runs.filter((run) => isRedactedDeployRun(run)).map((run) => run.id),
      );
      const pendingRunIds = runs.filter(hasLegacyDiagnostics).map((run) => run.id);
      const pendingLogIds = logs.ids.filter((id) => !marked.has(id));
      if (pendingRunIds.length === 0 && pendingLogIds.length === 0) continue;

      let lock;
      try {
        lock = acquireLockFn(paths);
      } catch (error) {
        result.errors.push({ appId, path: paths.root, reason: error.message });
        continue;
      }
      if (!lock.ok) {
        result.activeApps.push(appId);
        continue;
      }

      try {
        // Re-read under the same lock a new deployment would hold.
        if (!directoryStillMatches(rootSnapshot)) {
          throw new Error('The deployment app folder changed before retirement.');
        }
        runs = listRunsFn(paths, { limit: Number.MAX_SAFE_INTEGER });
        logs = validLogIds(paths.logs);
        const redacted = new Set(
          runs.filter((run) => isRedactedDeployRun(run)).map((run) => run.id),
        );
        const retiredIds = new Set();
        const at = now();

        for (const run of runs) {
          if (isRedactedDeployRun(run)) continue;
          if (!hasLegacyDiagnostics(run) && run.logSecurity !== LOG_SECURITY_RETIRED_V1) continue;
          writeRunFn(paths, scrubbedLegacyRun(run, at));
          retiredIds.add(run.id);
          if (run.logSecurity !== LOG_SECURITY_RETIRED_V1) result.retiredRuns += 1;
        }

        for (const id of logs.ids) {
          if (redacted.has(id)) continue;
          try {
            if (retireLog(path.join(paths.logs, `${id}.log`), logs.directory)) {
              result.removedLogs += 1;
              retiredIds.add(id);
            }
          } catch (error) {
            result.errors.push({ appId, runId: id, reason: error.message });
          }
        }

        // A retired run is counted even if its log was already gone.
        for (const id of pendingRunIds) {
          if (!retiredIds.has(id)) result.skippedLogs += 1;
        }
        if (!directoryStillMatches(rootSnapshot)) {
          throw new Error('The deployment app folder changed during retirement.');
        }
      } catch (error) {
        result.errors.push({ appId, path: paths.root, reason: error.message });
      } finally {
        lock.release();
      }
    }
  } finally {
    migrationLock.release();
  }

  result.ok = result.errors.length === 0;
  return result;
}
