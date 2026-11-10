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

  return null;
}

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

  return null;
}
