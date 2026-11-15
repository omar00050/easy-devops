/**
 * cli/menus/runtime.js
 *
 * `ezz runtime status | update` — the Node runtime the background service is
 * pinned to.
 *
 * CLI-only, for two reasons that are both about honesty rather than policy:
 * the step that installs a Node version can take minutes and streams output
 * nobody would see from a web request, and on Windows Server mode the swap
 * needs an Administrator terminal, which a dashboard cannot obtain and must
 * not pretend to. As everywhere else in this project, the CLI asks every
 * question and `core/service/` does the work without prompting.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';

import { isWindows } from '../../core/platform.js';
import * as runtimeUpdate from '../../core/service/runtimeUpdate.js';
import * as service from '../../core/service/index.js';

const ACTIONS = ['status', 'update'];

/**
 * @param {string} action
 * @param {Object} [opts]
 * @param {boolean} [opts.yes] Take the newest usable version without asking
 * @returns {Promise<number>} Process exit code
 */
export async function runtimeCommand(action, { yes = false } = {}) {
  if (!ACTIONS.includes(action)) {
    process.stderr.write(
      `Unknown runtime action: ${action}\n` +
      `Available: ${ACTIONS.join(', ')}\n`
    );
    return 1;
  }

  return action === 'status' ? showStatus() : doUpdate({ yes });
}

const dot = (ok) => (ok ? chalk.green('*') : chalk.red('*'));

function header(title) {
  console.log();
  console.log('  ' + chalk.bold(title));
  console.log('  ' + chalk.gray('-'.repeat(58)));
  console.log();
}

/** Shared by both actions: read the state once and render the top of it. */
async function loadAndPrint() {
  const spinner = ora('Reading the pinned runtime and the available versions...').start();
  let targets;
  try {
    targets = await runtimeUpdate.listTargets();
  } finally {
    spinner.stop();
  }

  header('Service runtime');

  const pinned = targets.pinned;
  console.log(`  ${dot(Boolean(pinned.version) && !pinned.broken)} Pinned    `
    + (pinned.version ? chalk.white(`v${pinned.version}`) : chalk.yellow('unknown'))
    + chalk.gray(`  (${pinned.kind})`));
  if (pinned.path) console.log(`    ${chalk.gray(pinned.path)}`);
  if (pinned.kind === 'symlink' && pinned.target) console.log(`    ${chalk.gray('-> ' + pinned.target)}`);
  if (pinned.broken) {
    console.log('    ' + chalk.red('the pinned runtime is missing or does not run'));
    console.log('    ' + chalk.gray('`ezz service repair` re-pins it to the Node you are using now'));
  }

  const system = targets.systemNode;
  console.log(`  ${dot(Boolean(system.version))} On PATH   `
    + (system.version ? chalk.white(`v${system.version}`) : chalk.yellow('no node found')));
  if (system.path) console.log(`    ${chalk.gray(system.path)}`);

  console.log(`  ${dot(Boolean(targets.manager.manager))} Manager   `
    + (targets.manager.manager
      ? chalk.white(targets.manager.manager)
      : chalk.gray(targets.manager.reason)));

  console.log(`    ${chalk.gray(`minimum supported: Node ${targets.minimum.major} (${targets.minimum.raw})`)}`);

  // A clone is not updated by npm, and the same is true of the runtime's app
  // copy in Windows Server mode — it is refreshed from wherever this package
  // lives, so where that is matters.
  if (targets.installSource.kind !== 'npm') {
    console.log(`    ${chalk.gray(`this copy: ${targets.installSource.reason}`)}`);
  }

  return targets;
}

async function showStatus() {
  const targets = await loadAndPrint();

  const usable = targets.candidates.filter((c) => c.meetsMinimum && !c.isPinned);

  console.log();
  if (targets.nothingToUpdate) {
    console.log('  ' + chalk.green('Nothing to update.'));
    for (const line of targets.hint ?? []) console.log('  ' + chalk.gray(line));
    console.log();
    return 0;
  }

  console.log('  ' + chalk.bold('Available'));
  for (const candidate of usable.slice(0, 8)) {
    const label = candidate.source === 'system'
      ? chalk.gray('already installed on this machine')
      : chalk.gray(`install with ${candidate.source}`);
    console.log(`    v${candidate.version}  ${label}`);
  }

  const blocked = targets.candidates.filter((c) => !c.meetsMinimum);
  if (blocked.length) {
    console.log();
    console.log('  ' + chalk.gray(`${blocked.length} version(s) below the supported minimum are not offered.`));
  }

  console.log();
  console.log('  ' + chalk.white('ezz runtime update') + chalk.gray('   move the service onto one of these'));
  console.log();
  return 0;
}

async function doUpdate({ yes = false } = {}) {
  const targets = await loadAndPrint();

  // Nothing is installed to update: say so rather than offering to re-pin a
  // service that does not exist.
  const installed = await service.status().catch(() => null);
  if (installed && !installed.service.installed) {
    console.log();
    console.log('  ' + chalk.white('No background service is installed, so there is no pinned runtime to move.'));
    console.log('  ' + chalk.gray('Install one with: ') + chalk.white('ezz service install'));
    console.log();
    return 0;
  }

  if (targets.nothingToUpdate) {
    console.log();
    console.log('  ' + chalk.green('Nothing to update.'));
    for (const line of targets.hint ?? []) console.log('  ' + chalk.gray(line));
    console.log();
    return 0;
  }

  const usable = targets.candidates.filter((c) => c.meetsMinimum && !c.isPinned);

  let target = usable[0];

  if (!yes) {
    console.log();
    const { chosen } = await inquirer.prompt([{
      type: 'list',
      name: 'chosen',
      message: 'Move the service to which Node version?',
      pageSize: 12,
      choices: [
        ...usable.slice(0, 10).map((c) => ({
          name: `v${c.version}${c.source === 'system' ? '  (already on this machine)' : `  (via ${c.source})`}`,
          value: c,
        })),
        new inquirer.Separator(),
        { name: 'Cancel', value: null },
      ],
    }]);

    if (!chosen) {
      console.log('  ' + chalk.gray('Nothing was changed.'));
      return 0;
    }
    target = chosen;
  }

  console.log();
  console.log('  ' + chalk.bold(`Updating the service runtime to v${target.version}`));
  console.log('  ' + chalk.gray('The service keeps running until the new runtime has been tested.'));
  console.log();

  const result = await runtimeUpdate.update({
    target,
    log: (line) => console.log('  ' + chalk.gray(line)),
  });

  console.log();

  if (result.ok) {
    console.log('  ' + chalk.green(`Done. The service runs Node v${result.version}.`));
    if (result.detail) console.log('  ' + chalk.gray(result.detail));
    console.log('  ' + chalk.gray(`The daemon reported in after ${result.waitedMs}ms.`));
    console.log();
    console.log('  ' + chalk.gray('The previous runtime was left in place: nothing uninstalls a Node version.'));
    console.log('  ' + chalk.gray('`ezz cleanup` lists the backup copy when you no longer want it.'));
    console.log();
    return 0;
  }

  // Failures are reported by the step that failed, because what the user
  // should do next is entirely different for each one.
  console.log('  ' + chalk.red(`The runtime was not updated (${result.step}).`));
  console.log();
  for (const line of String(result.reason ?? '').split('\n')) console.log('  ' + line);
  if (result.fix) {
    console.log();
    for (const line of String(result.fix).split('\n')) console.log('  ' + chalk.gray(line));
  }
  console.log();

  if (result.untouched) {
    console.log('  ' + chalk.green('Nothing was changed and the service was not stopped.'));
  } else if (result.rolledBack) {
    console.log('  ' + chalk.green('The previous runtime was restored.')
      + (result.restored ? chalk.gray(' The service is running again.') : ''));
    if (!result.restored) {
      console.log('  ' + chalk.yellow('The service did not come back by itself: ')
        + chalk.white('ezz service start'));
    }
  } else if (result.restarted) {
    console.log('  ' + chalk.gray('The service was started again on the runtime it had.'));
  } else {
    console.log('  ' + chalk.yellow('The service may be stopped. Check: ') + chalk.white('ezz service status'));
  }

  if (result.needsElevation && isWindows) {
    console.log();
    console.log('  ' + chalk.gray('No password is needed - only elevation.'));
  }

  console.log();
  return 1;
}
