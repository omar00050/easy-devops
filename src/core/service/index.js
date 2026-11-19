/**
 * core/service/index.js
 *
 * One interface over three genuinely different native service mechanisms:
 *
 *   | platform / mode    | mechanism                     | elevation | starts   |
 *   |--------------------|-------------------------------|-----------|----------|
 *   | Linux              | systemd unit                  | sudo once | at boot  |
 *   | Windows "Server"   | Windows Service via WinSW     | UAC once  | at boot  |
 *   | Windows "Personal" | Startup-folder supervisor     | none      | at logon |
 *
 * **No password is ever requested, stored or passed through this code.** On
 * Linux sudo does its own asking, on the user's terminal. On Windows the
 * service runs as the virtual account `NT SERVICE\EasyDevOps`, which has no
 * password at all. The previous design needed the user's password for a
 * scheduled task; that mode is gone, and core/service/legacy.js exists to find
 * and remove what it left behind.
 *
 * PM2 is no longer involved in running Easy DevOps itself. `core/runner.js`
 * and the Processes page remain, for the user's OWN applications — that is a
 * supported feature and is untouched.
 *
 * ── What this module does and does not decide ──────────────────────────────
 *
 * It decides which mechanism applies and sequences the steps. It does not
 * prompt: every question — Server or Personal, remove the legacy setup, move
 * the data back on uninstall — is asked by the CLI, which has a terminal, and
 * passed in as a plain option. That keeps this module callable from a test
 * with no TTY, and keeps the dashboard unable to trigger anything interactive.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  isWindows,
  getDataDir,
  isServerMode,
  programDataDir,
  windowsEditionQueryCmd,
  windowsProductNameCmd,
} from '../platform.js';
import { run as shellRun } from '../shell.js';
import { loadConfig } from '../config.js';
import { dbGet, dbSet, closeDb, reopenDb } from '../db.js';
import { isPidAlive } from '../dashboardProcess.js';
import { inspect as inspectLock, HEARTBEAT_INTERVAL_MS } from '../daemon/lock.js';
import { requestStop, clearStopRequest, isStopRequested } from '../daemon/stopRequest.js';
import { inspect as inspectOwner } from '../jobs/owner.js';
import { probe, invalidate } from '../probeCache.js';

import * as systemd from './systemd.js';
import * as windowsService from './windowsService.js';
import * as windowsPersonal from './windowsPersonal.js';
import * as legacy from './legacy.js';
import { enableServerMode, disableServerMode, describeOriginal } from './dataDir.js';
import { linkRuntime, inspectRuntime, runtimeNodePath } from './runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where install details are recorded. Shared with the old module's key. */
const STATE_KEY = 'service-state';

/** The two Windows modes. */
export const MODES = Object.freeze({ SERVER: 'server', PERSONAL: 'personal' });

/**
 * How long to wait for the daemon's heartbeat after starting a service.
 *
 * 45 s, not the 10 s it was: the first start of a freshly copied node.exe on
 * Windows Server is routinely slow (Defender scans the new binary before it
 * may run), and 1.4.0 reported "Install failed" for a daemon that came up a
 * few seconds after it stopped waiting.
 */
export const STARTUP_GRACE_MS = 45_000;

/** How often a long wait says it is still waiting. */
const WAIT_PROGRESS_MS = 5_000;

/** How long to wait for a stopping daemon to actually release its lock. */
export const STOP_GRACE_MS = 15_000;

/**
 * The `ezz` entry script, resolved from this file rather than from `cwd`.
 *
 * A service unit records this path, so it has to be the installed package's
 * real location — `process.argv[1]` would be whatever shim the user invoked,
 * which on Windows is a `.cmd` wrapper that a service cannot run directly.
 */
export function entryScript() {
  return path.resolve(__dirname, '..', '..', 'cli', 'index.js');
}

/** The package root, used as a working directory and as the copy source. */
export function appRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * Which mechanism applies here.
 *
 * @param {Object} [opts]
 * @param {string} [opts.mode] Windows only; defaults to the recorded or detected mode
 * @returns {{ platform: 'linux'|'windows', mode: string|null, mechanism: string }}
 */
export function resolveMechanism({ mode = null } = {}) {
  if (!isWindows) {
    return { platform: 'linux', mode: null, mechanism: 'systemd' };
  }

  const recorded = dbGet(STATE_KEY)?.mode ?? null;
  // Server mode is also inferable from the marker, which survives a database
  // that was moved or rebuilt — so it wins over a stale record.
  const effective = mode ?? (isServerMode() ? MODES.SERVER : recorded);

  return {
    platform: 'windows',
    mode: effective,
    mechanism: effective === MODES.SERVER ? 'winsw' : 'startup-supervisor',
  };
}

/**
 * The default Windows mode for this machine.
 *
 * Server on a Windows Server edition, because that machine exists to serve and
 * nobody is logged in; ask otherwise. The caller does the asking — this only
 * supplies the default.
 *
 * @returns {Promise<{ mode: string, isServerEdition: boolean, detail: string }>}
 */
export async function suggestWindowsMode({ run = shellRun } = {}) {
  if (!isWindows) return { mode: null, isServerEdition: false, detail: 'not Windows' };

  let isServerEdition = false;
  let detail = 'could not determine the Windows edition';

  try {
    const type = await run(windowsEditionQueryCmd(), { timeout: 15_000 });
    const value = (type.stdout ?? '').trim();

    if (type.success && value) {
      // `Server` and `Server Core` both mean a machine that exists to serve.
      isServerEdition = /^server/i.test(value);

      const named = await run(windowsProductNameCmd(), { timeout: 15_000 });
      const product = (named.stdout ?? '').trim();
      detail = product || value;
    }
  } catch {
    // Unreadable registry: fall through to Personal, which needs no elevation
    // and therefore cannot be the wrong answer in a damaging way. Choosing
    // Server by default on an unknown machine would ask for UAC it may not get.
  }

  return {
    mode: isServerEdition ? MODES.SERVER : MODES.PERSONAL,
    isServerEdition,
    detail,
  };
}

/**
 * Waits for the daemon to prove it is alive, by its heartbeat.
 *
 * "The service manager says it started" is not the same as "the daemon is
 * running": WinSW and systemd both report success as soon as the process is
 * spawned, and a daemon that throws on startup is reported as started and then
 * restarted for ever. The lock's heartbeat is the only evidence that the
 * daemon actually reached a working state.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ alive: boolean, waitedMs: number, lock: Object|null }>}
 */
export async function waitForDaemon({ dataDir, timeoutMs = STARTUP_GRACE_MS, onProgress = null } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let nextProgress = started + WAIT_PROGRESS_MS;

  while (Date.now() < deadline) {
    const state = inspectLock({ dataDir });
    if (state.running) {
      return { alive: true, waitedMs: Date.now() - started, lock: state.lock };
    }
    if (onProgress && Date.now() >= nextProgress) {
      nextProgress += WAIT_PROGRESS_MS;
      try { onProgress(Date.now() - started, timeoutMs); } catch { /* a progress line must not break the wait */ }
    }
    await new Promise((r) => setTimeout(r, Math.min(500, HEARTBEAT_INTERVAL_MS)));
  }

  return { alive: false, waitedMs: Date.now() - started, lock: inspectLock({ dataDir }).lock };
}

/**
 * Waits for a running daemon to go away.
 *
 * The mirror of waitForDaemon(): a `stop` that reported success while the
 * daemon was still up would be worse than one that took a moment longer.
 *
 * @param {Object} opts
 * @returns {Promise<{ gone: boolean, waitedMs: number }>}
 */
export async function waitForDaemonGone({ dataDir, timeoutMs = STOP_GRACE_MS } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;

  while (Date.now() < deadline) {
    if (!inspectLock({ dataDir }).running) {
      return { gone: true, waitedMs: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return { gone: false, waitedMs: Date.now() - started };
}

/**
 * The background-service state, cheaply and synchronously.
 *
 * This is the object the UI treats as the single authority, and it is
 * deliberately separate from `status()`: that one queries the service manager
 * (`sc query`, `systemctl show`), probes Node runtimes and reads PM2, which is
 * far too expensive to run on every lock change. Everything here is a lock
 * read, a `existsSync` and a database read.
 *
 * `installed` cannot be derived from `running` — a daemon started by hand runs
 * without being installed, and a stopped service is installed without running.
 * Both are reported.
 *
 * @param {Object} [opts]
 * @returns {Object}
 */
export function backgroundServiceState({ dataDir = getDataDir() } = {}) {
  const mech = resolveMechanism();
  const lock = inspectLock({ dataDir });
  const owner = inspectOwner({ dataDir });
  const recorded = dbGet(STATE_KEY) ?? {};

  const stoppedRequested = isStopRequested({ dataDir });
  const stoppedByUser = (Boolean(recorded.stoppedAt) || stoppedRequested) && !lock.running;

  return {
    running: lock.running,
    pid: lock.lock?.pid ?? null,
    version: lock.lock?.version ?? null,
    startedAt: lock.lock?.startedAt ?? null,
    heartbeatAgeMs: lock.age,

    // Which process is doing the work. Exactly one holds the marker.
    jobsRunningHere: owner.held && owner.mine,
    jobsOwnerPid: owner.owner?.pid ?? null,
    jobsOwnerRole: owner.owner?.role ?? null,

    mechanism: mech.mechanism,
    mode: mech.mode,
    installed: isInstalled({ mech, dataDir }),
    startsAt: startsAtFor(mech),

    stoppedByUser,
    stoppedAt: recorded.stoppedAt ?? null,

    dataDir,
    serverMode: isServerMode(),
    detail: lock.reason,
  };
}

/**
 * Whether a native service is installed, by the only cheap evidence there is:
 * the artifact each mechanism leaves behind.
 */
function isInstalled({ mech = resolveMechanism(), dataDir = getDataDir() } = {}) {
  try {
    if (!isWindows) return fs.existsSync(systemd.UNIT_PATH);
    if (mech.mode === MODES.SERVER) {
      return fs.existsSync(windowsService.winswPath()) && fs.existsSync(windowsService.serviceXmlPath());
    }
    const launcher = windowsPersonal.launcherPath();
    return Boolean(launcher && fs.existsSync(launcher));
  } catch {
    return false;
  }
}

/** When the service starts itself: at logon (Personal) or at boot. */
function startsAtFor(mech = resolveMechanism()) {
  if (!isWindows) return 'boot';
  return mech.mode === MODES.SERVER ? 'boot' : 'logon';
}

/** Records that the user stopped it, so `status` can say so. */
function recordStopped() {
  const existing = dbGet(STATE_KEY) ?? {};
  dbSet(STATE_KEY, { ...existing, stoppedAt: new Date().toISOString() });
}

/** Clears that record. */
function recordStarted() {
  const existing = dbGet(STATE_KEY) ?? {};
  if (existing.stoppedAt) dbSet(STATE_KEY, { ...existing, stoppedAt: null });
}

/**
 * Installs the native service.
 *
 * @param {Object} opts
 * @param {string} [opts.mode]           Windows: 'server' | 'personal'
 * @param {boolean} [opts.removeLegacy]  Remove the old PM2 setup (the CLI asks)
 * @param {(line: string) => void} [opts.log]
 * @param {Object} [opts.deps]           Injected for tests
 * @returns {Promise<Object>}
 */
export async function install({ mode = null, removeLegacy = false, log = () => {}, deps = {} } = {}) {
  // What the probes measure is about to change.
  invalidateProbes();
  // A stop request left over from a previous install would make the daemon
  // exit the moment it started. Install is an explicit "I want this running".
  (deps.clearStopRequest ?? clearStopRequest)({ dataDir: getDataDir() });
  recordStarted();

  const found = await legacy.detectLegacy(deps.legacy ?? {});
  const legacyResult = { found: found.items, removed: [], failed: [] };

  if (found.found && removeLegacy) {
    log('Removing the old PM2-based service…');
    const cleaned = await legacy.removeLegacy({ items: found.items, log, ...(deps.legacy ?? {}) });
    legacyResult.removed = cleaned.removed;
    legacyResult.failed = cleaned.failed;
  }

  const entry = entryScript();
  const root = appRoot();

  if (!isWindows) {
    return installLinux({ entry, log, legacyResult, deps });
  }

  const resolved = mode ?? (await suggestWindowsMode()).mode;

  return resolved === MODES.SERVER
    ? installWindowsServer({ entry, root, log, legacyResult, deps })
    : installWindowsPersonal({ entry, log, legacyResult, deps });
}

/** Linux: pin the runtime, write the unit, start it, verify the heartbeat. */
async function installLinux({ entry, log, legacyResult, deps = {} }) {
  const dataDir = getDataDir();
  const sd = deps.systemd ?? systemd;

  if (!(await sd.hasSystemd(deps.systemdOpts ?? {}))) {
    return {
      ok: false,
      mechanism: 'none',
      manual: sd.manualInstructions({ nodeExe: process.execPath, entry, dataDir }),
      reason: 'this machine does not use systemd',
      legacy: legacyResult,
    };
  }

  log('Pinning the Node runtime…');
  const linked = linkRuntime({ dataDir });
  if (!linked.ok) return { ok: false, mechanism: 'systemd', reason: linked.reason, legacy: legacyResult };
  log(`  ${linked.link} → ${linked.target}`);

  const installed = await sd.install({
    nodeExe: linked.link,
    entry,
    dataDir,
    log,
    ...(deps.systemdOpts ?? {}),
  });
  if (!installed.ok) {
    return { ok: false, mechanism: 'systemd', reason: installed.reason, legacy: legacyResult };
  }

  const alive = await waitForDaemon({ dataDir, timeoutMs: deps.startupGraceMs ?? STARTUP_GRACE_MS });
  if (!alive.alive) {
    const recent = await sd.journal({ lines: 25, ...(deps.systemdOpts ?? {}) });
    return {
      ok: false,
      mechanism: 'systemd',
      reason: `the unit was installed and started, but the daemon did not report in within `
        + `${Math.round(alive.waitedMs / 1000)}s — so it is starting and failing.\n\n`
        + `Last log lines:\n${recent.output}`,
      installedButNotRunning: true,
      legacy: legacyResult,
    };
  }

  record({ mode: null, mechanism: 'systemd', nodeExe: linked.target, runtimeLink: linked.link, entry, dataDir });

  return {
    ok: true,
    mechanism: 'systemd',
    dataDir,
    unitPath: installed.unitPath,
    runtime: { link: linked.link, target: linked.target },
    daemon: { pid: alive.lock?.pid ?? null, waitedMs: alive.waitedMs },
    legacy: legacyResult,
  };
}

/** Windows Server: move the data, copy the runtime, register the service. */
async function installWindowsServer({ entry, root, log, legacyResult, deps = {} }) {
  const ws = deps.windowsService ?? windowsService;

  // The data directory moves FIRST: everything after this — the ACL grants,
  // the service XML's EASY_DEVOPS_DATA_DIR — has to refer to the final
  // location, and a half-installed service pointing at the old one would see
  // an empty database.
  //
  // A machine already in Server mode — including one left there by a 1.4.0
  // install that failed at "Registering the service" — skips the migration
  // and resumes from here: enableServerMode() sees the marker and returns
  // without copying, so a ProgramData database that is already the live data
  // is reused rather than refused.
  const migrating = !(deps.isServerMode ?? isServerMode)();

  // Elevation is checked for real BEFORE anything is copied or migrated. A
  // normal terminal used to get through the write probe, move the data, and
  // then meet a UAC prompt for the unsigned wrapper half way through.
  const elevationProbe = deps.isElevated ?? ws.isElevated;
  const elevated = elevationProbe ? await elevationProbe({}) : null;
  if (elevated === false) {
    return {
      ok: false,
      mechanism: 'winsw',
      mode: MODES.SERVER,
      needsElevation: true,
      reason: (ws.elevationMessage ?? windowsService.elevationMessage)(),
      legacy: legacyResult,
    };
  }

  if (migrating) {
    // A dashboard started from the menu holds the per-user database open. It
    // would make the backup rename fail, and it would keep writing to a copy
    // nothing reads once the move is done.
    const dashboardPid = dbGet('dashboard-pid');
    if (dashboardPid && (deps.isPidAlive ?? isPidAlive)(dashboardPid)) {
      return {
        ok: false,
        mechanism: 'winsw',
        mode: MODES.SERVER,
        reason: `the dashboard is running (pid ${dashboardPid}) and has the database open, so the data `
          + 'cannot be moved safely. Stop it first (Easy DevOps > Dashboard > Stop), then run '
          + 'ezz service install again. Nothing was changed.',
        legacy: legacyResult,
      };
    }
  }

  log('Switching to the machine-wide data directory…');

  // This process's own connection is closed for the move, so Windows can
  // rename the original to its backup name, then reopened on whichever
  // directory getDataDir() now answers — the new one on success, the old one
  // if the switch was refused. Everything after this (loadConfig, record)
  // must read and write the live database, not the abandoned copy.
  (deps.closeDb ?? closeDb)();
  let switched;
  try {
    switched = (deps.enableServerMode ?? enableServerMode)({ log });
  } finally {
    (deps.reopenDb ?? reopenDb)();
  }
  if (!switched.ok) {
    return { ok: false, mechanism: 'winsw', mode: MODES.SERVER, reason: switched.reason, legacy: legacyResult };
  }

  const dataDir = switched.dataDir;
  if (switched.migrated) log(`  migrated; ${describeOriginal(switched)}`);

  const config = loadConfig();

  const installed = await ws.install({
    dataDir,
    appRoot: root,
    config,
    log,
    ...(deps.windowsServiceOpts ?? {}),
  });

  // Recorded as soon as the service is registered and the grants are in —
  // not only after the heartbeat. Otherwise a slow first start left a
  // registered, granted service with no record, and `status` compared its
  // ACLs against an empty list.
  if (installed.ok || installed.registered) {
    record({
      mode: MODES.SERVER,
      mechanism: 'winsw',
      nodeExe: installed.runtime?.nodeExe ?? null,
      entry: installed.runtime?.entry ?? entry,
      dataDir,
      granted: installed.granted ?? [],
    });
  }

  if (!installed.ok) {
    // Server mode is deliberately KEPT after a failed install. The data was
    // copied and verified and the original is still on disk, so nothing is at
    // risk; moving it back and forth would be. Any half-registered service has
    // already been removed by windowsService.install(), and running
    // `ezz service install` again resumes from this point.
    const resume = installed.needsElevation
      ? ''
      : `\n\nServer mode stays enabled (data in ${dataDir}); after fixing the cause, run `
        + 'ezz service install again to finish — it resumes from here.';
    return {
      ok: false,
      mechanism: 'winsw',
      mode: MODES.SERVER,
      reason: `${installed.reason}${resume}`,
      needsElevation: installed.needsElevation ?? false,
      registrationFailed: installed.registrationFailed ?? false,
      dataDir,
      legacy: legacyResult,
    };
  }

  log('Waiting for the daemon to report in (the first start can take a while)…');
  const alive = await waitForDaemon({
    dataDir,
    timeoutMs: deps.startupGraceMs ?? STARTUP_GRACE_MS,
    onProgress: (waited, limit) => log(`  still waiting… ${Math.round(waited / 1000)}s of ${Math.round(limit / 1000)}s`),
  });
  if (!alive.alive) {
    // Out of time is not the same as failed. If Windows reports the service
    // RUNNING, the daemon is most likely still initialising (a first start of
    // the copied node.exe is slow while Defender scans it): the install is
    // done, and saying "Install failed" would be wrong.
    const scState = ws.queryState ? await ws.queryState({}) : null;
    if (scState === 'RUNNING' || scState === 'START_PENDING') {
      return {
        ok: true,
        stillInitialising: true,
        mechanism: 'winsw',
        mode: MODES.SERVER,
        dataDir,
        migrated: switched.migrated,
        backup: switched.backup,
        originalAt: switched.originalAt ?? null,
        granted: installed.granted,
        aclFailures: installed.aclFailures,
        runtime: installed.runtime,
        daemon: { pid: null, waitedMs: alive.waitedMs },
        detail: 'The service is started and still initialising; check with ezz service status in a minute.',
        legacy: legacyResult,
      };
    }

    const logs = ws.readLogs({ lines: 25, which: 'err' });
    return {
      ok: false,
      mechanism: 'winsw',
      mode: MODES.SERVER,
      reason: `the service was registered and started, but the daemon did not report in within `
        + `${Math.round(alive.waitedMs / 1000)}s and Windows reports it ${scState ? scState.toLowerCase() : 'in an unknown state'}.\n\n`
        + `Last log lines (${logs.file}):\n${logs.output}\n\n`
        + `More: ${windowsService.TROUBLESHOOTING_URL}#logs`,
      installedButNotRunning: true,
      dataDir,
      legacy: legacyResult,
    };
  }

  return {
    ok: true,
    mechanism: 'winsw',
    mode: MODES.SERVER,
    dataDir,
    migrated: switched.migrated,
    backup: switched.backup,
    originalAt: switched.originalAt ?? null,
    granted: installed.granted,
    aclFailures: installed.aclFailures,
    runtime: installed.runtime,
    daemon: { pid: alive.lock?.pid ?? null, waitedMs: alive.waitedMs },
    legacy: legacyResult,
  };
}

/** Windows Personal: a Startup-folder supervisor. No elevation, no data move. */
async function installWindowsPersonal({ entry, log, legacyResult, deps = {} }) {
  const dataDir = getDataDir();
  const wp = deps.windowsPersonal ?? windowsPersonal;

  // Personal mode runs as the logged-in user. On a machine already in Server
  // mode the live data is under ProgramData, written by an elevated install,
  // and a per-user daemon there could not write its own database. So the data
  // has to come back to %APPDATA% first, through the uninstall question that
  // already asks exactly that — never silently from here.
  if ((deps.isServerMode ?? isServerMode)()) {
    return {
      ok: false,
      mechanism: 'startup-supervisor',
      mode: MODES.PERSONAL,
      reason: `this machine is in Server mode: the data is in ${programDataDir()}.\n`
        + 'Personal mode needs it back in %APPDATA% first. In an Administrator PowerShell run\n'
        + '  ezz service uninstall\n'
        + 'and choose to move the data back, then install again and pick Personal mode.\n'
        + 'Or answer Yes to Server mode to finish the Server install instead.',
      legacy: legacyResult,
    };
  }

  const installed = wp.install({ dataDir, entry, log, ...(deps.windowsPersonalOpts ?? {}) });
  if (!installed.ok) {
    return { ok: false, mechanism: 'startup-supervisor', mode: MODES.PERSONAL, reason: installed.reason, legacy: legacyResult };
  }

  record({
    mode: MODES.PERSONAL,
    mechanism: 'startup-supervisor',
    nodeExe: installed.nodeExe,
    entry,
    dataDir,
    launcher: installed.launcher,
  });

  // Not started here, and not waited for: Personal mode starts at LOGON. The
  // user is logged in right now, so the honest thing is to say it will start
  // next time they sign in — and to offer `ezz daemon` meanwhile — rather than
  // to launch a detached process whose lifetime nothing manages.
  return {
    ok: true,
    mechanism: 'startup-supervisor',
    mode: MODES.PERSONAL,
    dataDir,
    launcher: installed.launcher,
    logFile: installed.logFile,
    startsAt: 'logon',
    legacy: legacyResult,
  };
}

/**
 * Removes the native service.
 *
 * `keepServerDataLocation` implements decision 5: uninstalling in Server mode
 * must NEVER silently move the data back to `%APPDATA%`. The default is to
 * keep using ProgramData; moving back is an explicit choice, and then it is a
 * real verified move with a backup.
 *
 * @param {Object} opts
 * @param {boolean} [opts.keepServerDataLocation] Default true
 * @param {boolean} [opts.removeLegacy]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<Object>}
 */
export async function uninstall({
  keepServerDataLocation = true,
  removeLegacy = false,
  log = () => {},
  deps = {},
} = {}) {
  // What the probes measure is about to change.
  invalidateProbes();
  const mech = resolveMechanism();
  const result = { mechanism: mech.mechanism, mode: mech.mode, notes: [], dataDir: getDataDir() };

  if (!isWindows) {
    const removed = await (deps.systemd ?? systemd).uninstall({ log, ...(deps.systemdOpts ?? {}) });
    if (!removed.ok) return { ok: false, ...result, reason: removed.reason };
  } else if (mech.mode === MODES.SERVER) {
    const config = loadConfig();
    const removed = await (deps.windowsService ?? windowsService).uninstall({
      dataDir: getDataDir(),
      config,
      log,
      ...(deps.windowsServiceOpts ?? {}),
    });
    if (!removed.ok) {
      return { ok: false, ...result, reason: removed.reason, needsElevation: removed.needsElevation ?? false };
    }
    result.notes.push(...(removed.notes ?? []));

    if (keepServerDataLocation) {
      result.notes.push(
        `The data stays at ${programDataDir()}. The Server-mode marker is kept, so the CLI and `
        + 'the dashboard keep reading it. Run `ezz service uninstall` again and choose to move it '
        + 'back if you change your mind.',
      );
      result.dataDir = programDataDir();
    } else {
      log('Moving the data back to %APPDATA%…');
      // Same reason as on install: this process's own handle would stop
      // Windows renaming the ProgramData directory, and every write after the
      // move must reach the database that is now live.
      (deps.closeDb ?? closeDb)();
      let moved;
      try {
        moved = (deps.disableServerMode ?? disableServerMode)({ log });
      } finally {
        (deps.reopenDb ?? reopenDb)();
      }
      if (!moved.ok) return { ok: false, ...result, reason: moved.reason };
      result.dataDir = moved.dataDir;
      result.movedData = moved.moved;
      result.backup = moved.backup;
      result.originalAt = moved.originalAt ?? null;
      if (moved.moved) result.notes.push(`Data moved back: ${describeOriginal(moved)}.`);
    }
  } else {
    const removed = (deps.windowsPersonal ?? windowsPersonal).uninstall({ log, ...(deps.windowsPersonalOpts ?? {}) });
    if (!removed.ok) return { ok: false, ...result, reason: removed.reason };
    result.notes.push(...(removed.notes ?? []));
  }

  // Legacy cleanup is offered on uninstall too: a user removing our service
  // almost certainly does not want the old PM2 boot hook left behind.
  const found = await legacy.detectLegacy(deps.legacy ?? {});
  result.legacy = { found: found.items, removed: [], failed: [] };
  if (found.found && removeLegacy) {
    const cleaned = await legacy.removeLegacy({ items: found.items, log, ...(deps.legacy ?? {}) });
    result.legacy.removed = cleaned.removed;
    result.legacy.failed = cleaned.failed;
  }

  const existing = dbGet(STATE_KEY) ?? {};
  dbSet(STATE_KEY, { ...existing, mode: null, mechanism: null, uninstalledAt: new Date().toISOString() });

  return { ok: true, ...result };
}

/**
 * Stops the daemon, temporarily.
 *
 * "Temporarily" is the whole distinction from uninstall: the service stays
 * installed and comes back at the next boot or logon. `ezz service start`
 * brings it back now.
 *
 * Personal mode has no service manager to ask, so it goes through the stop
 * request file that the daemon and its supervisor both watch — see
 * core/daemon/stopRequest.js for why that is a file and not an IPC command.
 *
 * @param {Object} [opts]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<Object>}
 */
export async function stop({ log = () => {}, deps = {} } = {}) {
  // What the probes measure is about to change.
  invalidateProbes();
  const mech = resolveMechanism();
  const dataDir = getDataDir();
  const before = inspectLock({ dataDir });

  let result;

  if (!isWindows) {
    result = await (deps.systemd ?? systemd).stop({ log, ...(deps.systemdOpts ?? {}) });
  } else if (mech.mode === MODES.SERVER) {
    result = await (deps.windowsService ?? windowsService).stop(deps.windowsServiceOpts ?? {});
  } else {
    // Personal mode. The request has to be written even when no daemon is
    // running right now: the supervisor may be mid-backoff and about to start
    // one, and the file is what stops that.
    const requested = (deps.requestStop ?? requestStop)({ dataDir, reason: 'ezz service stop' });
    if (!requested.ok) {
      return { ok: false, mechanism: mech.mechanism, mode: mech.mode, reason: requested.reason };
    }
    log(`Wrote the stop request: ${requested.path}`);

    if (!before.running) {
      recordStopped();
      return {
        ok: true,
        mechanism: mech.mechanism,
        mode: mech.mode,
        alreadyStopped: true,
        detail: 'No daemon was running. The request is in place, so the supervisor will not start one '
          + 'until the next logon or `ezz service start`.',
      };
    }

    // Wait for the daemon to actually go, so the command does not report
    // success while it is still running.
    const gone = await waitForDaemonGone({ dataDir, timeoutMs: deps.stopGraceMs ?? STOP_GRACE_MS });
    if (!gone.gone) {
      return {
        ok: false,
        mechanism: mech.mechanism,
        mode: mech.mode,
        reason: `the stop request was written but the daemon (pid ${before.lock?.pid}) was still running after `
          + `${Math.round(gone.waitedMs / 1000)}s. Check the supervisor log: ezz service logs`,
      };
    }

    recordStopped();
    return { ok: true, mechanism: mech.mechanism, mode: mech.mode, waitedMs: gone.waitedMs };
  }

  if (!result.ok) {
    return {
      ok: false,
      mechanism: mech.mechanism,
      mode: mech.mode,
      reason: result.reason,
      needsElevation: result.needsElevation ?? false,
    };
  }

  const gone = await waitForDaemonGone({ dataDir, timeoutMs: deps.stopGraceMs ?? STOP_GRACE_MS });
  recordStopped();

  return {
    ok: true,
    mechanism: mech.mechanism,
    mode: mech.mode,
    alreadyStopped: result.alreadyStopped ?? false,
    waitedMs: gone.waitedMs,
    ...(gone.gone ? {} : { detail: 'The service manager accepted the stop; the daemon lock has not cleared yet.' }),
  };
}

/**
 * Starts the daemon again after a stop.
 *
 * @param {Object} [opts]
 * @returns {Promise<Object>}
 */
export async function start({ log = () => {}, deps = {} } = {}) {
  // What the probes measure is about to change.
  invalidateProbes();
  const mech = resolveMechanism();
  const dataDir = getDataDir();

  // Refuse rather than start a second one. The daemon lock would refuse it
  // anyway, but saying so here is a clearer answer than a service that starts
  // and immediately exits.
  const existing = inspectLock({ dataDir });
  if (existing.running) {
    return {
      ok: false,
      mechanism: mech.mechanism,
      mode: mech.mode,
      alreadyRunning: true,
      reason: `a daemon is already running (pid ${existing.lock?.pid}). `
        + 'Use `ezz service restart` to replace it.',
    };
  }

  // Clearing the request is what makes a stop temporary. Done for every mode:
  // a stale request from a Personal-mode stop must not silently kill a daemon
  // started later by any route.
  (deps.clearStopRequest ?? clearStopRequest)({ dataDir });
  recordStarted();

  let result;

  if (!isWindows) {
    result = await (deps.systemd ?? systemd).start({ log, ...(deps.systemdOpts ?? {}) });
  } else if (mech.mode === MODES.SERVER) {
    result = await (deps.windowsService ?? windowsService).start(deps.windowsServiceOpts ?? {});
  } else {
    result = await (deps.windowsPersonal ?? windowsPersonal).startNow({
      dataDir,
      log,
      ...(deps.windowsPersonalOpts ?? {}),
    });
  }

  if (!result.ok) {
    return {
      ok: false,
      mechanism: mech.mechanism,
      mode: mech.mode,
      reason: result.reason,
      needsElevation: result.needsElevation ?? false,
    };
  }

  const alive = await waitForDaemon({ dataDir, timeoutMs: deps.startupGraceMs ?? STARTUP_GRACE_MS });
  if (!alive.alive) {
    return {
      ok: false,
      mechanism: mech.mechanism,
      mode: mech.mode,
      reason: `it was started but the daemon did not report in within `
        + `${Math.round(alive.waitedMs / 1000)}s. Check the logs: ezz service logs`,
    };
  }

  return {
    ok: true,
    mechanism: mech.mechanism,
    mode: mech.mode,
    pid: alive.lock?.pid ?? null,
    waitedMs: alive.waitedMs,
  };
}

/**
 * Restarts the service, in every mode.
 *
 * Personal mode has no service manager, so it is a stop followed by a start —
 * which is exactly what the two commands already do correctly, including
 * clearing the stop request so the restart is not immediately undone by it.
 * It used to refuse outright and tell the user to find the process themselves.
 */
export async function restart({ log = () => {}, deps = {} } = {}) {
  // What the probes measure is about to change.
  invalidateProbes();
  const mech = resolveMechanism();
  const dataDir = getDataDir();

  if (isWindows && mech.mode !== MODES.SERVER) {
    const stopped = await stop({ log, deps });
    if (!stopped.ok) {
      return { ok: false, reason: `could not stop it first: ${stopped.reason}`, needsElevation: stopped.needsElevation };
    }

    const started = await start({ log, deps });
    return started.ok
      ? { ok: true, pid: started.pid, waitedMs: started.waitedMs, viaStopStart: true }
      : { ok: false, reason: started.reason };
  }

  if (!isWindows) {
    const result = await (deps.systemd ?? systemd).restart(deps.systemdOpts ?? {});
    if (!result.ok) return { ok: false, reason: result.reason };
  } else {
    const result = await (deps.windowsService ?? windowsService).restart(deps.windowsServiceOpts ?? {});
    if (!result.ok) return { ok: false, reason: result.reason };
  }

  // A restart also ends a deliberate stop: the service is running again, so
  // `status` must stop saying the user stopped it.
  (deps.clearStopRequest ?? clearStopRequest)({ dataDir });
  recordStarted();

  const alive = await waitForDaemon({ dataDir, timeoutMs: deps.startupGraceMs ?? STARTUP_GRACE_MS });
  return alive.alive
    ? { ok: true, pid: alive.lock?.pid ?? null, waitedMs: alive.waitedMs }
    : {
      ok: false,
      reason: `the restart was accepted but the daemon did not report in within `
        + `${Math.round(alive.waitedMs / 1000)}s. Check the logs: ezz service logs`,
    };
}

/**
 * Cache keys for the probes in `status()`.
 *
 * Named rather than inline so `invalidateProbes()` and the tests refer to the
 * same strings, and prefixed so one call drops them all.
 */
export const PROBE_KEYS = Object.freeze({
  manager: 'service:manager',
  runtime: 'service:runtime',
  legacy: 'service:legacy',
});

/**
 * How long each probe stays fresh.
 *
 * Different numbers because the questions change at different rates, and the
 * cost of a stale answer differs too:
 *
 *  - the service MANAGER's view changes when the user starts or stops
 *    something, so it has the shortest life - though every one of those
 *    commands also calls invalidateProbes(), which is what actually keeps it
 *    correct. The TTL is the backstop for a change made outside this process,
 *    such as `sc stop` or systemctl by hand.
 *  - the RUNTIME changes on a repair or a runtime update, both of which
 *    invalidate.
 *  - LEGACY leftovers change only when install or uninstall removes them, and
 *    it is the most expensive probe of the three (PM2 detection, a PM2 app
 *    list and a schtasks query), so it gets the longest life.
 */
export const PROBE_TTL_MS = Object.freeze({
  [PROBE_KEYS.manager]: 10_000,
  [PROBE_KEYS.runtime]: 60_000,
  [PROBE_KEYS.legacy]: 300_000,
});

/** Drops every cached probe. See the note in core/probeCache.js. */
export function invalidateProbes() {
  return invalidate('service:');
}

/**
 * Everything `ezz service status` and `GET /api/service` need to say.
 *
 * ── Fast and correct at the same time ──────────────────────────────────────
 *
 * The cheap facts - the daemon lock, its heartbeat age, whether a stop was
 * requested, what install recorded - are read FRESH on every call. They cost
 * microseconds and they are the ones that change on their own.
 *
 * The expensive facts each cost a subprocess, and on Windows a subprocess
 * costs about a second. Those three are:
 *
 *   the service manager's view   `sc query` / `systemctl is-active` / a file
 *   the pinned runtime            `<node> --version`
 *   legacy PM2 leftovers          PM2 detection, `pm2 jlist`, `schtasks`
 *
 * They run in PARALLEL rather than one after another, and with `cache: true`
 * they come from core/probeCache.js, which answers immediately and refreshes
 * behind the request. Measured on the machine that reported this: about 20 s
 * sequential and uncached, about 2 s cold and parallel, single-digit
 * milliseconds warm.
 *
 * `cache: false` is the default, so the CLI keeps getting a freshly measured
 * answer - someone who has just typed `ezz service status` is asking BECAUSE
 * something changed. The dashboard passes `cache: true`.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.cache]       Serve cached probes, refresh behind
 * @param {number} [opts.coldWaitMs]   Max wait when a probe has never run
 * @returns {Promise<Object>}
 */
export async function status({ cache = false, coldWaitMs, deps = {} } = {}) {
  const mech = resolveMechanism();
  const dataDir = getDataDir();
  const config = loadConfig();
  const recorded = dbGet(STATE_KEY) ?? {};

  // The daemon's own view, which is the authority on whether work is happening.
  const lock = inspectLock({ dataDir });

  const out = {
    platform: mech.platform,
    mode: mech.mode,
    mechanism: mech.mechanism,
    dataDir,
    serverMode: isServerMode(),
    dashboardUi: config.dashboardUi ?? null,
    daemon: {
      running: lock.running,
      pid: lock.lock?.pid ?? null,
      version: lock.lock?.version ?? null,
      startedAt: lock.lock?.startedAt ?? null,
      heartbeatAgeMs: lock.age,
      detail: lock.reason,
    },
    warnings: [],
  };

  // ── The three expensive probes, together ─────────────────────────────────
  const managerProbe = () => {
    if (!isWindows) return (deps.systemd ?? systemd).status(deps.systemdOpts ?? {});
    if (mech.mode === MODES.SERVER) {
      return (deps.windowsService ?? windowsService).status({
        dataDir,
        config,
        granted: recorded.granted ?? [],
        ...(deps.windowsServiceOpts ?? {}),
      });
    }
    // Personal mode reads files only, so it is already cheap; it goes through
    // the same path for one shape rather than for speed.
    return (deps.windowsPersonal ?? windowsPersonal).status(deps.windowsPersonalOpts ?? {});
  };

  const runtimeProbe = () => (deps.inspectRuntime ?? inspectRuntime)({
    dataDir,
    recordedNodeExe: recorded.nodeExe ?? null,
  });

  const legacyProbe = () => (deps.detectLegacy ?? legacy.detectLegacy)(deps.legacy ?? {});

  const read = async (key, producer) => {
    if (!cache) return { value: await producer(), ageMs: 0, fresh: true, pending: false, refreshing: false };
    return probe(key, producer, {
      ttlMs: PROBE_TTL_MS[key],
      ...(coldWaitMs === undefined ? {} : { coldWaitMs }),
    });
  };

  const [manager, runtimeRead, legacyRead] = await Promise.all([
    read(PROBE_KEYS.manager, managerProbe),
    read(PROBE_KEYS.runtime, runtimeProbe),
    read(PROBE_KEYS.legacy, legacyProbe),
  ]);

  // A pending probe must not become a crash or a lie. The shape stays the
  // same and `probes` below says which parts are not measured yet, so a client
  // can render the rest and ask again.
  out.service = manager.value ?? { installed: null, running: null, state: null, pending: true, warnings: [] };
  out.runtime = runtimeRead.value ?? null;
  out.legacy = legacyRead.value?.items ?? [];

  if (isWindows && mech.mode === MODES.SERVER && out.service.acl && !out.service.acl.ok) {
    out.warnings.push(out.service.acl.reason);
  }
  if (isWindows && mech.mode !== MODES.SERVER) {
    out.warnings.push(...(out.service.warnings ?? []));
  }
  out.warnings.push(...(out.runtime?.warnings ?? []));

  // What the caller needs to know about the measurement itself: how old it is,
  // and whether anything is still being measured.
  out.probes = {
    cached: Boolean(cache),
    ageMs: Math.max(manager.ageMs ?? 0, runtimeRead.ageMs ?? 0, legacyRead.ageMs ?? 0),
    fresh: manager.fresh && runtimeRead.fresh && legacyRead.fresh,
    pending: manager.pending || runtimeRead.pending || legacyRead.pending,
    refreshing: manager.refreshing || runtimeRead.refreshing || legacyRead.refreshing,
  };

  if (out.service.crashLooping) {
    const crashes = out.service.crashRestarts ?? out.service.restarts;
    out.warnings.push(
      `The service is in a crash loop: ${crashes} unclean restart(s) in the last 10 minutes. `
      + 'It starts and dies rather than staying up. `ezz service logs` shows why.',
    );
  }

  // The record and Windows must agree. When they do not, say which way and
  // what to run — 1.4.0 reported "Installed: yes" for a service Windows did
  // not have (sc query: 1060).
  if (isWindows && mech.mode === MODES.SERVER) {
    if (out.service.registered === false && (recorded.mechanism === 'winsw' || out.service.filesPresent)) {
      out.warnings.push(
        'Easy DevOps has a Server-mode install on record, but Windows has no EasyDevOps service '
        + '(sc.exe query: 1060). Run `ezz service install` in an Administrator PowerShell to register it again.',
      );
    } else if (out.service.mismatch) {
      out.warnings.push(`${out.service.mismatch}. Run \`ezz service install\` in an Administrator PowerShell.`);
    }

    // A daemon holding the lock while Windows says the service is not running
    // was started some other way (by hand, or a dashboard) — worth naming.
    if (out.service.installed && out.service.state && !out.service.running && lock.running
        && out.service.state !== 'unknown') {
      out.warnings.push(
        `Windows reports the service ${out.service.state}, but a daemon is running (pid ${lock.lock?.pid}) — `
        + 'it was not started by the service.',
      );
    }
  }

  // Installed but the daemon is not reporting in: the most useful single thing
  // status can tell a user, and the one a service-manager-only check misses.
  if (out.service.installed && out.service.running && !lock.running) {
    out.warnings.push(
      'The service is running but no daemon has reported in. Either it is still starting, '
      + 'or it is failing immediately — `ezz service logs` will say which.',
    );
  }

  // "Stopped by you" and "not running" look identical to a service manager, and
  // telling a user their service crashed when they stopped it themselves is
  // both wrong and alarming. The distinction comes from two recorded facts: an
  // explicit stop writes `stoppedAt`, and Personal mode also leaves a stop
  // request file that is the actual reason nothing restarts.
  const stoppedOnPurpose = Boolean(recorded.stoppedAt)
    || (deps.isStopRequested ?? isStopRequested)({ dataDir });

  out.stoppedByUser = stoppedOnPurpose && !lock.running;
  out.stoppedAt = recorded.stoppedAt ?? null;

  if (out.stoppedByUser) {
    out.daemon.detail = recorded.stoppedAt
      ? `stopped by you at ${recorded.stoppedAt}`
      : 'stopped by you';
    // Anything on Windows that is not Server mode starts at LOGON, including
    // the case where no mode is recorded yet — Personal is the Windows default.
    const comesBack = isWindows && mech.mode !== MODES.SERVER
      ? 'at your next logon'
      : 'at the next boot';

    out.warnings.push(
      `The background service is stopped. This is temporary — it starts again ${comesBack}, `
      + 'or now with: ezz service start',
    );
  } else if (out.service.installed && !out.service.running && mech.mode !== MODES.PERSONAL) {
    out.warnings.push('The service is installed but not running. Start it with: ezz service start');
  } else if (out.service.installed && mech.mode === MODES.PERSONAL && !lock.running) {
    out.warnings.push(
      'The launcher is installed but no daemon is running. It starts at logon — '
      + 'or now with: ezz service start',
    );
  }

  if (out.legacy.length > 0) {
    out.warnings.push(
      `${out.legacy.length} leftover(s) from the old PM2-based service are still set up. `
      + 'Run `ezz service install` or `ezz service uninstall` to be offered their removal.',
    );
  }

  return out;
}

/**
 * Fills the probe cache without anyone waiting for it.
 *
 * Called once when the dashboard starts, so the first page load finds the
 * answers already there instead of paying for six subprocesses while someone
 * is watching a spinner.
 *
 * @param {Object} [opts]
 * @returns {Promise<void>}
 */
export async function warmProbes({ deps = {} } = {}) {
  try {
    await status({ cache: true, coldWaitMs: 60_000, deps });
  } catch (err) {
    // A warm-up that fails changes nothing: the next real request probes
    // again. It must never stop the dashboard from starting.
    process.stderr?.write?.(`[service] could not warm the status probes: ${err.message}\n`);
  }
}

/** Recent service logs. */
export async function logs({ lines = 50, which = 'out', deps = {} } = {}) {
  const mech = resolveMechanism();

  if (!isWindows) {
    const result = await (deps.systemd ?? systemd).journal({ lines, ...(deps.systemdOpts ?? {}) });
    return { ok: result.ok, source: `journalctl -u ${systemd.UNIT_NAME}`, output: result.output };
  }

  if (mech.mode === MODES.SERVER) {
    const result = (deps.windowsService ?? windowsService).readLogs({ lines, which });
    return { ok: result.ok, source: result.file, output: result.output };
  }

  const result = (deps.windowsPersonal ?? windowsPersonal).readLogs({ dataDir: getDataDir(), lines });
  return { ok: result.ok, source: result.file, output: result.output };
}

/**
 * Fixes what drifts: a broken runtime pin, stale ACLs, an outdated launcher.
 *
 * This is the command every "it stopped working after I upgraded Node" message
 * points at, which is why `status` names it in its warnings.
 */
export async function repair({ log = () => {}, deps = {} } = {}) {
  // What the probes measure is about to change.
  invalidateProbes();
  const mech = resolveMechanism();
  const dataDir = getDataDir();

  if (!isWindows) {
    return { ...(await (deps.systemd ?? systemd).repair({ dataDir, log, ...(deps.systemdOpts ?? {}) })), mechanism: 'systemd' };
  }

  if (mech.mode === MODES.SERVER) {
    const result = await (deps.windowsService ?? windowsService).repair({
      dataDir,
      appRoot: appRoot(),
      config: loadConfig(),
      log,
      // Repair restores the previous runtime if the daemon does not come up,
      // and "came up" means its heartbeat — not the service manager's word.
      waitForStart: () => waitForDaemon({
        dataDir,
        timeoutMs: deps.startupGraceMs ?? STARTUP_GRACE_MS,
        onProgress: (waited, limit) => log(`  still waiting… ${Math.round(waited / 1000)}s of ${Math.round(limit / 1000)}s`),
      }),
      ...(deps.windowsServiceOpts ?? {}),
    });
    if (result.ok) {
      const existing = dbGet(STATE_KEY) ?? {};
      dbSet(STATE_KEY, { ...existing, granted: result.granted ?? existing.granted ?? [], repairedAt: new Date().toISOString() });
    }
    return { ...result, mechanism: 'winsw' };
  }

  const result = (deps.windowsPersonal ?? windowsPersonal).repair({
    dataDir,
    entry: entryScript(),
    log,
    ...(deps.windowsPersonalOpts ?? {}),
  });
  if (result.ok) {
    const existing = dbGet(STATE_KEY) ?? {};
    dbSet(STATE_KEY, { ...existing, nodeExe: result.nodeExe, repairedAt: new Date().toISOString() });
  }
  return { ...result, mechanism: 'startup-supervisor' };
}

/** Records what was installed, merged over whatever is already there. */
function record(details) {
  const existing = dbGet(STATE_KEY) ?? {};
  dbSet(STATE_KEY, { ...existing, ...details, installedAt: new Date().toISOString() });
}

/** The recorded install details, for callers that only need to read them. */
export function recordedState() {
  return dbGet(STATE_KEY) ?? {};
}

/**
 * Updates the recorded runtime path without re-recording an install.
 *
 * `ezz runtime update` needs exactly this and nothing else: the service is
 * already installed, only the binary it runs changed. Exported rather than
 * duplicated there so `service-state` keeps one writer, and so `installedAt`
 * is not overwritten by what is not an install.
 *
 * @param {Object} details
 * @param {string} details.nodeExe
 */
export function recordRuntime({ nodeExe }) {
  const existing = dbGet(STATE_KEY) ?? {};
  dbSet(STATE_KEY, { ...existing, nodeExe, runtimeUpdatedAt: new Date().toISOString() });
}

export { legacy, runtimeNodePath, describeOriginal };
