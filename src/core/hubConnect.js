/**
 * core/hubConnect.js — turns what the operator typed after `ezz hub connect`
 * into a connection string, without ever printing it.
 *
 * Two inputs are accepted:
 *   - a one-time link from the Hub, https://<hub>/api/v1/connect/cli/<token>,
 *     fetched exactly once (the Hub deletes it on the first successful fetch);
 *   - a raw `ezops://…` connection string, as pasted into the dashboard.
 *
 * The link's path IS the credential, so it is treated like a password here:
 * https only (plain http only for localhost, where there is no network to
 * cross), redirects are refused rather than followed (a redirect would carry
 * the token to wherever it points), a timeout bounds the request, and no
 * message this module produces contains the token or the connection string.
 *
 * Nothing here persists anything or touches the database: the caller saves
 * the result through core/hubLink.js, which is what tells a running daemon.
 */

import { parseConnectionString } from './hubLink.js';

export const CONNECT_TIMEOUT_MS = 15_000;
/** A real answer is ~200 bytes; anything far larger is not the Hub. */
const MAX_BODY_BYTES = 16 * 1024;

const LINK_PATH = /^\/api\/v1\/connect\/cli\/([A-Za-z0-9_-]{43})$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Failure reasons the CLI turns into a sentence; stable for tests. */
export const CONNECT_ERRORS = Object.freeze({
  INVALID_INPUT: 'invalid_input',
  INSECURE: 'insecure',
  EXPIRED: 'expired',
  USED: 'used',
  REPLACED: 'replaced',
  REVOKED: 'revoked',
  UNKNOWN_LINK: 'unknown_link',
  RATE_LIMITED: 'rate_limited',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  REJECTED: 'rejected',
});

const MESSAGES = {
  invalid_input:
    'That is neither a Hub pairing link nor an ezops:// connection string. ' +
    'Copy the full `ezz hub connect …` command from the Hub\'s "From the CLI" pairing option.',
  insecure:
    'The pairing link must use https (plain http is accepted only for localhost). ' +
    'Set PUBLIC_HUB_URL on the Hub to its https address and create a new link.',
  expired: 'This pairing link has expired (links last 5 minutes). Create a new one in the Hub and run the new command.',
  used: 'This pairing link was already used. A link works once — create a new one in the Hub.',
  replaced: 'A newer pairing link was created for this server, which cancels this one. Use the newest link.',
  revoked: 'This pairing link was cancelled on the Hub (the server was deleted or its secret changed). Create a new link.',
  unknown_link: 'The Hub does not recognise this pairing link. Check it was copied completely, or create a new one.',
  rate_limited: 'Too many pairing attempts from this address. Wait a few minutes and try again.',
  unreachable: 'Could not reach the Hub. Check the server can open an https connection to it, then try again.',
  timeout: 'The Hub did not answer in time. Check the server can reach it, then try again.',
  rejected: 'The Hub refused the request. Create a new pairing link and try again.',
};

function fail(code, extra = {}) {
  return { ok: false, code, error: MESSAGES[code], ...extra };
}

/**
 * Classifies the operator's input. Never echoes it back in an error.
 *
 * @param {string} input
 * @returns {{ ok: true, kind: 'link', url: string }
 *          | { ok: true, kind: 'string', connectionString: string }
 *          | { ok: false, code: string, error: string }}
 */
export function parseConnectTarget(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return fail(CONNECT_ERRORS.INVALID_INPUT);

  if (raw.toLowerCase().startsWith('ezops://')) {
    const parsed = parseConnectionString(raw);
    // parseConnectionString's errors describe shape only, never the value.
    return parsed.ok
      ? { ok: true, kind: 'string', connectionString: raw }
      : { ok: false, code: CONNECT_ERRORS.INVALID_INPUT, error: parsed.error };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail(CONNECT_ERRORS.INVALID_INPUT);
  }
  if (url.username || url.password || url.search || url.hash) return fail(CONNECT_ERRORS.INVALID_INPUT);
  if (!LINK_PATH.test(url.pathname.replace(/\/+$/, ''))) return fail(CONNECT_ERRORS.INVALID_INPUT);

  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) return fail(CONNECT_ERRORS.INSECURE);
  } else if (url.protocol !== 'https:') {
    return fail(CONNECT_ERRORS.INVALID_INPUT);
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return { ok: true, kind: 'link', url: url.toString() };
}

/** The Hub's origin for display, e.g. "https://hub.example.com" — no token. */
export function linkOrigin(linkUrl) {
  try {
    return new URL(linkUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Fetches a one-time link once.
 *
 * @param {string} linkUrl  a URL accepted by parseConnectTarget()
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [deps]
 * @returns {Promise<{ ok: true, connectionString: string }
 *                  | { ok: false, code: string, error: string, retryAfterSeconds?: number }>}
 */
export async function fetchConnectionString(linkUrl, deps = {}) {
  const target = parseConnectTarget(linkUrl);
  if (!target.ok) return target;
  if (target.kind !== 'link') return fail(CONNECT_ERRORS.INVALID_INPUT);

  const doFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? CONNECT_TIMEOUT_MS;

  let res;
  try {
    res = await doFetch(target.url, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') return fail(CONNECT_ERRORS.TIMEOUT);
    // `fetch failed` hides the cause; neither carries the URL's token, but only
    // the error CODE is passed on, never a message that might quote the URL.
    const cause = typeof err?.cause?.code === 'string' ? err.cause.code : null;
    return fail(CONNECT_ERRORS.UNREACHABLE, cause ? { cause } : {});
  }

  if (res.status === 200) {
    let body;
    try {
      const text = await readLimited(res, MAX_BODY_BYTES);
      body = JSON.parse(text);
    } catch {
      return fail(CONNECT_ERRORS.REJECTED);
    }
    const connectionString = typeof body?.connectionString === 'string' ? body.connectionString.trim() : '';
    if (!parseConnectionString(connectionString).ok) return fail(CONNECT_ERRORS.REJECTED);
    return { ok: true, connectionString };
  }

  // Drain without reading into memory beyond the limit; the body is only a code.
  let code = null;
  try {
    const text = await readLimited(res, MAX_BODY_BYTES);
    code = JSON.parse(text)?.code ?? null;
  } catch {
    /* no usable body */
  }

  if (res.status === 410) {
    if (code === 'LINK_EXPIRED') return fail(CONNECT_ERRORS.EXPIRED);
    if (code === 'LINK_REPLACED') return fail(CONNECT_ERRORS.REPLACED);
    if (code === 'LINK_REVOKED') return fail(CONNECT_ERRORS.REVOKED);
    return fail(CONNECT_ERRORS.USED);
  }
  if (res.status === 404) return fail(CONNECT_ERRORS.UNKNOWN_LINK);
  if (res.status === 429) {
    const retry = Number(res.headers?.get?.('retry-after'));
    return fail(CONNECT_ERRORS.RATE_LIMITED, Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {});
  }
  if (res.status >= 500) return fail(CONNECT_ERRORS.UNREACHABLE, { status: res.status });
  return fail(CONNECT_ERRORS.REJECTED, { status: res.status });
}

async function readLimited(res, limit) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('response too large');
  const text = await res.text();
  if (text.length > limit) throw new Error('response too large');
  return text;
}

/**
 * Resolves the operator's input to a connection string: a raw string is used
 * as-is, a link is fetched once.
 *
 * @returns {Promise<{ ok: true, connectionString: string, source: 'link'|'string' }
 *                  | { ok: false, code: string, error: string }>}
 */
export async function resolveConnectInput(input, deps = {}) {
  const target = parseConnectTarget(input);
  if (!target.ok) return target;
  if (target.kind === 'string') return { ok: true, connectionString: target.connectionString, source: 'string' };
  const fetched = await fetchConnectionString(target.url, deps);
  return fetched.ok ? { ...fetched, source: 'link' } : fetched;
}
