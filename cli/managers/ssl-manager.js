/**
 * cli/managers/ssl-manager.js
 *
 * SSL Manager — view certificate status, issue and renew certificates using acme-client.
 *
 * Exported functions:
 * - showSslManager() — interactive menu for managing SSL certificates
 * - issueCert() — issue new certificate via Let's Encrypt (HTTP-01 or DNS-01)
 * - renewCert() — renew an existing certificate
 *
 * Pure Node.js implementation — no external ACME binaries required.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import net from 'net';
import * as acme from 'acme-client';
import { run, runLive } from '../../core/shell.js';
import { loadConfig } from '../../core/config.js';
import { isWindows } from '../../core/platform.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSslDir() {
  const { sslDir } = loadConfig();
  return sslDir;
}

/**
 * Loads or generates the ACME account private key.
 * The key is persisted at {sslDir}/.account/account.key
 */
async function getAccountKey(sslDir) {
  const keyPath = path.join(sslDir, '.account', 'account.key');
  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  try {
    return await fs.readFile(keyPath);
  } catch {
    const key = await acme.crypto.createPrivateKey();
    await fs.writeFile(keyPath, key);
    return key;
  }
}

/**
 * Checks if port 80 is free (can be bound).
 * Used for HTTP-01 challenge validation.
 */
async function isPort80Free() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(80, () => {
      srv.close(() => resolve(true));
    });
    srv.on('error', () => resolve(false));
  });
}

/**
 * Stops nginx to free port 80 for HTTP-01 challenge.
 */
async function stopNginx() {
  const cmd = isWindows
    ? 'taskkill /f /IM nginx.exe'
    : 'systemctl stop nginx';
  await run(cmd);
}

/**
 * Starts nginx after HTTP-01 challenge completes.
 */
async function startNginx() {
  const { nginxDir } = loadConfig();
  const cmd = isWindows
    ? `& "${nginxDir}\\nginx.exe"`
    : 'systemctl start nginx';
  await run(cmd);
}

// ─── Certificate Listing ──────────────────────────────────────────────────────

function getLiveDir() {
  return getSslDir();
}

async function parseCertExpiry(certPath) {
  const result = await run(`openssl x509 -enddate -noout -in "${certPath}"`);

  if (result.success && result.stdout) {
    const match = result.stdout.match(/notAfter=(.+)/);
    if (match) {
      const expiryDate = new Date(match[1].trim());
      const daysLeft = Math.floor((expiryDate - Date.now()) / 86400000);
      return { expiryDate, daysLeft };
    }
  }

  // Fallback: use file mtime + 90 days
  try {
    const stat = await fs.stat(certPath);
    const expiryDate = new Date(stat.mtime.getTime() + 90 * 86400000);
    const daysLeft = Math.floor((expiryDate - Date.now()) / 86400000);
    return { expiryDate, daysLeft, errorReason: 'expiry estimated from file date' };
  } catch {
    return null;
  }
}

async function listCerts(liveDir) {
  let entries;
  try {
    entries = await fs.readdir(liveDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const domains = entries.filter(e => e.isDirectory()).map(e => e.name);
  const certs = [];

  for (const domain of domains) {
    // Skip hidden directories like .account
    if (domain.startsWith('.')) continue;

    const certPath = path.join(liveDir, domain, 'fullchain.pem');

    let status = 'error';
    let expiryDate = null;
    let daysLeft = null;

    try {
      await fs.stat(certPath);
      const expiry = await parseCertExpiry(certPath);
      if (expiry !== null) {
        expiryDate = expiry.expiryDate;
        daysLeft = expiry.daysLeft;
        if (daysLeft > 30) {
          status = 'healthy';
        } else if (daysLeft >= 10) {
          status = 'expiring';
        } else {
          status = 'critical';
        }
      }
    } catch {
      status = 'error';
    }

    certs.push({ domain, status, expiryDate, daysLeft });
  }

  return certs;
}

function renderCertRow(cert) {
  const domainPadded = cert.domain.padEnd(35);

  if (cert.status === 'error') {
    console.log(` ${chalk.gray('❌')} ${chalk.gray(domainPadded)} ${chalk.gray('ERROR')}`);
    return;
  }

  const expiryStr = cert.expiryDate
    ? cert.expiryDate.toDateString().replace(/^\S+\s/, '')
    : '—';
  const daysStr = cert.daysLeft !== null ? `${cert.daysLeft}d` : '—';

  if (cert.status === 'healthy') {
    console.log(` ${chalk.green('✅')} ${chalk.green(domainPadded)} ${chalk.green(daysStr.padEnd(6))} ${chalk.green(`(${expiryStr})`)}`);
  } else if (cert.status === 'expiring') {
    console.log(` ${chalk.yellow('⚠️')} ${chalk.yellow(domainPadded)} ${chalk.yellow(daysStr.padEnd(6))} ${chalk.yellow(`(${expiryStr})`)}`);
  } else {
    console.log(` ${chalk.red('❌')} ${chalk.red(domainPadded)} ${chalk.red(daysStr.padEnd(6))} ${chalk.red(`(${expiryStr})`)}`);
  }
}

// ─── Certificate Issuance ─────────────────────────────────────────────────────

/**
 * Issues a new SSL certificate using Let's Encrypt (acme-client).
 *
 * HTTP-01: stops nginx, starts temp HTTP server on port 80, validates, restarts nginx.
 * DNS-01: no nginx interaction; caller handles TXT record via onDnsChallenge callback.
 *
 * @param {string} domainName - The primary domain name
 * @param {{
 *   www?: boolean,
 *   validationMethod?: 'http' | 'dns',
 *   email?: string | null,
 *   onDnsChallenge?: (txtName: string, txtValue: string) => Promise<void>
 * }} options
 * @returns {Promise<{ success: boolean, certPath: string|null, keyPath: string|null, error: object|null }>}
 */
export async function issueCert(domainName, {
  www = false,
  wildcard = false,
  validationMethod = 'http',
  email = null,
  onDnsChallenge = null,
} = {}) {
  const sslDir = getSslDir();
  const config = loadConfig();

  // Email is required for Let's Encrypt
  const acmeEmail = email || config.acmeEmail;
  if (!acmeEmail) {
    return {
      success: false,
      certPath: null,
      keyPath: null,
      error: {
        step: 'email configuration',
        cause: 'No email address configured. Let\'s Encrypt requires an email for account creation.',
        consequence: 'No certificate was issued. Configure acmeEmail in settings or provide email parameter.',
        nginxRunning: true,
        configSaved: false,
      },
    };
  }

  // Ensure certificate directory exists
  const certDir = path.join(sslDir, domainName);
  await fs.mkdir(certDir, { recursive: true });

  // Load or create account key
  const accountKey = await getAccountKey(sslDir);

  // Create ACME client (Let's Encrypt production)
  const client = new acme.Client({
    directoryUrl: acme.directory.letsencrypt.production,
    accountKey,
  });

  // Wildcard requires DNS-01 — enforce it here
  if (wildcard && validationMethod === 'http') {
    return {
      success: false,
      certPath: null,
      keyPath: null,
      error: {
        step: 'validation method',
        cause: 'Wildcard certificates require DNS-01 validation, not HTTP-01.',
        consequence: 'No certificate was issued. Change validation method to DNS.',
        nginxRunning: true,
        configSaved: false,
      },
    };
  }

  // altNames: wildcard includes both bare domain and *.domain
  const altNames = wildcard
    ? [domainName, `*.${domainName}`]
    : (www ? [domainName, `www.${domainName}`] : [domainName]);
  const [domainKey, csr] = await acme.crypto.createCsr({
    commonName: domainName,
    altNames,
  });

  // ─── HTTP-01 Challenge ─────────────────────────────────────────────────────
  if (validationMethod === 'http') {
    // Stop nginx to free port 80
    await stopNginx();

    // Check port 80 is free
    const portFree = await isPort80Free();
    if (!portFree) {
      await startNginx();
      return {
        success: false,
        certPath: null,
        keyPath: null,
        error: {
          step: 'port 80 check',
          cause: 'Port 80 is still in use after stopping nginx. Another process may be binding it.',
          consequence: 'No certificate was issued. nginx has been restarted.',
          nginxRunning: true,
          configSaved: false,
        },
      };
    }

    // Create temporary HTTP server for challenge
    const challengeTokens = new Map();
    let httpServer;

    const challengeCreateFn = async (authz, challenge, keyAuthorization) => {
      challengeTokens.set(challenge.token, keyAuthorization);
    };

    const challengeRemoveFn = async (authz, challenge, keyAuthorization) => {
      challengeTokens.delete(challenge.token);
    };

    // Start temp HTTP server on port 80
    httpServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/.well-known/acme-challenge/')) {
        const token = url.pathname.split('/').pop();
        const keyAuth = challengeTokens.get(token);
        if (keyAuth) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(keyAuth);
          return;
        }
      }
      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise((resolve, reject) => {
      httpServer.listen(80, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    try {
      // Execute ACME challenge — returns the signed certificate PEM
      // challengePriority forces http-01 only so acme-client never falls back to dns-01
      const cert = await client.auto({
        csr,
        email: acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn,
        challengeRemoveFn,
      });

      // Close HTTP server
      await new Promise((resolve) => httpServer.close(resolve));

      // Restart nginx
      await startNginx();

      // Write certificate files
      const certPath = path.join(certDir, 'fullchain.pem');
      const keyPath = path.join(certDir, 'privkey.pem');

      await fs.writeFile(keyPath, domainKey);
      await fs.writeFile(certPath, cert);

      return { success: true, certPath, keyPath, error: null };
    } catch (err) {
      // Ensure server is closed and nginx restarted on error
      await new Promise((resolve) => httpServer.close(resolve));
      await startNginx();
      return {
        success: false,
        certPath: null,
        keyPath: null,
        error: {
          step: 'ACME validation',
          cause: err.message || 'HTTP-01 challenge failed.',
          consequence: 'No certificate was issued. nginx has been restarted.',
          nginxRunning: true,
          configSaved: false,
        },
      };
    }
  }

  // ─── DNS-01 Challenge ──────────────────────────────────────────────────────
  if (validationMethod === 'dns') {
    const challengeCreateFn = async (authz, challenge, keyAuthorization) => {
      const txtName = `_acme-challenge.${domainName}`;
      const txtValue = keyAuthorization;

      // Yield TXT record to caller and pause until they confirm DNS is set.
      // onDnsChallenge is async — it returns only after the user confirms
      // (dashboard: /create-confirm resolves the deferred; CLI: inquirer prompt).
      if (onDnsChallenge) {
        await onDnsChallenge(txtName, txtValue);
      }
      // challengeCreateFn returning here signals acme-client to proceed with validation.
    };

    const challengeRemoveFn = async () => {
      // No-op: TXT record cleanup is the user's responsibility.
    };

    try {
      // Execute ACME challenge — returns the signed certificate PEM
      // challengePriority forces dns-01 only so acme-client never tries http-01
      
      const cert = await client.auto({
        csr,
        email: acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        challengeCreateFn,
        challengeRemoveFn,
      });

      // Write certificate files
      const certPath = path.join(certDir, 'fullchain.pem');
      const keyPath = path.join(certDir, 'privkey.pem');

      await fs.writeFile(keyPath, domainKey);
      await fs.writeFile(certPath, cert);

      return { success: true, certPath, keyPath, error: null };
    } catch (err) {
      return {
        success: false,
        certPath: null,
        keyPath: null,
        error: {
          step: 'ACME validation',
          cause: err.message || 'DNS-01 challenge failed.',
          consequence: 'No certificate was issued. nginx was not affected.',
          nginxRunning: true,
          configSaved: false,
        },
      };
    }
  }

  // Invalid validation method
  return {
    success: false,
    certPath: null,
    keyPath: null,
    error: {
      step: 'validation method',
      cause: `Invalid validation method: ${validationMethod}. Must be 'http' or 'dns'.`,
      consequence: 'No certificate was issued.',
      nginxRunning: true,
      configSaved: false,
    },
  };
}

/**
 * Renews a certificate by re-issuing it.
 * acme-client's auto() handles renewal transparently.
 */
export async function renewCert(domainName, options = {}) {
  return issueCert(domainName, options);
}

/**
 * Renews all certificates expiring within 30 days.
 */
export async function renewExpiring(certs) {
  const expiring = certs.filter(c => c.daysLeft !== null && c.daysLeft < 30);
  if (expiring.length === 0) return [];

  const results = [];
  for (const cert of expiring) {
    const result = await issueCert(cert.domain, { validationMethod: 'http' });
    results.push({
      domain: cert.domain,
      success: result.success,
      exitCode: result.success ? 0 : 1,
    });
  }
  return results;
}

// ─── CLI Menu ────────────────────────────────────────────────────────────────

export async function showSslManager() {
  while (true) {
    const liveDir = getLiveDir();

    const spinner = ora('Loading certificates…').start();
    const certs = await listCerts(liveDir);
    spinner.stop();

    console.log(chalk.bold('\n SSL Manager'));
    console.log(chalk.gray(' ' + '─'.repeat(40)));

    if (certs.length === 0) {
      console.log(chalk.gray(' No certificates found'));
    } else {
      for (const cert of certs) {
        renderCertRow(cert);
      }
    }
    console.log();

    const choices = [
      'Create new certificate',
      'Renew a certificate',
      'Renew all expiring (< 30 days)',
      new inquirer.Separator(),
      '← Back',
    ];

    let choice;
    try {
      ({ choice } = await inquirer.prompt([{
        type: 'list',
        name: 'choice',
        message: 'Select an option:',
        choices,
      }]));
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      throw err;
    }

    switch (choice) {
      case 'Create new certificate': {
        const config = loadConfig();

        // Prompt for email if not configured
        let acmeEmail = config.acmeEmail;
        if (!acmeEmail) {
          let emailInput;
          try {
            ({ emailInput } = await inquirer.prompt([{
              type: 'input',
              name: 'emailInput',
              message: 'Email address (required for Let\'s Encrypt):',
              validate: v => v.trim() && v.includes('@') ? true : 'Valid email required',
            }]));
            acmeEmail = emailInput;
            // Save to config
            config.acmeEmail = acmeEmail;
            const { saveConfig } = await import('../../core/config.js');
            saveConfig(config);
          } catch (err) {
            if (err.name === 'ExitPromptError') return;
            throw err;
          }
        }

        let domainInput, wwwInput, method;
        try {
          ({ domainInput } = await inquirer.prompt([{
            type: 'input',
            name: 'domainInput',
            message: 'Domain name:',
            validate: v => v.trim() ? true : 'Required',
          }]));
          ({ wwwInput } = await inquirer.prompt([{
            type: 'confirm',
            name: 'wwwInput',
            message: 'Include www subdomain?',
            default: false,
          }]));
          ({ method } = await inquirer.prompt([{
            type: 'list',
            name: 'method',
            message: 'How should we validate domain ownership?',
            choices: [
              { name: 'HTTP challenge (domain DNS points to this server)', value: 'http' },
              { name: 'DNS challenge (I\'ll add a TXT record manually)', value: 'dns' },
            ],
          }]));
        } catch (err) {
          if (err.name === 'ExitPromptError') return;
          throw err;
        }

        let result;
        if (method === 'dns') {
          const onDnsChallenge = async (txtName, txtValue) => {
            console.log(chalk.yellow('\n Add this DNS TXT record:'));
            console.log(chalk.white(` Name: ${txtName}`));
            console.log(chalk.white(` Value: ${txtValue}\n`));
            try {
              await inquirer.prompt([{
                type: 'input',
                name: '_',
                message: 'Add the TXT record to your DNS, then press Enter to continue...',
              }]);
            } catch (err) {
              if (err.name !== 'ExitPromptError') throw err;
            }
          };
          console.log(chalk.cyan(`\n Starting DNS challenge for ${domainInput.trim()}…\n`));
          result = await issueCert(domainInput.trim(), {
            www: wwwInput,
            validationMethod: 'dns',
            email: acmeEmail,
            onDnsChallenge,
          });
        } else {
          const spinner = ora(`Creating certificate for ${domainInput.trim()}…`).start();
          result = await issueCert(domainInput.trim(), {
            www: wwwInput,
            validationMethod: 'http',
            email: acmeEmail,
          });
          spinner.stop();
        }

        if (result.success) {
          console.log(chalk.green('\n ✓ Certificate created successfully'));
          console.log(chalk.gray(` Cert: ${result.certPath}`));
          console.log(chalk.gray(` Key: ${result.keyPath}\n`));
        } else {
          const e = result.error;
          console.log(chalk.red('\n ✗ Certificate creation failed'));
          console.log(chalk.yellow(` Step: ${e.step}`));
          console.log(chalk.yellow(` Cause: ${e.cause}`));
          console.log(chalk.yellow(` Consequence: ${e.consequence}`));
          console.log(chalk.gray(` nginx running: ${e.nginxRunning ? 'yes' : 'no'}\n`));
        }
        break;
      }

      case 'Renew a certificate': {
        if (certs.length === 0) {
          console.log(chalk.gray('\n No certificates found to renew\n'));
          break;
        }

        let selectedDomain;
        try {
          ({ selectedDomain } = await inquirer.prompt([{
            type: 'list',
            name: 'selectedDomain',
            message: 'Select domain to renew:',
            choices: certs.map(c => c.domain),
          }]));
        } catch (err) {
          if (err.name === 'ExitPromptError') return;
          throw err;
        }

        const config = loadConfig();
        const spinner = ora(`Renewing certificate for ${selectedDomain}…`).start();
        const result = await renewCert(selectedDomain, {
          validationMethod: 'http',
          email: config.acmeEmail,
        });
        spinner.stop();

        if (result.success) {
          console.log(chalk.green('\n ✓ Renewed successfully\n'));
        } else {
          const e = result.error;
          console.log(chalk.red('\n ✗ Renewal failed'));
          console.log(chalk.yellow(` Step: ${e.step}`));
          console.log(chalk.yellow(` Cause: ${e.cause}\n`));
        }
        break;
      }

      case 'Renew all expiring (< 30 days)': {
        const config = loadConfig();
        const results = await renewExpiring(certs, { email: config.acmeEmail });
        if (results.length === 0) {
          console.log(chalk.gray('\n No certificates expiring within 30 days\n'));
        } else {
          console.log();
          for (const r of results) {
            if (r.success) {
              console.log(` ${chalk.green('✓ ' + r.domain)}`);
            } else {
              console.log(` ${chalk.red('✗ ' + r.domain)}`);
            }
          }
          console.log();
        }
        break;
      }

      case '← Back':
        return;
    }

    if (choice !== '← Back') {
      try {
        await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        throw err;
      }
    }
  }
}
