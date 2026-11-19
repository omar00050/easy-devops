/**
 * core/jobs/owner.js
 *
 * A marker naming the process that is currently RUNNING the background jobs.
 *
 * ── Why this is separate from the daemon lock ──────────────────────────────
 *
 * `core/daemon/lock.js` answers "is a daemon running?". That is not the same
 * question as "who is running the jobs", because an open dashboard runs them
 * whenever no daemon does. The two were conflated, and the gap showed up as a
 * real fault:
 *
 *   1. a daemon starts and takes the daemon lock
 *   2. the dashboard is still running the jobs — it only notices the new
 *      daemon on its next ownership poll, up to 15 seconds later
 *   3. for those seconds BOTH processes have a Hub agent connected with the
 *      same serverId, and the Hub keeps one socket per server: it evicts them
 *      in turn, so the user sees "io server disconnect" twice
 *
 * The daemon lock cannot fix that on its own: the dashboard deliberately never
 * takes it (otherwise `ezz daemon` could not start while a browser tab is
 * open). So job ownership needs its own marker, which BOTH roles claim, and a
 * starting daemon waits for the dashboard to release before it starts anything
 * that talks to the outside world.
 *
 * ── The protocol ───────────────────────────────────────────────────────────
 *
 *   - whoever runs the jobs holds `jobs.owner` and refreshes its heartbeat
 *   - a daemon takes the daemon lock FIRST (so the dashboard sees it at once,
 *     via fs.watch), then waits for `jobs.owner` to free up, then claims it
 *   - a dashboard releases it the moment it learns a daemon exists
 *
 * Staleness is judged exactly as the daemon lock judges it — heartbeat old AND
 * pid gone — for the same reason: a live pid does not prove our process still
 * owns it, and a stale heartbeat alone can be a paused process.
 */

import fs from 'fs';
import path from 'path';

import { getDataDir } from '../platform.js';
import { isPidAlive } from '../daemon/lock.js';

/** How often the owner refreshes its heartbeat. */
export const OWNER_HEARTBEAT_MS = 5_000;

/** How old a heartbeat may get before the marker is a candidate for recovery. */
export const OWNER_STALE_AFTER_MS = 20_000;

/**
 * How long a starting daemon waits for a dashboard to let go.
 *
 * Generous enough for a dashboard that is mid-poll or mid-request, short
 * enough that a daemon never appears to hang. If it expires the daemon starts
 * anyway: being briefly doubled is better than a server with no monitoring at
 * all, and the notification claim makes the overlap harmless.
 */
export const HANDOVER_WAIT_MS = 8_000;

const OWNER_FILE = 'jobs.owner';

/**
 * How long a recovery guard left by a crashed process must sit before another
 * process may clear it. Long enough that a slow but live recovery is never
 * cleared out from under itself.
 */
const RECOVERY_GUARD_STALE_MS = 30_000;

/**
 * How long an empty, unreadable marker may exist before another process may
 * treat it as abandoned: creating it is `writeFileSync(path, data, { flag:
 * 'wx' })`, which creates the file and THEN writes it, so a brand-new marker is
 * briefly empty. A reader in that window must not "recover" it.
 */
const UNREADABLE_GRACE_MS = 2_000;

/** @returns {string} Absolute path to the ownership marker. */
export function ownerPath(dataDir = getDataDir()) {
  return path.join(dataDir, OWNER_FILE);
}

/**
 * Reads a marker file without judging it.
 * @param {string} file Absolute path to the marker
 * @returns {{ pid: number, role: string|null, at: number, heartbeatAt: number }|null}
 */
function readOwnerAt(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(parsed?.pid)) return null;
    return {
      pid: parsed.pid,
      role: parsed.role ?? null,
      at: Number(parsed.at) || 0,
      heartbeatAt: Number(parsed.heartbeatAt) || 0,
    };
  } catch {
    // Missing, unreadable or half-written all mean "nobody is holding it".
    return null;
  }
}

/**
 * True when an unreadable marker is a create that has not been written yet: an
 * empty file younger than the grace counts as LIVE, an empty file older than it
 * is a crash and may be recovered, and a non-empty file that does not parse is
 * a truncated write with no live owner.
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
 * Reads the marker in a data directory without judging it.
 * @returns {{ pid: number, role: string|null, at: number, heartbeatAt: number }|null}
 */
export function readOwner(dataDir = getDataDir()) {
  return readOwnerAt(ownerPath(dataDir));
}

/**
 * Who holds the jobs, as far as anyone else can tell.
 *
 * @param {Object} [opts]
 * @returns {{ held: boolean, mine: boolean, stale: boolean, owner: Object|null, reason: string }}
 */
export function inspect({ dataDir = getDataDir(), now = Date.now() } = {}) {
  const owner = readOwner(dataDir);
  if (!owner) return { held: false, mine: false, stale: false, owner: null, reason: 'nobody holds the jobs' };

  const mine = owner.pid === process.pid;
  const age = now - owner.heartbeatAt;
  const alive = isPidAlive(owner.pid);
  const fresh = age < OWNER_STALE_AFTER_MS;

  if (alive || fresh) {
    return {
      held: true,
      mine,
      stale: false,
      owner,
      reason: mine
        ? 'this process holds the jobs'
        : `pid ${owner.pid} (${owner.role ?? 'unknown role'}) holds the jobs`,
    };
  }

  return {
    held: false,
    mine: false,
    stale: true,
    owner,
    reason: `pid ${owner.pid} is gone and its heartbeat is ${Math.round(age / 1000)}s old`,
  };
}

/**
 * Takes ownership of the jobs.
 *
 * The marker is CREATED exclusively (`wx`), exactly as the daemon lock is: two
 * processes racing for the jobs cannot both win, because only one open can
 * create the file.
 *
 * Recovering a marker whose owner is gone is the subtle half, for the same
 * reason as the daemon lock: deciding from `inspect()` before the race lets two
 * processes both "recover" the same dead marker, and moving the file aside
 * leaves the path empty long enough for a third process to create there.
 *
 * So recovery is serialised and the marker is only REPLACED, never removed:
 * one process creates `jobs.owner.recovery` exclusively (the permission to
 * recover), re-reads the marker under that guard, and replaces a dead one with
 * an atomic rename of a prepared candidate. The path is never empty. Everyone
 * else is refused, and the guard is removed in a `finally`.
 *
 * @param {Object} opts
 * @param {string} [opts.dataDir]
 * @param {string} opts.role 'daemon' | 'dashboard'
 * @returns {{ ok: true, recovered: boolean } | { ok: false, reason: string, owner: Object|null }}
 */
export function claim({ dataDir = getDataDir(), role = 'unknown', now = Date.now() } = {}) {
  const state = inspect({ dataDir, now });

  if (state.held && !state.mine) {
    return { ok: false, reason: state.reason, owner: state.owner };
  }

  // Refreshing our own marker is not an acquisition: keep the original `at`,
  // and use the atomic rewrite that only the owner performs.
  if (state.mine) {
    write({ dataDir, role, now, at: state.owner.at });
    return { ok: true, recovered: false };
  }

  const payload = { pid: process.pid, role, at: now, heartbeatAt: now };

  const first = createExclusive(dataDir, payload);
  if (first.ok) return { ok: true, recovered: state.stale };

  if (first.code !== 'EEXIST') {
    return { ok: false, reason: `could not create the jobs marker: ${first.message}`, owner: null };
  }

  // A marker appeared after inspect() saw none. If it is readable it is
  // somebody's; an unreadable one (truncated by a crash) has no owner, so it
  // falls through to the guard below, which replaces it.
  if (!state.owner && !fs.existsSync(ownerPath(dataDir))) {
    return { ok: false, reason: 'another process claimed the jobs first', owner: readOwner(dataDir) };
  }

  // Empty and just created: a `wx` create whose write has not landed yet.
  if (!state.owner && isWriteInFlight(ownerPath(dataDir), now)) {
    return { ok: false, reason: 'another process is writing its claim', owner: readOwner(dataDir) };
  }

  const guard = acquireRecoveryGuard({ dataDir, now });
  if (!guard.ok) {
    return { ok: false, reason: guard.reason, owner: readOwner(dataDir) };
  }

  try {
    // Authoritative: nobody else may change the marker while we hold the guard.
    const current = inspect({ dataDir, now });

    if (current.held && !current.mine) {
      return { ok: false, reason: current.reason, owner: current.owner };
    }

    if (current.mine) {
      write({ dataDir, role, now, at: current.owner.at });
      return { ok: true, recovered: false };
    }

    if (!current.owner) {
      // Empty and just created is a create in flight — treat it as live.
      if (isWriteInFlight(ownerPath(dataDir), now)) {
        return { ok: false, reason: 'another process is writing its claim', owner: null };
      }

      // Unreadable or gone: a marker with no readable owner cannot be waited on
      // (a crash mid-write would otherwise block the jobs for ever), so it is
      // created over if it is gone, replaced under the guard if it is still
      // there.
      const again = createExclusive(dataDir, payload);
      if (again.ok) return { ok: true, recovered: true };

      if (again.code !== 'EEXIST') {
        return { ok: false, reason: `could not create the jobs marker: ${again.message}`, owner: null };
      }

      const replaced = replaceOwner({ dataDir, payload });
      return replaced.ok
        ? { ok: true, recovered: true }
        : { ok: false, reason: `could not replace the unreadable jobs marker: ${replaced.message}`, owner: null };
    }

    const replaced = replaceOwner({ dataDir, payload });
    if (!replaced.ok) {
      return {
        ok: false,
        reason: `could not replace the jobs marker: ${replaced.message}`,
        owner: readOwner(dataDir),
      };
    }

    return { ok: true, recovered: true };
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
  const file = `${ownerPath(dataDir)}.recovery`;
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

  // A guard left behind by a process that died mid-recovery: clear it only when
  // its owner is provably gone and it is old enough not to be a slow recovery.
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* unreadable: treat it as live */ }

  const abandoned = Boolean(existing)
    && Number.isInteger(existing.pid)
    && !isPidAlive(existing.pid)
    && now - (Number(existing.at) || 0) > RECOVERY_GUARD_STALE_MS;

  if (!abandoned) return { ok: false, reason: 'another process is recovering the jobs marker' };

  try { fs.unlinkSync(file); } catch { /* another process cleared it first */ }

  const second = attempt();
  return second.ok
    ? { ok: true, release }
    : { ok: false, reason: 'another process is recovering the jobs marker' };
}

/**
 * Replaces the marker with this process's payload, atomically.
 *
 * A `rename` within the directory replaces the old file with the new one in one
 * step, so the path is never absent and no third process can create there.
 * Called only while the recovery guard is held.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {Object} opts.payload
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function replaceOwner({ dataDir, payload }) {
  const target = ownerPath(dataDir);
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
 * A file another process has open for reading cannot be replaced on Windows
 * (EPERM/EBUSY) until that handle closes. Readers here read and close
 * immediately, so a bounded retry is enough — and bounded, so a stuck file can
 * never hang an acquisition.
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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

/**
 * Refreshes the heartbeat.
 *
 * @returns {boolean} True while this process still owns the jobs
 */
export function heartbeat({ dataDir = getDataDir(), role = 'unknown', now = Date.now() } = {}) {
  const current = readOwner(dataDir);
  if (!current || current.pid !== process.pid) return false;

  write({ dataDir, role, now, at: current.at });
  return true;
}

/**
 * Lets the jobs go, but only if this process holds them.
 * @returns {boolean} True when the marker was actually removed
 */
export function release({ dataDir = getDataDir() } = {}) {
  const current = readOwner(dataDir);
  if (!current || current.pid !== process.pid) return false;

  try {
    fs.unlinkSync(ownerPath(dataDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits for whoever holds the jobs to let go.
 *
 * Used by a starting daemon, after it has taken the daemon lock. The lock is
 * what tells the dashboard to stand down; this is what makes the daemon wait
 * until it actually has.
 *
 * @param {Object} [opts]
 * @returns {Promise<{ free: boolean, waitedMs: number, reason: string }>}
 */
export async function waitUntilFree({
  dataDir = getDataDir(),
  timeoutMs = HANDOVER_WAIT_MS,
  everyMs = 100,
} = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;

  for (;;) {
    const state = inspect({ dataDir });
    if (!state.held || state.mine) {
      return { free: true, waitedMs: Date.now() - started, reason: state.reason };
    }
    if (Date.now() >= deadline) {
      return { free: false, waitedMs: Date.now() - started, reason: state.reason };
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * Creates the marker exclusively, or reports why it could not.
 *
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function createExclusive(dataDir, payload) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(ownerPath(dataDir), `${JSON.stringify(payload)}\n`, {
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
 * Writes the marker atomically.
 *
 * Same temp-file-and-rename as the daemon lock: a reader must never see a
 * half-written marker and conclude nobody owns the jobs. Only an owner
 * refreshes it this way; taking it is createExclusive() above.
 */
function write({ dataDir, role, now, at }) {
  const payload = { pid: process.pid, role, at: at ?? now, heartbeatAt: now };
  const target = ownerPath(dataDir);
  const temp = `${target}.${process.pid}.tmp`;

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);

  return payload;
}
