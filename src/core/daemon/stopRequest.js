/**
 * core/daemon/stopRequest.js
 *
 * How `ezz service stop` reaches a daemon that has no service manager behind
 * it — Windows Personal mode, where the daemon is started by a hidden
 * Startup-folder supervisor and there is nothing to `sc stop`.
 *
 * ── Why a file and not the IPC channel ─────────────────────────────────────
 *
 * The IPC channel in core/daemon/ipc.js is deliberately **one-way**: the
 * daemon sends events and accepts no commands, because it may run as a service
 * account with access the dashboard user does not have. Adding a "stop"
 * command would turn that channel into a control surface and undo the
 * guarantee. A file in the data directory stays on the right side of that
 * line: writing it needs write access to the data directory, which is the same
 * permission that lets you edit the database anyway.
 *
 * ── The protocol ───────────────────────────────────────────────────────────
 *
 *   1. `ezz service stop` writes `<dataDir>/daemon.stop`.
 *   2. The daemon notices within a second and exits with code **0**.
 *   3. The supervisor treats exit 0 as "it was asked to stop" and does not
 *      restart it. It also checks for the file before each start, so a stop
 *      lands even while the supervisor is mid-backoff with no daemon running.
 *   4. The file is NOT removed by either of them — it is what keeps the
 *      supervisor from restarting. It is cleared by the logon bootstrap and by
 *      `ezz service start`, which is exactly what makes a stop temporary:
 *      back at the next logon, or when the user starts it again.
 *
 * Only Personal mode writes this file. Server mode and Linux have real service
 * managers, and `sc stop` / `systemctl stop` are authoritative there — adding
 * a marker a restarted service would then obey would break "back at boot".
 */

import { replaceStateFile } from '../atomicState.js';
import fs from 'fs';
import path from 'path';

import { getDataDir } from '../platform.js';

/** How often the daemon checks for the request. */
export const STOP_POLL_MS = 1_000;

const STOP_FILE = 'daemon.stop';

/** @returns {string} Absolute path to the stop-request file. */
export function stopRequestPath(dataDir = getDataDir()) {
  return path.join(dataDir, STOP_FILE);
}

/**
 * Asks the running daemon to stop.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {string} [opts.reason] Recorded for the log, never acted on
 * @returns {{ ok: boolean, path: string, reason?: string }}
 */
export function requestStop({ dataDir = getDataDir(), reason = 'ezz service stop' } = {}) {
  const file = stopRequestPath(dataDir);

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    replaceStateFile(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), by: process.pid, reason })}\n`,
    );
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, path: file, reason: `could not write ${file}: ${err.message}` };
  }
}

/**
 * Whether a stop has been requested and not yet cleared.
 *
 * @param {Object} [opts]
 * @returns {{ requested: boolean, at: string|null, reason: string|null }}
 */
export function readStopRequest({ dataDir = getDataDir() } = {}) {
  const file = stopRequestPath(dataDir);

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { requested: false, at: null, reason: null };
  }

  // An unparseable file still counts as a request: its presence is the signal,
  // and the contents are only there to explain it afterwards. Treating a
  // half-written file as "no request" would make a stop silently fail.
  try {
    const parsed = JSON.parse(raw);
    return { requested: true, at: parsed?.at ?? null, reason: parsed?.reason ?? null };
  } catch {
    return { requested: true, at: null, reason: null };
  }
}

/** Convenience boolean. */
export function isStopRequested(opts = {}) {
  return readStopRequest(opts).requested;
}

/**
 * Clears the request, so the supervisor may start the daemon again.
 *
 * Called by the logon bootstrap and by `ezz service start` — never by the
 * daemon or the supervisor, which both need the file to persist in order to
 * stay stopped.
 *
 * @returns {boolean} True when a request was actually removed
 */
export function clearStopRequest({ dataDir = getDataDir() } = {}) {
  try {
    fs.rmSync(stopRequestPath(dataDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Watches for a stop request and calls back once.
 *
 * A poll rather than `fs.watch`: the file is created by another process, and
 * `fs.watch` on a directory to catch a creation is unreliable across platforms
 * and network shares. A one-second `existsSync` is cheap and cannot miss the
 * event.
 *
 * @param {Object} opts
 * @param {string} [opts.dataDir]
 * @param {number} [opts.intervalMs]
 * @param {(request: { at: string|null, reason: string|null }) => void} opts.onStop
 * @returns {{ stop: () => void, check: () => boolean }}
 */
export function watchForStop({ dataDir = getDataDir(), intervalMs = STOP_POLL_MS, onStop } = {}) {
  let fired = false;

  const check = () => {
    if (fired) return true;

    const request = readStopRequest({ dataDir });
    if (!request.requested) return false;

    fired = true;
    try {
      onStop?.(request);
    } catch (err) {
      console.error('[daemon] stop handler threw:', err.message);
    }
    return true;
  };

  const timer = setInterval(check, intervalMs);

  return {
    stop() { clearInterval(timer); },
    check,
  };
}
