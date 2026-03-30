/**
 * cli/managers/ssl-manager.js
 *
 * SSL Manager — view certificate status, renew certificates, install certbot.
 *
 * Exported functions:
 *   - showSslManager() — interactive menu for managing SSL certificates
 *
 * All shell calls go through core/shell.js (run / runLive).
 * Platform differences (Windows/Linux) are handled via isWindows guards.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import fs from 'fs/promises';
import path from 'path';
import { run, runLive } from '../../core/shell.js';
import { loadConfig } from '../../core/config.js';

const isWindows = process.platform === 'win32';

// ─── getCertbotDir ────────────────────────────────────────────────────────────

function getCertbotDir() {
  const config = loadConfig();
  return path.join(config.certbotDir, 'live');
}

// ─── parseCertExpiry ──────────────────────────────────────────────────────────

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

// ─── getCertbotExe ────────────────────────────────────────────────────────────
// Returns the certbot command to use, or null if not installed.
// On Windows, checks PATH first, then the well-known install location used by
// the official EFF winget package (EFF.Certbot).
// Always returns a PS-safe invocation string (& "..." for full paths).

const CERTBOT_WIN_EXE = 'C:\\Program Files\\Certbot\\bin\\certbot.exe';

async function getCertbotExe() {
  if (!isWindows) {
    const r = await run('which certbot');
    return (r.exitCode === 0 && r.stdout.trim()) ? 'certbot' : null;
  }

  // 1. On PATH?
  const pathResult = await run('where.exe certbot');
  if (pathResult.exitCode === 0 && pathResult.stdout.trim()) {
    return 'certbot';
  }

  // 2. Well-known install location (winget / official EFF installer)
  const exeCheck = await run(`Test-Path "${CERTBOT_WIN_EXE}"`);
  if (exeCheck.stdout.trim().toLowerCase() === 'true') {
    // Must use & "..." in PowerShell to invoke a path with spaces
    return `& "${CERTBOT_WIN_EXE}"`;
  }

  return null;
}

async function isCertbotInstalled() {
  return (await getCertbotExe()) !== null;
}

// ─── isPort80Busy ─────────────────────────────────────────────────────────────

async function isPort80Busy() {
  const cmd = isWindows
    ? 'netstat -ano | findstr ":80"'
    : "ss -tlnp | grep ':80 '";
  const result = await run(cmd);
  const busy = result.success && result.stdout.length > 0;
  return { busy, detail: busy ? result.stdout.split('\n')[0].trim() : null };
}

// ─── stopNginx / startNginx ───────────────────────────────────────────────────

async function stopNginx() {
  const { nginxDir } = loadConfig();
  const cmd = isWindows
    ? 'taskkill /f /IM nginx.exe'
    : 'systemctl stop nginx';
  await run(cmd);
}

async function startNginx() {
  const { nginxDir } = loadConfig();
  const cmd = isWindows
    ? `& "${nginxDir}\\nginx.exe"`
    : 'systemctl start nginx';
  await run(cmd);
}

// ─── listCerts ────────────────────────────────────────────────────────────────

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
    const certPath = path.join(liveDir, domain, 'cert.pem');

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

// ─── renderCertRow ────────────────────────────────────────────────────────────

function renderCertRow(cert) {
  const domainPadded = cert.domain.padEnd(35);

  if (cert.status === 'error') {
    console.log(`  ${chalk.gray('❌')} ${chalk.gray(domainPadded)} ${chalk.gray('ERROR')}`);
    return;
  }

  const expiryStr = cert.expiryDate
    ? cert.expiryDate.toDateString().replace(/^\S+\s/, '')
    : '—';
  const daysStr = cert.daysLeft !== null ? `${cert.daysLeft}d` : '—';

  if (cert.status === 'healthy') {
    console.log(`  ${chalk.green('✅')} ${chalk.green(domainPadded)} ${chalk.green(daysStr.padEnd(6))} ${chalk.green(`(${expiryStr})`)}`);
  } else if (cert.status === 'expiring') {
    console.log(`  ${chalk.yellow('⚠️')}  ${chalk.yellow(domainPadded)} ${chalk.yellow(daysStr.padEnd(6))} ${chalk.yellow(`(${expiryStr})`)}`);
  } else {
    console.log(`  ${chalk.red('❌')} ${chalk.red(domainPadded)} ${chalk.red(daysStr.padEnd(6))} ${chalk.red(`(${expiryStr})`)}`);
  }
}

// ─── renewCert ────────────────────────────────────────────────────────────────

async function renewCert(domain) {
  const certbotExe = await getCertbotExe();
  if (!certbotExe) {
    console.log(chalk.red('\n  certbot not found — install it first\n'));
    return { domain, success: false, exitCode: null };
  }

  await stopNginx();

  try {
    const portCheck = await isPort80Busy();
    if (portCheck.busy) {
      console.log(chalk.yellow(`\n  ⚠ Port 80 is in use: ${portCheck.detail}`));
      console.log(chalk.yellow('  Stop that process before renewing.\n'));
      return { domain, success: false, exitCode: null };
    }

    const exitCode = await runLive(
      `${certbotExe} certonly --standalone -d "${domain}"`,
      { timeout: 120000 },
    );
    return { domain, success: exitCode === 0, exitCode };
  } finally {
    await startNginx();
  }
}

// ─── renewExpiring ────────────────────────────────────────────────────────────

async function renewExpiring(certs) {
  const expiring = certs.filter(c => c.daysLeft !== null && c.daysLeft < 30);
  if (expiring.length === 0) return [];

  const certbotExe = await getCertbotExe();
  if (!certbotExe) return [];

  await stopNginx();

  const results = [];
  try {
    for (const cert of expiring) {
      const exitCode = await runLive(
        `${certbotExe} certonly --standalone -d "${cert.domain}"`,
        { timeout: 120000 },
      );
      results.push({ domain: cert.domain, success: exitCode === 0, exitCode });
    }
  } finally {
    await startNginx();
  }

  return results;
}

// ─── installCertbot ───────────────────────────────────────────────────────────

async function installCertbot() {
  if (!isWindows) {
    const exitCode = await runLive('sudo apt-get install -y certbot', { timeout: 180000 });
    return { success: exitCode === 0 };
  }

  // ── Windows: winget → Chocolatey → direct EFF installer ──────────────────────

  // 1. Try winget (Windows 10/11 desktop; not on Windows Server by default)
  const wingetCheck = await run('where.exe winget 2>$null');
  if (wingetCheck.success && wingetCheck.stdout.trim().length > 0) {
    console.log(chalk.gray('\n  Installing via winget (EFF.Certbot) ...\n'));
    const exitCode = await runLive(
      'winget install -e --id EFF.Certbot --accept-package-agreements --accept-source-agreements',
      { timeout: 180000 },
    );
    if (exitCode === 0) {
      const check = await run(`Test-Path "${CERTBOT_WIN_EXE}"`);
      return { success: check.stdout.trim().toLowerCase() === 'true' };
    }
    console.log(chalk.yellow('  winget failed, trying Chocolatey...\n'));
  }

  // 2. Try Chocolatey (common on Windows Server)
  const chocoCheck = await run('where.exe choco 2>$null');
  if (chocoCheck.success && chocoCheck.stdout.trim().length > 0) {
    console.log(chalk.gray('\n  Installing via Chocolatey ...\n'));
    const exitCode = await runLive('choco install certbot -y', { timeout: 180000 });
    if (exitCode === 0) {
      const check = await run(`Test-Path "${CERTBOT_WIN_EXE}"`);
      return { success: check.stdout.trim().toLowerCase() === 'true' };
    }
    console.log(chalk.yellow('  Chocolatey failed, trying direct download...\n'));
  }

  // 3. Direct download — try multiple sources × multiple download methods
  //    PowerShell 5.1 on Windows Server defaults to TLS 1.0; GitHub requires TLS 1.2+.
  //    Force TLS 1.2 before every Invoke-WebRequest call.
  //    Also try curl.exe (built into Windows Server 2019+) as a second method.
  const INSTALLER_FILENAME = 'certbot-beta-installer-win_amd64_signed.exe';
  const INSTALLER_DEST     = '$env:TEMP\\certbot-installer.exe';
  const downloadSources = [
    `https://github.com/certbot/certbot/releases/latest/download/${INSTALLER_FILENAME}`,
    `https://dl.eff.org/${INSTALLER_FILENAME}`,
  ];

  const hasCurl = (await run('where.exe curl.exe 2>$null')).success;

  let downloaded = false;
  for (const url of downloadSources) {
    const label = new URL(url).hostname;
    console.log(chalk.gray(`\n  Downloading certbot installer from ${label} ...\n`));

    // Method A: Invoke-WebRequest with TLS 1.2 forced
    const iwr = await run(
      `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile "${INSTALLER_DEST}" -UseBasicParsing -TimeoutSec 120`,
      { timeout: 130000 },
    );
    if (iwr.success) { downloaded = true; break; }

    // Method B: curl.exe (handles TLS independently of PowerShell/.NET settings)
    if (hasCurl) {
      const curlResult = await run(
        `curl.exe -L --silent --show-error --max-time 120 -o "${INSTALLER_DEST}" "${url}"`,
        { timeout: 130000 },
      );
      if (curlResult.success) { downloaded = true; break; }
    }

    console.log(chalk.yellow(`  Failed from ${label}`));
  }

  if (!downloaded) {
    console.log(chalk.red('\n  Download failed from all sources.'));
    console.log(chalk.gray('  Install manually: https://certbot.eff.org/instructions?ws=other&os=windows\n'));
    return { success: false };
  }

  console.log(chalk.gray('  Running installer silently ...\n'));

  await run(
    `Start-Process -FilePath "$env:TEMP\\certbot-installer.exe" -ArgumentList '/S' -Wait -NoNewWindow`,
    { timeout: 120000 },
  );

  // Cleanup installer
  await run(`Remove-Item -Force "$env:TEMP\\certbot-installer.exe" -ErrorAction SilentlyContinue`);

  // Verify
  const check = await run(`Test-Path "${CERTBOT_WIN_EXE}"`);
  return { success: check.stdout.trim().toLowerCase() === 'true' };
}

// ─── showSslManager ───────────────────────────────────────────────────────────

export async function showSslManager() {
  while (true) {
    const liveDir = getCertbotDir();

    const spinner = ora('Loading certificates…').start();
    const certs = await listCerts(liveDir);
    spinner.stop();

    console.log(chalk.bold('\n  SSL Manager'));
    console.log(chalk.gray('  ' + '─'.repeat(40)));

    if (certs.length === 0) {
      console.log(chalk.gray('  No certificates found'));
    } else {
      for (const cert of certs) {
        renderCertRow(cert);
      }
    }
    console.log();

    const choices = [
      'Renew a certificate',
      'Renew all expiring (< 30 days)',
      'Install certbot',
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
      case 'Renew a certificate': {
        const installed = await isCertbotInstalled();
        if (!installed) {
          console.log(chalk.yellow('\n  ⚠ certbot not found — select "Install certbot" first\n'));
          break;
        }

        if (certs.length === 0) {
          console.log(chalk.gray('\n  No certificates found to renew\n'));
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

        const renewResult = await renewCert(selectedDomain);
        if (renewResult.success) {
          console.log(chalk.green('\n  ✓ Renewed successfully\n'));
        } else {
          console.log(chalk.red('\n  ✗ Renewal failed — see output above\n'));
        }
        break;
      }

      case 'Renew all expiring (< 30 days)': {
        const installed = await isCertbotInstalled();
        if (!installed) {
          console.log(chalk.yellow('\n  ⚠ certbot not found — select "Install certbot" first\n'));
          break;
        }

        const results = await renewExpiring(certs);
        if (results.length === 0) {
          console.log(chalk.gray('\n  No certificates expiring within 30 days\n'));
        } else {
          console.log();
          for (const r of results) {
            if (r.success) {
              console.log(`  ${chalk.green('✓ ' + r.domain)}`);
            } else {
              console.log(`  ${chalk.red('✗ ' + r.domain)}`);
            }
          }
          console.log();
        }
        break;
      }

      case 'Install certbot': {
        const alreadyInstalled = await isCertbotInstalled();
        if (alreadyInstalled) {
          console.log(chalk.gray('\n  certbot is already installed\n'));
          break;
        }

        const installResult = await installCertbot();
        if (installResult.success) {
          console.log(chalk.green('\n  ✓ certbot installed successfully\n'));
        } else {
          console.log(chalk.red('\n  ✗ Installation failed\n'));
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
