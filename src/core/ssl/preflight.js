/**
 * core/ssl/preflight.js
 *
 * Everything that can be known BEFORE a Let's Encrypt request is made.
 *
 * A failed check stops the operation here: no account is created, no order is
 * placed and no failed-validation budget is spent. The module is pure with
 * respect to I/O — DNS, HTTP, local interfaces, the challenge listener and the
 * clock are all injectable — which is what lets the e2e suite prove every
 * branch without touching the network.
 *
 * Each check returns { id, status: 'ok'|'warn'|'fail'|'skipped', message, fix }.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { promises as dnsPromises } from 'node:dns';
import { ACME_CHALLENGE_PATH } from '../nginx-conf-generator.js';

/** Cloudflare's published edge ranges. Source: https://www.cloudflare.com/ips/ (2026-11-19). */
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

/** Cloudflare's published IPv6 ranges. Same source and date as above. */
export const CLOUDFLARE_IPV6 = Object.freeze([
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]);

export const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 5000;

const cloudflare = new net.BlockList();
for (const range of CLOUDFLARE_IPV4) {
  const [base, bits] = range.split('/');
  cloudflare.addSubnet(base, Number(bits), 'ipv4');
}
for (const range of CLOUDFLARE_IPV6) {
  const [base, bits] = range.split('/');
  cloudflare.addSubnet(base, Number(bits), 'ipv6');
}

/** True when an address is in Cloudflare's published edge ranges. */
export function isCloudflareAddress(address) {
  const ip = String(address ?? '').trim();
  if (!ip) return false;
  const family = net.isIP(ip);
  if (family === 4) return cloudflare.check(ip, 'ipv4');
  if (family === 6) return cloudflare.check(ip, 'ipv6');
  return false;
}

/** Local interface addresses, including loopback, normalised for comparison. */
export function defaultLocalAddresses() {
  const found = new Set(['127.0.0.1', '::1']);
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (!entry?.address) continue;
        found.add(entry.address.split('%')[0]);
      }
    }
  } catch { /* an unreadable interface table is not fatal */ }
  return [...found];
}

function normaliseIp(value) {
  return String(value ?? '').trim().replace(/^\[|\]$/g, '').split('%')[0];
}

/** True when `address` is one of this machine's addresses. */
export function isLocalAddress(address, localAddresses = defaultLocalAddresses()) {
  const ip = normaliseIp(address);
  if (!ip) return false;
  const locals = localAddresses.map(normaliseIp);
  if (locals.includes(ip)) return true;
  // An IPv4-mapped IPv6 address still names the same local interface.
  if (ip.startsWith('::ffff:')) return locals.includes(ip.slice(7));
  return false;
}

function isMissingRecord(error) {
  return ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(error?.code);
}

function errorText(error) {
  if (!error) return '';
  return error.code ? `${error.code}: ${error.message}` : error.message;
}

/**
 * A tiny HTTP GET that never follows a redirect and never throws.
 *
 * `address` connects to a specific IP while sending `Host: <hostHeader>`,
 * which is how an AAAA record is tested without adding a second name to DNS.
 *
 * @returns {Promise<{ ok: boolean, status: number|null, body: string,
 *   headers: Object, error: string|null }>}
 */
export function defaultHttpGet(url, {
  address = null,
  hostHeader = null,
  timeoutMs = DEFAULT_HTTP_PROBE_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      resolve({ ok: false, status: null, body: '', headers: {}, error: err.message });
      return;
    }

    const secure = target.protocol === 'https:';
    const transport = secure ? https : http;
    const port = Number(target.port) || (secure ? 443 : 80);
    const host = address ? normaliseIp(address) : target.hostname;

    const req = transport.request({
      host,
      port,
      path: `${target.pathname || '/'}${target.search || ''}`,
      method: 'GET',
      headers: { Host: hostHeader || target.host },
      timeout: timeoutMs,
      // A redirect is data here, not something to follow.
      maxRedirects: 0,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      res.on('end', () => resolve({
        ok: true,
        status: res.statusCode ?? null,
        body,
        headers: res.headers ?? {},
        error: null,
      }));
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, body: '', headers: {}, error: 'timed out' });
    });
    req.on('error', (err) => resolve({
      ok: false,
      status: null,
      body: '',
      headers: {},
      error: err.code || err.message,
    }));
    req.end();
  });
}

/** Starts the loopback challenge listener for the probe token. */
async function defaultServeChallenge(challengePort, token, expected, fn) {
  const { withChallengeServer } = await import('../acme-challenge.js');
  return withChallengeServer(challengePort, async ({ setToken }) => {
    setToken(token, expected);
    return fn();
  });
}

function result(id, status, message, fix = '') {
  return { id, status, message, fix };
}

function readinessFix(name) {
  return `Check the spelling of ${name}, then add an A record pointing at this server (and an AAAA record only if this server has a working IPv6 address).`;
}

async function lookupName(name, { resolve4, resolve6, resolveAny }) {
  const settle = (fn) => Promise.resolve()
    .then(() => fn(name))
    .then((value) => ({ value: Array.isArray(value) ? value : [], error: null }))
    .catch((error) => ({ value: [], error }));

  const [a, aaaa, any] = await Promise.all([
    settle(resolve4),
    settle(resolve6),
    settle(resolveAny),
  ]);
  return { a, aaaa, any };
}

/**
 * Runs every preflight check for one certificate request.
 *
 * @param {string} domainName
 * @param {Object} [options]
 * @param {boolean} [options.www]
 * @param {'http'|'dns'} [options.validationMethod]
 * @param {'proxy'|'standalone'|'dns'} [options.mode] How the challenge will be served
 * @param {number} [options.challengePort] Loopback port of the challenge listener
 * @param {number} [options.httpPort] Public HTTP port (80, except tests)
 * @param {number} [options.httpTimeoutMs]
 * @param {Object} [options.deps] Injected collaborators (testing only)
 * @returns {Promise<{
 *   ok: boolean,
 *   results: Array<{id:string,status:string,message:string,fix:string}>,
 *   proxied: boolean,
 *   reachesUs: boolean,
 * }>}
 */
export async function runPreflight(domainName, options = {}) {
  const {
    www = false,
    validationMethod = 'http',
    mode = 'proxy',
    challengePort = 8089,
    httpPort = 80,
    httpTimeoutMs = DEFAULT_HTTP_PROBE_TIMEOUT_MS,
    deps = {},
  } = options;

  const {
    resolve4 = dnsPromises.resolve4,
    resolve6 = dnsPromises.resolve6,
    resolveAny = dnsPromises.resolveAny,
    httpGet = defaultHttpGet,
    localAddresses: localAddressesDep = defaultLocalAddresses,
    serveChallenge = defaultServeChallenge,
  } = deps;

  // The injected value may be a function (the default) or a ready array.
  const localAddresses = typeof localAddressesDep === 'function'
    ? localAddressesDep()
    : localAddressesDep;

  const name = String(domainName ?? '').trim().toLowerCase();
  const names = www && name && !name.startsWith('*.') ? [name, `www.${name}`] : [name];
  const results = [];
  let proxied = false;
  let reachesUs = false;

  const lookups = new Map();
  for (const candidate of names) {
    const lookup = candidate.startsWith('*.') ? candidate.slice(2) : candidate;
    lookups.set(candidate, await lookupName(lookup, { resolve4, resolve6, resolveAny }));
  }

  // ── a. The name resolves at all ───────────────────────────────────────────
  for (const candidate of names) {
    const { a, aaaa, any } = lookups.get(candidate);
    const noAddress = a.value.length === 0 && aaaa.value.length === 0;

    if (noAddress) {
      const allMissing = [a, aaaa, any].every((r) => r.error && isMissingRecord(r.error));
      const unexpected = [a, aaaa, any].find((r) => r.error && !isMissingRecord(r.error));
      if (allMissing) {
        results.push(result(
          `dns:${candidate}`,
          'fail',
          `${candidate} has no DNS record`,
          readinessFix(candidate),
        ));
      } else if (unexpected) {
        results.push(result(
          `dns:${candidate}`,
          'fail',
          `DNS lookup for ${candidate} failed: ${errorText(unexpected.error)}`,
          readinessFix(candidate),
        ));
      } else {
        results.push(result(
          `dns:${candidate}`,
          'fail',
          `${candidate} has DNS records but no A or AAAA address`,
          readinessFix(candidate),
        ));
      }
      continue;
    }

    results.push(result(
      `dns:${candidate}`,
      'ok',
      `${candidate} resolves to ${[...a.value, ...aaaa.value].join(', ')}`,
    ));
  }

  // ── b. Classify every address ─────────────────────────────────────────────
  for (const candidate of names) {
    const { a, aaaa } = lookups.get(candidate);

    for (const ip of a.value) {
      if (isLocalAddress(ip, localAddresses)) {
        results.push(result(
          `a:${candidate}:${ip}`, 'ok',
          `${candidate} points at this server (${ip})`,
        ));
      } else if (isCloudflareAddress(ip)) {
        proxied = true;
        results.push(result(
          `a:${candidate}:${ip}`, 'ok',
          `${candidate} is proxied by Cloudflare (${ip})`,
        ));
      } else {
        results.push(result(
          `a:${candidate}:${ip}`, 'warn',
          `${candidate} points to ${ip}, which is not this server`,
          `Point the A record at this server, or put Cloudflare in front of ${candidate}.`,
        ));
      }
    }

    for (const ip of aaaa.value) {
      if (isLocalAddress(ip, localAddresses)) {
        results.push(result(
          `aaaa:${candidate}:${ip}`, 'ok',
          `${candidate} points at this server over IPv6 (${ip})`,
        ));
      } else if (isCloudflareAddress(ip)) {
        proxied = true;
        results.push(result(
          `aaaa:${candidate}:${ip}`, 'ok',
          `${candidate} is proxied by Cloudflare over IPv6 (${ip})`,
        ));
      } else {
        // Filled in by check c once the probe has run.
        results.push(result(
          `aaaa:${candidate}:${ip}`, 'warn',
          `${candidate} has an AAAA record (${ip}) that has not been probed yet`,
          `Remove the AAAA record, or point it at this server. Let's Encrypt prefers IPv6.`,
        ));
      }
    }
  }

  // ── c/d. Port 80 and the IPv6 address, through the real public path ───────
  const httpChecks = [];
  if (validationMethod === 'dns') {
    httpChecks.push(result(
      'aaaa', 'skipped',
      'DNS-01 validation does not use port 80, so IPv6 reachability is not checked',
    ));
    httpChecks.push(result(
      'http', 'skipped',
      'DNS-01 validation does not use the HTTP challenge',
    ));
  } else if (mode === 'standalone') {
    httpChecks.push(result(
      'aaaa', 'skipped',
      'Standalone mode binds port 80 directly; the public HTTP probe runs during the challenge',
    ));
    httpChecks.push(result(
      'http', 'skipped',
      'Standalone mode binds port 80 directly; nginx is not in the path',
    ));
  } else {
    const probeToken = `easy-devops-preflight-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    const expected = `${probeToken}.preflight`;
    const challengePath = `${ACME_CHALLENGE_PATH}${probeToken}`;
    const publicResults = [];
    const aaaaReachable = new Set();

    const probe = async (candidate) => {
      // c. An AAAA that is not one of ours must actually answer on this host.
      const { aaaa } = lookups.get(candidate);
      for (const ip of aaaa.value) {
        if (isLocalAddress(ip, localAddresses) || isCloudflareAddress(ip)) continue;
        const res = await httpGet(`http://${candidate}:${httpPort}${challengePath}`, {
          address: ip,
          hostHeader: candidate,
          timeoutMs: httpTimeoutMs,
        });
        if (res.ok && res.status === 200 && res.body === expected) {
          aaaaReachable.add(`${candidate}:${ip}`);
        }
      }

      // d. The ordinary public path, exactly as Let's Encrypt will use it.
      return httpGet(`http://${candidate}:${httpPort}${challengePath}`, {
        hostHeader: candidate,
        timeoutMs: httpTimeoutMs,
      });
    };

    let responses = new Map();
    try {
      responses = await serveChallenge(challengePort, probeToken, expected, async () => {
        const out = new Map();
        for (const candidate of names) out.set(candidate, await probe(candidate));
        return out;
      });
    } catch (err) {
      httpChecks.push(result(
        'http', 'fail',
        `The challenge listener could not start: ${errorText(err)}`,
        `Stop whatever is using port ${challengePort}, or change acmeChallengePort in Settings.`,
      ));
    }

    // Rewrite the AAAA warnings that the probe resolved.
    for (let i = 0; i < results.length; i += 1) {
      const entry = results[i];
      if (!entry.id.startsWith('aaaa:') || entry.status !== 'warn') continue;
      const candidate = entry.id.split(':')[1];
      const ip = entry.id.slice(`aaaa:${candidate}:`.length);
      if (aaaaReachable.has(`${candidate}:${ip}`)) {
        results[i] = result(
          entry.id, 'ok',
          `${candidate} reaches this server over IPv6 (${ip})`,
        );
      } else {
        results[i] = result(
          entry.id, 'fail',
          `${candidate} has an AAAA record (${ip}) that does not reach this server; Let's Encrypt prefers IPv6`,
          `Remove the AAAA record for ${candidate}, or point it at this server.`,
        );
      }
    }

    for (const candidate of names) {
      const res = responses.get(candidate);
      if (!res) continue;
      const label = `http:${candidate}`;

      if (res.ok && res.status === 200 && res.body === expected) {
        reachesUs = true;
        publicResults.push(result(label, 'ok', `http://${candidate}/ answers this server on port 80`));
        continue;
      }

      if (res.ok && res.status >= 300 && res.status < 400) {
        publicResults.push(result(
          label, 'fail',
          `Cloudflare 'Always Use HTTPS' or a redirect sends Let's Encrypt to https for ${candidate}`,
          `Turn off Cloudflare 'Always Use HTTPS' (or the port-80 redirect) for ${candidate} so /.well-known/acme-challenge/ stays on HTTP.`,
        ));
        continue;
      }

      if (res.error === 'ECONNREFUSED' || res.error === 'timed out' || /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|timeout/i.test(res.error ?? '')) {
        publicResults.push(result(
          label, 'fail',
          `port 80 is closed or blocked for ${candidate}`,
          `Open port 80 in the firewall or security group and make sure nginx is running for ${candidate}.`,
        ));
        continue;
      }

      if (!res.ok) {
        publicResults.push(result(
          label, 'fail',
          `could not reach ${candidate} on port 80: ${res.error}`,
          `Check that the DNS record points at this server and that port 80 is open.`,
        ));
        continue;
      }

      publicResults.push(result(
        label, 'fail',
        `another server answers for ${candidate} (HTTP ${res.status})`,
        `Point the DNS A/AAAA record at this server, and check that nothing else is listening on port 80.`,
      ));
    }

    httpChecks.push(...publicResults);
  }

  results.push(...httpChecks);

  const ok = !results.some((entry) => entry.status === 'fail');
  return { ok, results, proxied, reachesUs };
}

/** One-line summary for a failed preflight, without exposing secrets. */
export function summarizePreflight(preflightResult) {
  if (!preflightResult) return '';
  const failed = (preflightResult.results ?? []).filter((entry) => entry.status === 'fail');
  if (failed.length === 0) return '';
  return failed.map((entry) => `${entry.message}${entry.fix ? ` — ${entry.fix}` : ''}`).join(' ');
}

/**
 * A one-line fix for the common ACME failures. Kept next to the preflight so
 * every caller reports the same next step, and so a rate limit names how long
 * to wait rather than only that it happened.
 *
 * @param {string} message
 * @param {string} [domain]
 * @returns {string}
 */
export function fixForAcmeError(message, domain = '') {
  const text = String(message ?? '');
  const target = domain || 'the domain';

  const retry = text.match(/retry[\s-]*after\s*:?\s*(\d+)/i);
  if (retry) {
    const seconds = Number(retry[1]);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const human = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    return `Let's Encrypt is rate limiting this name. Wait ${seconds}s (${human}) before trying again.`;
  }
  const retryDate = text.match(/retry[\s-]*after\s*:?\s*(\d{4}-\d\d-\d\dT[^\s,;]+)/i);
  if (retryDate) {
    const when = new Date(retryDate[1]);
    if (!Number.isNaN(when.getTime())) {
      const seconds = Math.max(1, Math.round((when.getTime() - Date.now()) / 1000));
      return `Let's Encrypt is rate limiting this name. Wait about ${seconds}s (until ${when.toISOString()}) before trying again.`;
    }
  }
  if (/too many certificates|rate.?limit|urn:ietf:params:acme:error:rateLimited/i.test(text)) {
    return "Let's Encrypt is rate limiting this name. Wait before trying again — the limit is per registered domain and per account.";
  }
  if (/NXDOMAIN|no DNS record|ENOTFOUND|ENODATA/i.test(text)) {
    return `Add an A record for ${target} pointing at this server, then try again.`;
  }
  if (/AAAA|IPv6/i.test(text)) {
    return `Remove the AAAA record for ${target}, or point it at this server. Let's Encrypt prefers IPv6.`;
  }
  if (/always use https|redirect/i.test(text)) {
    return `Turn off Cloudflare 'Always Use HTTPS' (or the port-80 redirect) for ${target}.`;
  }
  if (/ECONNREFUSED|port 80|timeout|timed out/i.test(text)) {
    return `Open port 80 in the firewall or security group and make sure nginx is running for ${target}.`;
  }
  if (/unauthorized|incorrect response|wrong server/i.test(text)) {
    return `Check that ${target} points at this server and that nothing else answers on port 80.`;
  }
  return `Check the DNS records for ${target} and that port 80 reaches this server, then try again.`;
}
