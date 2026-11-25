/**
 * core/hub/deployProgress.js
 *
 * Live deployment progress for the Hub, read from the files the engine already
 * writes.
 *
 * A deployment can be started by this process (the Hub), by an open dashboard
 * in another process, by `ezz daemon`, or by a CI hook. The in-process job bus
 * therefore cannot be the source: two of those run somewhere else. What every
 * one of them leaves behind is the same pair of files —
 *
 *   deploy/<app>/deploy.lock       who is deploying, and which run
 *   deploy/<app>/runs/<id>.json    the run record, rewritten as steps change
 *   deploy/<app>/logs/<id>.log     the run output, appended by the engine
 *
 * so the agent watches those with cheap fs reads. It never spawns a process,
 * never reads the deploy key, and never sends a run's log unless the Hub has
 * `deploy.logs`.
 *
 * Detection runs every two seconds because a lock file appearing is the only
 * cross-process "a deployment started" signal there is. Once a run is found it
 * is polled every second, and the log is read from the last byte offset, so a
 * long build is not re-sent line after line. Only whole lines are emitted; a
 * partial last line waits for its newline.
 */

import fs from 'fs';
import path from 'node:path';

import { getDataDir } from '../platform.js';
import { listApps } from '../deploy/apps.js';
import { logFile, lockHolder, listRuns, readRun } from '../deploy/store.js';
import { RUN_STATUS, redactSecrets } from '../deploy/engine.js';
import { isRedactedDeployRun } from '../deploy/logSecurity.js';
import { getHubPermissions } from '../hubLink.js';
import { openVerifiedChild } from '../safe-file.js';

/** How often apps and their locks are scanned for a new run. */
export const DETECT_INTERVAL_MS = 2_000;
/** How often a run already under way is read. */
export const POLL_INTERVAL_MS = 1_000;
/** At most one `deploy:progress` per run per second. */
export const EMIT_INTERVAL_MS = 1_000;

/** Limits of one event's `lines` array. */
export const MAX_LINES = 200;
export const MAX_LINE_CHARS = 2_000;
export const MAX_LINES_BYTES = 32 * 1024;
/** One poll never allocates more than this much of a run log. */
export const MAX_PROGRESS_READ_BYTES = 128 * 1024;
/** File reads are fixed-size, so a sparse or fast-growing file cannot force one large allocation. */
export const MAX_PROGRESS_CHUNK_BYTES = 16 * 1024;
/** A newline-free producer is represented by this bounded tail. */
export const MAX_PROGRESS_PARTIAL_CHARS = 32 * 1024;
/** Remember enough completed runs to avoid re-announcing a crashed one, without growing forever. */
export const MAX_SEEN_RUNS = 512;

/** A deploy key must never travel, not even as part of a log line. */
const PRIVATE_KEY_LINE = /PRIVATE KEY-----/;
/** The edges of a PEM private key block: everything between them is the key itself. */
const KEY_BLOCK_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_BLOCK_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

const RUNNING = RUN_STATUS.RUNNING;

/**
 * What the run record says about the current step.
 *
 * The record has a single real field for this — `step` — not a `steps` array.
 * The event's array shape is kept for the Hub, but it is built from that field
 * only, so nothing here can disagree with the record the dashboard shows.
 *
 * @param {Object|null} run
 * @returns {Array<{ name: string, status: string }>}
 */
export function stepsFromRun(run) {
  if (!run || typeof run.step !== 'string' || run.step === '') return [];
  const status = typeof run.status === 'string' ? run.status : RUNNING;
  return [{ name: run.step, status }];
}

/**
 * Applies the two rules a log line must pass before it can leave this machine:
 * drop anything that looks like a private key, and redact the app's own secret
 * values. The length cap is applied after redaction, so a long secret cannot
 * make the cap hide the `***` that replaced it.
 *
 * @param {string} line
 * @param {Object|null} app
 * @returns {string|null} null when the line must be dropped entirely
 */
export function safeLogLine(line, app) {
  if (PRIVATE_KEY_LINE.test(line)) return null;
  const redacted = redactSecrets(line, app?.env ?? {}, app?.auth?.token ?? null);
  return redacted.length > MAX_LINE_CHARS ? redacted.slice(0, MAX_LINE_CHARS) : redacted;
}

/**
 * The same rules for a whole log text (the Hub's `run` action): redaction
 * per line, and every PEM private key block dropped from BEGIN to END.
 *
 * @param {string} text
 * @param {Object|null} app
 * @returns {string}
 */
export function safeLogText(text, app) {
  const out = [];
  let inKeyBlock = false;
  for (const line of String(text ?? '').split('\n')) {
    if (inKeyBlock) {
      if (KEY_BLOCK_END.test(line)) inKeyBlock = false;
      continue;
    }
    if (KEY_BLOCK_BEGIN.test(line) && !KEY_BLOCK_END.test(line)) {
      inKeyBlock = true;
      continue;
    }
    const safeLine = safeLogLine(line, app);
    if (safeLine !== null) out.push(safeLine);
  }
  return out.join('\n');
}

/**
 * Takes the newest lines that fit in one event.
 *
 * When more arrived than fit, the newest are kept and `skipped` says how many
 * of the oldest were dropped. Sending the newest matters: a build's last lines
 * are the ones that explain where it stopped.
 *
 * @param {string[]} lines
 * @returns {{ lines: string[], skipped: number }}
 */
export function batchLines(lines) {
  const selected = [];
  let bytes = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (selected.length >= MAX_LINES) break;
    const line = lines[i].length > MAX_LINE_CHARS ? lines[i].slice(0, MAX_LINE_CHARS) : lines[i];
    // Measure what the Hub will actually receive: JSON escaping can double a
    // line of quotes or backslashes, and that is part of the payload budget.
    const size = Buffer.byteLength(JSON.stringify(line), 'utf8') + 1; // + the comma
    if (selected.length > 0 && bytes + size > MAX_LINES_BYTES) break;
    selected.push(line);
    bytes += size;
  }

  selected.reverse();
  return { lines: selected, skipped: lines.length - selected.length };
}

/**
 * Creates one poller. Exported for tests; the agent uses the singleton below.
 *
 * @param {Object} options
 * @param {(event: string, payload: Object) => void} options.emit
 * @param {() => void} [options.onAppsChanged] Send a fresh deploy:apps
 * @param {string} [options.dataDir]
 * @param {number} [options.detectMs]
 * @param {number} [options.pollMs]
 * @param {number} [options.emitMs]
 * @param {Object} [options.deps] Injected store/app functions (tests only)
 */
export function createDeployProgress({
  emit,
  onAppsChanged = () => {},
  dataDir = getDataDir(),
  detectMs = DETECT_INTERVAL_MS,
  pollMs = POLL_INTERVAL_MS,
  emitMs = EMIT_INTERVAL_MS,
  deps = {},
} = {}) {
  if (typeof emit !== 'function') throw new TypeError('deployProgress: emit must be a function');

  const listAppsFn = deps.listApps ?? listApps;
  const lockHolderFn = deps.lockHolder ?? lockHolder;
  const listRunsFn = deps.listRuns ?? listRuns;
  const readRunFn = deps.readRun ?? readRun;
  const logFileFn = deps.logFile ?? logFile;
  const getPermissionsFn = deps.getPermissions ?? getHubPermissions;
  const nowFn = deps.now ?? (() => Date.now());

  /** runId → per-run cursor state */
  const active = new Map();
  /** Runs already watched, newest last, so an interrupted run is not picked up twice. */
  const seen = new Map();

  let detectTimer = null;
  let pollTimer = null;
  let stopped = true;

  const safe = (fn, fallback = null) => {
    try { return fn(); } catch { return fallback; }
  };

  function rememberRun(runId) {
    seen.delete(runId);
    seen.set(runId, true);
    while (seen.size > MAX_SEEN_RUNS) {
      const oldest = seen.keys().next().value;
      if (active.has(oldest)) break;
      seen.delete(oldest);
    }
  }

  function startRun(app, runId) {
    if (stopped || seen.has(runId) || active.has(runId)) return;
    rememberRun(runId);

    const state = {
      appId: app.id,
      app,
      runId,
      offset: 0,
      partial: '',
      partialDropped: 0,
      skippedLines: 0,
      inKeyBlock: false,
      pending: [],
      lastEmitAt: 0,
      lastFingerprint: null,
    };
    active.set(runId, state);

    try { onAppsChanged(); } catch { /* the list push is not the poller's job */ }
    poll(state); // do not wait a second for the first sign of life
  }

  function detect() {
    if (stopped) return;
    const apps = safe(() => listAppsFn()) ?? [];
    if (!Array.isArray(apps)) return;

    for (const app of apps) {
      const appId = app?.id;
      if (typeof appId !== 'string' || appId === '') continue;

      // A lock is the strongest signal. The newest run record is the fallback
      // only when no lock is held at all — a lock with no runId belongs to
      // another operation (a move or a delete), not to a deployment.
      const holder = safe(() => lockHolderFn(appId, dataDir));
      let runId = null;
      if (holder) {
        if (typeof holder.runId === 'string') runId = holder.runId;
      } else {
        const newest = safe(() => listRunsFn(appId, { limit: 1, dataDir }))?.[0];
        if (newest?.status === RUNNING && typeof newest.id === 'string') runId = newest.id;
      }

      if (typeof runId !== 'string' || runId === '' || seen.has(runId)) continue;
      startRun(app, runId);
    }
  }

  /**
   * Reads bytes added since the last read.
   *
   * Three cases that would otherwise corrupt the stream: the file does not
   * exist yet (nothing to read), it was truncated while a run was live (start
   * again from zero), and the last chunk ends mid-line (hold the fragment until
   * its newline arrives).
   *
   * @returns {{lines: string[], skipped: number}} Whole lines and the count
   *          dropped by the fixed per-poll line budget
   */
  function readNewLines(state) {
    let file;
    try { file = logFileFn(state.appId, state.runId, dataDir); } catch {
      return { lines: [], skipped: 0 };
    }

    let opened;
    try {
      opened = openVerifiedChild(file, { expectedDirectory: path.dirname(file) });
      const size = opened.opened.size;
      if (size < state.offset) {
        state.offset = 0;
        state.partial = '';
        state.partialDropped = 0;
        state.inKeyBlock = false;
      }
      if (size === state.offset) return { lines: [], skipped: 0 };

      const jumped = size - state.offset > MAX_PROGRESS_READ_BYTES;
      const start = jumped ? size - MAX_PROGRESS_READ_BYTES : state.offset;
      let firstFragmentComplete = !jumped || start === 0;
      if (jumped) {
        state.partial = '';
        state.partialDropped = 0;
        state.inKeyBlock = false;
      }

      const lines = [];
      let skippedLines = jumped && start > 0 ? 1 : 0;
      const addLine = (rawLine) => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (state.partialDropped > 0) {
          // The old prefix is deliberately not retained. Keep the newest bounded
          // tail and make the truncation visible rather than pretending the line
          // was complete.
          lines.push(`[line truncated: ${state.partialDropped} characters] ${line}`);
          state.partialDropped = 0;
        } else {
          lines.push(line);
        }
        if (lines.length > MAX_LINES) {
          lines.shift();
          skippedLines += 1;
        }
      };

      let bytesRead = 0;
      const decoder = new TextDecoder('utf-8');
      while (start + bytesRead < size) {
        const remaining = size - (start + bytesRead);
        const length = Math.min(MAX_PROGRESS_CHUNK_BYTES, remaining);
        const buffer = Buffer.allocUnsafe(length);
        const got = fs.readSync(opened.fd, buffer, 0, length, start + bytesRead);
        if (got <= 0) break;
        bytesRead += got;

        let text = decoder.decode(buffer.subarray(0, got), { stream: true });
        if (!firstFragmentComplete) {
          const newline = text.indexOf('\n');
          if (newline === -1) continue;
          text = text.slice(newline + 1);
          firstFragmentComplete = true;
        }

        const parts = `${state.partial}${text}`.split('\n');
        state.partial = parts.pop() ?? '';
        for (const line of parts) addLine(line);

        if (state.partial.length > MAX_PROGRESS_PARTIAL_CHARS) {
          const drop = state.partial.length - MAX_PROGRESS_PARTIAL_CHARS;
          state.partial = state.partial.slice(drop);
          state.partialDropped += drop;
        }
      }

      if (bytesRead > 0) {
        let tail = decoder.decode();
        if (!firstFragmentComplete) {
          const newline = tail.indexOf('\n');
          tail = newline === -1 ? '' : tail.slice(newline + 1);
        }
        if (tail) {
          const parts = `${state.partial}${tail}`.split('\n');
          state.partial = parts.pop() ?? '';
          for (const line of parts) addLine(line);
        }
      }
      state.offset = start + bytesRead;
      return { lines, skipped: skippedLines };
    } catch {
      return { lines: [], skipped: 0 };
    } finally {
      opened?.close();
    }
  }

  function emitProgress(state, { status, steps, stage, skippedStages, done, now }) {
    const pending = state.pending;
    state.pending = [];

    let lines = [];
    let skipped = 0;
    const permissions = safe(() => getPermissionsFn(), {}) ?? {};
    if (permissions['deploy.logs'] === true) {
      ({ lines, skipped } = batchLines(pending));
    }
    skipped += state.skippedLines;
    state.skippedLines = 0;

    const payload = {
      appId: state.appId,
      runId: state.runId,
      status,
      steps,
      // The canonical stage bar. `stage` is null and `skippedStages` empty for
      // an agent old enough to send neither; readers fall back to `steps`.
      stage,
      skippedStages,
      lines,
      done,
      at: new Date(now).toISOString(),
    };
    if (skipped > 0) payload.skipped = skipped;

    try { emit('deploy:progress', payload); } catch { /* a closed socket is not a poller error */ }
  }

  function finish(state) {
    if (active.get(state.runId) !== state) return;
    active.delete(state.runId);
    try { onAppsChanged(); } catch { /* non-fatal */ }
  }

  function poll(state) {
    if (stopped || active.get(state.runId) !== state) return;

    const run = safe(() => readRunFn(state.appId, state.runId, dataDir));
    const holder = safe(() => lockHolderFn(state.appId, dataDir));
    const lockHeld = Boolean(holder && holder.runId === state.runId);

    if (!run) {
      // The lock is taken before the record is written, so a missing record
      // while the lock is ours is just "not yet". Otherwise this run is over
      // without a record to report.
      if (!lockHeld) finish(state);
      return;
    }

    const app = state.app;
    if (isRedactedDeployRun(run)) {
      const read = readNewLines(state);
      state.skippedLines += read.skipped;
      for (const line of read.lines) {
        // Dropping only the BEGIN/END lines would still send the base64 between
        // them. A block that never ends drops the rest of the run's log.
        if (state.inKeyBlock) {
          if (KEY_BLOCK_END.test(line)) state.inKeyBlock = false;
          continue;
        }
        if (KEY_BLOCK_BEGIN.test(line) && !KEY_BLOCK_END.test(line)) {
          state.inKeyBlock = true;
          continue;
        }
        const safeLine = safeLogLine(line, app);
        if (safeLine !== null) state.pending.push(safeLine);
      }
    }

    const status = typeof run.status === 'string' ? run.status : RUNNING;
    const steps = stepsFromRun(run);
    const stage = typeof run.stage === 'string' && run.stage !== '' ? run.stage : null;
    const skippedStages = Array.isArray(run.skippedStages) ? run.skippedStages : [];
    const done = status !== RUNNING || !lockHeld;
    const fingerprint = `${status}|${done}|${stage ?? ''}|${skippedStages.join(',')}|${steps.map((s) => `${s.name}:${s.status}`).join(',')}`;
    const now = nowFn();

    const changed = done || state.pending.length > 0 || fingerprint !== state.lastFingerprint;
    if (changed && (done || now - state.lastEmitAt >= emitMs)) {
      emitProgress(state, { status, steps, stage, skippedStages, done, now });
      state.lastEmitAt = now;
      state.lastFingerprint = fingerprint;
    }

    if (done) finish(state);
  }

  return {
    start() {
      if (!stopped) return this;
      stopped = false;
      detect();
      detectTimer = setInterval(detect, detectMs);
      pollTimer = setInterval(() => {
        for (const state of [...active.values()]) poll(state);
      }, pollMs);
      detectTimer.unref?.();
      pollTimer.unref?.();
      return this;
    },

    stop() {
      stopped = true;
      if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      active.clear();
      seen.clear();
    },

    isRunning() {
      return !stopped;
    },

    activeRunIds() {
      return [...active.keys()];
    },

    seenRunIds() {
      return [...seen.keys()];
    },
  };
}

// ─── The agent's singleton ───────────────────────────────────────────────────

let singleton = null;

/**
 * Starts progress observation for the current agent socket. Idempotent: a
 * reconnect replaces the old poller rather than leaving two reading one log.
 */
export function startDeployProgress(options) {
  stopDeployProgress();
  singleton = createDeployProgress(options);
  singleton.start();
  return singleton;
}

/** Stops observation and forgets every cursor. Called with the socket. */
export function stopDeployProgress() {
  if (!singleton) return;
  singleton.stop();
  singleton = null;
}

/** @returns {boolean} */
export function isDeployProgressRunning() {
  return singleton?.isRunning() === true;
}
