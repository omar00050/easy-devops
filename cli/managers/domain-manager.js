/**
 * cli/managers/domain-manager.js
 *
 * Domain Manager — full control over nginx reverse proxy domains from CLI.
 *
 * Exported functions:
 * - showDomainManager() — interactive menu for managing domains
 *
 * Uses shared nginx-conf-generator.js (core/) for identical conf output
 * to the dashboard.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import fs from 'fs/promises';
import Table from 'cli-table3';
import { run } from '../../core/shell.js';
import { loadConfig } from '../../core/config.js';
import { getDomains, saveDomains, findDomain, createDomain, DOMAIN_DEFAULTS } from '../../dashboard/lib/domains-db.js';
import { generateConf, buildConf } from '../../core/nginx-conf-generator.js';
import { issueCert } from './ssl-manager.js';

const isWindows = process.platform === 'win32';

// ─── Helper functions ────────────────────────────────────────────────────────

function getNginxExe(nginxDir) {
  return isWindows ? `${nginxDir}\\nginx.exe` : 'nginx';
}

function nginxTestCmd(nginxDir) {
  const exe = getNginxExe(nginxDir);
  return isWindows ? `& "${exe}" -t` : 'nginx -t';
}

function nginxReloadCmd(nginxDir) {
  const exe = getNginxExe(nginxDir);
  return isWindows ? `& "${exe}" -s reload` : 'nginx -s reload';
}

function combineOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

// ─── List Domains ───────────────────────────────────────────────────────

async function listDomainsAction() {
  const domains = getDomains();

  if (domains.length === 0) {
    console.log(chalk.yellow('\n No domains configured yet.\n'));
    return;
  }

  const table = new Table({
    head: [
      chalk.cyan('Domain'),
      chalk.cyan('Port'),
      chalk.cyan('Type'),
      chalk.cyan('SSL'),
      chalk.cyan('Cert'),
    ],
    style: { head: [], border: ['gray'] },
    colWidths: [30, 8, 8, 8, 8],
  });

  for (const d of domains) {
    const sslStatus = d.ssl?.enabled ? chalk.green('HTTPS') : chalk.gray('HTTP');
    const type = (d.upstreamType || 'http').toUpperCase();
    const certDays = d.daysLeft !== null && d.daysLeft !== undefined
      ? (d.daysLeft > 30 ? chalk.green(`${d.daysLeft}d`) : chalk.yellow(`${d.daysLeft}d`))
      : chalk.gray('—');

    table.push([
      d.name,
      d.port.toString(),
      type,
      sslStatus,
      certDays,
    ]);
  }

  console.log('\n' + table.toString() + '\n');
}

// ─── Add Domain ───────────────────────────────────────────────────────

async function addDomainAction() {
  console.log(chalk.bold('\n Add New Domain\n'));

  // Section 1: Basic
  const basic = await inquirer.prompt([
    { type: 'input', name: 'name', message: 'Domain name:', validate: (v) => v.trim() ? true : 'Required' },
    { type: 'input', name: 'backendHost', message: 'Backend host:', default: '127.0.0.1' },
    { type: 'number', name: 'port', message: 'Backend port:', default: 3000, validate: (v) => (v >= 1 && v <= 65535) ? true : 'Port must be 1-65535' },
    {
      type: 'list', name: 'upstreamType', message: 'Upstream type:', default: 'http',
      choices: ['http', 'https', 'ws'],
    },
    { type: 'confirm', name: 'www', message: 'Include www subdomain?', default: false },
  ]);

  // Check for duplicate
  if (findDomain(basic.name)) {
    console.log(chalk.red(`\n Domain "${basic.name}" already exists.\n`));
    return;
  }

  // Section 2: SSL
  const sslAnswers = await inquirer.prompt([
    { type: 'confirm', name: 'enabled', message: 'Enable SSL?', default: false },
  ]);

  let ssl = { ...DOMAIN_DEFAULTS.ssl, enabled: sslAnswers.enabled };

  if (ssl.enabled) {
    const { nginxDir, certbotDir } = loadConfig();
    const platform = isWindows ? 'win32' : 'linux';
    const defaultCertPath = platform === 'win32'
      ? `C:\\Certbot\\live\\${basic.name}\\fullchain.pem`
      : `${certbotDir}/live/${basic.name}/fullchain.pem`;
    const defaultKeyPath = platform === 'win32'
      ? `C:\\Certbot\\live\\${basic.name}\\privkey.pem`
      : `${certbotDir}/live/${basic.name}/privkey.pem`;

    const sslDetails = await inquirer.prompt([
      { type: 'input', name: 'certPath', message: 'SSL cert path:', default: defaultCertPath },
      { type: 'input', name: 'keyPath', message: 'SSL key path:', default: defaultKeyPath },
      { type: 'confirm', name: 'redirect', message: 'HTTP → HTTPS redirect?', default: true },
      { type: 'confirm', name: 'hsts', message: 'Enable HSTS?', default: false },
    ]);

    if (sslDetails.hsts) {
      const { hstsMaxAge } = await inquirer.prompt([
        { type: 'number', name: 'hstsMaxAge', message: 'HSTS max-age (seconds):', default: 31536000 },
      ]);
      ssl.hstsMaxAge = hstsMaxAge;
    }

    ssl = { ...ssl, ...sslDetails };
  }

  // Cert existence check (FR-001, FR-002)
  if (ssl.enabled) {
    let certExists = false;
    try {
      await fs.access(ssl.certPath, fs.constants.F_OK);
      certExists = true;
    } catch {
      certExists = false;
    }

    if (!certExists) {
      console.log(chalk.yellow(`\n ⚠ Certificate not found at: ${ssl.certPath}`));

      let certAction;
      try {
        ({ certAction } = await inquirer.prompt([{
          type: 'list',
          name: 'certAction',
          message: 'What would you like to do?',
          choices: ['Create certificate now', 'Disable SSL', 'Cancel'],
        }]));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        throw err;
      }

      if (certAction === 'Cancel') {
        console.log(chalk.gray('\n Cancelled.\n'));
        return;
      }

      if (certAction === 'Disable SSL') {
        ssl.enabled = false;
        console.log(chalk.gray(' SSL disabled. Domain will be saved as HTTP-only.\n'));
      }

      if (certAction === 'Create certificate now') {
        const spinner = ora(`Creating certificate for ${basic.name}…`).start();
        const result = await issueCert(basic.name, { www: basic.www });
        spinner.stop();

        if (result.success) {
          console.log(chalk.green('\n ✓ Certificate created successfully'));
          console.log(chalk.gray(`   Cert: ${result.certPath}`));
          console.log(chalk.gray(`   Key:  ${result.keyPath}\n`));
          ssl.certPath = result.certPath;
          ssl.keyPath = result.keyPath;
        } else {
          const e = result.error;
          console.log(chalk.red('\n ✗ Certificate creation failed — domain was not saved'));
          console.log(chalk.yellow(`   Step:        ${e.step}`));
          console.log(chalk.yellow(`   Cause:       ${e.cause}`));
          console.log(chalk.yellow(`   Consequence: ${e.consequence}`));
          console.log(chalk.gray(`   nginx running: ${e.nginxRunning ? 'yes' : 'no'}\n`));
          return;
        }
      }
    }
  }

  // Section 3: Proxy Behavior
  const proxy = await inquirer.prompt([
    { type: 'input', name: 'maxBodySize', message: 'Max body size:', default: '10m' },
    { type: 'number', name: 'readTimeout', message: 'Read timeout (s):', default: 60 },
    { type: 'number', name: 'connectTimeout', message: 'Connect timeout (s):', default: 10 },
    { type: 'confirm', name: 'proxyBuffers', message: 'Enable proxy buffering?', default: false },
  ]);

  // Section 4: Performance
  const perf = await inquirer.prompt([
    { type: 'confirm', name: 'gzip', message: 'Enable gzip?', default: true },
  ]);

  let performance = {
    ...DOMAIN_DEFAULTS.performance,
    maxBodySize: proxy.maxBodySize,
    readTimeout: proxy.readTimeout,
    connectTimeout: proxy.connectTimeout,
    proxyBuffers: proxy.proxyBuffers,
    gzip: perf.gzip,
  };

  // Section 5: Security
  const secAnswers = await inquirer.prompt([
    { type: 'confirm', name: 'rateLimit', message: 'Enable rate limiting?', default: false },
  ]);

  let security = { ...DOMAIN_DEFAULTS.security, rateLimit: secAnswers.rateLimit };

  if (secAnswers.rateLimit) {
    const rateDetails = await inquirer.prompt([
      { type: 'number', name: 'rateLimitRate', message: 'Requests/second:', default: 10 },
      { type: 'number', name: 'rateLimitBurst', message: 'Burst queue:', default: 20 },
    ]);
    security.rateLimitRate = rateDetails.rateLimitRate;
    security.rateLimitBurst = rateDetails.rateLimitBurst;
  }

  const secHeaders = await inquirer.prompt([
    { type: 'confirm', name: 'securityHeaders', message: 'Add security headers?', default: false },
    { type: 'confirm', name: 'custom404', message: 'Custom 404 page?', default: false },
    { type: 'confirm', name: 'custom50x', message: 'Custom 50x page?', default: false },
  ]);
  security = { ...security, ...secHeaders };

  // Section 6: Advanced (optional)
  const { configureAdvanced } = await inquirer.prompt([
    { type: 'confirm', name: 'configureAdvanced', message: 'Configure advanced options?', default: false },
  ]);

  let advanced = { ...DOMAIN_DEFAULTS.advanced };

  if (configureAdvanced) {
    const advDetails = await inquirer.prompt([
      { type: 'confirm', name: 'accessLog', message: 'Enable domain access log?', default: true },
      { type: 'editor', name: 'customLocations', message: 'Custom location blocks (nginx):', default: '' },
    ]);
    advanced = advDetails;
  }

  // Build domain object
  const domain = createDomain({
    name: basic.name,
    port: basic.port,
    backendHost: basic.backendHost,
    upstreamType: basic.upstreamType,
    www: basic.www,
    ssl,
    performance,
    security,
    advanced,
  });

  // Generate conf and test
  const spinner = ora('Generating nginx config...').start();
  const { nginxDir } = loadConfig();

  try {
    await generateConf(domain);
  } catch (err) {
    spinner.fail('Failed to generate config');
    console.log(chalk.red(err.message));
    return;
  }

  spinner.text = 'Testing config...';
  const testResult = await run(nginxTestCmd(nginxDir), { cwd: nginxDir });

  if (!testResult.success) {
    spinner.fail('Config test failed');
    console.log(chalk.red('\n' + combineOutput(testResult)));
    // Clean up failed config
    try { await import('fs/promises').then(fs => fs.unlink(domain.configFile)); } catch { /* ignore */ }
    return;
  }

  // Save domain
  const domains = getDomains();
  domains.push(domain);
  saveDomains(domains);

  spinner.succeed('Domain added successfully');
  console.log(chalk.gray(` Config: ${domain.configFile}\n`));
}

// ─── Edit Domain ───────────────────────────────────────────────────────

async function editDomainAction() {
  const domains = getDomains();

  if (domains.length === 0) {
    console.log(chalk.yellow('\n No domains to edit.\n'));
    return;
  }

  const { selectedName } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedName',
      message: 'Select domain to edit:',
      choices: domains.map(d => d.name),
    },
  ]);

  const existing = findDomain(selectedName);
  if (!existing) return;

  console.log(chalk.bold(`\n Editing: ${selectedName}\n`));

  // Prompt for each field with current value as default
  const updates = await inquirer.prompt([
    { type: 'input', name: 'backendHost', message: 'Backend host:', default: existing.backendHost || '127.0.0.1' },
    { type: 'number', name: 'port', message: 'Backend port:', default: existing.port },
    {
      type: 'list', name: 'upstreamType', message: 'Upstream type:', default: existing.upstreamType || 'http',
      choices: ['http', 'https', 'ws'],
    },
    { type: 'confirm', name: 'www', message: 'Include www?', default: existing.www || false },
    { type: 'confirm', name: 'sslEnabled', message: 'SSL enabled?', default: existing.ssl?.enabled || false },
  ]);

  const domain = { ...existing };

  // Update fields
  domain.backendHost = updates.backendHost;
  domain.port = updates.port;
  domain.upstreamType = updates.upstreamType;
  domain.www = updates.www;
  domain.ssl.enabled = updates.sslEnabled;

  // Regenerate config
  const spinner = ora('Regenerating config...').start();
  const { nginxDir } = loadConfig();

  try {
    await generateConf(domain);
  } catch (err) {
    spinner.fail('Failed to generate config');
    return;
  }

  spinner.text = 'Testing config...';
  const testResult = await run(nginxTestCmd(nginxDir), { cwd: nginxDir });

  if (!testResult.success) {
    spinner.fail('Config test failed');
    console.log(chalk.red('\n' + combineOutput(testResult)));
    return;
  }

  // Save
  const allDomains = getDomains();
  const idx = allDomains.findIndex(d => d.name === selectedName);
  allDomains[idx] = domain;
  saveDomains(allDomains);

  spinner.succeed('Domain updated successfully\n');
}

// ─── Delete Domain ─────────────────────────────────────────────────────

async function deleteDomainAction() {
  const domains = getDomains();

  if (domains.length === 0) {
    console.log(chalk.yellow('\n No domains to delete.\n'));
    return;
  }

  const { selectedName, confirm } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedName',
      message: 'Select domain to delete:',
      choices: domains.map(d => d.name),
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Are you sure?',
      default: false,
    },
  ]);

  if (!confirm) {
    console.log(chalk.gray('\n Cancelled.\n'));
    return;
  }

  const domain = findDomain(selectedName);
  if (!domain) return;

  // Delete config file
  if (domain.configFile) {
    const { default: fs } = await import('fs/promises');
    try {
      await fs.unlink(domain.configFile);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.log(chalk.yellow(`Warning: Could not delete ${domain.configFile}`));
      }
    }
  }

  // Remove from storage
  const remaining = domains.filter(d => d.name !== selectedName);
  saveDomains(remaining);

  console.log(chalk.green(`\n Domain "${selectedName}" deleted.\n`));
}

// ─── Reload Nginx ──────────────────────────────────────────────────────

async function reloadNginxAfterChange() {
  const { nginxDir } = loadConfig();
  const spinner = ora('Reloading nginx...').start();

  const testResult = await run(nginxTestCmd(nginxDir), { cwd: nginxDir });
  if (!testResult.success) {
    spinner.fail('Config test failed');
    console.log(chalk.red('\n' + combineOutput(testResult)));
    return false;
  }

  const reloadResult = await run(nginxReloadCmd(nginxDir), { cwd: nginxDir });
  if (!reloadResult.success) {
    spinner.fail('Reload failed');
    console.log(chalk.red('\n' + combineOutput(reloadResult)));
    return false;
  }

  spinner.succeed('Nginx reloaded');
  return true;
}

// ─── Main Menu (T026, T029-T033) ──────────────────────────────────────────────

export async function showDomainManager() {
  while (true) {
    const domains = getDomains();

    console.log(chalk.bold('\n Domain Manager'));
    console.log(chalk.gray(' ' + '─'.repeat(40)));
    console.log(` ${chalk.blue(domains.length)} domain${domains.length !== 1 ? 's' : ''} configured`);
    console.log();

    const choices = [
      'List Domains',
      'Add Domain',
      'Edit Domain',
      'Delete Domain',
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
      case 'List Domains':
        await listDomainsAction();
        break;
      case 'Add Domain':
        await addDomainAction();
        break;
      case 'Edit Domain':
        await editDomainAction();
        break;
      case 'Delete Domain':
        await deleteDomainAction();
        break;
      case '← Back':
        return;
    }

    if (choice !== '← Back') {
      await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
    }
  }
}
