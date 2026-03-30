/**
 * core/detector.js
 *
 * Automatic server environment detection.
 *
 * DB key: 'system-detection'
 *
 * Exported functions:
 *   - runDetection()        — collects all system info, writes to DB, silent on success
 *   - showSystemStatus()    — reads DB, prints chalk-formatted table to stdout
 *   - getDetectionResult()  — thin wrapper around dbGet('system-detection') for other modules
 *
 * SystemDetectionResult schema:
 * {
 *   detectedAt: string,           // ISO 8601 timestamp
 *   os:      { type, release },
 *   nodejs:  { version },
 *   npm:     { installed, version },
 *   nginx:   { installed, version, path },
 *   certbot: { installed, version }
 * }
 *
 * Returns undefined (never throws) when detection has never run.
 * Other modules should import getDetectionResult() rather than coupling to the raw DB key.
 */

import os from 'os';
import chalk from 'chalk';
import { dbGet, dbSet } from './db.js';
import { run } from './shell.js';
import { loadConfig } from './config.js';

// ─── runDetection ─────────────────────────────────────────────────────────────

export async function runDetection() {
  // OS — no subprocess needed
  const platform = os.platform();
  const osInfo = {
    type: platform === 'linux' || platform === 'win32' ? platform : 'unknown',
    release: os.release(),
  };

  // Node.js — always available
  const nodejsInfo = { version: process.version };

  // npm
  const npmResult = await run('npm --version');
  const npmInfo = npmResult.success
    ? { installed: true, version: npmResult.stdout }
    : { installed: false, version: null };

  // nginx detection — two-step on Windows: PATH first, configured path as fallback.
  // Detection intentionally does NOT rely on exit code because nginx -v writes to
  // stderr and may exit non-zero on some Windows builds. Instead we look for the
  // version string in combined output, matching the same approach as nginx-manager.
  const { nginxDir } = loadConfig();

  let nginxInfo;

  if (platform === 'win32') {
    let detectedPath = null;
    let combined = '';

    // Step 1: PATH check
    // Use where.exe — plain `where` in PowerShell is an alias for Where-Object
    // and always exits 0, giving a false positive.
    const whereResult = await run('where.exe nginx');
    if (whereResult.success && whereResult.stdout) {
      detectedPath = whereResult.stdout.split('\n')[0].trim();
      const r = await run('nginx -v');
      combined = r.stdout + r.stderr;
    }

    // Step 2: configured path fallback (if PATH check found nothing)
    if (!combined.includes('nginx/')) {
      const configuredExe = `${nginxDir}\\nginx.exe`;
      const r = await run(`& "${configuredExe}" -v`);
      combined = r.stdout + r.stderr;
      if (combined.includes('nginx/')) {
        detectedPath = configuredExe;
      }
    }

    const versionMatch = combined.match(/nginx\/([^\s]+)/);
    nginxInfo = versionMatch
      ? { installed: true, version: versionMatch[1], path: detectedPath }
      : { installed: false, version: null, path: null };
  } else {
    const r = await run('nginx -v 2>&1');
    const combined = r.stdout + r.stderr;
    const versionMatch = combined.match(/nginx\/([^\s]+)/);
    if (versionMatch) {
      const pathResult = await run('which nginx');
      nginxInfo = {
        installed: true,
        version: versionMatch[1],
        path: pathResult.success ? pathResult.stdout.split('\n')[0].trim() : null,
      };
    } else {
      nginxInfo = { installed: false, version: null, path: null };
    }
  }

  // certbot — try PATH first, then the well-known Windows install location.
  // The winget/official installer puts certbot in C:\Program Files\Certbot\bin\
  // which may not be reflected in the current session PATH immediately after install.
  const CERTBOT_WIN_EXE = 'C:\\Program Files\\Certbot\\bin\\certbot.exe';
  let certbotExe = 'certbot';

  if (platform === 'win32') {
    const pathCheck = await run('where.exe certbot');
    if (pathCheck.exitCode !== 0 || !pathCheck.stdout.trim()) {
      // Fall back to the known install path
      const exeCheck = await run(`Test-Path "${CERTBOT_WIN_EXE}"`);
      if (exeCheck.stdout.trim().toLowerCase() === 'true') {
        certbotExe = CERTBOT_WIN_EXE;
      }
    }
  }

  // Use & "..." in PowerShell when the exe is a full path, otherwise bare name
  const certbotCmd = (platform === 'win32' && certbotExe !== 'certbot')
    ? `& "${certbotExe}" --version`
    : `${certbotExe} --version`;
  const certbotResult = await run(certbotCmd);
  const certbotCombined = certbotResult.stdout + ' ' + certbotResult.stderr;
  let certbotInfo;
  if (certbotResult.success || certbotCombined.match(/certbot\s+[\d.]+/i)) {
    const match = certbotCombined.match(/certbot\s+([\d.]+)/i);
    certbotInfo = { installed: true, version: match ? match[1] : null };
  } else {
    certbotInfo = { installed: false, version: null };
  }

  const result = {
    detectedAt: new Date().toISOString(),
    os: osInfo,
    nodejs: nodejsInfo,
    npm: npmInfo,
    nginx: nginxInfo,
    certbot: certbotInfo,
  };

  try {
    dbSet('system-detection', result);
  } catch (err) {
    process.stderr.write(`[ERROR] Failed to persist detection results: ${err.message}\n`);
    process.exit(1);
  }
}

// ─── showSystemStatus ─────────────────────────────────────────────────────────

export function showSystemStatus() {
  const result = dbGet('system-detection');

  if (!result) {
    console.log(chalk.yellow('No system detection data available.'));
    console.log(chalk.gray('Run the tool to detect your environment automatically.'));
    return;
  }

  const SEP = chalk.gray('─'.repeat(42));
  const label = (s) => chalk.bold(s.padEnd(14));

  console.log();
  console.log(chalk.bold.cyan('System Information'));
  console.log(SEP);

  // OS
  console.log(label('OS') + chalk.white(`${result.os.type} (${result.os.release})`));

  // Node.js
  console.log(label('Node.js') + chalk.white(result.nodejs.version));

  // npm
  if (result.npm.installed) {
    console.log(label('npm') + chalk.white(result.npm.version));
  } else {
    console.log(label('npm') + chalk.red('✗  not installed'));
  }

  // nginx
  if (result.nginx.installed) {
    const parts = [chalk.green('✓'), result.nginx.version, result.nginx.path]
      .filter(Boolean)
      .join('  ');
    console.log(label('nginx') + parts);
  } else {
    console.log(label('nginx') + chalk.red('✗  not installed'));
  }

  // certbot
  if (result.certbot.installed) {
    const parts = [chalk.green('✓'), result.certbot.version].filter(Boolean).join('  ');
    console.log(label('certbot') + parts);
  } else {
    console.log(label('certbot') + chalk.red('✗  not installed'));
  }

  console.log(SEP);
  console.log(chalk.gray(`Last detected: ${result.detectedAt}`));
  console.log();
}

// ─── getDetectionResult ───────────────────────────────────────────────────────

/**
 * Returns the latest SystemDetectionResult from the database,
 * or undefined if detection has never run.
 *
 * Usage by other modules:
 *   import { getDetectionResult } from '../core/detector.js';
 *   const detection = getDetectionResult();
 *   const { nginx } = detection ?? {};
 */
export function getDetectionResult() {
  return dbGet('system-detection');
}

// ─── formatStatusLine ─────────────────────────────────────────────────────────

/**
 * Returns a compact inline status string for embedding in the main menu header.
 * Format: "nginx: ✅ v1.26  |  certbot: ✅  |  node: v20.11"
 * Returns a warning string if detection result is undefined.
 */
export function formatStatusLine() {
  const result = getDetectionResult();

  if (!result) {
    return chalk.yellow('⚠  System detection not available — run detection first.');
  }

  const parts = [];

  // nginx
  if (result.nginx.installed) {
    const ver = result.nginx.version ? ` v${result.nginx.version}` : '';
    parts.push(`nginx: ✅${ver}`);
  } else {
    parts.push(`nginx: ${chalk.yellow('⚠ not found')}`);
  }

  // certbot
  if (result.certbot.installed) {
    const ver = result.certbot.version ? ` v${result.certbot.version}` : '';
    parts.push(`certbot: ✅${ver}`);
  } else {
    parts.push(`certbot: ${chalk.yellow('⚠ not found')}`);
  }

  // node
  parts.push(`node: ${result.nodejs.version}`);

  return parts.join('  |  ');
}
