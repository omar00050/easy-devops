/**
 * core/updateStatus.js
 *
 * The single record of an update the dashboard asked for.
 *
 * The process that starts an update does not survive it, so memory cannot be
 * the medium: the HTTP handler writes the first record, the detached worker
 * rewrites it at every phase, and the dashboard that comes back reads it to
 * tell the user what happened. A crash needs no separate handling — an active
 * phase whose worker is gone and whose heartbeat stopped is reported as
 * interrupted, never as still running.
 */

import fs from 'fs';
import path from 'path';
import { getDataDir } from './platform.js';
import { isPidAlive } from './daemon/lock.js';

const STATUS_FILE = 'update-status.json';

/** Phases that mean "a run has not finished". */
export const ACTIVE_PHASES = Object.freeze(['starting', 'stopping', 'updating', 'restarting']);

/** Phases that are a final outcome. */
export const FINAL_PHASES = Object.freeze(['done', 'failed', 'interrupted']);

/**
 * How old the heartbeat may be before an active run is called interrupted.
 * Generous: the npm install step legitimately runs for minutes, and its worker
 * only needs to refresh every few seconds.
 */
export const STALE_AFTER_MS = 45_000;

/** @returns {string} Absolute path to the status file. */
export function statusPath(dataDir = getDataDir()) {
  return path.join(dataDir, STATUS_FILE);
}

/**
 * The last written run, or null.
 *
 * @param {string} [dataDir]
 * @returns {Object|null}
 */
export function readStatus(dataDir = getDataDir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath(dataDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.id !== 'string' || typeof parsed.phase !== 'string') return null;
    return parsed;
  } catch {
    // Missing, unreadable or truncated: all mean "no run to report". A
    // half-written file is possible after a crash mid-write and is not data.
    return null;
  }
}

/**
 * Merges a patch into the status file and stamps the heartbeat.
 *
 * Atomic (temp + rename), because the dashboard that reads it may be starting
 * at the same moment the worker writes the final record.
 *
 * @param {Object} patch
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {boolean} [opts.replace] Start a fresh record instead of merging
 * @returns {Object} The record as written
 */
export function writeStatus(patch, { dataDir = getDataDir(), replace = false } = {}) {
  const current = replace ? {} : readStatus(dataDir) ?? {};
  const next = { ...current, ...patch, updatedAt: Date.now() };

  const target = statusPath(dataDir);
  const temp = `${target}.${process.pid}.tmp`;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);

  return next;
}

/**
 * True while a run should be shown as in progress.
 *
 * A live worker pid is proof enough; without one (the spawn has not reported
 * back yet), a fresh heartbeat is. Both stale means the worker died and the
 * run will never finish on its own.
 *
 * @param {Object|null} run
 * @param {Object} [opts]
 * @returns {boolean}
 */
export function runIsActive(run, { now = Date.now(), isAlive = isPidAlive } = {}) {
  if (!run || !ACTIVE_PHASES.includes(run.phase)) return false;
  if (run.workerPid && isAlive(run.workerPid)) return true;
  return now - Number(run.updatedAt ?? 0) < STALE_AFTER_MS;
}

/**
 * The run as an API should present it: an abandoned active phase becomes
 * `interrupted`, so no client has to reason about heartbeats.
 *
 * @param {Object|null} run
 * @param {Object} [opts]
 * @returns {Object|null}
 */
export function describeRun(run, opts) {
  if (!run) return null;
  if (ACTIVE_PHASES.includes(run.phase) && !runIsActive(run, opts)) {
    return { ...run, phase: 'interrupted' };
  }
  return run;
}
