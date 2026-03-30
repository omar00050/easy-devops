/**
 * cli/menus/update.js
 *
 * Check for updates and upgrade easy-devops in place.
 *
 * Flow:
 *  1. Fetch latest version from npm registry
 *  2. If an update is available, offer to install it
 *  3. Before installing: record dashboard running state in DB
 *     (key: 'update-pre-dashboard') so it survives a crash mid-update
 *  4. Stop dashboard if it was running
 *  5. Run: npm install -g easy-devops@<latest>
 *  6. Re-start dashboard if it was running before
 *  7. Clear the saved state key
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { run } from '../../core/shell.js';
import { dbGet, dbSet, closeDb, initDb } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { getDashboardStatus, startDashboard, stopDashboard } from './dashboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);
const { version: currentVersion } = require('../../package.json');

// ─── Version helpers ──────────────────────────────────────────────────────────

async function fetchLatestVersion() {
  const result = await run('npm view easy-devops version', { timeout: 20000 });
  if (result.success && result.stdout.trim()) return result.stdout.trim();
  return null;
}

function isNewer(latest, current) {
  const parse = v => v.replace(/^v/, '').split('.').map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

// ─── Recover interrupted update ───────────────────────────────────────────────
// If a previous update crashed after stopping the dashboard but before restarting
// it, the key 'update-pre-dashboard' is still set. Offer to restart it.

async function recoverIfNeeded() {
  const saved = dbGet('update-pre-dashboard');
  if (!saved?.wasRunning) return;

  console.log(chalk.yellow('\n  A previous update left the dashboard stopped.'));
  const { restart } = await inquirer.prompt([{
    type:    'confirm',
    name:    'restart',
    message: 'Restart the dashboard now?',
    default: true,
  }]);

  if (restart) {
    const port = saved.port || loadConfig().dashboardPort;
    const sp   = ora(`Starting dashboard on port ${port}...`).start();
    const res  = await startDashboard(port);
    res.success
      ? sp.succeed(`Dashboard restarted on port ${port}`)
      : sp.fail('Could not restart dashboard — use the Dashboard menu');
  }

  dbSet('update-pre-dashboard', null);
}

// ─── Perform update ───────────────────────────────────────────────────────────

async function performUpdate(latestVersion) {
  // Step 1 — snapshot dashboard state and persist it
  const status = await getDashboardStatus();
  dbSet('update-pre-dashboard', {
    wasRunning: status.running,
    pid:        status.pid,
    port:       status.port,
  });

  // Step 2 — stop dashboard if running
  if (status.running) {
    const sp = ora('Stopping dashboard...').start();
    await stopDashboard(status.pid);
    sp.succeed('Dashboard stopped');
  }

  // Step 3 — close the SQLite connection so npm can rename the db file (EBUSY on Windows)
  closeDb();

  // Step 4 — install new version
  const sp = ora(`Installing easy-devops@${latestVersion}...`).start();
  const result = await run(`npm install -g easy-devops@${latestVersion}`, { timeout: 120000 });

  if (!result.success) {
    sp.fail('Update failed');
    console.log(chalk.red('\n' + (result.stderr || result.stdout) + '\n'));
    // Leave 'update-pre-dashboard' in DB so recovery runs on next launch
    return false;
  }

  sp.succeed(`Updated to v${latestVersion}`);

  // Re-initialize the database connection after npm replaced the module
  initDb();

  // Step 5 — restart dashboard if it was running before
  const saved = dbGet('update-pre-dashboard');
  dbSet('update-pre-dashboard', null);

  if (saved?.wasRunning) {
    const port    = saved.port || loadConfig().dashboardPort;
    const restSp  = ora(`Restarting dashboard on port ${port}...`).start();
    const res     = await startDashboard(port);
    res.success
      ? restSp.succeed(`Dashboard restarted on port ${port}`)
      : restSp.fail('Could not restart dashboard — use the Dashboard menu');
  }

  return true;
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

export default async function updateMenu() {
  // Recover from a crashed previous update first
  await recoverIfNeeded();

  const spinner = ora('Checking for updates...').start();
  const latestVersion = await fetchLatestVersion();
  spinner.stop();

  console.log(chalk.bold('\n  Check for Updates'));
  console.log(chalk.gray('  ' + '─'.repeat(40)));
  console.log(`  Current version : ${chalk.cyan('v' + currentVersion)}`);

  if (!latestVersion) {
    console.log(chalk.yellow('  Could not reach npm registry. Check your internet connection.\n'));
    await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to go back...' }]);
    return;
  }

  const updateAvailable = isNewer(latestVersion, currentVersion);

  if (updateAvailable) {
    console.log(`  Latest version  : ${chalk.green('v' + latestVersion)}  ${chalk.yellow('← update available')}\n`);
  } else {
    console.log(`  Latest version  : ${chalk.green('v' + latestVersion)}  ${chalk.gray('✓ up to date')}\n`);
  }

  const choices = updateAvailable
    ? [`Update to v${latestVersion}`, new inquirer.Separator(), '← Back']
    : ['← Back'];

  let choice;
  try {
    ({ choice } = await inquirer.prompt([{
      type:    'list',
      name:    'choice',
      message: 'Select an option:',
      choices,
    }]));
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    throw err;
  }

  if (choice === `Update to v${latestVersion}`) {
    const success = await performUpdate(latestVersion);
    if (success) {
      console.log(chalk.gray('\n  Restart easy-devops to use the new version.\n'));
    }
    try {
      await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
    } catch { /* ExitPromptError */ }
  }
}
