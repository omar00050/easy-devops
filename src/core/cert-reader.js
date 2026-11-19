import fs from 'fs/promises';
import path from 'path';
import { X509Certificate } from 'node:crypto';
import { run } from './shell.js';
import { loadConfig } from './config.js';

/**
 * Reads every certificate directory.
 *
 * Two different "there is no usable certificate here" cases are kept apart:
 *
 *   not_issued  the directory exists but no fullchain.pem was ever written
 *               (a failed first issuance leaves exactly this), label
 *               "Not issued yet"
 *   unreadable  fullchain.pem exists but neither Node nor openssl can parse it
 *
 * Collapsing them into one "error" made a domain whose certificate had simply
 * not been requested yet look broken.
 */
export async function listAllCerts({ sslDir, includeUnusable = false } = {}) {
  const liveDir = sslDir ?? loadConfig().sslDir;
  let entries;
  try {
    entries = await fs.readdir(liveDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
  const certs = [];
  for (const dir of dirs) {
    const info = await getCertExpiry(dir.name, { sslDir: liveDir });
    const { expiry, daysLeft } = info;
    let status;
    if (info.state === 'not_issued') {
      status = 'not_issued';
    } else if (info.state === 'unreadable' || daysLeft === null) {
      status = 'unreadable';
    } else if (daysLeft <= 0) {
      status = 'expired';
    } else if (daysLeft < 30) {
      status = 'expiring';
    } else {
      status = 'valid';
    }
    // Callers that act on certificates (suggestion, renewal, monitoring) must
    // see only usable ones; the SSL list passes includeUnusable so it can show
    // "Not issued yet" instead of silently omitting the domain.
    if (!includeUnusable && (status === 'not_issued' || status === 'unreadable')) continue;
    certs.push({
      domain: dir.name,
      expiry: expiry?.toISOString() ?? null,
      daysLeft,
      status,
      label: status === 'not_issued' ? 'Not issued yet' : null,
    });
  }
  return certs;
}

/**
 * Expiry of one certificate, with the reason when there is none.
 *
 * @returns {Promise<{ expiry: Date|null, daysLeft: number|null,
 *   valid: boolean|null, state: 'ok'|'not_issued'|'unreadable' }>}
 */
export async function getCertExpiry(name, { sslDir } = {}) {
  const certPath = path.join(sslDir ?? loadConfig().sslDir, name, 'fullchain.pem');

  let pem = null;
  try {
    pem = await fs.readFile(certPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { expiry: null, daysLeft: null, valid: null, state: 'not_issued' };
    }
    return { expiry: null, daysLeft: null, valid: null, state: 'unreadable' };
  }

  // Node's own parser first: it works on Windows without an openssl binary.
  try {
    const cert = new X509Certificate(pem);
    const expiry = new Date(cert.validTo);
    if (!Number.isNaN(expiry.getTime())) {
      const daysLeft = Math.floor((expiry - Date.now()) / 86400000);
      return { expiry, daysLeft, valid: daysLeft > 0, state: 'ok' };
    }
  } catch { /* fall through to openssl */ }

  // openssl remains the fallback for a PEM chain or an older/odd encoding.
  const result = await run(`openssl x509 -enddate -noout -in "${certPath}"`);
  if (result.success && result.stdout) {
    const match = result.stdout.match(/notAfter=(.+)/);
    if (match) {
      const expiry = new Date(match[1].trim());
      if (!Number.isNaN(expiry.getTime())) {
        const daysLeft = Math.floor((expiry - Date.now()) / 86400000);
        return { expiry, daysLeft, valid: daysLeft > 0, state: 'ok' };
      }
    }
  }

  return { expiry: null, daysLeft: null, valid: null, state: 'unreadable' };
}
