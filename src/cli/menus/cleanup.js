/**
 * cli/menus/cleanup.js
 *
 * `ezz cleanup` — show what can be reclaimed, then remove what the user picks.
 *
 * The dry run is not a flag, it is the first half of the command: the
 * inventory is always printed, with a size per item, before anything is
 * offered. Nothing is selected by default except the groups that are
 * unambiguous, and installed Node versions are never selected by default at
 * all — "unused" is a guess, and the evidence is printed beside each one so
 * the user can judge it.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';

import * as cleanup from '../../core/cleanup.js';

/** How each group is introduced, and whether it is safe to preselect. */
const GROUP_INFO = {
  'runtime-backups': {
    title: 'Old runtime backups',
    note: 'the newest of each kind is kept, so the last change can still be undone',
    preselect: true,
  },
  logs: {
    title: 'Easy DevOps logs',
    note: 'only files older than the age threshold',
    preselect: true,
  },
  temp: {
    title: 'Temporary files, stale claims and dead locks',
    note: 'a live lock and a pending stop request are never listed',
    preselect: true,
  },
  'nginx-bak': {
    title: 'nginx .bak files',
    note: 'backups of configs that were rewritten; the .conf files themselves are untouched',
    preselect: true,
  },
  'pm2-logs': {
    title: 'PM2 logs',
    note: 'truncated with `pm2 flush`, because PM2 holds the files open',
    preselect: false,
  },
  'node-versions': {
    title: 'Installed Node versions',
    note: 'listed only - nothing here is selected for you',
    preselect: false,
  },
};

/**
 * @param {Object} [opts]
 * @param {string|number} [opts.days]
 * @param {boolean} [opts.yes] Remove the preselected groups without asking
 * @returns {Promise<number>} Process exit code
 */
export async function cleanupCommand({ days, yes = false } = {}) {
  const parsedDays = days === undefined ? cleanup.DEFAULT_LOG_DAYS : Number(days);

  if (!Number.isFinite(parsedDays) || parsedDays < 0) {
    process.stderr.write(`--days needs a number of days, not "${days}".\n`);
    return 1;
  }

  const spinner = ora('Looking for reclaimable files...').start();
  let report;
  try {
    report = await cleanup.scan({ days: parsedDays });
  } finally {
    spinner.stop();
  }

  console.log();
  console.log('  ' + chalk.bold('Cleanup'));
  console.log('  ' + chalk.gray('-'.repeat(58)));
  console.log('  ' + chalk.gray(`data directory: ${report.dataDir}`));
  console.log('  ' + chalk.gray(`logs older than ${report.days} days count as reclaimable (--days N)`));
  console.log();

  let anything = false;

  for (const group of cleanup.GROUPS) {
    const data = report.groups[group];
    if (!data || data.count === 0) continue;
    anything = true;

    const info = GROUP_INFO[group];
    console.log('  ' + chalk.bold(info.title)
      + chalk.gray(`  ${cleanup.humanBytes(data.bytes)} reclaimable`));
    console.log('    ' + chalk.gray(info.note));

    for (const item of data.items) {
      const mark = item.removable ? chalk.yellow('-') : chalk.green('=');
      const size = item.bytes ? chalk.gray(` ${cleanup.humanBytes(item.bytes)}`) : '';
      const label = item.version ? `Node v${item.version}` : item.path;
      console.log(`    ${mark} ${label}${size}`);
      console.log(`      ${chalk.gray(item.why)}`);
    }
    console.log();
  }

  if (!anything) {
    console.log('  ' + chalk.green('Nothing to reclaim.'));
    console.log();
    return 0;
  }

  console.log('  ' + chalk.white(`Total reclaimable: ${cleanup.humanBytes(report.totalBytes)}`));
  console.log('  ' + chalk.gray('Nothing has been removed. The database, your settings, your'));
  console.log('  ' + chalk.gray('certificates and every active nginx config are never listed.'));
  console.log();

  // What can actually be acted on.
  const candidates = report.items.filter((i) => i.removable);
  if (candidates.length === 0) {
    console.log('  ' + chalk.gray('Everything found is in use or kept on purpose.'));
    console.log();
    return 0;
  }

  let chosen;

  if (yes) {
    // Only the unambiguous groups. --yes must never uninstall a Node version
    // or touch PM2 on its own: those need a human to look at the evidence.
    chosen = candidates.filter((i) => GROUP_INFO[i.group]?.preselect);
    console.log('  ' + chalk.gray(`--yes: removing ${chosen.length} item(s) from the unambiguous groups only.`));
  } else {
    const { picked } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'picked',
      message: 'Remove which items?',
      pageSize: 18,
      choices: cleanup.GROUPS.flatMap((group) => {
        const data = report.groups[group];
        const removable = (data?.items ?? []).filter((i) => i.removable);
        if (removable.length === 0) return [];
        return [
          new inquirer.Separator(` ${GROUP_INFO[group].title} `),
          ...removable.map((item) => ({
            name: `${item.version ? `Node v${item.version}` : item.path}  (${cleanup.humanBytes(item.bytes)})`,
            value: item.id,
            checked: GROUP_INFO[group].preselect,
          })),
        ];
      }),
    }]);

    chosen = candidates.filter((i) => picked.includes(i.id));
  }

  if (chosen.length === 0) {
    console.log('  ' + chalk.gray('Nothing selected; nothing was removed.'));
    console.log();
    return 0;
  }

  const bytes = chosen.reduce((sum, i) => sum + (i.bytes ?? 0), 0);
  const nodeVersions = chosen.filter((i) => i.group === 'node-versions');

  if (!yes) {
    console.log();
    if (nodeVersions.length) {
      console.log('  ' + chalk.yellow(
        `This will uninstall ${nodeVersions.length} Node version(s): `
        + nodeVersions.map((i) => `v${i.version}`).join(', '),
      ));
      console.log('  ' + chalk.gray('Anything outside Easy DevOps that uses them will stop working.'));
    }

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Remove ${chosen.length} item(s), freeing about ${cleanup.humanBytes(bytes)}?`,
      default: false,
    }]);

    if (!confirm) {
      console.log('  ' + chalk.gray('Nothing was removed.'));
      console.log();
      return 0;
    }
  }

  console.log();
  const result = await cleanup.apply({
    items: chosen,
    log: (line) => console.log('  ' + chalk.gray(line)),
  });
  console.log();

  console.log('  ' + chalk.green(
    `Removed ${result.removed.length} item(s), freeing about ${cleanup.humanBytes(result.freedBytes)}.`,
  ));

  for (const failure of result.failed) {
    console.log('  ' + chalk.yellow(`could not remove ${failure.path}: ${failure.reason}`));
  }

  console.log();
  return result.failed.length === 0 ? 0 : 1;
}
