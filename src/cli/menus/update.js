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
 * Nothing in this file runs from the Hub, and `whyCliOnly()` in
 * core/updater.js is what explains that to the user rather than a comment.
 * The dashboard has its own entry point for the same flow —
 * dashboard/updateWorker.js — which is why this file owns only the CLI side.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { dbGet, dbSet } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { getDashboardStatus, startDashboard, stopDashboard } from '../../core/dashboardProcess.js';
import { page, pause } from '../ui/page.js';


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

// ─── Detached dashboard ───────────────────────────────────────────────────────

/**
 * Persists the dashboard state, stops it, runs `fn`, and starts it again.
 *
 * The state is written *before* the stop, so a crash in between leaves the
 * `update-pre-dashboard` key behind and `recoverIfNeeded()` finishes the job on
 * the next launch. Both entry points go through here — `ezz update`, and the
 * menu, which now simply calls it — so neither can stop the dashboard and
 * forget to bring it back.
 */
async function withDashboardStopped(fn) {
  const status = await getDashboardStatus();
  dbSet('update-pre-dashboard', {
    wasRunning: status.running,
    pid: status.pid,
    port: status.port,
    service: false,
  });

  if (status.running) {
    const sp = ora('Stopping the dashboard...').start();
    await stopDashboard(status.pid);
    sp.succeed('Dashboard stopped');
  }

  try {
    return await fn();
  } finally {
    // Cleared before the restart: if the restart itself crashes, the next
    // launch must not start a second dashboard on the same port.
    const saved = dbGet('update-pre-dashboard');
    dbSet('update-pre-dashboard', null);

    if (saved?.wasRunning) {
      const port = saved.port || loadConfig().dashboardPort;
      const sp = ora(`Starting the dashboard on port ${port}...`).start();
      const back = await startDashboard(port);
      back.success
        ? sp.succeed(`Dashboard running on port ${port}`)
        : sp.fail('Could not start the dashboard - use the Dashboard menu');
    }
  }
}

// ─── Post-update check ────────────────────────────────────────────────────────

/**
 * Says so when a daemon this command did not start is still on the old code.
 *
 * Replacing the files does not replace a running process: a daemon started
 * from another terminal keeps the code it loaded until it is restarted. Telling
 * the user is the whole fix — killing a process another terminal owns is not
 * this command's call, and that pid may be an interactive session.
 *
 * @param {string} targetVersion The version the files on disk now carry
 */
async function warnStaleDaemon(targetVersion) {
  const updater = await import('../../core/updater.js');
  const { inspect } = await import('../../core/daemon/lock.js');

  const state = inspect();
  if (!state.running || !state.lock) return;

  const running = state.lock.version;
  if (running && updater.compareVersions(running, targetVersion) === 0) return;

  console.log();
  console.log('  ' + chalk.yellow(
    `A daemon this command did not start is still running${running ? ` v${running}` : ''} (pid ${state.lock.pid}).`
  ));
  console.log('  ' + chalk.gray('The files on disk are now the new version, but a running process keeps the code it loaded.'));
  console.log('  ' + chalk.gray('Restart it from the terminal that started it (stop it there, then run `ezz daemon`).'));
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
 * @param {boolean} [opts.heading] Print the "Update Easy DevOps" heading
 * @returns {Promise<number>} Process exit code
 */
export async function updateCommand({ yes = false, heading = true } = {}) {
  const code = await runUpdate({ yes, heading });

  // A long operation's outcome is read, not scrolled past. No-op without a
  // TTY, so `ezz update` in a script is unaffected. A dismissed confirmation
  // (code 2) ran nothing and has nothing to read.
  if (code !== 2) await pause();

  return code;
}

async function runUpdate({ yes = false, heading = true } = {}) {
  const updater = await import('../../core/updater.js');

  if (heading) {
    console.log();
    console.log('  ' + chalk.bold('Update Easy DevOps'));
    console.log('  ' + chalk.gray('-'.repeat(58)));
    console.log();
  }

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
  // running the code npm is about to replace. Stopped and started again around
  // the update, with the recovery key that covers a crash in between.
  console.log();
  const result = await withDashboardStopped(() =>
    updater.performUpdate({
      version: check.latest,
      log: (line) => console.log('  ' + chalk.gray(line)),
    })
  );
  console.log();

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
    await warnStaleDaemon(result.to);
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

/**
 * The menu's "Check for Updates".
 *
 * Deliberately a front for `updateCommand` and not a second implementation:
 * the old version here kept calling helpers that no longer existed and threw a
 * ReferenceError the moment the item was chosen. One flow, one place to fix.
 */
export default async function updateMenu() {
  // A crashed previous update is finished before another one is offered.
  await recoverIfNeeded();

  page(['Update']);

  try {
    // The page header is the heading; the command's own title would repeat it.
    await updateCommand({ heading: false });
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    throw err;
  }
}
