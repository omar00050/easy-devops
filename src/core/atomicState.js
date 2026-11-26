/**
 * core/atomicState.js
 *
 * Every small piece of process state Easy DevOps keeps in the data directory
 * — the daemon lock, the jobs marker, `daemon-state.json`, the update status,
 * notification claims, the stop request — is written through this module.
 *
 * ── Why a shared module ────────────────────────────────────────────────────
 *
 * All of them are read by ANOTHER process while they are rewritten: a CLI
 * reading the lock, a dashboard reading the jobs marker, an updater reading
 * the status file. So every write is "write a temp file, rename it over the
 * target": a reader sees either the whole old document or the whole new one,
 * never half of either.
 *
 * On Windows a rename over a file that another process currently has open
 * fails with EPERM, EBUSY or EACCES — even though every reader closes the
 * handle within microseconds. The daemon died from exactly that in 1.4.6:
 *
 *   [daemon] uncaught exception: Error: EPERM: operation not permitted,
 *   rename '...\jobs.owner.10376.tmp' -> '...\jobs.owner'
 *       at write (core/jobs/owner.js:476) at heartbeat (owner.js:393)
 *
 * So a sharing denial is not treated as a permanent failure: the operation is
 * retried with a short, bounded backoff (about 155 ms in total) so an ordinary
 * momentary reader is ridden out, while a genuinely stuck file still reaches
 * the caller as an error in well under the heartbeat interval. Nothing here
 * swallows a failure: the temp file is removed and the original error is
 * re-thrown. A caller that cannot write may decide to keep running (a
 * heartbeat), but it has to do so knowingly.
 *
 * ── The retry is exported, because the problem is not local ────────────────
 *
 * A rename over an open file fails the same way for every writer on Windows,
 * so `retrySharing`, `renameWithRetry`, `copyFileWithRetry` (and the async
 * pair) are public here rather than copied into each caller. Five modules had
 * grown their own version, two of them without EACCES — a file held by a virus
 * scanner failed in one place and not in another. The dashboard's session
 * store (dashboard/lib/sessionStore.js) is the first caller added after the
 * export; it was the one that turned a denial into a 500.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const pause = new Int32Array(new SharedArrayBuffer(4));

/** The codes Windows uses for "somebody else has this file open". */
const sharingErrors = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * The waits between attempts, in milliseconds.
 *
 * Five waits after the first attempt, so at most six attempts and 155 ms of
 * waiting in total. Small enough to run inside a five-second heartbeat, long
 * enough to outlast a reader that opened the file while it was being replaced.
 */
const RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80]);

/** True when the error is one Windows reports for a file somebody else has open. */
function isSharingError(err) {
  return sharingErrors.has(err?.code);
}

/**
 * Runs a filesystem operation, retrying briefly while Windows refuses it
 * because another process has the file open.
 *
 * Synchronous on purpose: the lock, the marker, the claims and the status file
 * are all written from synchronous code paths, several of which run inside a
 * timer callback. Waits are `Atomics.wait`, so the retry does not spin the CPU.
 *
 * Shared rather than copied: five modules grew their own version of this loop
 * (the daemon lock, the SSL artifact lock, the certificate transaction, the
 * service update transaction, the runtime swap), two of them without EACCES, so
 * a file held open by a virus scanner failed in one place and not in another.
 * Every new atomic write goes through this one.
 *
 * @template T
 * @param {() => T} operation
 * @param {{ delays?: readonly number[] }} [options] Override the wait schedule
 * @returns {T}
 */
export function retrySharing(operation, options = {}) {
  const delays = options.delays ?? RETRY_DELAYS_MS;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (err) {
      // Any other code is a real failure: ENOENT, ENOSPC, a bad path. Retrying
      // it would only delay the error message the user needs.
      if (!isSharingError(err) || attempt >= delays.length) throw err;
      Atomics.wait(pause, 0, 0, delays[attempt]);
    }
  }
}

/**
 * The same retry for an operation that returns a promise.
 *
 * Awaited with `setTimeout` rather than a blocking wait, so a caller on the
 * request path (the session store) does not stall the event loop for 155 ms.
 *
 * @template T
 * @param {() => T | Promise<T>} operation
 * @param {{ delays?: readonly number[] }} [options]
 * @returns {Promise<T>}
 */
export async function retrySharingAsync(operation, options = {}) {
  const delays = options.delays ?? RETRY_DELAYS_MS;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      if (!isSharingError(err) || attempt >= delays.length) throw err;
      await new Promise((resolve) => { setTimeout(resolve, delays[attempt]); });
    }
  }
}

/**
 * Renames a file, riding out a momentary Windows sharing denial.
 *
 * @param {string} from
 * @param {string} to
 */
export function renameWithRetry(from, to) {
  retrySharing(() => fs.renameSync(from, to));
}

/**
 * The async form of renameWithRetry().
 *
 * @param {string} from
 * @param {string} to
 */
export async function renameWithRetryAsync(from, to) {
  await retrySharingAsync(() => fs.promises.rename(from, to));
}

/**
 * Copies a file, riding out a momentary Windows sharing denial.
 *
 * `mode` is `fs.constants.COPYFILE_*`, passed through unchanged; omitting it
 * keeps `fs.copyFileSync`'s own default.
 *
 * @param {string} from
 * @param {string} to
 * @param {number} [mode]
 */
export function copyFileWithRetry(from, to, mode) {
  retrySharing(() => (mode === undefined ? fs.copyFileSync(from, to) : fs.copyFileSync(from, to, mode)));
}

function openExclusive(file) {
  return retrySharing(() => fs.openSync(file, 'wx', 0o600));
}

/**
 * Creates a file that must not exist yet, exclusively and atomically.
 *
 * `wx` is the whole guarantee: it creates the file or fails with EEXIST, never
 * both, so two processes racing for the same lock, marker or claim cannot both
 * win. A failed write removes the file again, because a half-written lock that
 * was never ours must not look like one.
 *
 * @param {string} file
 * @param {string} body
 */
export function createStateFile(file, body) {
  const fd = openExclusive(file);
  try {
    fs.writeFileSync(fd, body, 'utf8');
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(file); } catch { /* never created, or already gone */ }
    throw err;
  }
  fs.closeSync(fd);
}

/**
 * Moves a prepared file over the target, retrying a brief sharing denial.
 *
 * Exported for the two recovery paths (daemon lock, jobs marker) that prepare
 * their own uniquely named candidate: they need the same Windows retry, and a
 * second copy of it would drift.
 *
 * @param {string} temp
 * @param {string} file
 */
export function moveIntoPlace(temp, file) {
  renameWithRetry(temp, file);
}

/**
 * Writes a state document atomically: a unique temp file, then a rename.
 *
 * On a final failure the temp file is removed and the error is thrown, so the
 * caller can log it (or, for a heartbeat, retry on the next beat) — state is
 * never silently dropped.
 *
 * @param {string} file
 * @param {string} body
 */
export function replaceStateFile(file, body) {
  const temp = `${file}.${randomUUID()}.tmp`;
  createStateFile(temp, body);
  try {
    moveIntoPlace(temp, file);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch { /* preserve the original failure */ }
    throw err;
  }
}

/** Files whose current failure has already been reported. */
const failingWrites = new Map();

/**
 * Logs a state write failure once per failure streak, not once per attempt.
 *
 * A heartbeat runs every five seconds; if the data directory is temporarily
 * unwritable, one line per beat would bury the log that explains it. The
 * first failure is reported, the rest are silent until it succeeds, and the
 * recovery is reported once.
 *
 * @param {string} file
 * @param {Error|unknown} err
 * @param {string} [hint] What happens next, for the reader of the log
 * @returns {boolean} True when this call did the reporting
 */
export function reportStateWriteFailure(file, err, hint = 'It will be retried on the next write.') {
  const key = String(file);
  if (failingWrites.has(key)) return false;
  failingWrites.set(key, true);

  const code = err?.code ?? 'unknown';
  const message = err?.message ?? String(err);
  console.warn(
    `[state] could not write ${key} (${code}: ${message}). ${hint} `
    + 'Check that the data directory is writable and that no other program is holding the file open.',
  );
  return true;
}

/**
 * Clears the failure streak for a file and says so, once.
 *
 * @param {string} file
 * @returns {boolean} True when a failure streak had been reported
 */
export function reportStateWriteSuccess(file) {
  const key = String(file);
  if (!failingWrites.delete(key)) return false;
  console.log(`[state] ${key} is writable again.`);
  return true;
}
