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

import fs from 'fs';
import path from 'path';

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';

import {
  isWindows, isDevDataDir, getDataDir, isServerMode, programDataDir,
} from '../../core/platform.js';
import * as service from '../../core/service/index.js';
import { describeLegacy } from '../../core/service/legacy.js';
import { page, pause, isInteractiveIO } from '../ui/page.js';
import { requireElevation, offerRelaunchFor } from '../elevation.js';

const ACTIONS = ['install', 'uninstall', 'status', 'start', 'stop', 'restart', 'logs', 'repair', 'recover'];

/**
 * Actions that change something, as opposed to read-only ones (`status`,
 * `logs`). Only these get a page heading and hold their result until Enter;
 * the read-only pair must stay pipeable, so it does neither.
 */
const MUTATING_ACTIONS = new Set(['install', 'uninstall', 'start', 'stop', 'restart', 'repair', 'recover']);

/**
 * Entry point for the `service` command.
 *
 * @param {string} action
 * @param {Object|string} [options]
 *        `{ leftoverChoice, yes }`. A bare `'adopt'` / `'keep-aside'` string is
 *        read as the leftover choice too, so both call shapes the CLI bootstrap
 *        may produce keep working while the lanes land.
 * @returns {Promise<number>} Process exit code
 */
export async function serviceCommand(action, options = {}) {
  if (!ACTIONS.includes(action)) {
    process.stderr.write(
      `Unknown service action: ${action}\n` +
      `Available: ${ACTIONS.join(', ')}\n`
    );
    return 1;
  }

  const opts = typeof options === 'string' ? { leftoverChoice: options } : (options ?? {});
  const leftoverChoice = opts.leftoverChoice === 'adopt' || opts.leftoverChoice === 'keep-aside'
    ? opts.leftoverChoice
    : undefined;
  // `--yes` may arrive as an option (the bootstrap passes it) or, on a build
  // that does not pass options yet, only in argv. Both mean the same thing.
  const yes = opts.yes === true || process.argv.includes('--yes');

  let code;
  switch (action) {
    case 'status': code = await showStatus(); break;
    case 'install': code = await doInstall({ leftoverChoice, yes }); break;
    case 'uninstall': code = await doUninstall({ yes }); break;
    case 'start': code = await doStart(); break;
    case 'stop': code = await doStop(); break;
    case 'restart': code = await doRestart(); break;
    case 'logs': code = await showLogs(); break;
    case 'recover': code = await doRepair(true, { yes }); break;
    case 'repair': code = await doRepair(false, { yes }); break;
    default: code = 1;
  }

  if (MUTATING_ACTIONS.has(action)) await pause();
  return code;
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

/**
 * Warning lines as text, so the whole status report can be built (and tested)
 * without printing it.
 *
 * @param {string[]} warnings
 * @returns {string[]}
 */
function warningLines(warnings) {
  if (!warnings?.length) return [];
  const lines = [''];
  for (const warning of warnings) {
    const [first, ...rest] = String(warning).split('\n');
    lines.push('  ' + chalk.yellow('⚠ ') + chalk.yellow(first));
    for (const line of rest) lines.push('    ' + chalk.gray(line));
  }
  return lines;
}

// ─── status ───────────────────────────────────────────────────────────────────

/**
 * What the status lines are allowed to claim, decided in one place so the
 * lines cannot contradict each other.
 *
 *  - `registered` is tri-state. "not installed" is only printed when the
 *    service manager said so; an unknown answer stays unknown.
 *  - The service version is shown only for a registered service. 1.4.7 printed
 *    the CLI's own version while no service existed (the real server report).
 *  - An unfinished install says exactly one thing: resume it. Every
 *    permission-derived warning is dropped while that is true.
 *  - The operator line and the "needs an Administrator terminal" warning are
 *    both derived from the same live field (`operatorControl`, read from the
 *    service's DACL), so they can never disagree.
 *
 * @param {Object} s The `service.status()` result
 * @returns {Object}
 */
export function statusView(s = {}) {
  const registered = s.serviceInstalled === true
    ? true
    : s.serviceInstalled === false
      ? false
      : s.service?.installed === true
        ? true
        : s.service?.installed === false
          ? false
          : null;

  const installProgress = s.installProgress ?? s.service?.installProgress ?? null;
  const failedStep = installProgress?.failedStep ?? null;
  const installUnfinished = Boolean(failedStep);
  const windowsServer = s.mode === service.MODES.SERVER || s.serverMode === true;

  const operator = s.operator ?? null;
  const controlMeasured = operator?.verified === true;
  const controlGranted = controlMeasured ? operator.serviceControl === true : null;

  const warnings = filterStatusWarnings(s, { installUnfinished, controlGranted });

  let operatorRights = null;
  if (operator) {
    if (controlMeasured) {
      operatorRights = {
        text: operator.serviceControl ? 'start/stop/restart' : 'nothing',
        checked: true,
      };
    } else {
      // Never dress the install record up as a live measurement.
      const recorded = [operator.serviceControl && 'start/stop/restart', operator.dataDir && 'data']
        .filter(Boolean).join(', ') || 'nothing';
      operatorRights = { text: `${recorded} (recorded; not re-checked)`, checked: false };
    }
  }

  return {
    registered,
    installedText: registered === null ? 'unknown' : registered ? 'installed' : 'not installed',
    showServiceVersion: registered === true,
    installUnfinished,
    failedStep,
    installLine: installUnfinished
      ? `Install not finished (stopped at ${failedStep}): run \`ezz service install\` to resume.`
      : null,
    windowsServer,
    operator,
    controlMeasured,
    controlGranted,
    operatorRights,
    warnings,
    hint: installUnfinished ? 'resume' : registered === false ? 'install' : registered === null ? 'unknown' : null,
  };
}

/**
 * The warnings a status read may print, after removing the ones a newer,
 * live measurement supersedes and the ones that would contradict the install
 * progress or the live operator field.
 *
 * @param {Object} s The `service.status()` result
 * @param {Object} [state]
 * @returns {string[]}
 */
export function filterStatusWarnings(s = {}, { installUnfinished = false, controlGranted = null } = {}) {
  const liveChecked = s.liveGrants?.checked === true
    || s.service?.liveGrants?.checked === true
    || s.service?.acl?.checked === true;

  const seen = new Set();
  const out = [];
  const raw = Array.isArray(s.warnings) ? s.warnings : [];

  for (const entry of raw) {
    const text = typeof entry === 'string' ? entry.trim() : '';
    if (!text) continue;

    // One install line, printed from `installProgress` (item 6).
    if (installUnfinished && /install not finished/i.test(text)) continue;
    // While install is unfinished, a permission warning would send the user to
    // repair for a step install has not reached yet.
    if (installUnfinished
      && /(service account|could not read the permissions|has no access|no access to|need an Administrator terminal|recorded permission check)/i.test(text)) {
      continue;
    }
    // The live ACL read is the authority; a recorded check is not.
    if (liveChecked && /no recorded permission check/i.test(text)) continue;
    // The live operator field says start/stop works: the warning is stale.
    if (controlGranted === true && /need an Administrator terminal/i.test(text)) continue;
    // The canonical not-installed sentence is printed once, as the hint below.
    if (/^The Easy DevOps service is not installed on this Windows Server\./i.test(text)) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }

  return out;
}

/**
 * Warning block for leftover Server-mode data seen by a CLI that is not using
 * it. Key COUNTS only: values and key names never leave the database here.
 *
 * @param {Object} leftover `detectLeftoverServerData()`'s result
 * @param {string} dataDir The directory this process actually uses
 * @returns {string}
 */
function leftoverStatusWarning(leftover, dataDir) {
  const program = leftover?.programData ?? {};
  const user = leftover?.userData ?? {};
  const used = dataDir ?? user.dir ?? 'this CLI\'s data directory';
  const count = (db) => (Number.isFinite(db?.keyCount) ? db.keyCount : '?');
  // The count beside "this CLI is using" comes from the inspection of that same
  // directory, never from the other database.
  const norm = (p) => {
    try {
      return isWindows ? path.resolve(p).toLowerCase() : path.resolve(p);
    } catch {
      return String(p);
    }
  };
  const usedDb = user.dir && norm(used) === norm(user.dir)
    ? user.db
    : (program.dir && norm(used) === norm(program.dir) ? program.db : user.db);

  return `An earlier Server-mode install's data is in ${program.dir ?? 'C:\\ProgramData\\easy-devops'} `
    + `(${count(program.db)} keys); this CLI is using ${used} (${count(usedDb)} keys).\n`
    + 'Run `ezz service install` from an Administrator PowerShell; it will ask which one to keep '
    + '(or pass --adopt-existing-data / --set-aside-existing-data).';
}

/**
 * Builds the status report as lines, so the decisions above can be asserted
 * without a terminal (and without a real service).
 *
 * @param {Object} s The `service.status()` result
 * @param {Object} [opts]
 * @param {Object|null} [opts.leftover] `detectLeftoverServerData()`'s result
 * @returns {string[]}
 */
export function buildStatusLines(s = {}, { leftover = null } = {}) {
  const view = statusView(s);
  const lines = [];
  const svc = s.service ?? {};

  const modeLabel = s.mode ? ` (${s.mode})` : '';
  lines.push(`  Mechanism      ${MECHANISM_LABELS[s.mechanism] ?? s.mechanism}${chalk.gray(modeLabel)}`);
  lines.push(`  Service        ${maybeDot(view.registered)} ${view.installedText}`);

  if (view.registered !== false) {
    if (s.mode === service.MODES.PERSONAL) {
      lines.push(`  Starts         ${chalk.gray('at logon (nothing runs before you sign in)')}`);
    } else {
      const runningText = svc.running === null || svc.running === undefined
        ? 'unknown'
        : (svc.running ? 'yes' : `no${svc.state ? ` (${svc.state})` : ''}`);
      lines.push(`  Running        ${maybeDot(svc.running)} ${runningText}`);
      lines.push(`  Start on boot  ${maybeDot(svc.enabledOnBoot)} ${describeBoot(svc.enabledOnBoot)}`);
    }
  }

  // The daemon's own heartbeat, which is the authority on whether background
  // work is actually happening. A service manager reporting "running" is not
  // the same thing.
  //
  // "stopped by you" is its own state, in its own colour: a user who stopped
  // it deliberately must not be told their service crashed.
  const d = s.daemon ?? {};
  const daemonLine = d.running
    ? `running (pid ${d.pid}, since ${localTime(d.startedAt)}, up ${humanDuration(d.startedAt ? Date.now() - d.startedAt : null)})`
    : s.stoppedByUser
      ? chalk.yellow('stopped by you') + chalk.gray(s.stoppedAt ? ` at ${localTime(s.stoppedAt)}` : '')
      : `not running ${chalk.gray(`— ${d.detail}`)}`;

  const daemonDot = d.running ? dot(true) : s.stoppedByUser ? chalk.yellow('●') : dot(false);
  lines.push(`  Daemon         ${daemonDot} ${daemonLine}`);

  // Clean restarts (a stop, restart, update or repair) and crash restarts are
  // told apart: only the second kind is a problem, and only it can make a
  // crash loop.
  if (s.service?.restarts) {
    const crashes = s.service.crashRestarts ?? 0;
    const clean = s.service.cleanRestarts ?? (s.service.restarts - crashes);
    const parts = [];
    if (clean) parts.push(`${clean} clean (stop/restart)`);
    if (crashes) parts.push(s.service.crashLooping ? chalk.red(`${crashes} after a crash`) : `${crashes} after a crash`);
    lines.push(`  Restarts       ${parts.join(', ')} ${chalk.gray('in the last 10 min')}`);
  }

  // The directory labelled here is the one THIS process actually uses
  // (`getDataDir()`), and the label comes from the Server-mode marker alone —
  // never from the mechanism or the edition. A Server with no marker uses
  // %APPDATA%, and saying "server mode" would hide that (the 1.4.7 report).
  const markerServerMode = typeof s.serverMode === 'boolean' ? s.serverMode : isServerMode();
  lines.push(`  Data directory ${chalk.gray(s.dataDir)}`
    + chalk.gray(markerServerMode ? '  (server mode)' : '  (per-user)'));
  lines.push(`  Dashboard UI   ${chalk.gray(s.dashboardUi ?? 'unknown')}`);

  // In Windows Server mode the service runs its own copy of the package, so
  // these two can disagree after a plain `npm i -g` (finding A3). The service
  // version is only meaningful when a service is registered: with none, the
  // 1.4.7 report printed the CLI's own version and looked installed.
  if (view.showServiceVersion) {
    lines.push(`  Service version${chalk.gray(' ')} ${s.serviceVersion ? chalk.white(s.serviceVersion) : chalk.gray('unknown')}`);
  }
  lines.push(`  CLI version    ${s.cliVersion ? chalk.white(s.cliVersion) : chalk.gray('unknown')}`);

  // Server mode: who may start/stop it and use the data without elevation.
  // Both halves come from the same live field, so they cannot contradict.
  if (s.mode === service.MODES.SERVER && view.registered === true) {
    if (!view.operator) {
      lines.push(`  Without admin  ${dot(false)} nobody ${chalk.gray('(ezz service repair as administrator allows your account)')}`);
    } else {
      const operatorDot = view.operatorRights.checked
        ? dot(view.operator.serviceControl)
        : chalk.yellow('●');
      lines.push(`  Without admin  ${operatorDot} `
        + `${view.operator.name ?? view.operator.sid}: ${view.operatorRights.text}`
        + (view.operatorRights.checked ? chalk.gray('  (checked on the service)') : ''));
    }
  }

  // Runtime: the service's pinned Node next to the one in this shell.
  const rt = s.runtime;
  if (rt?.systemNode) {
    lines.push('');
    lines.push(`  System Node    ${rt.systemNode.version} ${chalk.gray(rt.systemNode.path)}`);

    if (rt.pinned && rt.pinned.kind !== 'none') {
      const label = rt.pinned.version ?? chalk.red('not runnable');
      const kind = { symlink: 'link', copy: 'copy', recorded: 'recorded path', 'real file': 'file' }[rt.pinned.kind] ?? rt.pinned.kind;
      lines.push(`  Service Node   ${label} ${chalk.gray(`(${kind}: ${rt.pinned.path})`)}`);
      if (rt.pinned.target && rt.pinned.target !== rt.pinned.path) {
        lines.push(`                 ${chalk.gray(`→ ${rt.pinned.target}`)}`);
      }
    } else {
      lines.push(`  Service Node   ${chalk.gray('not pinned yet')}`);
    }

    if (rt.manager?.managed) {
      lines.push(`  Version manager${chalk.gray(` ${rt.manager.manager} — the service is pinned so switching versions cannot break it`)}`);
    }
  }

  // One install line, then the live-read warnings, then the data-location
  // warning. All three are separate facts and none repeats another.
  if (view.installLine) lines.push(...warningLines([view.installLine]));
  lines.push(...warningLines(view.warnings));
  if (leftover?.leftover === true && !markerServerMode) {
    lines.push(...warningLines([leftoverStatusWarning(leftover, s.dataDir)]));
  }

  if (view.hint === 'resume') {
    lines.push('');
    lines.push('  ' + chalk.gray('Resume it with: ') + chalk.white('ezz service install'));
  } else if (view.hint === 'install') {
    lines.push('');
    if (view.windowsServer) {
      lines.push('  ' + chalk.gray('Run ') + chalk.white('ezz service install')
        + chalk.gray(' from an Administrator PowerShell.'));
    } else {
      lines.push('  ' + chalk.gray('Install it with: ') + chalk.white('ezz service install'));
    }
  } else if (view.hint === 'unknown') {
    lines.push('');
    lines.push('  ' + chalk.gray('The service manager gave no usable answer. Check with: ')
      + chalk.white('ezz service status'));
  }

  return lines;
}

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

  // A Server-mode install whose marker is gone leaves its database behind in
  // ProgramData while this CLI uses %APPDATA%. Say both, with key counts only.
  // Two small files and two read-only opens; worth it for a status read that
  // would otherwise imply the near-empty database is all there is. When the
  // marker exists the detector reports nothing, so the call is skipped.
  let leftover = null;
  if (isWindows && !isServerMode()) {
    try {
      leftover = (await service.serviceInstallState())?.leftover ?? null;
    } catch {
      leftover = null;
    }
  }

  for (const line of buildStatusLines(s, { leftover })) console.log(line);

  console.log();
  return 0;
}

function describeBoot(enabled) {
  if (enabled === null || enabled === undefined) return 'unknown';
  return enabled ? 'yes' : 'no';
}

// ─── leftover Server data ─────────────────────────────────────────────────────

/** Bytes in the unit a person reads, or null when it is not known. */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}

/** Key NAMES only — never a value, and never the database file's contents. */
function keyNameLines(keys) {
  const names = (Array.isArray(keys) ? keys : []).filter((name) => typeof name === 'string' && name);
  if (names.length === 0) return ['    keys: (none)'];

  const lines = [];
  const indent = '    ';
  let current = `${indent}keys: `;
  for (const name of names) {
    const piece = current === `${indent}keys: ` ? name : `, ${name}`;
    if (current.length + piece.length > 74 && current !== `${indent}keys: `) {
      lines.push(current);
      current = `${indent}      ${name}`;
    } else {
      current += piece;
    }
  }
  lines.push(current);
  return lines;
}

function databaseLines(entry) {
  const dir = entry?.dir ?? '?';
  const db = entry?.db ?? {};
  const lines = [`  ${chalk.white(path.join(dir, 'easy-devops.sqlite'))}`];

  if (db.error) {
    lines.push(`    ${chalk.yellow('could not be read:')} ${db.error}`);
    return lines;
  }
  if (db.exists === false) {
    lines.push(`    ${chalk.gray('no database here')}`);
    return lines;
  }

  const parts = [
    `${db.keyCount ?? 0} key${db.keyCount === 1 ? '' : 's'}`,
    humanBytes(db.size),
    db.mtime ? `modified ${localTime(db.mtime)}` : null,
  ].filter(Boolean);
  lines.push(`    ${parts.join(', ')}`);
  lines.push(...keyNameLines(db.keys));
  return lines;
}

function leftoverEffect(choice, programDir) {
  return choice === 'adopt'
    ? `restores the Server-mode marker and leaves %APPDATA% untouched.`
    : `renames ${programDir} to easy-devops.old-<date>, then migrates %APPDATA%.`;
}

/**
 * Both databases side by side, key names only, and the two choices.
 *
 * @param {Object} leftover `detectLeftoverServerData()`'s result
 * @returns {string[]} lines, ready to print
 */
export function leftoverReportLines(leftover = {}) {
  const program = leftover.programData ?? {};
  const user = leftover.userData ?? {};
  const programDir = program.dir ?? 'C:\\ProgramData\\easy-devops';
  const recommended = leftover.recommended === 'keep-aside' ? 'keep-aside' : 'adopt';

  const lines = [];
  lines.push('');
  lines.push('  ' + chalk.white('Two Easy DevOps databases were found. Nothing has been changed.'));
  lines.push('');
  lines.push('  ' + chalk.gray('C:\\ProgramData (Server mode)'));
  lines.push(...databaseLines(program));
  lines.push('');
  lines.push('  ' + chalk.gray('%APPDATA% (per-user)'));
  lines.push(...databaseLines(user));
  lines.push('');

  const programCount = Number.isFinite(program.db?.keyCount) ? program.db.keyCount : 0;
  const userCount = Number.isFinite(user.db?.keyCount) ? user.db.keyCount : 0;
  if (program.db?.error || user.db?.error) {
    lines.push('  ' + chalk.yellow('One database could not be read, so compare them by hand before choosing.'));
  } else if (programCount === userCount) {
    lines.push(`  Both databases have ${programCount} keys, so the default is to use ${programDir} as it is.`);
  } else {
    const more = programCount > userCount ? programDir : (user.dir ?? '%APPDATA%\\easy-devops');
    lines.push(`  The database in ${more} has more keys (${Math.max(programCount, userCount)} vs ${Math.min(programCount, userCount)}).`);
  }

  lines.push('');
  lines.push(`  Recommended: ${recommended === 'adopt' ? 'adopt' : 'set aside'} — ${leftoverEffect(recommended, programDir)}`);
  const other = recommended === 'adopt' ? 'keep-aside' : 'adopt';
  lines.push(`  The other:   ${other === 'adopt' ? 'adopt' : 'set aside'} — ${leftoverEffect(other, programDir)}`);
  return lines;
}

/**
 * How a leftover decision is taken, as a pure decision: a flag wins, an
 * unattended run refuses, and only a person is asked.
 *
 * @param {Object} opts
 * @returns {{ action: 'use'|'ask'|'refuse', choice?: 'adopt'|'keep-aside' }}
 */
export function leftoverChoicePlan({ leftoverChoice, interactive = false, assumeYes = false } = {}) {
  if (leftoverChoice === 'adopt' || leftoverChoice === 'keep-aside') {
    return { action: 'use', choice: leftoverChoice };
  }
  if (!interactive || assumeYes) return { action: 'refuse' };
  return { action: 'ask' };
}

/**
 * The exact commands an unattended install must use (item 5). Exported so the
 * suite can assert the words, and printed in one place only.
 */
export const LEFTOVER_COMMANDS = Object.freeze([
  'ezz service install --adopt-existing-data',
  'ezz service install --set-aside-existing-data',
]);

function printLeftoverRefusal() {
  console.log();
  console.log('  ' + chalk.yellow('Nothing was changed. Run one of these from an Administrator PowerShell:'));
  console.log();
  for (const command of LEFTOVER_COMMANDS) console.log('    ' + chalk.white(command));
  console.log();
}

async function decideLeftover(leftover, { leftoverChoice, yes }) {
  for (const line of leftoverReportLines(leftover)) console.log(line);

  const plan = leftoverChoicePlan({
    leftoverChoice,
    interactive: isInteractiveIO(),
    assumeYes: yes,
  });

  if (plan.action === 'refuse') {
    printLeftoverRefusal();
    return { ok: false, code: 1 };
  }
  if (plan.action === 'use') {
    console.log();
    console.log('  ' + chalk.green(plan.choice === 'adopt'
      ? '✓ Using the existing ProgramData database; %APPDATA% is not touched.'
      : '✓ Moving the existing ProgramData database aside first.'));
    console.log();
    return { ok: true, choice: plan.choice };
  }

  const programDir = leftover?.programData?.dir ?? 'C:\\ProgramData\\easy-devops';
  const recommended = leftover?.recommended === 'keep-aside' ? 'keep-aside' : 'adopt';

  let choice;
  try {
    ({ choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: 'Which database should the service use?',
      default: recommended,
      choices: [
        {
          name: `Use ${programDir} as it is (adopt)${recommended === 'adopt' ? ' — recommended' : ''}`,
          value: 'adopt',
        },
        {
          name: `Set it aside, then migrate %APPDATA% (keep-aside)${recommended === 'keep-aside' ? ' — recommended' : ''}`,
          value: 'keep-aside',
        },
      ],
    }]));
  } catch (err) {
    if (err?.name !== 'ExitPromptError') throw err;
    choice = null;
  }

  if (!choice) {
    console.log('  ' + chalk.gray('Nothing was changed.'));
    return { ok: false, code: 0 };
  }
  return { ok: true, choice };
}

/**
 * A confirmation with a default that an unattended run accepts, so `--yes`
 * and a pipe never hang on a prompt nobody can answer.
 *
 * @returns {Promise<boolean|null>} null when the user pressed Ctrl+C
 */
async function askConfirm(message, defaultValue, { assumeYes = false } = {}) {
  if (assumeYes || !isInteractiveIO()) return defaultValue;
  try {
    const { answer } = await inquirer.prompt([{
      type: 'confirm',
      name: 'answer',
      message,
      default: defaultValue,
    }]);
    return answer;
  } catch (err) {
    if (err?.name === 'ExitPromptError') return null;
    throw err;
  }
}

// ─── install ──────────────────────────────────────────────────────────────────

async function doInstall({ leftoverChoice = undefined, yes = false } = {}) {
  page(['Service', 'Install']);
  console.log();
  console.log('  ' + chalk.bold('Install the Easy DevOps background service'));
  console.log('  ' + chalk.gray('─'.repeat(58)));

  if (isDevDataDir()) {
    console.log('  ' + chalk.bgYellow.black(' DEV MODE ') + chalk.yellow(`  data ${getDataDir()}`));
  }
  console.log();

  // ── Windows: Server or Personal ──────────────────────────────────────────
  let mode = null;
  let chosenLeftover = leftoverChoice;
  let detectedLeftover = null;

  if (isWindows) {
    const suggested = await service.suggestWindowsMode();
    const state = await service.serviceInstallState().catch(() => null);
    detectedLeftover = state?.leftover ?? null;

    // Server-mode data in ProgramData makes this a Server install even on a
    // client edition: the real database decides the mechanism as much as the
    // edition does. 1.4.7 asked "how should it run?" and then installed the
    // Personal launcher on a server.
    const serverLike = suggested.isServerEdition
      || state?.mode === service.MODES.SERVER
      || state?.edition === 'server'
      || detectedLeftover?.leftover === true;

    console.log('  ' + chalk.gray(`Detected: ${suggested.detail}`));
    console.log();

    // The leftover decision comes FIRST: it needs no elevation, and an
    // unattended run must get a command rather than a UAC window.
    if (detectedLeftover?.leftover === true && !chosenLeftover) {
      const decided = await decideLeftover(detectedLeftover, { leftoverChoice: chosenLeftover, yes });
      if (!decided.ok) return decided.code;
      chosenLeftover = decided.choice;
    } else if (detectedLeftover?.leftover === true) {
      console.log('  ' + chalk.gray(chosenLeftover === 'adopt'
        ? `Using the existing data in ${detectedLeftover.programData?.dir ?? 'C:\\ProgramData\\easy-devops'}; %APPDATA% is not touched.`
        : 'Moving the existing ProgramData data aside before migrating %APPDATA%.'));
      console.log();
    }

    if (serverLike) {
      // On a server the answer is clear, so it is stated rather than asked:
      // the machine exists to serve and nobody is logged in most of the time.
      if (suggested.isServerEdition) {
        console.log('  ' + chalk.white('This is Windows Server, so Server mode is the right choice.'));
        console.log('  ' + chalk.gray('It runs as a real Windows Service, starts before anyone logs in,'));
        console.log('  ' + chalk.gray('and needs an Administrator terminal once. You will NOT be asked'));
        console.log('  ' + chalk.gray('for a password: the service uses a Windows-managed account.'));
      } else {
        console.log('  ' + chalk.white('Existing Server-mode data was found, so Server mode is the right choice.'));
        console.log('  ' + chalk.gray('It runs as a real Windows Service and needs an Administrator terminal once.'));
      }
      console.log();

      const confirmServer = await askConfirm('Install in Server mode?', true, { assumeYes: yes });
      if (confirmServer === null) {
        console.log('  ' + chalk.gray('Nothing was changed.'));
        return 0;
      }
      if (confirmServer) {
        mode = service.MODES.SERVER;
      } else {
        // Allowed, but not without saying what it costs on a server: Personal
        // mode is tied to this user's logon session.
        console.log();
        console.log('  ' + chalk.yellow('Personal mode instead:'));
        console.log('  ' + chalk.gray('• It only runs while this user is logged in.'));
        console.log('  ' + chalk.gray('• Signing out of RDP stops it; disconnecting the RDP window keeps it running.'));
        console.log('  ' + chalk.gray('• It does not start at boot before someone logs in.'));
        console.log();

        const confirmPersonal = await askConfirm('Install in Personal mode?', true, { assumeYes: yes });
        if (confirmPersonal === null) {
          console.log('  ' + chalk.gray('Nothing was changed.'));
          return 0;
        }
        if (!confirmPersonal) {
          console.log('  ' + chalk.gray('Nothing was changed.'));
          return 0;
        }
        mode = service.MODES.PERSONAL;
      }
    } else {
      let chosen = service.MODES.PERSONAL;
      if (isInteractiveIO() && !yes) {
        ({ chosen } = await inquirer.prompt([{
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
        }]));
      }
      mode = chosen;
    }

    // Before anything else is asked or changed: Server mode registers a
    // service and writes under ProgramData, and a normal terminal cannot.
    if (mode === service.MODES.SERVER) {
      // Carry a leftover flag through the elevated relaunch: dropping it would
      // make the elevated copy ask (or refuse) all over again.
      const extra = [];
      if (chosenLeftover === 'adopt') extra.push('--adopt-existing-data');
      else if (chosenLeftover === 'keep-aside') extra.push('--set-aside-existing-data');
      if (yes) extra.push('--yes');

      const gate = await requireElevation({
        args: ['service', 'install', ...extra],
        what: 'Installing in Server mode',
        yes,
      });
      if (!gate.proceed) return gate.code;
    }

    if (mode === service.MODES.SERVER) {
      console.log();
      if (chosenLeftover === 'adopt') {
        console.log('  ' + chalk.yellow(`Server mode will use ${detectedLeftover?.programData?.dir ?? 'C:\\ProgramData\\easy-devops'} as it is`));
        console.log('  ' + chalk.gray('and restore its Server-mode marker. %APPDATA% is not touched.'));
      } else {
        console.log('  ' + chalk.yellow('Server mode will move your data to C:\\ProgramData\\easy-devops'));
        console.log('  ' + chalk.gray('so the service account and your CLI can share one database.'));
        console.log('  ' + chalk.gray('It is copied, verified, and the original is kept as a backup.'));
      }
      console.log();

      const confirmMove = await askConfirm('Continue?', true, { assumeYes: yes });
      if (confirmMove === null) {
        console.log('  ' + chalk.gray('Nothing was changed.'));
        return 0;
      }
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

  const attempt = async (choice) => {
    lines.length = 0;
    spinner.start('Installing…');
    let result;
    try {
      result = await service.install({
        mode,
        removeLegacy,
        leftoverChoice: choice,
        log: (line) => { lines.push(line); spinner.text = line; },
      });
    } catch (err) {
      spinner.fail(`Install failed: ${err.message}`);
      throw Object.assign(err, { reported: true });
    }
    spinner.stop();
    for (const line of lines) console.log('  ' + chalk.gray(line));
    return result;
  };

  let result;
  try {
    result = await attempt(chosenLeftover);
  } catch (err) {
    if (!err.reported) spinner.fail(`Install failed: ${err.message}`);
    return 1;
  }

  // A leftover that was not seen by the early check (or a build without it)
  // still gets the same treatment: both databases, then a choice or a refusal.
  if (!result.ok && result.code === 'leftover_data') {
    const leftover = result.leftover
      ?? detectedLeftover
      ?? (await service.serviceInstallState().catch(() => null))?.leftover
      ?? null;
    const decided = await decideLeftover(leftover, { leftoverChoice: chosenLeftover, yes });
    if (!decided.ok) return decided.code;
    chosenLeftover = decided.choice;

    try {
      result = await attempt(chosenLeftover);
    } catch (err) {
      if (!err.reported) spinner.fail(`Install failed: ${err.message}`);
      return 1;
    }

    // Never loop, and never guess: if the core still refuses, say the two
    // commands and stop.
    if (!result.ok && result.code === 'leftover_data') {
      printLeftoverRefusal();
      return 1;
    }
  }

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
    console.log('  ' + chalk.gray('Troubleshooting: https://easy-devops.devxor.team/docs/troubleshooting'));
    console.log();
    return 1;
  }

  console.log();
  console.log('  ' + chalk.green('✓ Installed.'));

  if (result.migrated) {
    console.log('  ' + chalk.gray(`Data moved to ${result.dataDir}`));
    const original = service.describeOriginal(result);
    console.log('  ' + chalk.gray(`${original[0].toUpperCase()}${original.slice(1)}.`));
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

  // Out of waiting time while Windows reports the service RUNNING: installed,
  // just slow to initialise on its first start. Not a failure, so the status
  // table (which would show the daemon as not yet running) is not printed.
  if (result.stillInitialising) {
    console.log('  ' + chalk.yellow('Started, still initialising.'));
    console.log('  ' + chalk.gray('The first start can be slow while Windows scans the new runtime.'));
    console.log('  ' + chalk.gray('Check with ') + chalk.white('ezz service status') + chalk.gray(' in a minute.'));
    console.log();
    return 0;
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

async function doUninstall({ yes = false } = {}) {
  page(['Service', 'Uninstall']);

  if (isWindows && isServerMode()) {
    const gate = await requireElevation({
      args: ['service', 'uninstall'],
      what: 'Removing the Windows service',
      yes,
    });
    if (!gate.proceed) return gate.code;
  }

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

/**
 * Every action that meets `code: 'not_installed'` says the same thing and
 * exits non-zero. On Windows Server a Startup-folder launcher is never offered
 * as the answer: only `ezz service install` is (1.4.7 bought a launcher here).
 *
 * @param {Object} result The core result
 */
function printNotInstalled(result) {
  const message = String(result?.message ?? result?.reason ?? '').trim()
    || 'The Easy DevOps service is not installed.';
  console.log();
  console.log(String(message).split('\n').map((line) => `  ${line}`).join('\n'));
  if (!/ezz service install/.test(message)) {
    console.log();
    if (isWindows && (isServerMode() || result?.mode === service.MODES.SERVER)) {
      console.log('  ' + chalk.gray('Install it with ') + chalk.white('ezz service install')
        + chalk.gray(' from an Administrator PowerShell.'));
    } else {
      console.log('  ' + chalk.gray('Install it with: ') + chalk.white('ezz service install'));
    }
  }
  console.log();
}

async function doStop() {
  page(['Service', 'Stop']);
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
    if (result.code === 'not_installed') {
      printNotInstalled(result);
      return 1;
    }
    console.log();
    // An install from before 1.4.3 has no start/stop grant for this account.
    const handed = await offerRelaunchFor(result, ['service', 'stop']);
    if (handed !== null) return handed;
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
  page(['Service', 'Start']);
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
    if (result.code === 'not_installed') {
      printNotInstalled(result);
      return 1;
    }
    if (result.alreadyRunning) {
      console.log('  ' + chalk.yellow('Already running.'));
      console.log('  ' + chalk.gray(result.reason));
      console.log();
      return 0;
    }
    const handed = await offerRelaunchFor(result, ['service', 'start']);
    if (handed !== null) return handed;
    console.log('  ' + chalk.red('Could not start it.'));
    console.log(String(result.reason).split('\n').map((l) => `  ${l}`).join('\n'));
    if (result.needsElevation) {
      console.log();
      console.log('  ' + chalk.gray('No password is needed — only elevation.'));
    }
    console.log();
    console.log('  ' + chalk.gray('Troubleshooting: https://easy-devops.devxor.team/docs/troubleshooting'));
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
  page(['Service', 'Restart']);
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
    if (result.code === 'not_installed') {
      printNotInstalled(result);
      return 1;
    }
    const handed = await offerRelaunchFor(result, ['service', 'restart']);
    if (handed !== null) return handed;
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

/**
 * A permission step that failed has already put the previous ACL back (or says
 * it could not). Say which, and what to do next — never the 1.4.7 line "the
 * permissions were not changed back automatically", which was true then.
 */
function printPermissionFailure(recovered) {
  console.log();
  console.log('  ' + chalk.red('The service files could not be protected.'));
  console.log(String(recovered?.reason ?? 'the permission step returned no reason')
    .split('\n').map((line) => `  ${line}`).join('\n'));
  console.log();
  console.log('  ' + (recovered?.restored
    ? chalk.gray('The previous permissions were restored; nothing is locked.')
    : chalk.yellow('The previous permissions were NOT restored.')));
  if (recovered?.next && !String(recovered.reason ?? '').includes(recovered.next)) {
    console.log('  ' + chalk.gray('Next: ') + chalk.white(recovered.next));
  }
  console.log();
}

async function doRepair(recover = false, { yes = false } = {}) {
  const verb = recover ? 'Recover' : 'Repair';
  page(['Service', verb]);
  console.log();
  console.log('  ' + chalk.bold(`${verb} the Easy DevOps service`));
  console.log('  ' + chalk.gray('─'.repeat(58)));
  console.log('  ' + chalk.gray(recover
    ? 'Restores administrator and service access, then repairs and starts it.'
    : 'Re-pins the Node runtime, re-applies permissions, and restarts it.'));
  console.log();

  // The edition decides the elevation question, not the marker alone: a Server
  // with leftover data and no marker is still a Server, and its code folders
  // need an Administrator terminal.
  const winState = isWindows ? await service.serviceInstallState().catch(() => null) : null;
  const serverLike = winState
    ? winState.edition === 'server' || winState.mode === service.MODES.SERVER
    : isServerMode();

  if (isWindows && serverLike) {
    const gate = await requireElevation({
      args: ['service', recover ? 'recover' : 'repair'],
      what: `${verb}ing the Windows service`,
      yes,
    });
    if (!gate.proceed) return gate.code;
  }

  const spinner = ora(recover ? 'Recovering…' : 'Repairing…').start();
  const lines = [];
  const log = (line) => { lines.push(line); spinner.text = line; };

  // An update that died mid-transaction is finished first, on both platforms
  // and for both repair and recover, before anything else is touched.
  try {
    const { recoverInterruptedUpdate } = await import('../../core/service/updateTransaction.js');
    const interrupted = await recoverInterruptedUpdate({ log });
    if (!interrupted?.ok) {
      throw new Error(interrupted?.reason ?? 'the interrupted update could not be recovered');
    }
  } catch (err) {
    spinner.fail(`${verb} failed: ${err.message}`);
    return 1;
  }

  // Linux recovery is its own path: the unit is regenerated and the service
  // restarted, which is not something the shared repair flow can do.
  if (recover && !isWindows) {
    try {
      const systemd = await import('../../core/service/systemd.js');
      if (typeof systemd.recoverService !== 'function') {
        throw new Error('this build cannot recover the Linux service. Reinstall the package, then run `ezz service recover` again.');
      }
      const recovered = await systemd.recoverService({ log });
      if (!recovered?.ok) throw new Error(recovered?.reason ?? 'the Linux service recovery returned no result');
    } catch (err) {
      spinner.fail(`${verb} failed: ${err.message}`);
      return 1;
    }
    spinner.stop();
    for (const line of lines) console.log('  ' + chalk.gray(line));
    console.log();
    console.log('  ' + chalk.green('✓ Recovered.'));
    console.log();
    return showStatus();
  }

  let result = null;
  let permissionFailure = null;

  // Windows recover is a superset of repair: the interrupted update above,
  // then the code folders' permissions, then the ordinary repair. On an
  // uninstalled Server the permission pass still protects any bin/runtime that
  // exists (it is additive and safe); repair then reports "not installed".
  //
  // A Personal-mode client has no ProgramData code to protect, so recover is
  // just repair there — it never touches the machine-wide folders.
  if (recover && isWindows && serverLike) {
    let windowsServiceModule = null;
    try {
      windowsServiceModule = await import('../../core/service/windowsService.js');
    } catch (err) {
      spinner.fail(`${verb} failed: ${err.message}`);
      return 1;
    }

    const exists = (dir) => {
      try {
        return fs.existsSync(dir);
      } catch {
        return false;
      }
    };
    const codeRoots = [
      windowsServiceModule.binDir(),
      path.dirname(service.runtimeNodePath(getDataDir())),
      path.join(programDataDir(), 'runtime.prev'),
    ].filter(exists);

    if (codeRoots.length > 0) {
      try {
        const recovered = await windowsServiceModule.recoverCodePermissions({ log });
        if (!recovered?.ok) permissionFailure = recovered;
      } catch (err) {
        spinner.fail(`${verb} failed: ${err.message}`);
        return 1;
      }
    }

    // A REGISTERED service whose files could not be protected is a real stop:
    // the next step (repair) cannot fix an ACL failure, and the previous ACL
    // has already been restored by the routine.
    const registered = winState ? winState.registered : null;
    if (permissionFailure && registered !== false) {
      spinner.stop();
      for (const line of lines) console.log('  ' + chalk.gray(line));
      printPermissionFailure(permissionFailure);
      return 1;
    }
  }

  try {
    result = await service.repair({ log });
  } catch (err) {
    spinner.fail(`${verb} failed: ${err.message}`);
    if (permissionFailure) printPermissionFailure(permissionFailure);
    return 1;
  }

  spinner.stop();
  for (const line of lines) console.log('  ' + chalk.gray(line));

  // On an uninstalled server the code folders may still have been protected;
  // report that honestly, then the one answer that matters.
  if (permissionFailure) printPermissionFailure(permissionFailure);

  if (!result.ok && result.code === 'not_installed') {
    printNotInstalled(result);
    return 1;
  }

  if (!result.ok) {
    console.log();
    console.log('  ' + chalk.red(`${verb} failed.`));
    console.log(String(result.reason).split('\n').map((l) => `  ${l}`).join('\n'));
    if (result.needsElevation) {
      console.log();
      console.log('  ' + chalk.gray('No password is needed — only elevation.'));
    }
    console.log();
    console.log('  ' + chalk.gray('Troubleshooting: https://easy-devops.devxor.team/docs/troubleshooting'));
    console.log();
    return 1;
  }

  console.log();
  console.log('  ' + chalk.green(recover ? '✓ Recovered.' : '✓ Repaired.'));
  for (const failure of result.aclFailures ?? []) {
    console.log('  ' + chalk.yellow(`⚠ ${failure.path}: ${failure.reason}`));
  }
  console.log();
  return showStatus();
}
