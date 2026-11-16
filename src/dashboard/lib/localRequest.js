/**
 * dashboard/lib/localRequest.js
 *
 * Defends the dashboard against *other websites* in the same browser.
 *
 * A session cookie, or no login at all, protects nothing from a page the user
 * happens to have open in another tab. Two attacks matter here:
 *
 *   DNS rebinding — a hostile domain resolves to 127.0.0.1, so the browser
 *     sends the request to the dashboard with the attacker's hostname in the
 *     Host header. Checking Host defeats it: the dashboard only answers to
 *     names that mean "this machine".
 *
 *   Cross-site request forgery — a hostile page submits a form or fires a
 *     fetch at the dashboard, and the browser attaches the session cookie.
 *     Checking Origin defeats the fetch case; requiring a custom header
 *     defeats the rest, because a cross-site form POST cannot set one and a
 *     cross-site fetch that tries triggers a CORS preflight the dashboard
 *     never approves.
 *
 * Both apply in BOTH auth modes. They are not a substitute for a password —
 * they stop a different attacker, one the password never protected against.
 *
 * ── On the Host check and non-loopback binds ───────────────────────────────
 *
 * When the dashboard is bound to loopback, Host must be a loopback name. That
 * covers every `dashboardAuth: 'none'` install by construction, since that
 * mode requires a loopback bind.
 *
 * When the user has deliberately bound to every interface to reach the
 * dashboard from another machine, demanding Host=localhost would make the
 * dashboard unreachable — so there the rule becomes same-origin instead:
 * Origin, when present, must match the Host the request arrived on. That
 * keeps the anti-CSRF guarantee without breaking the feature.
 */

import { isLoopbackBind } from '../../core/config.js';

/** Header a legitimate dashboard client must send. */
export const REQUEST_HEADER = 'x-ez-request';
export const REQUEST_HEADER_VALUE = '1';

/** Hostnames that mean "this machine". */
const LOOPBACK_HOSTNAMES = Object.freeze(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Methods that change state, and therefore need the custom header. */
const STATE_CHANGING = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Splits a Host header into hostname and port.
 *
 * Handles the bracketed IPv6 form (`[::1]:6443`), where splitting on the last
 * colon would otherwise cut the address in half.
 *
 * @param {string} hostHeader
 * @returns {{ hostname: string, port: string|null }|null}
 */
export function parseHost(hostHeader) {
  const raw = String(hostHeader ?? '').trim();
  if (!raw) return null;

  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close === -1) return null;
    const hostname = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    const port = rest.startsWith(':') ? rest.slice(1) : null;
    return { hostname, port: port || null };
  }

  const colon = raw.lastIndexOf(':');
  if (colon === -1) return { hostname: raw, port: null };
  return { hostname: raw.slice(0, colon), port: raw.slice(colon + 1) || null };
}

/** True when a hostname means "this machine". */
export function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.includes(String(hostname ?? '').toLowerCase());
}

/** True when a remote address is a loopback address. */
export function isLoopbackAddress(addr) {
  const a = String(addr ?? '');
  // Express reports IPv4-mapped IPv6 as ::ffff:127.0.0.1.
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' ||
    a.startsWith('127.');
}

/**
 * Checks one request's Host, Origin and custom header.
 *
 * @param {Object} req            Anything with { method, headers }
 * @param {Object} opts
 * @param {number} opts.port      The port the dashboard is listening on
 * @param {string} opts.bindAddress
 * @param {boolean} [opts.requireHeader] Override the method-based decision
 * @returns {{ ok: boolean, reason: string|null, detail: string|null }}
 */
export function checkLocalRequest(req, { port, bindAddress, requireHeader } = {}) {
  const headers = req?.headers ?? {};
  const method = String(req?.method ?? 'GET').toUpperCase();
  const loopbackOnly = isLoopbackBind(bindAddress);

  // ── Host ──────────────────────────────────────────────────────────────────
  const host = parseHost(headers.host);
  if (!host) {
    return { ok: false, reason: 'host_missing', detail: 'No Host header' };
  }

  // A mismatched port means the request was aimed somewhere else and arrived
  // here — exactly the shape of a rebinding attempt.
  if (host.port !== null && port !== undefined && String(port) !== host.port) {
    return {
      ok: false,
      reason: 'host_port_mismatch',
      detail: `Host port ${host.port} is not the dashboard port ${port}`,
    };
  }

  if (loopbackOnly && !isLoopbackHostname(host.hostname)) {
    return {
      ok: false,
      reason: 'host_not_local',
      detail: `Host '${host.hostname}' is not a loopback name, and this dashboard is bound to ${bindAddress}`,
    };
  }

  // ── Origin ────────────────────────────────────────────────────────────────
  // Absent on same-origin navigations and simple GETs; present on anything a
  // script sends cross-site, which is the case worth refusing.
  const originHeader = headers.origin;
  if (originHeader && originHeader !== 'null') {
    let origin;
    try {
      origin = new URL(originHeader);
    } catch {
      return { ok: false, reason: 'origin_malformed', detail: `Origin '${originHeader}' is not a URL` };
    }

    const originPort = origin.port || (origin.protocol === 'https:' ? '443' : '80');
    if (port !== undefined && String(port) !== originPort) {
      return {
        ok: false,
        reason: 'origin_port_mismatch',
        detail: `Origin port ${originPort} is not the dashboard port ${port}`,
      };
    }

    if (loopbackOnly) {
      if (!isLoopbackHostname(origin.hostname)) {
        return {
          ok: false,
          reason: 'origin_not_local',
          detail: `Origin '${origin.hostname}' is not a loopback name`,
        };
      }
    } else if (origin.hostname.toLowerCase() !== host.hostname.toLowerCase()) {
      // Non-loopback bind: same-origin instead of loopback-only, so remote
      // access keeps working while cross-site requests still do not.
      return {
        ok: false,
        reason: 'origin_cross_site',
        detail: `Origin '${origin.hostname}' does not match Host '${host.hostname}'`,
      };
    }
  }

  // ── Custom header ─────────────────────────────────────────────────────────
  const needsHeader = requireHeader ?? STATE_CHANGING.includes(method);
  if (needsHeader && headers[REQUEST_HEADER] !== REQUEST_HEADER_VALUE) {
    return {
      ok: false,
      reason: 'missing_request_header',
      detail: `${method} requests must send ${REQUEST_HEADER}: ${REQUEST_HEADER_VALUE}`,
    };
  }

  return { ok: true, reason: null, detail: null };
}

/**
 * Express middleware factory.
 *
 * The port and bind address are read per request rather than captured, so a
 * settings change does not leave a stale rule behind until restart.
 *
 * @param {() => { port: number, bindAddress: string }} getBinding
 */
export function requireLocalRequest(getBinding) {
  return function localRequestGuard(req, res, next) {
    const { port, bindAddress } = getBinding();
    const verdict = checkLocalRequest(req, { port, bindAddress });

    if (verdict.ok) return next();

    // 403, not 401: this is not "log in", it is "this request may not be made
    // from where it came from". A 401 would send the UI to the login screen
    // for a problem a login cannot fix.
    return res.status(403).json({
      error: 'Forbidden',
      reason: verdict.reason,
      detail: verdict.detail,
    });
  };
}

/**
 * Socket.io middleware factory.
 *
 * The handshake is held to the same rules, with the custom header required
 * unconditionally — there is no "safe method" for opening a socket.
 *
 * Browsers cannot set headers on a WebSocket upgrade, which is why the client
 * must not force `transports: ['websocket']`: socket.io's default starts with
 * HTTP polling, where extraHeaders does apply, and the handshake is
 * authenticated there before any upgrade.
 *
 * @param {() => { port: number, bindAddress: string }} getBinding
 */
export function socketRequireLocalRequest(getBinding) {
  return function socketLocalGuard(socket, next) {
    const { port, bindAddress } = getBinding();
    const verdict = checkLocalRequest(socket.request, {
      port,
      bindAddress,
      requireHeader: true,
    });

    if (verdict.ok) return next();

    const err = new Error('FORBIDDEN');
    err.data = { reason: verdict.reason, detail: verdict.detail };
    return next(err);
  };
}
