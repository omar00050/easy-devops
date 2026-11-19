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

/**
 * How long a recovery guard left by a crashed process must sit before another
 * process may clear it. Long enough that a slow (but live) recovery is never
 * cleared out from under itself, short enough that a crash does not need a
 * reboot to recover from.
 */
const RECOVERY_GUARD_STALE_MS = 30_000;

/**
 * How long an empty, unreadable lock file may exist before another process may
 * treat it as abandoned.
 *
 * Creating a lock is `writeFileSync(path, data, { flag: 'wx' })`, which creates
 * the file and THEN writes it — so a brand-new lock is briefly empty. A reader
 * in that window must not "recover" a lock created microseconds earlier.
 */
const UNREADABLE_GRACE_MS = 2_000;

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
 * Reads a lock file without judging it.
 *
 * @param {string} file Absolute path to the lock file
 * @returns {{ pid: number, startedAt: number, heartbeatAt: number, version: string|null, mode: string|null }|null}
 */
function readLockAt(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
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
 * True when an unreadable lock file is a create that has not been written yet.
 *
 * An empty file younger than the grace is somebody's `wx` create in flight, so
 * it counts as LIVE. An empty file older than the grace is a crash between the
 * create and the write, and may be recovered. A file that has content but does
 * not parse is a truncated write, which has no live owner at all.
 *
 * @param {string} file
 * @param {number} now
 * @returns {boolean}
 */
function isWriteInFlight(file, now) {
  try {
    const stat = fs.statSync(file);
    return stat.size === 0 && now - stat.mtimeMs < UNREADABLE_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Reads the lock in a data directory without judging it.
 * @returns {{ pid: number, startedAt: number, heartbeatAt: number, version: string|null, mode: string|null }|null}
 */
export function readLock(dataDir = getDataDir()) {
  return readLockAt(lockPath(dataDir));
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
 * Refuses a live lock, recovers an abandoned one. Creating a lock is a single
 * EXCLUSIVE open (`wx`), so two daemons can never both believe they created
 * it, and there is no check-then-write window.
 *
 * Recovering a STALE lock is the subtle half. Deciding from `inspect()` before
 * the race is not enough: several processes see the same dead lock, all are
 * entitled to recover it, and if each one deletes "the stale file" it saw, the
 * second deletes the FIRST ONE'S BRAND-NEW LOCK. Both report success and one of
 * them owns nothing.
 *
 * Moving the file aside first does not fix that either: the path is empty for
 * as long as it takes to judge and re-create, and on a machine with real-time
 * scanning that can be milliseconds — long enough for another process to create
 * there. Measured with six contenders, that produced two winners.
 *
 * So recovery is serialised and the lock is only ever REPLACED, never removed:
 *
 *   1. exactly one process can create `daemon.lock.recovery` (`wx`), which is
 *      the permission to recover; everyone else is refused;
 *   2. inside that guard the lock is re-read — that read is authoritative,
 *      because no other process may touch it — and a live lock is refused;
 *   3. a dead one is replaced by an atomic `rename` of a prepared candidate
 *      over it. The path is never empty, so there is nothing for a third
 *      process to slip into.
 *
 * The guard is removed in a `finally`. One left behind by a crash is only
 * cleared when its pid is gone and it has been sitting long enough, so it can
 * never be cleared out from under a live recovery.
 *
 * Re-acquiring as the same pid stays idempotent, and rewriting one's own lock
 * (heartbeat) still goes through the atomic temp-file rename: only the owner
 * does that, so a reader always sees either the old lock or the new one.
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

  const payload = { pid: process.pid, startedAt: now, heartbeatAt: now, version, mode };

  const first = createExclusive(dataDir, payload);
  if (first.ok) return { ok: true, recovered: state.stale, lock: payload };

  if (first.code !== 'EEXIST') {
    return { ok: false, reason: `could not create the lock: ${first.message}`, lock: null };
  }

  // A lock file appeared after inspect() saw none. If it is a readable lock, it
  // is somebody's and nothing here is recoverable. A file that exists but
  // cannot be read (truncated by a crash) has no owner to respect, so it falls
  // through to the guard below, which replaces it rather than blocking for ever.
  if (!state.lock && !fs.existsSync(lockPath(dataDir))) {
    return { ok: false, reason: 'another process created the lock first', lock: readLock(dataDir) };
  }

  // Empty and just created: that is a `wx` create whose write has not landed
  // yet. Reading it in that window is not permission to take it over.
  if (!state.lock && isWriteInFlight(lockPath(dataDir), now)) {
    return { ok: false, reason: 'another process is writing its lock', lock: readLock(dataDir) };
  }

  const guard = acquireRecoveryGuard({ dataDir, now });
  if (!guard.ok) {
    return { ok: false, reason: guard.reason, lock: readLock(dataDir) };
  }

  try {
    // Authoritative: nobody else may change the lock while we hold the guard.
    const current = inspect({ dataDir, now });

    if (current.running) {
      if (current.lock?.pid === process.pid) {
        return { ok: true, recovered: false, lock: write({ dataDir, version, mode, now }) };
      }
      return { ok: false, reason: current.reason, lock: current.lock };
    }

    if (!current.lock) {
      // Empty and just created is still a create in flight — treat it as live.
      if (isWriteInFlight(lockPath(dataDir), now)) {
        return { ok: false, reason: 'another process is writing its lock', lock: null };
      }

      // Nothing readable is at the path: either the file vanished (a release,
      // or a crash being cleaned up) or it is truncated/half-written. A lock
      // with no readable owner cannot be waited on, so it is abandoned —
      // created over if it is gone, replaced under the guard if it is still
      // there. Blocking here for ever is what a crash would otherwise cause.
      const again = createExclusive(dataDir, payload);
      if (again.ok) return { ok: true, recovered: true, lock: payload };

      if (again.code !== 'EEXIST') {
        return { ok: false, reason: `could not create the lock: ${again.message}`, lock: null };
      }

      const replaced = replaceLock({ dataDir, payload });
      return replaced.ok
        ? { ok: true, recovered: true, lock: payload }
        : { ok: false, reason: `could not replace the unreadable lock: ${replaced.message}`, lock: null };
    }

    const replaced = replaceLock({ dataDir, payload });
    if (!replaced.ok) {
      return { ok: false, reason: `could not replace the stale lock: ${replaced.message}`, lock: readLock(dataDir) };
    }

    return { ok: true, recovered: true, lock: payload };
  } finally {
    guard.release();
  }
}

/**
 * Creates the recovery guard exclusively, or explains why recovery may not run.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {number} opts.now
 * @returns {{ ok: true, release: () => void } | { ok: false, reason: string }}
 */
function acquireRecoveryGuard({ dataDir, now }) {
  const file = `${lockPath(dataDir)}.recovery`;
  const payload = { pid: process.pid, at: now };

  const attempt = () => {
    try {
      fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err?.code ?? 'UNKNOWN', message: err?.message ?? String(err) };
    }
  };

  const release = () => {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  };

  const first = attempt();
  if (first.ok) return { ok: true, release };
  if (first.code !== 'EEXIST') {
    return { ok: false, reason: `could not create the recovery guard: ${first.message}` };
  }

  // A guard left behind by a process that died mid-recovery. It is not the
  // lock itself, so it may be cleared — but only once its owner is provably
  // gone and it is old enough that a slow recovery cannot be the one holding it.
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* unreadable: treat it as live */ }

  const abandoned = Boolean(existing)
    && Number.isInteger(existing.pid)
    && !isPidAlive(existing.pid)
    && now - (Number(existing.at) || 0) > RECOVERY_GUARD_STALE_MS;

  if (!abandoned) return { ok: false, reason: 'another process is recovering the lock' };

  try { fs.unlinkSync(file); } catch { /* another process cleared it first */ }

  const second = attempt();
  return second.ok
    ? { ok: true, release }
    : { ok: false, reason: 'another process is recovering the lock' };
}

/**
 * Replaces the lock file with this process's payload, atomically.
 *
 * A `rename` within the directory is a replace: the lock path goes from the old
 * file to the new one in one step, so it is never absent and no third process
 * can create there. Called only while the recovery guard is held.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {Object} opts.payload
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function replaceLock({ dataDir, payload }) {
  const target = lockPath(dataDir);
  const candidate = `${target}.candidate-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const body = `${JSON.stringify(payload)}\n`;

  try {
    fs.writeFileSync(candidate, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    return { ok: false, message: err?.message ?? String(err) };
  }

  const moved = renameWithRetry(candidate, target);
  if (!moved.ok) {
    try { fs.unlinkSync(candidate); } catch { /* already gone */ }
    return { ok: false, message: moved.message };
  }

  return { ok: true };
}

/**
 * `rename`, retried briefly while Windows refuses it.
 *
 * On Windows a file another process currently has open for reading cannot be
 * replaced — the rename fails with EPERM/EBUSY until that handle closes. Every
 * reader in this module reads and closes immediately, so a bounded retry is
 * enough; bounded, so a genuinely stuck file can never hang an acquisition.
 *
 * @param {string} from
 * @param {string} to
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function renameWithRetry(from, to, attempts = 200, waitMs = 1) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return { ok: true };
    } catch (err) {
      const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
      if (!transient || i >= attempts) {
        return { ok: false, message: err?.message ?? String(err) };
      }
      // A real blocking pause: no busy spin, no async in a synchronous path.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
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
 * Creates the lock file exclusively, or reports why it could not.
 *
 * `wx` is the whole guarantee: the open fails with EEXIST when the file
 * exists, atomically, with no window between checking and creating. The file
 * is written 0600 like the temp file it replaces.
 *
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function createExclusive(dataDir, payload) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(lockPath(dataDir), `${JSON.stringify(payload)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err?.code ?? 'UNKNOWN', message: err?.message ?? String(err) };
  }
}

/**
 * Writes the lock atomically.
 *
 * `rename` is atomic on both platforms for a same-directory move, so a reader
 * either sees the old file or the new one — never a partial write. Used only
 * to refresh a lock this process already owns; taking it in the first place is
 * createExclusive() above.
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
