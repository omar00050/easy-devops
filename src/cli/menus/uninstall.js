/**
 * cli/menus/uninstall.js
 *
 * `ezz uninstall --purge` — remove Easy DevOps itself.
 *
 * Without `--purge` this command does nothing except explain the difference
 * between removing the service and removing Easy DevOps. That is deliberate:
 * `uninstall` is a word people type expecting the smaller of the two meanings,
 * and `ezz service uninstall` is almost always what they want. The destructive
 * reading has to be asked for explicitly.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';

import { getDataDir } from '../../core/platform.js';
import { loadConfig } from '../../core/config.js';
import * as purgeCore from '../../core/purge.js';
import { humanBytes } from '../../core/cleanup.js';

/**
 * @param {Object} [opts]
 * @param {boolean} [opts.purge]
 * @param {boolean} [opts.yes]
 * @returns {Promise<number>} Process exit code
 */
export async function uninstallCommand({ purge = false, yes = false } = {}) {
  if (!purge) {
    console.log();
    console.log('  ' + chalk.bold('Uninstall'));
    console.log('  ' + chalk.gray('-'.repeat(58)));
    console.log();
    console.log('  ' + chalk.white('Two different things are called "uninstall":'));
    console.log();
    console.log('  ' + chalk.white('ezz service uninstall')
      + chalk.gray('   removes the background service only.'));
    console.log('  ' + chalk.gray('                          Your data, settings, domains and'));
    console.log('  ' + chalk.gray('                          certificates all stay. This is almost'));
    console.log('  ' + chalk.gray('                          always the one you want.'));
    console.log();
    console.log('  ' + chalk.white('ezz uninstall --purge')
      + chalk.gray('   removes the service, the pinned runtime and'));
    console.log('  ' + chalk.gray('                          the data directory, after exporting a'));
    console.log('  ' + chalk.gray('                          backup. nginx, your sites and your'));
    console.log('  ' + chalk.gray('                          certificates are kept.'));
    console.log();
    console.log('  ' + chalk.gray('Nothing was changed.'));
    console.log();
    return 0;
  }

  const dataDir = getDataDir();
  const config = loadConfig();

  console.log();
  console.log('  ' + chalk.bold('Remove Easy DevOps'));
  console.log('  ' + chalk.gray('-'.repeat(58)));
  console.log();

  // Certificates are the one genuine question: they are private keys, and
  // whether they are still wanted depends on whether nginx keeps serving the
  // sites that use them. Default keep, as that is the safe reading.
  let certificates = 'keep';

  if (!yes) {
    const { choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: 'What should happen to the SSL certificates?',
      default: 'keep',
      choices: [
        {
          name: `Keep them (recommended) - nginx keeps serving HTTPS from ${config.sslDir ?? 'the certificate directory'}`,
          value: 'keep',
        },
        {
          name: 'Delete them - only do this if nginx is not serving these sites any more',
          value: 'remove',
        },
      ],
    }]);
    certificates = choice;
  }

  const outline = purgeCore.plan({ dataDir, certificates, config });

  console.log();
  console.log('  ' + chalk.bold('This will remove'));
  for (const item of outline.removes) {
    console.log(`    ${chalk.yellow('-')} ${item.what}  ${chalk.gray(item.path)}`);
  }
  console.log();
  console.log('  ' + chalk.bold('This will keep'));
  for (const item of outline.keeps) {
    console.log(`    ${chalk.green('=')} ${item.what}  ${chalk.gray(item.path)}`);
  }
  console.log();
  console.log('  ' + chalk.white('A backup of the data directory is exported first, and nothing is'));
  console.log('  ' + chalk.white('removed if that backup fails.'));
  console.log();

  if (!yes) {
    const { confirm } = await inquirer.prompt([{
      type: 'input',
      name: 'confirm',
      message: 'Type "remove" to go ahead, or anything else to cancel:',
    }]);

    if (String(confirm).trim().toLowerCase() !== 'remove') {
      console.log('  ' + chalk.gray('Nothing was changed.'));
      console.log();
      return 0;
    }
  }

  console.log();
  const spinner = ora('Working...').start();
  const result = await purgeCore.purge({
    dataDir,
    certificates,
    log: (line) => { spinner.text = line; },
  });
  spinner.stop();

  if (result.step === 'backup') {
    console.log('  ' + chalk.red('The backup could not be written, so nothing was removed.'));
    console.log('  ' + result.reason);
    console.log();
    console.log('  ' + chalk.gray(result.hint));
    console.log();
    return 1;
  }

  console.log('  ' + chalk.green('Backup: ') + chalk.white(result.backup.path)
    + chalk.gray(`  (${humanBytes(result.backup.bytes)})`));
  console.log();

  for (const item of result.removed) {
    console.log('    ' + chalk.gray(`removed ${item.what}: ${item.detail}`));
  }

  for (const failure of result.failed) {
    console.log('    ' + chalk.yellow(`could not remove ${failure.what}: ${failure.reason}`));
  }

  console.log();
  if (result.ok) {
    console.log('  ' + chalk.green('Easy DevOps has been removed from this machine.'));
  } else {
    console.log('  ' + chalk.yellow('Easy DevOps was mostly removed; the items above need attention.'));
  }

  console.log();
  console.log('  ' + chalk.bold('One step left - the package itself:'));
  console.log();
  console.log('    ' + chalk.white(result.finalCommand));
  console.log();
  console.log('  ' + chalk.gray('That cannot be done from here: npm would be deleting the files'));
  console.log('  ' + chalk.gray('this command is running from.'));
  console.log();
  console.log('  ' + chalk.gray(`Your data is still at ${result.backup.path}`));
  console.log('  ' + chalk.gray('Delete it when you are sure you will not want it back.'));
  console.log();

  return result.ok ? 0 : 1;
}
