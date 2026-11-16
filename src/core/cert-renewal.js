/**
 * core/cert-renewal.js
 *
 * Certificate renewal, in one place: the manual "Renew" buttons (dashboard,
 * CLI, Hub) and the unattended job the daemon runs all go through
 * renewCertificate(), so they cannot disagree about which names a certificate
 * covers or about reloading nginx afterwards.
 *
 * Two things the old per-caller renewals got wrong, and this fixes for all of
 * them at once:
 *
 *  1. They re-issued for the bare domain only. A certificate issued with
 *     `www` came back from a renewal WITHOUT `www.example.com`, and the www
 *     site started failing certificate validation. The names are now read
 *     back from the certificate being replaced.
 *  2. In proxy mode nginx is never stopped — which is the point — but it was
 *     never reloaded either, so it kept serving the old certificate from
 *     memory until something else happened to reload it.
 *
 * ── What is renewed automatically ────────────────────────────────────────────
 *
 * Only HTTP-01 certificates. A DNS-01 certificate (every wildcard is one)
 * needs a TXT record that a person adds at their DNS provider, so there is
 * nothing a background job can do for it; those keep getting the expiry
 * warning, which says they need a manual renewal.
 *
 * ── Why unattended renewal never stops nginx ─────────────────────────────────
 *
 * `sslChallengeMode: 'auto'` may fall back to standalone mode, which stops
 * nginx for the duration of the challenge. That is acceptable when someone
 * just clicked a button and is watching; it is not acceptable at an arbitrary
 * time of night on every site the server hosts. So an unattended renewal on a
 * running nginx is pinned to proxy mode: if the local preflight fails, the
 * attempt fails, a notification says why, and nothing was taken down. An
 * operator who explicitly configured 'standalone' has chosen the downtime and
 * keeps it.
 */

import fs from 'fs/promises';
import path from 'path';
import * as acme from 'acme-client';

import { loadConfig } from './config.js';
import { dbGet, dbSet } from './db.js';
import { listAllCerts } from './cert-reader.js';
import { findDomain, getDomains } from './domains-db.js';
import { getStatus } from './nginx-service.js';
import { bumpHubRevision } from './hubLink.js';
import { createCertRenewedEvent, createCertRenewFailedEvent } from './events.js';
import {
  CERT_META_FILE,
  CHALLENGE_MODES,
  describeIssuance,
  issueCertificate,
  prepareDomainForHttpChallenge,
  reloadNginx,
} from './ssl-issuer.js';

/** Renew this many days before expiry unless the setting says otherwise. */
export const DEFAULT_AUTO_RENEW_DAYS = 7;
export const MIN_AUTO_RENEW_DAYS = 1;
/**
 * Let's Encrypt certificates live 90 days. Renewing earlier than a month out
 * buys nothing and spends issuance quota, so the setting is capped there.
 */
export const MAX_AUTO_RENEW_DAYS = 30;

/**
 * Minimum gap between two automatic attempts for the same certificate.
 *
 * The job runs every 12 hours, but it also runs once at every daemon start —
 * so without a persisted gap, a crash-looping service would retry a failing
 * domain on every restart and walk straight into Let's Encrypt's
 * failed-validation limit (5 per hostname per hour). Six hours keeps the
 * normal 12-hour cadence intact while making a restart loop harmless.
 */
export const RENEW_RETRY_MS = 6 * 60 * 60 * 1000;

const STATE_KEY = 'sslAutoRenewState';

// ─── Settings ─────────────────────────────────────────────────────────────────

/**
 * Validates a "days before expiry" value.
 * @param {*} value
 * @returns {number|null} The integer, or null when it is not acceptable
 */
export function normalizeAutoRenewDays(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  if (n < MIN_AUTO_RENEW_DAYS || n > MAX_AUTO_RENEW_DAYS) return null;
  return n;
}

/**
 * The auto-renew settings actually in force.
 *
 * An install that predates the setting has neither key stored; loadConfig()
 * merges the defaults in, so it reads as enabled at 7 days. A stored value
 * that is not usable (hand-edited database) falls back to the default rather
 * than disabling renewal silently.
 *
 * @param {Object} [config]
 * @returns {{ enabled: boolean, days: number }}
 */
export function getAutoRenewSettings(config = loadConfig()) {
  return {
    enabled: config?.sslAutoRenew !== false,
    days: normalizeAutoRenewDays(config?.sslAutoRenewDays) ?? DEFAULT_AUTO_RENEW_DAYS,
  };
}

// ─── What a certificate covers, and how it was validated ──────────────────────

/**
 * Describes an existing certificate well enough to renew it faithfully.
 *
 * The names come from the certificate itself whenever it can be parsed — that
 * is the ground truth for what is being replaced. The validation method comes
 * from the metadata file written at issuance; without one, a wildcard is
 * necessarily DNS-01 and anything else is assumed to be HTTP-01, which is what
 * every certificate issued before the metadata existed was unless it was a
 * wildcard or the operator deliberately picked DNS.
 *
 * @param {string} domainName The certificate's directory name
 * @param {Object} [opts]
 * @param {string} [opts.sslDir]
 * @returns {Promise<{
 *   names: string[], www: boolean, wildcard: boolean,
 *   validationMethod: 'http'|'dns', source: 'certificate'|'meta'|'unknown'
 * }>}
 */
export async function describeCertificate(domainName, { sslDir } = {}) {
  const dir = path.join(sslDir ?? loadConfig().sslDir, domainName);

  let meta = null;
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, CERT_META_FILE), 'utf8'));
  } catch { /* absent or unreadable: fall back to the certificate */ }

  let names = null;
  let source = 'unknown';
  try {
    const pem = await fs.readFile(path.join(dir, 'fullchain.pem'));
    const info = acme.crypto.readCertificateInfo(pem);
    const found = [info?.domains?.commonName, ...(info?.domains?.altNames ?? [])]
      .filter((n) => typeof n === 'string' && n.length > 0);
    if (found.length > 0) {
      names = [...new Set(found)];
      source = 'certificate';
    }
  } catch { /* not parseable: fall back to the metadata */ }

  if (!names && Array.isArray(meta?.altNames) && meta.altNames.length > 0) {
    names = meta.altNames.filter((n) => typeof n === 'string' && n.length > 0);
    source = 'meta';
  }
  if (!names || names.length === 0) names = [domainName];

  const wildcard = names.some((n) => n.startsWith('*.'));
  const www = names.includes(`www.${domainName}`);
  const validationMethod = wildcard || meta?.validationMethod === 'dns' ? 'dns' : 'http';

  return { names, www, wildcard, validationMethod, source };
}

/**
 * True when an enabled domain actually serves this certificate.
 *
 * The certificate directory routinely holds leftovers — a site that moved
 * away, a certificate issued by hand to try something. Their DNS often no
 * longer points here, so renewing them would fail every time and spend
 * Let's Encrypt's failed-validation budget on certificates nobody uses.
 *
 * @param {string} certDomain
 * @param {Array<Object>} domains
 * @param {string} sslDir
 * @returns {boolean}
 */
export function isCertInUse(certDomain, domains, sslDir) {
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();
  const dir = `${norm(path.join(sslDir, certDomain))}/`;

  return (domains ?? []).some((d) => {
    if (d?.enabled === false || !d?.ssl?.enabled) return false;
    if (d.name === certDomain) return true;
    return norm(d.ssl?.certPath).startsWith(dir) || norm(d.ssl?.keyPath).startsWith(dir);
  });
}

// ─── Renewing one certificate ─────────────────────────────────────────────────

/** Plain-text reason out of an issueCertificate() / renewCertificate() result. */
export function failureReason(result) {
  const cause = result?.error?.cause ?? result?.error ?? 'Certificate renewal failed';
  // The cause can be a multi-paragraph hint; a notification wants its headline.
  return String(cause).split('\n')[0].trim();
}

/**
 * Renews one certificate, keeping the names it already covers, and reloads
 * nginx when nginx was left running so the new certificate is actually served.
 *
 * Returns issueCertificate()'s result with three additions:
 *   - `info`           what describeCertificate() found
 *   - `skipped`        'manual' when the certificate needs DNS-01 (nothing was attempted)
 *   - `nginxReloaded`  true/false after a proxy-mode renewal, null otherwise
 *
 * @param {string} domainName
 * @param {Object} [options]
 * @param {string|null} [options.email]
 * @param {'auto'|'proxy'|'standalone'} [options.mode] Explicit challenge mode
 * @param {boolean} [options.unattended] Never stop a running nginx (see header)
 * @param {Object} [options.deps] Injected collaborators (testing only)
 * @returns {Promise<Object>}
 */
export async function renewCertificate(domainName, options = {}) {
  const { email = null, mode = null, unattended = false, deps = {} } = options;
  const {
    issue = issueCertificate,
    prepare = prepareDomainForHttpChallenge,
    reload = reloadNginx,
    nginxStatus = getStatus,
    describe = describeCertificate,
    lookupDomain = findDomain,
  } = deps;

  const config = loadConfig();
  const info = await describe(domainName);

  const base = {
    success: false, certPath: null, keyPath: null, mode: null, fellBack: false,
    nginxDownMs: 0, staging: false, preflight: null, configRegenerated: false,
    error: null, info, skipped: null, nginxReloaded: null,
  };

  if (info.validationMethod === 'dns') {
    return {
      ...base,
      skipped: 'manual',
      mode: 'dns-01',
      error: {
        step: 'validation method',
        cause: info.wildcard
          ? `${domainName} is a wildcard certificate, which needs DNS-01 validation and a TXT record added by hand.`
          : `${domainName} was validated over DNS-01, which needs a TXT record added by hand.`,
        consequence: 'No certificate was requested. Renew it from the SSL page with the DNS method.',
        nginxRunning: true,
        configSaved: false,
      },
    };
  }

  // A config written before the challenge location existed cannot answer the
  // challenge in proxy mode. Regenerating it is a reload, never a stop.
  const record = lookupDomain(domainName);
  let prepared = null;
  if (record) {
    prepared = await prepare(record);
    if (!prepared.ok) {
      return {
        ...base,
        error: {
          step: 'challenge setup',
          cause: prepared.error ?? 'nginx could not be prepared to answer the ACME challenge.',
          consequence: 'No certificate was requested.',
          nginxRunning: true,
          configSaved: false,
        },
      };
    }
  }

  let chosenMode = mode;
  if (!chosenMode && unattended) {
    const requested = config.sslChallengeMode || CHALLENGE_MODES.AUTO;
    if (requested === CHALLENGE_MODES.AUTO) {
      let running = false;
      try { running = Boolean((await nginxStatus())?.running); } catch { running = false; }
      // nginx up: proxy only, so nothing can stop it. nginx down: leave 'auto',
      // whose standalone path then has nothing to stop.
      if (running) chosenMode = CHALLENGE_MODES.PROXY;
    }
  }

  const result = await issue(domainName, {
    www: info.www,
    validationMethod: 'http',
    email: email || config.acmeEmail,
    ...(chosenMode ? { mode: chosenMode } : {}),
  });

  // Standalone mode restarts nginx itself, which loads the new certificate.
  // Proxy mode leaves it running with the old one in memory.
  let nginxReloaded = null;
  let reloadDetail = null;
  if (result?.success && result.mode === CHALLENGE_MODES.PROXY) {
    try {
      const reloaded = await reload();
      nginxReloaded = Boolean(reloaded?.ok);
      if (!nginxReloaded) reloadDetail = reloaded?.output ?? null;
    } catch (err) {
      nginxReloaded = false;
      reloadDetail = err.message;
    }
  }

  return {
    ...base,
    ...result,
    info,
    skipped: null,
    configRegenerated: Boolean(result?.configRegenerated || prepared?.regenerated),
    nginxReloaded,
    reloadDetail,
  };
}

/**
 * describeIssuance() plus the reload outcome, for callers reporting a renewal.
 * @param {Object} result Value returned by renewCertificate()
 * @returns {string}
 */
export function describeRenewal(result) {
  const parts = [describeIssuance(result)].filter(Boolean);
  if (result?.nginxReloaded === true) parts.push('nginx reloaded');
  if (result?.nginxReloaded === false) {
    parts.push('nginx reload FAILED — it is still serving the old certificate until it is reloaded');
  }
  return parts.join(' · ');
}

// ─── The unattended job ───────────────────────────────────────────────────────

/** Per-certificate bookkeeping: `{ [domain]: { lastAttemptAt, lastResult, ... } }`. */
export function getAutoRenewState() {
  const state = dbGet(STATE_KEY);
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

function saveAutoRenewState(state) {
  dbSet(STATE_KEY, state);
}

/**
 * What the auto-renew job would do with one certificate right now, without
 * doing it. Shared by the job and by the API that shows the plan in the UI, so
 * the badge on the SSL page cannot promise something the job will not do.
 *
 * @returns {'auto'|'manual'|'unused'|'off'}
 *   auto   — will be renewed in the background
 *   manual — DNS-01 / wildcard: warning only
 *   unused — no enabled domain serves it, so it is left alone
 *   off    — auto-renewal is switched off
 */
export function autoRenewPlan({ certDomain, info, settings, domains, sslDir }) {
  if (!settings.enabled) return 'off';
  if (info.validationMethod === 'dns') return 'manual';
  if (!isCertInUse(certDomain, domains, sslDir)) return 'unused';
  return 'auto';
}

/**
 * One pass of automatic renewal.
 *
 * Runs in whichever process owns the background jobs (core/jobs/index.js
 * elects exactly one), so two processes never renew the same certificate.
 *
 * @param {Object} [opts]
 * @param {number} [opts.now]
 * @param {(event: Object, domain: string) => (void|Promise<void>)} [opts.onEvent]
 *   Receives the renewed / failed notification events. The caller decides
 *   where they go; this module knows nothing about buses or channels.
 * @param {Object} [opts.deps] Injected collaborators (testing only)
 * @returns {Promise<{
 *   enabled: boolean, days: number,
 *   results: Array<{ domain: string, action: 'renewed'|'failed'|'manual'|'skipped', reason: string }>
 * }>}
 */
export async function runAutoRenewal({ now = Date.now(), onEvent = null, deps = {} } = {}) {
  const {
    listCerts = listAllCerts,
    renew = renewCertificate,
    describe = describeCertificate,
    listDomains = getDomains,
    bumpRevision = bumpHubRevision,
  } = deps;

  const config = loadConfig();
  const settings = getAutoRenewSettings(config);
  const out = { enabled: settings.enabled, days: settings.days, results: [] };
  if (!settings.enabled) return out;

  let certs;
  try {
    certs = await listCerts();
  } catch {
    // A missing or unreadable certificate directory is normal on a fresh install.
    return out;
  }

  const state = getAutoRenewState();
  let stateDirty = false;

  // Forget certificates that no longer exist, so the record cannot grow for ever.
  const present = new Set(certs.map((c) => c.domain));
  for (const name of Object.keys(state)) {
    if (!present.has(name)) { delete state[name]; stateDirty = true; }
  }

  const emit = async (event, domain) => {
    if (!onEvent) return;
    try { await onEvent(event, domain); } catch (err) {
      console.error('[cert-renewal] notification failed:', err.message);
    }
  };

  const domains = listDomains();
  let renewedAny = false;

  for (const cert of certs) {
    if (cert.daysLeft === null || cert.daysLeft > settings.days) continue;

    const info = await describe(cert.domain);
    const plan = autoRenewPlan({
      certDomain: cert.domain, info, settings, domains, sslDir: config.sslDir,
    });

    if (plan === 'manual') {
      out.results.push({ domain: cert.domain, action: 'manual', reason: 'DNS-01 certificate — needs a manual renewal' });
      continue;
    }
    if (plan === 'unused') {
      out.results.push({ domain: cert.domain, action: 'skipped', reason: 'no enabled domain uses this certificate' });
      continue;
    }

    const previous = state[cert.domain] ?? {};
    if (previous.lastAttemptAt && now - previous.lastAttemptAt < RENEW_RETRY_MS) {
      out.results.push({ domain: cert.domain, action: 'skipped', reason: 'attempted recently — waiting before retrying' });
      continue;
    }

    // Recorded BEFORE the attempt and written straight away: if this process
    // dies mid-issuance, the next start must still see that an attempt was made.
    state[cert.domain] = { ...previous, lastAttemptAt: now };
    saveAutoRenewState(state);
    stateDirty = false;

    let result;
    if (!config.acmeEmail) {
      result = { success: false, error: { cause: 'No ACME email is configured. Set it in Settings.' } };
    } else {
      try {
        result = await renew(cert.domain, { email: config.acmeEmail, unattended: true });
      } catch (err) {
        result = { success: false, error: { cause: err.message } };
      }
    }

    if (result?.success) {
      const summary = describeRenewal(result);
      state[cert.domain] = {
        lastAttemptAt: now, lastResult: 'renewed', lastRenewedAt: now, lastError: null, failures: 0,
      };
      renewedAny = true;
      out.results.push({ domain: cert.domain, action: 'renewed', reason: summary });
      console.log(`[cert-renewal] ${cert.domain}: renewed — ${summary}`);
      await emit(createCertRenewedEvent(cert.domain, summary), cert.domain);
    } else {
      const reason = failureReason(result);
      state[cert.domain] = {
        ...previous,
        lastAttemptAt: now,
        lastResult: 'failed',
        lastError: reason,
        failures: (previous.failures ?? 0) + 1,
      };
      out.results.push({ domain: cert.domain, action: 'failed', reason });
      console.error(`[cert-renewal] ${cert.domain}: renewal failed — ${reason}`);
      await emit(createCertRenewFailedEvent(cert.domain, cert.daysLeft, reason), cert.domain);
    }
    stateDirty = true;
  }

  if (stateDirty) saveAutoRenewState(state);

  // A linked Hub shows certificate expiry; tell the agent it changed.
  if (renewedAny) {
    try { bumpRevision(); } catch { /* not linked, or nothing to bump */ }
  }

  return out;
}
