/**
 * core/ssl/progress.js
 *
 * Live progress for a certificate operation, in one small place so the
 * dashboard, the CLI and the Hub all describe the same stages the same way.
 *
 * The payload is deliberately boring and secret-free:
 *
 *   { opId, domain, stage, status: 'running'|'ok'|'failed'|'skipped',
 *     detail?, elapsedMs, at }
 *
 * Throttling is part of the contract: at most five events per opId per second.
 * When the budget is spent the LAST event of each stage is kept and sent when
 * the window reopens, so a stage's running -> ok/failed pair cannot be lost to
 * the throttle. A listener that throws never breaks the issuance that is doing
 * the real work.
 */

import crypto from 'node:crypto';

export const OP_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const PROGRESS_WINDOW_MS = 1000;
export const PROGRESS_MAX_PER_WINDOW = 5;
export const PROGRESS_DETAIL_MAX = 300;

/** True for a caller-supplied operation id that is safe to echo back. */
export function isValidOpId(value) {
  return typeof value === 'string' && OP_ID_PATTERN.test(value);
}

/** A server-generated id, used when the client did not send one. */
export function newOpId() {
  return `ssl_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Validates an optional client opId.
 *
 * @param {*} value
 * @param {() => string} [generate]
 * @returns {{ opId: string, error: string|null }}
 */
export function resolveOpId(value, generate = newOpId) {
  if (value === undefined || value === null || value === '') {
    return { opId: generate(), error: null };
  }
  if (!isValidOpId(value)) {
    return {
      opId: null,
      error: 'opId must be 8-64 characters of A-Z, a-z, 0-9, "_" or "-".',
    };
  }
  return { opId: value, error: null };
}

/**
 * Removes anything that must never leave the process in a progress detail.
 * ACME errors are text from a remote server; a key block in one would be a
 * surprise, and the cost of checking is trivial.
 */
export function sanitizeDetail(value) {
  if (typeof value !== 'string' || value === '') return '';
  const redacted = value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '[redacted private key]')
    .replace(/-----BEGIN [^-]*-----[\s\S]*?-----END [^-]*-----/g, '[redacted]');
  return redacted.length > PROGRESS_DETAIL_MAX
    ? redacted.slice(0, PROGRESS_DETAIL_MAX)
    : redacted;
}

/**
 * Creates the per-operation reporter.
 *
 * @param {Object} [options]
 * @param {string|null} [options.opId]
 * @param {string|null} [options.domain]
 * @param {(event: Object) => void} [options.onEvent] Full event payload
 * @param {(stage: string, status: string, detail?: string) => void} [options.onProgress]
 *   The Hub/agent signature: step = stage.
 * @param {() => number} [options.now] Injected clock (testing)
 * @param {Function} [options.schedule] Injected setTimeout (testing)
 * @param {Function} [options.cancel] Injected clearTimeout (testing)
 * @returns {{
 *   opId: string|null, domain: string|null,
 *   report: (stage: string, status: string, detail?: string) => void,
 *   elapsedMs: () => number,
 *   flush: () => void,
 *   pendingCount: () => number,
 *   stop: () => void,
 * }}
 */
export function createSslProgress({
  opId = null,
  domain = null,
  onEvent = null,
  onProgress = null,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  windowMs = PROGRESS_WINDOW_MS,
  maxPerWindow = PROGRESS_MAX_PER_WINDOW,
} = {}) {
  const startedAt = now();
  let windowStartedAt = startedAt;
  let sentInWindow = 0;
  let timer = null;
  const deferred = new Map();

  const safeEmit = (payload) => {
    try { if (onEvent) onEvent(payload); } catch { /* never break the work */ }
    try {
      if (onProgress) onProgress(payload.stage, payload.status, payload.detail);
    } catch { /* never break the work */ }
  };

  const arm = () => {
    if (timer) return;
    const wait = Math.max(1, windowStartedAt + windowMs - now());
    try {
      timer = schedule(() => {
        timer = null;
        flush();
      }, wait);
      if (timer && typeof timer.unref === 'function') timer.unref();
    } catch { timer = null; }
  };

  const flush = () => {
    try {
      if (deferred.size === 0) return;
      const t = now();
      if (t - windowStartedAt >= windowMs) {
        windowStartedAt = t;
        sentInWindow = 0;
      }
      for (const [stage, payload] of [...deferred]) {
        if (sentInWindow >= maxPerWindow) break;
        deferred.delete(stage);
        sentInWindow += 1;
        safeEmit(payload);
      }
      if (deferred.size) arm();
    } catch { /* never throw from a timer */ }
  };

  const report = (stage, status, detail) => {
    try {
      const statusName = String(status);
      if (!['running', 'ok', 'failed', 'skipped'].includes(statusName)) return;

      const elapsedMs = Math.max(0, now() - startedAt);
      const payload = {
        opId,
        domain,
        stage: String(stage),
        status: statusName,
        elapsedMs,
        at: new Date().toISOString(),
      };
      const clean = sanitizeDetail(detail);
      if (clean) payload.detail = clean;

      const t = now();
      if (t - windowStartedAt >= windowMs) {
        windowStartedAt = t;
        sentInWindow = 0;
      }

      if (sentInWindow < maxPerWindow) {
        sentInWindow += 1;
        safeEmit(payload);
        return;
      }

      // Over the budget: remember only the newest event for this stage.
      deferred.set(payload.stage, payload);
      arm();
    } catch { /* never throw */ }
  };

  return {
    opId,
    domain,
    report,
    elapsedMs: () => Math.max(0, now() - startedAt),
    flush,
    pendingCount: () => deferred.size,
    stop() {
      if (timer) {
        try { cancel(timer); } catch { /* ignore */ }
        timer = null;
      }
    },
  };
}
