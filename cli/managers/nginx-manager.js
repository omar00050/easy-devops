/**
 * cli/managers/nginx-manager.js
 *
 * Nginx Manager — full control over nginx from the CLI.
 *
 * Exported functions:
 *   - showNginxManager() — interactive menu for managing nginx
 *
 * All shell calls go through core/shell.js (run / runLive).
 * Platform differences (Windows/Linux) are handled via isWindows guards.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { run, runLive } from '../../core/shell.js';
import { loadConfig } from '../../core/config.js';
import { ensureNginxInclude } from '../../core/nginx-conf-generator.js';
import { isWindows } from '../../core/platform.js';

// ─── Helpers ────────────────────────────────────────────────────────────────
import { access } from 'fs/promises';

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── getNginxStatus ───────────────────────────────────────────────────────────

async function getNginxStatus(nginxDir) {
  const nginxExe = isWindows ? `${nginxDir}\\nginx.exe` : 'nginx';
  const logPath = isWindows
    ? `${nginxDir}\\logs\\error.log`
    : '/var/log/nginx/error.log';

  let running = false;
  let version = null;

  if (isWindows) {
    const taskResult = await run('tasklist /FI "IMAGENAME eq nginx.exe" /NH');
    running = taskResult.success && taskResult.stdout.toLowerCase().includes('nginx.exe');

    const versionResult = await run(`& "${nginxExe}" -v`);
    const versionMatch = (versionResult.stderr + versionResult.stdout).match(/nginx\/(\S+)/);
    if (versionMatch) version = versionMatch[1];
  } else {
    const pgrepResult = await run('pgrep -x nginx');
    running = pgrepResult.exitCode === 0;

    const versionResult = await run('nginx -v');
    const versionMatch = (versionResult.stderr + versionResult.stdout).match(/nginx\/(\S+)/);
    if (versionMatch) version = versionMatch[1];
  }

  return { running, version, nginxDir, nginxExe, logPath };
}

// ─── testConfig ───────────────────────────────────────────────────────────────

async function testConfig(nginxExe, nginxDir) {
  await ensureNginxInclude(nginxDir);
  const cmd = isWindows ? `& "${nginxExe}" -t` : 'nginx -t';
  const result = await run(cmd, { cwd: nginxDir });
  const PathDomain = await pathExists(`${nginxDir}\\conf\\conf.d`);
  const willKnown = await pathExists(`${nginxDir}\\html\\.well-known`);

  if (!PathDomain) {
    console.warn(chalk.yellow(`Warning: conf.d directory not found in ${nginxDir} — creating it now...`));
    await import('fs/promises').then(fs => fs.mkdir(`${nginxDir}\\conf\\conf.d`, { recursive: true }));
  }

  if (!willKnown) {
    console.warn(chalk.yellow(`Warning: .well-known/acme-challenge directory not found in ${nginxDir} — creating it now...`));
    await import('fs/promises').then(fs => fs.mkdir(`${nginxDir}\\html\\.well-known\\`, { recursive: true }));
    await import('fs/promises').then(fs => fs.mkdir(`${nginxDir}\\html\\.well-known\\acme-challenge`, { recursive: true }));
  }

  return {
    success: result.success,
    output: (result.stdout + '\n' + result.stderr).trim(),
  };
}

// ─── reloadNginx ──────────────────────────────────────────────────────────────

async function reloadNginx(nginxExe, nginxDir) {
  const spinner = ora('Testing config…').start();
  const configTest = await testConfig(nginxExe, nginxDir);

  if (!configTest.success) {
    spinner.fail('Config test failed');
    console.log(chalk.red('\n' + configTest.output));
    return { success: false, message: 'Config test failed', output: configTest.output };
  }

  spinner.text = 'Reloading nginx…';
  const cmd = isWindows ? `& "${nginxExe}" -s reload` : 'systemctl reload nginx';
  const result = await run(cmd, { cwd: nginxDir });

  if (result.success) {
    spinner.succeed('nginx reloaded successfully');
  } else {
    spinner.fail('Reload failed');
  }

  return {
    success: result.success,
    message: result.success ? 'nginx reloaded successfully' : 'Reload failed',
    output: (result.stdout + '\n' + result.stderr).trim(),
  };
}

// ─── restartNginx ─────────────────────────────────────────────────────────────

async function restartNginx(nginxExe, nginxDir) {
  const spinner = ora('Testing config…').start();
  const configTest = await testConfig(nginxExe, nginxDir);

  if (!configTest.success) {
    spinner.fail('Config test failed');
    console.log(chalk.red('\n' + configTest.output));
    return { success: false, message: 'Config test failed', output: configTest.output };
  }

  spinner.text = 'Restarting nginx…';
  let result;
  if (isWindows) {
    await run('taskkill /f /IM nginx.exe', { cwd: nginxDir });
    await new Promise(resolve => setTimeout(resolve, 2000));
    result = await run(`& "${nginxExe}"`, { cwd: nginxDir });
  } else {
    result = await run('systemctl restart nginx');
  }

  if (result.success) {
    spinner.succeed('nginx restarted successfully');
  } else {
    spinner.fail('Restart failed');
  }

  return {
    success: result.success,
    message: result.success ? 'nginx restarted successfully' : 'Restart failed',
    output: (result.stdout + '\n' + result.stderr).trim(),
  };
}

// ─── viewErrorLog ─────────────────────────────────────────────────────────────

async function viewErrorLog(logPath) {
  const cmd = isWindows
    ? `Get-Content -Tail 50 "${logPath}"`
    : `tail -n 50 "${logPath}"`;

  const result = await run(cmd);

  if (result.success && result.stdout) {
    console.log('\n' + result.stdout);
  } else {
    console.log(chalk.yellow('\n  No errors logged yet (log file not found or empty)\n'));
  }
}

// ─── startNginx ───────────────────────────────────────────────────────────────

async function startNginx(nginxExe, nginxDir) {
  // Step 1: config check before attempting to start
  const spinner = ora('Checking config…').start();
  const configTest = await testConfig(nginxExe, nginxDir);
  if (!configTest.success) {
    spinner.fail('Config test failed — fix the errors below before starting');
    console.log(chalk.red('\n' + configTest.output));
    return { success: false };
  }

  // Step 2: launch nginx
  spinner.text = 'Starting nginx…';

  if (isWindows) {
    // nginx.exe runs in the foreground on Windows and never exits, so we must
    // use Start-Process to launch it as a detached background process.
    const startCmd = `Start-Process -FilePath "${nginxExe}" -WorkingDirectory "${nginxDir}" -WindowStyle Hidden`;
    await run(startCmd, { timeout: 10000 });
  } else {
    const result = await run('systemctl start nginx', { timeout: 15000 });
    if (!result.success) {
      spinner.fail('Start failed');
      console.log(chalk.red('\n' + (result.stderr || result.stdout)));
      return { success: false };
    }
  }

  // Step 3: wait briefly then verify nginx is actually running
  await new Promise(r => setTimeout(r, 1500));

  let running = false;
  if (isWindows) {
    const check = await run('tasklist /FI "IMAGENAME eq nginx.exe" /NH');
    running = check.success && check.stdout.toLowerCase().includes('nginx.exe');
  } else {
    const check = await run('pgrep -x nginx');
    running = check.exitCode === 0;
  }

  if (running) {
    spinner.succeed('nginx started successfully');
    return { success: true };
  }

  // Step 4: nginx didn't come up — read the error log to surface the reason
  spinner.fail('nginx did not start');
  const logPath = isWindows
    ? `${nginxDir}\\logs\\error.log`
    : '/var/log/nginx/error.log';
  const logCmd = isWindows
    ? `Get-Content -Tail 20 "${logPath}" -ErrorAction SilentlyContinue`
    : `tail -n 20 "${logPath}" 2>/dev/null`;
  const logResult = await run(logCmd);

  console.log(chalk.yellow('\n  Recent error log:'));
  if (logResult.success && logResult.stdout) {
    console.log(chalk.red(logResult.stdout));
  } else {
    console.log(chalk.gray('  (error log not found or empty)'));
  }

  return { success: false };
}

// ─── stopNginx ────────────────────────────────────────────────────────────────

async function stopNginx(nginxDir) {
  const spinner = ora('Stopping nginx…').start();
  const cmd = isWindows ? 'taskkill /f /IM nginx.exe' : 'systemctl stop nginx';
  const result = await run(cmd, { cwd: nginxDir });
  if (result.success) {
    spinner.succeed('nginx stopped');
  } else {
    spinner.fail('Stop failed');
    console.log(chalk.red('\n' + (result.stderr || result.stdout)));
  }
  return { success: result.success, output: (result.stdout + '\n' + result.stderr).trim() };
}

// ─── installNginx ─────────────────────────────────────────────────────────────

async function installNginx() {
  if (!isWindows) {
    const spinner = ora('Installing nginx…').start();
    const result = await run('sudo apt-get install -y nginx', { timeout: 120000 });
    if (result.success) {
      spinner.succeed('nginx installed successfully');
      return { success: true, message: 'nginx installed successfully', output: result.stdout };
    }
    spinner.fail('Installation failed');
    console.log(chalk.red(result.stderr || result.stdout));
    console.log(chalk.gray('\n  Manual instructions: https://nginx.org/en/docs/install.html\n'));
    return { success: false, message: 'Installation failed', output: result.stderr || result.stdout };
  }

  // ── Windows ──────────────────────────────────────────────────────────────────
  const spinner = ora('Checking for winget…').start();
  //! Winget is not reliably available on all Windows versions (missing from Windows Server, and some users report it missing on Windows 10 desktop), so we'll skip it for now and go straight to the direct download method. We can revisit this in the future if winget becomes more ubiquitous.

  // Try winget first (available on Windows 10/11 desktop; not on Windows Server by default)
  // const wingetCheck = await run('where.exe winget 2>$null');
  // const hasWinget = wingetCheck.success && wingetCheck.stdout.trim().length > 0;

  // if (hasWinget) {
  //   spinner.text = 'Installing nginx via winget…';
  //   const result = await run(
  //     'winget install -e --id Nginx.Nginx --accept-package-agreements --accept-source-agreements',
  //     { timeout: 120000 },
  //   );
  //   if (result.success) {
  //     spinner.succeed('nginx installed successfully');
  //     return { success: true, message: 'nginx installed successfully', output: result.stdout };
  //   }
  //   spinner.fail('winget install failed');
  //   console.log(chalk.red(result.stderr || result.stdout));
  //   console.log(chalk.gray('\n  Manual instructions: https://nginx.org/en/docs/install.html\n'));
  //   return { success: false, message: 'Installation failed', output: result.stderr || result.stdout };
  // }

  // ── Fallback: direct download from nginx.org ─────────────────────────────────
  spinner.text = 'Fetching latest nginx version…';

  // Try to resolve the current stable version; fall back to a known-good release
  const FALLBACK_VERSION = '1.29.6';
  let nginxVersion = FALLBACK_VERSION;

  const fetchVersionResult = await run(
    `try { $p=(Invoke-WebRequest -Uri 'https://nginx.org/en/download.html' -UseBasicParsing -TimeoutSec 15).Content; if($p -match 'nginx-(\\d+\\.\\d+\\.\\d+)\\.zip'){$Matches[1]}else{''} } catch { '' }`,
    { timeout: 20000 },
  );
  const fetched = (fetchVersionResult.stdout || '').trim();
  if (/^\d+\.\d+\.\d+$/.test(fetched)) nginxVersion = fetched;

  const { nginxDir } = loadConfig();
  const zipUrl = `https://nginx.org/download/nginx-${nginxVersion}.zip`;

  spinner.text = `Downloading nginx ${nginxVersion}…`;

  const downloadResult = await run(
    `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${zipUrl}' -OutFile "$env:TEMP\\nginx-${nginxVersion}.zip" -UseBasicParsing -TimeoutSec 120`,
    { timeout: 130000 },
  );

  if (!downloadResult.success) {
    spinner.fail('Download failed');
    console.log(chalk.red(downloadResult.stderr || downloadResult.stdout));
    console.log(chalk.gray(`\n  Download nginx manually from: https://nginx.org/en/download.html\n`));
    return { success: false, message: 'Download failed', output: downloadResult.stderr || downloadResult.stdout };
  }

  spinner.text = 'Extracting nginx…';

  const extractResult = await run(
    `$ProgressPreference='SilentlyContinue'; $tmp="$env:TEMP\\nginx-extract-${nginxVersion}"; if(Test-Path $tmp){Remove-Item -Recurse -Force $tmp}; Expand-Archive -Path "$env:TEMP\\nginx-${nginxVersion}.zip" -DestinationPath $tmp -Force; $src=Join-Path $tmp 'nginx-${nginxVersion}'; if(-not(Test-Path '${nginxDir}')){New-Item -ItemType Directory -Force '${nginxDir}'|Out-Null}; Copy-Item -Path "$src\\*" -Destination '${nginxDir}' -Recurse -Force; Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue; Remove-Item -Force "$env:TEMP\\nginx-${nginxVersion}.zip" -ErrorAction SilentlyContinue`,
    { timeout: 60000 },
  );

  if (!extractResult.success) {
    spinner.fail('Extraction failed');
    console.log(chalk.red(extractResult.stderr || extractResult.stdout));
    return { success: false, message: 'Extraction failed', output: extractResult.stderr || extractResult.stdout };
  }

  // Verify nginx.exe is present
  const verifyResult = await run(`Test-Path '${nginxDir}\\nginx.exe'`);
  if (!verifyResult.success || !verifyResult.stdout.trim().toLowerCase().includes('true')) {
    spinner.fail(`nginx.exe not found in ${nginxDir} after extraction`);
    return { success: false, message: 'nginx.exe not found after extraction' };
  }

  // Create conf/conf.d directory for domain config files
  await import('fs/promises').then(fs => fs.mkdir(`${nginxDir}\\conf\\conf.d`, { recursive: true }));

  await import('fs/promises').then(fs => fs.mkdir(`${nginxDir}\\html\\.well-known\\`, { recursive: true }));
  // Create html/.well-known/acme-challenge directory for SSL certificate verification
  await import('fs/promises').then(fs => fs.writeFile(`${nginxDir}\\html\\.well-known\\acme-challenge`, '', (err) => {
    if (err) {
      console.error(chalk.red(`Failed to create acme-challenge directory: ${err.message}`));
    } else {
      console.log(chalk.green('Created acme-challenge directory for SSL certificate verification'));
    }
  }));

  spinner.succeed(`nginx ${nginxVersion} installed to ${nginxDir}`);
  return { success: true, message: `nginx ${nginxVersion} installed successfully`, output: '' };
}

// ─── showNginxManager ─────────────────────────────────────────────────────────

export async function showNginxManager() {
  while (true) {
    const { nginxDir } = loadConfig();
    const status = await getNginxStatus(nginxDir);

    console.log(chalk.bold('\n  Nginx Manager'));
    console.log(chalk.gray('  ' + '─'.repeat(40)));

    if (status.version) {
      const statusIcon = status.running ? chalk.green('✅ Running') : chalk.red('❌ Stopped');
      console.log(`  ${statusIcon}  |  v${status.version}  |  ${status.nginxDir}`);
    } else {
      console.log(`  ${chalk.yellow('⚠ Not installed')}`);
    }
    console.log();

    const choices = [];

    if (status.running) {
      // nginx is running — offer reload, restart, stop
      choices.push('Reload nginx', 'Restart nginx', 'Stop nginx', new inquirer.Separator());
      choices.push('Test config', 'View error log', new inquirer.Separator());
    } else if (status.version) {
      // nginx is installed but stopped — offer start
      choices.push('Start nginx', new inquirer.Separator());
      choices.push('Test config', 'View error log', new inquirer.Separator());
    } else {
      // nginx not found — offer install
      choices.push('Install nginx', new inquirer.Separator());
    }

    choices.push('← Back');

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
      case 'Reload nginx':
        await reloadNginx(status.nginxExe, status.nginxDir);
        break;
      case 'Restart nginx':
        await restartNginx(status.nginxExe, status.nginxDir);
        break;
      case 'Start nginx':
        await startNginx(status.nginxExe, status.nginxDir);
        break;
      case 'Stop nginx':
        await stopNginx(status.nginxDir);
        break;
      case 'Test config': {
        const result = await testConfig(status.nginxExe, status.nginxDir);
        console.log(
          '\n  Config test: ' +
          (result.success ? chalk.green('✓ OK') : chalk.red('✗ Failed')) +
          '\n',
        );
        console.log(chalk.gray(result.output) + '\n');
        break;
      }
      case 'View error log':
        await viewErrorLog(status.logPath);
        break;
      case 'Install nginx':
        await installNginx();
        break;
      case '← Back':
        return;
    }

    if (choice !== '← Back') {
      await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
    }
  }
}
