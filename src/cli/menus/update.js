/**
 * cli/menus/update.js
 *
 * `ezz update`, and the same operation from the interactive menu.
 *
 * The sequence lives in core/updater.js: establish how this copy was installed
 * (npm or a git clone), stop the background service, replace the package,
 * refresh the Windows Server runtime copy, start, verify against the daemon's
 * own heartbeat, and roll back if the new version does not come up.
 *
 * This file owns only what is genuinely CLI: the questions, the output, and the
 * detached dashboard (cli/menus/dashboard.js), plus the `update-pre-dashboard`
 * key that lets a crash mid-update still bring the dashboard back on the next
 * launch.
 *
 * Nothing here runs from the dashboard or the Hub, and `whyCliOnly()` in
 * core/updater.js is what explains that to the user rather than a comment.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { dbGet, dbSet } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { getDashboardStatus, startDashboard, stopDashboard } from './dashboard.js';
import { run } from '../../core/shell.js';


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

  // A service-managed dashboard needs no recovery prompt: PM2 brought it back
  // on its own, or `ezz service restart` will.
  if (saved?.service) {
    dbSet('update-pre-dashboard', null);
    return;
  }

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

/**
 * The menu's update, which is the same operation `ezz update` performs.
 *
 * The sequence itself — stop the service, replace the package, refresh the
 * Windows Server runtime copy, start, verify against the daemon's own
 * heartbeat, roll back if it did not come up — lives in core/updater.js.
 * Having had two copies of it was how the runtime copy came to be refreshed in
 * neither: a feature added to one path is invisible to the other.
 *
 * What stays here is the detached dashboard, which is a CLI concept, and the
 * recovery key that survives a crash mid-update.
 */
async function performUpdate(latestVersion) {
  const updater = await import('../../core/updater.js');
  const { detectInstallSource, describeUnmanaged } = await import('../../core/installSource.js');

  const source = detectInstallSource();
  if (!source.npmUpdatable) {
    console.log();
    for (const line of describeUnmanaged(source, 'update')) console.log('  ' + chalk.gray(line));
    return false;
  }

  for (const line of updater.whyCliOnly()) console.log('  ' + chalk.gray(line));
  console.log();

  // Step 1 — the dashboard's state, persisted so a crash mid-update can still
  // bring it back on the next launch (recoverIfNeeded above).
  const status = await getDashboardStatus();
  dbSet('update-pre-dashboard', {
    wasRunning: status.running,
    pid: status.pid,
    port: status.port,
    service: false,
  });

  if (status.running) {
    const sp = ora('Stopping dashboard...').start();
    await stopDashboard(status.pid);
    sp.succeed('Dashboard stopped');
  }

  // Step 2 — the package and the service.
  const result = await updater.performUpdate({
    version: latestVersion,
    log: (line) => console.log('  ' + chalk.gray(line)),
  });

  // Step 3 — the dashboard, however it was before.
  const saved = dbGet('update-pre-dashboard');
  dbSet('update-pre-dashboard', null);

  if (saved?.wasRunning) {
    const port = saved.port || loadConfig().dashboardPort;
    const sp = ora(`Restarting dashboard on port ${port}...`).start();
    const back = await startDashboard(port);
    back.success
      ? sp.succeed(`Dashboard restarted on port ${port}`)
      : sp.fail('Could not restart dashboard — use the Dashboard menu');
  }

  if (result.ok) {
    console.log('  ' + chalk.green(`Updated to v${result.to}`));
    if (result.serviceInstalled && result.runningVersion) {
      console.log('  ' + chalk.gray(`The service reports v${result.runningVersion}.`));
    }
    return true;
  }

  console.log('  ' + chalk.red(`Update failed (${result.step})`));
  for (const line of String(result.reason ?? '').split('\n')) console.log('  ' + chalk.gray(line));
  if (result.rolledBack) {
    console.log('  ' + chalk.green(`Rolled back to v${result.from}.`));
  }
  return false;
}

// ─── `ezz update` ─────────────────────────────────────────────────────────────

/**
 * Non-interactive update.
 *
 * Shares `core/updater.js` with the menu above, so there is one implementation
 * of "stop, replace, refresh the copy, start, verify, roll back" and the two
 * entry points cannot drift. What stays here is the part that is genuinely
 * CLI-only: a detached dashboard, which cli/menus/dashboard.js owns.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.yes] Skip the confirmation
 * @returns {Promise<number>} Process exit code
 */
export async function updateCommand({ yes = false } = {}) {
  const updater = await import('../../core/updater.js');

  console.log();
  console.log('  ' + chalk.bold('Update Easy DevOps'));
  console.log('  ' + chalk.gray('-'.repeat(58)));
  console.log();

  const spinner = ora('Checking the registry...').start();
  const check = await updater.checkForUpdate();
  spinner.stop();

  console.log(`  Installed : ${chalk.cyan('v' + check.current)}`);

  if (!check.reachable) {
    console.log('  ' + chalk.yellow('Could not reach the npm registry.'));
    console.log('  ' + chalk.gray('Check your internet connection and try again.'));
    console.log();
    return 1;
  }

  console.log(`  Latest    : ${chalk.green('v' + check.latest)}`);
  console.log();

  // The install source is checked before anything is offered: on a clone the
  // answer is `git pull`, and asking "update to v1.3.0?" first would be
  // offering something that cannot happen.
  const { detectInstallSource, describeUnmanaged } = await import('../../core/installSource.js');
  const source = detectInstallSource();

  if (!source.npmUpdatable) {
    for (const line of describeUnmanaged(source, 'update')) console.log('  ' + chalk.gray(line));
    if (check.updateAvailable) {
      console.log('  ' + chalk.gray(`The registry has v${check.latest}; this clone is at v${check.current}.`));
      console.log();
    }
    return 1;
  }

  if (!check.updateAvailable) {
    console.log('  ' + chalk.green('Already up to date.'));
    console.log();
    return 0;
  }

  for (const line of updater.whyCliOnly()) console.log('  ' + chalk.gray(line));
  console.log();

  if (!yes) {
    let confirm = false;
    try {
      ({ confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Update to v${check.latest}? The background service will be restarted.`,
        default: true,
      }]));
    } catch (err) {
      if (err.name === 'ExitPromptError') return 2;
      throw err;
    }
    if (!confirm) {
      console.log('  ' + chalk.gray('Nothing was changed.'));
      return 0;
    }
  }

  // A detached dashboard runs the jobs while no service does, and it is
  // running the code npm is about to replace. Stopped here and started again
  // afterwards, which is exactly what the menu path does.
  const dash = await getDashboardStatus();
  if (dash.running) {
    const sp = ora('Stopping the dashboard...').start();
    await stopDashboard(dash.pid);
    sp.succeed('Dashboard stopped');
  }

  console.log();
  const result = await updater.performUpdate({
    version: check.latest,
    log: (line) => console.log('  ' + chalk.gray(line)),
  });
  console.log();

  if (dash.running) {
    const port = dash.port || loadConfig().dashboardPort;
    const sp = ora(`Starting the dashboard on port ${port}...`).start();
    const back = await startDashboard(port);
    back.success
      ? sp.succeed(`Dashboard running on port ${port}`)
      : sp.fail('Could not start the dashboard - use the Dashboard menu');
  }

  if (result.ok) {
    console.log('  ' + chalk.green(`Updated v${result.from} -> v${result.to}.`));
    if (result.serviceInstalled) {
      console.log('  ' + chalk.gray(
        result.versionConfirmed
          ? `The service is running v${result.runningVersion} (reported by the daemon itself).`
          : `The service restarted, reporting v${result.runningVersion ?? 'an unknown version'}.`,
      ));
      if (result.refreshedCopy) {
        console.log('  ' + chalk.gray('The ProgramData runtime copy was refreshed, so the service runs the new code.'));
      }
    }
    console.log();
    return 0;
  }

  console.log('  ' + chalk.red(`The update failed (${result.step}).`));
  console.log();
  for (const line of String(result.reason ?? '').split('\n')) console.log('  ' + line);
  console.log();

  if (result.untouched) {
    console.log('  ' + chalk.green('Nothing was changed.'));
  } else if (result.rolledBack) {
    console.log('  ' + chalk.green(`Rolled back to v${result.from}.`)
      + (result.restored ? chalk.gray(' The service is running again.') : ''));
    if (!result.restored) {
      console.log('  ' + chalk.yellow('The service did not come back: ') + chalk.white('ezz service start'));
    }
  } else if (result.restarted) {
    console.log('  ' + chalk.gray('The service was started again on the version it had.'));
  }

  console.log();
  return 1;
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

  const updateAvailable = check.updateAvailable;

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
