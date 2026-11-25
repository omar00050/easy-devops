import { listAllCerts } from '../../core/cert-reader.js';
import { issueCert } from '../../cli/managers/ssl-manager.js';
import {
  renewCertificate,
  describeRenewal,
  describeCertificate,
  getAutoRenewSettings,
  getAutoRenewState,
  autoRenewPlan,
} from '../../core/cert-renewal.js';
import { describeIssuance, prepareDomainForHttpChallenge } from '../../core/ssl-issuer.js';
import { resolveOpId } from '../../core/ssl/progress.js';
import { publish } from '../../core/jobs/bus.js';
import { findDomain, getDomains } from '../../core/domains-db.js';
import { loadConfig } from '../../core/config.js';
import { deleteCertificate } from '../../core/cert-usage.js';
import { promises as dns } from 'dns';

// In-memory DNS challenge state
// Keyed by domain name. Entries are cleaned up when the ACME process exits
// or when cancelled. Entries older than 10 minutes are forcibly removed.
const pendingDnsChallenges = new Map();

const dnsSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [domain, state] of pendingDnsChallenges) {
    if (now - state.createdAt > 10 * 60 * 1000) {
      state.confirmDeferred.reject(new Error('DNS challenge timed out after 10 minutes'));
      pendingDnsChallenges.delete(domain);
    }
  }
}, 60000);

/**
 * Validates or generates the operation id for a request and wires the live
 * `ssl:progress` event onto the bus. The socket manager forwards it; it is
 * deliberately not cached, because a stage is a moment, not a state.
 *
 * @returns {{ opId: string, onEvent: Function } | { error: string }}
 */
function progressForRequest(req) {
  const { opId, error } = resolveOpId(req.body?.opId);
  if (error) return { error };
  return {
    opId,
    onEvent: (event) => publish('ssl:progress', event),
  };
}

/**
 * The per-check preflight results for an API body.
 *
 * `issueCertificate()` keeps them as `preflight.results`; clients render them
 * as the PreflightResult list, so a failure body must carry the checks rather
 * than only the one-line cause. A request that stopped before preflight ran
 * (missing email, wildcard over HTTP) has no array and answers `null`.
 */
export function preflightChecks(result) {
  const checks = result?.preflight?.results;
  return Array.isArray(checks) ? checks : null;
}

/**
 * Stops the DNS-challenge sweep and rejects anything still pending.
 *
 * Called by the dashboard's shutdown(): this interval is created at module
 * load and would otherwise keep the event loop alive, so `ezz --dash` would
 * never exit on Ctrl+C. Safe to call more than once.
 */
export function stopSslController() {
  clearInterval(dnsSweepTimer);

  for (const [domain, state] of pendingDnsChallenges) {
    try {
      state.confirmDeferred.reject(new Error('Dashboard is shutting down'));
    } catch { /* already settled */ }
    pendingDnsChallenges.delete(domain);
  }
}


class SslController {
  async create(req, res, next) {
    try {
      const { domain, www = false, validationMethod = 'http', email = null } = req.body ?? {};

      if (!domain || typeof domain !== 'string' || !domain.trim()) {
        return res.status(400).json({ error: 'domain is required' });
      }

      const domainKey = domain.trim();
      const progress = progressForRequest(req);
      if (progress.error) {
        return res.status(400).json({ error: 'invalid_opId', detail: progress.error });
      }
      const config = loadConfig();
      const acmeEmail = email || config.acmeEmail;

      if (validationMethod === 'dns') {
        // Two-phase flow: spawn ACME process, wait for TXT record, respond 202, pause until confirm.
        let confirmResolve, confirmReject;
        const confirmPromise = new Promise((resolve, reject) => {
          confirmResolve = resolve;
          confirmReject = reject;
        });

        let resultResolve;
        const resultPromise = new Promise((resolve) => { resultResolve = resolve; });

        // Track whether a response has already been sent (202 from onDnsChallenge)
        let responseSent = false;

        const onDnsChallenge = async (txtName, txtValue) => {
          responseSent = true;
          pendingDnsChallenges.set(domainKey, {
            domain: domainKey,
            opId: progress.opId,
            txtName,
            txtValue,
            confirmDeferred: { resolve: confirmResolve, reject: confirmReject },
            resultPromise,
            createdAt: Date.now(),
          });

          res.status(202).json({
            status: 'waiting_dns',
            opId: progress.opId,
            domain: domainKey,
            txtName,
            txtValue,
            hint: 'Add a DNS TXT record with the name and value above, then call POST /api/ssl/create-confirm',
          });

          // Pause until user calls /create-confirm (resolves) or /create-cancel (rejects)
          await confirmPromise;
        };

        // Run issueCert in the background — it will call onDnsChallenge which sends 202 and pauses.
        issueCert(domainKey, {
          www: !!www,
          validationMethod: 'dns',
          email: acmeEmail,
          onDnsChallenge,
          opId: progress.opId,
          onEvent: progress.onEvent,
        })
          .then(result => {
            resultResolve(result);
            pendingDnsChallenges.delete(domainKey);
            if (!responseSent) {
              responseSent = true;
              if (result.success) {
                return res.json({
                  success: true,
                  opId: progress.opId,
                  certPath: result.certPath,
                  keyPath: result.keyPath,
                  preflight: preflightChecks(result),
                });
              }
              const { step } = result.error ?? {};
              if (step === 'email configuration') {
                return res.status(400).json({ error: 'email_required', opId: progress.opId, preflight: preflightChecks(result), hint: 'Configure acmeEmail in settings or provide email parameter.' });
              }
              return res.status(500).json({
                success: false,
                opId: progress.opId,
                error: result.error,
                preflight: preflightChecks(result),
              });
            }
          })
          .catch(err => {
            const errResult = {
              success: false,
              certPath: null,
              keyPath: null,
              error: {
                step: 'certificate issuance',
                cause: err.message,
                consequence: 'Unexpected error during DNS certificate issuance.',
                nginxRunning: true,
                configSaved: false,
              },
            };
            resultResolve(errResult);
            pendingDnsChallenges.delete(domainKey);
            if (!responseSent) {
              responseSent = true;
              return res.status(500).json({ success: false, opId: progress.opId, error: errResult.error, preflight: null });
            }
          });

        // The response is sent either by onDnsChallenge (202) or by the .then()/.catch() above.
        return;
      }

      // HTTP validation path (synchronous — responds when complete).
      //
      // Flow 2: make sure nginx can answer the challenge first. For a domain
      // that is already configured this regenerates a stale config; for a new
      // one it writes a temporary HTTP-only config. Either way nginx is only
      // reloaded, never stopped.
      const existing = findDomain(domainKey);
      let prepared = null;
      if (existing) {
        prepared = await prepareDomainForHttpChallenge(existing);
        if (!prepared.ok) {
          return res.status(500).json({
            error: 'challenge_setup_failed',
            opId: progress.opId,
            preflight: null,
            detail: prepared.error,
            hint: 'nginx could not be prepared to answer the ACME challenge. Check the nginx config and try again.',
          });
        }
      }

      const result = await issueCert(domainKey, {
        www: !!www,
        validationMethod: 'http',
        email: acmeEmail,
        opId: progress.opId,
        onEvent: progress.onEvent,
      });

      if (result.success) {
        // Tell the UI how the challenge ran: proxy (nginx stayed up), or a
        // standalone fallback with how long nginx was stopped.
        return res.json({
          success: true,
          opId: progress.opId,
          certPath: result.certPath,
          keyPath: result.keyPath,
          mode: result.mode,
          fellBack: result.fellBack,
          nginxDownMs: result.nginxDownMs,
          staging: result.staging,
          preflight: preflightChecks(result),
          summary: describeIssuance(result),
        });
      }

      const { step } = result.error;
      if (step === 'email configuration') {
        return res.status(400).json({
          error: 'email_required',
          opId: progress.opId,
          preflight: preflightChecks(result),
          hint: 'Configure acmeEmail in settings or provide email parameter.',
        });
      }
      if (step === 'port 80 check') {
        return res.status(409).json({
          error: 'port_busy',
          opId: progress.opId,
          preflight: preflightChecks(result),
          detail: result.error.cause,
          hint: 'Stop the process using port 80 and try again.',
        });
      }
      return res.status(500).json({
        success: false,
        opId: progress.opId,
        error: result.error,
        preflight: preflightChecks(result),
      });
    } catch (error) {
      next(error);
    }
  }

  async createConfirm(req, res, next) {
    try {
      const { domain } = req.body ?? {};
      const domainKey = domain?.trim();
      const state = domainKey ? pendingDnsChallenges.get(domainKey) : null;

      if (!state) {
        return res.status(404).json({
          error: 'no_pending_challenge',
          hint: 'No DNS challenge is pending for this domain. Start a new certificate issuance.',
        });
      }

      try {
        const records = await dns.resolveTxt(`_acme-challenge.${domainKey}`);
        const flatRecords = records.flat();

        const found = flatRecords.includes(state.txtValue);
        if (!found) {
          return res.status(400).json({
            error: 'dns_not_propagated',
            hint: 'The expected TXT record value was not found. Make sure you added the correct TXT record and wait a few minutes for DNS propagation.',
            expected: state.txtValue,
            found: flatRecords,
          });
        }
      } catch (err) {
        return res.status(400).json({
          error: 'dns_lookup_failed',
          hint: 'Failed to lookup the expected TXT record. Make sure you added the correct TXT record.',
          detail: err.message,
        });
      }
      // Signal issueCert() to continue with the ACME process
      await state.confirmDeferred.resolve();

      // Wait for the ACME process to complete
      const result = await state.resultPromise;
      pendingDnsChallenges.delete(domainKey);

      if (result.success) {
        // Tell the UI how the challenge ran: proxy (nginx stayed up), or a
        // standalone fallback with how long nginx was stopped.
        return res.json({
          success: true,
          opId: state.opId ?? null,
          certPath: result.certPath,
          keyPath: result.keyPath,
          mode: result.mode,
          fellBack: result.fellBack,
          nginxDownMs: result.nginxDownMs,
          staging: result.staging,
          preflight: preflightChecks(result),
          summary: describeIssuance(result),
        });
      }
      return res.status(500).json({
        success: false,
        opId: state.opId ?? null,
        error: result.error,
        preflight: preflightChecks(result),
      });
    } catch (error) {
      next(error);
    }
  }

  async createCancel(req, res, next) {
    try {
      const { domain } = req.body ?? {};
      const domainKey = domain?.trim();
      const state = domainKey ? pendingDnsChallenges.get(domainKey) : null;

      if (!state) {
        return res.status(404).json({
          error: 'no_pending_challenge',
          hint: 'No DNS challenge is pending for this domain.',
        });
      }

      // Reject the deferred — issueCert() will return a failure result
      state.confirmDeferred.reject(new Error('cancelled by user'));
      pendingDnsChallenges.delete(domainKey);

      return res.json({ cancelled: true });
    } catch (error) {
      next(error);
    }
  }

  async list(req, res, next) {
    try {
      const certs = await listAllCerts({ includeUnusable: true });

      // Additive: what the background job intends for each certificate, so the
      // UI can show "auto-renews" / "manual renewal" instead of leaving the
      // operator to guess. Computed by the same function the job uses.
      const config = loadConfig();
      const settings = getAutoRenewSettings(config);
      const domains = getDomains();
      const state = getAutoRenewState();

      const withPlan = await Promise.all(certs.map(async (cert) => {
        let plan = 'off';
        try {
          if (cert.status !== 'not_issued' && cert.status !== 'unreadable') {
            const info = await describeCertificate(cert.domain);
            plan = autoRenewPlan({ certDomain: cert.domain, info, settings, domains, sslDir: config.sslDir });
          }
        } catch { /* unreadable certificate: report it as not handled */ }

        const last = state[cert.domain] ?? null;
        return {
          ...cert,
          autoRenew: plan,
          autoRenewDays: settings.days,
          lastAutoRenew: last
            ? {
              at: last.lastAttemptAt ?? null,
              result: last.lastResult ?? null,
              error: last.lastError ?? null,
            }
            : null,
        };
      }));

      res.json(withPlan);
    } catch (error) {
      next(error);
    }
  }

  async remove(req, res, next) {
    try {
      // core/cert-usage.js takes the directory name from listAllCerts(), never
      // from the URL, which also rules out path traversal; the Hub agent
      // deletes through the same function and refuses the same way.
      const outcome = await deleteCertificate(req.params.domain);

      if (outcome.code === 'cert_not_found') {
        return res.status(404).json({ error: `Certificate '${req.params.domain}' not found` });
      }
      if (outcome.code === 'cert_in_use') {
        return res.status(409).json({
          error: 'cert_in_use',
          directory: outcome.directory,
          usedBy: outcome.usedBy,
          references: outcome.references,
          hint:
            'At least one nginx config still points at this certificate. ' +
            'Disable SSL on those domains (or remove the lines) before deleting it.',
        });
      }
      if (outcome.code === 'cert_not_managed') {
        return res.status(409).json({
          error: 'cert_not_managed',
          detail: outcome.detail
            ?? 'This certificate was not recorded as created by Easy DevOps, so it was not deleted.',
        });
      }
      if (outcome.code === 'delete_failed') {
        return res.status(500).json({ error: 'delete_failed', detail: outcome.detail });
      }

      res.json({ deleted: outcome.domain, directory: outcome.directory });
    } catch (error) {
      next(error);
    }
  }

  async renew(req, res, next) {
    try {
      const domain = req.params.domain;
      const config = loadConfig();
      const progress = progressForRequest(req);
      if (progress.error) {
        return res.status(400).json({ error: 'invalid_opId', detail: progress.error });
      }

      if (!config.acmeEmail) {
        return res.status(400).json({
          error: 'email_required',
          opId: progress.opId,
          hint: 'Configure acmeEmail in settings first.',
        });
      }

      const certs = await listAllCerts();
      const found = certs.find(cert => cert.domain === domain);
      if (!found) {
        return res.status(404).json({ error: `Domain '${domain}' not found`, opId: progress.opId });
      }

      // renewCertificate() is the one renewal path (core/cert-renewal.js): it
      // regenerates a config that predates the ACME challenge location, keeps
      // the names the certificate already covers, and reloads nginx so the new
      // certificate is the one being served.
      const result = await renewCertificate(domain, {
        email: config.acmeEmail,
        opId: progress.opId,
        onEvent: progress.onEvent,
      });

      if (result.success) {
        // Tell the UI how the challenge ran: proxy (nginx stayed up), or a
        // standalone fallback with how long nginx was stopped.
        return res.json({
          success: true,
          opId: progress.opId,
          certPath: result.certPath,
          keyPath: result.keyPath,
          mode: result.mode,
          fellBack: result.fellBack,
          nginxDownMs: result.nginxDownMs,
          staging: result.staging,
          nginxReloaded: result.nginxReloaded,
          preflight: preflightChecks(result),
          summary: describeRenewal(result),
        });
      }

      if (result.skipped === 'manual') {
        return res.status(409).json({
          error: 'manual_renewal_required',
          opId: progress.opId,
          preflight: preflightChecks(result),
          detail: result.error.cause,
          hint: 'Create the certificate again from the SSL page using the DNS method.',
        });
      }

      const { step } = result.error;
      if (step === 'challenge setup') {
        return res.status(500).json({
          error: 'challenge_setup_failed',
          opId: progress.opId,
          preflight: preflightChecks(result),
          detail: result.error.cause,
          hint: 'nginx could not be prepared to answer the ACME challenge.',
        });
      }
      if (step === 'port 80 check') {
        return res.status(409).json({
          error: 'port_busy',
          opId: progress.opId,
          preflight: preflightChecks(result),
          detail: result.error.cause,
          hint: 'Stop the process using port 80 and try again.',
        });
      }
      return res.status(500).json({
        success: false,
        opId: progress.opId,
        error: result.error,
        preflight: preflightChecks(result),
      });
    } catch (error) {
      next(error);
    }
  }

  async renewAll(req, res, next) {
    try {
      const config = loadConfig();
      const progress = progressForRequest(req);
      if (progress.error) {
        return res.status(400).json({ error: 'invalid_opId', detail: progress.error });
      }

      if (!config.acmeEmail) {
        return res.status(400).json({
          error: 'email_required',
          opId: progress.opId,
          hint: 'Configure acmeEmail in settings first.',
        });
      }

      const certs = await listAllCerts();
      const expiring = certs.filter(c => c.daysLeft !== null && c.daysLeft < 30);
      const results = [];

      for (const cert of expiring) {
        const result = await renewCertificate(cert.domain, {
          email: config.acmeEmail,
          opId: progress.opId,
          onEvent: progress.onEvent,
        });

        if (!result.success && result.error?.step === 'challenge setup') {
          results.push({
            domain: cert.domain,
            opId: progress.opId,
            success: false,
            certPath: null,
            keyPath: null,
            error: 'challenge_setup_failed',
            detail: result.error.cause,
            preflight: preflightChecks(result),
          });
          continue;
        }

        if (result.skipped === 'manual') {
          results.push({
            domain: cert.domain,
            opId: progress.opId,
            success: false,
            certPath: null,
            keyPath: null,
            error: 'manual_renewal_required',
            detail: result.error.cause,
            preflight: preflightChecks(result),
          });
          continue;
        }

        results.push({
          domain: cert.domain,
          opId: progress.opId,
          success: result.success,
          certPath: result.certPath,
          keyPath: result.keyPath,
          mode: result.mode,
          fellBack: result.fellBack,
          nginxDownMs: result.nginxDownMs,
          configRegenerated: Boolean(result.configRegenerated),
          nginxReloaded: result.nginxReloaded,
          preflight: preflightChecks(result),
          summary: describeRenewal(result),
        });
      }

      res.json(results);
    } catch (error) {
      next(error);
    }
  }
}

export default SslController;
