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
import { run } from '../../core/shell.js';
import { loadConfig } from '../../core/config.js';
import { issueCertificate, describeIssuance } from '../../core/ssl-issuer.js';
import { renewCertificate, describeRenewal, failureReason } from '../../core/cert-renewal.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSslDir() {
  const { sslDir } = loadConfig();
  return sslDir;
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
 * Issues (or renews) a certificate for a domain.
 *
 * Thin wrapper over core/ssl-issuer.js, which is the single implementation
 * shared by the CLI, the dashboard API and the Hub command path. It keeps
 * nginx running by default — see that module for the challenge strategy.
 *
 * @param {string} domainName
 * @param {Object} options See issueCertificate() in core/ssl-issuer.js
 * @returns {Promise<Object>} Result object from issueCertificate()
 */
export async function issueCert(domainName, options = {}) {
  return issueCertificate(domainName, options);
}

/**
 * Renews a certificate.
 *
 * Goes through core/cert-renewal.js, the one renewal path: it keeps the names
 * the certificate already covers (a `www` certificate stays one), prepares the
 * nginx config, and reloads nginx so the new certificate is the one served.
 * A DNS-01 / wildcard certificate is refused with `skipped: 'manual'` rather
 * than silently replaced by a single-name HTTP-01 certificate.
 */
export async function renewCert(domainName, options = {}) {
  return renewCertificate(domainName, { email: options.email ?? null, mode: options.mode ?? null });
}

/**
 * Renews all certificates expiring within 30 days.
 */
export async function renewExpiring(certs, options = {}) {
  const expiring = certs.filter(c => c.daysLeft !== null && c.daysLeft < 30);
  if (expiring.length === 0) return [];

  const results = [];
  for (const cert of expiring) {
    const result = await renewCert(cert.domain, options);
    results.push({
      domain: cert.domain,
      success: result.success,
      exitCode: result.success ? 0 : 1,
      manual: result.skipped === 'manual',
      configRegenerated: Boolean(result.configRegenerated),
      error: result.success ? null : failureReason(result),
      summary: describeRenewal(result),
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
          console.log(chalk.gray(` Key: ${result.keyPath}`));
          // Say whether nginx stayed up, or fell back and for how long.
          const summary = describeIssuance(result);
          if (summary) {
            const warn = result.fellBack || result.staging || result.nginxRestored === false;
            console.log((warn ? chalk.yellow : chalk.gray)(` ${summary}`));
          }
          console.log();
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
        const result = await renewCert(selectedDomain, { email: config.acmeEmail });
        spinner.stop();

        if (result.success) {
          console.log(chalk.green('\n ✓ Renewed successfully'));
          const summary = describeRenewal(result);
          if (summary) console.log(chalk.gray(`   ${summary}`));
          console.log();
        } else if (result.skipped === 'manual') {
          console.log(chalk.yellow('\n ⚠ This certificate cannot be renewed over HTTP'));
          console.log(chalk.yellow(` ${result.error.cause}`));
          console.log(chalk.gray(' Use "Create new certificate" with the DNS challenge to renew it.\n'));
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
              console.log(` ${chalk.green('✓ ' + r.domain)}${r.summary ? chalk.gray(`  ${r.summary}`) : ''}`);
            } else if (r.manual) {
              console.log(` ${chalk.yellow('⚠ ' + r.domain)}${chalk.gray('  DNS-validated — renew it manually')}`);
            } else {
              console.log(` ${chalk.red('✗ ' + r.domain)}${r.error ? chalk.gray(`  ${r.error}`) : ''}`);
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
