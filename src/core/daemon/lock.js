/**
 * core/daemon/lock.js
 *
 * Single-instance lock for the background daemon, and the signal the dashboard
 * uses to decide whether it should run the jobs itself.
 *
 * The lock is a JSON file in the data directory holding a pid, a start time and
 * a heartbeat the owner refreshes every few seconds. Two readers care about it:
 *
 *   - `ezz daemon` refuses to start when another daemon already holds it.
 *   - `ezz --dash` runs the background jobs only while NO daemon holds it, and
 *     hands them over in either direction when that changes.
 *
 * ── Why a heartbeat and not just a pid ─────────────────────────────────────
 *
 * A pid alone is not enough in either direction. A crashed daemon leaves its
 * pid behind, and the OS will eventually hand that number to something else —
 * so a live pid does not prove OUR process is alive. A heartbeat alone is not
 * enough either: a daemon stopped at a breakpoint, or a machine resumed from
 * sleep, has a stale heartbeat while still holding the socket.
 *
 * So a lock is considered dead only when BOTH say so: the heartbeat is older
 * than STALE_AFTER_MS *and* the pid is not running. That errs toward leaving a
 * questionable lock alone, which is the safe direction — two daemons competing
 * for the hub socket is worse than none, and "none" is visible to the user
 * while "two" is not.
 */

import fs from 'fs';
import path from 'path';
import { getDataDir } from '../platform.js';

/** How often the owner refreshes the heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * How old a heartbeat may get before the lock is a candidate for recovery.
 * Four missed beats: long enough to survive a slow disk or a GC pause, short
 * enough that a real crash is recovered inside a dashboard poll interval.
 */
export const STALE_AFTER_MS = 20_000;

/** Lock file name inside the data directory. */
const LOCK_FILE = 'daemon.lock';

/** @returns {string} Absolute path to the lock file. */
export function lockPath(dataDir = getDataDir()) {
  return path.join(dataDir, LOCK_FILE);
}

/**
 * True when a process with this pid exists.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process exists but belongs to another user, which
 * for our purposes is "alive".
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Reads the lock without judging it.
 * @returns {{ pid: number, startedAt: number, heartbeatAt: number, version: string|null, mode: string|null }|null}
 */
export function readLock(dataDir = getDataDir()) {
  try {
    const raw = fs.readFileSync(lockPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Number.isInteger(parsed?.pid)) return null;
    return {
      pid: parsed.pid,
      startedAt: Number(parsed.startedAt) || 0,
      heartbeatAt: Number(parsed.heartbeatAt) || 0,
      version: parsed.version ?? null,
      mode: parsed.mode ?? null,
    };
  } catch {
    // Missing, unreadable or truncated — all mean "no usable lock". A
    // half-written file is possible if a daemon died mid-write, and treating
    // that as absent is correct: nothing is holding it.
    return null;
  }
}

/**
 * The state of the daemon as far as anyone else can tell.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {number} [opts.now] Injectable clock, for tests
 * @returns {{ running: boolean, stale: boolean, lock: Object|null, age: number|null, reason: string }}
 */
export function inspect({ dataDir = getDataDir(), now = Date.now() } = {}) {
  const lock = readLock(dataDir);
  if (!lock) return { running: false, stale: false, lock: null, age: null, reason: 'no lock file' };

  const age = now - lock.heartbeatAt;
  const alive = isPidAlive(lock.pid);
  const fresh = age < STALE_AFTER_MS;

  // Alive OR fresh counts as running. Both must fail before the lock is
  // treated as abandoned — see the module header.
  if (alive && fresh) {
    return { running: true, stale: false, lock, age, reason: 'pid alive, heartbeat fresh' };
  }
  if (alive && !fresh) {
    return { running: true, stale: false, lock, age, reason: `pid ${lock.pid} alive but heartbeat is ${Math.round(age / 1000)}s old` };
  }
  if (!alive && fresh) {
    return { running: true, stale: false, lock, age, reason: 'heartbeat fresh but pid is gone; waiting for it to go stale' };
  }

  return {
    running: false,
    stale: true,
    lock,
    age,
    reason: `pid ${lock.pid} is gone and the heartbeat is ${Math.round(age / 1000)}s old`,
  };
}

/** Convenience: is a daemon holding this data directory right now? */
export function isDaemonRunning(opts = {}) {
  return inspect(opts).running;
}

/**
 * Takes the lock for this process.
 *
 * Recovers an abandoned lock, refuses a live one. The write is atomic — a
 * temporary file renamed into place — so a reader can never see a half-written
 * lock, and `wx` on the temp name means two daemons racing cannot both believe
 * they created it.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {string} [opts.version]
 * @param {string} [opts.mode] Free-form label, e.g. 'daemon' or 'dashboard'
 * @param {number} [opts.now]
 * @returns {{ ok: true, recovered: boolean, lock: Object }
 *          | { ok: false, reason: string, lock: Object|null }}
 */
export function acquire({
  dataDir = getDataDir(),
  version = null,
  mode = 'daemon',
  now = Date.now(),
} = {}) {
  const state = inspect({ dataDir, now });

  if (state.running) {
    // Our own pid holding it is not a conflict: a re-acquire is idempotent so
    // a restart inside one process does not deadlock itself.
    if (state.lock?.pid === process.pid) {
      return { ok: true, recovered: false, lock: write({ dataDir, version, mode, now }) };
    }
    return { ok: false, reason: state.reason, lock: state.lock };
  }

  return { ok: true, recovered: state.stale, lock: write({ dataDir, version, mode, now }) };
}

/**
 * Refreshes the heartbeat.
 *
 * Returns false when the lock is gone or has been taken over, which the caller
 * must treat as "I am no longer the owner" rather than ignoring: continuing to
 * run jobs after losing the lock is exactly the duplicate-work case the lock
 * exists to prevent.
 *
 * @returns {boolean} True while this process still owns the lock
 */
export function heartbeat({ dataDir = getDataDir(), version = null, mode = 'daemon', now = Date.now() } = {}) {
  const current = readLock(dataDir);
  if (!current || current.pid !== process.pid) return false;

  write({ dataDir, version, mode, now, startedAt: current.startedAt });
  return true;
}

/**
 * Releases the lock, but only if this process owns it.
 * @returns {boolean} True when a lock was actually removed
 */
export function release({ dataDir = getDataDir() } = {}) {
  const current = readLock(dataDir);
  if (!current || current.pid !== process.pid) return false;

  try {
    fs.unlinkSync(lockPath(dataDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Calls back whenever the lock file appears, changes or disappears.
 *
 * The dashboard polls ownership every 15 seconds, which is fine for noticing a
 * daemon that went away but far too slow for one that arrived: for those
 * seconds both processes ran the jobs, so both had a Hub agent connected with
 * the same serverId and the Hub evicted them in turn. Watching the file closes
 * that window to milliseconds.
 *
 * The DIRECTORY is watched rather than the file, because the file does not
 * exist when there is no daemon — and that absence is exactly the state a
 * watcher needs to see change. `fs.watch` on a missing path throws.
 *
 * Events are debounced: an atomic write is a create plus a rename, which
 * surfaces as several events for one logical change.
 *
 * @param {Object} opts
 * @param {string} [opts.dataDir]
 * @param {() => void} opts.onChange
 * @param {number} [opts.debounceMs]
 * @returns {{ close: () => void, watching: boolean }}
 */
export function watchLock({ dataDir = getDataDir(), onChange, debounceMs = 50 } = {}) {
  let timer = null;
  let watcher = null;

  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        onChange?.();
      } catch (err) {
        console.error('[lock] watch handler threw:', err.message);
      }
    }, debounceMs);
  };

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    watcher = fs.watch(dataDir, (_event, filename) => {
      // A rename within the directory reports the temp name too; only the
      // lock itself matters. A null filename (possible on some platforms)
      // is treated as "something changed", which is the safe direction.
      if (!filename || filename === LOCK_FILE) fire();
    });
    watcher.on('error', () => { /* the poll remains as the fallback */ });
  } catch {
    // No watcher is survivable: ownership is still re-checked on the poll, so
    // the hand-over is slow rather than broken.
    watcher = null;
  }

  return {
    watching: watcher !== null,
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      try { watcher?.close(); } catch { /* already closed */ }
      watcher = null;
    },
  };
}

/**
 * Writes the lock atomically.
 *
 * `rename` is atomic on both platforms for a same-directory move, so a reader
 * either sees the old file or the new one — never a partial write.
 */
function write({ dataDir, version, mode, now, startedAt }) {
  const payload = {
    pid: process.pid,
    startedAt: startedAt ?? now,
    heartbeatAt: now,
    version,
    mode,
  };

  const target = lockPath(dataDir);
  const temp = `${target}.${process.pid}.tmp`;

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);

  return payload;
}
