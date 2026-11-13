/**
 * cli/menus/service.js
 *
 * `ezz service install | uninstall | status | restart | logs`
 *
 * The CLI is the only place the Windows "server" boot mode can be set up: it
 * needs administrator rights and a real terminal, because Windows itself
 * prompts for the account password (see core/service.js). The dashboard can
 * only report on it.
 *
 * Nothing here installs PM2 or pm2-logrotate without asking.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { isWindows, isDevDataDir, getDataDir } from '../../core/platform.js';
import * as service from '../../core/service.js';
import * as runner from '../../core/runner.js';

const ACTIONS = ['install', 'uninstall', 'status', 'restart', 'logs'];

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
    case 'restart': return doRestart();
    case 'logs': return showLogs();
    default: return 1;
  }
}

// ─── status ───────────────────────────────────────────────────────────────────

/**
 * Renders the service state. Also used after install/uninstall so the user
 * always sees the result rather than just a success line.
 * @returns {Promise<number>}
 */
export async function showStatus() {
  const spinner = ora('Checking the service…').start();
  const s = await service.status();
  spinner.stop();

  console.log();
  console.log('  ' + chalk.bold('Easy DevOps service'));
  console.log('  ' + chalk.gray('─'.repeat(52)));

  if (!s.pm2.installed) {
    console.log('  ' + chalk.yellow('PM2 is not installed.'));
    console.log('  ' + chalk.gray('Run `ezz service install` to set it up.'));
    console.log();
    return 0;
  }

  const dot = (ok) => (ok ? chalk.green('●') : chalk.red('●'));
  // Unknown is its own colour: it is not a failure, it is a missing answer.
  const bootDot = (v) => (v === null ? chalk.yellow('●') : dot(v));

  // The version is only read when the PM2 daemon is already running: asking
  // for it would start one, and a status check must not do that.
  const pm2Label = s.pm2.version
    ? `v${s.pm2.version}`
    : chalk.gray('installed (daemon not running)');
  console.log(`  PM2            ${pm2Label}  ${chalk.gray(s.pm2.path ?? '')}`);
  console.log(`  App            ${s.appName}${s.dev ? chalk.yellow('  (dev)') : ''}`);
  console.log(`  Installed      ${dot(s.installed)} ${s.installed ? 'yes' : 'no'}`);
  console.log(`  Running        ${dot(s.running)} ${s.running ? 'yes' : `no${s.status ? ` (${s.status})` : ''}`}`);
  console.log(`  Start on boot  ${bootDot(s.enabledOnBoot)} ${describeBoot(s)}`);
  console.log(`  Data directory ${chalk.gray(s.dataDir)}`);

  if (s.app) {
    const mem = s.app.memoryBytes ? `${Math.round(s.app.memoryBytes / 1048576)} MB` : '—';
    const up = s.app.uptimeMs !== null ? humanDuration(s.app.uptimeMs) : '—';
    console.log(`  Process        pid ${s.app.pid ?? '—'}  cpu ${s.app.cpu ?? 0}%  mem ${mem}  up ${up}  restarts ${s.app.restarts}`);
  }

  // PM2 keeps one process list per user; another account's service is
  // invisible here and cannot be controlled from this session.
  if (!s.sameUser) {
    console.log();
    console.log('  ' + chalk.yellow(`⚠ The service belongs to OS user "${s.appUser}", but you are "${s.currentUser}".`));
    console.log('  ' + chalk.gray('PM2 keeps a separate process list per user, so you cannot control it from here.'));
    console.log('  ' + chalk.gray(`Sign in as "${s.appUser}" to manage it.`));
  }

  if (s.pm2Home) {
    console.log('  ' + chalk.gray(`PM2_HOME       ${s.pm2Home}`));
  }

  if (s.bootDetail) {
    console.log();
    console.log('  ' + chalk.gray(s.bootDetail));
  }

  console.log();
  return 0;
}

function describeBoot(s) {
  // null means "could not be determined" — a non-systemd Linux, say — and must
  // not be shown as a confident "no".
  if (s.enabledOnBoot === null) return 'unknown';
  if (!s.enabledOnBoot) return 'no';
  if (s.bootMode === service.BOOT_MODES.LOGON) return 'yes — at logon';
  if (s.bootMode === service.BOOT_MODES.BOOT) return 'yes — at system startup';
  return 'yes';
}

// ─── install ──────────────────────────────────────────────────────────────────

async function doInstall() {
  console.log();
  console.log('  ' + chalk.bold('Install the Easy DevOps service'));
  console.log('  ' + chalk.gray('─'.repeat(52)));
  if (isDevDataDir()) {
    console.log('  ' + chalk.bgYellow.black(' DEV MODE ') +
      chalk.yellow(`  app "${runner.appName(true)}", data ${getDataDir()}`));
  }
  console.log();

  // ── PM2 ────────────────────────────────────────────────────────────────────
  let pm2 = await runner.detect();
  let installPm2 = false;

  if (!pm2.installed) {
    console.log('  PM2 keeps the dashboard running and restarts it after a crash or a reboot.');
    const { yes } = await prompt({
      type: 'confirm', name: 'yes',
      message: 'PM2 is not installed. Install it globally now (npm install -g pm2)?',
      default: true,
    });
    if (!yes) {
      console.log('  ' + chalk.gray('Nothing was changed. PM2 is required for the service.'));
      console.log();
      return 1;
    }
    installPm2 = true;
  } else {
    console.log(`  PM2 ${chalk.gray(`v${pm2.version ?? '?'}`)} found at ${chalk.gray(pm2.path)}`);
  }

  // ── pm2-logrotate ──────────────────────────────────────────────────────────
  let installLogrotate = false;
  const logrotatePresent = pm2.installed
    ? await runner.hasLogrotate({ pm2Path: pm2.path ?? 'pm2' })
    : false;

  if (!logrotatePresent) {
    const { yes } = await prompt({
      type: 'confirm', name: 'yes',
      message: 'Install pm2-logrotate too, so PM2 logs cannot fill the disk?',
      default: true,
    });
    installLogrotate = yes;
  }

  // ── Start on boot ──────────────────────────────────────────────────────────
  const bootMode = await chooseBootMode();
  if (bootMode === undefined) {
    console.log('  ' + chalk.gray('Cancelled. Nothing was changed.'));
    console.log();
    return 1;
  }

  console.log();
  const spinner = ora('Installing…').start();
  const res = await service.install({ installPm2, installLogrotate, bootMode });
  spinner.stop();

  for (const step of res.steps) {
    const mark = step.ok ? chalk.green('✓') : chalk.yellow('•');
    console.log(`  ${mark} ${step.step}${step.detail ? chalk.gray(`  ${firstLine(step.detail)}`) : ''}`);
  }

  if (!res.ok) {
    console.log();
    console.log('  ' + chalk.red(res.error ?? 'Install failed.'));
    console.log();
    return 1;
  }

  // On Linux PM2 prints a command that must be run as root. Showing it beats
  // adding sudoers rules for something done once.
  if (res.sudoCommand) {
    console.log();
    console.log('  ' + chalk.bold('One more step — run this as root to finish start-on-boot:'));
    console.log();
    console.log('    ' + chalk.cyan(res.sudoCommand));
    console.log();
    console.log('  ' + chalk.gray('Easy DevOps does not run this for you, so it needs no sudoers rules.'));
  }

  await showStatus();
  return 0;
}

/**
 * Asks how the service should come back after a reboot.
 *
 * Windows gets the two modes described in core/service.js. Linux and macOS
 * have one answer — PM2's own init-system hook — so there is nothing to ask
 * beyond whether to set it up.
 *
 * @returns {Promise<string|null|undefined>} mode, null to skip, undefined if cancelled
 */
async function chooseBootMode() {
  if (!isWindows) {
    const { yes } = await prompt({
      type: 'confirm', name: 'yes',
      message: 'Start the service automatically on boot?',
      default: true,
    });
    return yes ? service.BOOT_MODES.BOOT : null;
  }

  const suggested = await service.defaultBootMode();
  const isServer = suggested === service.BOOT_MODES.BOOT;

  if (isServer) {
    console.log();
    console.log('  ' + chalk.gray('Windows Server detected — defaulting to start at system startup.'));
  }

  const { mode } = await prompt({
    type: 'list',
    name: 'mode',
    message: 'How should the service start after a reboot?',
    default: suggested,
    choices: [
      {
        name: 'Server — at system startup, even with nobody logged in (needs Administrator + your password, asked by Windows)',
        value: service.BOOT_MODES.BOOT,
      },
      {
        name: 'Personal/dev machine — at logon only; signing out stops it (no Administrator, no password)',
        value: service.BOOT_MODES.LOGON,
      },
      { name: "Don't start on boot", value: null },
    ],
  });

  if (mode === service.BOOT_MODES.BOOT) {
    // Fail early with the real reason rather than after PM2 work is done.
    if (!(await service.isElevated())) {
      console.log();
      console.log('  ' + chalk.yellow('That mode needs administrator rights.'));
      console.log('  ' + chalk.gray('Open an Administrator PowerShell and run `ezz service install` again,'));
      console.log('  ' + chalk.gray('or choose the personal/dev machine mode.'));
      console.log();
      return undefined;
    }
    if (!process.stdin.isTTY) {
      console.log();
      console.log('  ' + chalk.yellow('Windows must prompt for the account password, which needs a real terminal.'));
      console.log();
      return undefined;
    }
    console.log();
    console.log('  ' + chalk.gray('Windows will now ask for your account password. Easy DevOps never sees it:'));
    console.log('  ' + chalk.gray('schtasks collects it directly and stores it in the Windows credential vault.'));
  }

  return mode;
}

// ─── uninstall ────────────────────────────────────────────────────────────────

async function doUninstall() {
  const s = await service.status();

  console.log();
  if (!s.installed && !s.enabledOnBoot) {
    console.log('  ' + chalk.gray('The service is not installed. Nothing to do.'));
    console.log();
    return 0;
  }

  const { yes } = await prompt({
    type: 'confirm', name: 'yes',
    message: `Remove the service "${s.appName}" and its start-on-boot entry?`,
    default: false,
  });
  if (!yes) {
    console.log('  ' + chalk.gray('Cancelled.'));
    console.log();
    return 1;
  }

  const spinner = ora('Removing…').start();
  const res = await service.uninstall();
  spinner.stop();

  for (const step of res.steps) {
    const mark = step.ok ? chalk.green('✓') : chalk.yellow('•');
    console.log(`  ${mark} ${step.step}${step.detail ? chalk.gray(`  ${firstLine(step.detail)}`) : ''}`);
  }

  // PM2 itself is deliberately left installed: other apps may rely on it.
  console.log();
  console.log('  ' + chalk.gray('PM2 itself was left installed — other apps may be using it.'));

  // The boot mechanism is shared, so removing it would stop OTHER apps coming
  // back after a reboot. Say so rather than leaving it looking like a failure.
  if (res.keptBootMechanism) {
    console.log();
    console.log('  ' + chalk.yellow('Start-on-boot was left in place.'));
    console.log('  ' + chalk.gray(
      res.remainingApps.length
        ? `PM2 still manages: ${res.remainingApps.join(', ')} — removing it would stop those`
        : 'the PM2 app list could not be read, so it was left alone to be safe'));
    console.log('  ' + chalk.gray('coming back after a reboot.'));
  }

  if (res.sudoCommand) {
    console.log();
    console.log('  ' + chalk.bold('Run this as root to remove the boot hook:'));
    console.log();
    console.log('    ' + chalk.cyan(res.sudoCommand));
  }

  console.log();
  return 0;
}

// ─── restart / logs ───────────────────────────────────────────────────────────

async function doRestart() {
  const spinner = ora('Restarting the service…').start();
  const res = await service.restart();
  if (res.ok) spinner.succeed('Service restarted');
  else spinner.fail(firstLine(res.output) || 'Could not restart the service');
  console.log();
  return res.ok ? 0 : 1;
}

async function showLogs() {
  const spinner = ora('Reading service logs…').start();
  const res = await service.logs({ lines: 200 });
  spinner.stop();

  if (!res.ok && res.lines.length === 0) {
    console.log('  ' + chalk.yellow(firstLine(res.output) || 'No logs available.'));
    console.log();
    return 1;
  }

  console.log();
  for (const line of res.lines) console.log('  ' + chalk.gray(line));
  console.log();
  return 0;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** inquirer prompt that treats Ctrl+C as a decline rather than a crash. */
async function prompt(question) {
  try {
    return await inquirer.prompt([question]);
  } catch (err) {
    if (err?.name === 'ExitPromptError') return { [question.name]: question.type === 'confirm' ? false : null };
    throw err;
  }
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
}

function humanDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
