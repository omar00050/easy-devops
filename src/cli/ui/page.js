/**
 * cli/ui/page.js
 *
 * One way to draw a CLI page, so every menu looks the same and the screen holds
 * one menu instead of a scrollback of every menu visited on the way here.
 *
 *   page(['SSL', 'Issue']);
 *
 * clears the screen (only where that is safe) and prints the breadcrumb
 *
 *   Easy DevOps > SSL > Issue
 *
 * before the page body. `pause()` is the other half: a long operation leaves
 * its result on screen until Enter, and returns at once when nobody can press
 * it (a pipe, a script, CI), so `ezz service start | tee log` still works.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';

/** The one label every submenu uses for "leave this menu". */
export const BACK = '← Back';
/** The one label the main menu uses for "leave the program". */
export const EXIT = '✖ Exit';

/**
 * The clear sequence.
 *
 * `ESC[2J` erases the visible screen, `ESC[3J` erases the scrollback (so the
 * previous menu cannot be scrolled back into view, which is the whole point),
 * and `ESC[H` homes the cursor. Windows Terminal, PowerShell 7 and every
 * mainstream Linux terminal (xterm, VTE, kitty, alacritty) understand all
 * three. The legacy conhost window does not implement `ESC[3J`; it ignores
 * that one parameter and still clears and homes on the other two, which is
 * why this sequence is used rather than `console.clear()`: Node's
 * `console.clear()` writes the same kind of escape on POSIX but a bare form
 * feed on some Windows consoles, which leaves the previous page visible.
 *
 * Colour is never part of this: chalk is left to decide for itself, so a pipe
 * gets plain text.
 */
const CLEAR_SEQUENCE = '\x1b[2J\x1b[3J\x1b[H';

/** What "truthy" means for an environment variable: set and not '0'. */
function envTruthy(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim().toLowerCase();
  return text !== '' && text !== '0' && text !== 'false';
}

/**
 * Whether the screen may be cleared, as a pure decision so it can be tested
 * without a terminal.
 *
 * Clearing is allowed ONLY when:
 *  - stdout is a real TTY (a pipe or a file gets every line, never an escape);
 *  - CI is not set, because a CI log is read later and must stay complete;
 *  - this is not an EZ_TEST-driven run with no TTY, where the output is being
 *    captured by a suite and a clear would only add noise to the assertion.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.isTTY] Defaults to process.stdout.isTTY
 * @param {Object} [opts.env] Defaults to process.env
 * @returns {boolean}
 */
export function shouldClearScreen({
  isTTY = Boolean(process.stdout.isTTY),
  env = process.env,
} = {}) {
  const inCI = envTruthy(env.CI);
  const testCapture = envTruthy(env.EZ_TEST) && !isTTY;
  return Boolean(isTTY) && !inCI && !testCapture;
}

/** `Easy DevOps > SSL > Issue`, with the product name in the brand colour. */
function breadcrumb(titlePath) {
  const parts = ['Easy DevOps', ...titlePath.filter(Boolean).map(String)];
  const separator = chalk.gray(' > ');
  return parts
    .map((part, index) => (index === 0 ? chalk.hex('#d64a29').bold(part) : chalk.bold.white(part)))
    .join(separator);
}

/**
 * Starts a page: clears the screen where that is safe, then prints the
 * breadcrumb. Pass `{ clear: false }` for a command whose output is not a
 * menu screen (`ezz service status`, `ezz cleanup`): it gets no escape code
 * even in a terminal.
 *
 * @param {string[]} [titlePath] e.g. ['SSL', 'Issue']
 * @param {Object} [opts]
 * @param {boolean} [opts.clear] Force the decision one way or the other
 */
export function page(titlePath = [], { clear } = {}) {
  const clearNow = clear === undefined
    ? shouldClearScreen()
    : Boolean(clear) && Boolean(process.stdout.isTTY) && !envTruthy(process.env.CI);

  if (clearNow) process.stdout.write(CLEAR_SEQUENCE);
  process.stdout.write(`${breadcrumb(titlePath)}\n`);
}

/** True only when a person can actually see a prompt and answer it. */
export function isInteractiveIO() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Waits for Enter so a result stays on screen — and returns immediately when
 * there is no TTY (or in CI), because a prompt there would hang a script.
 *
 * @param {string} [message]
 */
export async function pause(message = 'Press Enter to continue') {
  if (!isInteractiveIO() || envTruthy(process.env.CI)) return;

  try {
    await inquirer.prompt([{ type: 'input', name: '_', message }]);
  } catch (err) {
    // Ctrl+C at the pause is the user leaving, not a failed command.
    if (err?.name !== 'ExitPromptError') throw err;
  }
}
