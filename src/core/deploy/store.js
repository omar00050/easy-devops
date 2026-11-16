/**
 * core/deploy/store.js
 *
 * Where a deployed app lives on disk, and the small files that describe it.
 *
 *   <dataDir>/deploy/<appId>/
 *     releases/<releaseId>/     one checkout per deployment, built in place
 *     runs/<runId>.json         the record of one deployment attempt
 *     logs/<runId>.log          its output
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

/** Name of the folder new apps are created in, under the data directory by default. */
export const DEPLOY_FOLDER = 'ez_deploys';
/** Where apps lived before the folder was configurable. Apps without a recorded `dir` are still there. */
const LEGACY_FOLDER = 'deploy';

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
    state: path.join(root, 'state.json'),
    lock: path.join(root, 'deploy.lock'),
    deployKey: path.join(root, 'id_deploy'),
  };
}

export function ensureAppDirs(appId, dataDir) {
  const p = appPaths(appId, dataDir);
  for (const dir of [p.root, p.releases, p.runs, p.logs]) fs.mkdirSync(dir, { recursive: true });
  return p;
}

// ─── Small atomic JSON files ──────────────────────────────────────────────────

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
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
  writeJsonAtomic(runFile(run.appId, run.id, dataDir), run);
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
  let file;
  try { file = logFile(appId, runId, dataDir); } catch { return { text: '', truncated: false }; }

  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    // Starting mid-file usually lands inside a line; drop the partial one.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: start > 0 };
  } catch {
    return { text: '', truncated: false };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
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
export function acquireLock(appId, { runId = null, dataDir, now = Date.now() } = {}) {
  const p = ensureAppDirs(appId, dataDir);
  const body = JSON.stringify({ pid: process.pid, runId, at: now });

  const take = () => {
    fs.writeFileSync(p.lock, body, { flag: 'wx' });
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        // Only remove a lock that is still ours: after a stale takeover it is
        // somebody else's, and removing it would let a third deployment in.
        const held = readJson(p.lock);
        if (held?.pid === process.pid && held?.runId === runId) {
          try { fs.rmSync(p.lock, { force: true }); } catch { /* ignore */ }
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

  try { fs.rmSync(p.lock, { force: true }); } catch { /* raced with another taker */ }
  try {
    return take();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return { ok: false, reason: 'A deployment of this app is already running.', runId: null };
  }
}

/** The run currently holding the lock, or null. */
export function lockHolder(appId, dataDir) {
  const held = readJson(appPaths(appId, dataDir).lock);
  if (!held || !pidAlive(held.pid) || Date.now() - (held.at ?? 0) > LOCK_STALE_MS) return null;
  return { pid: held.pid, runId: held.runId ?? null, at: held.at ?? null };
}

/** Removes everything on disk for an app. */
export function removeAppFiles(appId, dataDir) {
  fs.rmSync(appPaths(appId, dataDir).root, { recursive: true, force: true });
}
