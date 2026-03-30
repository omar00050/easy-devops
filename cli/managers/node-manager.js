/**
 * cli/managers/node-manager.js
 *
 * Node.js Manager — full control over Node.js from the CLI.
 *
 * Exported functions:
 *   - showNodeManager() — interactive menu for managing Node.js
 *
 * All shell calls go through core/shell.js (run / runLive).
 * On Windows, nvm-windows syntax is used where it differs from nvm.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { run, runLive } from '../../core/shell.js';

const isWindows = process.platform === 'win32';

// ─── getCurrentVersions ───────────────────────────────────────────────────────

async function getCurrentVersions() {
  const [nodeRes, npmRes] = await Promise.all([
    run('node -v'),
    run('npm -v'),
  ]);
  return {
    node: nodeRes.success ? nodeRes.stdout : 'unknown',
    npm:  npmRes.success  ? npmRes.stdout  : 'unknown',
  };
}

// ─── switchVersion ────────────────────────────────────────────────────────────

async function switchVersion() {
  // Verify nvm is present
  const nvmCheck = await run(isWindows ? 'nvm version' : 'nvm --version');
  if (!nvmCheck.success) {
    console.log(chalk.yellow('\n  nvm not installed.'));
    if (isWindows) {
      console.log(chalk.gray('  Re-run install.bat and choose to install nvm-windows,'));
      console.log(chalk.gray('  or download it from: https://github.com/coreybutler/nvm-windows/releases'));
    } else {
      console.log(chalk.gray('  Install nvm: https://github.com/nvm-sh/nvm#installing-and-updating'));
    }
    console.log();
    await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
    return;
  }

  console.log(chalk.gray('\n  Fetching available Node.js versions…'));

  let versions = [];

  if (isWindows) {
    // nvm-windows: `nvm list available` outputs a formatted table
    const result = await run('nvm list available', { timeout: 60000 });
    if (result.success && result.stdout) {
      const versionRegex = /\b(\d+\.\d+\.\d+)\b/g;
      const seen = new Set();
      for (const line of result.stdout.split('\n')) {
        let match;
        while ((match = versionRegex.exec(line)) !== null) {
          if (!seen.has(match[1])) {
            seen.add(match[1]);
            versions.push(match[1]);
          }
        }
      }
    }
  } else {
    // nvm (Unix): `nvm ls-remote --lts`
    const result = await run(
      'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm ls-remote --lts',
      { timeout: 60000 },
    );
    if (result.success && result.stdout) {
      for (const line of result.stdout.split('\n')) {
        const match = line.match(/v(\d+\.\d+\.\d+)/);
        if (match) versions.push(match[1]);
      }
      versions.reverse(); // newest first
    }
  }

  if (versions.length === 0) {
    console.log(chalk.red('\n  Could not fetch available versions. Check your internet connection.\n'));
    await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
    return;
  }

  const displayVersions = versions.slice(0, 30).map(v => `v${v}`);
  displayVersions.push('← Cancel');

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: 'Select Node.js version to switch to:',
    choices: displayVersions,
    pageSize: 15,
  }]);

  if (selected === '← Cancel') return;

  const version = selected.replace(/^v/, '');
  console.log(chalk.cyan(`\n  Switching to Node.js ${selected}…\n`));

  const switchCmd = isWindows
    ? `nvm use ${version}`
    : `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm use ${version}`;

  await runLive(switchCmd, { timeout: 60000 });

  await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
}

// ─── listGlobalPackages ───────────────────────────────────────────────────────

async function listGlobalPackages() {
  console.log(chalk.cyan('\n  Global npm packages:\n'));
  const result = await run('npm list -g --depth=0');
  if (result.stdout) {
    console.log(result.stdout);
  } else {
    console.log(chalk.red('  Failed to list global packages.'));
    if (result.stderr) console.log(chalk.gray('  ' + result.stderr));
  }
  await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
}

// ─── installGlobalPackage ─────────────────────────────────────────────────────

async function installGlobalPackage() {
  const { packageName } = await inquirer.prompt([{
    type: 'input',
    name: 'packageName',
    message: 'Package name to install globally:',
    validate: (v) => v.trim().length > 0 || 'Package name cannot be empty',
  }]);

  const name = packageName.trim();
  console.log(chalk.cyan(`\n  Installing ${name} globally…\n`));

  const exitCode = await runLive(`npm install -g ${name}`, { timeout: 120000 });

  if (exitCode === 0) {
    console.log(chalk.green(`\n  ✓ ${name} installed successfully`));
  } else {
    console.log(chalk.red(`\n  ✗ Installation failed (exit code ${exitCode})`));
  }
  await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
}

// ─── uninstallGlobalPackage ───────────────────────────────────────────────────

async function uninstallGlobalPackage() {
  const result = await run('npm list -g --depth=0 --parseable');

  const packages = (result.stdout || '')
    .split('\n')
    .filter(l => l.includes('node_modules'))
    .map(l => l.split(/[/\\]node_modules[/\\]/).pop()?.trim())
    .filter(Boolean)
    .filter(p => p !== 'npm'); // protect npm itself

  if (packages.length === 0) {
    console.log(chalk.yellow('\n  No removable global packages found.\n'));
    await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
    return;
  }

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: 'Select package to uninstall:',
    choices: [...packages, '← Cancel'],
    pageSize: 15,
  }]);

  if (selected === '← Cancel') return;

  console.log(chalk.cyan(`\n  Uninstalling ${selected}…\n`));

  const exitCode = await runLive(`npm uninstall -g ${selected}`, { timeout: 60000 });

  if (exitCode === 0) {
    console.log(chalk.green(`\n  ✓ ${selected} uninstalled successfully`));
  } else {
    console.log(chalk.red(`\n  ✗ Uninstall failed (exit code ${exitCode})`));
  }
  await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
}

// ─── updateNpm ────────────────────────────────────────────────────────────────

async function updateNpm() {
  console.log(chalk.cyan('\n  Updating npm to latest…\n'));

  const exitCode = await runLive('npm install -g npm@latest', { timeout: 120000 });

  if (exitCode === 0) {
    console.log(chalk.green('\n  ✓ npm updated successfully'));
  } else {
    console.log(chalk.red(`\n  ✗ Update failed (exit code ${exitCode})`));
  }
  await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
}

// ─── showNodeManager ──────────────────────────────────────────────────────────

export async function showNodeManager() {
  while (true) {
    const versions = await getCurrentVersions();

    console.log(chalk.bold('\n  Node.js Manager'));
    console.log(chalk.gray('  ' + '─'.repeat(40)));
    console.log(`  Current: ${chalk.green('Node ' + versions.node)} | ${chalk.yellow('npm v' + versions.npm)}`);
    console.log();

    let choice;
    try {
      ({ choice } = await inquirer.prompt([{
        type: 'list',
        name: 'choice',
        message: 'Select an option:',
        choices: [
          'Switch Node version',
          'Manage global packages',
          new inquirer.Separator(),
          'Update npm',
          new inquirer.Separator(),
          '← Back',
        ],
      }]));
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      throw err;
    }

    switch (choice) {
      case 'Switch Node version':    await switchVersion();          break;
      case 'Manage global packages': await manageGlobalPackages();   break;
      case 'Update npm':             await updateNpm();              break;
      case '← Back':                 return;
    }
  }
}

// ─── manageGlobalPackages ─────────────────────────────────────────────────────

async function manageGlobalPackages() {
  let choice;
  try {
    ({ choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: 'Global packages:',
      choices: [
        'List global packages',
        'Install global package',
        'Uninstall global package',
        '← Back',
      ],
    }]));
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    throw err;
  }

  switch (choice) {
    case 'List global packages':      await listGlobalPackages();      break;
    case 'Install global package':    await installGlobalPackage();    break;
    case 'Uninstall global package':  await uninstallGlobalPackage();  break;
    case '← Back':                    return;
  }
}
