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

/** @returns {string} Absolute path to the ownership marker. */
export function ownerPath(dataDir = getDataDir()) {
  return path.join(dataDir, OWNER_FILE);
}

/**
 * Reads the marker without judging it.
 * @returns {{ pid: number, role: string|null, at: number, heartbeatAt: number }|null}
 */
export function readOwner(dataDir = getDataDir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPath(dataDir), 'utf8'));
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

  write({ dataDir, role, now, at: state.mine ? state.owner.at : now });
  return { ok: true, recovered: state.stale };
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
 * Writes the marker atomically.
 *
 * Same temp-file-and-rename as the daemon lock: a reader must never see a
 * half-written marker and conclude nobody owns the jobs.
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
