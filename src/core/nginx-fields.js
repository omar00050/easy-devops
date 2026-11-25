import { isIP } from 'node:net';
import { validateDomainName, validatePort, validateUpstreamType } from './validators.js';

const unsafe = /[\x00-\x1f\x7f\u0085\u2028\u2029;{}]/u;
const unsafePath = /["'#$]/;
const mime = /^(?:\*|[a-z\d!%&*+.^_~-]+\/[a-z\d!%&*+.^_~-]+)$/i;

export function nginxPathError(value, field) {
  if (value != null && (typeof value !== 'string' || unsafe.test(value) || unsafePath.test(value))) {
    return `Invalid ${field}. Use a literal path without control characters, quotes, #, $, semicolons or braces.`;
  }
  return null;
}

export function isSafeBackendHost(value) {
  if (typeof value !== 'string' || unsafe.test(value) || /[\s"'#$\\]/u.test(value)) return false;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return Boolean(parsed.hostname)
        && !parsed.username
        && !parsed.password
        && parsed.search === ''
        && parsed.hash === '';
    } catch { return false; }
  }
  return /^[a-z\d_.-]+$/i.test(value) ||
    (value.startsWith('[') && value.endsWith(']') && isIP(value.slice(1, -1)) === 6);
}

// Used on incoming partial edits before coercion and on stored records at render time.
export function nginxDomainError(domain) {
  const { name, port, backendHost, upstreamType, performance, security, ssl, advanced } = domain;
  for (const [field, group] of Object.entries({ performance, security, ssl, advanced })) {
    if (group != null && (typeof group !== 'object' || Array.isArray(group))) {
      return `Invalid ${field}. Supply an object of domain settings.`;
    }
  }
  if (name !== undefined) {
    const error = validateDomainName(name);
    if (error) return error;
  }
  if (backendHost != null && !isSafeBackendHost(backendHost)) return 'Invalid backendHost. Use a hostname, IP address or HTTP(S) URL.';
  const schemeError = validateUpstreamType(upstreamType);
  if (schemeError) return schemeError;
  // A full URL supplies its own port. Existing clients may send zero or an empty port alongside it.
  if (port != null && (!(decimal(port) || port === '') ||
      (!/^https?:\/\//i.test(backendHost ?? '') && validatePort(port)))) {
    return 'Invalid port. Use a number from 1 to 65535.';
  }
  for (const [field, value] of Object.entries({
    readTimeout: performance?.readTimeout, connectTimeout: performance?.connectTimeout,
    hstsMaxAge: ssl?.hstsMaxAge, rateLimitRate: security?.rateLimitRate, rateLimitBurst: security?.rateLimitBurst,
  })) {
    if (value != null && !decimal(value)) return `Invalid ${field}. Use a nonnegative whole number.`;
  }
  const size = performance?.maxBodySize;
  if (size != null && (typeof size !== 'string' && typeof size !== 'number' || !/^\d+[kmg]?$/i.test(size))) {
    return 'Invalid maxBodySize. Use a size such as 10m.';
  }
  const types = performance?.gzipTypes;
  if (types != null && (typeof types !== 'string' || unsafe.test(types) || (types && !types.trim().split(/ +/).every(t => mime.test(t))))) {
    return 'Invalid gzipTypes. Use space-separated MIME types.';
  }
  for (const [field, value] of Object.entries({
    www: domain.www, wildcard: domain.wildcard, behindCloudflare: domain.behindCloudflare,
    'ssl.enabled': ssl?.enabled, redirect: ssl?.redirect, hsts: ssl?.hsts,
    gzip: performance?.gzip, proxyBuffers: performance?.proxyBuffers,
    rateLimit: security?.rateLimit, securityHeaders: security?.securityHeaders,
    custom404: security?.custom404, custom50x: security?.custom50x, accessLog: advanced?.accessLog,
  })) {
    if (value != null && typeof value !== 'boolean') return `Invalid ${field}: must be true or false`;
  }
  if (advanced?.customLocations != null && typeof advanced.customLocations !== 'string') {
    return 'Invalid customLocations. Supply nginx configuration text.';
  }
  return nginxPathError(ssl?.certPath, 'certPath') || nginxPathError(ssl?.keyPath, 'keyPath');
}

function decimal(value) {
  return (typeof value === 'string' || typeof value === 'number') && /^\d+$/.test(value);
}
