/**
 * core/passwords.js
 *
 * Password hashing for the dashboard login, built on node:crypto only — the
 * constitution forbids adding a dependency, and scrypt is in the standard
 * library precisely for this.
 *
 * Stored form:
 *
 *   scrypt$<N>$<r>$<p>$<salt base64>$<key base64>
 *
 * The parameters travel with the hash so that raising them later does not
 * invalidate existing passwords: verification reads the cost from the stored
 * string, and needsRehash() reports when a stored hash is below the current
 * defaults so the caller can upgrade it on the next successful login.
 *
 * Every comparison goes through timingSafeEqual. A plain `===` on secrets
 * leaks their contents through how long it takes to fail.
 */

import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/** Current cost parameters. N=16384 needs 128*N*r = 16 MB of memory. */
const PARAMS = Object.freeze({ N: 16_384, r: 8, p: 1 });
const KEY_LEN = 64;
const SALT_LEN = 16;
const PREFIX = 'scrypt';

/** scrypt needs its memory limit raised to match N and r. */
const MAX_MEM = 64 * 1024 * 1024;

/**
 * Minimum length for a new dashboard password.
 *
 * The single source of truth. Everything that enforces, displays or documents
 * the minimum reads it from here — the API publishes it as
 * `minPasswordLength` on GET /api/auth, and the UI uses that value rather than
 * a literal of its own, so this number only has to change in one place.
 */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * True when `stored` is one of our scrypt strings rather than a legacy
 * plain-text password.
 * @param {unknown} stored
 * @returns {boolean}
 */
export function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith(`${PREFIX}$`);
}

/**
 * Hashes a password with a fresh random salt.
 * @param {string} password
 * @returns {Promise<string>} The stored form
 */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('A password is required');
  }

  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, KEY_LEN, { ...PARAMS, maxmem: MAX_MEM });

  return [
    PREFIX,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * Verifies a password against a stored value.
 *
 * Accepts both the scrypt form and a legacy plain-text password, so an
 * existing installation keeps working until the next successful login
 * migrates it — see needsMigration().
 *
 * Never throws: a malformed stored value is a failed login, not a crash that
 * could take the dashboard down.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  if (password.length === 0 || stored.length === 0) return false;

  if (!isHashed(stored)) {
    // Legacy plain text. Compared through fixed-width digests so the
    // comparison stays constant-time even though the two strings may differ
    // in length — timingSafeEqual throws on a length mismatch.
    return timingSafeEqual(sha256(password), sha256(stored));
  }

  const parts = stored.split('$');
  if (parts.length !== 6) return false;

  const [, nRaw, rRaw, pRaw, saltB64, keyB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let expected;
  let salt;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(keyB64, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAX_MEM });
  } catch {
    // Absurd stored parameters (a corrupted record, or one written by
    // something else) must fail the login rather than throw.
    return false;
  }

  return timingSafeEqual(actual, expected);
}

/**
 * True when a stored value should be replaced by a fresh hash after a
 * successful login: either it is still plain text, or it was hashed with
 * weaker parameters than we now use.
 *
 * @param {string} stored
 * @returns {boolean}
 */
export function needsMigration(stored) {
  if (typeof stored !== 'string' || stored.length === 0) return false;
  if (!isHashed(stored)) return true;

  const [, nRaw, rRaw, pRaw] = stored.split('$');
  return Number(nRaw) < PARAMS.N || Number(rRaw) < PARAMS.r || Number(pRaw) < PARAMS.p;
}

/**
 * Validates a password a user is trying to set.
 * @param {unknown} password
 * @returns {string|null} An error message, or null when acceptable
 */
export function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return 'A password is required.';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}
