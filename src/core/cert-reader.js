import fs from 'fs/promises';
import path from 'path';
import { run } from './shell.js';
import { loadConfig } from './config.js';

export async function listAllCerts({ sslDir } = {}) {
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
    const { expiry, daysLeft } = await getCertExpiry(dir.name, { sslDir: liveDir });
    let status;
    if (daysLeft === null) {
      status = 'error';
    } else if (daysLeft <= 0) {
      status = 'expired';
    } else if (daysLeft < 30) {
      status = 'expiring';
    } else {
      status = 'valid';
    }
    certs.push({ domain: dir.name, expiry: expiry?.toISOString() ?? null, daysLeft, status });
  }
  return certs;
}

export async function getCertExpiry(name, { sslDir } = {}) {
  const certPath = path.join(sslDir ?? loadConfig().sslDir, name, 'fullchain.pem');

  const result = await run(`openssl x509 -enddate -noout -in "${certPath}"`);

  if (result.success && result.stdout) {
    const match = result.stdout.match(/notAfter=(.+)/);
    if (match) {
      const expiry = new Date(match[1].trim());
      const daysLeft = Math.floor((expiry - Date.now()) / 86400000);
      return { expiry, daysLeft, valid: daysLeft > 0 };
    }
  }

  // Fallback: mtime + 90 days if file exists but openssl failed
  try {
    const stat = await fs.stat(certPath);
    const expiry = new Date(stat.mtime.getTime() + 90 * 86400000);
    const daysLeft = Math.floor((expiry - Date.now()) / 86400000);
    return { expiry, daysLeft, valid: daysLeft > 0 };
  } catch {
    return { expiry: null, daysLeft: null, valid: null };
  }
}
