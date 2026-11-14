import { listAllCerts } from '../../core/cert-reader.js';
import { issueCert, renewCert } from '../../cli/managers/ssl-manager.js';
import { describeIssuance, prepareDomainForHttpChallenge } from '../../core/ssl-issuer.js';
import { findDomain } from '../../core/domains-db.js';
import { loadConfig } from '../../core/config.js';
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
            txtName,
            txtValue,
            confirmDeferred: { resolve: confirmResolve, reject: confirmReject },
            resultPromise,
            createdAt: Date.now(),
          });

          res.status(202).json({
            status: 'waiting_dns',
            domain: domainKey,
            txtName,
            txtValue,
            hint: 'Add a DNS TXT record with the name and value above, then call POST /api/ssl/create-confirm',
          });

          // Pause until user calls /create-confirm (resolves) or /create-cancel (rejects)
          await confirmPromise;
        };

        // Run issueCert in the background — it will call onDnsChallenge which sends 202 and pauses.
        issueCert(domainKey, { www: !!www, validationMethod: 'dns', email: acmeEmail, onDnsChallenge })
          .then(result => {
            resultResolve(result);
            pendingDnsChallenges.delete(domainKey);
            if (!responseSent) {
              responseSent = true;
              if (result.success) {
                return res.json({ success: true, certPath: result.certPath, keyPath: result.keyPath });
              }
              const { step } = result.error ?? {};
              if (step === 'email configuration') {
                return res.status(400).json({ error: 'email_required', hint: 'Configure acmeEmail in settings or provide email parameter.' });
              }
              return res.status(500).json({ success: false, error: result.error });
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
              return res.status(500).json({ success: false, error: errResult.error });
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
            detail: prepared.error,
            hint: 'nginx could not be prepared to answer the ACME challenge. Check the nginx config and try again.',
          });
        }
      }

      const result = await issueCert(domainKey, { www: !!www, validationMethod: 'http', email: acmeEmail });

      if (result.success) {
        // Tell the UI how the challenge ran: proxy (nginx stayed up), or a
        // standalone fallback with how long nginx was stopped.
        return res.json({
          success: true,
          certPath: result.certPath,
          keyPath: result.keyPath,
          mode: result.mode,
          fellBack: result.fellBack,
          nginxDownMs: result.nginxDownMs,
          staging: result.staging,
          summary: describeIssuance(result),
        });
      }

      const { step } = result.error;
      if (step === 'email configuration') {
        return res.status(400).json({
          error: 'email_required',
          hint: 'Configure acmeEmail in settings or provide email parameter.',
        });
      }
      if (step === 'port 80 check') {
        return res.status(409).json({
          error: 'port_busy',
          detail: result.error.cause,
          hint: 'Stop the process using port 80 and try again.',
        });
      }
      return res.status(500).json({ success: false, error: result.error });
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
          certPath: result.certPath,
          keyPath: result.keyPath,
          mode: result.mode,
          fellBack: result.fellBack,
          nginxDownMs: result.nginxDownMs,
          staging: result.staging,
          summary: describeIssuance(result),
        });
      }
      return res.status(500).json({ success: false, error: result.error });
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
      const certs = await listAllCerts();
      res.json(certs);
    } catch (error) {
      next(error);
    }
  }

  async renew(req, res, next) {
    try {
      const domain = req.params.domain;
      const config = loadConfig();

      if (!config.acmeEmail) {
        return res.status(400).json({
          error: 'email_required',
          hint: 'Configure acmeEmail in settings first.',
        });
      }

      const certs = await listAllCerts();
      const found = certs.find(cert => cert.domain === domain);
      if (!found) {
        return res.status(404).json({ error: `Domain '${domain}' not found` });
      }

      // Flow 1: a config generated before the ACME challenge location existed
      // cannot answer the challenge. Regenerate it (reload only) and say so.
      const domainRecord = findDomain(domain);
      let prepared = null;
      if (domainRecord) {
        prepared = await prepareDomainForHttpChallenge(domainRecord);
        if (!prepared.ok) {
          return res.status(500).json({
            error: 'challenge_setup_failed',
            detail: prepared.error,
            hint: 'nginx could not be prepared to answer the ACME challenge.',
          });
        }
      }

      const result = await renewCert(domain, { validationMethod: 'http', email: config.acmeEmail });

      if (result.success) {
        // Tell the UI how the challenge ran: proxy (nginx stayed up), or a
        // standalone fallback with how long nginx was stopped.
        return res.json({
          success: true,
          certPath: result.certPath,
          keyPath: result.keyPath,
          mode: result.mode,
          fellBack: result.fellBack,
          nginxDownMs: result.nginxDownMs,
          staging: result.staging,
          summary: describeIssuance(result),
        });
      }

      const { step } = result.error;
      if (step === 'port 80 check') {
        return res.status(409).json({
          error: 'port_busy',
          detail: result.error.cause,
          hint: 'Stop the process using port 80 and try again.',
        });
      }
      return res.status(500).json({ success: false, error: result.error });
    } catch (error) {
      next(error);
    }
  }

  async renewAll(req, res, next) {
    try {
      const config = loadConfig();

      if (!config.acmeEmail) {
        return res.status(400).json({
          error: 'email_required',
          hint: 'Configure acmeEmail in settings first.',
        });
      }

      const certs = await listAllCerts();
      const expiring = certs.filter(c => c.daysLeft !== null && c.daysLeft < 30);
      const results = [];

      for (const cert of expiring) {
        // Same prepare step as a single renew: regenerate a config that
        // predates the ACME challenge location so this renewal can use proxy
        // mode, instead of silently falling back to stopping nginx.
        const record = findDomain(cert.domain);
        let prepared = null;
        if (record) {
          prepared = await prepareDomainForHttpChallenge(record);
          if (!prepared.ok) {
            results.push({
              domain: cert.domain,
              success: false,
              certPath: null,
              keyPath: null,
              error: 'challenge_setup_failed',
              detail: prepared.error,
            });
            continue;
          }
        }

        const result = await renewCert(cert.domain, { validationMethod: 'http', email: config.acmeEmail });
        results.push({
          domain: cert.domain,
          success: result.success,
          certPath: result.certPath,
          keyPath: result.keyPath,
          mode: result.mode,
          fellBack: result.fellBack,
          nginxDownMs: result.nginxDownMs,
          configRegenerated: Boolean(prepared?.regenerated),
          summary: describeIssuance(result),
        });
      }

      res.json(results);
    } catch (error) {
      next(error);
    }
  }
}

export default SslController;
