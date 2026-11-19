/**
 * core/daemon/stateFile.js
 *
 * The daemon's public state, written to a file in the data directory.
 *
 * ── Why a file when there is an IPC channel ────────────────────────────────
 *
 * In Windows Server mode the daemon runs as `NT SERVICE\EasyDevOps`, and the
 * named pipe it creates carries that account's default security: an
 * Administrator's CLI cannot open it. Node has no API to put a different ACL
 * on a pipe, and a native module for it would be a new dependency for one
 * read. So `ezz hub status` and `ezz hub connect` said "not reported by the
 * background service yet" while the Hub showed the agent connected.
 *
 * The data directory is already shared on purpose — the service account
 * modifies it, Administrators own ProgramData, the installing user reads it —
 * so the daemon also writes what a CLI needs to read there. The IPC channel is
 * unchanged and stays one-way; this file is a second, read-only window, not a
 * way to send anything to the daemon.
 *
 * ── What it holds ──────────────────────────────────────────────────────────
 *
 * Only what `getHubAgentStatus()` returns — linked, connected, status,
 * lastError, attempts — plus the daemon's pid, version and the time of the
 * write. No secret, no Hub URL, no server id: those are in the database,
 * readable by the same people, and never needed here.
 *
 * ── Staleness ──────────────────────────────────────────────────────────────
 *
 * A file outlives its writer. A reader trusts it only when its pid is the pid
 * holding the live daemon lock (pid + heartbeat, core/daemon/lock.js), so a
 * leftover from a crashed or stopped daemon is never reported as current.
 */

import fs from 'fs';
import path from 'path';

import { inspect as inspectLock } from './lock.js';

export const STATE_FILE_NAME = 'daemon-state.json';

/** @param {string} dataDir */
export function stateFilePath(dataDir) {
  return path.join(dataDir, STATE_FILE_NAME);
}

/**
 * Writes the state atomically: a temporary file, then a rename, so a reader
 * never sees half a JSON document. Never throws — the daemon's work must not
 * depend on a status file.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {number} opts.pid
 * @param {string} [opts.version]
 * @param {Object|null} opts.hub   getHubAgentStatus()
 * @returns {boolean} whether it was written
 */
export function writeDaemonState({ dataDir, pid, version = null, hub }) {
  const file = stateFilePath(dataDir);
  const body = `${JSON.stringify({
    pid,
    version,
    updatedAt: new Date().toISOString(),
    hub: hub
      ? {
        linked: Boolean(hub.linked),
        connected: Boolean(hub.connected),
        status: hub.status ?? null,
        lastError: hub.lastError ?? null,
        attempts: Number.isFinite(hub.attempts) ? hub.attempts : 0,
      }
      : null,
  })}\n`;

  const temp = `${file}.${pid}.tmp`;
  try {
    fs.writeFileSync(temp, body, 'utf8');
    try {
      fs.renameSync(temp, file);
    } catch {
      // Windows refuses a rename over a file a reader has open at that
      // instant. A direct write is still whole for a document this small.
      fs.writeFileSync(file, body, 'utf8');
      fs.rmSync(temp, { force: true });
    }
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing to clean */ }
    return false;
  }
}

/** Removes the file on a clean stop. Best effort. */
export function removeDaemonState({ dataDir, pid }) {
  try {
    const current = readDaemonStateFile({ dataDir });
    // Only our own: a daemon that already replaced us must keep its file.
    if (!current || current.pid === pid) fs.rmSync(stateFilePath(dataDir), { force: true });
  } catch { /* best effort */ }
}

/** The raw file, or null. */
export function readDaemonStateFile({ dataDir }) {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The agent state as last written by the RUNNING daemon, or null.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {Function} [opts.inspect] Injected for tests
 * @returns {Object|null} the `hub` object, with `source: 'state-file'`
 */
export function readAgentStateFromFile({ dataDir, inspect = inspectLock } = {}) {
  const state = readDaemonStateFile({ dataDir });
  if (!state?.hub) return null;

  const lock = inspect({ dataDir });
  if (!lock.running || lock.lock?.pid !== state.pid) return null;

  return { ...state.hub, updatedAt: state.updatedAt ?? null, source: 'state-file' };
}
