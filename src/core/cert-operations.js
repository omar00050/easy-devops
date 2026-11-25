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

import path from 'path';
import { loadConfig } from './config.js';
import { describeIssuance, issueCertificate, prepareDomainForHttpChallenge } from './ssl-issuer.js';
import { renewCertificate, describeRenewal, failureReason } from './cert-renewal.js';
import { bumpHubRevision, getHubPermissions } from './hubLink.js';
import { listAllCerts } from './cert-reader.js';
import { findCertificateForDomain } from './cert-suggest.js';
import { findDomain } from './domains-db.js';
import { deleteCertificate } from './cert-usage.js';
import { validateDomainName } from './validators.js';

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
 * The failed stage, the real cause, the one-line fix and what it left
 * behind — the same four things the dashboard shows. Nothing else from the
 * internal error is passed on.
 */
function failureDetail(result) {
  const err = result?.error;
  if (!err || typeof err !== 'object') return null;
  return {
    stage: err.stage ?? err.step ?? null,
    cause: err.cause ?? 'Certificate operation failed',
    fix: err.fix ?? null,
    consequence: err.consequence ?? null,
  };
}

/**
 * A new certificate's result: the common shape, plus the preflight checks and
 * the paths on success (the Hub's domain form fills them in), or the failure
 * detail. On failure `error` is the object; the agent puts its `cause` in the
 * command's top-level error string, which is all an older Hub reads.
 */
function newCertificateResult(domain, result) {
  const out = issuanceResult(domain, result);
  out.preflight = result?.preflight
    ? {
      ok: Boolean(result.preflight.ok),
      detail: result.preflight.detail ?? '',
      results: Array.isArray(result.preflight.results) ? result.preflight.results : [],
      proxied: Boolean(result.preflight.proxied),
    }
    : null;
  if (out.ok) {
    if (getHubPermissions()['nginx.config.view'] === true) {
      out.certPath = result.certPath ?? null;
      out.keyPath = result.keyPath ?? null;
    }
  } else {
    out.error = failureDetail(result) ?? { stage: null, cause: out.error, fix: null, consequence: null };
  }
  return out;
}

/**
 * The same shape for a renewal, which additionally reports whether nginx was
 * reloaded onto the new certificate and whether the renewal was refused
 * because the certificate needs a manual DNS-01 renewal.
 */
function renewalResult(domain, result) {
  return {
    ...issuanceResult(domain, result),
    error: result?.success ? null : failureReason(result),
    summary: describeRenewal(result),
    nginxReloaded: result?.nginxReloaded ?? null,
    manual: result?.skipped === 'manual',
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
 * @param {Object} payload { action, domain?, www?, opId? }
 * @param {Object} [options]
 * @param {(step: string, status: string, detail?: string) => void} [options.onProgress]
 *   Live command progress from core/hub/agent.js. Step is the SSL stage name.
 * @returns {Promise<Object>} { ok, error, ... }
 */
export async function handleHubSslCommand(payload, options = {}) {
  const { action, domain } = payload ?? {};
  const {
    onProgress = null,
    recheck = null,
    issueFn = issueCertificate,
    suggestFn = findCertificateForDomain,
  } = options ?? {};
  const config = loadConfig();
  const authorize = () => {
    if (typeof recheck === 'function') recheck();
  };

  // Every SSL stage belongs to a name; the Hub needs that to show renewAll
  // per domain. The agent's onProgress accepts it as its fourth argument.
  const progressFor = (name) => (typeof onProgress === 'function'
    ? (step, status, detail) => onProgress(step, status, detail, name)
    : null);

  switch (action) {
    // ── Renew one ─────────────────────────────────────────────────────────
    case 'renew': {
      if (!domain) return { ok: false, error: 'domain is required' };
      if (!config.acmeEmail) return { ok: false, error: 'No acmeEmail configured on this server.' };

      // renewCertificate() keeps the names the certificate already covers
      // (a `www` certificate stays a `www` certificate), prepares the nginx
      // config, and reloads nginx afterwards.
      authorize();
      const result = await renewCertificate(domain, {
        email: config.acmeEmail,
        opId: payload?.opId,
        onProgress: progressFor(domain),
      });
      const out = renewalResult(domain, result);
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

      const renewed = [];

      for (const cert of expiring) {
        authorize();
        const result = await renewCertificate(cert.domain, {
          email: config.acmeEmail,
          opId: payload?.opId,
          onProgress: progressFor(cert.domain),
        });
        renewed.push(renewalResult(cert.domain, result));
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

      // Wildcards need a DNS TXT record the operator adds by hand, so they
      // cannot be driven from the Hub — ssl.issueDns is marked comingSoon.
      if (String(domain).startsWith('*.') || payload?.wildcard) {
        return {
          ok: false,
          error: 'Wildcard certificates need DNS-01 validation, which cannot be completed from the Hub yet. Issue it from the server’s own dashboard.',
        };
      }

      // The name becomes a directory under sslDir, so it must be a plain
      // hostname before anything is written.
      const nameError = validateDomainName(domain);
      if (nameError) return { ok: false, error: `Invalid domain name: ${nameError}` };

      if (!config.acmeEmail) {
        return { ok: false, error: 'No acmeEmail configured on this server. Set it in the server’s dashboard: Settings → General.' };
      }

      authorize();
      const prep = await prepare(domain);
      if (!prep.ok) return { ok: false, error: `Challenge setup failed: ${prep.error}` };

      authorize();
      const result = await issueFn(domain, {
        www: Boolean(payload?.www),
        validationMethod: 'http',
        email: config.acmeEmail,
        opId: payload?.opId,
        onProgress: progressFor(domain),
      });

      const out = newCertificateResult(domain, result);
      if (out.ok) bumpHubRevision();
      console.log('[hubAgent] ssl issue:', domain, out.ok ? 'OK' : 'FAILED', '—', out.summary || out.error);
      return out;
    }

    // ── Suggest an existing certificate ──────────────────────────────────
    // Read-only, like the server's own dashboard: it reports which
    // certificate could serve the domain and the paths that hold it. The Hub
    // fills them into the form and the operator still has to save.
    case 'suggest': {
      if (!domain) return { ok: false, error: 'domain is required' };
      const found = await suggestFn(domain);
      const safe = {
        ...found,
        ...(found?.certificate && typeof found.certificate === 'object'
          ? { certificate: { ...found.certificate } }
          : {}),
      };
      if (getHubPermissions()['nginx.config.view'] !== true) {
        delete safe.certPath;
        delete safe.keyPath;
        if (safe.certificate) {
          delete safe.certificate.certPath;
          delete safe.certificate.keyPath;
        }
      }
      return { ok: true, ...safe };
    }

    // ── Delete a certificate ──────────────────────────────────────────────
    // core/cert-usage.js resolves the directory from listAllCerts(), never
    // from this payload, and refuses while an enabled domain or any nginx
    // config still uses it — the same function the dashboard deletes with.
    case 'delete': {
      if (!domain) return { ok: false, error: 'domain is required' };

      authorize();
      const outcome = await deleteCertificate(domain);
      if (outcome.code === 'cert_not_found') {
        return { ok: false, code: 'cert_not_found', domain: outcome.domain, error: `No certificate named ${outcome.domain} on this server.` };
      }
      if (outcome.code === 'cert_in_use') {
        const names = outcome.usedBy.length ? outcome.usedBy.join(', ') : 'an nginx config';
        return {
          ok: false,
          code: 'cert_in_use',
          domain: outcome.domain,
          usedBy: outcome.usedBy,
          // File names and line numbers only: the Hub never receives config
          // contents or full paths.
          references: outcome.references.map((r) => ({ file: path.basename(r.file), line: r.line })),
          error:
            `Certificate for ${outcome.domain} is still used by ${names}. ` +
            'Disable SSL on those domains (or disable the domains) before deleting it.',
        };
      }
      if (outcome.code === 'cert_not_managed') {
        return {
          ok: false,
          code: 'cert_not_managed',
          domain: outcome.domain,
          error: outcome.detail
            ?? 'This certificate was not recorded as created by Easy DevOps, so it was not deleted.',
        };
      }
      if (outcome.code === 'delete_failed') {
        return { ok: false, code: 'delete_failed', domain: outcome.domain, error: outcome.detail };
      }

      bumpHubRevision();
      console.log('[hubAgent] ssl delete:', outcome.domain, 'OK');
      return { ok: true, domain: outcome.domain, deleted: true };
    }

    default:
      return { ok: false, error: `Unknown SSL action: ${action}` };
  }
}
