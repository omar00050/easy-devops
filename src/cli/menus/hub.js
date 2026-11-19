/**
 * cli/menus/hub.js
 *
 * `ezz hub connect | status | unlink` and the interactive Hub menu.
 *
 * Anything that reaches core/db.js lives here rather than in cli/index.js:
 * index.js is a thin bootstrap that decides the data directory before this
 * module is dynamically imported.
 *
 * The rule this file exists to keep: the connection string, the secret and the
 * one-time token are credentials. Nothing here prints them. The operator sees
 * the Hub's origin and the server id — which identify the pairing without
 * revealing anything that could be used to authenticate.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';

import {
  CONNECT_ERRORS,
  linkOrigin,
  resolveConnectInput,
} from '../../core/hubConnect.js';
import {
  clearHubLink,
  describeRejection,
  getHubLink,
  getLinkStatus,
  parseConnectionString,
  resolveHubOrigin,
  saveConnectionString,
} from '../../core/hubLink.js';
import { inspect } from '../../core/daemon/lock.js';
import { connectToDaemon } from '../../core/daemon/ipc.js';
import { page, pause, BACK } from '../ui/page.js';

const ACTIONS = ['connect', 'status', 'unlink'];

/** How long `connect` waits for the agent to report its first real outcome. */
const CONNECT_WAIT_MS = 30_000;
/** A status read must not make an ordinary command feel hung. */
const STATUS_WAIT_MS = 2_500;

/**
 * A test-only override for the link fetch timeout. Honoured only under
 * EZ_TEST=1, so a normal installation cannot change how long a pairing request
 * may take by setting an environment variable.
 */
const TEST_TIMEOUT_ENV = 'EZ_HUB_CONNECT_TIMEOUT_MS';

function connectDeps() {
  if (process.env.EZ_TEST !== '1') return {};
  const ms = Number(process.env[TEST_TIMEOUT_ENV]);
  return Number.isFinite(ms) && ms > 0 ? { timeoutMs: ms } : {};
}

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** The Hub's origin, never a path or token. */
function displayOrigin(hubUrl) {
  const resolved = resolveHubOrigin(hubUrl);
  return linkOrigin(resolved) ?? resolved;
}

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

/**
 * Waits, with a bound, for the daemon to tell us the agent's state.
 *
 * The daemon already publishes `hub:agentState` on the job bus and forwards its
 * frames over IPC (server → client only). Its hello frame carries the state at
 * connect time, so a CLI that starts after the agent connected still sees it.
 *
 * @param {Object} opts
 * @param {number} opts.timeoutMs
 * @param {(state: Object|null) => boolean} [opts.until]
 * @returns {Promise<{ state: Object|null, timedOut: boolean }>}
 */
function waitForAgentState({ timeoutMs, until = () => false }) {
  return new Promise((resolve) => {
    let latest = null;
    let finished = false;
    let client = null;

    const finish = (timedOut) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { client?.close(); } catch { /* already closed */ }
      resolve({ state: latest, timedOut });
    };

    const timer = setTimeout(() => finish(true), timeoutMs);

    client = connectToDaemon({
      onEvent(event, payload) {
        if (finished) return;
        if (event === 'daemon:hello') latest = payload?.hub ?? null;
        else if (event === 'hub:agentState') latest = payload;

        if (until(latest)) finish(false);
      },
      // Connecting is not yet state: the hello frame is what carries it.
      onStatus() {},
    });
  });
}

function printFailure(failure) {
  // hubConnect.js's messages never contain the token or connection string.
  say(chalk.red(failure.error));
  if (failure.code === CONNECT_ERRORS.REVOKED) {
    say(chalk.gray('A revoked link means the server was deleted on the Hub, or its secret changed.'));
  }
  if (failure.retryAfterSeconds) {
    say(chalk.gray(`The Hub asked to wait ${failure.retryAfterSeconds}s before trying again.`));
  }
  return 1;
}

/**
 * Reports the agent's state after a pairing was saved. Never prints a secret;
 * the only identifiers are the Hub origin and the server id.
 */
async function reportConnection(origin, serverId) {
  say(`Linked to ${chalk.bold(origin)}.`);
  say(`  Server: ${serverId}`);

  const daemon = inspect();
  if (!daemon.running) {
    say(chalk.yellow('The background service is not running, so the server is not connected yet — ')
      + 'run ' + chalk.bold('`ezz service start`') + ' (or open the dashboard).');
    return 0;
  }

  say(chalk.gray('Waiting for the background service to report the agent…'));
  const { state, timedOut } = await waitForAgentState({
    timeoutMs: CONNECT_WAIT_MS,
    until: (s) => s?.status === 'connected' || s?.status === 'rejected',
  });

  if (!state) {
    say(chalk.yellow(`The background service is running but did not report the agent's state `
      + `within ${Math.round(CONNECT_WAIT_MS / 1000)}s.`));
    say(chalk.gray('Check it with `ezz hub status`.'));
    return 0;
  }

  if (state.status === 'connected') {
    say(chalk.green(`Connected to ${origin}.`));
    return 0;
  }

  if (state.status === 'rejected') {
    say(chalk.red('The Hub rejected this pairing.'));
    say('  ' + (state.lastError || describeRejection('INVALID_SECRET')));
    say(chalk.gray('Create a new link in the Hub and run the new command.'));
    return 1;
  }

  if (state.status === 'unreachable') {
    say(chalk.yellow(`Saved, but the server cannot reach ${origin} yet.`));
    if (state.lastError) say('  ' + state.lastError);
    say(chalk.gray('It keeps retrying in the background.'));
    return 0;
  }

  // Still connecting, or the daemon answered with a state this CLI does not
  // recognise. Both are "not connected yet", which is the honest answer.
  say(chalk.yellow(timedOut
    ? `Still connecting to ${origin} after ${Math.round(CONNECT_WAIT_MS / 1000)}s.`
    : `Saved. The agent is ${state.status ?? 'not reported'} — it will keep trying in the background.`));
  return 0;
}

async function connect(target, { yes = false } = {}) {
  if (!target) {
    say(chalk.red('Missing pairing link.'));
    say('  ezz hub connect <link-or-ezops-string> [--yes]');
    return 1;
  }

  let resolved;
  try {
    resolved = await resolveConnectInput(target, connectDeps());
  } catch {
    // resolveConnectInput() returns failures rather than throwing; this is a
    // belt-and-braces guard that still says nothing about the input.
    say(chalk.red('Could not read the pairing link or connection string.'));
    return 1;
  }

  if (!resolved.ok) return printFailure(resolved);

  const parsed = parseConnectionString(resolved.connectionString);
  if (!parsed.ok) {
    say(chalk.red(parsed.error));
    return 1;
  }

  const next = parsed.link;
  const nextOrigin = displayOrigin(next.hubUrl);

  const current = getHubLink();
  if (current) {
    const sameHub = resolveHubOrigin(current.hubUrl) === resolveHubOrigin(next.hubUrl);
    const sameServer = current.serverId === next.serverId;
    if (!sameHub || !sameServer) {
      const currentOrigin = displayOrigin(current.hubUrl);

      if (!yes && !isInteractive()) {
        say(chalk.yellow(`This server is already linked to ${currentOrigin} as server ${current.serverId}.`));
        say('Run the same command with ' + chalk.bold('--yes') + ' to replace that link.');
        return 1;
      }

      if (!yes) {
        const { replace } = await inquirer.prompt([{
          type: 'confirm',
          name: 'replace',
          message: `Replace the existing link to ${currentOrigin} (server ${current.serverId})?`,
          default: false,
        }]);
        if (!replace) {
          say('Nothing was changed.');
          return 0;
        }
      }
    }
  }

  const saved = saveConnectionString(resolved.connectionString);
  if (!saved.ok) {
    say(chalk.red(saved.error));
    return 1;
  }

  return reportConnection(nextOrigin, next.serverId);
}

async function status() {
  const link = getLinkStatus();

  say(chalk.bold('Hub pairing'));
  if (!link.linked) {
    say('  Not linked.');
    say(chalk.gray('Pair with: ') + 'ezz hub connect <link-or-ezops-string>');
    return 0;
  }

  const origin = displayOrigin(link.hubUrl);
  const enabled = Object.entries(link.permissions ?? {})
    .filter(([, value]) => value === true)
    .map(([id]) => id);

  say(`  Hub        : ${origin}`);
  say(`  Server     : ${link.serverId}`);
  say(`  Permissions: ${enabled.length ? `${enabled.length} granted — ${enabled.join(', ')}` : 'none granted'}`);

  const daemon = inspect();
  if (!daemon.running) {
    say('  Agent      : the background service is not running, so the server is not connected');
    return 0;
  }

  const { state } = await waitForAgentState({
    timeoutMs: STATUS_WAIT_MS,
    until: (s) => Boolean(s),
  });

  if (!state) {
    say('  Agent      : not reported by the background service yet');
    return 0;
  }

  const suffix = state.lastError ? ` — ${state.lastError}` : '';
  say(`  Agent      : ${state.status ?? 'unknown'}${suffix}`);
  return 0;
}

async function unlink({ yes = false } = {}) {
  const link = getLinkStatus();
  if (!link.linked) {
    say('Not linked to a Hub.');
    return 0;
  }

  const origin = displayOrigin(link.hubUrl);

  if (!yes) {
    if (!isInteractive()) {
      say(chalk.yellow(`This server is linked to ${origin}.`));
      say('Run ' + chalk.bold('ezz hub unlink --yes') + ' to remove the link.');
      return 1;
    }

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Unlink this server from ${origin}?`,
      default: false,
    }]);
    if (!confirm) {
      say('Nothing was changed.');
      return 0;
    }
  }

  clearHubLink();
  say(`Unlinked from ${origin}.`);
  say(chalk.gray('The server stays listed in the Hub as offline until you delete it there.'));
  return 0;
}

/**
 * @param {string} [action]
 * @param {string[]} [args] Positional arguments after the action
 * @param {{ yes?: boolean }} [opts]
 * @returns {Promise<number>} Process exit code
 */
export async function hubCommand(action = 'status', args = [], { yes = false } = {}) {
  if (!ACTIONS.includes(action)) {
    process.stderr.write(
      `Unknown hub action: ${action}\n` +
      `Available: ${ACTIONS.join(', ')}\n`,
    );
    return 1;
  }

  if (action === 'connect') return connect(args[0], { yes });
  if (action === 'status') return status();
  return unlink({ yes });
}

/** The interactive Hub menu. */
export async function hubMenu() {
  page(['Hub']);

  const { choice } = await inquirer.prompt([{
    type: 'list',
    name: 'choice',
    message: 'Hub:',
    choices: ['Connect / re-pair', 'Status', 'Unlink', new inquirer.Separator(), BACK],
  }]);

  if (choice === BACK) return;

  if (choice === 'Status') {
    page(['Hub', 'Status']);
    await status();
    await pause();
    return;
  }

  if (choice === 'Unlink') {
    page(['Hub', 'Unlink']);
    await unlink({ yes: false });
    await pause();
    return;
  }

  page(['Hub', 'Connect']);
  const { target } = await inquirer.prompt([{
    type: 'password',
    name: 'target',
    mask: '*',
    message: 'Paste the pairing link or ezops:// connection string:',
  }]);

  await connect(target, { yes: false });
  await pause();
}

// Every other file in menus/ is imported as a default by cli/menu.js. This
// file's primary export is the non-interactive command, so the interactive
// menu is exported as the default as well.
export default hubMenu;
