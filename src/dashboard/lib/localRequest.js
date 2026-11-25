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
 * ── Host checks and TLS termination ────────────────────────────────────────
 *
 * The dashboard listener is loopback-only because it speaks plain HTTP. A
 * request may carry a public Host/Origin through a local HTTPS reverse proxy
 * or authenticated tunnel. Those forwarded names are honoured only when all of
 * these are true:
 *
 *   - the TCP peer is loopback;
 *   - X-Forwarded-Proto is exactly https (not a comma-separated chain); and
 *   - X-Forwarded-Host contains one host, not a list.
 *
 * A direct request cannot use forwarded headers to relax the loopback rule.
 */

import net from 'node:net';

import { isLoopbackBind } from '../../core/config.js';

/** Header a legitimate dashboard client must send. */
export const REQUEST_HEADER = 'x-ez-request';
export const REQUEST_HEADER_VALUE = '1';

/** Methods that change state, and therefore need the custom header. */
const STATE_CHANGING = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Headers that prove a request came through a proxy or tunnel. */
const FORWARDING_HEADERS = Object.freeze([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

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
    if (net.isIP(hostname) !== 6) return null;
    if (rest === '') return { hostname, port: null };
    if (!/^:\d+$/.test(rest)) return null;
    return { hostname, port: rest.slice(1) };
  }

  const colon = raw.lastIndexOf(':');
  if (colon === -1) return { hostname: raw, port: null };
  // An unbracketed IPv6 address is not a valid HTTP Host value, and a trailing
  // colon does not mean "the default port".
  if (raw.indexOf(':') !== colon || colon === 0 || colon === raw.length - 1) return null;
  return { hostname: raw.slice(0, colon), port: raw.slice(colon + 1) };
}

/** True when a hostname means "this machine". */
export function isLoopbackHostname(hostname) {
  const value = String(hostname ?? '').toLowerCase();
  return value === 'localhost' || isLoopbackAddress(value);
}

/** True when a remote address is a loopback address. */
export function isLoopbackAddress(addr) {
  let address = String(addr ?? '').trim().toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);

  // Express may report IPv4-mapped IPv6.
  if (address.startsWith('::ffff:')) address = address.slice(7);

  if (net.isIP(address) === 4) return address.startsWith('127.');
  return address === '::1';
}

/** All values of one case-insensitive header from Node's rawHeaders array. */
function rawHeaderValues(rawHeaders, wanted) {
  if (!Array.isArray(rawHeaders)) return [];
  const values = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === wanted) {
      values.push(String(rawHeaders[index + 1]));
    }
  }
  return values;
}

/** Returns true when either the normalized or raw headers contain forwarding metadata. */
function hasForwardingHeaders(req) {
  const headers = req?.headers ?? {};
  if (FORWARDING_HEADERS.some((name) => headers[name] !== undefined)) return true;
  return Array.isArray(req?.rawHeaders)
    && rawHeaderValues(req.rawHeaders, 'forwarded').length > 0;
}

/**
 * True only for a direct local request.
 *
 * A loopback TCP peer can be an HTTPS reverse proxy. Such a request is still
 * local at the transport layer, but it does not prove that the browser user is
 * sitting at this machine. Passwordless mode must require both properties.
 */
export function isDirectLoopbackRequest(req) {
  const peerAddress = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress;
  return isLoopbackAddress(peerAddress) && !hasForwardingHeaders(req);
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
  // The listener itself must be loopback. Keeping this invariant here is
  // defence in depth if a future caller accidentally passes a public bind.
  const listenerLoopback = isLoopbackBind(bindAddress);
  let loopbackOnly = true;
  const peerAddress = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress;

  // A local HTTPS reverse proxy or authenticated tunnel may preserve the
  // operator's public Host/Origin while connecting to loopback. Trust those
  // two forwarded values only when the TCP peer itself is loopback and the
  // proxy says the original scheme was HTTPS. A direct remote peer cannot set
  // them because the dashboard has no non-loopback listener.
  let forwardedTls = false;
  let hostHeader = headers.host;
  const rawHostValues = rawHeaderValues(req?.rawHeaders, 'host');
  const rawProtoValues = rawHeaderValues(req?.rawHeaders, 'x-forwarded-proto');
  const rawForwardedHostValues = rawHeaderValues(req?.rawHeaders, 'x-forwarded-host');
  if (rawHostValues.length > 1 || rawProtoValues.length > 1 || rawForwardedHostValues.length > 1) {
    return {
      ok: false,
      reason: 'duplicate_forwarding_header',
      detail: 'Host and forwarded host/scheme headers may appear only once',
    };
  }
  const forwardedProto = String(headers['x-forwarded-proto'] ?? '').toLowerCase().trim();
  const forwardedHostRaw = headers['x-forwarded-host'];
  if (
    listenerLoopback
    && isLoopbackAddress(peerAddress)
    && forwardedProto === 'https'
    && typeof forwardedHostRaw === 'string'
    && forwardedHostRaw
    && !forwardedHostRaw.includes(',')
  ) {
    hostHeader = forwardedHostRaw;
    forwardedTls = true;
    loopbackOnly = false;
  }

  // ── Host ──────────────────────────────────────────────────────────────────
  const host = parseHost(hostHeader);
  if (!host) {
    return { ok: false, reason: 'host_missing', detail: 'No Host header' };
  }
  if (
    /[\s/\\@?#]/.test(host.hostname)
    || (host.port !== null && !/^\d+$/.test(host.port))
    || (host.port !== null && (Number(host.port) < 1 || Number(host.port) > 65535))
  ) {
    return { ok: false, reason: 'host_invalid', detail: 'Host is not a valid host name and port' };
  }

  // A mismatched port means the request was aimed somewhere else and arrived
  // here — exactly the shape of a rebinding attempt.
  const effectivePort = forwardedTls ? (host.port ?? '443') : port;
  if (
    !forwardedTls
    && port !== undefined
    && host.port !== String(port)
    && !(host.port === null && String(port) === '80')
  ) {
    return {
      ok: false,
      reason: 'host_port_mismatch',
      detail: `Host port ${host.port ?? '(default)'} is not the dashboard port ${port}`,
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

    const expectedProtocol = forwardedTls ? 'https:' : 'http:';
    if (origin.protocol !== expectedProtocol) {
      return {
        ok: false,
        reason: 'origin_protocol_mismatch',
        detail: `Origin protocol ${origin.protocol} is not the expected ${expectedProtocol}`,
      };
    }

    const originPort = origin.port || (origin.protocol === 'https:' ? '443' : '80');
    if (effectivePort !== undefined && String(effectivePort) !== originPort) {
      return {
        ok: false,
        reason: 'origin_port_mismatch',
        detail: `Origin port ${originPort} is not the expected port ${effectivePort}`,
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
