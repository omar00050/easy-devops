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

import { repairPrivateKeys } from '../ssl/private-keys.js';
import fs from 'fs';
import os from 'os';
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
import { run as shellRun, runFile as shellRunFile } from '../shell.js';
import { loadConfig } from '../config.js';
import { dbGet, dbSet, closeDb, reopenDb } from '../db.js';
import { isPidAlive } from '../dashboardProcess.js';
import { inspect as inspectLock, HEARTBEAT_INTERVAL_MS } from '../daemon/lock.js';
import { requestStop, clearStopRequest, readStopRequest } from '../daemon/stopRequest.js';
import { inspect as inspectOwner } from '../jobs/owner.js';
import { probe, invalidate } from '../probeCache.js';

import * as systemd from './systemd.js';
import * as windowsService from './windowsService.js';
import * as windowsPersonal from './windowsPersonal.js';
import * as legacy from './legacy.js';
import * as dataDirModule from './dataDir.js';
import { enableServerMode, disableServerMode, describeOriginal } from './dataDir.js';
import { linkRuntime, inspectRuntime, runtimeNodePath } from './runtime.js';
import { resolveOperator, restoreOperatorDataAccess } from './operator.js';
import {
  checkDrift,
  compareVersions,
  driftMessage,
  cliVersion,
} from './versionDrift.js';
import {
  UNINSTALL_STAGE_TIMEOUT_MS,
  runUninstallStage,
} from './stageTimeout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where install details are recorded. Shared with the old module's key. */
const STATE_KEY = 'service-state';

/** The two Windows modes. */
export const MODES = Object.freeze({ SERVER: 'server', PERSONAL: 'personal' });

/**
 * What the last live probe learned about this Windows machine.
 *
 * `resolveMechanism()` is synchronous and is called from synchronous code
 * (`backgroundServiceState()`). The facts that need an `sc query` or the
 * registry are gathered asynchronously by the async entry points and left here,
 * so a later synchronous read sees the same answer instead of guessing from a
 * stale marker or record.
 *
 * @type {{ registered: boolean|null, edition: string|null, leftover: boolean|null,
 *          leftoverInfo: Object|null }}
 */
let lastFacts = {
  registered: null,
  edition: null,
  leftover: null,
  leftoverInfo: null,
};

function rememberFacts(facts) {
  if (!facts) return;
  lastFacts = { ...lastFacts, ...facts };
}

/**
 * Which mechanism applies here.
 *
 * The decision, in order (Windows):
 *
 *   1. the EasyDevOps service is registered            → Server (WinSW)
 *   2. Windows Server edition, the Server-mode marker,
 *      or leftover ProgramData data                    → Server (WinSW), not installed
 *   3. otherwise the caller's mode, else the recorded
 *      mode, else Personal
 *
 * Rule 2 is the fix for the 1.4.7 report: a Windows Server with no service
 * registered used to fall through to the Personal launcher.
 *
 * @param {Object} [opts]
 * @param {string} [opts.mode] Windows only; overrides the recorded/detected mode
 * @param {boolean|null} [opts.registered] Result of the live `sc query`
 * @param {string|null} [opts.edition] `windowsEdition()` result
 * @param {boolean|null} [opts.leftover] Leftover Server-mode data was detected
 * @returns {{ platform: 'linux'|'windows', mode: string|null, mechanism: string,
 *            registered?: boolean|null, edition?: string|null, installed?: boolean }}
 */
export function resolveMechanism({
  mode = null,
  registered = lastFacts.registered,
  edition = lastFacts.edition,
  leftover = lastFacts.leftover,
} = {}) {
  if (!isWindows) {
    return { platform: 'linux', mode: null, mechanism: 'systemd', registered: null, edition: null };
  }

  const marker = isServerMode();
  const serverEdition = edition === 'server';

  // The service manager is the authority: a registered service is a Server
  // install whatever the marker or the record says.
  if (registered === true) {
    return {
      platform: 'windows',
      mode: MODES.SERVER,
      mechanism: 'winsw',
      registered: true,
      edition,
      installed: true,
    };
  }

  if (serverEdition || marker || leftover === true) {
    return {
      platform: 'windows',
      mode: MODES.SERVER,
      mechanism: 'winsw',
      registered: registered ?? false,
      edition,
      installed: false,
    };
  }

  const recorded = dbGet(STATE_KEY)?.mode ?? null;
  const effective = mode ?? recorded;

  return {
    platform: 'windows',
    mode: effective,
    mechanism: effective === MODES.SERVER ? 'winsw' : 'startup-supervisor',
    registered: registered ?? null,
    edition,
  };
}

/** Per-process cache of the registry answer; one PowerShell call at most. */
const editionCache = { asked: false, edition: null, detail: null };

async function editionInfo({ run = shellRun } = {}) {
  if (!isWindows) return { edition: 'unknown', detail: 'not Windows' };

  // A caller-supplied `run` (a test or an elevated relaunch) is never cached:
  // its answer is about a different question than the real machine's.
  if (run === shellRun && editionCache.asked) {
    return { edition: editionCache.edition, detail: editionCache.detail };
  }

  let edition = 'unknown';
  let detail = 'could not determine the Windows edition';

  try {
    const type = await run(windowsEditionQueryCmd(), { timeout: 15_000 });
    const value = (type.stdout ?? '').trim();

    if (type.success && value) {
      // `Server` and `Server Core` both mean a machine that exists to serve.
      if (/^server/i.test(value)) edition = 'server';
      else if (/^client/i.test(value)) edition = 'client';

      const named = await run(windowsProductNameCmd(), { timeout: 15_000 });
      const product = (named.stdout ?? '').trim();
      detail = product || value;
    }
  } catch {
    // Unreadable registry: `unknown`. The caller keeps today's Personal
    // default, and resolveMechanism() still refuses a launcher when the
    // marker or leftover Server data says this is a Server install.
  }

  if (run === shellRun) {
    editionCache.asked = true;
    editionCache.edition = edition;
    editionCache.detail = detail;
  }

  return { edition, detail };
}

/**
 * `'server'` | `'client'` | `'unknown'`, asked of Windows once per process.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.run] Injected subprocess runner (tests only)
 * @returns {Promise<'server'|'client'|'unknown'>}
 */
export async function windowsEdition({ run = shellRun } = {}) {
  return (await editionInfo({ run })).edition;
}

function exists(file) {
  if (!file) return false;
  try {
    return Boolean(fs.lstatSync(file, { throwIfNoEntry: false }));
  } catch {
    return false;
  }
}

function hasExport(module, name) {
  return typeof module?.[name] === 'function';
}

async function detectLeftover({ deps = {} } = {}) {
  if (!isWindows) return { leftover: false };

  // Tests never read the machine's real ProgramData. A suite that exercises
  // this detection redirects ProgramData into its own temp directory; without
  // that redirect the honest answer is "nothing to say" rather than opening a
  // real database behind the suite's back.
  if (process.env.EZ_TEST === '1' && !deps.detectLeftoverServerData && !deps.programDataDir) {
    const root = String(process.env.ProgramData ?? '').trim();
    const temp = path.resolve(os.tmpdir()).toLowerCase();
    if (!root || !path.isAbsolute(root) || !path.resolve(root).toLowerCase().startsWith(temp)) {
      return { leftover: false, skipped: 'the real ProgramData is not read under EZ_TEST' };
    }
  }

  const detector = deps.detectLeftoverServerData
    ?? (hasExport(dataDirModule, 'detectLeftoverServerData')
      ? dataDirModule.detectLeftoverServerData
      : null);
  if (!detector) return { leftover: false, unavailable: true };

  try {
    return await detector({
      programDataDir: (deps.programDataDir ?? programDataDir)(),
      userDataDir: hasExport(dataDirModule, 'userDataDir') ? dataDirModule.userDataDir() : undefined,
    });
  } catch (error) {
    // A detection failure must not turn into a refusal or a launcher. Treat it
    // as "no leftover" and let the ordinary install path report its own error.
    return { leftover: false, error: error?.message ?? String(error) };
  }
}

async function readInstallProgressFrom({ dataDir, deps = {} } = {}) {
  const reader = deps.readInstallProgress
    ?? (hasExport(windowsService, 'readInstallProgress') ? windowsService.readInstallProgress : null);
  if (!reader) return null;
  try {
    return await reader(dataDir);
  } catch {
    return null;
  }
}

/**
 * The live facts that need a subprocess. Called by the async entry points
 * (install, start, stop, restart, repair, status, serviceInstallState).
 */
async function gatherFacts({ deps = {} } = {}) {
  if (!isWindows) {
    return { registered: null, edition: null, leftover: null, leftoverInfo: null };
  }

  const wsOpts = deps.windowsServiceOpts ?? {};
  const run = wsOpts.run ?? deps.run ?? shellRun;
  const runFile = wsOpts.runFile ?? deps.runFile ?? shellRunFile;

  let registered = null;
  // A supplied windowsService (tests) is not expected to implement `isRegistered`;
  // in that case the record/marker answer is kept rather than querying the real
  // machine behind the stub's back.
  const supplied = deps.windowsService;
  const isRegistered = deps.isRegistered
    ?? (supplied
      ? (hasExport(supplied, 'isRegistered') ? supplied.isRegistered : null)
      : (hasExport(windowsService, 'isRegistered') ? windowsService.isRegistered : null));
  if (isRegistered) {
    try {
      registered = await isRegistered({ run, runFile });
    } catch {
      registered = null;
    }
  }

  let edition = typeof deps.edition === 'string' ? deps.edition : null;
  if (!edition) {
    try {
      edition = await windowsEdition({ run: deps.editionRun ?? shellRun });
    } catch {
      edition = 'unknown';
    }
  }

  const leftoverInfo = await detectLeftover({ deps });
  return {
    registered: typeof registered === 'boolean' ? registered : null,
    edition,
    leftover: leftoverInfo?.leftover === true,
    leftoverInfo,
  };
}

/**
 * `gatherFacts()` + `resolveMechanism()`, for the async callers.
 */
async function detectMechanism({ mode = null, deps = {} } = {}) {
  if (!isWindows) return resolveMechanism({ mode });
  let facts = null;
  try {
    facts = await gatherFacts({ deps });
  } catch {
    facts = null;
  }
  if (facts) rememberFacts(facts);
  return resolveMechanism({
    mode,
    ...(facts ? { registered: facts.registered, edition: facts.edition, leftover: facts.leftover } : {}),
  });
}

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

/**
 * The one refusal a Windows Server with no registered service gets.
 *
 * It names the command that fixes it and the shell that command needs. A
 * Startup-folder launcher is never offered here (1.4.7 finding C4).
 */
const NOT_INSTALLED_MESSAGE = 'The Easy DevOps service is not installed on this Windows Server. '
  + 'Run `ezz service install` from an Administrator PowerShell.';

/** How long to wait for a stopping daemon to actually release its lock. */
export const STOP_GRACE_MS = 15_000;

/**
 * Safety net around the Windows implementation. Its named stages each have
 * their own deadline. This outer limit only catches an implementation bug that
 * bypasses an inner timer, after enough time for every expected stage.
 */
const WINDOWS_UNINSTALL_OUTER_STAGES = 8;

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

  const { edition, detail } = await editionInfo({ run });

  return {
    mode: edition === 'server' ? MODES.SERVER : MODES.PERSONAL,
    isServerEdition: edition === 'server',
    detail,
  };
}

/**
 * What an install decision needs to know, in one object.
 *
 * `leftover` is the full `detectLeftoverServerData()` result (or `null`), so a
 * caller can show both databases without another read.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.deps] Injected for tests
 * @returns {Promise<{ registered: boolean|null, edition: string, mode: string|null,
 *   mechanism: string, personalLauncher: { present: boolean, files: string[] },
 *   installProgress: Object|null, leftover: Object|null }>}
 */
export async function serviceInstallState({ deps = {} } = {}) {
  const facts = isWindows
    ? await gatherFacts({ deps })
    : { registered: null, edition: null, leftover: null, leftoverInfo: null };
  if (isWindows) rememberFacts(facts);

  const dataDir = getDataDir();
  const mech = resolveMechanism({
    registered: facts.registered,
    edition: facts.edition,
    leftover: facts.leftover,
  });

  const installProgress = isWindows && mech.mode === MODES.SERVER
    ? await readInstallProgressFrom({ dataDir, deps })
    : null;

  let personalLauncher = { present: false, files: [] };
  if (isWindows) {
    const wp = deps.windowsPersonal ?? windowsPersonal;
    const files = [];
    try {
      const candidates = [];
      if (hasExport(wp, 'launcherPath')) {
        candidates.push(wp.launcherPath(deps.startupDir ?? deps.windowsPersonalOpts?.startupDir));
      }
      if (hasExport(wp, 'supervisorPath')) candidates.push(wp.supervisorPath(dataDir));
      for (const file of candidates) {
        if (exists(file)) files.push(file);
      }
    } catch { /* an unreadable Startup folder is not a decision input */ }
    personalLauncher = { present: files.length > 0, files };
  }

  return {
    registered: facts.registered ?? null,
    edition: facts.edition ?? 'unknown',
    mode: mech.mode ?? null,
    mechanism: mech.mechanism,
    personalLauncher,
    installProgress,
    leftover: facts.leftoverInfo ?? null,
  };
}

/** The one sentence an install with leftover data prints, with both commands. */
function leftoverInstallMessage(leftover) {
  const describe = (side, label) => {
    const db = side?.db ?? null;
    if (!db?.exists) return `${label}: no database`;
    const keys = Number.isFinite(db.keyCount) ? `${db.keyCount} key(s)` : 'an unknown number of keys';
    const bytes = Number.isFinite(db.size) ? `${db.size} bytes` : 'unknown size';
    const when = db.mtime ? `, modified ${db.mtime}` : '';
    return `${label}: ${keys}, ${bytes}${when}`;
  };

  const lines = [
    'Easy DevOps data was found in C:\\ProgramData\\easy-devops but this machine is not in Server mode, '
      + 'so an install would otherwise read the per-user data in %APPDATA%. Nothing was changed.',
    '',
    describe(leftover?.programData, '  ProgramData'),
    describe(leftover?.userData, '  %APPDATA%'),
    '',
    'Choose one, non-interactively:',
    '  ezz service install --adopt-existing-data       keep the ProgramData data; %APPDATA% is left untouched',
    '  ezz service install --set-aside-existing-data   move ProgramData to easy-devops.old-<date>, then use %APPDATA%',
  ];
  if (leftover?.recommended === 'keep-aside') {
    lines.push('', 'The %APPDATA% database has more keys, so --set-aside-existing-data is the safer choice here.');
  } else if (leftover?.recommended === 'adopt') {
    lines.push('', 'The ProgramData database has the most keys, so --adopt-existing-data is the safer choice here.');
  }
  return lines.join('\n');
}

/**
 * Removes the Personal Startup launcher when a Server install takes over.
 *
 * Both files are copied into `<dataDir>\backup\personal-launcher-<stamp>\` and
 * the copies are compared byte for byte BEFORE either original is removed. A
 * copy failure removes nothing and is returned as a failure, with the next
 * step. Processes are never killed: a running supervisor is asked to stand
 * down through the ordinary stop-request file.
 */
async function removePersonalLauncherOnServer({ dataDir, log = () => {}, deps = {} } = {}) {
  // Under EZ_TEST, only an injected Personal module or Startup folder is
  // touched. A suite must never be able to remove a launcher from the real
  // Startup folder of the machine running it.
  if (process.env.EZ_TEST === '1'
      && !deps.windowsPersonal
      && deps.startupDir === undefined
      && deps.windowsPersonalOpts?.startupDir === undefined) {
    return { ok: true, removed: [], backupDir: null, skipped: true };
  }

  const wp = deps.windowsPersonal ?? windowsPersonal;
  const recorded = dbGet(STATE_KEY) ?? {};

  // The supervisor is what proves a Personal install of ours is here. Without
  // one, a file in the Startup folder is not ours to remove (it may belong to
  // another tool, or to a real user on a developer's machine).
  const supervisors = [];
  const addSupervisor = (file) => {
    if (file && !supervisors.includes(file) && exists(file)) supervisors.push(file);
  };
  if (hasExport(wp, 'supervisorPath')) {
    addSupervisor(wp.supervisorPath(dataDir));
    if (hasExport(dataDirModule, 'userDataDir')) addSupervisor(wp.supervisorPath(dataDirModule.userDataDir()));
  }
  if (recorded.supervisor && path.basename(recorded.supervisor) === windowsPersonal.SUPERVISOR_FILE) {
    addSupervisor(recorded.supervisor);
  }

  if (supervisors.length === 0) {
    return { ok: true, removed: [], backupDir: null };
  }

  const launcher = hasExport(wp, 'launcherPath')
    ? wp.launcherPath(deps.startupDir ?? deps.windowsPersonalOpts?.startupDir)
    : null;
  const candidates = [];
  if (launcher && exists(launcher)) candidates.push(launcher);
  candidates.push(...supervisors);

  // Stop the supervisor's daemon the same way `ezz service stop` does: a
  // stop-request file, then wait. Never a kill.
  const stopDirs = [];
  for (const file of candidates) {
    if (path.basename(file) === windowsPersonal.SUPERVISOR_FILE) stopDirs.push(path.dirname(file));
  }
  if (stopDirs.length === 0) stopDirs.push(dataDir);
  for (const dir of stopDirs) {
    const state = inspectLock({ dataDir: dir });
    if (!state.running) continue;
    const requested = (deps.requestStop ?? requestStop)({
      dataDir: dir,
      reason: 'switching to the Windows service',
    });
    if (!requested.ok) {
      return {
        ok: false,
        removed: [],
        backupDir: null,
        reason: `a Personal-mode daemon is running against ${dir} and could not be asked to stop: `
          + `${requested.reason}. Nothing was removed.`,
      };
    }
    const gone = await waitForDaemonGone({ dataDir: dir, timeoutMs: deps.stopGraceMs ?? STOP_GRACE_MS });
    if (!gone.gone) {
      return {
        ok: false,
        removed: [],
        backupDir: null,
        reason: `a Personal-mode daemon is still running against ${dir} (pid ${state.lock?.pid}). `
          + 'Nothing was removed; stop it with `ezz service stop`, then run this command again.',
      };
    }
  }

  const stamp = (() => {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
      + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  })();
  const backupDir = path.join(dataDir, 'backup', `personal-launcher-${stamp}`);

  const copies = [];
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const file of candidates) {
      const target = path.join(backupDir, path.basename(file));
      const original = fs.readFileSync(file);
      fs.writeFileSync(target, original, { flag: 'wx' });
      const copied = fs.readFileSync(target);
      if (copied.length !== original.length || !copied.equals(original)) {
        throw new Error(`the copy at ${target} does not match ${file}`);
      }
      copies.push({ file, target });
    }
  } catch (error) {
    return {
      ok: false,
      removed: [],
      backupDir,
      reason: `the Personal launcher could not be backed up before removal: ${error.message}. `
        + 'Both files were left in place. Check the free space and permissions of the backup folder, '
        + 'then run `ezz service install` again.',
    };
  }

  const removed = [];
  for (const { file } of copies) {
    try {
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch (error) {
      return {
        ok: false,
        removed,
        backupDir,
        reason: `the backup was written to ${backupDir}, but ${file} could not be removed: `
          + `${error.message}. Remove that file by hand, then run \`ezz service install\` again.`,
      };
    }
  }

  log(`Removed the Personal Startup launcher (a Server edition uses the Windows service); copies are in ${backupDir}`);
  return { ok: true, removed, backupDir };
}

/** Reads `package.json`'s version for a package root, without this CLI's root. */
function packageVersionAt(root) {
  if (!root) return null;
  try {
    return cliVersion({ deps: { packageRoot: root } });
  } catch {
    return null;
  }
}

/** `<root>/src/cli/index.js` → `<root>`, for a recorded Personal entry. */
function packageRootForWindowsEntry(entry) {
  if (!entry) return null;
  const parts = path.normalize(entry).split(path.sep);
  const cli = parts.lastIndexOf('cli');
  if (cli >= 2 && parts[cli - 1] === 'src') {
    const head = parts.slice(0, cli - 2).join(path.sep);
    if (head) return head;
  }
  return path.dirname(entry);
}

/** The installed unit's package, read from its own `ExecStart` line. */
function packageVersionFromUnit({ fsImpl = fs } = {}) {
  try {
    const text = fsImpl.readFileSync(systemd.UNIT_PATH, 'utf8');
    const line = text.split(/\r?\n/).find((l) => /^\s*ExecStart\s*=/.test(l));
    if (!line) return null;
    const tokens = line.slice(line.indexOf('=') + 1).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const cleaned = tokens.map((t) => t.replace(/^["']|["']$/g, ''));
    const entry = cleaned.find((t) => /src[\\/]cli[\\/]index\.js$/.test(t)) ?? cleaned[1] ?? null;
    if (!entry) return null;
    return packageVersionAt(systemd.packageRootFor(entry));
  } catch {
    return null;
  }
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
export function backgroundServiceState({ dataDir = getDataDir(), deps = {} } = {}) {
  const mech = deps.mechanism ?? resolveMechanism();
  const installedState = inspectInstalled({
    mech,
    fsImpl: deps.fs ?? fs,
  });
  const lock = inspectLock({ dataDir });
  const owner = inspectOwner({ dataDir });

  // "Stopped by you" is live state only: a request file that is still there
  // and no daemon holding the lock. A RECORDED stop (service-state.stoppedAt)
  // is history and never current state — deriving it from that record is what
  // showed "stopped by you" while the service was running (finding A5).
  //
  // Reading this must never clear the request: a dashboard poll during
  // `ezz service stop` would cancel the stop it is reporting. The file is
  // cleared by every start path and by the daemon when it takes the lock.
  const stopRequest = (deps.readStopRequest ?? readStopRequest)({ dataDir });
  if (lock.running) {
    // Drop the pre-1.4.7 compatibility record; the live file is the only source.
    try { recordStarted(); } catch { /* status must remain readable */ }
  }
  const stoppedByUser = stopRequest.requested && !lock.running;

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
    installed: installedState.installed,
    startsAt: startsAtFor(mech),

    stoppedByUser,
    stoppedAt: stoppedByUser ? stopRequest.at ?? null : null,

    dataDir,
    serverMode: isServerMode(),
    detail: installedState.detail
      ? (lock.reason ? `${lock.reason}; ${installedState.detail}` : installedState.detail)
      : lock.reason,
  };
}

/**
 * Whether a native service is installed, by the only cheap evidence there is:
 * the artifact each mechanism leaves behind.
 */
function inspectInstalled({ mech = resolveMechanism(), fsImpl = fs } = {}) {
  const inspect = (file) => {
    if (!file) return { exists: false, detail: null };
    try {
      const stat = fsImpl.lstatSync(file, { throwIfNoEntry: false });
      return { exists: Boolean(stat), detail: null };
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, detail: null };
      if (error?.code === 'EACCES' || error?.code === 'EPERM') {
        return {
          exists: null,
          detail: `Could not inspect the installed service at ${file}: ${error.message}`,
        };
      }
      return {
        exists: null,
        detail: `Could not inspect the installed service at ${file}: ${error?.message ?? String(error)}`,
      };
    }
  };

  try {
    if (!isWindows) {
      const unit = inspect(systemd.UNIT_PATH);
      return { installed: unit.exists, detail: unit.detail };
    }
    // A live `sc query` result, when the async entry points have one, beats the
    // artifact check: `sc 1060` with the wrapper still on disk is NOT installed
    // (the 1.4.0 failure). `backgroundServiceState()` stays synchronous; it
    // uses whatever the last live probe recorded.
    if (mech.registered === false && mech.mode === MODES.SERVER) {
      return { installed: false, detail: null };
    }
    if (mech.registered === true && mech.mode === MODES.SERVER) {
      return { installed: true, detail: null };
    }
    if (mech.mode === MODES.SERVER) {
      const wrapper = inspect(windowsService.winswPath());
      const xml = inspect(windowsService.serviceXmlPath());
      if (wrapper.exists === false || xml.exists === false) {
        return { installed: false, detail: wrapper.detail ?? xml.detail };
      }
      if (wrapper.exists === null || xml.exists === null) {
        return { installed: null, detail: wrapper.detail ?? xml.detail };
      }
      return { installed: true, detail: null };
    }
    const launcher = windowsPersonal.launcherPath();
    if (!launcher) return { installed: false, detail: null };
    const file = inspect(launcher);
    return { installed: file.exists, detail: file.detail };
  } catch (error) {
    return {
      installed: null,
      detail: `Could not inspect the installed service: ${error?.message ?? String(error)}`,
    };
  }
}

/** When the service starts itself: at logon (Personal) or at boot. */
function startsAtFor(mech = resolveMechanism()) {
  if (!isWindows) return 'boot';
  return mech.mode === MODES.SERVER ? 'boot' : 'logon';
}

/** Records a successful stop for status while no service manager is running. */
function recordStopped() {
  const existing = dbGet(STATE_KEY) ?? {};
  dbSet(STATE_KEY, { ...existing, stoppedAt: new Date().toISOString() });
}

/** Clears a completed deliberate-stop state after any start path. */
function recordStarted() {
  const existing = dbGet(STATE_KEY) ?? {};
  if (existing.stoppedAt) dbSet(STATE_KEY, { ...existing, stoppedAt: null });
}

/** A service start ends both the live request and the legacy stop timestamp. */
export function clearServiceStopState({ dataDir = getDataDir(), deps = {} } = {}) {
  const cleared = (deps.clearStopRequest ?? clearStopRequest)({ dataDir });
  if (cleared === false) {
    const file = path.join(dataDir, 'daemon.stop');
    const error = new Error(
      `could not clear the stop request at ${file}. The daemon would exit as soon as it starts. `
      + 'Close anything holding that file, delete it, then run `ezz service start` again.',
    );
    error.code = 'EZ_STOP_REQUEST_CLEAR';
    throw error;
  }
  recordStarted();
}

/**
 * Installs the native service.
 *
 * @param {Object} opts
 * @param {string} [opts.mode]           Windows: 'server' | 'personal'
 * @param {boolean} [opts.removeLegacy]  Remove the old PM2 setup (the CLI asks)
 * @param {'adopt'|'keep-aside'} [opts.leftoverChoice]
 *        What to do with a ProgramData database found without the Server-mode
 *        marker. Undefined refuses, naming both commands, and changes nothing.
 * @param {(line: string) => void} [opts.log]
 * @param {Object} [opts.deps]           Injected for tests
 * @returns {Promise<Object>}
 */
export async function install({
  mode = null,
  removeLegacy = false,
  leftoverChoice = undefined,
  log = () => {},
  deps = {},
} = {}) {
  // What the probes measure is about to change.
  invalidateProbes();

  const entry = entryScript();
  const root = appRoot();

  let facts = null;
  let resolved = mode;

  if (isWindows) {
    try {
      facts = await gatherFacts({ deps });
      rememberFacts(facts);
    } catch {
      facts = null;
    }

    resolved = mode ?? (await suggestWindowsMode({ run: deps.editionRun ?? shellRun })).mode;

    // Leftover Server data is a decision, not something to guess at. Refusing
    // here is what keeps a near-empty %APPDATA% database from replacing the
    // real one (the 1.4.7 report). Unreadable code folders in ProgramData are
    // not part of this: they are code, repaired or replaced, never a refusal.
    if (facts?.leftover === true && leftoverChoice !== 'adopt' && leftoverChoice !== 'keep-aside') {
      return {
        ok: false,
        code: 'leftover_data',
        mechanism: 'winsw',
        mode: MODES.SERVER,
        leftover: facts.leftoverInfo ?? null,
        message: leftoverInstallMessage(facts.leftoverInfo),
      };
    }

    // On a Windows Server the launcher is never the right answer, even if a
    // caller (or an old script) explicitly asked for Personal mode.
    if (resolved === MODES.PERSONAL && (facts?.edition === 'server' || facts?.leftover === true)) {
      return {
        ok: false,
        code: 'server_edition',
        mechanism: 'winsw',
        mode: MODES.SERVER,
        reason: 'This is Windows Server (or holds Server-mode data), so the service must run as a real '
          + 'Windows Service, not a Startup-folder launcher. Run `ezz service install` and choose Server '
          + 'mode. Nothing was changed.',
      };
    }
  }

  // A stop request left over from a previous install would make the daemon
  // exit the moment it started. Install is an explicit "I want this running".
  clearServiceStopState({ dataDir: getDataDir(), deps });

  const found = await legacy.detectLegacy(deps.legacy ?? {});
  const legacyResult = { found: found.items, removed: [], failed: [] };

  if (found.found && removeLegacy) {
    log('Removing the old PM2-based service…');
    const cleaned = await legacy.removeLegacy({ items: found.items, log, ...(deps.legacy ?? {}) });
    legacyResult.removed = cleaned.removed;
    legacyResult.failed = cleaned.failed;
  }

  if (!isWindows) {
    return installLinux({ entry, log, legacyResult, deps });
  }

  return resolved === MODES.SERVER
    ? installWindowsServer({
      entry,
      root,
      log,
      legacyResult,
      deps,
      leftoverChoice,
      leftover: facts?.leftoverInfo ?? null,
    })
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
async function installWindowsServer({
  entry,
  root,
  log,
  legacyResult,
  deps = {},
  leftoverChoice = undefined,
  leftover = null,
}) {
  const ws = deps.windowsService ?? windowsService;

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

  // ── Leftover Server data (finding 1.4.7, item 5) ─────────────────────────
  //
  // The caller has already refused when there was no choice. Both choices are
  // explicit and neither deletes anything:
  //   adopt      — write the marker, keep ProgramData as the live data, and
  //                leave %APPDATA% exactly as it is (no migration);
  //   keep-aside — rename ProgramData to easy-devops.old-<date>, verify it,
  //                then migrate %APPDATA% as a normal Server install.
  let adopted = false;
  let setAsideTo = null;
  if (leftover?.leftover === true && leftoverChoice === 'adopt') {
    const adopt = deps.adoptLeftoverServerData
      ?? (hasExport(dataDirModule, 'adoptLeftoverServerData') ? dataDirModule.adoptLeftoverServerData : null);
    if (!adopt) {
      return {
        ok: false,
        mechanism: 'winsw',
        mode: MODES.SERVER,
        reason: 'adopting the existing ProgramData data is not available in this build. '
          + 'Run `ezz service install --set-aside-existing-data` instead, or update Easy DevOps.',
        legacy: legacyResult,
      };
    }
    let result;
    try {
      result = await adopt({ log });
    } catch (error) {
      result = { ok: false, reason: error?.message ?? String(error) };
    }
    if (!result?.ok) {
      return {
        ok: false,
        mechanism: 'winsw',
        mode: MODES.SERVER,
        reason: `the existing ProgramData data could not be adopted: ${result?.reason ?? 'unknown error'}. `
          + 'Nothing was migrated and %APPDATA% was not touched.',
        legacy: legacyResult,
      };
    }
    adopted = true;
    // The marker now selects ProgramData; point this process's database at it.
    (deps.reopenDb ?? reopenDb)();
    log(`Adopted the existing Server data in ${result.dataDir ?? programDataDir()}; %APPDATA% was not touched.`);
  } else if (leftover?.leftover === true && leftoverChoice === 'keep-aside') {
    const setAside = deps.setAsideLeftoverServerData
      ?? (hasExport(dataDirModule, 'setAsideLeftoverServerData') ? dataDirModule.setAsideLeftoverServerData : null);
    if (!setAside) {
      return {
        ok: false,
        mechanism: 'winsw',
        mode: MODES.SERVER,
        reason: 'setting the existing ProgramData data aside is not available in this build. '
          + 'Run `ezz service install --adopt-existing-data` instead, or update Easy DevOps.',
        legacy: legacyResult,
      };
    }
    let result;
    try {
      result = await setAside({ log });
    } catch (error) {
      result = { ok: false, reason: error?.message ?? String(error) };
    }
    if (!result?.ok) {
      return {
        ok: false,
        mechanism: 'winsw',
        mode: MODES.SERVER,
        reason: `the existing ProgramData data could not be set aside: ${result?.reason ?? 'unknown error'}. `
          + 'Nothing was copied, moved or deleted.',
        legacy: legacyResult,
      };
    }
    setAsideTo = result.movedTo ?? null;
    log(`Moved the existing Server data aside to ${setAsideTo ?? 'its new folder'}; migrating %APPDATA% next.`);
  }

  // The data directory moves FIRST: everything after this — the ACL grants,
  // the service XML's EASY_DEVOPS_DATA_DIR — has to refer to the final
  // location, and a half-installed service pointing at the old one would see
  // an empty database.
  //
  // A machine already in Server mode — including one left there by a 1.4.0
  // install that failed at "Registering the service" — skips the migration
  // and resumes from here: enableServerMode() sees the marker and returns
  // without copying, so a ProgramData database that is already the live data
  // is reused rather than refused. An adopted install is exactly that case.
  const migrating = adopted ? false : !(deps.isServerMode ?? isServerMode)();

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
    switched = await (deps.enableServerMode ?? enableServerMode)({ log });
  } finally {
    (deps.reopenDb ?? reopenDb)();
  }
  if (!switched.ok) {
    return { ok: false, mechanism: 'winsw', mode: MODES.SERVER, reason: switched.reason, legacy: legacyResult };
  }

  const dataDir = switched.dataDir;
  if (switched.migrated) log(`  migrated; ${describeOriginal(switched)}`);
  // The marker now selects ProgramData; leftover detection has nothing left to
  // report for this process.
  rememberFacts({ leftover: false, leftoverInfo: null });

  // A Personal launcher left on this machine would start a second daemon at
  // logon, and on a Server it is simply the wrong mechanism. Copy both files
  // to a verified backup, then remove only those two, before the service is
  // registered. A copy failure leaves them in place and stops the install.
  const launcherCleanup = await removePersonalLauncherOnServer({ dataDir, log, deps });
  if (!launcherCleanup.ok) {
    return {
      ok: false,
      mechanism: 'winsw',
      mode: MODES.SERVER,
      reason: `${launcherCleanup.reason} The service was not installed.`,
      dataDir,
      legacy: legacyResult,
    };
  }

  const config = loadConfig();

  // Who may start and stop the service afterwards without elevation: the
  // account that asked for the install (operator.js). Resolved here, in the
  // elevated process, from Windows itself or from the relaunch that started it.
  const operator = await (deps.resolveOperator ?? resolveOperator)({});

  const installed = await ws.install({
    dataDir,
    appRoot: root,
    config,
    operator,
    log,
    ...(deps.windowsServiceOpts ?? {}),
  });

  // Recorded as soon as the service is registered and the grants are in —
  // not only after the heartbeat. Otherwise a slow first start left a
  // registered, granted service with no record, and `status` compared its
  // ACLs against an empty list.
  if (installed.ok || installed.registered) {
    rememberFacts({ registered: true });
    record({
      mode: MODES.SERVER,
      mechanism: 'winsw',
      nodeExe: installed.runtime?.nodeExe ?? null,
      entry: installed.runtime?.entry ?? entry,
      dataDir,
      granted: installed.granted ?? [],
      operator: installed.operator ?? null,
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
 * @param {number} [opts.stageTimeoutMs] Per-stage deadline (5 minutes by default)
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<Object>}
 */
export async function uninstall({
  keepServerDataLocation = true,
  removeLegacy = false,
  stageTimeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  log = () => {},
  deps = {},
} = {}) {
  // What the probes measure is about to change.
  invalidateProbes();
  const mech = resolveMechanism();
  const result = { mechanism: mech.mechanism, mode: mech.mode, notes: [], dataDir: getDataDir() };

  if (!isWindows) {
    let removed;
    try {
      removed = await runUninstallStage({
        stage: 'Removing the Easy DevOps systemd service',
        timeoutMs: stageTimeoutMs,
        log,
        action: async () => (deps.systemd ?? systemd).uninstall({
          log,
          ...(deps.systemdOpts ?? {}),
        }),
      });
    } catch (error) {
      return { ok: false, ...result, stage: error.stage ?? null, reason: error.message };
    }
    if (!removed.ok) return { ok: false, ...result, reason: removed.reason };
  } else if (mech.mode === MODES.SERVER) {
    const config = loadConfig();
    const operator = (dbGet(STATE_KEY) ?? {}).operator ?? null;
    let removed;
    try {
      removed = await runUninstallStage({
        stage: 'Removing the Easy DevOps Windows service',
        timeoutMs: stageTimeoutMs * WINDOWS_UNINSTALL_OUTER_STAGES,
        log,
        action: async () => (deps.windowsService ?? windowsService).uninstall({
          dataDir: getDataDir(),
          config,
          // Remove this temporarily while the recursive ACL operation runs.
          // The Windows implementation restores only the data grant when the
          // user chooses to keep the data at the Server-mode location.
          operator,
          keepOperatorDataAccess: keepServerDataLocation,
          log,
          stageTimeoutMs,
          ...(deps.windowsServiceOpts ?? {}),
        }),
      });
    } catch (error) {
      return {
        ok: false,
        ...result,
        stage: error.stage ?? null,
        reason: error.message,
      };
    }
    if (!removed.ok) {
      return {
        ok: false,
        ...result,
        stage: removed.stage ?? null,
        reason: removed.reason,
        needsElevation: removed.needsElevation ?? false,
      };
    }
    result.notes.push(...(removed.notes ?? []));

    if (keepServerDataLocation) {
      result.notes.push(
        `The data stays at ${programDataDir()}. The Server-mode marker is kept, so the CLI and `
        + 'the dashboard keep reading it. Run `ezz service uninstall` again and choose to move it '
        + 'back if you change your mind.',
      );
      if (operator?.dataDir) {
        result.notes.push(
          `${operator.name ?? 'Your account'} keeps write access to ${programDataDir()} so the CLI can still use it; `
          + 'it is removed when the data is moved back or purged.',
        );
      }
      result.dataDir = programDataDir();
      log(`Keeping data in ${programDataDir()} (no copy or move).`);
    } else {
      // Same reason as on install: this process's own handle would stop
      // Windows renaming the ProgramData directory, and every write after the
      // move must reach the database that is now live.
      (deps.closeDb ?? closeDb)();

      const restoreInstallerAfterFailedMove = async () => {
        if (!operator?.sid) return null;
        try {
          const restored = await runUninstallStage({
            stage: 'Restoring installing-account access',
            timeoutMs: stageTimeoutMs,
            log,
            action: ({ deadline, signal, timeoutMs }) => (
              deps.restoreOperatorDataAccess ?? restoreOperatorDataAccess
            )({
              operator,
              dataDir: programDataDir(),
              log,
              deadline,
              signal,
              timeoutMs,
            }),
          });
          return restored.ok ? null : restored.reason;
        } catch (error) {
          return error.message;
        }
      };

      let moved;
      try {
        moved = await runUninstallStage({
          stage: 'Moving user data back to %APPDATA%',
          timeoutMs: stageTimeoutMs,
          log,
          action: ({ deadline, signal }) => (
            deps.disableServerMode ?? disableServerMode
          )({ log, deadline, signal }),
        });
      } catch (error) {
        const restoreFailure = await restoreInstallerAfterFailedMove();
        return {
          ok: false,
          ...result,
          stage: error.stage ?? null,
          reason: `${error.message}`
            + (restoreFailure
              ? `\nThe installer's data-directory access could not be restored: ${restoreFailure}`
              : operator?.sid
                ? '\nThe installer\'s data-directory access was restored.'
                : ''),
        };
      } finally {
        (deps.reopenDb ?? reopenDb)();
      }
      if (!moved.ok) {
        const restoreFailure = await restoreInstallerAfterFailedMove();
        return {
          ok: false,
          ...result,
          stage: moved.stage ?? null,
          reason: `${moved.reason}`
            + (restoreFailure
              ? `\nThe installer's data-directory access could not be restored: ${restoreFailure}`
              : operator?.sid
                ? '\nThe installer\'s data-directory access was restored.'
                : ''),
        };
      }
      result.dataDir = moved.dataDir;
      result.movedData = moved.moved;
      result.backup = moved.backup;
      result.originalAt = moved.originalAt ?? null;
      if (moved.moved) result.notes.push(`Data moved back: ${describeOriginal(moved)}.`);
    }
  } else {
    let removed;
    try {
      removed = await runUninstallStage({
        stage: 'Removing the Personal-mode startup supervisor',
        timeoutMs: stageTimeoutMs,
        log,
        action: async () => (deps.windowsPersonal ?? windowsPersonal).uninstall({
          log,
          ...(deps.windowsPersonalOpts ?? {}),
        }),
      });
    } catch (error) {
      return { ok: false, ...result, stage: error.stage ?? null, reason: error.message };
    }
    if (!removed.ok) return { ok: false, ...result, reason: removed.reason };
    result.notes.push(...(removed.notes ?? []));
  }

  // Legacy cleanup is offered on uninstall too: a user removing our service
  // almost certainly does not want the old PM2 boot hook left behind.
  let found;
  try {
    found = await runUninstallStage({
      stage: 'Checking for an old PM2 setup',
      timeoutMs: stageTimeoutMs,
      log,
      action: async () => legacy.detectLegacy(deps.legacy ?? {}),
    });
  } catch (error) {
    return { ok: false, ...result, stage: error.stage ?? null, reason: error.message };
  }
  result.legacy = { found: found.items, removed: [], failed: [] };
  if (found.found && removeLegacy) {
    try {
      const cleaned = await runUninstallStage({
        stage: 'Removing the old PM2 startup setup',
        timeoutMs: stageTimeoutMs,
        log,
        action: async () => legacy.removeLegacy({
          items: found.items,
          log,
          ...(deps.legacy ?? {}),
        }),
      });
      result.legacy.removed = cleaned.removed;
      result.legacy.failed = cleaned.failed;
    } catch (error) {
      return { ok: false, ...result, stage: error.stage ?? null, reason: error.message };
    }
  }

  const existing = dbGet(STATE_KEY) ?? {};
  const keptOperator = mech.mode === MODES.SERVER && keepServerDataLocation && existing.operator?.dataDir
    ? { ...existing.operator, serviceControl: false }
    : null;
  dbSet(STATE_KEY, {
    ...existing, mode: null, mechanism: null, operator: keptOperator, uninstalledAt: new Date().toISOString(),
  });
  if (isWindows) rememberFacts({ registered: false, leftover: null, leftoverInfo: null });

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
  const mech = await detectMechanism({ deps });
  const dataDir = getDataDir();
  const before = inspectLock({ dataDir });

  if (isWindows && mech.mode === MODES.SERVER && mech.registered === false) {
    return {
      ok: false,
      code: 'not_installed',
      mechanism: mech.mechanism,
      mode: mech.mode,
      message: NOT_INSTALLED_MESSAGE,
      reason: NOT_INSTALLED_MESSAGE,
    };
  }

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
  const mech = await detectMechanism({ deps });
  const dataDir = getDataDir();

  // A Windows Server with no service registered gets the command that installs
  // one — never the Personal launcher (1.4.7 finding C4).
  if (isWindows && mech.mode === MODES.SERVER && mech.registered === false) {
    return {
      ok: false,
      code: 'not_installed',
      mechanism: mech.mechanism,
      mode: mech.mode,
      message: NOT_INSTALLED_MESSAGE,
      reason: NOT_INSTALLED_MESSAGE,
    };
  }

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

  // Clearing the request is what makes a stop temporary. Do this before the
  // manager starts the new daemon, which could otherwise consume it.
  clearServiceStopState({ dataDir, deps });

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
  const mech = await detectMechanism({ deps });
  const dataDir = getDataDir();

  if (isWindows && mech.mode === MODES.SERVER && mech.registered === false) {
    return {
      ok: false,
      code: 'not_installed',
      mechanism: mech.mechanism,
      mode: mech.mode,
      message: NOT_INSTALLED_MESSAGE,
      reason: NOT_INSTALLED_MESSAGE,
    };
  }

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

  // Server/Linux restarts start the replacement daemon as part of the manager
  // call. Clear the old marker first so that daemon cannot consume it during
  // startup. Personal mode above writes its own request, then start clears it.
  clearServiceStopState({ dataDir, deps });

  if (!isWindows) {
    const result = await (deps.systemd ?? systemd).restart(deps.systemdOpts ?? {});
    if (!result.ok) return { ok: false, reason: result.reason };
  } else {
    const result = await (deps.windowsService ?? windowsService).restart(deps.windowsServiceOpts ?? {});
    if (!result.ok) return { ok: false, reason: result.reason, needsElevation: result.needsElevation ?? false };
  }

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
  // The two live facts status needs to choose and describe the mechanism. They
  // are probes rather than an awaited preamble: a `sc query` and the registry
  // read are subprocesses, and running them before the Promise.all made every
  // status call serial (the 1.4.8 speed regression).
  registration: 'service:registration',
  edition: 'service:edition',
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
  // Registration changes when the user installs, removes or repairs the
  // service, and every one of those calls invalidateProbes(). Short here too,
  // as the backstop for a registration changed by hand.
  [PROBE_KEYS.registration]: 10_000,
  // A Windows edition (Server vs client) does not change while the machine is
  // up. Long enough that the registry is not re-read on every poll.
  [PROBE_KEYS.edition]: 3_600_000,
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
 * costs about a second. Those are:
 *
 *   the service manager's view   `sc query` / `systemctl is-active` / a file
 *   the registration             `sc query EasyDevOps`
 *   the Windows edition          the registry, through PowerShell
 *   the pinned runtime            `<node> --version`
 *   legacy PM2 leftovers          PM2 detection, `pm2 jlist`, `schtasks`
 *
 * They run in PARALLEL rather than one after another, and with `cache: true`
 * they come from core/probeCache.js, which answers immediately and refreshes
 * behind the request. Measured on the machine that reported this: about 20 s
 * sequential and uncached, about 2 s cold and parallel, single-digit
 * milliseconds warm.
 *
 * Only a Windows Server with no marker and no record can need a second manager
 * probe: the cheap evidence says Personal, the probes discover the edition, and
 * the Personal answer is dropped rather than cached. Healthy machines decide
 * from the marker or the record and never pay for it.
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
  const dataDir = getDataDir();
  const config = loadConfig();
  const recorded = dbGet(STATE_KEY) ?? {};

  // The daemon's own view, which is the authority on whether work is happening.
  const lock = inspectLock({ dataDir });

  // The CLI and the service's runtime copy are two packages in Windows Server
  // mode. This is a file read, so it is read fresh rather than probed/cached.
  const versionInfo = (deps.checkDrift ?? checkDrift)({ dataDir });

  // Cheap, synchronous evidence first: the Server-mode marker, the recorded
  // mode, and what the last live probe in this process learned. NOTHING here
  // spawns. The registry and `sc query` are probes below, in the same
  // Promise.all as the manager, runtime and legacy probes.
  const cheapMech = resolveMechanism();

  const out = {
    platform: cheapMech.platform,
    mode: cheapMech.mode,
    mechanism: cheapMech.mechanism,
    dataDir,
    serverMode: isServerMode(),
    dashboardUi: config.dashboardUi ?? null,
    serviceVersion: null,
    cliVersion: versionInfo.cliVersion ?? null,
    versionDrift: false,
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

  // ── The expensive probes, together ────────────────────────────────────────
  //
  // Five of them on Windows: the mechanism's status, the registration (`sc
  // query`), the edition (registry, PowerShell), the pinned runtime and the
  // legacy leftovers. Starting any of these before the Promise.all is what
  // made the 1.4.8 status call serial.
  const managerProducer = (forMech) => async () => {
    if (!isWindows) return (deps.systemd ?? systemd).status(deps.systemdOpts ?? {});
    if (forMech.mode === MODES.SERVER) {
      const managerStatus = await (deps.windowsService ?? windowsService).status({
        dataDir,
        config,
        // The install RECORD is not evidence of today's permissions. The live
        // read below (lane B's liveGrantState, or this one) is.
        granted: [],
        operatorSid: recorded.operator?.sid ?? null,
        ...(deps.windowsServiceOpts ?? {}),
      });

      // Lane B's status measures the live grants itself and exposes them as
      // `acl` (the old recorded-grant shape). Use that answer; only fall back
      // to a direct live read when the status object has none (a stub).
      let liveGrants = managerStatus?.liveGrants
        ?? (managerStatus?.acl && managerStatus.acl.checked !== undefined ? managerStatus.acl : null);
      const managerIsReal = !deps.windowsService || deps.windowsService === windowsService;
      if (!liveGrants && (managerIsReal || deps.liveGrantState)) {
        const reader = deps.liveGrantState
          ?? (hasExport(windowsService, 'liveGrantState') ? windowsService.liveGrantState : null);
        if (reader) {
          try {
            liveGrants = await reader({
              dataDir,
              nginxDir: config.nginxDir ?? null,
              sslDir: config.sslDir ?? null,
              ...(deps.windowsServiceOpts?.runFile ? { runFile: deps.windowsServiceOpts.runFile } : {}),
            });
          } catch (error) {
            liveGrants = { checked: false, missing: [], errors: [{ error: error?.message ?? String(error) }] };
          }
        }
      }
      return { ...managerStatus, liveGrants: liveGrants ?? null };
    }
    // Personal mode reads files only, so it is already cheap; it goes through
    // the same path for one shape rather than for speed.
    return (deps.windowsPersonal ?? windowsPersonal).status(deps.windowsPersonalOpts ?? {});
  };

  // A supplied platform module means the caller is testing (or replacing) the
  // mechanism. The real registry and SCM must not be consulted behind its
  // back, so only a module that implements `isRegistered` is asked.
  const injectedPlatform = Boolean(deps.windowsService || deps.windowsPersonal || deps.systemd);

  const registrationProbe = async () => {
    if (!isWindows) return { registered: null };
    const supplied = deps.windowsService;
    const isRegistered = deps.isRegistered
      ?? (supplied
        ? (hasExport(supplied, 'isRegistered') ? supplied.isRegistered : null)
        : (hasExport(windowsService, 'isRegistered') ? windowsService.isRegistered : null));
    if (!isRegistered) return { registered: lastFacts.registered ?? null, skipped: true };
    const registered = await isRegistered({
      run: deps.windowsServiceOpts?.run ?? deps.run ?? shellRun,
      runFile: deps.windowsServiceOpts?.runFile ?? deps.runFile ?? shellRunFile,
    });
    return { registered: typeof registered === 'boolean' ? registered : null };
  };

  const editionProbe = async () => {
    if (!isWindows) return { edition: null };
    if (typeof deps.edition === 'string') return { edition: deps.edition };
    if (injectedPlatform) return { edition: lastFacts.edition ?? 'unknown', skipped: true };
    return { edition: await windowsEdition({ run: deps.editionRun ?? shellRun }) };
  };

  const runtimeProbe = () => (deps.inspectRuntime ?? inspectRuntime)({
    dataDir,
    recordedNodeExe: recorded.nodeExe ?? null,
  });

  const legacyProbe = () => (deps.detectLegacy ?? legacy.detectLegacy)(deps.legacy ?? {});

  const read = async (key, producer) => {
    try {
      if (!cache) return { value: await producer(), ageMs: 0, fresh: true, pending: false, refreshing: false };
      return await probe(key, producer, {
        ttlMs: PROBE_TTL_MS[key],
        ...(coldWaitMs === undefined ? {} : { coldWaitMs }),
      });
    } catch (error) {
      return {
        value: null,
        error: error?.message ?? String(error),
        ageMs: 0,
        fresh: false,
        pending: false,
        refreshing: false,
      };
    }
  };

  const [managerRead, registrationRead, editionRead, runtimeRead, legacyRead] = await Promise.all([
    read(PROBE_KEYS.manager, managerProducer(cheapMech)),
    read(PROBE_KEYS.registration, registrationProbe),
    read(PROBE_KEYS.edition, editionProbe),
    read(PROBE_KEYS.runtime, runtimeProbe),
    read(PROBE_KEYS.legacy, legacyProbe),
  ]);

  // Fold what the live probes learned into the synchronous facts, then decide
  // the mechanism for real. On a healthy machine this agrees with the cheap
  // decision, so no second manager probe runs.
  const nextRegistered = typeof registrationRead.value?.registered === 'boolean'
    ? registrationRead.value.registered
    : lastFacts.registered;
  const nextEdition = typeof editionRead.value?.edition === 'string'
    ? editionRead.value.edition
    : lastFacts.edition;
  rememberFacts({ registered: nextRegistered ?? null, edition: nextEdition ?? null });

  const mech = resolveMechanism({
    registered: lastFacts.registered,
    edition: lastFacts.edition,
    leftover: lastFacts.leftover,
  });

  // The only case the cheap decision cannot get right: a Windows Server with
  // no marker and no record yet, where it guessed Personal. Measure the right
  // mechanism now and drop the wrong answer instead of caching it.
  let manager = managerRead;
  if (isWindows && mech.mechanism !== cheapMech.mechanism) {
    invalidate(PROBE_KEYS.manager);
    manager = await read(PROBE_KEYS.manager, managerProducer(mech));
  }

  out.mode = mech.mode;
  out.mechanism = mech.mechanism;

  if (manager.error) out.warnings.push(`Could not read the service state: ${manager.error}`);
  if (runtimeRead.error) out.warnings.push(`Could not inspect the pinned Node runtime: ${runtimeRead.error}`);
  if (legacyRead.error) out.warnings.push(`Could not inspect legacy service leftovers: ${legacyRead.error}`);

  // A pending probe must not become a crash or a lie. The shape stays the
  // same and `probes` below says which parts are not measured yet, so a client
  // can render the rest and ask again.
  out.service = manager.value ?? { installed: null, running: null, state: null, pending: true, warnings: [] };
  if (typeof out.service.registered === 'boolean') {
    rememberFacts({ registered: out.service.registered });
  }
  out.runtime = runtimeRead.value ?? null;
  out.legacy = legacyRead.value?.items ?? [];

  // ── Registration: the service manager's answer, not the files ────────────
  //
  // `registered` is the truth about "is there a service". A stub (a test) may
  // omit the field, so `installed` is the fallback there; a real Windows
  // Server status always reports it.
  const registered = typeof out.service.registered === 'boolean'
    ? out.service.registered
    : out.service.installed === false
      ? false
      : out.service.installed === true
        ? true
        : null;
  out.registered = registered;
  out.serviceInstalled = registered === true;

  // ── The service's version, only when a service is actually installed ─────
  //
  // Never this CLI's own package.json: the CLI and the service are two copies
  // in Windows Server mode, and printing the CLI's version while no service is
  // registered is exactly the 1.4.7 report. The daemon's heartbeat beats the
  // file: it is what is running.
  let serviceVersion = null;
  if (registered === true) {
    if (mech.mode === MODES.SERVER) {
      serviceVersion = lock.running && lock.lock?.version
        ? String(lock.lock.version)
        : versionInfo.serviceVersion ?? null;
    } else if (isWindows) {
      // Personal mode runs the recorded entry's package; with no record there
      // is nothing truthful to print, so it stays unknown.
      serviceVersion = packageVersionAt(packageRootForWindowsEntry(recorded.entry));
    } else {
      serviceVersion = packageVersionFromUnit() ?? null;
    }
  }
  out.serviceVersion = serviceVersion;

  const cli = versionInfo.cliVersion ?? null;
  out.cliVersion = cli;
  out.versionDrift = Boolean(
    registered === true && serviceVersion && cli && compareVersions(serviceVersion, cli) !== 0,
  );
  if (out.versionDrift) {
    out.warnings.push(
      versionInfo.message && versionInfo.serviceVersion === serviceVersion
        ? versionInfo.message
        : driftMessage({ serviceVersion, cliVersion: cli }),
    );
  }

  // ── Install progress (item 6) ────────────────────────────────────────────
  //
  // An install that stopped half way is "not finished", not "missing
  // permissions". The permission lines below are suppressed while it says so,
  // so the user is not sent to repair for something install has to finish.
  let installProgress = out.service.installProgress ?? null;
  if (!installProgress && isWindows && mech.mode === MODES.SERVER) {
    installProgress = await readInstallProgressFrom({ dataDir, deps });
  }
  out.installProgress = installProgress ?? null;
  const installUnfinished = Boolean(installProgress?.failedStep);
  out.installUnfinished = installUnfinished;
  if (installUnfinished) {
    out.warnings.unshift(
      `Install not finished (stopped at ${installProgress.failedStep}): run \`ezz service install\` to resume.`,
    );
  }

  // ── Access, from the live read only (item 7) ─────────────────────────────
  //
  // 1.4.7 derived "the service has no access to …" from the install RECORD,
  // and a failed install had recorded `granted: []`, so three false warnings
  // appeared on a server whose ACLs were correct. windowsService.status now
  // reads the live grants and reports their reason itself; this block only
  // covers a status object without that read, and never repeats it.
  const liveGrants = out.service.liveGrants ?? null;
  out.liveGrants = liveGrants;
  const managerHasAcl = out.service.acl && out.service.acl.checked !== undefined;
  if (isWindows && mech.mode === MODES.SERVER && registered === true && !installUnfinished && !managerHasAcl) {
    if (liveGrants?.checked === true) {
      const missing = Array.isArray(liveGrants.missing) ? liveGrants.missing : [];
      if (missing.length > 0) {
        const paths = missing.map((entry) => entry.path).filter(Boolean);
        out.warnings.push(
          `The service account (NT SERVICE\\EasyDevOps) has no access to ${paths.join(', ')}. `
          + 'Run `ezz service repair` from an Administrator PowerShell to restore it.',
        );
      }
    } else if (liveGrants && Array.isArray(liveGrants.errors) && liveGrants.errors.length > 0) {
      const detail = liveGrants.errors
        .map((entry) => (typeof entry === 'string' ? entry : entry?.error))
        .filter(Boolean)
        .join('; ');
      out.warnings.push(
        `Could not verify the service account's access to its data: ${detail}. `
        + 'Run `ezz service repair` from an Administrator PowerShell if this persists.',
      );
    }
  }

  // Who may start and stop it without elevation. The record says who it was
  // granted to; the service's DACL (read by the probe) says whether it still is.
  // The warning comes from that live read ONLY — never from the record — and
  // is never emitted while the same read says start/stop/restart are allowed.
  if (isWindows && mech.mode === MODES.SERVER) {
    const op = recorded.operator ?? null;
    const control = out.service.operatorControl ?? null;
    out.operator = op
      ? {
        name: op.name ?? null,
        sid: op.sid,
        serviceControl: control ? control.granted === true : false,
        dataDir: Boolean(op.dataDir),
        grantedAt: op.grantedAt ?? null,
        verified: Boolean(control),
      }
      : null;

    if (registered === true && control && control.granted === false && !installUnfinished) {
      out.warnings.push(
        'Starting and stopping the service need an Administrator terminal for your account. '
        + 'Run `ezz service repair` once from an Administrator PowerShell to allow it without elevation.',
      );
    }
    if (control?.excessive) {
      out.warnings.push(
        `The service permissions give ${op?.name ?? op?.sid} more than start, stop and query. `
        + 'Run `ezz service repair` from an Administrator PowerShell to reset them.',
      );
    }
  }

  // An unfinished install says exactly one thing about permissions: resume it.
  // Everything a live read says about missing access would send the user to
  // repair for a step install has not reached yet.
  let serviceWarnings = out.service.warnings ?? [];
  if (installUnfinished) {
    serviceWarnings = serviceWarnings.filter((warning) =>
      !/read from the live permissions|service account (?:has no|cannot read)|cannot read .*Run `ezz service (?:repair|recover)`/i
        .test(warning));
  }
  out.warnings.push(...serviceWarnings);
  out.warnings.push(...(out.runtime?.warnings ?? []));

  // What the caller needs to know about the measurement itself: how old it is,
  // and whether anything is still being measured.
  out.probes = {
    cached: Boolean(cache),
    ageMs: Math.max(
      manager.ageMs ?? 0,
      registrationRead.ageMs ?? 0,
      editionRead.ageMs ?? 0,
      runtimeRead.ageMs ?? 0,
      legacyRead.ageMs ?? 0,
    ),
    fresh: manager.fresh && registrationRead.fresh && editionRead.fresh
      && runtimeRead.fresh && legacyRead.fresh,
    pending: manager.pending || registrationRead.pending || editionRead.pending
      || runtimeRead.pending || legacyRead.pending,
    refreshing: manager.refreshing || registrationRead.refreshing || editionRead.refreshing
      || runtimeRead.refreshing || legacyRead.refreshing,
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
    if (registered === false && (recorded.mechanism === 'winsw' || out.service.filesPresent)) {
      out.warnings.push(
        'Easy DevOps has a Server-mode install on record, but Windows has no EasyDevOps service '
        + '(sc.exe query: 1060). Run `ezz service install` in an Administrator PowerShell to register it again.',
      );
    } else if (registered === false && !installUnfinished) {
      // A Windows Server with nothing installed: the command, not a launcher.
      out.warnings.push(NOT_INSTALLED_MESSAGE);
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

  // "Stopped by you" comes from LIVE state only: a stop request file that is
  // still on disk and no daemon running. Two rules, both learned from finding
  // A5 on a real server:
  //
  //   1. A recorded stop (service-state.stoppedAt) is HISTORY. Deriving the
  //      current state from it reported "stopped by you" while the service was
  //      running; it is only ever cleared here, never read as the answer.
  //   2. A status read NEVER clears the request. It used to, whenever the
  //      service manager said "running" and no heartbeat had arrived yet — so a
  //      dashboard poll during `ezz service stop` cancelled the stop. The file
  //      is cleared by every start path (service start/restart/repair/install,
  //      update/recover) and by the daemon itself when it takes the lock.
  const stopRequest = (deps.readStopRequest ?? readStopRequest)({ dataDir });
  const activelyRunning = lock.running || out.service.running === true;
  if (activelyRunning) {
    try { recordStarted(); } catch { /* keep status readable */ }
  }
  const stoppedOnPurpose = stopRequest.requested && !activelyRunning;

  out.stoppedByUser = stoppedOnPurpose;
  out.stoppedAt = stoppedOnPurpose ? stopRequest.at ?? null : null;

  if (out.stoppedByUser) {
    out.daemon.detail = out.stoppedAt
      ? `stopped by you at ${out.stoppedAt}`
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
  const mech = await detectMechanism({ deps });
  const dataDir = getDataDir();

  if (isWindows && mech.mode === MODES.SERVER && mech.registered === false) {
    // Clean up the launcher a 1.4.7 repair wrongly installed here, then say
    // what to run. The copy-first rule still applies; a failure leaves both
    // files and is reported instead of the plain refusal.
    const launcherCleanup = await removePersonalLauncherOnServer({ dataDir, log, deps });
    if (!launcherCleanup.ok) {
      return {
        ok: false,
        code: 'not_installed',
        mechanism: mech.mechanism,
        mode: mech.mode,
        message: launcherCleanup.reason,
        reason: launcherCleanup.reason,
      };
    }
    return {
      ok: false,
      code: 'not_installed',
      mechanism: mech.mechanism,
      mode: mech.mode,
      message: NOT_INSTALLED_MESSAGE,
      reason: NOT_INSTALLED_MESSAGE,
    };
  }

  // Repair is a start path. Clear the live marker before a manager or the
  // Personal supervisor is asked to run, otherwise the daemon can consume a
  // request that the user has already superseded by asking for repair.
  clearServiceStopState({ dataDir, deps });

  async function finish(result, mechanism) {
    if (result.ok) {
      try {
        await (deps.repairPrivateKeys ?? repairPrivateKeys)(loadConfig().sslDir, { server: mechanism === 'winsw' });
      } catch (error) {
        return { ...result, ok: false, mechanism, reason: `Certificate key permission repair failed: ${error.message}` };
      }
    }
    return { ...result, mechanism };
  }

  if (!isWindows) {
    const result = await (deps.systemd ?? systemd).repair({ dataDir, entry: entryScript(), log, ...(deps.systemdOpts ?? {}) });
    return finish(result, 'systemd');
  }

  if (mech.mode === MODES.SERVER) {
    // The same rule as install: a Personal launcher on a Server is replaced by
    // the service, after a verified copy of its two files.
    const launcherCleanup = await removePersonalLauncherOnServer({ dataDir, log, deps });
    if (!launcherCleanup.ok) {
      return { ok: false, mechanism: 'winsw', mode: MODES.SERVER, reason: launcherCleanup.reason };
    }

    const result = await (deps.windowsService ?? windowsService).repair({
      dataDir,
      appRoot: appRoot(),
      config: loadConfig(),
      // Repair is how an install from before 1.4.3 gets these rights.
      operator: await (deps.resolveOperator ?? resolveOperator)({}),
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
      rememberFacts({ registered: true });
      const existing = dbGet(STATE_KEY) ?? {};
      dbSet(STATE_KEY, {
        ...existing,
        granted: result.granted ?? existing.granted ?? [],
        operator: result.operator ?? existing.operator ?? null,
        repairedAt: new Date().toISOString(),
      });
    }
    return finish(result, 'winsw');
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
  return finish(result, 'startup-supervisor');
}

/** Records what was installed, merged over whatever is already there. */
function record(details) {
  const existing = dbGet(STATE_KEY) ?? {};
  dbSet(STATE_KEY, { ...existing, ...details, installedAt: new Date().toISOString() });
}

/** The recorded install details, for callers that only need to read them. */
export async function refreshUserService({ dataDir, log }) {
  const entry = entryScript();
  if (!isWindows) return systemd.refreshUnit({ dataDir, entry, log });
  return windowsPersonal.repair({ dataDir, entry, nodeExe: recordedState().nodeExe || process.execPath, log });
}

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
