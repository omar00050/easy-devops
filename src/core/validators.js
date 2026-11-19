/**
 * core/validators.js
 *
 * Shared input validation helpers used by dashboard API routes and CLI prompts.
 * Each function returns a human-readable error string on failure, or null on success.
 */

/**
 * Validates a domain name.
 * Accepts multi-level subdomains (a.b.c.example.com) and wildcards (*.example.com).
 * The *. prefix is stripped before validation so the bare domain is checked.
 * @param {string} name
 * @returns {string|null} Error message, or null if valid
 */
export function validateDomainName(name) {
  if (!name || typeof name !== 'string') {
    return 'name is required';
  }
  // Strip *. prefix defensively — the system adds it; users should not type it
  const bare = name.startsWith('*.') ? name.slice(2) : name;
  // Each label: starts and ends with alphanumeric, hyphens allowed in middle
  const labelPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
  const labels = bare.split('.');
  if (labels.length < 2) {
    return 'Domain must have at least two labels (e.g. example.com)';
  }
  for (const label of labels) {
    if (!label) return 'Invalid domain name format: empty label';
    if (!labelPattern.test(label)) return 'Invalid domain name format';
  }
  return null;
}

/**
 * Validates that a port number is a valid TCP port (1–65535).
 * @param {number|string} port
 * @returns {string|null}
 */
export function validatePort(port) {
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return 'Invalid port: must be 1–65535';
  }
  return null;
}

/**
 * Validates an email address (basic format check).
 * An empty string is allowed — pass a non-empty email to require one.
 * @param {string} email
 * @returns {string|null}
 */
export function validateEmail(email) {
  if (email === undefined || email === null || email === '') return null;
  if (typeof email !== 'string' || !email.includes('@') || email.trim() !== email) {
    return 'Invalid email address';
  }
  return null;
}

/**
 * Validates that upstreamType is one of the accepted values.
 * @param {string} type
 * @returns {string|null}
 */
export function validateUpstreamType(type) {
  if (type && !['http', 'https', 'ws'].includes(type)) {
    return 'Invalid upstreamType: must be http, https, or ws';
  }
  return null;
}

/**
 * Validates the nginx client_max_body_size format (e.g. 10m, 1g, 512k).
 * @param {string} size
 * @returns {string|null}
 */
export function validateMaxBodySize(size) {
  if (size && !/^\d+[kmgKMG]?$/.test(size)) {
    return 'Invalid maxBodySize format (e.g., 10m, 1g)';
  }
  return null;
}

/**
 * Validates that a value is a positive integer.
 * @param {number|string} val
 * @param {string} field  Human-readable field name for the error message
 * @returns {string|null}
 */
export function validatePositiveInteger(val, field) {
  if (val !== undefined && (!Number.isInteger(Number(val)) || Number(val) < 1)) {
    return `Invalid ${field}: must be a positive integer`;
  }
  return null;
}

/**
 * Validates a strictly boolean field. `undefined`/`null` mean "not supplied"
 * and are accepted, so older clients and stored domains keep working.
 * @param {unknown} value
 * @param {string} field Human-readable field name for the error message
 * @returns {string|null}
 */
export function validateBoolean(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    return `Invalid ${field}: must be true or false`;
  }
  return null;
}

/**
 * Validates the per-domain `behindCloudflare` option.
 * @param {unknown} value
 * @returns {string|null}
 */
export function validateBehindCloudflare(value) {
  return validateBoolean(value, 'behindCloudflare');
}

/**
 * Validates the hub URL portion of a connection string.
 * Accepts an http/https URL or a bare host, optionally with a port.
 * @param {string} hubUrl
 * @returns {string|null}
 */
export function validateHubUrl(hubUrl) {
  if (!hubUrl || typeof hubUrl !== 'string') {
    return 'Hub URL is required';
  }
  if (hubUrl !== hubUrl.trim()) {
    return 'Hub URL must not have leading or trailing spaces';
  }

  // Reject any other scheme explicitly. Without this, "file://x" is silently
  // re-prefixed below and parses as the host "file", which hides the mistake.
  if (hubUrl.includes('://') && !/^https?:\/\//i.test(hubUrl)) {
    return 'Hub URL must use http or https';
  }

  // Bare hosts are allowed; the agent defaults them to https.
  const candidate = /^https?:\/\//i.test(hubUrl) ? hubUrl : `https://${hubUrl}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return 'Invalid hub URL';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Hub URL must use http or https';
  }
  if (!parsed.hostname) {
    return 'Hub URL is missing a host';
  }
  // The hub never issues credentials inside the URL; refuse to store any.
  if (parsed.username || parsed.password) {
    return 'Hub URL must not contain credentials';
  }

  return null;
}

/** Upper bound on a pasted connection string (real ones are ~150 chars). */
const MAX_CONNECTION_STRING_LENGTH = 2048;

/** serverId / secret shape: URL-safe token, no whitespace or control chars. */
const SAFE_TOKEN = /^[A-Za-z0-9._~-]{1,200}$/;

/**
 * Validates an Easy DevOps Hub connection string.
 * Expected format: ezops://<hubUrl>|<serverId>|<secret>
 *
 * Note: this only checks shape. Whether the hub recognises the serverId and
 * secret is decided by the hub during the agent handshake.
 *
 * @param {string} str
 * @returns {string|null} Error message, or null if valid
 */
export function validateConnectionString(str) {
  if (!str || typeof str !== 'string') {
    return 'Connection string is required';
  }

  const trimmed = str.trim();
  const PREFIX = 'ezops://';

  // A real string is ~150 characters. Cap it so a pasted blob is rejected
  // before it is persisted to SQLite or sent as a handshake credential.
  if (trimmed.length > MAX_CONNECTION_STRING_LENGTH) {
    return 'Connection string is too long';
  }

  if (!trimmed.toLowerCase().startsWith(PREFIX)) {
    return 'Connection string must start with ezops://';
  }

  const parts = trimmed.slice(PREFIX.length).split('|');
  if (parts.length !== 3) {
    return 'Connection string must have the form ezops://hubUrl|serverId|secret';
  }

  const [hubUrl, serverId, secret] = parts.map((part) => part.trim());

  const hubUrlError = validateHubUrl(hubUrl);
  if (hubUrlError) return hubUrlError;

  if (!serverId) return 'Connection string is missing the server ID';
  if (!secret) return 'Connection string is missing the secret';

  // Identifiers the hub mints are URL-safe tokens (cuid / uuid / hex). Reject
  // anything with whitespace or control characters rather than storing it.
  if (!SAFE_TOKEN.test(serverId)) return 'Connection string has an invalid server ID';
  if (!SAFE_TOKEN.test(secret)) return 'Connection string has an invalid secret';

  return null;
}
