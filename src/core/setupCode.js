/**
 * core/setupCode.js
 *
 * The one-time code that protects first-run setup from being taken over.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 *
 * `POST /api/setup` has to be public: it is how the first password gets set,
 * and there is no session to require before that password exists. So on a
 * freshly started dashboard with no password, whoever reaches that endpoint
 * first owns the installation. The transport checks (Host/Origin/X-EZ-Request)
 * stop a hostile *page* in the user's browser, and they are a real defence,
 * but they do nothing against a direct request from anything that can reach
 * the port — which, on a server deliberately bound to 0.0.0.0, is the network.
 *
 * The code is proof that the person setting the password can read the server's
 * terminal or its service log. That is the property we actually want: setup is
 * for whoever runs the machine.
 *
 * ── Why six digits are enough here ─────────────────────────────────────────
 *
 * Six digits is 10^6, which a script could exhaust in minutes if it were
 * allowed to try. It is not:
 *
 *   - per-IP rate limiting, in its own budget (so setup guesses cannot
 *     exhaust the login budget, or the reverse), and
 *   - a GLOBAL cap of 20 failed attempts across every address, after which the
 *     code is invalidated and only the machine's own terminal can issue
 *     another, and
 *   - a 24-hour expiry, so an abandoned pending setup does not leave a
 *     guessable code outstanding for ever.
 *
 * The global cap is the one that matters: a per-IP limit alone is bypassable
 * from many addresses, and it is the part that bounds the whole attack to 20
 * guesses rather than 20 per attacker.
 *
 * ── It never leaves the machine ────────────────────────────────────────────
 *
 * The code is printed to the local terminal and written to the local service
 * log, and nowhere else. It is NOT in `GET /api/auth`, not in any other API
 * response, not in a Socket.io event, and not in anything the Hub agent sends.
 * A client may learn *whether* a code is required; never what it is.
 *
 * That is why only the HASH is stored, in the same scrypt form as the
 * dashboard password (core/passwords.js) and compared the same way: a code
 * readable from the database would be readable by anything that can read the
 * database, including the Hub telemetry paths that legitimately read config.
 * The cleartext exists in this process only long enough to be printed.
 */

import { randomInt } from 'node:crypto';

import { dbGet, dbSet } from './db.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { AUTH_MODES, effectiveAuthMode } from './config.js';

/** DB key holding the outstanding code's hash and its counters. */
const KEY = 'setup-code';

/** Six digits: readable off a terminal, typable on a phone. */
const DIGITS = 6;

/** How long an outstanding code stays valid. */
export const CODE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Failed attempts across ALL addresses before the code is burned.
 *
 * Twenty rather than a round hundred because a person typing a code they can
 * see gets it right in one or two tries; twenty is already generous for a
 * human and negligible against 10^6 for a script.
 */
export const MAX_GLOBAL_FAILURES = 20;

/** The stored record, or null. */
function read() {
  const value = dbGet(KEY);
  if (!value || typeof value !== 'object' || typeof value.hash !== 'string') return null;
  return value;
}

/**
 * Whether a stored record is still usable.
 *
 * Expiry and the failure cap are checked here rather than at write time
 * because nothing runs on a schedule to sweep them: the record goes stale on
 * its own, and every reader has to agree on when.
 */
function usable(record, now = Date.now()) {
  if (!record) return { ok: false, reason: 'none' };
  if (record.burned) return { ok: false, reason: 'burned' };
  if (Number(record.failures ?? 0) >= MAX_GLOBAL_FAILURES) return { ok: false, reason: 'burned' };
  if (Number(record.expiresAt ?? 0) <= now) return { ok: false, reason: 'expired' };
  return { ok: true, reason: 'ok' };
}

/** `418902` → `418 902`. Printed form only; input is accepted either way. */
export function format(code) {
  const digits = String(code).replace(/\D/g, '');
  if (digits.length !== DIGITS) return String(code);
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** Strips everything that is not a digit, so `418 902` and `418-902` both work. */
export function normalize(input) {
  return String(input ?? '').replace(/\D/g, '');
}

/**
 * True when first-run setup still has to happen.
 *
 * `none` mode is already configured — there is nothing to take over — and a
 * stored password means setup is done.
 *
 * @param {Object} config
 * @returns {boolean}
 */
export function setupPending(config) {
  if (effectiveAuthMode(config) === AUTH_MODES.NONE) return false;
  const stored = config.dashboardPasswordHash || config.dashboardPassword || '';
  return String(stored) === '';
}

/**
 * Whether a client must supply a code with a password setup right now.
 *
 * False when setup is already done, and false when no code is outstanding —
 * a dashboard started before this feature existed, or one whose code was
 * cleared, must not become impossible to set up. The code is *created* by
 * ensureCode() at startup, so in practice one is always outstanding; this stays
 * tolerant of the case where it is not rather than locking the user out.
 *
 * @param {Object} [opts]
 * @returns {boolean}
 */
export function required() {
  const record = read();
  if (!record) return false;
  // An expired or burned code still REQUIRES a code: the answer to "can I set
  // up without one" must not become yes by waiting or by guessing twenty
  // times. It requires a NEW one, which is what the message says.
  return true;
}

/**
 * What a client may be told: whether a code is needed and when it stops being
 * valid. Never the code itself.
 *
 * @param {Object} [opts]
 * @returns {{ required: boolean, expiresAt: number|null, state: string }}
 */
export function publicState({ now = Date.now() } = {}) {
  const record = read();
  if (!record) return { required: false, expiresAt: null, state: 'none' };
  const state = usable(record, now);
  return {
    required: true,
    // Null once it is no longer valid: a timestamp in the past would read as
    // "expires soon" in a UI that only compares it to the clock.
    expiresAt: state.ok ? Number(record.expiresAt) : null,
    state: state.reason,
  };
}

/**
 * Issues a new code, replacing any outstanding one.
 *
 * Returns the cleartext ONCE, to the caller that is about to print it. It is
 * never readable again from anywhere.
 *
 * @param {Object} [opts]
 * @returns {Promise<{ code: string, expiresAt: number }>}
 */
export async function issue({ now = Date.now() } = {}) {
  // randomInt, not Math.random: this is a credential.
  const code = String(randomInt(0, 10 ** DIGITS)).padStart(DIGITS, '0');
  const expiresAt = now + CODE_TTL_MS;

  dbSet(KEY, {
    hash: await hashPassword(code),
    issuedAt: now,
    expiresAt,
    failures: 0,
    burned: false,
  });

  return { code, expiresAt };
}

/**
 * Makes sure a code exists while setup is pending, and returns the cleartext
 * only when a NEW one had to be created.
 *
 * Called at dashboard startup and at daemon startup. Both run against the same
 * database, so whichever starts first creates the code and the other reports
 * that one is outstanding without being able to print it — which is correct:
 * re-printing would require storing the cleartext.
 *
 * @param {Object} opts
 * @param {Object} opts.config
 * @returns {Promise<{ pending: boolean, code: string|null, expiresAt: number|null, state: string }>}
 */
export async function ensureCode({ config, now = Date.now() } = {}) {
  if (!setupPending(config)) {
    // Nothing to protect. An outstanding code from before a password was set
    // is removed rather than left to expire.
    clear();
    return { pending: false, code: null, expiresAt: null, state: 'not-needed' };
  }

  const existing = read();
  const state = usable(existing, now);

  if (state.ok) {
    return { pending: true, code: null, expiresAt: Number(existing.expiresAt), state: 'outstanding' };
  }

  // Expired or burned: a fresh one, so a pending setup stays completable.
  const issued = await issue({ now });
  return {
    pending: true,
    code: issued.code,
    expiresAt: issued.expiresAt,
    state: existing ? `reissued-${state.reason}` : 'issued',
  };
}

/**
 * Checks a submitted code and counts the attempt.
 *
 * @param {string} input
 * @param {Object} [opts]
 * @returns {Promise<{ ok: boolean, reason: string, failures: number, burned: boolean }>}
 */
export async function verify(input, { now = Date.now() } = {}) {
  const record = read();
  const state = usable(record, now);

  if (!state.ok) {
    return {
      ok: false,
      reason: state.reason,
      failures: Number(record?.failures ?? 0),
      burned: state.reason === 'burned',
    };
  }

  const digits = normalize(input);
  if (digits.length !== DIGITS) {
    // Counted: a malformed guess is still a guess.
    return countFailure(record, 'invalid');
  }

  const matches = await verifyPassword(digits, record.hash);
  if (!matches) return countFailure(record, 'invalid');

  return { ok: true, reason: 'ok', failures: Number(record.failures ?? 0), burned: false };
}

/** Records one failure, burning the code at the cap. */
function countFailure(record, reason) {
  const failures = Number(record.failures ?? 0) + 1;
  const burned = failures >= MAX_GLOBAL_FAILURES;

  dbSet(KEY, { ...record, failures, burned });

  return { ok: false, reason: burned ? 'burned' : reason, failures, burned };
}

/** Removes the outstanding code. Called once a password is set. */
export function clear() {
  if (read() === null) return false;
  dbSet(KEY, null);
  return true;
}

/**
 * `YYYY-MM-DD HH:mm` in local time.
 *
 * Not the locale formatter: ICU emits a narrow no-break space before AM/PM in
 * recent Node versions, and these lines go to a Windows console in the legacy
 * OEM code page and to a WinSW-captured log file, where anything above ASCII
 * arrives as mojibake. Local time rather than ISO/UTC because the person
 * reading it is standing at the machine.
 */
function localStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The block printed to a terminal or a service log.
 *
 * ASCII only: this reaches a Windows console in the legacy OEM code page and a
 * WinSW-captured log file, where an em dash or an ellipsis arrives as mojibake.
 *
 * @param {Object} opts
 * @param {string|null} opts.code      Cleartext, when this process issued it
 * @param {number|null} opts.expiresAt
 * @param {string} [opts.state]
 * @returns {string[]} Lines, so the caller chooses how to write them
 */
export function describe({ code = null, expiresAt = null, state = 'issued' } = {}) {
  const lines = [];
  lines.push('');
  lines.push('  First-run setup code');
  lines.push('  ' + '-'.repeat(48));

  if (code) {
    lines.push(`  ${format(code)}`);
    lines.push('');
    lines.push('  Enter it on the dashboard\'s first-run screen together with');
    lines.push('  the password you want to set. It is required because that');
    lines.push('  screen is reachable by anything that can reach this port.');
    if (expiresAt) lines.push(`  Valid until ${localStamp(expiresAt)} (24 hours).`);
  } else if (state === 'outstanding') {
    lines.push('  A setup code is already outstanding.');
    lines.push('  It was printed when the first process started. To see a new one:');
    lines.push('    ezz dashboard setup-code');
    if (expiresAt) lines.push(`  The current one is valid until ${localStamp(expiresAt)}.`);
  } else {
    lines.push('  The setup code is no longer valid.');
    lines.push('  Issue a new one on this machine:');
    lines.push('    ezz dashboard setup-code');
  }

  lines.push('');
  return lines;
}
