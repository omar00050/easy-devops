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
import { createHash } from 'crypto';
import { getDataDir } from './platform.js';
import { isPidAlive } from './daemon/lock.js';

const STATUS_FILE = 'update-status.json';
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_ID_LENGTH = 200;
const UPDATE_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isOptionalVersion(value) {
  return value === undefined
    || value === null
    || (typeof value === 'string' && value.length <= 128 && UPDATE_VERSION_RE.test(value));
}

function isValidDashboard(value) {
  if (value === undefined || value === null) return true;
  if (!isPlainObject(value)) return false;
  if (value.pid !== undefined && value.pid !== null && !isPositiveInteger(value.pid)) return false;
  if (value.port !== undefined
      && value.port !== null
      && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)) {
    return false;
  }
  return true;
}

function isValidStatus(record) {
  if (!isPlainObject(record)) return false;
  if (typeof record.id !== 'string' || record.id.length < 1 || record.id.length > MAX_ID_LENGTH) return false;
  if (![...ACTIVE_PHASES, ...FINAL_PHASES].includes(record.phase)) return false;
  if (!isOptionalVersion(record.from) || !isOptionalVersion(record.to)) return false;
  if (record.workerPid !== undefined
      && record.workerPid !== null
      && !isPositiveInteger(record.workerPid)) {
    return false;
  }
  return isValidDashboard(record.dashboard);
}

/**
 * Read at most MAX_STATUS_BYTES through one regular-file handle.
 *
 * The status file is a process-control record: dashboard.pid and dashboard.port
 * feed the detached worker. A malformed or oversized hand-written record must
 * be treated as absent, before either value can reach process-control code.
 */
function readBoundedStatus(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_STATUS_BYTES) return null;
    const buffer = Buffer.alloc(MAX_STATUS_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (read === 0) break;
      bytes += read;
    }
    if (bytes > MAX_STATUS_BYTES) return null;
    return buffer.subarray(0, bytes).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * The last written run, or null.
 *
 * @param {string} [dataDir]
 * @returns {Object|null}
 */
export function readStatus(dataDir = getDataDir()) {
  try {
    const text = readBoundedStatus(statusPath(dataDir));
    if (text === null) return null;
    const parsed = JSON.parse(text);
    return isValidStatus(parsed) ? parsed : null;
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
 * Remove a provisional run only when it is still the record named by id.
 *
 * The controller reserves the status before its asynchronous registry lookup.
 * If that lookup fails, another request may already have observed the
 * reservation; clearing it by id makes the same controller safe without risking
 * deletion of a replacement record.
 */
export function clearStatus(id, { dataDir = getDataDir() } = {}) {
  const current = readStatus(dataDir);
  if (!current || current.id !== id) return false;
  try {
    fs.unlinkSync(statusPath(dataDir));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function claimPath(runId, dataDir) {
  const key = createHash('sha256').update(String(runId)).digest('hex');
  return path.join(dataDir, 'update-worker-claims', `${key}.claim`);
}

/**
 * Atomically claim one starting run for exactly one worker process.
 *
 * The status phase check and this exclusive create cannot be a single database
 * transaction, but they do not need to be: every worker must hold this
 * per-run claim before it calls apply(). A second worker observes EEXIST and
 * exits without touching npm, the dashboard, or the status record.
 */
export function claimStartingRun(runId, { dataDir = getDataDir() } = {}) {
  if (typeof runId !== 'string' || runId.length < 1 || runId.length > MAX_ID_LENGTH) return null;
  const claim = claimPath(runId, dataDir);
  fs.mkdirSync(path.dirname(claim), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(claim, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, runId, claimedAt: Date.now() }));
    return claim;
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

export function releaseRunClaim(claim) {
  if (typeof claim !== 'string') return;
  try {
    fs.unlinkSync(claim);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
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
