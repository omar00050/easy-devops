import express from 'express';
import { run } from '../../core/shell.js';
import { listAllCerts } from '../lib/cert-reader.js';
import { issueCert } from '../../cli/managers/ssl-manager.js';

const router = express.Router();

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
  const { domain, www = false } = req.body ?? {};

  if (!domain || typeof domain !== 'string' || !domain.trim()) {
    return res.status(400).json({ error: 'domain is required' });
  }

  const result = await issueCert(domain.trim(), { www: !!www });

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
