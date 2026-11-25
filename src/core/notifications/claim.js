/**
 * core/notifications/claim.js
 *
 * Makes sure exactly one process sends a given notification, even while the
 * daemon and an open dashboard are both briefly running the monitors.
 *
 * ── The ordering that matters ───────────────────────────────────────────────
 *
 * The old code marked a transition "notified" BEFORE sending it. That made a
 * lost notification invisible: if the webhook failed, the state already said
 * it had been sent, so it was never retried. The order here is:
 *
 *   1. claim the transition  (atomic; exactly one process wins)
 *   2. send
 *   3. commit — only now is it recorded as sent
 *
 * and on a send failure the claim is RELEASED without committing, so the next
 * poll tries again.
 *
 * ── Why the claim is a file and not a database row ──────────────────────────
 *
 * It has to be atomic across processes, and `good.db` exposes only get/set
 * through `core/db.js` — no compare-and-swap. The obvious substitute, "write
 * my pid then read it back and see if I won", is not safe: two processes can
 * interleave write/read/write/read and both see their own pid.
 *
 * `open(path, 'wx')` is a single atomic syscall on both platforms: it creates
 * the file or fails with EEXIST, and it cannot do both. So the claim lives in
 * the data directory next to the database, while the durable "was it sent"
 * record stays in the database where it belongs. Raw SQL would be the other
 * way to get a real CAS, and the constitution prohibits it.
 *
 * ── Crashed claimants ──────────────────────────────────────────────────────
 *
 * A process that dies between claiming and committing must not block the
 * transition for ever. A claim older than CLAIM_TTL_MS whose owner is gone is
 * taken over. Both conditions, for the same reason as the daemon lock: a live
 * pid may still be working, and a stale timestamp alone can mean a slow send.
 */

import { createStateFile, replaceStateFile } from '../atomicState.js';
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../platform.js';
import { isPidAlive } from '../daemon/lock.js';

/**
 * How long a claim may be held before another process may take it over.
 *
 * Generous on purpose: a Telegram or Discord call can legitimately take tens
 * of seconds, and taking a claim away from a sender that is still working is
 * how duplicates happen.
 */
export const CLAIM_TTL_MS = 120_000;

const CLAIM_DIR = 'claims';

/** Directory holding claim files. */
export function claimDir(dataDir = getDataDir()) {
  return path.join(dataDir, CLAIM_DIR);
}

/**
 * Turns a transition into a safe file name.
 *
 * Domain names, event types and statuses are concatenated, so anything that is
 * not plainly safe in a path is replaced. The result is also length-capped,
 * because a long wildcard domain plus an event type can otherwise exceed the
 * filename limit and fail the claim for a reason that has nothing to do with
 * contention.
 *
 * @param {string|null} domain
 * @param {string} eventType
 * @param {string} status
 * @returns {string}
 */
export function claimKey(domain, eventType, status) {
  const parts = [domain ?? '_global', eventType, status]
    .map((p) => String(p).replace(/[^a-zA-Z0-9._-]/g, '_'))
    .join('__');
  return parts.slice(0, 180);
}

/** Absolute path of one claim. */
export function claimPath(domain, eventType, status, dataDir = getDataDir()) {
  return path.join(claimDir(dataDir), `${claimKey(domain, eventType, status)}.claim`);
}

/**
 * Reads a claim file.
 *
 * An unreadable (half-written) claim is dated from the file's mtime, never from
 * zero. `at: 0` would make it look ancient, and every reader would then be
 * allowed to take it over immediately — which is how two processes ended up
 * both sending one notification while the winner was still writing its claim.
 *
 * @returns {{ pid: number, at: number }|null}
 */
function readClaim(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { pid: Number(parsed?.pid) || 0, at: Number(parsed?.at) || 0 };
  } catch {
    try {
      // No usable owner, but the file's own age is still evidence: a claim
      // written a moment ago must be waited out, not reclaimed.
      return { pid: 0, at: fs.statSync(file).mtimeMs };
    } catch {
      // Gone (a release, or a commit) — nothing to reclaim.
      return null;
    }
  }
}

/**
 * Tries to become the one process that sends this notification.
 *
 * @param {Object} opts
 * @param {string|null} opts.domain
 * @param {string} opts.eventType
 * @param {string} opts.status
 * @param {string} [opts.dataDir]
 * @param {number} [opts.now] Injectable clock, for tests
 * @returns {{ ok: true, takeover: boolean, commit: () => void, release: () => void }
 *          | { ok: false, heldBy: number|null, reason: string }}
 */
export function claim({
  domain,
  eventType,
  status,
  dataDir = getDataDir(),
  now = Date.now(),
} = {}) {
  const file = claimPath(domain, eventType, status, dataDir);
  const payload = `${JSON.stringify({ pid: process.pid, at: now })}\n`;

  const finish = (takeover) => ({
    ok: true,
    takeover,
    /** Removes the claim. Called after the send succeeded AND was recorded. */
    commit: () => { try { fs.unlinkSync(file); } catch { /* already gone */ } },
    /** Removes the claim WITHOUT recording a send, so it is retried. */
    release: () => { try { fs.unlinkSync(file); } catch { /* already gone */ } },
  });

  try {
    fs.mkdirSync(claimDir(dataDir), { recursive: true });
  } catch { /* created concurrently, or unwritable — the open below reports it */ }

  // The atomic step: creates or fails, never both.
  try {
    createStateFile(file, payload);
    return finish(false);
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      return { ok: false, heldBy: null, reason: `could not write a claim: ${err.message}` };
    }
  }

  // Someone holds it. Take it over only if they are gone AND it is old.
  const held = readClaim(file);
  if (!held) {
    // It vanished between the exclusive create and this read — its owner
    // committed or released. Try once more to take it.
    try {
      createStateFile(file, payload);
      return finish(false);
    } catch (err) {
      return { ok: false, heldBy: null, reason: `could not write a claim: ${err.message}` };
    }
  }

  const age = now - held.at;
  const ownerGone = held.pid === 0 || !isPidAlive(held.pid);

  if (!ownerGone) {
    return { ok: false, heldBy: held.pid, reason: `pid ${held.pid} is sending it` };
  }
  if (age < CLAIM_TTL_MS) {
    return {
      ok: false,
      heldBy: held.pid || null,
      reason: `claim is ${Math.round(age / 1000)}s old; waiting for the ${Math.round(CLAIM_TTL_MS / 1000)}s timeout`,
    };
  }

  // Abandoned. Replace it, and re-check that we are the one who did: two
  // processes can reach this point together, and only the one whose pid is in
  // the file afterwards may proceed.
  try {
    replaceStateFile(file, payload);
  } catch (err) {
    return { ok: false, heldBy: held.pid || null, reason: `could not take over the claim: ${err.message}` };
  }

  const after = readClaim(file);
  if (after.pid !== process.pid) {
    return { ok: false, heldBy: after.pid, reason: `pid ${after.pid} took over first` };
  }

  return finish(true);
}

/**
 * Removes every claim owned by a dead process.
 *
 * Called when a job owner starts up: a crash leaves claims behind, and clearing
 * the ones whose owners are gone means the first poll after a restart can send
 * rather than waiting out the TTL.
 *
 * @returns {number} How many were removed
 */
export function sweepAbandoned({ dataDir = getDataDir(), now = Date.now() } = {}) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(claimDir(dataDir));
  } catch {
    return 0;
  }

  for (const name of entries) {
    if (!name.endsWith('.claim')) continue;
    const file = path.join(claimDir(dataDir), name);
    const held = readClaim(file);
    if (!held) continue;

    const ownerGone = held.pid === 0 || !isPidAlive(held.pid);
    if (!ownerGone) continue;
    // Still honour the TTL: a claim written microseconds ago by a process that
    // has not yet appeared in the process table would otherwise be swept.
    if (now - held.at < CLAIM_TTL_MS) continue;

    try { fs.unlinkSync(file); removed++; } catch { /* raced */ }
  }

  return removed;
}
