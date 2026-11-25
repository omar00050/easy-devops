/**
 * cli/elevation.js
 *
 * "This needs administrator rights. Relaunch as administrator? (Y/n)"
 *
 * Windows Server mode keeps administrator rights for everything that replaces
 * the service's files: install, uninstall, repair, update, runtime update. A
 * process cannot elevate itself, so the answer to a normal terminal is a NEW
 * elevated PowerShell window running the same command with the same
 * arguments. One UAC prompt, no password — UAC asks Windows, not us — and
 * that window shows its own output and stays open at the end.
 *
 * The check comes before anything is changed, and the original window only
 * says it handed off. Without a terminal to answer in (a script, CI) nothing
 * is relaunched: the exact command is printed and the exit code is non-zero,
 * so automation cannot silently hang on a UAC prompt nobody sees.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';

import { isWindows, windowsElevatedRelaunchCmd } from '../core/platform.js';
import { WINDOWS_POWERSHELL } from '../core/service/acl.js';
import { runFile } from '../core/shell.js';
import { isElevated } from '../core/service/windowsService.js';
import { currentUser, OPERATOR_SID_ENV } from '../core/service/operator.js';

/** Exit code for "this terminal could not do it": nothing was changed. */
export const NEEDS_ELEVATION_EXIT = 3;

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function printCommand(command) {
  console.log('  ' + chalk.white('Open PowerShell with "Run as administrator" and run:'));
  console.log();
  console.log('    ' + chalk.cyan(command));
  console.log();
  console.log('  ' + chalk.gray('No password is needed — only elevation. Nothing was changed.'));
}

/**
 * Makes sure this command runs elevated, or hands it to a window that does.
 *
 * @param {Object} opts
 * @param {string[]} opts.args   The CLI arguments to run elevated, e.g. ['update', '--yes']
 * @param {string} [opts.what]   What needs it, for the message ("Updating Easy DevOps")
 * @param {boolean} [opts.yes]   `--yes` was given: relaunch without asking (UAC still asks)
 * @param {Object} [opts.deps]   For tests: isWindows, isElevated, isInteractive, prompt, currentUser, run, argv1
 * @returns {Promise<{ proceed: true } | { proceed: false, code: number }>}
 *   proceed: true when this process is elevated (or this is not Windows) — go on.
 *   Otherwise stop with `code`: 0 handed off, non-zero refused or not possible.
 */
export async function requireElevation({ args, what = 'This', yes = false, deps = {} }) {
  if (!(deps.isWindows ?? isWindows)) return { proceed: true };

  const elevated = await (deps.isElevated ?? isElevated)({});
  if (elevated === true) return { proceed: true };

  const command = `ezz ${args.join(' ')}`;
  console.log();

  if (elevated === null) {
    console.log('  ' + chalk.yellow(`Could not verify administrator rights for ${what.toLowerCase()}.`));
    console.log('  ' + chalk.gray('Nothing was changed. Open PowerShell with "Run as administrator" and run the command below.'));
    printCommand(command);
    return { proceed: false, code: NEEDS_ELEVATION_EXIT };
  }

  console.log('  ' + chalk.yellow(`${what} needs administrator rights (Windows Server mode).`));

  if (!(deps.isInteractive ?? isInteractive)()) {
    printCommand(command);
    return { proceed: false, code: NEEDS_ELEVATION_EXIT };
  }

  let relaunch = yes;
  if (!relaunch) {
    try {
      ({ relaunch } = await (deps.prompt ?? inquirer.prompt)([{
        type: 'confirm',
        name: 'relaunch',
        message: 'This needs administrator rights. Relaunch as administrator?',
        default: true,
      }]));
    } catch (err) {
      if (err.name !== 'ExitPromptError') throw err;
      relaunch = false;
    }
  }

  if (!relaunch) {
    console.log();
    printCommand(command);
    return { proceed: false, code: NEEDS_ELEVATION_EXIT };
  }

  // Who asked, so the elevated copy grants start/stop to this account even
  // when the UAC prompt is answered with another administrator's credentials.
  const me = await (deps.currentUser ?? currentUser)({});
  const env = me ? { [OPERATOR_SID_ENV]: me.sid } : {};

  const script = windowsElevatedRelaunchCmd({
    execPath: process.execPath,
    script: deps.argv1 ?? process.argv[1],
    args,
    cwd: process.cwd(),
    env,
  });
  const result = await (deps.runFile ?? runFile)(WINDOWS_POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 120_000 });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  console.log();
  if (result.success && /relaunched/.test(output)) {
    console.log('  ' + chalk.green('Handed off to an elevated PowerShell window.'));
    console.log('  ' + chalk.gray(`It runs \`${command}\` and stays open at the end. This window changed nothing.`));
    console.log();
    return { proceed: false, code: 0 };
  }

  const why = output.match(/relaunch-failed:\s*(.*)/)?.[1]?.trim();
  console.log('  ' + chalk.yellow(
    /cancel/i.test(why ?? '') ? 'The administrator prompt was declined.' : `Could not relaunch${why ? `: ${why}` : '.'}`,
  ));
  printCommand(command);
  return { proceed: false, code: NEEDS_ELEVATION_EXIT };
}

/**
 * For commands that do not need elevation in principle but were refused it:
 * start, stop and restart on an install that predates the operator grant.
 *
 * @param {Object} result A core result with `needsElevation`
 * @param {string[]} args
 * @returns {Promise<number|null>} an exit code when it handled the refusal, else null
 */
export async function offerRelaunchFor(result, args, { deps = {} } = {}) {
  if (!(deps.isWindows ?? isWindows) || !result?.needsElevation) return null;
  const gate = await requireElevation({ args, what: `\`ezz ${args.join(' ')}\``, deps });
  return gate.proceed ? null : gate.code;
}
