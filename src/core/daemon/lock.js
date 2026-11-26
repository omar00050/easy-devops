/**
 * core/daemon/lock.js
 *
 * Single-instance lock for the background daemon, and the signal the dashboard
 * uses to decide whether it should run the jobs itself.
 *
 * The lock is a JSON file in the data directory holding a pid, a start time, a
 * heartbeat and an owner token, refreshed every few seconds. Two readers care
 * about it:
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
 *
 * ── Windows contention is not damage ───────────────────────────────────────
 *
 * On Windows, creating, renaming, deleting or opening a path that another
 * process is in the middle of creating, renaming or deleting is refused with
 * EPERM or EBUSY — a SHARING denial, not a broken file. Measured on this
 * project's machine, ten processes churning one path produced 1,898 EPERM
 * renames out of 3,009 attempts, and every one succeeded on a later attempt.
 *
 * 1.4.7 threw one of those out of the daemon and a real Windows Server died
 * with "EPERM: operation not permitted, rename '...daemon.lock...'". Worse, the
 * reads were not retried either: a contended read returned "no usable lock",
 * which let a recovery replace a LIVE owner's lock. Two processes then both
 * believed they owned it. That is the one outcome this module exists to make
 * impossible, so every mutation and read below retries the sharing denial, and
 * a path that cannot be read is treated as HELD, never as absent.
 *
 * A lock file is therefore only ever created with `wx` (one exclusive open) or
 * replaced under the recovery guard; it is never removed by a non-owner.
 */

import {
  createStateFile,
  replaceStateFile,
  reportStateWriteFailure,
  reportStateWriteSuccess,
} from '../atomicState.js';
import { randomUUID } from 'node:crypto';
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
 * Creating a lock is createStateFile() (`open(..., 'wx')`), which creates the
 * file and THEN writes it — so a brand-new lock is briefly empty. A reader
 * in that window must not "recover" a lock created microseconds earlier.
 */
const UNREADABLE_GRACE_MS = 2_000;

/**
 * This process's identity in both the lock and the recovery guard.
 *
 * A pid alone cannot prove ownership after a pid is reused; the token is what
 * `release()` and the guard check compare. Readable by nobody else, and never
 * written to disk outside these two files.
 */
const PROCESS_TOKEN = randomUUID();

/**
 * The codes Windows uses for "somebody else is using this path right now".
 * Both are retried, never reported as a failure of the lock.
 */
const CONTENTION_CODES = new Set(['EPERM', 'EBUSY']);

/** One retry step for a contended path, and how many of them a mutation gets. */
const CONTENTION_RETRY_MS = 5;
const CONTENTION_ATTEMPTS = 200;

/**
 * Bounded rounds around a whole create. createStateFile() already rides out
 * about 155 ms of sharing denials internally; three rounds give a contended
 * create roughly half a second without turning a permanently denied path into
 * a multi-second stall.
 */
const CREATE_ROUNDS = 3;

const pause = new Int32Array(new SharedArrayBuffer(4));

function isContention(error) {
  return CONTENTION_CODES.has(error?.code);
}

function sleepSync(ms) {
  Atomics.wait(pause, 0, 0, ms);
}

/**
 * Runs a filesystem operation, retrying while Windows refuses it because the
 * path is being created, renamed or deleted by another process.
 *
 * Synchronous on purpose: the lock, the guard and the heartbeat are written
 * from synchronous code paths, several of which run inside a timer callback.
 *
 * @template T
 * @param {() => T} operation
 * @param {number} [attempts]
 * @returns {T}
 */
function retryContention(operation, attempts = CONTENTION_ATTEMPTS) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isContention(error) || attempt >= attempts) throw error;
      sleepSync(CONTENTION_RETRY_MS);
    }
  }
}

/**
 * Removes a path, retrying Windows contention. Best effort by design: the
 * caller decides what a false means, and something left behind is stale rather
 * than dangerous.
 *
 * @param {string} file
 * @returns {boolean} True when the path is gone
 */
function removeWithRetry(file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      if (!isContention(error) || attempt >= CONTENTION_ATTEMPTS) return false;
      sleepSync(CONTENTION_RETRY_MS);
    }
  }
}

/** @returns {string} Absolute path to the lock file. */
export function lockPath(dataDir = getDataDir()) {
  return path.join(dataDir, LOCK_FILE);
}

/** @returns {string} Absolute path to the recovery guard. */
function guardPath(dataDir) {
  return `${lockPath(dataDir)}.recovery`;
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
 * Reads and parses one state file, retrying a sharing denial.
 *
 * The status is what makes the difference that 1.4.7 got wrong: `missing`,
 * `empty` and `corrupt` have no live owner and may be recovered, while
 * `contended` and `unreadable` mean the file may well be somebody's live lock
 * and must be treated as held.
 *
 * @param {string} file
 * @returns {{ status: 'ok'|'missing'|'empty'|'corrupt'|'contended'|'unreadable', value: Object|null, error?: Error }}
 */
function readRecord(file) {
  let raw;
  try {
    raw = retryContention(() => fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', value: null };
    if (isContention(error)) return { status: 'contended', value: null, error };
    return { status: 'unreadable', value: null, error };
  }

  if (String(raw).trim() === '') return { status: 'empty', value: null };
  try {
    return { status: 'ok', value: JSON.parse(raw) };
  } catch {
    // A half-written file is possible if a daemon died mid-write. It has no
    // live owner, but it is NOT "missing": recovery replaces it under the
    // guard, which is why the distinction is kept.
    return { status: 'corrupt', value: null };
  }
}

/** @param {Object} parsed @returns {Object} */
function normaliseLock(parsed) {
  return {
    pid: parsed.pid,
    startedAt: Number(parsed.startedAt) || 0,
    heartbeatAt: Number(parsed.heartbeatAt) || 0,
    version: parsed.version ?? null,
    mode: parsed.mode ?? null,
    token: typeof parsed.token === 'string' ? parsed.token : null,
  };
}

/**
 * @param {string} file
 * @returns {{ status: string, lock: Object|null, error?: Error }}
 */
function readLockRecord(file) {
  const record = readRecord(file);
  if (record.status !== 'ok') return { status: record.status, lock: null, error: record.error };
  if (!Number.isInteger(record.value?.pid)) return { status: 'corrupt', lock: null };
  return { status: 'ok', lock: normaliseLock(record.value) };
}

/**
 * Reads a lock file without judging it.
 *
 * @param {string} file Absolute path to the lock file
 * @returns {Object|null}
 */
function readLockAt(file) {
  return readLockRecord(file).lock;
}

/**
 * Stat a path without throwing for absence. A contended stat is reported as
 * unknown, which every caller treats in the refusing direction.
 *
 * @param {string} file
 * @returns {{ stat: fs.Stats } | { unknown: true } | null}
 */
function statIfPresent(file) {
  try {
    return { stat: retryContention(() => fs.lstatSync(file)) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { unknown: true };
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
 * A stat that cannot be completed under contention is treated as "in flight"
 * as well: the one thing this must never do is answer "not in flight" for a
 * path it could not inspect.
 *
 * @param {string} file
 * @param {number} now
 * @returns {boolean}
 */
function isWriteInFlight(file, now) {
  const result = statIfPresent(file);
  if (!result) return false;
  if (result.unknown) return true;
  return result.stat.size === 0 && now - result.stat.mtimeMs < UNREADABLE_GRACE_MS;
}

/**
 * Reads the lock in a data directory without judging it.
 * @returns {Object|null}
 */
export function readLock(dataDir = getDataDir()) {
  return readLockAt(lockPath(dataDir));
}

/**
 * Judges one lock record.
 *
 * @param {Object} lock
 * @param {number} now
 * @returns {{ running: boolean, stale: boolean, lock: Object, age: number, reason: string }}
 */
function judge(lock, now) {
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

/** The refusal for a lock path that could not be read or stat'd under contention. */
function describeUnreadable(record) {
  const code = record.error?.code ?? 'unknown';
  return record.status === 'contended'
    ? 'the lock is being created or replaced by another process; try again'
    : `the lock could not be read (${code}); check that the data directory is readable and try again`;
}

/**
 * The state of the daemon as far as anyone else can tell.
 *
 * A lock that cannot be read right now is reported as RUNNING. It is almost
 * certainly a live owner's file caught mid-replacement, and letting its readers
 * conclude "no daemon" is what produced two holders in 1.4.7.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {number} [opts.now] Injectable clock, for tests
 * @returns {{ running: boolean, stale: boolean, lock: Object|null, age: number|null, reason: string }}
 */
export function inspect({ dataDir = getDataDir(), now = Date.now() } = {}) {
  const record = readLockRecord(lockPath(dataDir));

  if (record.status === 'contended' || record.status === 'unreadable') {
    return {
      running: true,
      stale: false,
      lock: null,
      age: null,
      reason: record.status === 'contended'
        ? 'the lock is being created or replaced by another process; treating it as held'
        : `the lock could not be read (${record.error?.code ?? 'unknown'}); treating it as held`,
    };
  }

  if (!record.lock) return { running: false, stale: false, lock: null, age: null, reason: 'no lock file' };
  return judge(record.lock, now);
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
 * The guard is removed in a `finally`. One left behind by a crash is cleared
 * once its owner is provably gone, and one left by a wedged process only once
 * it is older than RECOVERY_GUARD_STALE_MS. It is DELETED, never renamed back:
 * restoring a copy could revive a marker after its owner had already released
 * it, leaving every waiter staring at "another process is recovering the lock"
 * for the whole guard age.
 *
 * This process's own token is re-checked before and after the replacement. If
 * the guard was displaced, a lock is withdrawn only when it is still OURS, so
 * a loser can never remove the winner's lock.
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
  const file = lockPath(dataDir);
  const first = readLockRecord(file);

  // A path we cannot read may be a LIVE lock mid-replacement. Treating it as
  // absent is the bug that produced two holders (finding A4).
  if (first.status === 'contended' || first.status === 'unreadable') {
    return { ok: false, reason: describeUnreadable(first), lock: null };
  }

  if (first.lock) {
    const state = judge(first.lock, now);
    if (state.running) {
      // Our own pid holding it is not a conflict: a re-acquire is idempotent so
      // a restart inside one process does not deadlock itself.
      if (state.lock.pid === process.pid) return refreshOwn({ dataDir, version, mode, now, current: state.lock });
      return { ok: false, reason: state.reason, lock: state.lock };
    }
  }

  const payload = { pid: process.pid, startedAt: now, heartbeatAt: now, version, mode, token: PROCESS_TOKEN };
  const created = createExclusive(dataDir, payload);
  if (created.ok) {
    // Empty and corrupt leftovers are recovered by this create; a path that is
    // simply missing is a free lock, not a recovery.
    return { ok: true, recovered: first.status === 'empty' || first.status === 'corrupt', lock: payload };
  }
  if (created.code !== 'EEXIST') {
    return { ok: false, reason: `could not create the lock: ${created.message}`, lock: null };
  }

  // Somebody created a file between the read and the create. Judge THAT file,
  // never the one read earlier.
  const second = readLockRecord(file);
  if (second.status === 'missing') {
    return { ok: false, reason: 'another process created the lock first', lock: null };
  }
  if (second.status === 'contended' || second.status === 'unreadable') {
    return { ok: false, reason: describeUnreadable(second), lock: null };
  }
  if (second.lock) {
    const state = judge(second.lock, now);
    if (state.running) {
      if (state.lock.pid === process.pid) return refreshOwn({ dataDir, version, mode, now, current: state.lock });
      return { ok: false, reason: state.reason, lock: state.lock };
    }
  } else if (second.status === 'empty' && isWriteInFlight(file, now)) {
    // Empty and just created: that is a `wx` create whose write has not landed
    // yet. Reading it in that window is not permission to take it over.
    return { ok: false, reason: 'another process is writing its lock', lock: null };
  }

  return recoverUnderGuard({ dataDir, file, payload, now, version, mode });
}

/**
 * Rewrites a lock this process already owns.
 *
 * A failed rewrite is not a lost lock: the old record is still ours and the
 * heartbeat will try again, so this reports success rather than failing a
 * re-acquire on a momentary rename denial.
 */
function refreshOwn({ dataDir, version, mode, now, current }) {
  try {
    return {
      ok: true,
      recovered: false,
      lock: write({ dataDir, version, mode, now, startedAt: current.startedAt }),
    };
  } catch {
    return { ok: true, recovered: false, lock: current };
  }
}

/**
 * Replaces one inspected stale/corrupt/empty-old lock under the recovery guard.
 * Every decision inside the guard re-reads the path; the only lock it may
 * replace is one it has just judged dead.
 *
 * @returns {{ ok: true, recovered: boolean, lock: Object }
 *          | { ok: false, reason: string, lock: Object|null }}
 */
function recoverUnderGuard({ dataDir, file, payload, now, version, mode }) {
  const guard = acquireRecoveryGuard({ dataDir, now });
  if (!guard.ok) {
    return { ok: false, reason: guard.reason, lock: readLock(dataDir) };
  }

  try {
    if (!guardIsOurs(guard.file, guard.token)) {
      return { ok: false, reason: 'another process recovered the lock first', lock: readLock(dataDir) };
    }

    const inside = readLockRecord(file);
    if (inside.status === 'contended' || inside.status === 'unreadable') {
      return { ok: false, reason: describeUnreadable(inside), lock: null };
    }

    if (inside.lock) {
      const state = judge(inside.lock, now);
      if (state.running) {
        if (state.lock.pid === process.pid) return refreshOwn({ dataDir, version, mode, now, current: state.lock });
        return { ok: false, reason: state.reason, lock: state.lock };
      }
    } else if (inside.status === 'empty' && isWriteInFlight(file, now)) {
      return { ok: false, reason: 'another process is writing its lock', lock: null };
    } else if (inside.status === 'missing') {
      // The previous owner released while we held the guard. Create; if another
      // process wins that instant, judge what appeared and never replace it
      // blindly.
      const again = createExclusive(dataDir, payload);
      if (again.ok) {
        return withdrawIfGuardLost({ dataDir, file, payload, guard, recovered: false });
      }
      if (again.code !== 'EEXIST') {
        return { ok: false, reason: `could not create the lock: ${again.message}`, lock: null };
      }

      const appeared = readLockRecord(file);
      if (appeared.status === 'missing') {
        return { ok: false, reason: 'another process created the lock first', lock: null };
      }
      if (appeared.status === 'contended' || appeared.status === 'unreadable') {
        return { ok: false, reason: describeUnreadable(appeared), lock: null };
      }
      if (appeared.lock) {
        const state = judge(appeared.lock, now);
        if (state.running) {
          if (state.lock.pid === process.pid) return refreshOwn({ dataDir, version, mode, now, current: state.lock });
          return { ok: false, reason: state.reason, lock: state.lock };
        }
      } else if (appeared.status === 'empty' && isWriteInFlight(file, now)) {
        return { ok: false, reason: 'another process is writing its lock', lock: null };
      }
      // A stale, corrupt or old empty file: fall through to a guarded replace.
    }

    const replaced = replaceLock({ dataDir, payload });
    if (!replaced.ok) {
      return { ok: false, reason: `could not replace the stale lock: ${replaced.message}`, lock: readLock(dataDir) };
    }

    return withdrawIfGuardLost({ dataDir, file, payload, guard, recovered: true });
  } finally {
    guard.release();
  }
}

/**
 * After installing a lock, prove the guard was still ours.
 *
 * A displaced guard means another recovery may also have installed a lock.
 * Withdraw ONLY a lock that still carries our token, so the winner keeps its
 * lock and at most one process ever runs.
 */
function withdrawIfGuardLost({ dataDir, file, payload, guard, recovered }) {
  if (guardIsOurs(guard.file, guard.token)) {
    return { ok: true, recovered, lock: payload };
  }

  // `file` is already the lock path; readLock() takes a DATA DIRECTORY and
  // appends daemon.lock, so passing it here would read <lock>\daemon.lock,
  // find nothing, and leave our lock behind after a displacement.
  const held = readLockAt(file);
  if (held?.token === payload.token) removeWithRetry(file);
  return { ok: false, reason: 'another process recovered the lock first', lock: readLock(dataDir) };
}

/**
 * Creates the recovery guard exclusively, or explains why recovery may not run.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {number} opts.now
 * @returns {{ ok: true, token: string, file: string, release: () => void }
 *          | { ok: false, reason: string }}
 */
function acquireRecoveryGuard({ dataDir, now }) {
  const file = guardPath(dataDir);
  const token = PROCESS_TOKEN;
  const body = `${JSON.stringify({ pid: process.pid, at: now, token })}\n`;

  const release = () => {
    const current = readRecord(file);
    // Only remove the guard this process still owns. A contended or
    // unreadable guard is left alone: it goes stale, it is never a live lock.
    if (current.status !== 'ok') return;
    if (current.value?.token !== token || current.value?.pid !== process.pid) return;
    if (!removeWithRetry(file)) {
      reportStateWriteFailure(file, { code: 'EPERM', message: 'the recovery guard is held open' },
        'Other processes will wait until it goes stale (about 30 seconds).');
    }
  };

  const attempt = () => {
    let last = null;
    for (let round = 0; round < CREATE_ROUNDS; round += 1) {
      try {
        createStateFile(file, body);
        return { ok: true, token, file, release };
      } catch (error) {
        const code = error?.code ?? 'UNKNOWN';
        const message = error?.message ?? String(error);
        if (code === 'EEXIST') return { ok: false, code, message };
        last = { code, message };
        if (!isContention(error)) return { ok: false, ...last };
        sleepSync(CONTENTION_RETRY_MS);
      }
    }
    return { ok: false, ...(last ?? { code: 'UNKNOWN', message: 'could not create the guard' }) };
  };

  const first = attempt();
  if (first.ok) return first;
  if (first.code !== 'EEXIST') {
    return { ok: false, reason: `could not create the recovery guard: ${first.message}` };
  }

  const abandoned = abandonedGuard(file, now);
  if (!abandoned) return { ok: false, reason: 'another process is recovering the lock' };

  // Re-check the very file inspected, then DELETE it. Restoring a copy is what
  // 1.4.7 did, and it revived a marker after its owner had already released
  // it: every waiter then saw a live recovery for the whole guard age.
  if (!retireGuard(file, abandoned)) {
    return { ok: false, reason: 'another process is recovering the lock' };
  }

  const second = attempt();
  if (second.ok) return second;
  if (second.code !== 'EEXIST') {
    return { ok: false, reason: `could not create the recovery guard: ${second.message}` };
  }
  return { ok: false, reason: 'another process is recovering the lock' };
}

/**
 * Describes an abandoned recovery guard, or null when it must be respected.
 *
 * A dead owner cannot still be replacing the lock, so its guard is abandoned at
 * once. A live owner is normally inside a replacement that is a few
 * synchronous file operations; a guard older than RECOVERY_GUARD_STALE_MS
 * therefore belongs to a wedged process, not one making progress.
 *
 * @param {string} file
 * @param {number} now
 * @returns {{ stat: fs.Stats, status: string, record: Object|null }|null}
 */
function abandonedGuard(file, now) {
  const present = statIfPresent(file);
  if (!present || present.unknown) return null;

  const record = readRecord(file);
  if (record.status === 'contended' || record.status === 'unreadable') return null;

  const age = Math.max(0, now - present.stat.mtimeMs);
  const value = record.status === 'ok' ? record.value : null;
  const hasOwner = Boolean(value) && Number.isInteger(value.pid);

  if (!hasOwner) {
    // Empty or half-written: only after the grace, so a guard being created is
    // never mistaken for a crash.
    return age > RECOVERY_GUARD_STALE_MS ? { stat: present.stat, status: record.status, record: null } : null;
  }

  if (!isPidAlive(value.pid)) return { stat: present.stat, status: record.status, record: value };
  return age > RECOVERY_GUARD_STALE_MS ? { stat: present.stat, status: record.status, record: value } : null;
}

/**
 * Removes one inspected abandoned guard, after proving the path still holds the
 * same file (dev/ino) and the same record (pid, start and token).
 *
 * @param {string} file
 * @param {{ stat: fs.Stats, status: string, record: Object|null }} abandoned
 * @returns {boolean} True when that exact guard is gone
 */
function retireGuard(file, abandoned) {
  const present = statIfPresent(file);
  if (!present || present.unknown) return false;
  if (present.stat.dev !== abandoned.stat.dev || present.stat.ino !== abandoned.stat.ino) return false;

  const record = readRecord(file);
  if (record.status !== abandoned.status) return false;
  if (abandoned.record) {
    const value = record.value;
    if (!value
        || value.pid !== abandoned.record.pid
        || Number(value.at) !== Number(abandoned.record.at)
        || (value.token ?? null) !== (abandoned.record.token ?? null)) {
      return false;
    }
  }
  return removeWithRetry(file);
}

/** True while the guard path still holds exactly the token we created. */
function guardIsOurs(file, token) {
  const record = readRecord(file);
  return record.status === 'ok'
    && record.value?.token === token
    && record.value?.pid === process.pid;
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
    createStateFile(candidate, body);
  } catch (err) {
    return { ok: false, message: err?.message ?? String(err) };
  }

  try {
    // Bounded retry of the Windows "target is in use" denial. This is the exact
    // operation that killed the 1.4.7 daemon.
    retryContention(() => fs.renameSync(candidate, target));
    return { ok: true };
  } catch (err) {
    removeWithRetry(candidate);
    return { ok: false, message: err?.message ?? String(err) };
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
 * A failed READ or WRITE is different: on Windows a rename over a lock a
 * reader has open can be refused. That is a momentary denial, not a lost lock,
 * so a contended read KEEPS ownership and a failed write is logged once and
 * retried on the next beat — the daemon must not die from it, which is what
 * happened in 1.4.6 (finding A4).
 *
 * @returns {boolean} True while this process still owns the lock
 */
export function heartbeat({ dataDir = getDataDir(), version = null, mode = 'daemon', now = Date.now() } = {}) {
  const file = lockPath(dataDir);
  const record = readLockRecord(file);

  if (record.status === 'contended' || record.status === 'unreadable') {
    // A live, beating owner is never replaced: that needs its pid gone AND its
    // heartbeat stale. Keeping ownership is safer than stopping the jobs
    // because a reader lost a race with a rename.
    return true;
  }

  if (!record.lock || !isOurLock(record.lock)) return false;

  // The write goes through atomicState.js, which already retries the Windows
  // sharing denial (about 155 ms). One beat is one attempt on purpose: a
  // heartbeat that cannot be written is reported once and retried on the NEXT
  // beat, so a burst of denials still shows up in the log instead of being
  // hidden by an ever-longer stall inside the timer.
  try {
    write({ dataDir, version, mode, now, startedAt: record.lock.startedAt });
    reportStateWriteSuccess(file);
  } catch (err) {
    reportStateWriteFailure(file, err, 'It will be retried on the next heartbeat.');
  }
  return true;
}

/**
 * True when this lock record belongs to this process.
 *
 * The pid must be ours; a token written by this process must match. A lock
 * from an older version has no token and is accepted on the pid alone — a live
 * process never shares our pid.
 */
function isOurLock(lock) {
  if (lock?.pid !== process.pid) return false;
  return lock.token === null || lock.token === undefined || lock.token === PROCESS_TOKEN;
}

/**
 * Releases the lock, but only if this process owns it.
 *
 * The read is retried, and a lock whose owner cannot be confirmed is NOT
 * removed: removing somebody else's lock would let two daemons run.
 *
 * @returns {boolean} True when a lock was actually removed
 */
export function release({ dataDir = getDataDir() } = {}) {
  const file = lockPath(dataDir);
  const record = readLockRecord(file);
  if (!record.lock || !isOurLock(record.lock)) return false;
  return removeWithRetry(file);
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
 * It stays the ONLY way to acquire: the retry below only rides out a Windows
 * sharing denial, it never turns the create into a check-then-write.
 *
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function createExclusive(dataDir, payload) {
  try {
    retryContention(() => fs.mkdirSync(dataDir, { recursive: true }));
  } catch (err) {
    return { ok: false, code: err?.code ?? 'UNKNOWN', message: err?.message ?? String(err) };
  }

  let last = { code: 'UNKNOWN', message: 'the lock could not be created' };
  for (let round = 0; round < CREATE_ROUNDS; round += 1) {
    try {
      createStateFile(lockPath(dataDir), `${JSON.stringify(payload)}\n`);
      return { ok: true };
    } catch (err) {
      last = { code: err?.code ?? 'UNKNOWN', message: err?.message ?? String(err) };
      if (last.code === 'EEXIST') return { ok: false, ...last };
      if (!isContention(err)) return { ok: false, ...last };
      sleepSync(CONTENTION_RETRY_MS);
    }
  }
  return { ok: false, ...last };
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
    token: PROCESS_TOKEN,
  };

  const target = lockPath(dataDir);

  fs.mkdirSync(dataDir, { recursive: true });
  replaceStateFile(target, `${JSON.stringify(payload)}\n`);

  return payload;
}
