/**
 * core/cloudflare-ips.js
 *
 * Cloudflare's published edge ranges, in ONE refreshable file.
 *
 * These are the addresses a domain may trust as `set_real_ip_from` when it is
 * marked `behindCloudflare`. The list is data, not logic: `scripts/refresh-
 * cloudflare-ips.mjs` fetches https://www.cloudflare.com/ips-v4 and /ips-v6,
 * validates every entry, and rewrites the arrays below (never run it in tests).
 *
 * Keeping it here rather than in the generator means a refresh touches exactly
 * one file and the generator only asks whether an entry is a valid CIDR.
 */

import net from 'node:net';

/** Where the list comes from. */
export const SOURCE_URLS = Object.freeze({
  ipv4: 'https://www.cloudflare.com/ips-v4',
  ipv6: 'https://www.cloudflare.com/ips-v6',
});

/** Date the arrays below were last refreshed. Updated by the refresh script. */
export const LAST_REFRESHED = '2025-01-01';

/* BEGIN CLOUDFLARE_IPV4 */
export const CLOUDFLARE_IPV4 = Object.freeze([
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]);
/* END CLOUDFLARE_IPV4 */

/* BEGIN CLOUDFLARE_IPV6 */
export const CLOUDFLARE_IPV6 = Object.freeze([
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]);
/* END CLOUDFLARE_IPV6 */

/** IPv4 + IPv6, in that order. */
export const CLOUDFLARE_RANGES = Object.freeze([...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6]);

/**
 * True when `entry` is a syntactically valid CIDR (address + in-range prefix).
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isValidCidr(entry) {
  if (typeof entry !== 'string' || entry !== entry.trim()) return false;
  const match = /^([^\s/]+)\/(\d{1,3})$/.exec(entry);
  if (!match) return false;

  const address = match[1];
  const family = net.isIP(address);
  if (family !== 4 && family !== 6) return false;

  const prefix = Number(match[2]);
  return prefix >= 0 && prefix <= (family === 4 ? 32 : 128);
}

/**
 * Validates a whole list and, when given, that every entry has one family.
 * @param {unknown} list
 * @param {4|6} [family]
 * @returns {{ ok: boolean, invalid: string[] }}
 */
export function validateCidrList(list, family) {
  if (!Array.isArray(list)) return { ok: false, invalid: ['(not an array)'] };

  const invalid = [];
  for (const entry of list) {
    if (!isValidCidr(entry)) {
      invalid.push(String(entry));
      continue;
    }
    if (family) {
      const address = entry.slice(0, entry.indexOf('/'));
      if (net.isIP(address) !== family) invalid.push(entry);
    }
  }

  return { ok: invalid.length === 0, invalid };
}

/**
 * Throws unless both shipped lists are non-empty and entirely valid CIDRs.
 * Called by the refresh script before it writes anything, and usable by tests.
 */
export function assertShippedRanges() {
  const v4 = validateCidrList(CLOUDFLARE_IPV4, 4);
  const v6 = validateCidrList(CLOUDFLARE_IPV6, 6);
  if (!CLOUDFLARE_IPV4.length || !CLOUDFLARE_IPV6.length) {
    throw new Error('Cloudflare range list is empty');
  }
  if (!v4.ok) throw new Error(`Invalid IPv4 Cloudflare range(s): ${v4.invalid.join(', ')}`);
  if (!v6.ok) throw new Error(`Invalid IPv6 Cloudflare range(s): ${v6.invalid.join(', ')}`);
}

/**
 * Parses a fetch response body into a validated CIDR list for one family.
 * @param {string} text
 * @param {4|6} family
 * @returns {string[]}
 */
export function parseRangeText(text, family) {
  const entries = String(text ?? '')
    .split(/\s+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const { ok, invalid } = validateCidrList(entries, family);
  if (entries.length === 0) throw new Error(`No IPv${family} ranges returned`);
  if (!ok) throw new Error(`Invalid IPv${family} range(s): ${invalid.join(', ')}`);
  return entries;
}

/**
 * Fetches both published lists and validates them. No filesystem, no writes —
 * the script owns that so this can be exercised with a fake fetch.
 *
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ipv4: string[], ipv6: string[], refreshedAt: string }>}
 */
export async function fetchCloudflareRanges({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available');

  const [v4Response, v6Response] = await Promise.all([
    fetchImpl(SOURCE_URLS.ipv4),
    fetchImpl(SOURCE_URLS.ipv6),
  ]);

  for (const [label, response] of [['ips-v4', v4Response], ['ips-v6', v6Response]]) {
    if (!response.ok) {
      throw new Error(`Fetching ${label} failed: HTTP ${response.status}`);
    }
  }

  const [v4Text, v6Text] = await Promise.all([v4Response.text(), v6Response.text()]);
  const ipv4 = parseRangeText(v4Text, 4);
  const ipv6 = parseRangeText(v6Text, 6);

  return { ipv4, ipv6, refreshedAt: new Date().toISOString().slice(0, 10) };
}
