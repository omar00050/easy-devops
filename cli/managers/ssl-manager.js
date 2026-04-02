/**
 * cli/managers/ssl-manager.js
 *
 * SSL Manager — view certificate status, renew certificates, install certbot/win-acme.
 *
 * Exported functions:
 * - showSslManager() — interactive menu for managing SSL certificates
 *
 * All shell calls go through core/shell.js (run / runLive).
 * Platform differences (Windows/Linux) are handled via isWindows guards.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { run, runLive, getShell } from '../../core/shell.js';
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

// ─── ACME Client Detection ────────────────────────────────────────────────────
// Supports both certbot and win-acme on Windows

const CERTBOT_WIN_EXE = 'C:\\Program Files\\Certbot\\bin\\certbot.exe';
const WINACME_EXE = 'C:\\simple-acme\\wacs.exe';
const WINACME_EXE_FALLBACK = 'C:\\Program Files\\win-acme\\wacs.exe';

async function getCertbotExe() {
  if (!isWindows) {
    const r = await run('which certbot');
    return (r.exitCode === 0 && r.stdout.trim()) ? 'certbot' : null;
  }

  // 1. simple-acme (wacs) on PATH?
  const wacsPathResult = await run('where.exe wacs');
  if (wacsPathResult.exitCode === 0 && wacsPathResult.stdout.trim()) {
    return 'wacs';
  }

  // 2. simple-acme primary location (C:\simple-acme\wacs.exe)
  const wacsCheck = await run(`Test-Path "${WINACME_EXE}"`);
  if (wacsCheck.stdout.trim().toLowerCase() === 'true') {
    return `& "${WINACME_EXE}"`;
  }

  // 3. simple-acme fallback location (C:\Program Files\win-acme\wacs.exe)
  const wacsFallbackCheck = await run(`Test-Path "${WINACME_EXE_FALLBACK}"`);
  if (wacsFallbackCheck.stdout.trim().toLowerCase() === 'true') {
    return `& "${WINACME_EXE_FALLBACK}"`;
  }

  // 4. certbot on PATH?
  const pathResult = await run('where.exe certbot');
  if (pathResult.exitCode === 0 && pathResult.stdout.trim()) {
    return 'certbot';
  }

  // 5. certbot well-known location
  const exeCheck = await run(`Test-Path "${CERTBOT_WIN_EXE}"`);
  if (exeCheck.stdout.trim().toLowerCase() === 'true') {
    return `& "${CERTBOT_WIN_EXE}"`;
  }

  return null;
}

async function isCertbotInstalled() {
  return (await getCertbotExe()) !== null;
}

async function getAcmeClientType() {
  const exe = await getCertbotExe();
  if (!exe) return null;
  if (exe.includes('wacs')) return 'winacme';
  return 'certbot';
}

// ─── isPort80Busy ─────────────────────────────────────────────────────────────

async function isPort80Busy() {
  const cmd = isWindows
    ? 'netstat -ano | findstr /R "0.0.0.0:80 " | findstr "LISTENING"'
    : "ss -tlnp | grep ':80'";
  const result = await run(cmd);
  const busy = result.success && result.stdout.trim().length > 0;
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

// ─── renewCert ────────────────────────────────────────────────────────────────

async function renewCert(domain) {
  const certbotExe = await getCertbotExe();
  if (!certbotExe) {
    console.log(chalk.red('\n certbot/win-acme not found — install it first\n'));
    return { domain, success: false, exitCode: null };
  }

  const clientType = await getAcmeClientType();

  await stopNginx();

  try {
    const portCheck = await isPort80Busy();
    if (portCheck.busy) {
      console.log(chalk.yellow(`\n ⚠ Port 80 is in use: ${portCheck.detail}`));
      console.log(chalk.yellow(' Stop that process before renewing.\n'));
      return { domain, success: false, exitCode: null };
    }

    let cmd;
    if (clientType === 'winacme') {
      // win-acme interactive mode - needs manual input
      console.log(chalk.cyan('\n win-acme will open. Follow the prompts to renew the certificate.'));
      console.log(chalk.cyan(' Select: N) Create new certificate → 2) Manual input → enter domain\n'));
      cmd = certbotExe;
    } else {
      cmd = `${certbotExe} certonly --standalone -d "${domain}"`;
    }

    const exitCode = await runLive(cmd, { timeout: 120000 });
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

  const clientType = await getAcmeClientType();

  await stopNginx();

  const results = [];
  try {
    for (const cert of expiring) {
      let cmd;
      if (clientType === 'winacme') {
        console.log(chalk.cyan(`\n Renewing ${cert.domain} with win-acme - follow the prompts\n`));
        cmd = certbotExe;
      } else {
        cmd = `${certbotExe} certonly --standalone -d "${cert.domain}"`;
      }
      const exitCode = await runLive(cmd, { timeout: 120000 });
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

  // ── Shared helpers ────────────────────────────────────────────────────────────

  async function verifyCertbot() {
    const whereResult = await run('where.exe certbot 2>$null');
    if (whereResult.success && whereResult.stdout.trim()) return true;
    const paths = [
      CERTBOT_WIN_EXE,
      'C:\\Program Files (x86)\\Certbot\\bin\\certbot.exe',
      'C:\\Certbot\\bin\\certbot.exe',
    ];
    for (const p of paths) {
      const r = await run(`Test-Path '${p}'`);
      if (r.stdout.trim().toLowerCase() === 'true') return true;
    }
    return false;
  }

  async function verifyWinAcme() {
    const paths = [
      WINACME_EXE,
      'C:\\Program Files (x86)\\win-acme\\wacs.exe',
      'C:\\simple-acme\\wacs.exe',
    ];
    for (const p of paths) {
      const r = await run(`Test-Path '${p}'`);
      if (r.stdout.trim().toLowerCase() === 'true') return true;
    }
    const whereResult = await run('where.exe wacs 2>$null');
    return whereResult.success && whereResult.stdout.trim();
  }

  const hasCurl = (await run('where.exe curl.exe 2>$null')).success;
  let lastDownloadError = '';

  async function downloadFile(url, dest, showErrors = false) {
    const safeUrl = url.replace(/'/g, "''");
    const safeDest = dest.replace(/'/g, "''");

    // Enable all TLS versions (1.0, 1.1, 1.2, 1.3) for maximum compatibility
    const tlsSetup = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13`;

    // Helper to safely run a command and catch EPERM errors
    const safeRun = async (cmd, opts) => {
      try {
        return await run(cmd, opts);
      } catch (err) {
        // Re-throw EPERM so caller can handle Windows Defender blocks
        if (err.code === 'EPERM' || err.message?.includes('EPERM')) {
          throw err;
        }
        return { success: false, stdout: '', stderr: err.message, exitCode: null };
      }
    };

    // Method 1: Invoke-WebRequest with all TLS versions
    let r = await safeRun(
      `${tlsSetup}; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${safeUrl}' -OutFile '${safeDest}' -UseBasicParsing -TimeoutSec 120`,
      { timeout: 130000 },
    );
    if (r.success) return true;
    if (showErrors && r.stderr) lastDownloadError = `Invoke-WebRequest: ${r.stderr}`;

    // Method 2: curl.exe (works on Windows 10+, often bypasses AV detection)
    if (hasCurl) {
      r = await safeRun(
        `curl.exe -L --ssl-no-revoke --max-time 120 -o '${safeDest}' '${safeUrl}'`,
        { timeout: 130000 },
      );
      if (r.success) return true;
      if (showErrors && r.stderr && !lastDownloadError) lastDownloadError = `curl: ${r.stderr}`;
    }

    // Method 3: WebClient with TLS
    r = await safeRun(
      `${tlsSetup}; (New-Object System.Net.WebClient).DownloadFile('${safeUrl}','${safeDest}')`,
      { timeout: 130000 },
    );
    if (r.success) return true;
    if (showErrors && r.stderr && !lastDownloadError) lastDownloadError = `WebClient: ${r.stderr}`;

    // Method 4: HttpClient with custom handler
    r = await safeRun(
      `${tlsSetup}; $handler=[System.Net.Http.HttpClientHandler]::new(); $handler.ServerCertificateCustomValidationCallback={$true}; $handler.AllowAutoRedirect=$true; $hc=[System.Net.Http.HttpClient]::new($handler); $hc.DefaultRequestHeaders.Add('User-Agent','Mozilla/5.0 (Windows NT 10.0; Win64; x64)'); $hc.Timeout=[TimeSpan]::FromSeconds(120); $bytes=$hc.GetByteArrayAsync('${safeUrl}').GetAwaiter().GetResult(); [System.IO.File]::WriteAllBytes('${safeDest}',$bytes)`,
      { timeout: 130000 },
    );
    if (r.success) return true;
    if (showErrors && r.stderr && !lastDownloadError) lastDownloadError = `HttpClient: ${r.stderr}`;

    // Method 5: BITS Transfer (background transfers)
    r = await safeRun(
      `Import-Module BitsTransfer -ErrorAction SilentlyContinue; Start-BitsTransfer -Source '${safeUrl}' -Destination '${safeDest}' -ErrorAction Stop`,
      { timeout: 130000 },
    );
    if (r.success) return true;
    if (showErrors && r.stderr && !lastDownloadError) lastDownloadError = `BITS: ${r.stderr}`;

    // Note: certutil.exe removed - it triggers Trojan:Win32/Ceprolad.A detection

    return false;
  }

  async function runNsisInstaller(exePath) {
    await run(
      `$p = Start-Process -FilePath '${exePath}' -ArgumentList '/S' -PassThru -Wait; $p.ExitCode`,
      { timeout: 120000 },
    );
    await new Promise(res => setTimeout(res, 4000));
    return verifyCertbot();
  }

  let methodNum = 0;
  function step(label) {
    methodNum++;
    console.log(chalk.gray(`\n [${methodNum}] ${label}\n`));
  }

  // ── Check winget availability and offer to install if missing ─────────────────
  let wingetAvailable = false;
  const wingetCheck = await run('where.exe winget 2>$null');
  wingetAvailable = wingetCheck.success && wingetCheck.stdout.trim();

  if (!wingetAvailable) {
    console.log(chalk.yellow('\n ⚠ winget is not installed on this system.'));
    console.log(chalk.gray(' winget (Windows Package Manager) provides the easiest installation method.'));

    let installWinget;
    try {
      ({ installWinget } = await inquirer.prompt([{
        type: 'confirm',
        name: 'installWinget',
        message: 'Would you like to install winget automatically?',
        default: true,
      }]));
    } catch { /* user cancelled */ }

    if (installWinget) {
      console.log(chalk.cyan('\n Opening winget installer in a new window...'));
      console.log(chalk.gray(' The installer will run in a separate PowerShell window.'));
      console.log(chalk.gray(' Please complete the installation in that window.\n'));

      // Use the embedded winget-install.ps1 script
      const scriptDir = path.dirname(fileURLToPath(import.meta.url));
      const wingetScriptPath = path.join(scriptDir, '..', '..', 'lib', 'installer', 'winget-install.ps1');

      // Check if the embedded script exists
      const scriptExists = await run(`Test-Path "${wingetScriptPath}"`);
      if (scriptExists.stdout.trim().toLowerCase() !== 'true') {
        console.log(chalk.red('\n Embedded winget installer script not found.'));
        console.log(chalk.gray(' Expected location: ' + wingetScriptPath + '\n'));
      } else {
        // Run the installer in a new PowerShell window with -NoExit so user can see output
        // The script has a built-in -NoExit parameter we can use
        await run(`Start-Process powershell.exe -ArgumentList '-ExecutionPolicy Bypass -NoProfile -File "${wingetScriptPath}" -NoExit' -Verb RunAs -Wait`);

        console.log(chalk.gray('\n Winget installer window has closed.'));
        console.log(chalk.cyan(' Checking if winget is now available...\n'));

        // Give a moment for PATH to update
        await new Promise(res => setTimeout(res, 2000));

        // Re-check for winget
        const recheck = await run('where.exe winget 2>$null');
        if (recheck.success && recheck.stdout.trim()) {
          console.log(chalk.green(' ✓ winget installed successfully!\n'));
          wingetAvailable = true;
        } else {
          // Try refreshing PATH from registry and check again
          console.log(chalk.yellow(' winget not immediately detected. Refreshing PATH...'));
          await run(`$env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')`);
          await new Promise(res => setTimeout(res, 1000));

          const recheck2 = await run('where.exe winget 2>$null');
          if (recheck2.success && recheck2.stdout.trim()) {
            console.log(chalk.green('\n ✓ winget installed successfully!\n'));
            wingetAvailable = true;
          } else {
            console.log(chalk.yellow('\n winget may have been installed but is not in PATH yet.'));
            console.log(chalk.gray(' You may need to restart your terminal or computer.\n'));
          }
        }
      }

      // If still no winget, continue with other methods
      if (!wingetAvailable) {
        console.log(chalk.gray(' Continuing with alternative installation methods...\n'));
      }
    } else {
      console.log(chalk.gray(' Skipping winget installation. Using alternative methods...\n'));
    }
  }

  // ── Method 1: winget (certbot EFF - most reliable) ────────────────────────────
  if (wingetAvailable) {
    step('Trying winget (EFF.Certbot) ...');
    console.log(chalk.gray(' Running: winget install EFF.Certbot\n'));
    const exitCode = await runLive(
      'winget install -e --id EFF.Certbot --accept-package-agreements --accept-source-agreements',
      { timeout: 180000 },
    );

    step('Trying winget (win-acme) as fallback to support more Windows-friendly client ...');
    console.log(chalk.gray(' Running: winget install simple-acme.simple-acme\n'));
    const exitCode_2 = await runLive(
      'winget install -e --id simple-acme.simple-acme --location "C:\simple-acme" --accept-package-agreements --accept-source-agreements',
      { timeout: 180000 },
    );

    if (exitCode_2 === 0 || await verifyWinAcme()) step('winget simple-acme installed successfully!');

    await runLive("wacs --version", { timeout: 5000 }); // Trigger any first-run setup for win-acme

    if (exitCode === 0 || await verifyCertbot()) return { success: true };
    console.log(chalk.yellow(' winget certbot failed, trying next...\n'));
  }

  // ── Method 2: winget (win-acme) ───────────────────────────────────────────────
  if (wingetAvailable) {
    step('Trying winget (win-acme) ...');
    console.log(chalk.gray(' Running: winget install simple-acme.simple-acme\n'));
    const exitCode = await runLive(
      'winget install -e --id simple-acme.simple-acme --location "C:\simple-acme" --accept-package-agreements --accept-source-agreements',
      { timeout: 180000 },
    );
    if (exitCode === 0 || await verifyWinAcme()) return { success: true, client: 'winacme' };
    console.log(chalk.yellow(' winget simple-acme failed, trying next...\n'));
  }

  // ── Method 3: Chocolatey (win-acme) ───────────────────────────────────────────
  if ((await run('where.exe choco 2>$null')).success) {
    step('Trying Chocolatey (win-acme) ...');
    const exitCode = await runLive('choco install win-acme -y', { timeout: 180000 });
    if (exitCode === 0 || await verifyWinAcme()) return { success: true, client: 'winacme' };
    console.log(chalk.yellow(' Chocolatey win-acme failed, trying next...\n'));
  }

  // ── Method 4: Chocolatey (certbot) ────────────────────────────────────────────
  if ((await run('where.exe choco 2>$null')).success) {
    step('Trying Chocolatey (certbot) ...');
    const exitCode = await runLive('choco install certbot -y', { timeout: 180000 });
    if (exitCode === 0 || await verifyCertbot()) return { success: true };
    console.log(chalk.yellow(' Chocolatey certbot failed, trying next...\n'));
  }

  // ── Method 5: pip (certbot) ───────────────────────────────────────────────────
  for (const pip of ['pip', 'pip3']) {
    const check = await run(`where.exe ${pip} 2>$null`);
    if (check.success && check.stdout.trim()) {
      step(`Trying ${pip} install certbot ...`);
      const exitCode = await runLive(`${pip} install certbot`, { timeout: 180000 });
      if (exitCode === 0 || await verifyCertbot()) return { success: true };
      console.log(chalk.yellow(` ${pip} did not install certbot, trying next...\n`));
      break;
    }
  }

  // ── Method 6: Scoop (win-acme) ────────────────────────────────────────────────
  if ((await run('where.exe scoop 2>$null')).success) {
    step('Trying Scoop (win-acme) ...');
    await runLive('scoop bucket add extras', { timeout: 60000 });
    const exitCode = await runLive('scoop install win-acme', { timeout: 180000 });
    if (exitCode === 0 || await verifyWinAcme()) return { success: true, client: 'winacme' };
    console.log(chalk.yellow(' Scoop win-acme failed, trying next...\n'));
  }

  // ── Method 7: Direct download win-acme (ZIP - smaller, no installer) ──────────
  const WINACME_DEST = 'C:\\Program Files\\simple-acme';

  step('Downloading simple-acme from GitHub ...');
  const winAcmeUrls = [
    'https://github.com/win-acme/win-acme/archive/refs/tags/v2.2.9.1701.zip',
  ];

  for (const url of winAcmeUrls) {
    const hostname = new URL(url).hostname;
    console.log(chalk.gray(` Downloading from ${hostname} ...`));

    const zipDest = `$env:TEMP\\win-acme.zip`;
    lastDownloadError = '';
    let dlOk = false;
    try { dlOk = await downloadFile(url, zipDest, true); } catch (err) {
      if (err.code === 'EPERM' || err.message?.includes('EPERM')) {
        console.log(chalk.red('Windows Defender blocked this download.'));
        console.log(chalk.gray('Use the manual installer option or add a Windows Defender exclusion.'));
      }
    }
    if (dlOk) {
      console.log(chalk.gray(' Extracting win-acme ...\n'));
      await run(`New-Item -ItemType Directory -Force -Path '${WINACME_DEST}'`);
      await run(`Expand-Archive -Path '${zipDest}' -DestinationPath '${WINACME_DEST}' -Force`);
      await run(`Remove-Item -Force '${zipDest}' -ErrorAction SilentlyContinue`);

      if (await verifyWinAcme()) {
        console.log(chalk.green(` win-acme installed to ${WINACME_DEST}\n`));
        return { success: true, client: 'winacme' };
      }
      console.log(chalk.yellow(' Extraction succeeded but verification failed, trying next...\n'));
    } else {
      console.log(chalk.yellow(` Could not download from ${hostname}`));
      if (lastDownloadError) {
        console.log(chalk.gray(` Error: ${lastDownloadError.substring(0, 200)}\n`));
      }
    }
  }

  // ── Method 8: Direct download certbot installer ────────────────────────────────
  const INSTALLER_FILENAME = 'certbot-beta-installer-win_amd64_signed.exe';
  const INSTALLER_DEST = `$env:TEMP\\${INSTALLER_FILENAME}`;
  const certbotUrls = [
    `https://dl.eff.org/${INSTALLER_FILENAME}`,
    `https://github.com/certbot/certbot/releases/latest/download/${INSTALLER_FILENAME}`,
  ];

  for (const url of certbotUrls) {
    const hostname = new URL(url).hostname;
    step(`Downloading certbot installer from ${hostname} ...`);

    lastDownloadError = '';
    let dlOk = false;
    try { dlOk = await downloadFile(url, INSTALLER_DEST, true); } catch (err) {
      if (err.code === 'EPERM' || err.message?.includes('EPERM')) {
        console.log(chalk.red('Windows Defender blocked this download.'));
        console.log(chalk.gray('Use the manual installer option or add a Windows Defender exclusion.'));
      }
    }
    if (dlOk) {
      console.log(chalk.gray(' Running installer silently ...\n'));
      const ok = await runNsisInstaller(INSTALLER_DEST);
      await run(`Remove-Item -Force '${INSTALLER_DEST}' -ErrorAction SilentlyContinue`);
      if (ok) return { success: true };
      console.log(chalk.yellow(' Installer ran but certbot not detected, trying next...\n'));
    } else {
      console.log(chalk.yellow(` Could not download from ${hostname}`));
      if (lastDownloadError) {
        console.log(chalk.gray(` Error: ${lastDownloadError.substring(0, 200)}\n`));
      }
    }
  }

  // ── Method 9: Manual installer path ───────────────────────────────────────────
  console.log(chalk.yellow('\n All automatic methods failed.'));
  console.log(chalk.gray(' You can manually download one of these on another PC:'));
  console.log(chalk.gray(' • certbot: https://certbot.eff.org/instructions?ws=other&os=windows'));
  console.log(chalk.gray(' • win-acme: https://github.com/win-acme/win-acme/releases'));
  console.log(chalk.gray(' Then transfer to this server and use "Specify local installer" below.\n'));

  let localChoice;
  try {
    ({ localChoice } = await inquirer.prompt([{
      type: 'list',
      name: 'localChoice',
      message: 'What would you like to do?',
      choices: [
        'Open download page in browser',
        'Specify local installer path',
        'Cancel'
      ],
    }]));
  } catch { return { success: false }; }

  if (localChoice === 'Open download page in browser') {
    console.log(chalk.cyan('\n Opening download pages in browser...'));
    console.log(chalk.gray(' Download either win-acme.zip or certbot installer, then re-run this tool.\n'));

    // Open win-acme releases
    await run('Start-Process "https://github.com/win-acme/win-acme/releases/latest"');
    // Also open EFF certbot page
    await run('Start-Process "https://certbot.eff.org/instructions?ws=other&os=windows"');

    console.log(chalk.green('✓ Browser opened. Download the installer, then run:'));
    console.log(chalk.cyan(' easy-devops → SSL Manager → Install certbot → Specify local installer path\n'));

    return { success: false };
  }

  if (localChoice === 'Specify local installer path') {
    let localPath;
    try {
      ({ localPath } = await inquirer.prompt([{
        type: 'input',
        name: 'localPath',
        message: 'Full path to installer (.exe or .zip):',
        validate: v => v.trim().length > 0 || 'Required',
      }]));
    } catch { return { success: false }; }

    const exists = await run(`Test-Path '${localPath.trim()}'`);
    if (exists.stdout.trim().toLowerCase() !== 'true') {
      console.log(chalk.red(` File not found: ${localPath}\n`));
      return { success: false };
    }

    const ext = path.extname(localPath.trim().toLowerCase());

    if (ext === '.zip') {
      step('Extracting ZIP archive ...');
      await run(`New-Item -ItemType Directory -Force -Path '${WINACME_DEST}'`);
      await run(`Expand-Archive -Path '${localPath.trim()}' -DestinationPath '${WINACME_DEST}' -Force`);
      if (await verifyWinAcme()) {
        return { success: true, client: 'winacme' };
      }
      console.log(chalk.red(' Extraction succeeded but win-acme not found.\n'));
    } else {
      step('Running installer silently ...');
      const ok = await runNsisInstaller(localPath.trim());
      if (ok) return { success: true };
      console.log(chalk.red(' Installer ran but certbot was not detected.\n'));
    }
  }

  return { success: false };
}

// ─── issueCert ────────────────────────────────────────────────────────────────

/**
 * Issues a new SSL certificate using the installed ACME client.
 *
 * HTTP method: stops nginx before challenge, restarts after (Linux only).
 *   Windows uses wacs.exe filesystem validation — nginx stays running.
 * DNS method: does NOT stop nginx. Pauses for user confirmation via onDnsChallenge callback.
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
  validationMethod = 'http',
  email = null,
  onDnsChallenge = null,
} = {}) {
  // Guard: ACME client must be installed
  const certbotExe = await getCertbotExe();
  if (!certbotExe) {
    return {
      success: false,
      certPath: null,
      keyPath: null,
      error: {
        step: 'ACME client detection',
        cause: 'No ACME client (certbot or win-acme) is installed on this server.',
        consequence: 'No certificate was issued. Install certbot or win-acme using the SSL Manager first.',
        nginxRunning: true,
        configSaved: false,
      },
    };
  }

  // ── DNS validation path ───────────────────────────────────────────────────────
  // nginx is never stopped for DNS challenges
  if (validationMethod === 'dns') {
    if (isWindows) {
      // Windows: use piped spawn so we can auto-answer the validation method prompt
      // and then extract the TXT record details from output.
      // wacs.exe shows "1: Upload a file / 2: Create a DNS record" even in Unattended
      // mode when --validation manual is used. We write "2\n" to select DNS-01.
      const pemPath = `C:\\certbot\\live\\${domainName}`;
      await run(`New-Item -ItemType Directory -Force -Path "${pemPath}"`, { timeout: 10000 });
      const wacsCmd = `& "${WINACME_EXE}" --target manual --host "${domainName}" --validation manual --validationmode dns-01 --store pemfiles --pemfilespath "${pemPath}"`;

      const { shell, flag } = getShell();
      const wacsProc = spawn(shell, [flag, wacsCmd], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let wacsOutput = '';
      let wacsMethodAnswered = false;
      let wacsTxtResolved = false;

      const wacsTxtPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!wacsTxtResolved) {
            wacsTxtResolved = true;
            reject(new Error('Timeout waiting for TXT record from wacs.exe (60s exceeded)'));
          }
        }, 60000);

        function checkMethodPrompt() {
          if (wacsMethodAnswered) return;
          // wacs asks "How would you like to prove that you own the domain?"
          if (wacsOutput.includes('Upload a file') || wacsOutput.includes('Create a DNS record')) {
            wacsMethodAnswered = true;
            try { wacsProc.stdin.write('2\n'); } catch { /* ignore */ }
          }
        }

        function checkTxtRecord() {
          if (wacsTxtResolved) return;
          const hostMatch = wacsOutput.match(/Host:\s+(\S+)/);
          const valueMatch = wacsOutput.match(/Value:\s+(\S+)/);
          if (hostMatch && valueMatch) {
            clearTimeout(timer);
            wacsTxtResolved = true;
            resolve({ txtName: hostMatch[1], txtValue: valueMatch[1] });
          }
        }

        wacsProc.stdout.on('data', (chunk) => {
          wacsOutput += chunk.toString();
          checkMethodPrompt();
          checkTxtRecord();
        });
        wacsProc.stderr.on('data', (chunk) => {
          wacsOutput += chunk.toString();
          checkMethodPrompt();
          checkTxtRecord();
        });
        wacsProc.on('error', (err) => {
          clearTimeout(timer);
          if (!wacsTxtResolved) { wacsTxtResolved = true; reject(err); }
        });
        wacsProc.on('close', (code) => {
          clearTimeout(timer);
          if (!wacsTxtResolved) {
            wacsTxtResolved = true;
            reject(new Error(`wacs.exe exited (code ${code}) before printing TXT record. Output:\n${wacsOutput.slice(-500)}`));
          }
        });
      });

      let wacsTxtDetails;
      try {
        wacsTxtDetails = await wacsTxtPromise;
      } catch (err) {
        try { wacsProc.kill(); } catch { /* ignore */ }
        return {
          success: false,
          certPath: null,
          keyPath: null,
          error: {
            step: 'TXT record extraction',
            cause: err.message,
            consequence: 'No certificate was issued. nginx was not affected.',
            nginxRunning: true,
            configSaved: false,
          },
        };
      }

      if (onDnsChallenge) {
        try {
          await onDnsChallenge(wacsTxtDetails.txtName, wacsTxtDetails.txtValue);
        } catch {
          try { wacsProc.kill(); } catch { /* ignore */ }
          return {
            success: false,
            certPath: null,
            keyPath: null,
            error: {
              step: 'DNS challenge cancelled',
              cause: 'The DNS challenge was cancelled before confirmation.',
              consequence: 'No certificate was issued. nginx was not affected.',
              nginxRunning: true,
              configSaved: false,
            },
          };
        }
      }

      // Signal wacs.exe to continue verifying DNS
      try { wacsProc.stdin.write('\n'); } catch { /* ignore */ }

      const wacsExitCode = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { wacsProc.kill(); } catch { /* ignore */ }
          resolve(null);
        }, 300000);
        wacsProc.on('close', (code) => { clearTimeout(timer); resolve(code); });
      });

      if (wacsExitCode !== 0) {
        return {
          success: false,
          certPath: null,
          keyPath: null,
          error: {
            step: 'ACME domain validation',
            cause: 'The DNS challenge failed. The TXT record may not have propagated, or the value was incorrect.',
            consequence: 'No certificate was issued. nginx was not affected.',
            nginxRunning: true,
            configSaved: false,
          },
        };
      }

      const certPath = `C:\\certbot\\live\\${domainName}\\fullchain.pem`;
      const keyPath = `C:\\certbot\\live\\${domainName}\\privkey.pem`;
      return { success: true, certPath, keyPath, error: null };
    }

    // Linux: piped spawn — certbot works with piped stdin for DNS challenge
    const emailArg = email ? `--email "${email}"` : '--register-unsafely-without-email';
    const domainArgs = www ? `-d "${domainName}" -d "www.${domainName}"` : `-d "${domainName}"`;
    const cmd = `certbot certonly --manual --preferred-challenges dns --agree-tos ${emailArg} ${domainArgs}`;

    const { shell, flag } = getShell();
    const proc = spawn(shell, [flag, cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Capture stdout/stderr to extract TXT record
    let rawOutput = '';
    let txtResolved = false;

    const txtPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!txtResolved) {
          txtResolved = true;
          reject(new Error('Timeout waiting for TXT record prompt (30s exceeded)'));
        }
      }, 30000);

      function checkForTxt() {
        if (txtResolved) return;

        // wacs.exe pattern: "Host: _acme-challenge.example.com" / "Value: abc123"
        const wacsHostMatch = rawOutput.match(/Host:\s+(\S+)/);
        const wacsValueMatch = rawOutput.match(/Value:\s+(\S+)/);
        if (wacsHostMatch && wacsValueMatch) {
          clearTimeout(timer);
          txtResolved = true;
          resolve({ txtName: wacsHostMatch[1], txtValue: wacsValueMatch[1] });
          return;
        }

        // certbot pattern: "_acme-challenge.example.com" + "with the following value:"
        const certbotNameMatch = rawOutput.match(/(_acme-challenge\.\S+)/);
        const certbotValueIdx = rawOutput.indexOf('with the following value:');
        if (certbotNameMatch && certbotValueIdx !== -1) {
          const afterValue = rawOutput.slice(certbotValueIdx + 'with the following value:'.length).trim();
          const valueMatch = afterValue.match(/^(\S+)/m);
          if (valueMatch) {
            clearTimeout(timer);
            txtResolved = true;
            resolve({ txtName: certbotNameMatch[1], txtValue: valueMatch[1] });
            return;
          }
        }
      }

      proc.stdout.on('data', (chunk) => { rawOutput += chunk.toString(); checkForTxt(); });
      proc.stderr.on('data', (chunk) => { rawOutput += chunk.toString(); checkForTxt(); });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!txtResolved) {
          txtResolved = true;
          reject(err);
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (!txtResolved) {
          txtResolved = true;
          reject(new Error(`ACME process exited (code ${code}) before printing TXT record`));
        }
      });
    });

    let txtDetails;
    try {
      txtDetails = await txtPromise;
    } catch (err) {
      try { proc.kill(); } catch { }
      return {
        success: false,
        certPath: null,
        keyPath: null,
        error: {
          step: 'TXT record extraction',
          cause: err.message || 'Failed to extract TXT record from ACME process output.',
          consequence: 'No certificate was issued. The ACME process has been terminated. nginx was not affected.',
          nginxRunning: true,
          configSaved: false,
        },
      };
    }

    // Fallback names if pattern matched but values were empty
    if (!txtDetails.txtName) txtDetails.txtName = `_acme-challenge.${domainName}`;
    if (!txtDetails.txtValue) txtDetails.txtValue = '[see terminal output]';

    // Yield TXT record details to the caller — this is the pause mechanism
    if (onDnsChallenge) {
      try {
        await onDnsChallenge(txtDetails.txtName, txtDetails.txtValue);
      } catch {
        // Caller cancelled (e.g. dashboard cancel endpoint rejected the deferred)
        try { proc.kill(); } catch { }
        return {
          success: false,
          certPath: null,
          keyPath: null,
          error: {
            step: 'DNS challenge cancelled',
            cause: 'The DNS challenge was cancelled or timed out before confirmation.',
            consequence: 'No certificate was issued. nginx was not affected.',
            nginxRunning: true,
            configSaved: false,
          },
        };
      }
    }

    // Signal the ACME process to continue (user confirmed)
    try { proc.stdin.write('\n'); } catch { }

    // Wait for the process to exit (up to 300s for DNS propagation + validation)
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { }
        resolve(null);
      }, 300000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    if (exitCode !== 0) {
      return {
        success: false,
        certPath: null,
        keyPath: null,
        error: {
          step: 'ACME domain validation',
          cause: 'The DNS challenge failed. The TXT record may not have propagated yet, or the value was incorrect.',
          consequence: 'No certificate was issued. nginx was not affected.',
          nginxRunning: true,
          configSaved: false,
        },
      };
    }

    // Derive cert paths
    let certPath, keyPath;
    if (isWindows) {
      certPath = `C:\\certbot\\live\\${domainName}\\fullchain.pem`;
      keyPath = `C:\\certbot\\live\\${domainName}\\privkey.pem`;
    } else {
      const liveDir = getCertbotDir();
      certPath = path.join(liveDir, domainName, 'fullchain.pem');
      keyPath = path.join(liveDir, domainName, 'privkey.pem');
    }

    return { success: true, certPath, keyPath, error: null };
  }

  // ── HTTP validation path ──────────────────────────────────────────────────────

  if (isWindows) {
    // Windows: wacs.exe filesystem validation — nginx stays running
    const pemPath = `C:\\certbot\\live\\${domainName}`;
    // wacs.exe requires the pemfilespath directory to exist before running
    await run(`New-Item -ItemType Directory -Force -Path "${pemPath}"`, { timeout: 10000 });

    const hostArgs = www
      ? `--host "${domainName}" --host "www.${domainName}"`
      : `--host "${domainName}"`;
    const cmd = `& "${WINACME_EXE}" --target manual ${hostArgs} --validation filesystem --webroot "C:\\nginx\\html" --store pemfiles --pemfilespath "${pemPath}"`;

    const exitCode = await runLive(cmd, { timeout: 120000 });

    if (exitCode !== 0) {
      return {
        success: false,
        certPath: null,
        keyPath: null,
        error: {
          step: 'ACME domain validation',
          cause: 'The wacs.exe filesystem challenge failed. Ensure nginx is serving requests from C:\\nginx\\html and the domain DNS points to this server.',
          consequence: 'No certificate was issued. nginx was not stopped.',
          nginxRunning: true,
          configSaved: false,
        },
      };
    }

    const certPath = `C:\\certbot\\live\\${domainName}\\fullchain.pem`;
    const keyPath = `C:\\certbot\\live\\${domainName}\\privkey.pem`;

    // Verify cert files exist at expected location
    try {
      await fs.access(certPath, fs.constants.F_OK);
    } catch {
      return {
        success: false,
        certPath: null,
        keyPath: null,
        error: {
          step: 'ACME domain validation',
          cause: `Certificate file not found at ${certPath} after wacs.exe exited successfully. Check the --pemfilespath output directory.`,
          consequence: 'No certificate was issued. nginx was not stopped.',
          nginxRunning: true,
          configSaved: false,
        },
      };
    }

    return { success: true, certPath, keyPath, error: null };
  }

  // Linux: certbot standalone — stop nginx, check port, run challenge, restart nginx
  await stopNginx();

  try {
    const portCheck = await isPort80Busy();
    if (portCheck.busy) {
      await startNginx();
      return {
        success: false,
        certPath: null,
        keyPath: null,
        error: {
          step: 'port 80 check',
          cause: `Port 80 is still in use: ${portCheck.detail}. Stop that process before creating a certificate.`,
          consequence: 'The standalone ACME challenge cannot bind to port 80. No certificate was issued. nginx has been restarted.',
          nginxRunning: true,
          configSaved: false,
        },
      };
    }

    const emailArg = email ? `--email "${email}"` : '--register-unsafely-without-email';
    const domainArgs = www ? `-d "${domainName}" -d "www.${domainName}"` : `-d "${domainName}"`;
    const cmd = `${certbotExe} certonly --standalone --non-interactive --agree-tos ${emailArg} ${domainArgs}`;

    const exitCode = await runLive(cmd, { timeout: 120000 });

    if (exitCode !== 0) {
      await startNginx();
      return {
        success: false,
        certPath: null,
        keyPath: null,
        error: {
          step: 'ACME domain validation',
          cause: 'The ACME challenge failed. Common causes: domain DNS does not point to this server, or port 80 is blocked by a firewall.',
          consequence: 'No certificate was issued. nginx has been restarted.',
          nginxRunning: true,
          configSaved: false,
        },
      };
    }

    const liveDir = getCertbotDir();
    const certPath = path.join(liveDir, domainName, 'fullchain.pem');
    const keyPath = path.join(liveDir, domainName, 'privkey.pem');

    await startNginx();
    return { success: true, certPath, keyPath, error: null };
  } catch (err) {
    try { await startNginx(); } catch { /* best effort */ }
    return {
      success: false,
      certPath: null,
      keyPath: null,
      error: {
        step: 'certificate issuance',
        cause: err.message,
        consequence: 'An unexpected error occurred during certificate issuance. nginx restart was attempted.',
        nginxRunning: false,
        configSaved: false,
      },
    };
  }
}

// ─── showSslManager ───────────────────────────────────────────────────────────

export async function showSslManager() {
  while (true) {
    const liveDir = getCertbotDir();

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
      case 'Create new certificate': {
        const installed = await isCertbotInstalled();
        if (!installed) {
          console.log(chalk.yellow('\n ⚠ certbot/win-acme not found — select "Install certbot" first\n'));
          break;
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
            console.log(chalk.white(`   Name:  ${txtName}`));
            console.log(chalk.white(`   Value: ${txtValue}\n`));
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
          result = await issueCert(domainInput.trim(), { www: wwwInput, validationMethod: 'dns', onDnsChallenge });
        } else {
          const spinner = ora(`Creating certificate for ${domainInput.trim()}…`).start();
          result = await issueCert(domainInput.trim(), { www: wwwInput, validationMethod: 'http' });
          spinner.stop();
        }

        if (result.success) {
          console.log(chalk.green('\n ✓ Certificate created successfully'));
          console.log(chalk.gray(`   Cert: ${result.certPath}`));
          console.log(chalk.gray(`   Key:  ${result.keyPath}\n`));
        } else {
          const e = result.error;
          console.log(chalk.red('\n ✗ Certificate creation failed'));
          console.log(chalk.yellow(`   Step:        ${e.step}`));
          console.log(chalk.yellow(`   Cause:       ${e.cause}`));
          console.log(chalk.yellow(`   Consequence: ${e.consequence}`));
          console.log(chalk.gray(`   nginx running: ${e.nginxRunning ? 'yes' : 'no'}\n`));
        }
        break;
      }

      case 'Renew a certificate': {
        const installed = await isCertbotInstalled();
        if (!installed) {
          console.log(chalk.yellow('\n ⚠ certbot/win-acme not found — select "Install certbot" first\n'));
          break;
        }

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

        const renewResult = await renewCert(selectedDomain);
        if (renewResult.success) {
          console.log(chalk.green('\n ✓ Renewed successfully\n'));
        } else {
          console.log(chalk.red('\n ✗ Renewal failed — see output above\n'));
        }
        break;
      }

      case 'Renew all expiring (< 30 days)': {
        const installed = await isCertbotInstalled();
        if (!installed) {
          console.log(chalk.yellow('\n ⚠ certbot/win-acme not found — select "Install certbot" first\n'));
          break;
        }

        const results = await renewExpiring(certs);
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

      case 'Install certbot': {
        const alreadyInstalled = await isCertbotInstalled();
        if (alreadyInstalled) {
          const clientType = await getAcmeClientType();
          console.log(chalk.gray(`\n ${clientType === 'winacme' ? 'win-acme' : 'certbot'} is already installed\n`));
          break;
        }

        const installResult = await installCertbot();
        if (installResult.success) {
          const clientName = installResult.client === 'winacme' ? 'win-acme' : 'certbot';
          console.log(chalk.green(`\n ✓ ${clientName} installed successfully\n`));
        } else {
          console.log(chalk.red('\n ✗ Installation failed\n'));
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
