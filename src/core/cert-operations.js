/**
 * core/cert-operations.js
 *
 * Certificate actions the Hub can request. Permission checking happens in
 * core/hub/agent.js before any of this runs; these functions assume they are
 * allowed and concentrate on doing the work and reporting the outcome.
 *
 * Every handler returns { ok, error, ... } so the agent can acknowledge the
 * command with command:result instead of leaving the Hub guessing.
 */

import fs from 'fs/promises';
import path from 'path';
import { loadConfig } from './config.js';
import { describeIssuance, prepareDomainForHttpChallenge } from './ssl-issuer.js';
import { bumpHubRevision } from './hubLink.js';
import { listAllCerts } from './cert-reader.js';
import { getDomains, findDomain } from './domains-db.js';

let sslManager = null;

async function getSslManager() {
  if (!sslManager) sslManager = await import('../../cli/managers/ssl-manager.js');
  return sslManager;
}

/** Shape shared by every SSL result so the Hub can render it uniformly. */
function issuanceResult(domain, result) {
  return {
    ok: Boolean(result?.success),
    domain,
    error: result?.success ? null : (result?.error?.cause ?? 'Certificate operation failed'),
    mode: result?.mode ?? null,
    fellBack: Boolean(result?.fellBack),
    nginxDownMs: result?.nginxDownMs ?? 0,
    staging: Boolean(result?.staging),
    summary: describeIssuance(result),
  };
}

/**
 * Prepares nginx to answer an HTTP-01 challenge for a domain we know about.
 * @returns {{ ok: boolean, error: string|null, regenerated: boolean }}
 */
async function prepare(domainName) {
  const record = findDomain(domainName);
  if (!record) return { ok: true, error: null, regenerated: false };

  const prep = await prepareDomainForHttpChallenge(record);
  if (prep.regenerated) console.log('[hubAgent] ssl:', prep.reason);
  return { ok: prep.ok, error: prep.error, regenerated: prep.regenerated };
}

/**
 * Handles a hub:manageSSL command.
 *
 * @param {Object} payload { action, domain?, www? }
 * @returns {Promise<Object>} { ok, error, ... }
 */
export async function handleHubSslCommand(payload) {
  const { action, domain } = payload ?? {};
  const config = loadConfig();

  switch (action) {
    // ── Renew one ─────────────────────────────────────────────────────────
    case 'renew': {
      if (!domain) return { ok: false, error: 'domain is required' };
      if (!config.acmeEmail) return { ok: false, error: 'No acmeEmail configured on this server.' };

      const prep = await prepare(domain);
      if (!prep.ok) return { ok: false, error: `Challenge setup failed: ${prep.error}` };

      const { renewCert } = await getSslManager();
      const result = await renewCert(domain, { validationMethod: 'http', email: config.acmeEmail });
      const out = issuanceResult(domain, result);
      if (out.ok) bumpHubRevision();
      console.log('[hubAgent] ssl renew:', domain, out.ok ? 'OK' : 'FAILED', '—', out.summary || out.error);
      return out;
    }

    // ── Renew everything expiring ─────────────────────────────────────────
    case 'renewAll': {
      if (!config.acmeEmail) return { ok: false, error: 'No acmeEmail configured on this server.' };

      const certs = await listAllCerts();
      const expiring = certs.filter((c) => c.daysLeft !== null && c.daysLeft < 30);
      if (expiring.length === 0) return { ok: true, renewed: [], message: 'Nothing is expiring within 30 days.' };

      const { renewCert } = await getSslManager();
      const renewed = [];

      for (const cert of expiring) {
        const prep = await prepare(cert.domain);
        if (!prep.ok) {
          renewed.push({ ok: false, domain: cert.domain, error: `Challenge setup failed: ${prep.error}` });
          continue;
        }
        const result = await renewCert(cert.domain, { validationMethod: 'http', email: config.acmeEmail });
        renewed.push(issuanceResult(cert.domain, result));
      }

      bumpHubRevision();
      const failures = renewed.filter((r) => !r.ok);
      return {
        ok: failures.length === 0,
        renewed,
        error: failures.length ? `${failures.length} of ${renewed.length} renewals failed` : null,
      };
    }

    // ── Issue a new certificate ───────────────────────────────────────────
    case 'issue': {
      if (!domain) return { ok: false, error: 'domain is required' };
      if (!config.acmeEmail) return { ok: false, error: 'No acmeEmail configured on this server.' };

      // Wildcards need a DNS TXT record the operator adds by hand, so they
      // cannot be driven from the Hub — ssl.issueDns is marked comingSoon.
      if (String(domain).startsWith('*.') || payload?.wildcard) {
        return {
          ok: false,
          error: 'Wildcard certificates need DNS-01 validation, which cannot be completed from the Hub yet. Issue it from the server’s own dashboard.',
        };
      }

      const prep = await prepare(domain);
      if (!prep.ok) return { ok: false, error: `Challenge setup failed: ${prep.error}` };

      const { issueCert } = await getSslManager();
      const result = await issueCert(domain, {
        www: Boolean(payload?.www),
        validationMethod: 'http',
        email: config.acmeEmail,
      });

      const out = issuanceResult(domain, result);
      if (out.ok) bumpHubRevision();
      console.log('[hubAgent] ssl issue:', domain, out.ok ? 'OK' : 'FAILED', '—', out.summary || out.error);
      return out;
    }

    // ── Delete a certificate ──────────────────────────────────────────────
    case 'delete': {
      if (!domain) return { ok: false, error: 'domain is required' };

      // Refuse while an enabled domain still points at it: deleting would
      // leave nginx referencing a missing file and fail its next reload.
      const inUse = getDomains().filter(
        (d) => d.enabled !== false && d.ssl?.enabled && certBelongsTo(d, domain, config.sslDir)
      );

      if (inUse.length > 0) {
        return {
          ok: false,
          error:
            `Certificate for ${domain} is still used by ${inUse.map((d) => d.name).join(', ')}. ` +
            'Disable SSL on those domains (or disable the domains) before deleting it.',
        };
      }

      const certDir = path.join(config.sslDir, domain);
      try {
        await fs.rm(certDir, { recursive: true, force: true });
      } catch (err) {
        return { ok: false, error: `Could not delete ${certDir}: ${err.message}` };
      }

      bumpHubRevision();
      console.log('[hubAgent] ssl delete:', domain, 'OK');
      return { ok: true, domain, deleted: certDir };
    }

    default:
      return { ok: false, error: `Unknown SSL action: ${action}` };
  }
}

/**
 * True when a domain's configured certificate lives in the directory for
 * `certDomain`. Compares with forward slashes so Windows paths match whichever
 * separator style they were stored with.
 */
function certBelongsTo(domain, certDomain, sslDir) {
  if (domain.name === certDomain) return true;

  const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();
  const dir = norm(path.join(sslDir, certDomain));
  return norm(domain.ssl?.certPath).startsWith(dir) || norm(domain.ssl?.keyPath).startsWith(dir);
}
