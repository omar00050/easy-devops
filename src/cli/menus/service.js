/**
 * cli/menus/service.js
 *
 * `ezz service install | uninstall | status | start | stop | restart | logs | repair`
 *
 * The CLI owns every question. `core/service/` sequences the work but never
 * prompts, so the dashboard cannot trigger anything interactive and the core
 * stays callable from a test with no terminal.
 *
 * Installing a Windows service in Server mode needs an Administrator terminal,
 * which is why that path is CLI-only and says so. **No password is ever
 * requested here or anywhere below it** — on Linux sudo does its own asking,
 * and the Windows service runs as a virtual account that has no password.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';

import { isWindows, isDevDataDir, getDataDir } from '../../core/platform.js';
import * as service from '../../core/service/index.js';
import { describeLegacy } from '../../core/service/legacy.js';

const ACTIONS = ['install', 'uninstall', 'status', 'start', 'stop', 'restart', 'logs', 'repair'];

/**
 * Entry point for the `service` command.
 * @param {string} action
 * @returns {Promise<number>} Process exit code
 */
export async function serviceCommand(action) {
  if (!ACTIONS.includes(action)) {
    process.stderr.write(
      `Unknown service action: ${action}\n` +
      `Available: ${ACTIONS.join(', ')}\n`
    );
    return 1;
  }

  switch (action) {
    case 'status': return showStatus();
    case 'install': return doInstall();
    case 'uninstall': return doUninstall();
    case 'start': return doStart();
    case 'stop': return doStop();
    case 'restart': return doRestart();
    case 'logs': return showLogs();
    case 'repair': return doRepair();
    default: return 1;
  }
}

// ─── Shared rendering ─────────────────────────────────────────────────────────

const dot = (ok) => (ok ? chalk.green('●') : chalk.red('●'));
/** Unknown is its own colour: it is a missing answer, not a failure. */
const maybeDot = (v) => (v === null || v === undefined ? chalk.yellow('●') : dot(v));

const MECHANISM_LABELS = {
  systemd: 'systemd unit',
  winsw: 'Windows Service (WinSW)',
  'startup-supervisor': 'Startup-folder supervisor',
  none: 'none',
};

/**
 * A timestamp a person can read, in their own timezone.
 *
 * ISO-8601 UTC ("2026-11-14T23:21:18.682Z") was being printed straight from
 * the stored value, which is both the wrong clock for the reader and harder to
 * scan than it needs to be. The stored value stays ISO — it is a record — and
 * only the display is converted.
 *
 * @param {string|number|null} value ISO string or epoch milliseconds
 * @returns {string}
 */
function localTime(value) {
  if (value === null || value === undefined) return '—';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function humanDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function printWarnings(warnings) {
  if (!warnings?.length) return;
  console.log();
  for (const warning of warnings) {
    const [first, ...rest] = String(warning).split('\n');
    console.log('  ' + chalk.yellow('⚠ ') + chalk.yellow(first));
    for (const line of rest) console.log('    ' + chalk.gray(line));
  }
}

// ─── status ───────────────────────────────────────────────────────────────────

/**
 * Renders the service state. Also used after install/uninstall, so the user
 * always sees the resulting state rather than only a success line.
 * @returns {Promise<number>}
 */
export async function showStatus() {
  const spinner = ora('Checking the service…').start();
  let s;
  try {
    s = await service.status();
  } catch (err) {
    spinner.fail(`Could not read the service state: ${err.message}`);
    return 1;
  }
  spinner.stop();

  console.log();
  console.log('  ' + chalk.bold('Easy DevOps background service'));
  console.log('  ' + chalk.gray('─'.repeat(58)));

  if (isDevDataDir()) {
    console.log('  ' + chalk.bgYellow.black(' DEV MODE ') + chalk.yellow(`  data ${getDataDir()}`));
    console.log();
  }

  const modeLabel = s.mode ? ` (${s.mode})` : '';
  console.log(`  Mechanism      ${MECHANISM_LABELS[s.mechanism] ?? s.mechanism}${chalk.gray(modeLabel)}`);
  console.log(`  Installed      ${dot(s.service.installed)} ${s.service.installed ? 'yes' : 'no'}`);

  if (s.mode === service.MODES.PERSONAL) {
    console.log(`  Starts         ${chalk.gray('at logon (nothing runs before you sign in)')}`);
  } else {
    console.log(`  Running        ${dot(s.service.running)} ${s.service.running ? 'yes' : `no${s.service.state ? ` (${s.service.state})` : ''}`}`);
    console.log(`  Start on boot  ${maybeDot(s.service.enabledOnBoot)} ${describeBoot(s.service.enabledOnBoot)}`);
  }

  // The daemon's own heartbeat, which is the authority on whether background
  // work is actually happening. A service manager reporting "running" is not
  // the same thing.
  //
  // "stopped by you" is its own state, in its own colour: a user who stopped
  // it deliberately must not be told their service crashed.
  const d = s.daemon;
  const daemonLine = d.running
    ? `running (pid ${d.pid}, since ${localTime(d.startedAt)}, up ${humanDuration(d.startedAt ? Date.now() - d.startedAt : null)})`
    : s.stoppedByUser
      ? chalk.yellow('stopped by you') + chalk.gray(s.stoppedAt ? ` at ${localTime(s.stoppedAt)}` : '')
      : `not running ${chalk.gray(`— ${d.detail}`)}`;

  const daemonDot = d.running ? dot(true) : s.stoppedByUser ? chalk.yellow('●') : dot(false);
  console.log(`  Daemon         ${daemonDot} ${daemonLine}`);

  if (s.service.restarts) {
    console.log(`  Restarts       ${s.service.crashLooping ? chalk.red(s.service.restarts) : s.service.restarts}`);
  }

  console.log(`  Data directory ${chalk.gray(s.dataDir)}${s.serverMode ? chalk.gray('  (server mode)') : ''}`);
  console.log(`  Dashboard UI   ${chalk.gray(s.dashboardUi ?? 'unknown')}`);

  // Runtime: the service's pinned Node next to the one in this shell.
  const rt = s.runtime;
  console.log();
  console.log(`  System Node    ${rt.systemNode.version} ${chalk.gray(rt.systemNode.path)}`);

  if (rt.pinned && rt.pinned.kind !== 'none') {
    const label = rt.pinned.version ?? chalk.red('not runnable');
    const kind = { symlink: 'link', copy: 'copy', recorded: 'recorded path', 'real file': 'file' }[rt.pinned.kind] ?? rt.pinned.kind;
    console.log(`  Service Node   ${label} ${chalk.gray(`(${kind}: ${rt.pinned.path})`)}`);
    if (rt.pinned.target && rt.pinned.target !== rt.pinned.path) {
      console.log(`                 ${chalk.gray(`→ ${rt.pinned.target}`)}`);
    }
  } else {
    console.log(`  Service Node   ${chalk.gray('not pinned yet')}`);
  }

  if (rt.manager?.managed) {
    console.log(`  Version manager${chalk.gray(` ${rt.manager.manager} — the service is pinned so switching versions cannot break it`)}`);
  }

  printWarnings(s.warnings);

  if (!s.service.installed) {
    console.log();
    console.log('  ' + chalk.gray('Install it with: ') + chalk.white('ezz service install'));
  }

  console.log();
  return 0;
}

function describeBoot(enabled) {
  if (enabled === null || enabled === undefined) return 'unknown';
  return enabled ? 'yes' : 'no';
}

// ─── install ──────────────────────────────────────────────────────────────────

async function doInstall() {
  console.log();
  console.log('  ' + chalk.bold('Install the Easy DevOps background service'));
  console.log('  ' + chalk.gray('─'.repeat(58)));

  if (isDevDataDir()) {
    console.log('  ' + chalk.bgYellow.black(' DEV MODE ') + chalk.yellow(`  data ${getDataDir()}`));
  }
  console.log();

  // ── Windows: Server or Personal ──────────────────────────────────────────
  let mode = null;

  if (isWindows) {
    const suggested = await service.suggestWindowsMode();

    console.log('  ' + chalk.gray(`Detected: ${suggested.detail}`));
    console.log();

    if (suggested.isServerEdition) {
      // On a server the answer is clear, so it is stated rather than asked:
      // the machine exists to serve and nobody is logged in most of the time.
      console.log('  ' + chalk.white('This is Windows Server, so Server mode is the right choice.'));
      console.log('  ' + chalk.gray('It runs as a real Windows Service, starts before anyone logs in,'));
      console.log('  ' + chalk.gray('and needs an Administrator terminal once. You will NOT be asked'));
      console.log('  ' + chalk.gray('for a password: the service uses a Windows-managed account.'));
      console.log();

      const { confirmServer } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmServer',
        message: 'Install in Server mode?',
        default: true,
      }]);
      mode = confirmServer ? service.MODES.SERVER : service.MODES.PERSONAL;
    } else {
      const { chosen } = await inquirer.prompt([{
        type: 'list',
        name: 'chosen',
        message: 'How should the background service run?',
        default: service.MODES.PERSONAL,
        choices: [
          {
            name: 'Personal — starts when you log in. No administrator rights needed.',
            value: service.MODES.PERSONAL,
          },
          {
            name: 'Server — a real Windows Service, starts at boot. Needs an Administrator terminal once.',
            value: service.MODES.SERVER,
          },
        ],
      }]);
      mode = chosen;
    }

    if (mode === service.MODES.SERVER) {
      console.log();
      console.log('  ' + chalk.yellow('Server mode will move your data to C:\\ProgramData\\easy-devops'));
      console.log('  ' + chalk.gray('so the service account and your CLI can share one database.'));
      console.log('  ' + chalk.gray('It is copied, verified, and the original is kept as a backup.'));
      console.log();

      const { confirmMove } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmMove',
        message: 'Continue?',
        default: true,
      }]);
      if (!confirmMove) {
        console.log('  ' + chalk.gray('Nothing was changed.'));
        return 0;
      }
    }
  }

  // ── The old PM2 setup ────────────────────────────────────────────────────
  let removeLegacy = false;
  const found = await service.legacy.detectLegacy();

  if (found.found) {
    console.log();
    console.log(describeLegacy(found.items).split('\n').map((l) => `  ${chalk.yellow(l)}`).join('\n'));
    console.log();

    const { cleanup } = await inquirer.prompt([{
      type: 'confirm',
      name: 'cleanup',
      message: 'Remove the old PM2-based setup?',
      default: true,
    }]);
    removeLegacy = cleanup;
  }

  // ── Install ──────────────────────────────────────────────────────────────
  console.log();
  const spinner = ora('Installing…').start();
  const lines = [];

  let result;
  try {
    result = await service.install({
      mode,
      removeLegacy,
      log: (line) => { lines.push(line); spinner.text = line; },
    });
  } catch (err) {
    spinner.fail(`Install failed: ${err.message}`);
    return 1;
  }

  spinner.stop();
  for (const line of lines) console.log('  ' + chalk.gray(line));

  if (!result.ok) {
    console.log();

    if (result.manual) {
      // No systemd: not a failure, just a different answer.
      console.log('  ' + chalk.yellow(result.reason));
      console.log();
      console.log(result.manual.split('\n').map((l) => `  ${l}`).join('\n'));
      console.log();
      return 0;
    }

    console.log('  ' + chalk.red('Install failed.'));
    console.log(String(result.reason).split('\n').map((l) => `  ${l}`).join('\n'));

    if (result.needsElevation) {
      console.log();
      console.log('  ' + chalk.gray('No password is needed — only elevation.'));
    }
    console.log();
    return 1;
  }

  console.log();
  console.log('  ' + chalk.green('✓ Installed.'));

  if (result.migrated) {
    console.log('  ' + chalk.gray(`Data moved to ${result.dataDir}`));
    if (result.backup) console.log('  ' + chalk.gray(`Backup kept at ${result.backup}`));
  }

  if (result.legacy?.removed?.length) {
    console.log('  ' + chalk.gray(`Removed from the old setup: ${result.legacy.removed.join(', ')}`));
  }
  for (const failure of result.legacy?.failed ?? []) {
    console.log('  ' + chalk.yellow(`⚠ could not remove ${failure.name}: ${failure.reason}`));
  }
  for (const failure of result.aclFailures ?? []) {
    console.log('  ' + chalk.yellow(`⚠ ${failure.path}: ${failure.reason}`));
  }

  if (result.mode === service.MODES.PERSONAL) {
    console.log();
    console.log('  ' + chalk.white('It will start automatically the next time you log in.'));
    console.log('  ' + chalk.gray(`Supervisor log: ${result.logFile}`));
    console.log();

    // Offer to start it now, through exactly the same path as
    // `ezz service start`. The old message suggested `ezz daemon` instead,
    // which is wrong for this purpose: that runs a daemon in the foreground
    // tied to the terminal, so closing the window stops it. The supervisor is
    // what should own it.
    const started = await offerToStart();
    if (started !== null) return started;

    return 0;
  }

  if (result.daemon?.pid) {
    console.log('  ' + chalk.gray(`Daemon reported in after ${Math.round(result.daemon.waitedMs / 1000)}s (pid ${result.daemon.pid})`));
  }

  console.log();
  return showStatus();
}

/**
 * Asks whether to start the service now, and does it the same way
 * `ezz service start` does.
 *
 * @returns {Promise<number|null>} An exit code, or null when not started
 */
async function offerToStart() {
  // Already up — a Server-mode install starts the service itself, and so does a
  // repair. Nothing to offer.
  if (service.backgroundServiceState().running) return null;

  let answer;
  try {
    ({ answer } = await inquirer.prompt([{
      type: 'confirm',
      name: 'answer',
      message: 'Start it now?',
      default: true,
    }]));
  } catch (err) {
    // Ctrl+C at the prompt is not a failure: the install succeeded.
    if (err.name === 'ExitPromptError') return null;
    throw err;
  }

  if (!answer) {
    console.log('  ' + chalk.gray('Not started. Start it any time with: ') + chalk.white('ezz service start'));
    console.log();
    return null;
  }

  return doStart();
}

// ─── uninstall ────────────────────────────────────────────────────────────────

async function doUninstall() {
  const current = await service.status().catch(() => null);

  console.log();
  console.log('  ' + chalk.bold('Remove the Easy DevOps background service'));
  console.log('  ' + chalk.gray('─'.repeat(58)));
  console.log();

  // Nothing to remove: say so and stop, rather than asking the user to confirm
  // removing something that does not exist and then reporting success. The one
  // thing still worth offering is cleaning up the OLD PM2-based setup, and only
  // when some of it is actually there.
  if (current && !current.service.installed) {
    console.log('  ' + chalk.white('No background service is installed.'));
    console.log('  ' + chalk.gray('Nothing to remove.'));

    const leftovers = await service.legacy.detectLegacy();
    if (!leftovers.found) {
      console.log();
      console.log('  ' + chalk.gray('Install one with: ') + chalk.white('ezz service install'));
      console.log();
      return 0;
    }

    console.log();
    console.log(describeLegacy(leftovers.items).split('\n').map((l) => `  ${chalk.yellow(l)}`).join('\n'));
    console.log();

    const { cleanupOnly } = await inquirer.prompt([{
      type: 'confirm',
      name: 'cleanupOnly',
      message: 'Remove the old PM2-based setup?',
      default: true,
    }]);

    if (!cleanupOnly) {
      console.log('  ' + chalk.gray('Nothing was changed.'));
      return 0;
    }

    const spinner = ora('Removing the old setup...').start();
    const cleaned = await service.legacy.removeLegacy({
      items: leftovers.items,
      log: (line) => { spinner.text = line; },
    });
    spinner.stop();

    if (cleaned.removed.length) {
      console.log('  ' + chalk.green(`✓ Removed: ${cleaned.removed.join(', ')}`));
    }
    for (const failure of cleaned.failed) {
      console.log('  ' + chalk.yellow(`⚠ could not remove ${failure.name}: ${failure.reason}`));
    }
    console.log();
    return cleaned.ok ? 0 : 1;
  }

  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: 'Remove the background service? Monitoring will then only run while a dashboard is open.',
    default: false,
  }]);

  if (!confirm) {
    console.log('  ' + chalk.gray('Nothing was changed.'));
    return 0;
  }

  // ── Decision 5: the data location is an explicit question ────────────────
  //
  // Uninstalling must never silently move the data back to %APPDATA%. While
  // the marker exists, ProgramData holds the live data; relocating it without
  // asking would be a surprise, and the per-user copy is the stale one.
  let keepServerDataLocation = true;

  if (current?.serverMode) {
    console.log();
    console.log('  ' + chalk.white(`Your data currently lives at ${current.dataDir}`));
    console.log();

    const { dataChoice } = await inquirer.prompt([{
      type: 'list',
      name: 'dataChoice',
      message: 'What should happen to it?',
      default: 'keep',
      choices: [
        {
          name: `Keep it where it is (recommended) — the CLI and dashboard keep using ${current.dataDir}`,
          value: 'keep',
        },
        {
          name: 'Move it back to %APPDATA%\\easy-devops — copied, verified, with a backup kept',
          value: 'move',
        },
      ],
    }]);
    keepServerDataLocation = dataChoice === 'keep';
  }

  // ── The old PM2 setup ────────────────────────────────────────────────────
  let removeLegacy = false;
  const found = await service.legacy.detectLegacy();

  if (found.found) {
    console.log();
    console.log(describeLegacy(found.items).split('\n').map((l) => `  ${chalk.yellow(l)}`).join('\n'));
    console.log();

    const { cleanup } = await inquirer.prompt([{
      type: 'confirm',
      name: 'cleanup',
      message: 'Remove the old PM2-based setup as well?',
      default: true,
    }]);
    removeLegacy = cleanup;
  }

  console.log();
  const spinner = ora('Removing…').start();
  const lines = [];

  let result;
  try {
    result = await service.uninstall({
      keepServerDataLocation,
      removeLegacy,
      log: (line) => { lines.push(line); spinner.text = line; },
    });
  } catch (err) {
    spinner.fail(`Uninstall failed: ${err.message}`);
    return 1;
  }

  spinner.stop();
  for (const line of lines) console.log('  ' + chalk.gray(line));

  if (!result.ok) {
    console.log();
    console.log('  ' + chalk.red('Uninstall failed.'));
    console.log(String(result.reason).split('\n').map((l) => `  ${l}`).join('\n'));
    console.log();
    return 1;
  }

  console.log();
  console.log('  ' + chalk.green('✓ Removed.'));
  for (const note of result.notes ?? []) {
    console.log(('  ' + chalk.gray(note)).replace(/\n/g, '\n  '));
  }
  if (result.movedData) {
    console.log('  ' + chalk.gray(`Data moved back to ${result.dataDir}`));
    if (result.backup) console.log('  ' + chalk.gray(`Backup kept at ${result.backup}`));
  }
  if (result.legacy?.removed?.length) {
    console.log('  ' + chalk.gray(`Removed from the old setup: ${result.legacy.removed.join(', ')}`));
  }

  console.log();
  console.log('  ' + chalk.gray('Monitoring and notifications now run only while a dashboard is open.'));
  console.log();
  return 0;
}

// ─── stop / start ─────────────────────────────────────────────────────────────

async function doStop() {
  const spinner = ora('Stopping the background service…').start();
  const lines = [];

  let result;
  try {
    result = await service.stop({ log: (line) => { lines.push(line); spinner.text = line; } });
  } catch (err) {
    spinner.fail(`Stop failed: ${err.message}`);
    return 1;
  }

  spinner.stop();
  for (const line of lines) console.log('  ' + chalk.gray(line));

  if (!result.ok) {
    console.log();
    console.log('  ' + chalk.red('Could not stop it.'));
    console.log(String(result.reason).split('\n').map((l) => `  ${l}`).join('\n'));
    console.log();
    return 1;
  }

  console.log();
  console.log('  ' + chalk.green(result.alreadyStopped ? '✓ Already stopped.' : '✓ Stopped.'));
  if (result.detail) console.log('  ' + chalk.gray(result.detail));

  // The difference from uninstall is the thing a user most needs to hear.
  console.log();
  console.log('  ' + chalk.gray('This is temporary. It starts again '
    + (result.mode === service.MODES.PERSONAL ? 'at your next logon' : 'at the next boot') + ','));
  console.log('  ' + chalk.gray('or right now with: ') + chalk.white('ezz service start'));
  console.log('  ' + chalk.gray('To remove it permanently: ') + chalk.white('ezz service uninstall'));
  console.log();
  console.log('  ' + chalk.yellow('Monitoring and notifications are not running while it is stopped.'));
  console.log();
  return 0;
}

async function doStart() {
  const spinner = ora('Starting the background service…').start();
  const lines = [];

  let result;
  try {
    result = await service.start({ log: (line) => { lines.push(line); spinner.text = line; } });
  } catch (err) {
    spinner.fail(`Start failed: ${err.message}`);
    return 1;
  }

  spinner.stop();
  for (const line of lines) console.log('  ' + chalk.gray(line));

  if (!result.ok) {
    console.log();
    if (result.alreadyRunning) {
      console.log('  ' + chalk.yellow('Already running.'));
      console.log('  ' + chalk.gray(result.reason));
      console.log();
      return 0;
    }
    console.log('  ' + chalk.red('Could not start it.'));
    console.log(String(result.reason).split('\n').map((l) => `  ${l}`).join('\n'));
    if (result.needsElevation) {
      console.log();
      console.log('  ' + chalk.gray('No password is needed — only elevation.'));
    }
    console.log();
    return 1;
  }

  console.log();
  console.log('  ' + chalk.green(`✓ Started (pid ${result.pid}, reported in after ${Math.round(result.waitedMs / 1000)}s).`));
  console.log();
  return 0;
}

// ─── restart ──────────────────────────────────────────────────────────────────

async function doRestart() {
  const spinner = ora('Restarting the service…').start();

  let result;
  try {
    result = await service.restart({ log: (line) => { spinner.text = line; } });
  } catch (err) {
    spinner.fail(`Restart failed: ${err.message}`);
    return 1;
  }

  if (!result.ok) {
    spinner.stop();
    console.log();
    console.log('  ' + chalk.red('Restart failed.'));
    console.log(String(result.reason).split('\n').map((l) => `  ${l}`).join('\n'));
    console.log();
    return 1;
  }

  spinner.succeed(`Restarted (pid ${result.pid}, reported in after ${Math.round(result.waitedMs / 1000)}s)`);
  console.log();
  return 0;
}

// ─── logs ─────────────────────────────────────────────────────────────────────

async function showLogs() {
  const spinner = ora('Reading the service log…').start();

  let result;
  try {
    result = await service.logs({ lines: 80 });
  } catch (err) {
    spinner.fail(`Could not read the log: ${err.message}`);
    return 1;
  }
  spinner.stop();

  console.log();
  console.log('  ' + chalk.bold('Service log') + chalk.gray(`  ${result.source}`));
  console.log('  ' + chalk.gray('─'.repeat(58)));

  if (!result.output?.trim()) {
    console.log('  ' + chalk.gray('(empty)'));
  } else {
    for (const line of result.output.split('\n')) console.log('  ' + line);
  }

  console.log();
  return result.ok ? 0 : 1;
}

// ─── repair ───────────────────────────────────────────────────────────────────

async function doRepair() {
  console.log();
  console.log('  ' + chalk.bold('Repair the Easy DevOps service'));
  console.log('  ' + chalk.gray('─'.repeat(58)));
  console.log('  ' + chalk.gray('Re-pins the Node runtime, re-applies permissions, and restarts it.'));
  console.log();

  const spinner = ora('Repairing…').start();
  const lines = [];

  let result;
  try {
    result = await service.repair({ log: (line) => { lines.push(line); spinner.text = line; } });
  } catch (err) {
    spinner.fail(`Repair failed: ${err.message}`);
    return 1;
  }

  spinner.stop();
  for (const line of lines) console.log('  ' + chalk.gray(line));

  if (!result.ok) {
    console.log();
    console.log('  ' + chalk.red('Repair failed.'));
    console.log(String(result.reason).split('\n').map((l) => `  ${l}`).join('\n'));
    if (result.needsElevation) {
      console.log();
      console.log('  ' + chalk.gray('No password is needed — only elevation.'));
    }
    console.log();
    return 1;
  }

  console.log();
  console.log('  ' + chalk.green('✓ Repaired.'));
  for (const failure of result.aclFailures ?? []) {
    console.log('  ' + chalk.yellow(`⚠ ${failure.path}: ${failure.reason}`));
  }
  console.log();
  return showStatus();
}
