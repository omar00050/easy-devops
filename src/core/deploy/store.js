/**
 * core/deploy/store.js
 *
 * Where a deployed app lives on disk, and the small files that describe it.
 *
 *   <dataDir>/deploy/<appId>/
 *     releases/<releaseId>/     one checkout per deployment, built in place
 *     runs/<runId>.json         the record of one deployment attempt
 *     logs/<runId>.log          its output
 *     shared/                   data that outlives a release, linked into each one
 *     state.json                which release is live, and the one before it
 *     deploy.lock               held while a deployment is running
 *     id_deploy                 the app's private deploy key, when it has one
 *
 * ── Why files, not the database ──────────────────────────────────────────────
 *
 * A deployment can be started by the dashboard (a button) or by the background
 * service (the deploy hook, the Hub), which are different processes. good.db
 * offers no compare-and-swap, so two processes updating one array of runs
 * would lose writes. Each run is therefore its own file, written atomically
 * (temp file + rename), and the lock is a file created with the exclusive
 * flag. The APP REGISTRY stays in the database (core/deploy/apps.js): it is
 * only ever edited by a person, one request at a time.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { getDataDir } from '../platform.js';
import { dbGet } from '../db.js';
import { loadConfig } from '../config.js';
import {
  openVerifiedChild, unlinkVerifiedChild, writeFileEventual,
} from '../safe-file.js';

/** Name of the folder new apps are created in, under the data directory by default. */
export const DEPLOY_FOLDER = 'ez_deploys';
/** Where apps lived before the folder was configurable. Apps without a recorded `dir` are still there. */
const LEGACY_FOLDER = 'deploy';
/**
 * Engine-owned deployment artifacts. These are deliberately outside the
 * deploy root: an app's install/build hooks can change every file in a
 * checkout, but they must never be able to redirect a generated PM2 config,
 * launcher, or release record through a link.
 */
export const ENGINE_ARTIFACT_FOLDER = 'engine-deploy';

/** How many run records are kept per app. Older ones are deleted with their logs. */
export const MAX_RUNS_KEPT = 30;

/**
 * A lock older than this is treated as abandoned even if its pid is alive —
 * the pid may have been reused by an unrelated process after a crash.
 */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * A folder path that is safe to put in a shell command between double quotes.
 *
 * The deployments folder is typed by a person and ends up in `git -C "<dir>"`
 * and `pm2 start "<file>"`. Rather than escape it per shell, the characters
 * that could end the quoting or expand inside it are refused outright; nothing
 * a real folder path needs is lost. Spaces are fine.
 *
 * @returns {string|null} An error message, or null when the path is acceptable
 */
export function validateDeployDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return 'A folder path is required.';
  const value = dir.trim();
  if (value.length > 400) return 'The path is too long.';
  if (!path.isAbsolute(value)) return 'Use an absolute path, such as /srv/ez_deploys or D:\\ez_deploys.';
  if (/["'`$\r\n\0;&|<>*?%!]/.test(value)) return 'The path contains characters that are not allowed.';
  if (path.parse(path.resolve(value)).root === path.resolve(value)) return 'Choose a folder, not the root of a drive.';
  return null;
}

/** The default deployments folder: `<data dir>/ez_deploys`. */
export function defaultDeployRoot(dataDir = getDataDir()) {
  return path.join(dataDir, DEPLOY_FOLDER);
}

/**
 * Where NEW apps are created: the `deployDir` setting, or the default.
 *
 * Changing the setting never moves anything. Every app records the folder it
 * was created in (`dir` on its record) and keeps using it; only apps created
 * afterwards land in the new place. Moving an existing app is an explicit
 * action — moveApp() in core/deploy/engine.js.
 */
export function deployRoot(dataDir = getDataDir()) {
  let configured = null;
  try { configured = loadConfig()?.deployDir ?? null; } catch { /* unreadable config: use the default */ }
  if (typeof configured === 'string' && validateDeployDir(configured) === null) return path.resolve(configured.trim());
  return defaultDeployRoot(dataDir);
}

/**
 * The folder one app lives in.
 *
 *   1. the `dir` on its record — set at creation, changed only by a move;
 *   2. the pre-setting location `<data dir>/deploy/<id>`, when that exists —
 *      apps created before the folder was configurable are still there;
 *   3. otherwise where a new app with this id would be created.
 */
export function appRoot(appId, dataDir = getDataDir()) {
  let record = null;
  try {
    const apps = dbGet('deployApps');
    record = Array.isArray(apps) ? apps.find((a) => a?.id === appId) ?? null : null;
  } catch { /* fall through to the computed locations */ }

  if (typeof record?.dir === 'string' && record.dir) return record.dir;

  const legacy = path.join(dataDir, LEGACY_FOLDER, appId);
  if (fs.existsSync(legacy)) return legacy;
  return path.join(deployRoot(dataDir), appId);
}

/**
 * Paths for one app.
 *
 * `appId` is validated by core/deploy/apps.js before it gets anywhere near
 * here; the check below is a second line, because this value becomes a
 * directory name and a traversal would be a write outside the data directory.
 */
export function appPaths(appId, dataDir = getDataDir()) {
  if (typeof appId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(appId)) {
    throw new Error(`Invalid app id: ${JSON.stringify(appId)}`);
  }
  return pathsIn(appRoot(appId, dataDir));
}

/** The same layout, for an explicit folder — used while an app is being moved. */
export function pathsIn(root) {
  return {
    root,
    releases: path.join(root, 'releases'),
    runs: path.join(root, 'runs'),
    logs: path.join(root, 'logs'),
    shared: path.join(root, 'shared'),
    state: path.join(root, 'state.json'),
    lock: path.join(root, 'deploy.lock'),
    deployKey: path.join(root, 'id_deploy'),
  };
}

/**
 * The private artifact directory for one release. It always lives below the
 * data directory, even when the app checkout is in a custom deploy folder.
 */
export function engineAppDir(appId, dataDir = getDataDir()) {
  if (typeof appId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(appId)) {
    throw new Error(`Invalid app id: ${JSON.stringify(appId)}`);
  }
  return path.join(dataDir, ENGINE_ARTIFACT_FOLDER, appId);
}

export function engineReleaseDir(appId, releaseId, dataDir = getDataDir()) {
  if (!isId(releaseId)) throw new Error(`Invalid release id: ${JSON.stringify(releaseId)}`);
  return path.join(engineAppDir(appId, dataDir), releaseId);
}

function ensurePrivateDirectory(directory, mode) {
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Refusing a linked or non-directory engine artifact path: ${directory}`);
    }
    fs.chmodSync(directory, mode);
    return existing;
  }

  fs.mkdirSync(directory, { mode });
  const created = fs.lstatSync(directory);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`Refusing a linked or non-directory engine artifact path: ${directory}`);
  }
  fs.chmodSync(directory, mode);
  return created;
}

/**
 * Create and return one release's private artifact directory.
 *
 * Each newly introduced path component is checked independently so a link
 * cannot make a later component resolve outside the engine-owned tree.
 */
export function ensureEngineReleaseDir(appId, releaseId, dataDir = getDataDir()) {
  const root = path.resolve(dataDir);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`The Easy DevOps data directory is not a regular directory: ${root}`);
  }

  ensurePrivateDirectory(path.join(root, ENGINE_ARTIFACT_FOLDER), 0o700);
  ensurePrivateDirectory(path.join(root, ENGINE_ARTIFACT_FOLDER, appId), 0o700);
  return ensurePrivateDirectory(engineReleaseDir(appId, releaseId, root), 0o700);
}

/** Read a JSON artifact only from the engine-owned location. */
export function readEngineJson(appId, releaseId, fileName, dataDir = getDataDir()) {
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName || !fileName.endsWith('.json')) {
    throw new Error(`Invalid engine artifact name: ${JSON.stringify(fileName)}`);
  }
  return readJson(path.join(engineReleaseDir(appId, releaseId, dataDir), fileName));
}

export function removeEngineRelease(appId, releaseId, dataDir = getDataDir()) {
  fs.rmSync(engineReleaseDir(appId, releaseId, dataDir), { recursive: true, force: true });
}

export function ensureAppDirs(appId, dataDir) {
  const p = appPaths(appId, dataDir);
  for (const dir of [p.root, p.releases, p.runs, p.logs]) fs.mkdirSync(dir, { recursive: true });
  return p;
}

// ─── Small atomic JSON files ──────────────────────────────────────────────────

function writeJsonAtomic(file, value) {
  writeFileEventual(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function readJson(file) {
  let opened;
  try {
    opened = openVerifiedChild(file);
    return JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
  } catch {
    return null;
  } finally {
    opened?.close();
  }
}

// ─── Ids ──────────────────────────────────────────────────────────────────────

/**
 * A release id: sortable by time, unique, and safe as a directory name on
 * both platforms. e.g. `20261115-214502-3fa9c1`.
 */
export function newReleaseId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/** True for a string shaped like an id this module generates. */
export function isId(value) {
  return typeof value === 'string' && /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(value);
}

// ─── State ────────────────────────────────────────────────────────────────────

/** @returns {{ current: string|null, previous: string|null, updatedAt: number|null }} */
export function readState(appId, dataDir) {
  const s = readJson(appPaths(appId, dataDir).state);
  return {
    current: isId(s?.current) ? s.current : null,
    previous: isId(s?.previous) ? s.previous : null,
    updatedAt: typeof s?.updatedAt === 'number' ? s.updatedAt : null,
  };
}

export function writeState(appId, state, dataDir) {
  ensureAppDirs(appId, dataDir);
  writeJsonAtomic(appPaths(appId, dataDir).state, { ...state, updatedAt: Date.now() });
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export function runFile(appId, runId, dataDir) {
  if (!isId(runId)) throw new Error(`Invalid run id: ${JSON.stringify(runId)}`);
  return path.join(appPaths(appId, dataDir).runs, `${runId}.json`);
}

export function logFile(appId, runId, dataDir) {
  if (!isId(runId)) throw new Error(`Invalid run id: ${JSON.stringify(runId)}`);
  return path.join(appPaths(appId, dataDir).logs, `${runId}.log`);
}

export function writeRun(run, dataDir) {
  ensureAppDirs(run.appId, dataDir);
  writeRunAt(appPaths(run.appId, dataDir), run);
}

/**
 * Reads runs from one explicit app folder.
 *
 * Unlike the ordinary dashboard accessor, this migration-facing reader refuses
 * a linked runs directory or a linked/hard-linked run file. A legacy record
 * that cannot be trusted must not be copied into a backup as though it had
 * been inspected and scrubbed.
 */
export function listRunsAt(paths, { limit = MAX_RUNS_KEPT } = {}) {
  const directory = fs.lstatSync(paths.runs, { throwIfNoEntry: false });
  if (!directory) return [];
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`Refusing a linked or non-directory deployment runs folder: ${paths.runs}`);
  }

  const names = fs.readdirSync(paths.runs)
    .filter((name) => name.endsWith('.json') && isId(name.slice(0, -5)))
    .sort()
    .reverse()
    .slice(0, limit);

  return names.map((name) => {
    const id = name.slice(0, -5);
    const file = path.join(paths.runs, name);
    let handle;
    try {
      handle = openVerifiedChild(file, { expectedDirectory: paths.runs });
      const run = JSON.parse(fs.readFileSync(handle.fd, 'utf8'));
      if (!run || typeof run !== 'object' || run.id !== id) {
        throw new Error(`Invalid deployment run record: ${file}`);
      }
      return run;
    } finally {
      handle?.close();
    }
  });
}

/** Writes a run to one explicit app folder by exclusive-create and rename. */
export function writeRunAt(paths, run) {
  if (!isId(run?.id)) throw new Error(`Invalid run id: ${JSON.stringify(run?.id)}`);
  writeJsonAtomic(path.join(paths.runs, `${run.id}.json`), run);
}

/** @returns {Object|null} */
export function readRun(appId, runId, dataDir) {
  if (!isId(runId)) return null;
  let file;
  try { file = runFile(appId, runId, dataDir); } catch { return null; }
  const run = readJson(file);
  return run && run.id === runId ? run : null;
}

/**
 * Newest first.
 * @returns {Array<Object>}
 */
export function listRuns(appId, { limit = MAX_RUNS_KEPT, dataDir } = {}) {
  let names;
  try {
    names = fs.readdirSync(appPaths(appId, dataDir).runs);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && isId(n.slice(0, -5)))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((n) => readRun(appId, n.slice(0, -5), dataDir))
    .filter(Boolean);
}

/** Deletes run records (and their logs) beyond the newest MAX_RUNS_KEPT. */
export function pruneRuns(appId, dataDir) {
  const p = appPaths(appId, dataDir);
  let names;
  try { names = fs.readdirSync(p.runs); } catch { return 0; }

  const ids = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter(isId).sort().reverse();
  let removed = 0;
  for (const id of ids.slice(MAX_RUNS_KEPT)) {
    try { fs.rmSync(path.join(p.runs, `${id}.json`), { force: true }); removed += 1; } catch { /* next time */ }
    try { fs.rmSync(path.join(p.logs, `${id}.log`), { force: true }); } catch { /* next time */ }
  }
  return removed;
}

/**
 * The tail of a run's log.
 * @returns {{ text: string, truncated: boolean }}
 */
export function readLogTail(appId, runId, { maxBytes = 64 * 1024, dataDir } = {}) {
  let paths;
  let file;
  try {
    paths = appPaths(appId, dataDir);
    file = path.join(paths.logs, `${runId}.log`);
    if (!isId(runId)) throw new Error('invalid run id');
  } catch {
    return { text: '', truncated: false };
  }

  const budget = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Math.min(64 * 1024, Math.trunc(Number(maxBytes)))
    : 64 * 1024;
  let opened;
  try {
    opened = openVerifiedChild(file, { expectedDirectory: paths.logs });
    const size = opened.opened.size;
    const start = Math.max(0, size - budget);
    const buf = Buffer.alloc(size - start);
    fs.readSync(opened.fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    // Starting mid-file usually lands inside a line; drop the partial one.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: start > 0 };
  } catch {
    return { text: '', truncated: false };
  } finally {
    opened?.close();
  }
}

// ─── Releases ─────────────────────────────────────────────────────────────────

export function releaseDir(appId, releaseId, dataDir) {
  if (!isId(releaseId)) throw new Error(`Invalid release id: ${JSON.stringify(releaseId)}`);
  return path.join(appPaths(appId, dataDir).releases, releaseId);
}

/** Release ids on disk, newest first. */
export function listReleases(appId, dataDir) {
  try {
    return fs.readdirSync(appPaths(appId, dataDir).releases, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isId(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Removes old releases, keeping the newest `keep` plus anything in `protect`.
 * The live release and the one a rollback would return to are always
 * protected by the caller — deleting either would turn a rollback into an
 * outage.
 *
 * @returns {string[]} The release ids that were removed
 */
export function pruneReleases(appId, { keep = 5, protect = [], dataDir } = {}) {
  const all = listReleases(appId, dataDir);
  const guarded = new Set(protect.filter(Boolean));
  const removed = [];
  for (const id of all.slice(Math.max(1, keep))) {
    if (guarded.has(id)) continue;
    try {
      fs.rmSync(releaseDir(appId, id, dataDir), { recursive: true, force: true });
      removeEngineRelease(appId, id, dataDir);
      removed.push(id);
    } catch { /* a file in use (Windows): try again on the next deployment */ }
  }
  return removed;
}

// ─── The per-app lock ─────────────────────────────────────────────────────────

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return err.code === 'EPERM';
  }
}

/**
 * Takes the deployment lock for an app.
 *
 * Two deployments of one app at once would build into each other's process
 * list: both would stop and start the same PM2 name. The exclusive-create
 * flag makes taking the lock atomic across processes.
 *
 * @returns {{ ok: true, release: () => void } | { ok: false, reason: string, runId: string|null }}
 */
export function acquireLockAt(paths, { runId = null, now = Date.now() } = {}) {
  const p = paths;
  const token = crypto.randomBytes(16).toString('hex');
  const body = JSON.stringify({ pid: process.pid, runId, at: now, token });

  const take = () => {
    let opened;
    try {
      opened = openVerifiedChild(p.lock, {
        expectedDirectory: p.root,
        flags: fs.constants.O_WRONLY | fs.constants.O_CREAT,
        mode: 0o600,
        exclusive: true,
      });
      fs.writeFileSync(opened.fd, body, 'utf8');
    } finally {
      opened?.close();
    }
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        // Only remove a lock that is still ours: after a stale takeover it is
        // somebody else's, and removing it would let a third deployment in.
        const held = readJson(p.lock);
        if (held?.pid === process.pid && held?.runId === runId && held?.token === token) {
          try {
            unlinkVerifiedChild(p.lock, { expectedDirectory: p.root });
          } catch { /* a replacement lock is not ours to remove */ }
        }
      },
    };
  };

  try {
    return take();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const held = readJson(p.lock);
  const stale = !held || !pidAlive(held.pid) || now - (held.at ?? 0) > LOCK_STALE_MS;
  if (!stale) {
    return { ok: false, reason: 'A deployment of this app is already running.', runId: held.runId ?? null };
  }

  try {
    const listed = fs.lstatSync(p.lock, { throwIfNoEntry: false });
    if (listed) {
      unlinkVerifiedChild(p.lock, {
        expectedDirectory: p.root,
        expected: listed,
      });
    }
  } catch { /* raced with another taker or was replaced */ }
  try {
    return take();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return { ok: false, reason: 'A deployment of this app is already running.', runId: null };
  }
}

export function acquireLock(appId, { runId = null, dataDir, now = Date.now() } = {}) {
  return acquireLockAt(ensureAppDirs(appId, dataDir), { runId, now });
}

/** The run currently holding the lock, or null. */
export function lockHolder(appId, dataDir) {
  const held = readJson(appPaths(appId, dataDir).lock);
  if (!held || !pidAlive(held.pid) || Date.now() - (held.at ?? 0) > LOCK_STALE_MS) return null;
  return { pid: held.pid, runId: held.runId ?? null, at: held.at ?? null };
}

/**
 * Removes an app's folder — or everything in it except `shared/`.
 *
 * Persistent data is the one thing a delete does not destroy silently: the
 * default keeps it, and removing it is an explicit choice. A `shared/` that
 * holds nothing is removed with the rest, so an app that never used it leaves
 * no trace.
 *
 * @returns {{ keptShared: boolean, sharedPath: string }}
 */
export function removeAppFiles(appId, { keepShared = false, dataDir } = {}) {
  const p = appPaths(appId, dataDir);
  const artifacts = engineAppDir(appId, dataDir);

  let hasShared = false;
  if (keepShared) {
    try { hasShared = fs.readdirSync(p.shared).length > 0; } catch { /* no shared folder */ }
  }
  if (!hasShared) {
    fs.rmSync(p.root, { recursive: true, force: true });
    fs.rmSync(artifacts, { recursive: true, force: true });
    return { keptShared: false, sharedPath: p.shared };
  }

  for (const entry of fs.readdirSync(p.root)) {
    if (entry === 'shared') continue;
    fs.rmSync(path.join(p.root, entry), { recursive: true, force: true });
  }
  fs.rmSync(artifacts, { recursive: true, force: true });
  return { keptShared: true, sharedPath: p.shared };
}
