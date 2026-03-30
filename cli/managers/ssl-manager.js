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

// ─── ACME Client Detection ────────────────────────────────────────────────────
// Supports both certbot and win-acme on Windows

const CERTBOT_WIN_EXE = 'C:\\Program Files\\Certbot\\bin\\certbot.exe';
const WINACME_EXE = 'C:\\Program Files\\win-acme\\wacs.exe';

async function getCertbotExe() {
  if (!isWindows) {
    const r = await run('which certbot');
    return (r.exitCode === 0 && r.stdout.trim()) ? 'certbot' : null;
  }

  // 1. certbot on PATH?
  const pathResult = await run('where.exe certbot');
  if (pathResult.exitCode === 0 && pathResult.stdout.trim()) {
    return 'certbot';
  }

  // 2. certbot well-known location
  const exeCheck = await run(`Test-Path "${CERTBOT_WIN_EXE}"`);
  if (exeCheck.stdout.trim().toLowerCase() === 'true') {
    return `& "${CERTBOT_WIN_EXE}"`;
  }

  // 3. win-acme on PATH?
  const wacsPathResult = await run('where.exe wacs');
  if (wacsPathResult.exitCode === 0 && wacsPathResult.stdout.trim()) {
    return 'wacs';
  }

  // 4. win-acme well-known location
  const wacsCheck = await run(`Test-Path "${WINACME_EXE}"`);
  if (wacsCheck.stdout.trim().toLowerCase() === 'true') {
    return `& "${WINACME_EXE}"`;
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
      'C:\\win-acme\\wacs.exe',
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

    // Method 2: WebClient with TLS
    r = await safeRun(
      `${tlsSetup}; (New-Object System.Net.WebClient).DownloadFile('${safeUrl}','${safeDest}')`,
      { timeout: 130000 },
    );
    if (r.success) return true;
    if (showErrors && r.stderr && !lastDownloadError) lastDownloadError = `WebClient: ${r.stderr}`;

    // Method 3: BITS Transfer
    r = await safeRun(
      `Import-Module BitsTransfer -ErrorAction SilentlyContinue; Start-BitsTransfer -Source '${safeUrl}' -Destination '${safeDest}' -ErrorAction Stop`,
      { timeout: 130000 },
    );
    if (r.success) return true;
    if (showErrors && r.stderr && !lastDownloadError) lastDownloadError = `BITS: ${r.stderr}`;

    // Method 4: curl.exe (works on Windows 10+)
    if (hasCurl) {
      r = await safeRun(
        `curl.exe -L --ssl-no-revoke --max-time 120 -o '${safeDest}' '${safeUrl}'`,
        { timeout: 130000 },
      );
      if (r.success) return true;
      if (showErrors && r.stderr && !lastDownloadError) lastDownloadError = `curl: ${r.stderr}`;
    }

    // Method 5: HttpClient with custom handler
    r = await safeRun(
      `${tlsSetup}; $handler=[System.Net.Http.HttpClientHandler]::new(); $handler.ServerCertificateCustomValidationCallback={$true}; $handler.AllowAutoRedirect=$true; $hc=[System.Net.Http.HttpClient]::new($handler); $hc.DefaultRequestHeaders.Add('User-Agent','Mozilla/5.0 (Windows NT 10.0; Win64; x64)'); $hc.Timeout=[TimeSpan]::FromSeconds(120); $bytes=$hc.GetByteArrayAsync('${safeUrl}').GetAwaiter().GetResult(); [System.IO.File]::WriteAllBytes('${safeDest}',$bytes)`,
      { timeout: 130000 },
    );
    if (r.success) return true;
    if (showErrors && r.stderr && !lastDownloadError) lastDownloadError = `HttpClient: ${r.stderr}`;

    // Method 6: Certutil (built-in Windows tool)
    r = await safeRun(
      `certutil.exe -urlcache -split -f "${safeUrl}" "${safeDest}"`,
      { timeout: 130000 },
    );
    if (r.success) return true;
    if (showErrors && r.stderr && !lastDownloadError) lastDownloadError = `certutil: ${r.stderr}`;

    // Method 7: PowerShell with DisableKeepAlive
    r = await safeRun(
      `${tlsSetup}; $req=[System.Net.WebRequest]::Create('${safeUrl}'); $req.Method='GET'; $req.KeepAlive=$false; $req.UserAgent='Mozilla/5.0'; $resp=$req.GetResponse(); $stream=$resp.GetResponseStream(); $reader=[System.IO.BinaryReader]::new($stream); $bytes=$reader.ReadBytes($resp.ContentLength); $reader.Close(); [System.IO.File]::WriteAllBytes('${safeDest}',$bytes)`,
      { timeout: 130000 },
    );
    if (r.success) return true;
    if (showErrors && r.stderr && !lastDownloadError) lastDownloadError = `WebRequest: ${r.stderr}`;

    return false;
  }

  // Test network connectivity to common endpoints
  async function testNetworkConnectivity() {
    console.log(chalk.cyan('\n Testing network connectivity...'));
    const tests = [
      { name: 'GitHub', url: 'https://github.com' },
      { name: 'Microsoft', url: 'https://microsoft.com' },
      { name: 'EFF', url: 'https://eff.org' },
    ];
    const results = [];

    for (const test of tests) {
      const r = await run(`curl.exe -I --ssl-no-revoke --max-time 10 "${test.url}"`, { timeout: 15000 });
      const success = r.success || r.stdout.includes('HTTP') || r.stdout.includes('200');
      results.push({ name: test.name, success });
      console.log(chalk.gray(`   ${test.name}: ${success ? chalk.green('✓ Connected') : chalk.red('✗ Failed')}`));
    }

    const allFailed = results.every(r => !r.success);
    if (allFailed) {
      console.log(chalk.yellow('\n   ⚠ All external connections failed.'));
      console.log(chalk.gray('   This could indicate:'));
      console.log(chalk.gray('   • Firewall blocking outbound connections'));
      console.log(chalk.gray('   • Proxy server required'));
      console.log(chalk.gray('   • DNS resolution issues'));
      console.log(chalk.gray('   • Antivirus blocking downloads'));
    }
    console.log();
    return results;
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
    console.log(chalk.gray('   winget (Windows Package Manager) provides the easiest installation method.'));

    let installWinget;
    try {
      ({ installWinget } = await inquirer.prompt([{
        type: 'confirm',
        name: 'installWinget',
        message: 'Would you like to install winget (App Installer) from Microsoft Store?',
        default: true,
      }]));
    } catch { /* user cancelled */ }

    if (installWinget) {
      console.log(chalk.cyan('\n Opening Microsoft Store to install App Installer...'));
      console.log(chalk.gray(' Please complete the installation, then run this command again.\n'));

      // Try to open Microsoft Store
      const storeOpened = await run(
        'Start-Process "ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1"',
        { timeout: 10000 }
      ).catch(() => ({ success: false }));

      if (storeOpened.success) {
        console.log(chalk.green(' Microsoft Store opened successfully.'));
        console.log(chalk.gray(' After installing App Installer, winget will be available.\n'));
      } else {
        console.log(chalk.yellow(' Could not open Microsoft Store directly.'));
        console.log(chalk.gray(' Please manually install "App Installer" from:'));
        console.log(chalk.cyan(' https://apps.microsoft.com/store/detail/app-installer/9NBLGGH4NNS1\n'));
      }

      // Optional: try direct download of App Installer
      let tryDownload;
      try {
        ({ tryDownload } = await inquirer.prompt([{
          type: 'confirm',
          name: 'tryDownload',
          message: 'Would you like to try downloading App Installer directly?',
          default: false,
        }]));
      } catch { tryDownload = false; }

      if (tryDownload) {
        const appInstallerUrl = 'https://aka.ms/getwinget';
        const appInstallerDest = '$env:TEMP\\AppInstaller.msixbundle';

        console.log(chalk.gray('\n Downloading App Installer...'));
        let downloaded = false; try { downloaded = await downloadFile(appInstallerUrl, appInstallerDest); } catch (err) { if (err.code === 'EPERM' || err.message?.includes('EPERM')) { console.log(chalk.red('\n ? Windows Defender blocked the download.')); console.log(chalk.gray(' Add an exclusion in Windows Defender or download manually.')); console.log(chalk.gray(' Download URL: https://aka.ms/getwinget\n')); } else { console.log(chalk.yellow('\n Download failed: ' + err.message + '\n')); } }

        if (downloaded) {
          console.log(chalk.gray(' Running App Installer...'));
          await run(`Start-Process -FilePath '${appInstallerDest}' -Wait`, { timeout: 300000 });

          // Re-check for winget
          const recheck = await run('where.exe winget 2>$null');
          if (recheck.success && recheck.stdout.trim()) {
            console.log(chalk.green('\n ✓ winget installed successfully!\n'));
            wingetAvailable = true;
          } else {
            console.log(chalk.yellow('\n App Installer ran but winget is not yet available.'));
            console.log(chalk.gray(' You may need to restart your terminal or sign out/in.\n'));
          }
        } else {
          console.log(chalk.yellow('\n Could not download App Installer automatically.\n'));
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

  // ── Method 1: winget (win-acme - has better success rate) ─────────────────────
  if (wingetAvailable) {
    step('Trying winget (win-acme) ...');
    console.log(chalk.gray(' Running: winget install win-acme.win-acme\n'));
    const exitCode = await runLive(
      'winget install -e --id win-acme.win-acme --accept-package-agreements --accept-source-agreements',
      { timeout: 180000 },
    );
    if (exitCode === 0 || await verifyWinAcme()) return { success: true, client: 'winacme' };
    console.log(chalk.yellow(' winget win-acme failed, trying next...\n'));
  }

  // ── Method 2: winget (certbot EFF) ────────────────────────────────────────────
  if (wingetAvailable) {
    step('Trying winget (EFF.Certbot) ...');
    console.log(chalk.gray(' Running: winget install EFF.Certbot\n'));
    const exitCode = await runLive(
      'winget install -e --id EFF.Certbot --accept-package-agreements --accept-source-agreements',
      { timeout: 180000 },
    );
    if (exitCode === 0 || await verifyCertbot()) return { success: true };
    console.log(chalk.yellow(' winget certbot failed, trying next...\n'));
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
  const WINACME_DEST = 'C:\\Program Files\\win-acme';

  // Test network before attempting downloads
  try { await testNetworkConnectivity(); } catch (err) { console.log(chalk.yellow('Network test failed: ' + err.message)); }

  step('Downloading win-acme from GitHub ...');
  const winAcmeUrls = [
    'https://github.com/win-acme/win-acme/releases/latest/download/win-acme.zip',
    'https://github.com/win-acme/win-acme/releases/download/v2.2.9.1/win-acme.v2.2.9.1.zip',
  ];

  for (const url of winAcmeUrls) {
    const hostname = new URL(url).hostname;
    console.log(chalk.gray(` Downloading from ${hostname} ...`));

    const zipDest = `$env:TEMP\\win-acme.zip`;
    lastDownloadError = '';
    let dlOk = false; try { dlOk = await downloadFile(url, zipDest, true); } catch (err) { if (err.code === 'EPERM' || err.message?.includes('EPERM')) { console.log(chalk.red('Windows Defender blocked this download.')); console.log(chalk.gray('Use the manual installer option or add a Windows Defender exclusion.')); } } if (dlOk) {
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
    let dlOk = false; try { dlOk = await downloadFile(url, INSTALLER_DEST, true); } catch (err) { if (err.code === 'EPERM' || err.message?.includes('EPERM')) { console.log(chalk.red('Windows Defender blocked this download.')); console.log(chalk.gray('Use the manual installer option or add a Windows Defender exclusion.')); } } if (dlOk) {
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
    console.log(chalk.cyan('  easy-devops → SSL Manager → Install certbot → Specify local installer path\n'));

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
