/**
 * lib/validation.ts — client-side mirrors of core/validators.js.
 *
 * These exist so the user sees a problem before a save round-trip. The server
 * still validates everything; a message here never replaces its answer.
 */

export function validateDomainName(name: string): string | null {
  if (!name || !name.trim()) return 'A domain name is required.';
  const bare = name.startsWith('*.') ? name.slice(2) : name;
  const labels = bare.split('.');
  if (labels.length < 2) return 'Use at least two labels, for example example.com.';
  const labelPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
  if (labels.some((label) => !label || !labelPattern.test(label))) {
    return 'Use letters, digits and hyphens only; each label must start and end with a letter or digit.';
  }
  return null;
}

export function validatePort(port: number | string): string | null {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return 'Port must be a whole number between 1 and 65535.';
  }
  return null;
}

export function validateEmail(email: string): string | null {
  if (!email) return null;
  if (!email.includes('@') || email.trim() !== email) return 'Enter a valid email address.';
  return null;
}

export function validateMaxBodySize(size: string): string | null {
  if (!size) return null;
  if (!/^\d+[kmgKMG]?$/.test(size)) return 'Use a size like 10m, 1g or 512k.';
  return null;
}

export function validatePositiveInteger(value: number | string, field: string): string | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return `${field} must be a positive whole number.`;
  return null;
}

export function validatePassword(password: string, minLength: number): string | null {
  if (!password) return 'Enter a password.';
  if (password.length < minLength) return `Use at least ${minLength} characters.`;
  return null;
}

// ─── Hub connection string (shape only; the Hub decides validity) ────────────

const MAX_CONNECTION_STRING_LENGTH = 2048;
const SAFE_TOKEN = /^[A-Za-z0-9._~-]{1,200}$/;

function validateHubUrl(hubUrl: string): string | null {
  if (!hubUrl) return 'The Hub URL is missing.';
  if (hubUrl !== hubUrl.trim()) return 'The Hub URL must not have spaces around it.';
  if (hubUrl.includes('://') && !/^https?:\/\//i.test(hubUrl)) {
    return 'The Hub URL must use http or https.';
  }
  const candidate = /^https?:\/\//i.test(hubUrl) ? hubUrl : `https://${hubUrl}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return 'The Hub URL is not valid.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'The Hub URL must use http or https.';
  }
  if (!parsed.hostname) return 'The Hub URL is missing a host.';
  if (parsed.username || parsed.password) return 'The Hub URL must not contain credentials.';
  return null;
}

export function validateConnectionString(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Paste the connection string the Hub gave you.';
  if (trimmed.length > MAX_CONNECTION_STRING_LENGTH) return 'That connection string is too long.';
  if (!trimmed.toLowerCase().startsWith('ezops://')) {
    return 'The connection string must start with ezops://.';
  }
  const parts = trimmed.slice('ezops://'.length).split('|');
  if (parts.length !== 3) {
    return 'Expected the form ezops://hubUrl|serverId|secret.';
  }
  const [hubUrl, serverId, secret] = parts.map((part) => part.trim());
  const urlError = validateHubUrl(hubUrl);
  if (urlError) return urlError;
  if (!serverId) return 'The server ID is missing.';
  if (!secret) return 'The secret is missing.';
  if (!SAFE_TOKEN.test(serverId)) return 'The server ID has characters the Hub does not use.';
  if (!SAFE_TOKEN.test(secret)) return 'The secret has characters the Hub does not use.';
  return null;
}
