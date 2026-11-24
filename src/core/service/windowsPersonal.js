import { pathToFileURL } from 'node:url';
/**
 * core/service/windowsPersonal.js
 *
 * Windows "Personal" mode: the daemon starts when the user logs in, with no
 * elevation and no password.
 *
 * This is the right mode for a workstation. It is honest about its limits:
 * nothing runs before someone signs in, and the data stays in `%APPDATA%`.
 * A machine that should be monitored while nobody is logged in needs Server
 * mode and its elevation.
 *
 * ── Two files, because of the window ──────────────────────────────────────
 *
 * The first version of this was a single `.cmd` in the Startup folder holding
 * the whole supervisor loop. That meant a **console window open for the entire
 * session**, and closing it — which looks like exactly the right thing to do
 * with a stray black window — killed the daemon with no restart. Unusable.
 *
 * So the Startup entry is now a tiny **bootstrap** that launches the real
 * supervisor hidden and exits immediately. Two files:
 *
 *   `<Startup>\easy-devops-daemon.cmd`  — the bootstrap. Flashes briefly.
 *   `<dataDir>\daemon-supervisor.cmd`   — the supervisor loop. Never visible.
 *
 * The hide is `Start-Process -WindowStyle Hidden` through PowerShell, which is
 * the documented way to launch a console program with no window. Deliberately
 * NOT a VBScript wrapper: that is the classic trick and endpoint protection now
 * flags or blocks it on many machines. Deliberately not `start /b` either —
 * that shares the bootstrap's console, so the child's fate is tied to a window
 * we are trying to get rid of.
 *
 * ── The supervisor ─────────────────────────────────────────────────────────
 *
 * Nothing restarts a crashed program in the Startup folder, so the supervisor
 * restarts the daemon with a growing delay. Without it, one crash means no
 * monitoring until the next logon — which could be weeks.
 *
 * Exit code 0 means "asked to stop" and is not restarted. That is how
 * `ezz service stop` works without any service manager: it writes a stop
 * request, the daemon sees it and exits 0, and the supervisor stands down. The
 * bootstrap clears the request at logon, so a stop lasts until the next sign-in
 * or an explicit `ezz service start`.
 */

import fs from 'fs';
import path from 'path';

import { getStartupFolder, isWindows, isDefaultDataDir } from '../platform.js';
import { dbGet, dbSet } from '../db.js';
import { run as shellRun } from '../shell.js';
import { stopRequestPath } from '../daemon/stopRequest.js';

/** The Startup entry. Distinct from the old PM2 one (`easy-devops-pm2.cmd`). */
export const LAUNCHER_FILE = 'easy-devops-daemon.cmd';

/** The supervisor, which lives in the data directory rather than in Startup. */
export const SUPERVISOR_FILE = 'daemon-supervisor.cmd';

/** Where the recorded install details live. */
const STATE_KEY = 'service-state';

/** Absolute path of the Startup bootstrap, or null when there is no folder. */
export function launcherPath(startupDir = getStartupFolder()) {
  return startupDir ? path.join(startupDir, LAUNCHER_FILE) : null;
}

/** Absolute path of the supervisor script. */
export function supervisorPath(dataDir) {
  return path.join(dataDir, SUPERVISOR_FILE);
}

/** Where the supervisor writes its log. */
export function logFilePath(dataDir) {
  return path.join(dataDir, 'daemon-supervisor.log');
}

/**
 * The PowerShell command that starts a `.cmd` with no window.
 *
 * Shared by the logon bootstrap and `ezz service start`, so both produce an
 * identically hidden process — a `start` that left a visible window would be a
 * confusing difference from a logon start.
 *
 * The supervisor path is passed through the ENVIRONMENT rather than inlined
 * into the command string. That avoids nested quoting entirely: a path with a
 * space (`C:\Users\A B\...`) has to survive cmd, then PowerShell, then
 * Start-Process, and every layer quotes differently. An environment variable
 * crosses all three untouched.
 *
 * @param {string} envVarName Name of the variable holding the script path
 * @returns {string}
 */
export function hiddenStartCommand(envVarName = 'EZ_SUPERVISOR') {
  return 'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden '
    + `-Command "Start-Process -FilePath $env:${envVarName} -WindowStyle Hidden"`;
}

/**
 * The Startup bootstrap.
 *
 * Does three things and exits: clears any pending stop request (so a stop
 * lasts until the next logon, not for ever), launches the supervisor hidden,
 * and gets out of the way. Its own window is visible for a fraction of a
 * second, which is the accepted trade-off.
 *
 * @param {Object} opts
 * @param {string} opts.supervisor Absolute path to the supervisor script
 * @param {string} opts.stopFile   Absolute path to the stop-request file
 * @returns {string}
 */
export function buildBootstrap({ supervisor, stopFile }) {
  return `@echo off
rem Easy DevOps -- logon bootstrap.
rem
rem Created by \`ezz service install\` (Personal mode). Safe to delete: doing so
rem simply stops the daemon from starting when you log in.
rem
rem This file does NOT contain the supervisor. It starts it with no window and
rem exits, so there is no console window left open for the session. The
rem supervisor itself is at:
rem   ${supervisor}

rem A stop requested with \`ezz service stop\` lasts until the next logon. This
rem is the line that makes it temporary rather than permanent.
if exist "${stopFile}" del /q "${stopFile}" >nul 2>&1

set "EZ_SUPERVISOR=${supervisor}"
${hiddenStartCommand()}

exit /b 0
`;
}

/**
 * The supervisor script: runs the daemon, restarts it on crash, stands down
 * when it is asked to stop.
 *
 * Written in plain `cmd` rather than PowerShell because a `.ps1` does not run
 * on a default execution policy, and changing the policy for the user would be
 * a far bigger imposition than a batch file.
 *
 * @param {Object} opts
 * @param {string} opts.nodeExe  Absolute path, captured at install
 * @param {string} opts.entry    Absolute path to the ez entry script
 * @param {string} opts.dataDir
 * @param {string} opts.logFile
 * @param {string} opts.stopFile
 * @returns {string}
 */
export function buildSupervisor({ nodeExe, entry, dataDir, logFile, stopFile }) {
  // Only set when it is NOT the default directory. Passing it needlessly is
  // what put the daemon into dev mode -- issuing staging certificates on real
  // domains -- back when dev mode was inferred from the variable's presence.
  // Both halves of that bug are fixed; this is the belt as well as the braces.
  const dataDirLine = isDefaultDataDir(dataDir)
    ? 'rem EASY_DEVOPS_DATA_DIR is not set: this is the default directory.'
    : `set "EASY_DEVOPS_DATA_DIR=${dataDir}"`;

  // Batch has no arrays and awkward arithmetic, so the backoff is a short
  // explicit ladder rather than a computed sequence. Clearer to read in a file
  // the user may well open.
  return `@echo off
setlocal EnableDelayedExpansion

rem Easy DevOps -- supervisor for the background daemon (Personal mode).
rem
rem Started hidden by the logon bootstrap in your Startup folder, or by
rem \`ezz service start\`. Do not put this file in the Startup folder: it would
rem then run with a visible console window for the whole session.

${dataDirLine}
set "NODE_OPTIONS="
set "NODE_PATH="
set "WS_NO_BUFFER_UTIL=1"
set "WS_NO_UTF_8_VALIDATE=1"
set "NODE_ENV=production"
set "LOGFILE=${logFile}"
set "NODEEXE=${nodeExe}"
set "ENTRY=${entry}"
set "STOPFILE=${stopFile}"

set "DELAY=5"
set "FAILS=0"

:loop
rem Trim the log if it has grown past ~5 MB, so an unattended machine cannot
rem fill its disk with restart notices. The \`if exist\` guard is required:
rem %%~zA on a file that does not exist expands to nothing, which turns the
rem comparison below into a batch syntax error on the very first run.
if exist "!LOGFILE!" (
  for %%A in ("!LOGFILE!") do (
    if %%~zA GTR 5242880 (
      del /q "!LOGFILE!" 2>nul
      echo [%DATE% %TIME%] log trimmed>>"!LOGFILE!"
    )
  )
)

rem Checked BEFORE starting, not only after the daemon exits: a stop requested
rem while this script is in its backoff sleep would otherwise be ignored and a
rem fresh daemon started on top of it.
if exist "!STOPFILE!" (
  echo [%DATE% %TIME%] stop requested, not starting>>"!LOGFILE!"
  goto end
)

echo [%DATE% %TIME%] starting daemon>>"!LOGFILE!"

"!NODEEXE!" "--experimental-loader=${pathToFileURL(path.resolve(path.dirname(entry), '../core/service/runtime-loader.mjs')).href.replaceAll('%', '%%')}" "!ENTRY!" daemon>>"!LOGFILE!" 2>&1

set "CODE=!ERRORLEVEL!"
echo [%DATE% %TIME%] daemon exited with code !CODE!>>"!LOGFILE!"

rem Exit code 0 means it was asked to stop -- by \`ezz service stop\`, or by a
rem signal. Do not restart it: that is the difference between "stopped" and
rem "crashed", and restarting here would make \`ezz service stop\` impossible.
if "!CODE!"=="0" (
  echo [%DATE% %TIME%] clean exit, not restarting>>"!LOGFILE!"
  goto end
)

set /a FAILS+=1

rem Backoff ladder: 5, 15, 30, then 60 seconds for every attempt after.
if !FAILS! EQU 1 set "DELAY=5"
if !FAILS! EQU 2 set "DELAY=15"
if !FAILS! EQU 3 set "DELAY=30"
if !FAILS! GEQ 4 set "DELAY=60"

echo [%DATE% %TIME%] restarting in !DELAY!s (failure !FAILS!)>>"!LOGFILE!"

rem The delay is called by ABSOLUTE path. Plain \`timeout\` resolves through
rem PATH, and a machine with Git for Windows or any GNU coreutils on PATH gets
rem the Unix \`timeout\`, which rejects these arguments outright -- measured, not
rem assumed. The delay would then be skipped and this backoff would become the
rem tight restart loop it exists to prevent.
rem
rem \`ping\` is the fallback: Windows' timeout.exe also refuses to run when stdin
rem is redirected, which happens in some logon contexts. ping -n N waits N-1
rem seconds and needs no console.
set /a PINGS=!DELAY!+1
"%SystemRoot%\\System32\\timeout.exe" /t !DELAY! /nobreak >nul 2>&1
if errorlevel 1 ping -n !PINGS! 127.0.0.1 >nul 2>&1

goto loop

:end
endlocal
`;
}

/**
 * Installs the bootstrap and the supervisor, and records what they were pinned
 * to.
 *
 * The absolute `node.exe` path is captured here and checked by `status`. There
 * is no copy and no symlink: Personal mode has no elevation and nowhere
 * admin-only to put one, and a Windows symlink needs either elevation or
 * Developer Mode. So the honest design is to record the path and detect it
 * breaking, which is what `status` does when nvm-windows removes a version.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {string} opts.entry
 * @param {string} [opts.nodeExe]
 * @param {string} [opts.startupDir] Injected by tests
 * @param {(line: string) => void} [opts.log]
 * @param {boolean} [opts.record] Write the recorded state (default true)
 * @returns {{ ok: boolean, reason?: string, launcher?: string, supervisor?: string, nodeExe?: string }}
 */
export function install({
  dataDir,
  entry,
  nodeExe = process.execPath,
  startupDir = getStartupFolder(),
  log = () => {},
  record = true,
} = {}) {
  if (!isWindows) return { ok: false, reason: 'Personal mode is Windows-only' };

  if (!startupDir) {
    return {
      ok: false,
      reason: 'could not find your Startup folder, so there is nowhere to put the launcher. '
        + 'Check that %APPDATA% is set.',
    };
  }

  const launcher = path.join(startupDir, LAUNCHER_FILE);
  const supervisor = supervisorPath(dataDir);
  const logFile = logFilePath(dataDir);
  const stopFile = stopRequestPath(dataDir);

  // Resolved to a real path so a shim is not what gets recorded. nvm-windows
  // in particular puts a symlink at a fixed location and repoints it on
  // `nvm use`; recording that link would mean the daemon silently changes Node
  // version the next time the user switches.
  let resolvedNode;
  try {
    resolvedNode = fs.realpathSync(nodeExe);
  } catch {
    resolvedNode = path.resolve(nodeExe);
  }

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      supervisor,
      buildSupervisor({ nodeExe: resolvedNode, entry, dataDir, logFile, stopFile }),
      'utf8',
    );
    log(`Wrote ${supervisor}`);
  } catch (err) {
    return { ok: false, reason: `could not write the supervisor: ${err.message}` };
  }

  try {
    fs.mkdirSync(startupDir, { recursive: true });
    fs.writeFileSync(launcher, buildBootstrap({ supervisor, stopFile }), 'utf8');
    log(`Wrote ${launcher}`);
  } catch (err) {
    return { ok: false, reason: `could not write the launcher: ${err.message}` };
  }

  if (record) {
    const existing = dbGet(STATE_KEY) ?? {};
    dbSet(STATE_KEY, {
      ...existing,
      mode: 'personal',
      installedAt: new Date().toISOString(),
      stoppedAt: null,
      nodeExe: resolvedNode,
      entry,
      launcher,
      supervisor,
      dataDir,
    });
  }

  return { ok: true, launcher, supervisor, nodeExe: resolvedNode, logFile };
}

/**
 * Starts the supervisor now, hidden, without waiting for a logon.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {Function} [opts.run]
 * @returns {Promise<{ ok: boolean, reason?: string, supervisor?: string }>}
 */
export async function startNow({ dataDir, run = shellRun, log = () => {} } = {}) {
  const supervisor = supervisorPath(dataDir);

  if (!fs.existsSync(supervisor)) {
    return {
      ok: false,
      reason: `the supervisor script is missing (${supervisor}). Run \`ezz service install\` first.`,
    };
  }

  // The path travels in the environment for the quoting reason explained on
  // hiddenStartCommand(). `run()` goes through PowerShell, so the command is
  // the same one the bootstrap uses.
  const command = 'Start-Process -FilePath $env:EZ_SUPERVISOR -WindowStyle Hidden';
  const result = await run(command, { timeout: 30_000, env: { EZ_SUPERVISOR: supervisor } });
  if (!result.success) {
    return {
      ok: false,
      reason: `could not start the supervisor: ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 300)}`,
    };
  }

  log(`Started ${supervisor} (hidden)`);
  return { ok: true, supervisor };
}

/** Removes the bootstrap and the supervisor. */
export function uninstall({ dataDir = null, startupDir = getStartupFolder(), log = () => {}, record = true } = {}) {
  if (!isWindows) return { ok: false, reason: 'Personal mode is Windows-only' };

  const launcher = launcherPath(startupDir);
  const notes = [];

  if (launcher && fs.existsSync(launcher)) {
    try {
      fs.rmSync(launcher, { force: true });
      log(`Removed ${launcher}`);
    } catch (err) {
      return { ok: false, reason: `could not remove ${launcher}: ${err.message}` };
    }
  } else {
    notes.push('the launcher was not present');
  }

  // The supervisor lives in the data directory, so it is removed too — leaving
  // it behind would mean `ezz service start` could still run a daemon after an
  // uninstall, which is not what uninstall means.
  const recorded = dbGet(STATE_KEY) ?? {};
  const supervisor = dataDir ? supervisorPath(dataDir) : recorded.supervisor;

  if (supervisor && fs.existsSync(supervisor)) {
    try {
      fs.rmSync(supervisor, { force: true });
      log(`Removed ${supervisor}`);
    } catch (err) {
      notes.push(`could not remove ${supervisor}: ${err.message}`);
    }
  }

  if (record && recorded.mode === 'personal') {
    dbSet(STATE_KEY, { ...recorded, mode: null, stoppedAt: null, uninstalledAt: new Date().toISOString() });
  }

  return { ok: true, notes };
}

/**
 * The state of a Personal-mode install.
 *
 * `running` is not asked of Windows here — there is no service to query. The
 * authority on whether the daemon is up is its own lock file, which the
 * dispatcher reads; this function reports only what Personal mode itself owns.
 *
 * @param {Object} [opts]
 * @returns {Object}
 */
export function status({ dataDir = null, startupDir = getStartupFolder() } = {}) {
  const launcher = launcherPath(startupDir);
  const installed = Boolean(launcher && fs.existsSync(launcher));
  const recorded = dbGet(STATE_KEY) ?? {};
  const supervisor = dataDir ? supervisorPath(dataDir) : recorded.supervisor ?? null;

  const out = {
    installed,
    launcher,
    supervisor,
    enabledOnBoot: installed,
    startsAt: 'logon',
    recordedNodeExe: recorded.nodeExe ?? null,
    nodeExeExists: null,
    warnings: [],
  };

  if (!installed) {
    out.state = 'not installed';
    return out;
  }

  out.state = 'installed (starts at logon)';

  if (supervisor && !fs.existsSync(supervisor)) {
    out.warnings.push(
      `The launcher is installed but its supervisor is missing:\n  ${supervisor}\n`
      + 'Run `ezz service install` again to recreate it.',
    );
  }

  if (recorded.nodeExe) {
    out.nodeExeExists = fs.existsSync(recorded.nodeExe);
    if (!out.nodeExeExists) {
      out.warnings.push(
        `The Node the launcher was pinned to no longer exists:\n  ${recorded.nodeExe}\n`
        + 'If you use nvm-windows, that version was probably uninstalled or switched. '
        + 'Fix it with: ezz service repair',
      );
    }
  } else {
    out.warnings.push(
      'No Node path was recorded for this install, so it cannot be checked. '
      + 'Run `ezz service repair` to record one.',
    );
  }

  // A launcher left over from the single-file design would run the supervisor
  // in a visible window for the whole session. Detected by its size: the
  // bootstrap is small, while the old all-in-one script was not.
  try {
    const script = fs.readFileSync(launcher, 'utf8');
    if (!script.includes('EZ_SUPERVISOR')) {
      out.warnings.push(
        'Your Startup launcher is from an older version that ran in a visible '
        + 'console window for the whole session. Run `ezz service install` again '
        + 'to replace it with the hidden one.',
      );
    }
    if (recorded.entry && script.includes(recorded.entry) === false && script.includes('EZ_SUPERVISOR') === false) {
      out.warnings.push(
        'The launcher points at a different entry point than the one recorded at install. '
        + 'Run `ezz service repair` to rewrite it.',
      );
    }
  } catch { /* unreadable launcher: the existence check above already covers it */ }

  return out;
}

/** Recent supervisor log lines. */
export function readLogs({ dataDir, lines = 50 } = {}) {
  const file = logFilePath(dataDir);

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {
      ok: false,
      file,
      output: err.code === 'ENOENT'
        ? `No supervisor log yet at ${file}. It is written the first time the daemon starts.`
        : `Could not read ${file}: ${err.message}`,
    };
  }

  const all = text.split(/\r?\n/).filter(Boolean);
  return { ok: true, file, output: all.slice(-Math.max(1, Math.min(5000, Number(lines) || 50))).join('\n') };
}

/** Rewrites both scripts against the Node running now. */
export function repair({ dataDir, entry, nodeExe = process.execPath, startupDir = getStartupFolder(), log = () => {} } = {}) {
  const recorded = dbGet(STATE_KEY) ?? {};
  const resolvedEntry = entry ?? recorded.entry;

  if (!resolvedEntry) {
    return { ok: false, reason: 'no entry point is recorded and none was given; run `ezz service install` instead' };
  }

  const result = install({ dataDir, entry: resolvedEntry, nodeExe, startupDir, log });
  if (!result.ok) return result;

  log(`Re-pinned to ${result.nodeExe}`);
  return { ok: true, launcher: result.launcher, supervisor: result.supervisor, nodeExe: result.nodeExe };
}
