/**
 * dashboard/lib/loginRateLimit.js
 *
 * In-memory rate limiting for the login endpoint: 10 attempts per 15 minutes
 * per client IP.
 *
 * Deliberately not `express-rate-limit`, which the hub backend uses — the
 * easy-devops constitution forbids adding a dependency here, and a fixed
 * window over a Map is enough for one login route on a single-process
 * dashboard.
 *
 * In memory means the counters reset when the dashboard restarts. That is an
 * accepted limit: the point is to make online guessing impractical, not to
 * survive a restart, and an attacker cannot trigger a restart from outside.
 *
 * ── Separate budgets ───────────────────────────────────────────────────────
 *
 * Callers name a BUCKET, and each bucket counts independently per IP. Login
 * and first-run setup are different questions, and sharing one counter would
 * mean a few mistyped setup codes locked the user out of logging in, or that
 * an attacker could burn the setup budget by failing logins. The setup code
 * additionally has a global cap of its own, in core/setupCode.js — that is the
 * part a per-IP limit cannot provide.
 */

/** Attempts allowed per window, per IP. */
const MAX_ATTEMPTS = 10;

/** Window length. */
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Entries are dropped once their window has passed, so the map cannot grow
 * without bound. The sweep is lazy — it runs on access rather than on a
 * timer, because a module-level setInterval would keep the event loop alive
 * and stop `ezz --dash` exiting on Ctrl+C (a bug this project has hit twice).
 */
const attempts = new Map();

/** Sweeps expired entries. Cheap: the map only holds recent IPs. */
function prune(now) {
  for (const [key, entry] of attempts) {
    if (now >= entry.resetAt) attempts.delete(key);
  }
}

/**
 * The client's address.
 *
 * `req.ip` already honours Express's trust-proxy setting, which this app does
 * not enable — so this is the socket address, not a spoofable header. That is
 * the right default: trusting X-Forwarded-For without a configured proxy
 * would let anyone reset their own limit by sending a header.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function clientKey(req, bucket = 'login') {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return `${bucket}:${ip}`;
}

/**
 * Records an attempt and reports whether it is allowed.
 *
 * Call once per login attempt, before checking the password.
 *
 * @param {import('express').Request} req
 * @param {number} [now] Injectable clock, for tests
 * @param {string} [bucket] Which budget to count against ('login' | 'setup')
 * @returns {{ allowed: boolean, remaining: number, retryAfterSeconds: number }}
 */
export function recordAttempt(req, now = Date.now(), bucket = 'login') {
  prune(now);

  const key = clientKey(req, bucket);
  const existing = attempts.get(key);

  if (!existing || now >= existing.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_ATTEMPTS - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;

  if (existing.count > MAX_ATTEMPTS) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  return {
    allowed: true,
    remaining: MAX_ATTEMPTS - existing.count,
    retryAfterSeconds: 0,
  };
}

/**
 * Clears the counter for a client.
 *
 * Called after a successful login, so that someone who mistyped a few times
 * and then got in is not left near the limit.
 *
 * @param {import('express').Request} req
 * @param {string} [bucket]
 */
export function clearAttempts(req, bucket = 'login') {
  attempts.delete(clientKey(req, bucket));
}

/** Drops every counter. For tests and for a clean shutdown. */
export function resetAll() {
  attempts.clear();
}

export const LOGIN_RATE_LIMIT = Object.freeze({ MAX_ATTEMPTS, WINDOW_MS });
