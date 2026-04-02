import express from 'express';
import { run } from '../../core/shell.js';
import { listAllCerts } from '../lib/cert-reader.js';
import { issueCert } from '../../cli/managers/ssl-manager.js';

const router = express.Router();

// ─── In-memory DNS challenge state ────────────────────────────────────────────
// Keyed by domain name. Entries are cleaned up when the ACME process exits
// or when cancelled. Entries older than 10 minutes are forcibly removed.

const pendingDnsChallenges = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [domain, state] of pendingDnsChallenges) {
    if (now - state.createdAt > 10 * 60 * 1000) {
      state.confirmDeferred.reject(new Error('DNS challenge timed out after 10 minutes'));
      pendingDnsChallenges.delete(domain);
    }
  }
}, 60000);

const CERTBOT_WIN_EXE = 'C:\\Program Files\\Certbot\\bin\\certbot.exe';

// Returns the PS-safe certbot invocation string, or null if not installed.
async function getCertbotCmd() {
  if (process.platform !== 'win32') {
    const r = await run('certbot --version', { timeout: 10000 });
    return r.success ? 'certbot' : null;
  }

  // Try PATH first
  const whereResult = await run('where.exe certbot', { timeout: 5000 });
  if (whereResult.success && whereResult.stdout.trim()) return 'certbot';

  // Check known Windows install location
  const testResult = await run(`Test-Path "${CERTBOT_WIN_EXE}"`, { timeout: 5000 });
  if (testResult.stdout.trim() === 'True') return `& "${CERTBOT_WIN_EXE}"`;

  return null;
}

async function renewDomain(domain, certbotCmd) {
  if (process.platform === 'win32') {
    const certResult = await run(
      `${certbotCmd} certonly --standalone --non-interactive --agree-tos -d ${domain}`,
      { timeout: 120000 }
    );
    const output = [certResult.stdout, certResult.stderr].filter(Boolean).join('\n').trim();
    return { success: certResult.success, output };
  }

  await run('systemctl stop nginx', { timeout: 15000 });
  let certResult;
  try {
    certResult = await run(
      `${certbotCmd} certonly --standalone --non-interactive --agree-tos -d ${domain}`,
      { timeout: 120000 }
    );
  } finally {
    await run('systemctl start nginx', { timeout: 15000 });
  }
  const output = [certResult.stdout, certResult.stderr].filter(Boolean).join('\n').trim();
  return { success: certResult.success, output };
}

// ─── POST /api/ssl/create ─────────────────────────────────────────────────────

router.post('/create', async (req, res) => {
  const { domain, www = false, validationMethod = 'http', email = null } = req.body ?? {};

  if (!domain || typeof domain !== 'string' || !domain.trim()) {
    return res.status(400).json({ error: 'domain is required' });
  }

  const domainKey = domain.trim();

  if (validationMethod === 'dns') {
    // Two-phase flow: spawn ACME process, wait for TXT record, respond 202, pause until confirm.
    // On Windows, wacs.exe runs interactively (stdin inherited), so onDnsChallenge is never
    // called — issueCert() completes synchronously and we respond directly below.
    let confirmResolve, confirmReject;
    const confirmPromise = new Promise((resolve, reject) => {
      confirmResolve = resolve;
      confirmReject = reject;
    });

    let resultResolve;
    const resultPromise = new Promise((resolve) => { resultResolve = resolve; });

    // Track whether a response has already been sent (202 from onDnsChallenge, or direct
    // 200/500 if issueCert() completes without calling onDnsChallenge, e.g. on Windows).
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
    // If issueCert() completes without calling onDnsChallenge (e.g. Windows interactive mode or
    // early error), we send the response directly.
    issueCert(domainKey, { www: !!www, validationMethod: 'dns', email: email || null, onDnsChallenge })
      .then(result => {
        resultResolve(result);
        pendingDnsChallenges.delete(domainKey);
        if (!responseSent) {
          responseSent = true;
          if (result.success) {
            return res.json({ success: true, certPath: result.certPath, keyPath: result.keyPath });
          }
          const { step } = result.error ?? {};
          if (step === 'ACME client detection') {
            return res.status(503).json({ error: 'no_acme_client', hint: 'Install certbot or win-acme first using the SSL Manager.' });
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

  // HTTP validation path (synchronous — responds when complete)
  const result = await issueCert(domainKey, { www: !!www, validationMethod: 'http', email: email || null });

  if (result.success) {
    return res.json({ success: true, certPath: result.certPath, keyPath: result.keyPath });
  }

  const { step } = result.error;
  if (step === 'ACME client detection') {
    return res.status(503).json({
      error: 'no_acme_client',
      hint: 'Install certbot or win-acme first using the SSL Manager.',
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
});

// ─── POST /api/ssl/create-confirm ────────────────────────────────────────────

router.post('/create-confirm', async (req, res) => {
  const { domain } = req.body ?? {};
  const domainKey = domain?.trim();
  const state = domainKey ? pendingDnsChallenges.get(domainKey) : null;

  if (!state) {
    return res.status(404).json({
      error: 'no_pending_challenge',
      hint: 'No DNS challenge is pending for this domain. Start a new certificate issuance.',
    });
  }

  // Signal issueCert() to write '\n' to the ACME process stdin and continue
  state.confirmDeferred.resolve();

  // Wait for the ACME process to complete
  const result = await state.resultPromise;
  pendingDnsChallenges.delete(domainKey);

  if (result.success) {
    return res.json({ success: true, certPath: result.certPath, keyPath: result.keyPath });
  }
  return res.status(500).json({ success: false, error: result.error });
});

// ─── POST /api/ssl/create-cancel ─────────────────────────────────────────────

router.post('/create-cancel', async (req, res) => {
  const { domain } = req.body ?? {};
  const domainKey = domain?.trim();
  const state = domainKey ? pendingDnsChallenges.get(domainKey) : null;

  if (!state) {
    return res.status(404).json({
      error: 'no_pending_challenge',
      hint: 'No DNS challenge is pending for this domain.',
    });
  }

  // Reject the deferred — issueCert() will kill the proc and return a failure result
  state.confirmDeferred.reject(new Error('cancelled by user'));
  pendingDnsChallenges.delete(domainKey);

  return res.json({ cancelled: true });
});

// ─── GET /api/ssl ─────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const certbotCmd = await getCertbotCmd();
  if (!certbotCmd) {
    return res.status(503).json({
      error: 'certbot not installed',
      instructions: 'Install certbot: https://certbot.eff.org/instructions',
    });
  }
  const certs = await listAllCerts();
  res.json(certs);
});

router.post('/renew/:domain', async (req, res) => {
  const certbotCmd = await getCertbotCmd();
  if (!certbotCmd) {
    return res.status(503).json({
      error: 'certbot not installed',
      instructions: 'Install certbot: https://certbot.eff.org/instructions',
    });
  }
  const domain = req.params.domain;
  const certs = await listAllCerts();
  const found = certs.find(cert => cert.domain === domain);
  if (!found) {
    return res.status(404).json({ error: `Domain '${domain}' not found in certbot` });
  }
  const result = await renewDomain(domain, certbotCmd);
  if (result.output.includes('binding to port 80') || result.output.includes('Address already in use')) {
    return res.status(409).json({
      error: 'Port 80 is busy',
      message: 'stop nginx first or use --webroot',
    });
  }
  res.json({ success: result.success, output: result.output });
});

router.post('/renew-all', async (req, res) => {
  const certbotCmd = await getCertbotCmd();
  if (!certbotCmd) {
    return res.status(503).json({
      error: 'certbot not installed',
      instructions: 'Install certbot: https://certbot.eff.org/instructions',
    });
  }
  const certs = await listAllCerts();
  const expiring = certs.filter(c => c.daysLeft !== null && c.daysLeft < 30);
  const results = [];
  for (const cert of expiring) {
    const r = await renewDomain(cert.domain, certbotCmd);
    results.push({ domain: cert.domain, success: r.success, output: r.output });
  }
  res.json(results);
});

export default router;
