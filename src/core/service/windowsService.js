/**
 * core/service/windowsService.js
 *
 * Windows "Server" mode: a real Windows Service, via WinSW.
 *
 * What this gives the user that the old Task Scheduler approach did not:
 *
 *   - It starts at boot, before anyone logs in. A scheduled task at logon
 *     meant a rebooted server stayed unmonitored until someone signed in.
 *   - It needs **no password, ever**. The service runs as the virtual account
 *     `NT SERVICE\EasyDevOps`, which Windows creates and manages itself. The
 *     old task needed the user's own password stored in Task Scheduler, which
 *     is what made that design unacceptable.
 *   - Restart on failure with backoff, and rolling logs, both from WinSW.
 *
 * The cost is elevation: registering a service, writing under ProgramData and
 * setting ACLs all need an Administrator terminal. UAC asks once, at install.
 *
 * ── Why the data directory moves ───────────────────────────────────────────
 *
 * The virtual account has no access to the installing user's `%APPDATA%`, so
 * `C:\ProgramData\easy-devops` becomes the data directory for the service, the
 * CLI and the dashboard alike. See core/service/dataDir.js — it is migrated
 * once, with a verified copy and a backup.
 */

import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'path';

import { run as shellRun, runFile as shellRunFile } from '../shell.js';
import { programDataDir, isWindows, WINDOWS_SC, windowsElevationCheckCmd } from '../platform.js';
import {
  SERVICE_ID,
  SERVICE_ACCOUNT,
  SERVICE_DISPLAY_NAME,
  WINSW_EXE_NAME,
  WINSW_XML_NAME,
  LEGACY_WINSW_NAME,
  buildServiceXml,
  downloadWinsw,
  verifyWinsw,
} from './winsw.js';
import {
  ACCESS, requiredGrants, applyGrants, revokeGrants, readPathAccess, systemTool,
  aclEntryAllowsReadExecute, parseIcaclsListing,
} from './acl.js';
import { runtimeDir, runtimeNodePath, copyRuntime, verifyNativeModules } from './runtime.js';
import {
  protectCodeRoot,
  removeCodeTree,
  grantOperator,
  grantServiceControl,
  ensureServiceDefaults,
  verifyServiceCodeRoot,
  revokeOperator,
  revokeServiceControl,
  restoreServiceControl,
  restoreOperatorDataAccess,
  readServiceSddl,
  resolveOperator,
  operatorAceState,
  prepareProtectedDir,
} from './operator.js';
import { renameWithRetry, replaceStateFile } from '../atomicState.js';
import { probe } from '../probeCache.js';
import {
  completeLogLines,
  readBoundedTailSync,
} from './logTail.js';
import {
  UNINSTALL_STAGE_TIMEOUT_MS,
  remainingStageMs,
  runUninstallStage,
} from './stageTimeout.js';

/** Where the wrapper, its config and its logs live. Admin-writable only. */
export function binDir() {
  return path.join(programDataDir(), 'bin');
}
/**
 * The wrapper and its definition: `EasyDevOps.exe` beside `EasyDevOps.xml`.
 *
 * WinSW v2 reads its configuration only from `<own base name>.xml` in its own
 * directory — a path given on the command line is ignored — so the two names
 * must share a stem. Both come from winsw.js, derived from SERVICE_ID.
 */
export function winswPath() {
  return path.join(binDir(), WINSW_EXE_NAME);
}
export function serviceXmlPath() {
  return path.join(binDir(), WINSW_XML_NAME);
}
/** Where 1.4.0 left the wrapper. Only ever removed, never run. */
export function legacyWinswPath() {
  return path.join(binDir(), LEGACY_WINSW_NAME);
}
export function logDir() {
  return path.join(programDataDir(), 'logs');
}

/** The rolling log WinSW writes the daemon's stdout to. */
export function wrapperLogPath() {
  return path.join(logDir(), `${SERVICE_ID}.wrapper.log`);
}
export function outLogPath() {
  return path.join(logDir(), `${SERVICE_ID}.out.log`);
}
export function errLogPath() {
  return path.join(logDir(), `${SERVICE_ID}.err.log`);
}

const require = createRequire(import.meta.url);

/**
 * This package's version, for the install progress record.
 *
 * The package root is THREE levels up from `src/core/service/`, not two: two
 * levels lands on `src/package.json`, which does not exist, and the version
 * silently read as null — so a record left by another version was reused. A
 * missing or unreadable file still returns null, never a throw.
 */
function packageVersion() {
  try {
    return String(require('../../../package.json').version);
  } catch {
    return null;
  }
}

/**
 * A timeout a timer can actually hold.
 *
 * `setTimeout(…, Infinity)` is not "wait for ever": Node warns
 * (`TimeoutOverflowWarning`), then fires on the next tick, and the command it
 * was guarding is killed immediately. That is how a recovery step inherited an
 * `Infinity` from a missing deadline (`remainingStageMs(undefined)` returns
 * Infinity by design) and turned into a timeout on the real server. Every wait
 * and every child-process timeout in this file goes through here, so nothing
 * infinite can reach a timer.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteMs(value, fallback) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

// ─── Install progress ────────────────────────────────────────────────────────
//
// Install is a long sequence of elevated steps: copy an 11,000-file runtime,
// write ACLs on it, register a service, grant three trees. On a real Windows
// Server it stopped at the runtime step, and the only way forward was to start
// again from the beginning — re-copying everything and re-protecting trees that
// had already passed.
//
// So each step boundary is written to `install-progress.json` in the DATA
// directory (atomic: core/atomicState.js), and the next `ezz service install`
// reads it back. A step recorded 'done' is skipped only when its result can be
// checked cheaply; the step that failed and every later step run again. The
// file is removed once an install completes, and the removal is safe: it is
// ours, it holds no user data, and a missing file simply means "start from the
// first step".
//
// A record written by a DIFFERENT version is never reused: the runtime copy it
// calls "done" is that version's code, and keeping it under a new CLI is the
// exact drift this release is fixing.

/** The progress file's name, in the data directory. */
export const INSTALL_PROGRESS_FILE = 'install-progress.json';

/** The install steps, in order. A later step never starts before an earlier one. */
export const INSTALL_STEPS = Object.freeze([
  'dataDir', 'runtime', 'bin', 'register', 'grants', 'operator', 'start',
]);

/** Human wording for a step, for "install not finished: …" messages. */
export const INSTALL_STEP_LABELS = Object.freeze({
  dataDir: 'protecting the data directory',
  runtime: 'copying and protecting the runtime',
  bin: 'installing the service wrapper',
  register: 'registering the service',
  grants: 'granting the service account access',
  operator: 'allowing your account to start and stop the service',
  start: 'starting the service',
});

/** Where the record lives. */
export function installProgressPath(dataDir) {
  return path.join(dataDir, INSTALL_PROGRESS_FILE);
}

/**
 * The install in progress, or null when there is none.
 *
 * Never throws and never writes. A half-written or unreadable file reads as
 * "no record", which only costs a re-run of steps that are idempotent anyway.
 *
 * @param {string} dataDir
 * @returns {{ version: string|null, startedAt: string|null, updatedAt: string|null,
 *             steps: Object<string, 'done'|'failed'>, failedStep: string|null,
 *             error: string|null }|null}
 */
export function readInstallProgress(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') return null;
  let text;
  try {
    text = fs.readFileSync(installProgressPath(dataDir), 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!parsed.steps || typeof parsed.steps !== 'object' || Array.isArray(parsed.steps)) return null;

  const steps = {};
  for (const name of INSTALL_STEPS) {
    const value = parsed.steps[name];
    if (value === 'done' || value === 'failed') steps[name] = value;
  }
  return {
    version: typeof parsed.version === 'string' ? parsed.version : null,
    startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    steps,
    failedStep: typeof parsed.failedStep === 'string' ? parsed.failedStep : null,
    error: typeof parsed.error === 'string' ? parsed.error : null,
  };
}

/**
 * Removes the record. Called when an install completes.
 *
 * Only this one file, and only by name: it is Easy DevOps's own scratch state,
 * never user data.
 *
 * @param {string} dataDir
 * @returns {boolean} Whether the file is gone afterwards
 */
export function clearInstallProgress(dataDir) {
  try {
    fs.rmSync(installProgressPath(dataDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes the record at each step boundary.
 *
 * A failed write is a warning, never a failed install: the record only saves
 * time on the next run, and losing that is not a reason to leave a server
 * without its service.
 */
function createInstallTracker({ dataDir, log = () => {} }) {
  const version = packageVersion();
  const previous = readInstallProgress(dataDir);
  const resuming = Boolean(previous && previous.version === version);
  if (previous && !resuming) {
    log(`The recorded install step belongs to version ${previous.version ?? 'unknown'}; `
      + `this is ${version ?? 'a different version'}, so every step runs again.`);
  }

  const now = () => new Date().toISOString();
  const state = {
    version,
    startedAt: resuming ? previous.startedAt ?? now() : now(),
    updatedAt: now(),
    steps: resuming ? { ...previous.steps } : {},
    failedStep: resuming ? previous.failedStep ?? null : null,
    error: resuming ? previous.error ?? null : null,
  };

  const write = () => {
    state.updatedAt = now();
    try {
      replaceStateFile(installProgressPath(dataDir), `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      log(`  warning: could not record the install step (${error?.code ?? error?.message ?? error}); `
        + 'the install continues, but a re-run cannot resume from here.');
    }
  };

  // Not written here: the first step boundary writes it. A run that refuses in
  // a preflight ("the service is not registered", "not elevated") changed
  // nothing, and must not leave a record that makes `status` say an install is
  // unfinished.
  return {
    resuming,
    previous,
    steps: state.steps,
    failedStep: () => state.failedStep,
    isDone: (name) => state.steps[name] === 'done',
    done(name) {
      state.steps[name] = 'done';
      if (state.failedStep === name) {
        state.failedStep = null;
        state.error = null;
      }
      write();
    },
    failed(name, error) {
      state.steps[name] = 'failed';
      state.failedStep = name;
      state.error = typeof error === 'string' ? error : error?.message ?? String(error);
      write();
    },
  };
}

/**
 * Whether this process can write under ProgramData — the practical test for
 * "are we elevated enough to do this".
 *
 * Attempted rather than inferred from a token check: group membership does not
 * tell you whether the process is actually running elevated, and a directory
 * write is exactly the permission that matters here.
 */
export async function canWriteProgramData() {
  const dir = programDataDir();

  // Probes the directory if it already exists, and otherwise probes its
  // PARENT. Creating `C:\ProgramData\easy-devops` as a side effect of asking
  // "am I elevated?" would leave a directory behind on a machine that never
  // installed anything — and this question is asked on paths that then
  // decline to proceed. Install creates the directory explicitly.
  let exists = false;
  try {
    await fs.promises.lstat(dir);
    exists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  const target = exists ? dir : path.dirname(dir);
  const probe = path.join(target, `.ez-write-probe-${process.pid}-${randomUUID()}`);

  try {
    await fs.promises.writeFile(probe, 'probe', { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  } finally {
    await fs.promises.rm(probe, { force: true }).catch(() => {});
  }
}

/** Where the troubleshooting guide lives, for links in messages. */
export const TROUBLESHOOTING_URL = 'https://easy-devops.devxor.team/docs/troubleshooting';

/** The message to print when elevation is missing. */
export function elevationMessage(command = 'ezz service install') {
  return [
    'Server mode needs an elevated terminal, and this one is not.',
    'Nothing was copied, migrated or registered.',
    '',
    'Open PowerShell with "Run as administrator" and run the command again:',
    '',
    `  ${command}`,
    '',
    'You will not be asked for a password: the service runs as the virtual',
    'account NT SERVICE\\EasyDevOps, which Windows manages itself.',
    `More: ${TROUBLESHOOTING_URL}#uac-unknown-publisher`,
  ].join('\n');
}

/**
 * One line explaining the UAC prompt, printed before the wrapper is called
 * when elevation could not be confirmed. WinSW is not code-signed, so Windows
 * shows "Unknown publisher" for EasyDevOps.exe; it is still the pinned binary.
 */
export const UAC_NOTE = `If Windows asks for permission for ${WINSW_EXE_NAME} ("Unknown publisher"): `
  + 'it is WinSW, the open-source service wrapper, verified by SHA-256 before use and not code-signed.';

/**
 * Whether this process runs elevated — asked of Windows, not inferred.
 *
 * canWriteProgramData() alone was not enough: when `C:\ProgramData\easy-devops`
 * does not exist yet it probes ProgramData itself, where ordinary users may
 * create folders, so a normal terminal passed it, migrated the data, and then
 * triggered a UAC prompt for the unsigned wrapper. This is the check that runs
 * before any Server-mode step.
 *
 * @returns {Promise<boolean|null>} null when PowerShell gave no usable answer
 */
export async function isElevated({ run = shellRun } = {}) {
  const result = await run(windowsElevationCheckCmd(), { timeout: 20_000 });
  const output = `${result?.stdout ?? ''}`.trim();
  if (/^true$/im.test(output)) return true;
  if (/^false$/im.test(output)) return false;
  return null;
}

/** Combined output of a shell result, trimmed. */
function outputOf(result) {
  return `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.trim();
}

/**
 * Service Control Manager calls use direct argv in production. The legacy
 * string runner remains injectable only so older focused tests can drive their
 * existing command stubs; no production caller selects that branch.
 */
function scExecutor({ run, runFile }) {
  if (run !== shellRun) {
    return (args, options) => run(`${WINDOWS_SC} ${args.join(' ')}`, options);
  }
  return (args, options) => runFile(systemTool(WINDOWS_SC), args, options);
}

/**
 * Filesystem inspection used by status and the first repair gate.
 *
 * Windows can deny access to a protected service file even though the file is
 * present. `existsSync` normally returns false for such failures, but injected
 * filesystems and future Node versions must not turn a status check into an
 * unhandled exception. Keep the error so callers can explain what happened.
 */
function inspectPath(fsImpl, file) {
  try {
    // existsSync() collapses every error into false. On Windows that turns an
    // EACCES/EPERM on a protected service file into "missing", which is both a
    // false status and a reason repair refuses to start. lstatSync keeps the
    // distinction; stat the link itself so a reparse point is still an entry.
    if (typeof fsImpl.lstatSync === 'function') {
      const stat = fsImpl.lstatSync(file, { throwIfNoEntry: false });
      return { exists: Boolean(stat), error: null };
    }
    // Compatibility for small filesystem stubs. Production always takes the
    // lstat path above.
    return { exists: fsImpl.existsSync(file), error: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, error: null };
    return { exists: false, error: error?.message ?? String(error) };
  }
}

/**
 * Whether the Service Control Manager knows a service called SERVICE_ID.
 *
 * Asked of `sc`, not of WinSW: a registration left behind by a failed or
 * interrupted install may point at a wrapper that no longer exists, and `sc`
 * still answers for it. 1060 is "The specified service does not exist".
 *
 * @returns {Promise<boolean|null>} null when `sc` itself gave no usable answer
 */
export async function isRegistered({
  run = shellRun,
  runFile = shellRunFile,
} = {}) {
  const sc = scExecutor({ run, runFile });
  let result;
  try {
    result = await sc(['query', SERVICE_ID], { timeout: 20_000 });
  } catch {
    return null;
  }
  const output = outputOf(result);
  if (/STATE\s*:/i.test(output)) return true;
  if (/1060|does not exist/i.test(output)) return false;
  return null;
}

/**
 * The stable SID for this service's virtual account.
 *
 * `sc.exe showsid` calculates it from the service name and works even when the
 * registration is already absent. That lets an interrupted uninstall remove
 * stale ACL entries without relying on name translation for an account the
 * Service Control Manager no longer knows.
 */
export async function serviceAccountSid({
  run = shellRun,
  runFile = shellRunFile,
} = {}) {
  const sc = scExecutor({ run, runFile });
  let result;
  try {
    result = await sc(['showsid', SERVICE_ID], { timeout: 20_000 });
  } catch {
    return null;
  }
  const output = outputOf(result);
  const sid = /SERVICE\s+SID\s*:\s*(S-1-5-80-\d+-\d+-\d+-\d+-\d+)/i.exec(output)?.[1] ?? null;
  return sid && /^S-1-5-80-\d+-\d+-\d+-\d+-\d+$/.test(sid) ? sid : null;
}

/**
 * Removes a registration of SERVICE_ID, whatever state it is in.
 *
 * Removal uses `sc stop` + `sc delete` only. An existing wrapper is never
 * executed before it has been hash-verified and replaced, because the folder
 * may contain an administrator-writable or otherwise unverified binary. The
 * Service Control Manager can stop and delete a registration without loading
 * that binary. A service that is marked for deletion while a handle is open
 * (services.msc, for instance) disappears once that handle closes.
 *
 * @returns {Promise<{ ok: boolean, removed: boolean, reason?: string }>}
 */
export async function unregister({
  run = shellRun,
  runFile = shellRunFile,
  log = () => {},
  force = false,
  skipStop = false,
  deleteWaitMs = 30_000,
  deletePollMs = 500,
} = {}) {
  const sc = scExecutor({ run, runFile });
  // Finite whatever the caller passed: these become a timer and a deadline.
  const pollMs = finiteMs(deletePollMs, 500);
  const removeWaitMs = finiteMs(deleteWaitMs, 30_000);

  const still = await isRegistered({ run, runFile });
  if (still === null) {
    return {
      ok: false,
      removed: false,
      reason: `Could not determine whether ${SERVICE_ID} is registered. Nothing was removed. `
        + `Run ${WINDOWS_SC} query ${SERVICE_ID} in an Administrator PowerShell, then retry.`,
    };
  }
  if (still === false && !force) return { ok: true, removed: false };

  if (!skipStop) await sc(['stop', SERVICE_ID], { timeout: 60_000 });
  const deleted = await sc(['delete', SERVICE_ID], { timeout: 30_000 });
  const output = outputOf(deleted);

  const waitForRemoval = async () => {
    const deadline = Date.now() + removeWaitMs;
    let lastState = true;
    let lastError = null;
    do {
      lastState = await isRegistered({ run, runFile });
      if (lastState === false) return { ok: true, removed: true };
      lastError = lastState === null
        ? `SCM did not return a usable state for ${SERVICE_ID}`
        : null;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    } while (true);
    return {
      ok: false,
      removed: false,
      reason: lastError
        ? `${lastError}. The service was not removed, so nothing may replace its runtime.`
        : `Windows has marked ${SERVICE_ID} for deletion, but SCM still owns it. `
          + 'Close services.msc and retry, or restart Windows before installing again.',
    };
  };

  if (deleted.success || /1060|does not exist/i.test(output)) {
    const removed = await waitForRemoval();
    if (removed.ok) log(`Removed the ${SERVICE_ID} service registration.`);
    return removed;
  }
  if (/1072|marked for deletion/i.test(output)) {
    return waitForRemoval();
  }
  return { ok: false, removed: false, reason: output.slice(0, 400) || `${WINDOWS_SC} delete ${SERVICE_ID} failed` };
}

/** Removes the wrapper 1.4.0 left under its release name. Best effort. */
function removeLegacyWinsw(log) {
  const legacy = legacyWinswPath();
  if (legacy === winswPath() || !fs.existsSync(legacy)) return;
  try {
    fs.rmSync(legacy, { force: true });
    log(`Removed ${legacy} (the wrapper's old name).`);
  } catch (err) {
    log(`  warning: could not remove ${legacy}: ${err.message}`);
  }
}

/**
 * Removes one service-owned directory without following links.
 *
 * Deletion is bottom-up and asynchronous so the uninstall stage deadline can
 * abort it. Hard links are safe to unlink because only this directory entry is
 * removed. Reparse points and non-file entries are refused before deletion.
 */
async function removeServiceDirectory(target, {
  deadline = Infinity,
  signal,
  stage = 'Removing obsolete service files',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
} = {}) {
  // This budget only feeds the stage checks (and the message a timeout
  // produces), so an unusable one must not become "no limit" anywhere.
  const stageBudgetMs = finiteMs(timeoutMs, UNINSTALL_STAGE_TIMEOUT_MS);
  let root;
  try {
    root = await fs.promises.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error(`${target} is a link, reparse point, or non-directory`);
  }

  const pending = [target];
  const directories = [];
  const files = [];
  while (pending.length) {
    remainingStageMs(deadline, stage, stageBudgetMs);
    signal?.throwIfAborted();
    const directory = pending.pop();
    directories.push(directory);
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      remainingStageMs(deadline, stage, stageBudgetMs);
      signal?.throwIfAborted();
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing a reparse point at ${entryPath}`);
      }
      if (stat.isDirectory()) {
        pending.push(entryPath);
      } else if (stat.isFile()) {
        files.push(entryPath);
      } else {
        throw new Error(`refusing a non-file entry at ${entryPath}`);
      }
    }
  }

  for (const file of files) {
    remainingStageMs(deadline, stage, stageBudgetMs);
    signal?.throwIfAborted();
    await fs.promises.unlink(file);
  }
  for (const directory of directories.reverse()) {
    remainingStageMs(deadline, stage, stageBudgetMs);
    signal?.throwIfAborted();
    await fs.promises.rmdir(directory);
  }
  return true;
}

async function removeObsoleteServiceFiles({
  dataDir,
  deadline,
  signal,
  log,
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
}) {
  let removed = 0;
  for (const target of [runtimeDir(dataDir), `${runtimeDir(dataDir)}.prev`, binDir()]) {
    if (await removeServiceDirectory(target, {
      deadline,
      signal,
      stage: 'Removing obsolete service files',
      timeoutMs,
    })) {
      removed++;
      log(`  removed ${target}`);
    }
  }
  return removed;
}

/**
 * Installs the service.
 *
 * Order matters and is deliberate:
 *   1. the data directory, protected in place
 *   2. the runtime copy, in a folder protected while it was still empty, then
 *      verified once — folder ACL, the files the service executes, and one
 *      streamed scan of the tree
 *   3. verify native modules load with the copied node.exe — before a service
 *      is registered against a runtime that cannot start
 *   4. WinSW, verified against its pinned hash, then the XML
 *   5. register, so the virtual account exists
 *   6. ACLs, so the service account can reach what it needs
 *   7. the installing user's own start/stop and data access, then start
 *
 * Steps 3 and 4 are refusals, not warnings. Registering a service that cannot
 * run, or installing an unverified binary with service privileges, are both
 * worse than stopping with an explanation.
 *
 * Each step boundary is recorded in `install-progress.json`, and a later run
 * resumes from the failed one. Every protection call goes through the one
 * routine in operator.js (`protectCodeRoot`, via `prepareProtectedDir`), so
 * install, repair and recover cannot drift apart.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {string} opts.appRoot
 * @param {Object} [opts.config]    Live settings, for the ACL paths
 * @param {(line: string) => void} [opts.log]
 * @param {Function} [opts.run]
 * @param {Function} [opts.fetchImpl]
 * @param {Object} [opts.deps]  Injected for tests: canWrite, isWindows, isElevated, copyRuntime,
 *                              verifyNativeModules, verifyWinsw, prepareProtectedDir,
 *                              verifyServiceCodeRoot, grantOperator
 * @returns {Promise<{ ok: boolean, reason?: string, granted?: string[], runtime?: Object,
 *                     registrationFailed?: boolean, failedStep?: string,
 *                     installProgress?: Object|null }>}
 */
export async function install({
  dataDir,
  appRoot,
  config = {},
  operator = null,
  log = () => {},
  run = shellRun,
  runFile = shellRunFile,
  fetchImpl = fetch,
  deps = {},
} = {}) {
  if (!(deps.isWindows ?? isWindows)) return { ok: false, reason: 'Server mode is Windows-only' };

  // A real elevation check first; the write probe stays as a second opinion.
  const elevated = await (deps.isElevated ?? (() => isElevated({ run })))();
  if (elevated === false || !await (deps.canWrite ?? canWriteProgramData)()) {
    return { ok: false, reason: elevationMessage(), needsElevation: true };
  }

  // Every step boundary below is written to `install-progress.json`, and an
  // interrupted install resumes from the failed step. See the section above
  // `readInstallProgress` for why, and for the version rule.
  const tracker = createInstallTracker({ dataDir, log });
  if (tracker.resuming) {
    const at = tracker.failedStep();
    log(`Resuming the install: it stopped at ${INSTALL_STEP_LABELS[at] ?? at ?? 'the last recorded step'}. `
      + 'Steps that already passed are kept and re-checked rather than redone.');
  }

  // Records the failure and answers the caller. Every reason ends with what to
  // do next, and the recorded step is what the next `install` resumes from.
  // `registered` is reported whenever the service really is registered, so the
  // caller records it and `status` does not say "not installed".
  let registrationInPlace = false;
  const fail = (step, reason, extra = {}) => {
    tracker.failed(step, reason);
    return {
      ok: false,
      failedStep: step,
      installProgress: readInstallProgress(dataDir),
      ...(registrationInPlace ? { registered: true } : {}),
      ...extra,
      reason,
    };
  };

  // A service left by an earlier attempt is normally stopped and unregistered
  // before runtime/bin are replaced: deleting a running wrapper is refused by
  // Windows, and leaving either executable directory for a merge would let
  // content written by another account survive into the service runtime.
  //
  // A RESUMED install keeps the registration its own record calls done. It is
  // this service, registered by the run that stopped later; tearing it down
  // would renumber the virtual account and make the record pointless. If a code
  // folder still has to be replaced, it is stopped first (Windows locks the
  // running image) and the registration stays.
  const keepRegistration = tracker.isDone('register');
  const existing = await isRegistered({ run, runFile });
  if (existing === null) {
    return {
      ok: false,
      registrationFailed: true,
      reason: 'Could not determine whether an EasyDevOps service is already registered. '
        + 'Nothing was replaced or registered. Run `sc.exe query EasyDevOps` in an '
        + 'Administrator PowerShell to inspect the service manager, then retry.',
    };
  }
  if (existing && keepRegistration) {
    log(`Install progress: the ${SERVICE_ID} service is already registered; keeping the registration.`);
    registrationInPlace = true;
  } else if (existing) {
    log(`A ${SERVICE_ID} service is already registered; removing it before registering again…`);
    const cleared = await unregister({ run, runFile, log });
    if (!cleared.ok) {
      return {
        ok: false,
        registrationFailed: true,
        reason: `an existing ${SERVICE_ID} service could not be removed first:\n${cleared.reason}\n\n`
          + `Hint: stop and delete it in an Administrator PowerShell (sc.exe stop ${SERVICE_ID}; `
          + `sc.exe delete ${SERVICE_ID}), then run ezz service install again.`,
      };
    }
  }

  /** Before replacing a code folder while our own registration stays in place. */
  const stopForReplacement = async () => {
    if (!(existing && keepRegistration)) return { ok: true };
    log('Stopping the service so its files can be replaced…');
    const stopped = await stop({ run, runFile, stopWaitMs: 60_000 });
    if (stopped.ok) return stopped;
    // Already gone is fine: there is nothing holding the files.
    return /not installed|nothing to stop/i.test(stopped.reason ?? '') ? { ok: true } : stopped;
  };

  // ── Step dataDir: the data folder, protected in place ────────────────────
  //
  // Not a fresh folder: the user's database, logs and sessions live here, so it
  // is protected in place and never reset recursively. An earlier install may
  // have left the installing user a grant that a new folder would inherit.
  if (tracker.isDone('dataDir')) {
    log('Install progress: the data directory is already protected; keeping it.');
  } else {
    const prepared = await (deps.prepareProtectedDir ?? prepareProtectedDir)({
      dir: dataDir,
      sid: operator?.sid ?? null,
      serviceAccount: false,
      fresh: false,
      runFile,
      log,
      mode: 'install',
    });
    if (!prepared.ok) {
      return fail('dataDir', `${prepared.reason}. Nothing was registered.\n`
        + `${prepared.next ?? 'Fix the cause above, then run ezz service install again in an Administrator PowerShell.'}`);
    }
    tracker.done('dataDir');
  }

  // ── Step runtime: the pinned runtime, copied and verified ────────────────
  let runtime = null;
  let native = null;

  if (tracker.isDone('runtime')) {
    // Cheap re-check, not a re-copy: read the folder ACL and the required files
    // back (one streamed scan, never a /T listing parsed out of a bounded
    // capture), then prove the copy still runs.
    const check = await (deps.verifyServiceCodeRoot ?? verifyServiceCodeRoot)({
      dir: runtimeDir(dataDir),
      serviceAccount: false,
      runFile,
      log,
      requireFiles: true,
    });
    if (check.ok) {
      const candidate = {
        dir: runtimeDir(dataDir),
        nodeExe: runtimeNodePath(dataDir),
        entry: path.join(runtimeDir(dataDir), 'app', 'src', 'cli', 'index.js'),
      };
      const proven = await (deps.verifyNativeModules ?? verifyNativeModules)({
        nodeExe: candidate.nodeExe,
        appDir: path.join(candidate.dir, 'app'),
      });
      if (proven.ok) {
        runtime = candidate;
        native = proven;
        log('Install progress: the runtime copy is present and verified; not copying it again.');
      } else {
        log(`Install progress: the recorded runtime copy cannot run (${`${proven.reason ?? ''}`.split('\n')[0]}); `
          + 'copying it again.');
      }
    } else {
      log(`Install progress: the recorded runtime copy does not verify (${check.reason}); copying it again.`);
    }
  }

  if (!runtime) {
    const released = await stopForReplacement();
    if (!released.ok) {
      return fail('runtime', `the service could not be stopped before its runtime was replaced: ${released.reason}\n`
        + 'Stop it with ezz service stop (or restart Windows), then run ezz service install again.');
    }
    const prepared = await (deps.prepareProtectedDir ?? prepareProtectedDir)({
      dir: runtimeDir(dataDir),
      sid: operator?.sid ?? null,
      serviceAccount: false,
      fresh: true,
      runFile,
      log,
      mode: 'install',
    });
    if (!prepared.ok) {
      return fail('runtime', `${prepared.reason}. Nothing was registered.\n`
        + `${prepared.next ?? 'Fix the cause above, then run ezz service install again.'}`);
    }

    log('Copying the runtime…');
    runtime = (deps.copyRuntime ?? copyRuntime)({ dataDir, appRoot, log });
    if (!runtime.ok) {
      return fail('runtime', `${runtime.reason}\n`
        + 'Free the file or folder above and run ezz service install again; it resumes from this step.');
    }

    log('Checking that native modules load with the copied node.exe…');
    native = await (deps.verifyNativeModules ?? verifyNativeModules)({
      nodeExe: runtime.nodeExe,
      appDir: path.join(runtime.dir, 'app'),
    });
    if (!native.ok) {
      return fail('runtime', `${native.reason}\n\n${native.fix ?? ''}\n`
        + 'Fix the cause above, then run ezz service install again; it resumes from this step.');
    }
    log(`  ok — Node ${native.version}, ABI ${native.abi}`);

    // The ONE verification of the runtime, and it runs AFTER the copy: the
    // folder was protected while empty, so every copied file must already
    // inherit, and the files the service actually executes must be readable.
    const verified = await (deps.verifyServiceCodeRoot ?? verifyServiceCodeRoot)({
      dir: runtime.dir,
      serviceAccount: false,
      runFile,
      log,
      requireFiles: true,
    });
    if (!verified.ok) {
      return fail('runtime', `the runtime copy could not be verified: ${verified.reason}\n`
        + 'Run ezz service install again in an Administrator PowerShell to copy and protect it again; '
        + 'if the same file keeps failing, run ezz service recover.');
    }
    tracker.done('runtime');
  }

  // ── Step bin: the wrapper, hash-verified, and its definition ────────────
  let binPrepared = false;
  if (tracker.isDone('bin') && fs.existsSync(winswPath()) && fs.existsSync(serviceXmlPath())) {
    const check = await (deps.verifyServiceCodeRoot ?? verifyServiceCodeRoot)({
      dir: binDir(),
      serviceAccount: false,
      runFile,
      log,
      requireFiles: true,
    });
    if (check.ok) {
      binPrepared = true;
      log('Install progress: the service wrapper folder is present and protected; keeping it.');
    } else {
      log(`Install progress: the wrapper folder does not verify (${check.reason}); installing it again.`);
    }
  }

  if (!binPrepared) {
    const released = await stopForReplacement();
    if (!released.ok) {
      return fail('bin', `the service could not be stopped before its wrapper was replaced: ${released.reason}\n`
        + 'Stop it with ezz service stop (or restart Windows), then run ezz service install again.');
    }
    const prepared = await (deps.prepareProtectedDir ?? prepareProtectedDir)({
      dir: binDir(),
      sid: operator?.sid ?? null,
      serviceAccount: false,
      fresh: true,
      runFile,
      log,
      mode: 'install',
    });
    if (!prepared.ok) {
      return fail('bin', `${prepared.reason}. Nothing was registered.\n`
        + `${prepared.next ?? 'Fix the cause above, then run ezz service install again.'}`);
    }
  }

  // WinSW is verified against its pinned hash on EVERY run: skipping the
  // download is a time saving, never a shortcut on trust.
  const winsw = await downloadWinsw({ dest: winswPath(), log, fetchImpl, verify: deps.verifyWinsw });
  if (!winsw.ok) {
    return fail('bin', `${winsw.reason}\n`
      + 'Check the network and the file above, then run ezz service install again; it resumes from this step.');
  }
  removeLegacyWinsw(log);

  // The service definition. No path argument to the wrapper: WinSW v2 ignores
  // it and reads `EasyDevOps.xml` beside `EasyDevOps.exe`.
  //
  // `nodeVersion` is the version of the COPIED node.exe, which the native-module
  // proof just reported. Without it the XML falls back to the loader flag
  // (`--experimental-loader`), because the copied binary is not the process that
  // wrote the file and cannot be asked cheaply here — and every daemon start
  // then prints ExperimentalWarning.
  const xml = buildServiceXml({
    nodeExe: runtime.nodeExe,
    entry: runtime.entry,
    dataDir,
    logDir: logDir(),
    workingDir: path.join(runtime.dir, 'app'),
    nodeVersion: native?.version ?? null,
  });

  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.writeFileSync(serviceXmlPath(), xml, 'utf8');
    log(`Wrote ${serviceXmlPath()}`);
  } catch (err) {
    return fail('bin', `could not write the service definition: ${err.message}\n`
      + 'Free the file above, then run ezz service install again in an Administrator PowerShell.');
  }

  if (!binPrepared) {
    // One verification of the wrapper folder, now that the wrapper and its
    // definition are in it.
    const verified = await (deps.verifyServiceCodeRoot ?? verifyServiceCodeRoot)({
      dir: binDir(),
      serviceAccount: false,
      runFile,
      log,
      requireFiles: true,
    });
    if (!verified.ok) {
      return fail('bin', `the service wrapper folder could not be verified: ${verified.reason}\n`
        + 'Run ezz service install again in an Administrator PowerShell; '
        + 'if the same file keeps failing, run ezz service recover.');
    }
  }
  tracker.done('bin');

  // ── Step register, so the virtual account exists ─────────────────────────
  //
  // The ACL grants have to come AFTER this: `NT SERVICE\EasyDevOps` does not
  // exist as a security principal until a service of that name is registered,
  // and icacls refuses an unknown account.
  let isRegisteredNow = tracker.isDone('register')
    ? (await isRegistered({ run, runFile })) === true
    : false;
  if (isRegisteredNow) {
    log('Install progress: the service is already registered; keeping the registration.');
  } else {
    log('Registering the service…');
    // Elevation is confirmed in the normal case, so no prompt appears. When it
    // could not be confirmed, say what a prompt would be before it shows up.
    if (elevated !== true) log(UAC_NOTE);
    const registration = await runFile(winswPath(), ['install'], { timeout: 120_000 });
    if (!registration.success) {
      const output = outputOf(registration);

      // WinSW can fail after the Service Control Manager accepted the name, so
      // a failed register is followed by a clean-up: nothing half-registered is
      // left for the next attempt to trip over.
      // SCM can report MISSING even after WinSW created and then lost part of a
      // registration. Force the delete on this failure path so a partial name is
      // not left to block the next install. Deleting a missing service is 1060,
      // which unregister treats as already clean.
      const cleanup = await unregister({ run, runFile, log, force: true });
      const leftover = cleanup.ok
        ? 'Nothing was left registered.'
        : `A partial registration could not be removed (${cleanup.reason}); `
          + `remove it with: sc.exe delete ${SERVICE_ID}`;

      return fail('register', `WinSW could not register the service:\n${output.slice(0, 600)}\n\n`
        + `Hint: ${WINSW_EXE_NAME} and ${WINSW_XML_NAME} must sit side by side in ${binDir()}; `
        + `fix the cause above and run ezz service install again in an Administrator PowerShell. ${leftover}`,
      { registrationFailed: true });
    }
    isRegisteredNow = true;
    registrationInPlace = true;
    tracker.done('register');
  }

  // ── Step grants: from the live Settings — never a hardcoded path ─────────
  const grants = requiredGrants({
    dataDir,
    nginxDir: config.nginxDir ?? null,
    sslDir: config.sslDir ?? null,
  });
  let acl = { applied: [], failed: [] };
  let grantedPaths = [];
  let grantsStillInPlace = false;
  if (tracker.isDone('grants')) {
    // One non-recursive icacls per granted directory: cheap, and it answers the
    // question the recorded list only used to guess at.
    const live = await liveGrantState({
      dataDir,
      nginxDir: config.nginxDir ?? null,
      sslDir: config.sslDir ?? null,
      runFile,
    });
    grantsStillInPlace = live.checked && live.missing.length === 0 && (live.errors ?? []).length === 0;
    log(grantsStillInPlace
      ? 'Install progress: the service-account grants are still in place; keeping them.'
      : 'Install progress: a service-account grant is missing; granting them again.');
  }

  if (grantsStillInPlace) {
    // Verified live, so the caller may record them as in place.
    grantedPaths = grants.map((grant) => grant.path);
  } else {
    log('Granting the service account access…');
    acl = await applyGrants({ grants, runFile, log });

    if (!acl.ok) {
      // Not fatal: the service is registered and the data directory grant is the
      // one that must work. A missing nginxDir grant degrades specific features
      // and is reported rather than rolled back, because rolling back a working
      // install over a directory that does not exist yet would be worse.
      for (const failure of acl.failed) {
        log(`  warning: ${failure.path} — ${failure.reason}`);
        log('  next: set the folder in Settings (or create it), then run ezz service repair.');
      }
    }
    // What is recorded must be what is TRUE, not what was attempted: a failed
    // grants step used to record `[]`, which made `status` report missing
    // permissions for directories that were fine.
    const live = await liveGrantState({
      dataDir,
      nginxDir: config.nginxDir ?? null,
      sslDir: config.sslDir ?? null,
      runFile,
    });
    grantedPaths = live.checked
      ? grants.map((grant) => grant.path)
        .filter((dir) => !live.missing.some((entry) => entry.path === dir))
      : [];
    tracker.done('grants');
  }

  // ── Step operator: start/stop without elevation, and the data directory ──
  //
  // Before the first start, so the service never runs from a runtime folder
  // that is not yet administrator-only. See operator.js.
  let operatorGrant;
  let operatorStillInPlace = false;
  if (tracker.isDone('operator') && operator?.sid) {
    // icacls prints the account name when Windows can resolve it and the SID
    // when it cannot, so both forms are asked about.
    const operatorTrustees = [`*${operator.sid}`, operator.name].filter(Boolean);
    const [sddl, access] = await Promise.all([
      readServiceSddl({ run, runFile }).catch(() => null),
      readPathAccess(dataDir, { runFile, trustees: operatorTrustees }).catch(() => null),
    ]);
    const control = sddl ? operatorAceState(sddl, operator.sid) : null;
    operatorStillInPlace = Boolean(control?.granted && !control?.excessive && access?.modify === true);
    log(operatorStillInPlace
      ? 'Install progress: your account already has start/stop and the data directory; keeping it.'
      : 'Install progress: your account\'s access is not in place; granting it again.');
  }

  if (operatorStillInPlace) {
    // Nothing to write, but the caller still records what is true.
    operatorGrant = {
      record: {
        sid: operator.sid,
        name: operator.name ?? null,
        serviceControl: true,
        dataDir: true,
        grantedAt: new Date().toISOString(),
      },
      protection: { ok: true, protected: [], failed: [] },
      notes: [],
    };
  } else {
    log('Allowing your account to start and stop the service without elevation…');
    operatorGrant = await (deps.grantOperator ?? grantOperator)({
      operator,
      dataDir,
      // The earlier passes ran with `serviceAccount: false`, because a service
      // account cannot be named before the service is registered (`icacls`
      // refuses an unknown account). So this step ADDS the virtual account's
      // read & execute ACE instead of re-protecting: `add-service-read` writes
      // one folder-only `/grant "NT SERVICE\EasyDevOps:(OI)(CI)RX"` per root,
      // which its files inherit, and reads the folder and the required files
      // back — the service can read its own files without a second /T scan of
      // an 11,000-file runtime.
      protectedDirs: [binDir(), runtimeDir(dataDir)],
      codeRootsProtected: 'add-service-read',
      run,
      runFile,
      log,
    });
    for (const note of operatorGrant.notes ?? []) log(`  note: ${note}`);

    if (operatorGrant.protection?.ok === false) {
      const detail = (operatorGrant.protection.failed ?? [])
        .map((failure) => `${failure.path}: ${failure.reason}`).join('; ');
      return fail('operator', `The service files could not be protected${detail ? ` (${detail})` : ''}. `
        + 'The service is registered but not started.\n'
        + 'Run ezz service recover from an Administrator PowerShell, then ezz service install again.',
      { registered: true, operator: operatorGrant.record });
    }
    tracker.done('operator');
  }

  // ── Step start ───────────────────────────────────────────────────────────
  let alreadyRunning = false;
  if (tracker.isDone('start')) {
    const state = await queryState({ run, runFile });
    if (state === 'RUNNING' || state === 'START_PENDING') {
      alreadyRunning = true;
      log('Install progress: the service is already running; not starting it again.');
    }
  }

  if (!alreadyRunning) {
    log('Starting the service…');
    const started = await runFile(winswPath(), ['start'], { timeout: 60_000 });
    if (!started.success) {
      const output = `${started.stdout ?? ''}\n${started.stderr ?? ''}`.trim();
      return fail('start', `the service was registered but would not start:\n${output.slice(0, 400)}\n\n`
        + `Run ezz service install again to resume (it does not repeat the passed steps). `
        + `Logs: ${errLogPath()} — more at ${TROUBLESHOOTING_URL}#logs`,
      {
        registered: true,
        // Registration and the grants did succeed, and the caller records them:
        // status must not report a registered service as "not installed".
        granted: grantedPaths,
        aclFailures: acl.failed,
        operator: operatorGrant.record,
        runtime: { nodeExe: runtime.nodeExe, entry: runtime.entry, version: native.version, abi: native.abi },
      });
    }
    tracker.done('start');
  }

  // A completed install needs no resume record. Removing it is safe: it is
  // Easy DevOps's own scratch file and holds no user data.
  clearInstallProgress(dataDir);

  return {
    ok: true,
    granted: grantedPaths,
    aclFailures: acl.failed,
    operator: operatorGrant.record,
    operatorNotes: operatorGrant.notes ?? [],
    runtime: { nodeExe: runtime.nodeExe, entry: runtime.entry, version: native.version, abi: native.abi },
  };
}

/**
 * Stops, unregisters and cleans up.
 *
 * The ACL grants are revoked but the DATA is never touched here: whether the
 * data moves back to `%APPDATA%` is a separate, explicit question asked by the
 * uninstall flow (decision 5), because the ProgramData directory holds the
 * live data and silently relocating it would be a surprise.
 */
export async function uninstall({
  dataDir,
  config = {},
  operator = null,
  keepOperatorDataAccess = false,
  log = () => {},
  run = shellRun,
  runFile = shellRunFile,
  stageTimeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
} = {}) {
  if (!isWindows) return { ok: false, reason: 'Server mode is Windows-only' };

  if ((await isElevated({ run })) === false) {
    return {
      ok: false,
      needsElevation: true,
      reason: 'Removing the Windows service needs an Administrator terminal.\n\n'
        + '  Right-click PowerShell → "Run as administrator", then: ezz service uninstall',
    };
  }
  let canWrite;
  try {
    canWrite = await runUninstallStage({
      stage: 'Checking ProgramData access',
      timeoutMs: stageTimeoutMs,
      log,
      action: () => canWriteProgramData(),
    });
  } catch (error) {
    return {
      ok: false,
      stage: error.stage ?? 'Checking ProgramData access',
      reason: `could not verify ProgramData write access: ${error.message}`,
    };
  }
  if (!canWrite) {
    return {
      ok: false,
      needsElevation: true,
      reason: 'Removing the Windows service needs write access to ProgramData.\n\n'
        + '  Run this from an Administrator PowerShell: ezz service uninstall',
    };
  }

  const notes = [];
  let removed = { ok: true, removed: false };
  let registrationRemoved = false;
  let operatorDataLocked = false;
  let operatorControlSddl = null;

  const restoreOperatorAccess = async ({ includeServiceControl }) => {
    const failures = [];
    if (includeServiceControl && operatorControlSddl && operator?.sid) {
      try {
        const restored = await restoreServiceControl({
          sid: operator.sid,
          sddl: operatorControlSddl,
          run,
          runFile,
        });
        if (restored.ok) operatorControlSddl = null;
        else failures.push(`could not restore the installer's service-control permission: ${restored.reason}`);
      } catch (error) {
        failures.push(`could not restore the installer's service-control permission: ${error.message}`);
      }
    }
    if (operatorDataLocked && operator?.sid) {
      try {
        const restored = await runUninstallStage({
          stage: 'Restoring installing-account access',
          timeoutMs: stageTimeoutMs,
          log,
          action: ({ deadline, signal, timeoutMs }) => restoreOperatorDataAccess({
            operator,
            dataDir,
            runFile,
            log,
            deadline,
            signal,
            timeoutMs,
          }),
        });
        if (restored.ok) operatorDataLocked = false;
        else failures.push(`could not restore the installer's data-directory access: ${restored.reason}`);
      } catch (error) {
        failures.push(`could not restore the installer's data-directory access: ${error.message}`);
      }
    }
    return failures;
  };

  try {
    const registered = await isRegistered({ run, runFile });
    if (registered === null) {
      return {
        ok: false,
        reason: `could not determine whether ${SERVICE_ID} is registered. Nothing was removed.`,
      };
    }

    if (registered) {
      const stopped = await runUninstallStage({
        stage: 'Stopping the Easy DevOps service',
        timeoutMs: stageTimeoutMs,
        log,
        action: async ({ deadline }) => stop({
          run,
          runFile,
          stopWaitMs: Math.min(
            30_000,
            remainingStageMs(
              deadline,
              'Stopping the Easy DevOps service',
              stageTimeoutMs,
            ),
          ),
        }),
      });
      if (!stopped.ok) {
        return {
          ok: false,
          needsElevation: stopped.needsElevation ?? false,
          reason: `the service could not be stopped before uninstall: ${stopped.reason}`,
        };
      }
    } else {
      notes.push('no service was registered, so there was nothing to stop or unregister');
    }

    if (operator?.sid) {
      // Retry-safe: this runs even when a previous attempt already removed the
      // registration. Otherwise an interrupted uninstall would silently leave
      // stale installer and service-account grants behind.
      operatorDataLocked = true;
      await runUninstallStage({
        stage: 'Locking installing-account access',
        timeoutMs: stageTimeoutMs,
        log,
        action: async ({ deadline, signal, timeoutMs }) => {
          if (registered) {
            const control = await revokeServiceControl({
              sid: operator.sid,
              run,
              runFile,
            });
            if (!control.ok) {
              throw new Error(`could not remove the installer's service-control permission: ${control.reason}`);
            }
            if (control.changed) operatorControlSddl = control.previousSddl;
          }
          const data = await revokeOperator({
            operator,
            dataDir,
            runFile,
            log,
            deadline,
            signal,
            timeoutMs,
          });
          if (!data.ok) {
            throw new Error(`could not remove the installer's data-directory permission: ${data.reason}`);
          }
        },
      });
    }

    // Revoke while the service account still resolves when it is registered.
    // When a prior attempt already removed the registration, still try: stale
    // grants must never be silently carried into either the retained data or
    // its backup.
    const serviceSid = await serviceAccountSid({ run, runFile });
    const revoked = await runUninstallStage({
      stage: 'Removing service-account permissions',
      timeoutMs: stageTimeoutMs,
      log,
      action: ({ deadline, signal, timeoutMs }) => revokeGrants({
        paths: [dataDir, config.nginxDir, config.sslDir].filter(Boolean),
        ...(serviceSid ? { trustee: `*${serviceSid}` } : {}),
        runFile,
        log,
        deadline,
        signal,
        timeoutMs,
      }),
    });
    if (!revoked.ok) {
      const detail = revoked.failed
        .map((failure) => `${failure.path}: ${failure.reason}`)
        .join('; ');
      throw new Error(`could not clear every service-account grant: ${detail}`);
    }

    if (registered) {
      removed = await runUninstallStage({
        stage: 'Removing the Easy DevOps service registration',
        timeoutMs: stageTimeoutMs,
        log,
        action: async ({ deadline }) => unregister({
          run,
          runFile,
          log,
          skipStop: true,
          deleteWaitMs: Math.min(
            60_000,
            remainingStageMs(
              deadline,
              'Removing the Easy DevOps service registration',
              stageTimeoutMs,
            ),
          ),
        }),
      });
      if (!removed.ok) {
        throw new Error(`the service could not be unregistered:\n${removed.reason}`);
      }
      registrationRemoved = true;
    }

    if (removed.reason) notes.push(removed.reason);
    if (removed.removed) log('Service unregistered.');

    await runUninstallStage({
      stage: 'Removing obsolete service files',
      timeoutMs: stageTimeoutMs,
      log,
      action: ({ deadline, signal, timeoutMs }) => removeObsoleteServiceFiles({
        dataDir,
        deadline,
        signal,
        log,
        timeoutMs,
      }),
    });

    // Start/stop authority was part of the service DACL and disappeared with
    // the registration. Keep the data grant only when the user chose to keep
    // the data at its Server-mode location.
    if (keepOperatorDataAccess && operator?.sid) {
      const restored = await runUninstallStage({
        stage: 'Restoring installing-account access',
        timeoutMs: stageTimeoutMs,
        log,
        action: ({ deadline, signal, timeoutMs }) => restoreOperatorDataAccess({
          operator,
          dataDir,
          runFile,
          log,
          deadline,
          signal,
          timeoutMs,
        }),
      });
      if (!restored.ok) {
        throw new Error(`the service was removed, but the installer's data access was not restored: ${restored.reason}`);
      }
      operatorDataLocked = false;
    }
  } catch (error) {
    const restoreFailures = await restoreOperatorAccess({
      includeServiceControl: !registrationRemoved,
    });
    return {
      ok: false,
      stage: error?.stage ?? null,
      reason: `${error?.message ?? String(error)}`
        + (restoreFailures.length ? `\n${restoreFailures.join('\n')}` : ''),
      notes,
    };
  }

  return { ok: true, notes };
}

/**
 * `sc.exe stop`, then `sc.exe start`.
 *
 * Not `winsw restart`: the Service Control Manager's own verbs are what the
 * installing user is allowed to call without elevation (operator.js), and
 * "Access is denied" from them is the authoritative answer when they are not.
 * Nothing is pre-checked here, so an allowed user is never told to elevate.
 */
export async function restart({
  run = shellRun,
  runFile = shellRunFile,
  stopWaitMs = 30_000,
} = {}) {
  const stopped = await stop({ run, runFile, stopWaitMs });
  if (!stopped.ok) {
    return stopped.needsElevation
      ? { ok: false, needsElevation: true, reason: elevationFor('Restarting') }
      : { ok: false, reason: stopped.reason };
  }
  const started = await start({ run, runFile });
  if (!started.ok) {
    return started.needsElevation
      ? { ok: false, needsElevation: true, reason: elevationFor('Restarting') }
      : { ok: false, reason: started.reason };
  }
  return { ok: true };
}

/**
 * The Service Control Manager's state for SERVICE_ID: 'RUNNING', 'STOPPED',
 * 'START_PENDING'…, 'MISSING' (1060) or null when `sc.exe` gave no answer.
 */
export async function queryStateInfo({
  run = shellRun,
  runFile = shellRunFile,
} = {}) {
  const sc = scExecutor({ run, runFile });
  let result;
  try {
    result = await sc(['query', SERVICE_ID], { timeout: 20_000 });
  } catch (error) {
    return {
      state: null,
      error: error?.message ?? String(error),
    };
  }
  const output = outputOf(result);
  const match = output.match(/STATE\s*:\s*\d+\s+(\w+)/i);
  if (match) return { state: match[1].toUpperCase(), error: null };
  if (/1060|does not exist/i.test(output)) return { state: 'MISSING', error: null };
  return {
    state: null,
    error: output || `${WINDOWS_SC} query ${SERVICE_ID} returned no usable state`,
  };
}

/** Backward-compatible state-only form used by lifecycle commands. */
export async function queryState(options = {}) {
  return (await queryStateInfo(options)).state;
}

/**
 * Polls until the service reaches `wanted`, or the time runs out.
 *
 * Needed after a stop: `sc.exe stop` returns while the service is still
 * STOP_PENDING, and node.exe stays locked until its process has exited — a
 * copy over it in that window fails with EBUSY, which is how 1.4.0's repair
 * failed. STOPPED is reported only once the wrapper's child is gone.
 */
export async function waitForState({
  wanted,
  run = shellRun,
  runFile = shellRunFile,
  timeoutMs = 30_000,
  intervalMs = 500,
} = {}) {
  // `setTimeout(…, Infinity)` warns and then fires at once, so an unusable
  // budget must become a real one rather than "no limit".
  const waitMs = finiteMs(timeoutMs, 30_000);
  const pollMs = finiteMs(intervalMs, 500);
  const deadline = Date.now() + waitMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await queryState({ run, runFile });
    if (state === wanted || (wanted === 'STOPPED' && state === 'MISSING')) return { reached: true, state };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { reached: false, state };
}

/**
 * The message for an operation that needs elevation it does not have.
 *
 * Stopping and starting a Windows service require SERVICE_STOP / SERVICE_START
 * rights, which an ordinary user does not have for a service they installed
 * elevated. So this says so plainly rather than letting `sc` return
 * "Access is denied" with no explanation.
 */
function elevationFor(action) {
  // "Stopping" → `ezz service stop`. It used to print `ezz service stopping`.
  const verb = { Stopping: 'stop', Starting: 'start', Restarting: 'restart' }[action] ?? action.toLowerCase();
  return `${action} the Windows service was refused for this account.\n\n`
    + '  Run it from PowerShell opened with "Run as administrator":\n'
    + `    ezz service ${verb}\n\n`
    + '  To let your account start, stop and restart it without elevation, run\n'
    + '  `ezz service repair` once as administrator. No password is needed — only elevation.';
}

/**
 * `sc stop` — temporary. The service stays registered and set to Automatic, so
 * it starts again at the next boot. `ezz service uninstall` is the permanent
 * removal.
 */
export async function stop({
  run = shellRun,
  runFile = shellRunFile,
  stopWaitMs = 30_000,
} = {}) {
  const sc = scExecutor({ run, runFile });
  const waitMs = finiteMs(stopWaitMs, 30_000);
  // Windows is asked, not the files: a registration whose wrapper is gone can
  // still be stopped, and files without a registration cannot.
  if ((await isRegistered({ run, runFile })) === false) {
    return { ok: false, reason: 'the service is not installed, so there is nothing to stop' };
  }

  // `sc.exe stop` rather than `winsw stop`: it is the Service Control
  // Manager's own verb, so it works even when the WinSW wrapper binary is
  // missing or broken, and its "Access is denied" is the authoritative answer
  // on elevation.
  const result = await sc(['stop', SERVICE_ID], { timeout: 60_000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  if (/Access is denied/i.test(output)) {
    return { ok: false, needsElevation: true, reason: elevationFor('Stopping') };
  }
  // 1062: the service has not been started. Already stopped is a success.
  if (/1062|has not been started/i.test(output)) {
    return { ok: true, alreadyStopped: true };
  }
  if (!result.success) {
    return { ok: false, reason: output.trim().slice(0, 400) || `${WINDOWS_SC} stop ${SERVICE_ID} failed` };
  }

  // Accepted is not stopped. Callers replace files the process holds open
  // (repair, update, runtime update), so this returns only once it is gone.
  const settled = await waitForState({
    wanted: 'STOPPED',
    run,
    runFile,
    timeoutMs: waitMs,
  });
  if (!settled.reached) {
    return {
      ok: false,
      reason: `the stop was accepted but the service was still ${settled.state ?? 'not reporting'} after `
        + `${Math.round(waitMs / 1000)}s. Check the wrapper log: ${wrapperLogPath()}`,
    };
  }
  return { ok: true };
}

/**
 * The exact commands to run the same recovery as LocalSystem. Printed, never
 * run: this process cannot become SYSTEM, and pretending to would hide the one
 * step that still needs the operator.
 */
function recoveryAsSystem({ dataDir, roots }) {
  const lines = [
    'If even this elevated Administrator cannot take ownership, run these exact',
    'commands as LocalSystem (for example `psexec -s -i powershell`, or a',
    'one-shot scheduled task running as SYSTEM):',
    '',
    `  icacls "${dataDir}" /grant *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /L /Q`,
  ];
  for (const dir of roots) {
    lines.push(`  icacls "${path.win32.join(dir, '*')}" /setowner *S-1-5-32-544 /T /C /L /Q`);
    lines.push(`  icacls "${path.win32.join(dir, '*')}" /reset /T /C /L /Q`);
    lines.push(`  icacls "${dir}" /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F `
      + `*S-1-5-32-545:(OI)(CI)RX "NT SERVICE\\EasyDevOps:(OI)(CI)RX" /L /Q`);
    lines.push(`  icacls "${dir}" /inheritance:r /L /Q`);
    lines.push(`  icacls "${path.win32.join(dir, '*')}" /reset /T /C /L /Q`);
  }
  lines.push(`  sc.exe start ${SERVICE_ID}`);
  return lines.join('\n');
}

/**
 * Protects one executable root by calling the ONE routine install and repair
 * use — `protectCodeRoot` in operator.js.
 *
 * It used to be a local sequence of its own: reset the files, take ownership,
 * grant, remove inheritance, remove stray ACEs, reset the files AGAIN, verify.
 * Four to five whole-tree icacls passes per root, every recovery, even on a
 * healthy server (cause C2), and no saved ACL to put back when a step failed
 * (cause C3), which is why recover could only say "the permissions were not
 * changed back". Now the routine saves the tree, does at most one child reset,
 * restores the saved ACL on any failure, and on a healthy tree does one scan
 * and no reset at all — so `ezz service recover` is safe to run anywhere.
 *
 * @returns {Promise<{ ok: boolean, reason?: string, restored?: boolean, next?: string|null }>}
 */
async function recoverCodeRoot({ dir, serviceAccount, runFile, log }) {
  return protectCodeRoot(dir, { serviceAccount, runFile, log, mode: 'recover' });
}

/**
 * `ezz service recover`, Windows. The escalation path: the same protection
 * routine install and repair use, applied to every executable root that exists,
 * with direct icacls/sc argv and a read-back at every step. It never resets or
 * recurses on the data root: only an additive grant there, so no user data is
 * ever touched.
 *
 * Safe on a healthy server: on a healthy tree the routine does one scan and no
 * reset, so `recover` is a cheap check there rather than four whole-tree
 * rewrites, which is what it used to be.
 *
 * @returns {Promise<{ ok: boolean, needsElevation?: boolean, reason?: string,
 *                     restored?: boolean, next?: string|null }>}
 */
export async function recoverCodePermissions({
  run = shellRun,
  runFile = shellRunFile,
  log = () => {},
  operator = undefined,
  dataDir = programDataDir(),
} = {}) {
  if (!isWindows) return { ok: false, reason: 'Recovering the Windows service is Windows-only.' };
  if (await isElevated({ run }) !== true) {
    return {
      ok: false,
      needsElevation: true,
      reason: 'Recovering the Windows service needs an Administrator PowerShell.\n\n'
        + '  Right-click PowerShell → "Run as administrator", then:\n'
        + '    ezz service recover',
    };
  }

  const icacls = systemTool('icacls.exe');
  const roots = [binDir(), runtimeDir(dataDir), path.join(dataDir, 'runtime.prev')]
    .filter((dir) => fs.existsSync(dir));
  if (roots.length === 0) {
    return { ok: false, reason: `there is no Windows Server installation to recover at ${dataDir}` };
  }
  const registered = await isRegistered({ run, runFile });
  const help = () => recoveryAsSystem({ dataDir, roots });

  // 1. The data directory itself: additive and non-recursive, so no data file
  //    is ever touched. Never /reset, never /T here.
  log(`  ${dataDir}: restoring SYSTEM and Administrators full control (additive, not recursive)`);
  const rootGrant = await runFile(icacls, [
    dataDir, '/grant', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/L', '/Q',
  ], { timeout: 120_000 });
  if (!rootGrant.success) {
    return {
      ok: false,
      reason: `${dataDir}: could not restore SYSTEM and Administrators access: `
        + `${outputOf(rootGrant).slice(0, 300)}\n\n` + help(),
    };
  }

  // 2. Each executable root, through the one protection routine. A failure has
  //    already put the previous ACL back, so the message says so (like install)
  //    and names the next step, instead of the old "the permissions were not
  //    changed back automatically" — which was true then and is not now.
  for (const dir of roots) {
    const recovered = await recoverCodeRoot({
      dir,
      serviceAccount: registered !== false,
      runFile,
      log,
    });
    if (!recovered.ok) {
      // protectCodeRoot's reason already says which step failed, whether the
      // previous permissions came back, and what to run next; the SYSTEM
      // commands below are recover's own last resort.
      const reason = String(recovered.reason ?? `${dir}: the permissions could not be established`);
      const lines = [reason];
      if (recovered.next && !reason.includes(recovered.next)) lines.push(recovered.next);
      lines.push('', help());
      return {
        ok: false,
        restored: recovered.restored === true,
        next: recovered.next ?? null,
        reason: lines.join('\n'),
      };
    }
    const verified = registered !== false
      ? 'SYSTEM, Administrators and the service account'
      : 'SYSTEM and Administrators';
    log(`  ${dir}: ${verified} verified`
      + `${recovered.resetChildren ? ' (the files were reset onto the folder permissions)' : ''}`
      + `${recovered.count ? `, ${recovered.count} entries scanned` : ''}`);
  }

  // 3. The service security descriptor: the Windows defaults plus the
  //    installing account's additive start/stop grant, verified.
  log(`  ${SERVICE_ID}: checking the service security descriptor`);
  const who = operator === undefined ? await resolveOperator({ run }) : operator;
  const descriptor = who?.sid
    ? await grantServiceControl({ sid: who.sid, run, runFile })
    : await ensureServiceDefaults({ run, runFile });
  if (!descriptor.ok) {
    return {
      ok: false,
      next: 'Run ezz service recover again from an Administrator PowerShell once the service is registered.',
      reason: `the ${SERVICE_ID} service descriptor could not be restored: ${descriptor.reason}\n\n${help()}`,
    };
  }
  log(who?.sid
    ? `  ${SERVICE_ID}: SYSTEM and Administrators full control verified; ${who.name ?? who.sid} may start and stop it`
    : `  ${SERVICE_ID}: SYSTEM and Administrators full control verified`);

  return { ok: true, restored: false, next: null };
}

/** `sc.exe start`. */
export async function start({
  run = shellRun,
  runFile = shellRunFile,
} = {}) {
  const sc = scExecutor({ run, runFile });
  if ((await isRegistered({ run, runFile })) === false) {
    return { ok: false, reason: 'the service is not installed; run `ezz service install` first' };
  }

  const result = await sc(['start', SERVICE_ID], { timeout: 60_000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  if (result.success) return { ok: true };

  // StartService FAILED 5 is the Service Control Manager reporting that it
  // opened the service and then could not launch its PROGRAM: on the two real
  // servers this was an unreadable (empty-DACL) EasyDevOps.exe, not a refusal
  // against this account. OpenService FAILED 5 is the real refusal.
  if (/StartService FAILED\s+5\b/i.test(output)
      || /StartService.*access is denied/i.test(output)) {
    return {
      ok: false,
      reason: 'The service program cannot be read (file permissions), so Windows could not start it.\n\n'
        + '  Run this from PowerShell opened with "Run as administrator":\n'
        + '    ezz service recover',
    };
  }
  if (/OpenService FAILED\s+5\b/i.test(output)) {
    return { ok: false, needsElevation: true, reason: elevationFor('Starting') };
  }
  if (/Access is denied/i.test(output)) {
    return { ok: false, needsElevation: true, reason: elevationFor('Starting') };
  }
  // 1056: an instance is already running.
  if (/1056|already running/i.test(output)) {
    return { ok: true, alreadyRunning: true };
  }

  return { ok: false, reason: output.trim().slice(0, 400) || `${WINDOWS_SC} start ${SERVICE_ID} failed` };
}

/**
 * Counts recent restarts in WinSW's wrapper log.
 *
 * This is how a crash loop is detected on Windows. `sc query` reports the
 * service as RUNNING between restarts, so a daemon that dies every five
 * seconds looks healthy to anything that only asks the Service Control
 * Manager. WinSW logs each start, and counting those within a window is what
 * actually reveals it.
 *
 * ── What counts ────────────────────────────────────────────────────────────
 *
 * Only a real process start: WinSW's "Started process <pid>", which the
 * service-mode instance writes when it launches the daemon. 1.4.0 counted
 * every line containing "Starting", and every CLI call of the wrapper writes
 * "Starting WinSW in console mode" — so `install`, `start` and `restart`
 * alone produced a "crash loop" on a perfectly healthy service.
 *
 * And a start is a CRASH restart only when the process before it did not stop
 * cleanly. A service stop, restart, update or repair logs "Stopping …" and
 * "Process <pid> canceled with code 0" first; a daemon that died on its own
 * does not. So a stop followed by a start is a restart, not a crash.
 *
 * @param {Object} [opts]
 * @param {number} [opts.windowMs] How far back to look (default 10 minutes)
 * @param {string} [opts.text]     The log text, for tests (default: the wrapper log)
 * @returns {{ restarts: number, cleanRestarts: number, crashRestarts: number,
 *             crashLooping: boolean, since: Date|null }}
 */
export function countRecentRestarts({
  windowMs = 10 * 60_000,
  now = Date.now(),
  text = null,
  file = null,
  fsApi = fs,
} = {}) {
  const none = { restarts: 0, cleanRestarts: 0, crashRestarts: 0, crashLooping: false, since: null };

  if (text === null) {
    try {
      const tail = readBoundedTailSync(file ?? wrapperLogPath(), { fsApi });
      text = completeLogLines(tail, 4000).join('\n');
    } catch {
      return none;
    }
  }

  // WinSW writes lines like:
  //   2026-11-14 04:17:03,123 INFO  - Started process 12700
  // Only the tail is examined: a months-old log is large and its early history
  // says nothing about whether the service is looping right now.
  const lines = text.split(/\r?\n/).slice(-4000);
  const cutoff = now - windowMs;

  const CLEAN_STOP = /\bStopping\b|canceled with code 0\b|finished with (code )?0\b|exited with code 0\b/i;
  const STARTED = /\bStarted process\s+\d+/i;

  let sawProcess = false;   // a daemon process was started earlier in the log
  let cleanSince = false;   // ...and it was stopped cleanly since then
  let restarts = 0;
  let cleanRestarts = 0;
  let crashRestarts = 0;
  let earliestCrash = null;

  for (const line of lines) {
    if (CLEAN_STOP.test(line)) {
      cleanSince = true;
      continue;
    }
    if (!STARTED.test(line)) continue;

    const stamp = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    const at = stamp ? Date.parse(`${stamp[1]}T${stamp[2]}`) : NaN;
    const inWindow = Number.isFinite(at) && at >= cutoff;

    // The first process in the log is a start, not a restart.
    if (sawProcess && inWindow) {
      restarts++;
      if (cleanSince) {
        cleanRestarts++;
      } else {
        crashRestarts++;
        if (earliestCrash === null || at < earliestCrash) earliestCrash = at;
      }
    }

    sawProcess = true;
    cleanSince = false;
  }

  // Three unclean restarts in ten minutes is not normal operation: WinSW's
  // backoff is 5 s, 20 s, then a minute, so that is a daemon dying on its own.
  // Deliberate restarts never count towards it.
  return {
    restarts,
    cleanRestarts,
    crashRestarts,
    crashLooping: crashRestarts >= 3,
    since: earliestCrash ? new Date(earliestCrash) : null,
  };
}

/**
 * The service account must keep read & execute on bin and runtime: it runs its
 * own binary from there. This reads the folders back when a real icacls channel
 * is available (a string run stub has none) and warns when that is missing.
 */
async function codeRootAccessWarnings({ dataDir, run, runFile, fsImpl }) {
  if (run !== shellRun && runFile === shellRunFile) return [];
  const warnings = [];
  for (const dir of [path.join(dataDir, 'bin'), runtimeDir(dataDir)]) {
    if (!inspectPath(fsImpl, dir).exists) continue;
    let result;
    try {
      result = await runFile(systemTool('icacls.exe'), [dir], { timeout: 60_000 });
    } catch (error) {
      warnings.push(`Could not read the permissions of ${dir}: ${error?.message ?? error}`);
      continue;
    }
    if (!result?.success) {
      warnings.push(`Could not read the permissions of ${dir}: ${outputOf(result).slice(0, 200)}`);
      continue;
    }
    const entries = parseIcaclsListing(result.stdout);
    const folder = entries.find((entry) => path.resolve(entry.path) === path.resolve(dir)) ?? entries[0];
    if (!folder || !aclEntryAllowsReadExecute(folder, [SERVICE_ACCOUNT])) {
      warnings.push(`The service account cannot read ${dir}. Run \`ezz service recover\` `
        + 'from an Administrator PowerShell.');
    }
  }
  return warnings;
}

/**
 * What the service account can ACTUALLY do with each directory it needs, read
 * from the live permissions.
 *
 * This replaces the old comparison of the install record against the live
 * Settings (cause C6). On the real server the record said `granted: []` because
 * the install had failed, so `status` reported "the service has no access to
 * C:\ProgramData\easy-devops, C:\nginx, C:\easy-devops\ssl" while every one of
 * those ACLs was correct — and told the user to run the repair that hit the same
 * bug. The filesystem is the only authority here.
 *
 * One `icacls <path>` per granted directory (no `/T`, no recursion), all in
 * parallel: three spawns, not three tree walks.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {string} [opts.nginxDir] From Settings — never a default
 * @param {string} [opts.sslDir]   From Settings — never a default
 * @param {Function} [opts.runFile]
 * @param {string} [opts.serviceSid] Already-known SID of the service account,
 *                                   for a machine that prints SIDs, not names
 * @returns {Promise<{ checked: boolean, missing: Array<{ path: string, need: 'modify'|'read' }>,
 *                     errors: Array<{ path: string, error: string }> }>}
 */
export async function liveGrantState({
  dataDir,
  nginxDir = null,
  sslDir = null,
  runFile = shellRunFile,
  serviceSid = null,
} = {}) {
  const required = requiredGrants({ dataDir, nginxDir, sslDir });
  // acl.js compares trustees by name, upper-cased and without its leading `*`.
  // The SID form is passed too when it is already known: a localized Windows
  // can print `*S-1-5-80-…` where it cannot resolve the account name.
  const trustees = [SERVICE_ACCOUNT];
  if (typeof serviceSid === 'string' && /^S-1-5-80-\d+-\d+-\d+-\d+-\d+$/.test(serviceSid)) {
    trustees.push(`*${serviceSid}`);
  }

  const readings = await Promise.all(required.map(async (grant) => {
    try {
      return { grant, access: await readPathAccess(grant.path, { runFile, trustees }) };
    } catch (error) {
      return { grant, error };
    }
  }));

  const missing = [];
  const errors = [];
  for (const { grant, access, error } of readings) {
    if (error) {
      errors.push({ path: grant.path, error: error?.message ?? String(error) });
      continue;
    }
    if (!access || access.ok === false) {
      errors.push({ path: grant.path, error: access?.error ?? 'the permissions could not be read' });
      continue;
    }
    // A directory that does not exist needs no grant: Settings may name one that
    // has not been created yet, and that is not an access failure.
    if (access.exists === false) continue;
    const need = grant.access === ACCESS.MODIFY ? 'modify' : 'read';
    const granted = need === 'modify'
      ? access.modify === true
      : (access.readable === true || access.full === true);
    if (!granted) missing.push({ path: grant.path, need });
  }

  return { checked: true, missing, errors };
}

/**
 * The service's state.
 *
 * Two halves, kept apart as before: this reads the service manager (a few
 * spawns) and, when it can, the live permissions of the directories the service
 * needs (one non-recursive icacls each). The dashboard passes `cache: true` so
 * those come from core/probeCache.js and a refresh runs behind the answer; the
 * CLI leaves it false so a freshly typed `ezz service status` measures afresh.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.cache]  Serve the live ACL read from the probe cache
 * @returns {Promise<Object>}
 */
export async function status({
  dataDir,
  config = {},
  run = shellRun,
  runFile = shellRunFile,
  // Kept for callers that still pass the install record. The record is NOT used
  // for any decision: a failed install recorded `granted: []` and produced the
  // three false warnings on the real server.
  granted = [],
  operatorSid = null,
  // The service account's SID, when the caller already knows it: a localized
  // Windows can print SIDs where it cannot resolve `NT SERVICE\EasyDevOps`.
  serviceSid = null,
  cache = false,
  deps = {},
} = {}) {
  const fsImpl = deps.fs ?? fs;
  const wrapperFile = inspectPath(fsImpl, winswPath());
  const xmlFile = inspectPath(fsImpl, serviceXmlPath());
  const filesPresent = wrapperFile.exists && xmlFile.exists;
  const fileInspectionError = wrapperFile.error ?? xmlFile.error;
  const installProgress = readInstallProgress(dataDir);

  // Windows is the authority on whether the service exists — not the files.
  // 1.4.0 said "Installed: yes" from the files alone while `sc query` answered
  // 1060, and (through the Set-Content alias) could not read the state at all.
  const scQuery = await queryStateInfo({ run, runFile });
  const scState = scQuery.state;
  const registered = scState === 'MISSING' ? false : scState ? true : null;
  const scWarning = scQuery.error
    ? `Could not read the Windows service state: ${scQuery.error}`
    : null;

  if (registered === false || (registered === null && !filesPresent && !scQuery.error)) {
    return {
      installed: false,
      registered,
      filesPresent,
      running: false,
      enabledOnBoot: false,
      state: 'not installed',
      restarts: 0,
      cleanRestarts: 0,
      crashRestarts: 0,
      crashLooping: false,
      fileInspectionError,
      // An install that stopped part way through: the caller can say "install
      // not finished: run ezz service install to resume" instead of guessing.
      installProgress,
      warnings: fileInspectionError
        ? [`Could not inspect the service files in ${binDir()}: ${fileInspectionError}`]
        : [],
      winswPath: winswPath(),
      // Files left behind without a registration: a removed or never-finished
      // install. Said explicitly, because "not installed" alone is confusing
      // when the wrapper is sitting right there.
      mismatch: fileInspectionError
        ? `Could not inspect the service files in ${binDir()}: ${fileInspectionError}`
        : filesPresent && registered === false
          ? `${WINSW_EXE_NAME} and ${WINSW_XML_NAME} are in ${binDir()}, but Windows has no ${SERVICE_ID} service`
          : null,
    };
  }

  if (registered === null && !filesPresent && scQuery.error) {
    return {
      installed: null,
      registered: null,
      filesPresent: false,
      running: null,
      enabledOnBoot: null,
      state: 'unknown',
      restarts: 0,
      cleanRestarts: 0,
      crashRestarts: 0,
      crashLooping: false,
      fileInspectionError,
      installProgress,
      warnings: [
        scWarning,
        ...(fileInspectionError
          ? [`Could not inspect the service files in ${binDir()}: ${fileInspectionError}`]
          : []),
      ].filter(Boolean),
      winswPath: winswPath(),
      mismatch: fileInspectionError
        ? `Could not inspect the service files in ${binDir()}: ${fileInspectionError}`
        : null,
    };
  }

  // One icacls per granted directory, and never a real one from a stubbed
  // channel: a string `run` stub with the production `runFile` has no icacls
  // channel at all, so nothing is measured and nothing is guessed.
  const liveChannel = run === shellRun || runFile !== shellRunFile;
  const readLive = async () => {
    const read = () => liveGrantState({
      dataDir,
      nginxDir: config.nginxDir ?? null,
      sslDir: config.sslDir ?? null,
      runFile,
      serviceSid,
    });
    if (!cache) return read();
    const probed = await probe('service:acl-live', read, { ttlMs: 30_000 });
    return probed.value ?? null;
  };

  const sc = scExecutor({ run, runFile });
  const [config2, sddl, codeWarnings, live] = await Promise.all([
    sc(['qc', SERVICE_ID], { timeout: 20_000 }).catch((error) => ({
      success: false,
      stdout: '',
      stderr: error?.message ?? String(error),
      exitCode: null,
    })),
    operatorSid
      ? readServiceSddl({ run, runFile }).catch(() => null)
      : Promise.resolve(null),
    codeRootAccessWarnings({ dataDir, run, runFile, fsImpl }),
    liveChannel ? readLive() : Promise.resolve(null),
  ]);
  const startType = `${config2.stdout ?? ''}`.match(/START_TYPE\s*:\s*\d+\s+([\w_]+)/i)?.[1] ?? null;

  const loop = countRecentRestarts();

  // The live answer, shaped like the old recorded-grant comparison so existing
  // readers (`service.acl.ok`, `.missing`, `.reason`) keep working. `ok` is null
  // while nothing has been measured — never a guess in either direction.
  const acl = liveChannel
    ? (live === null
      ? {
        checked: false,
        pending: true,
        ok: null,
        missing: [],
        stale: [],
        errors: [],
        reason: null,
      }
      : (() => {
        const missing = live.missing ?? [];
        const errors = live.errors ?? [];
        const parts = [];
        if (missing.length) {
          parts.push(`the service account has no ${missing.map((entry) => entry.need).join('/')} `
            + `access to ${missing.map((entry) => entry.path).join(', ')} (read from the live permissions)`);
        }
        if (errors.length) {
          parts.push(errors.map((entry) => `could not read the permissions of ${entry.path}: ${entry.error}`).join('; '));
        }
        return {
          checked: true,
          pending: false,
          ok: missing.length === 0 && errors.length === 0,
          missing,
          stale: [],
          errors,
          reason: parts.length
            ? `${parts.join('; ')}. Run \`ezz service repair\` in an Administrator PowerShell to fix it.`
            : null,
        };
      })())
    : null;

  return {
    installed: true,
    registered,
    filesPresent,
    fileInspectionError,
    installProgress,
    warnings: [
      ...(scWarning ? [scWarning] : []),
      ...(fileInspectionError
        ? [`Could not inspect the service files in ${binDir()}: ${fileInspectionError}`]
        : []),
      ...codeWarnings,
      ...(acl?.reason ? [acl.reason] : []),
    ],
    // Registered, but the wrapper or its definition is missing: the service
    // cannot start. A reinstall puts them back.
    mismatch: fileInspectionError
      ? `Could not inspect the service files in ${binDir()}: ${fileInspectionError}`
      : registered && !filesPresent
        ? `Windows has a ${SERVICE_ID} service, but ${WINSW_EXE_NAME} or ${WINSW_XML_NAME} is missing from ${binDir()}`
        : null,
    running: scState === 'RUNNING',
    enabledOnBoot: startType ? /AUTO_START/i.test(startType) : null,
    state: scState ? scState.toLowerCase() : 'unknown',
    startType,
    restarts: loop.restarts,
    cleanRestarts: loop.cleanRestarts,
    crashRestarts: loop.crashRestarts,
    crashLooping: loop.crashLooping,
    crashLoopSince: loop.since,
    // The live permissions of the data directory, nginx directory and SSL
    // directory. null: no real icacls channel to measure with.
    acl,
    // Whether the recorded installing user may still start and stop it — read
    // from the service's DACL, not from the record. null: nobody recorded, or
    // the DACL could not be read.
    operatorControl: operatorSid && sddl ? operatorAceState(sddl, operatorSid) : null,
    winswPath: winswPath(),
    logs: { out: outLogPath(), err: errLogPath(), wrapper: wrapperLogPath() },
  };
}

/** Recent log lines, newest last. */
export function readLogs({
  lines = 50,
  which = 'out',
  file = null,
  fsApi = fs,
} = {}) {
  const selectedFile = file
    ?? (which === 'err' ? errLogPath() : which === 'wrapper' ? wrapperLogPath() : outLogPath());

  let tail;
  try {
    tail = readBoundedTailSync(selectedFile, { fsApi });
  } catch (err) {
    return {
      ok: false,
      file: selectedFile,
      output: err.code === 'ENOENT'
        ? `No log yet at ${selectedFile}. The service may not have started.`
        : `Could not read ${selectedFile}: ${err.message}`,
    };
  }

  return {
    ok: true,
    file: selectedFile,
    output: completeLogLines(tail, lines).join('\n'),
  };
}

/**
 * Re-applies what install set up, without unregistering the service.
 *
 * The two things that drift: the ACL grants, when a path changes in Settings,
 * and the runtime copy, when the application is upgraded under it. Both are
 * re-done; the service is then restarted so it picks them up.
 *
 * The order is the one that worked on the real server and is kept: stop, keep
 * the current copy aside as `runtime.prev`, protect the new folder while it is
 * empty, copy, prove the copy runs, verify it ONCE, then grants, then start.
 * Any failure after the stop puts the previous copy back and starts it again.
 */
export async function repair({
  dataDir,
  appRoot,
  config = {},
  operator = null,
  log = () => {},
  run = shellRun,
  runFile = shellRunFile,
  waitForStart = async () => ({ alive: true }),
  deps = {},
} = {}) {
  if (!(deps.isWindows ?? isWindows)) return { ok: false, reason: 'Server mode is Windows-only' };

  const elevated = await (deps.isElevated ?? (() => isElevated({ run })))();
  if (elevated !== true || !await (deps.canWrite ?? canWriteProgramData)()) {
    return { ok: false, needsElevation: true, reason: elevationMessage('ezz service repair') };
  }

  const fsImpl = deps.fs ?? fs;
  const registered = await isRegistered({ run, runFile });
  if (registered === false) {
    return { ok: false, reason: 'the service is not installed; run `ezz service install` instead' };
  }
  if (registered === null) {
    // The SCM is the authority. Files alone do not prove a service exists, and
    // an ACL error may hide an installed wrapper. Do not stop anything unless
    // at least one authority is affirmative.
    const wrapperFile = inspectPath(fsImpl, winswPath());
    if (wrapperFile.error) {
      return {
        ok: false,
        reason: `Could not determine whether the service is installed. The service manager query failed, and ${winswPath()} could not be inspected: ${wrapperFile.error}. Nothing was stopped or changed.\n`
          + `Run sc.exe query ${SERVICE_ID} in an Administrator PowerShell, then run ezz service repair again.`,
      };
    }
    if (!wrapperFile.exists) {
      return { ok: false, reason: 'the service is not installed; run `ezz service install` instead' };
    }
  }

  // ── The runtime copy cannot be replaced while the service runs ──────────
  //
  // Windows locks a running executable: 1.4.0 copied over runtime\node.exe
  // with the service up and failed with EBUSY. So: stop, keep the current
  // copy aside as `runtime.prev` (a rename — same volume, instant), copy,
  // verify, start, and wait for the daemon's own heartbeat. Any failure after
  // the stop puts the previous copy back and starts it again.
  const dir = runtimeDir(dataDir);
  const prev = `${dir}.prev`;

  log('Stopping the service so the runtime copy can be replaced…');
  const stopped = await stop({
    run,
    runFile,
    stopWaitMs: deps.stopWaitMs ?? 30_000,
  });
  if (!stopped.ok) {
    return { ok: false, reason: `the service could not be stopped first, so nothing was changed: ${stopped.reason}` };
  }

  const startAgain = async () => {
    const started = await start({ run, runFile });
    if (!started.ok) return { ok: false, reason: started.reason };
    const alive = await waitForStart();
    return alive.alive ? { ok: true } : { ok: false, reason: 'the daemon did not report in' };
  };

  let previousXml;
  try { previousXml = fs.readFileSync(serviceXmlPath()); } catch (error) {
    const back = await startAgain();
    return {
      ok: false,
      reason: `Could not read the service definition: ${error.message}. `
        + (back.ok ? 'The service was started again.' : `The service did not start again: ${back.reason}`)
        + '\nRun ezz service install to write a fresh service definition.',
      restarted: back.ok,
    };
  }

  // Verify and, when necessary, replace the wrapper only after the service has
  // stopped. Windows can deny a read while an executable is running, and a
  // replacement cannot rename over a live image.
  let wrapper;
  try {
    wrapper = await (deps.verifyWinsw ?? verifyWinsw)(winswPath());
  } catch (error) {
    const back = await startAgain();
    return {
      ok: false,
      reason: `could not verify the installed service wrapper: ${error.message}. `
        + (back.ok ? 'The service was started again.' : `The service did not start again: ${back.reason}`)
        + '\nRun ezz service install in an Administrator PowerShell to replace the wrapper.',
      restarted: back.ok,
    };
  }
  if (!wrapper.ok && wrapper.code) {
    const back = await startAgain();
    return {
      ok: false,
      reason: `${wrapper.reason}. The service wrapper was not replaced. `
        + (back.ok ? 'The service was started again.' : `The service did not start again: ${back.reason}`)
        + '\nDelete the file named above and run ezz service install in an Administrator PowerShell.',
      restarted: back.ok,
    };
  }
  if (!wrapper.ok) {
    log('The installed WinSW did not verify; re-downloading.');
    const again = await downloadWinsw({ dest: winswPath(), log, verify: deps.verifyWinsw });
    if (!again.ok) {
      const back = await startAgain();
      return {
        ok: false,
        reason: `${again.reason}. `
          + (back.ok ? 'The service was started again.' : `The service did not start again: ${back.reason}`)
          + '\nCheck the network, then run ezz service repair again.',
        restarted: back.ok,
      };
    }
  }

  const restorePrevious = async (why) => {
    log(`Restoring the previous runtime copy (${why})…`);
    // A new copy that started but never reported in still holds its files.
    await stop({ run, runFile, stopWaitMs: deps.stopWaitMs ?? 30_000 });
    let restored = false;
    try {
      if (fs.existsSync(prev)) {
        // Removing a code tree needs the ACL-aware path, never a plain
        // `rmSync`: a runtime left by 1.4.4-1.4.6 can have empty DACLs, and
        // Windows refuses to read (or delete) those files until ownership is
        // taken. Unreadable code is replaced, never a reason to give up.
        if (fs.existsSync(dir)) {
          const removed = await removeCodeTree({ dir, runFile, log });
          if (removed?.ok === false) throw new Error(removed.reason ?? `could not remove ${dir}`);
        }
        renameWithRetry(prev, dir);
        fs.writeFileSync(serviceXmlPath(), previousXml);
        restored = true;
      }
    } catch (err) {
      log(`  could not restore ${prev}: ${err.message}`);
    }
    const back = await startAgain();
    return {
      ok: false,
      reason: `${why}. `
        + (restored ? 'The previous runtime copy was restored' : 'The previous runtime copy could not be restored')
        + (back.ok ? ' and the service is running on it again.' : `, and the service did not start again: ${back.reason}.`)
        + '\nFix the cause above, then run ezz service repair again.'
        + `\nLogs: ${errLogPath()} — more at ${TROUBLESHOOTING_URL}#repair-while-running`,
      restored,
      restarted: back.ok,
    };
  };

  try {
    if (fs.existsSync(prev)) {
      // The previous attempt's copy, possibly with empty DACLs. Only this code
      // folder, never anything else: removeCodeTree refuses any other path.
      const discarded = await removeCodeTree({ dir: prev, runFile, log });
      if (discarded?.ok === false) throw new Error(discarded.reason ?? `could not remove ${prev}`);
    }
    if (fs.existsSync(dir)) renameWithRetry(dir, prev);
  } catch (err) {
    const back = await startAgain();
    return {
      ok: false,
      reason: `could not set the current runtime copy aside (${err.code ?? err.message}), so nothing was changed`
        + (back.ok ? '; the service is running again.' : `; the service did not start again: ${back.reason}`)
        + '\nClose any program holding the runtime folder open, then run ezz service repair again.',
    };
  }

  // The new folder is protected while it is still empty, before anything the
  // service will run is copied into it.
  const prepared = await (deps.prepareProtectedDir ?? prepareProtectedDir)({
    dir, sid: operator?.sid ?? null, runFile, log, mode: 'repair',
  });
  if (!prepared.ok) return restorePrevious(`the new runtime folder could not be protected: ${prepared.reason}`);

  log('Refreshing the runtime copy…');
  const runtime = (deps.copyRuntime ?? copyRuntime)({ dataDir, appRoot, log });
  if (!runtime.ok) return restorePrevious(`the new runtime copy failed: ${runtime.reason}`);

  const native = await (deps.verifyNativeModules ?? verifyNativeModules)({
    nodeExe: runtime.nodeExe,
    appDir: path.join(runtime.dir, 'app'),
  });
  if (!native.ok) {
    return restorePrevious(`the new runtime cannot load its native modules: ${`${native.reason} ${native.fix ?? ''}`.trim()}`);
  }

  // The ONE verification of the new copy, and it runs after the copy: the
  // folder was protected while it was still empty, so every copied file must
  // already inherit, and the files the service executes must be readable by it.
  // It reads the folder ACL, each required file on its own, then one streamed
  // scan — never a `/T` listing parsed out of a bounded capture, which is what
  // failed on the real server: the whole runtime was scanned, the capture kept
  // only its newest 64 KiB, and `runtime\node.exe` never appeared in it.
  const verifiedCopy = await (deps.verifyServiceCodeRoot ?? verifyServiceCodeRoot)({
    dir: runtime.dir,
    serviceAccount: true,
    runFile,
    log,
    requireFiles: true,
  });
  if (!verifiedCopy.ok) {
    return restorePrevious(`the new runtime copy could not be verified: ${verifiedCopy.reason}`);
  }

  log('Re-applying the service account grants…');
  const grants = requiredGrants({
    dataDir,
    nginxDir: config.nginxDir ?? null,
    sslDir: config.sslDir ?? null,
  });
  const acl = await applyGrants({ grants, runFile, log });
  if (!acl.ok) {
    for (const failure of acl.failed) {
      log(`  warning: ${failure.path} — ${failure.reason}`);
    }
  }

  // The runtime folder was protected while empty and verified after the copy;
  // this pass renews the installing user's rights and the service's own
  // start/stop, which cannot be granted before the account exists.
  log('Allowing your account to start and stop the service without elevation…');
  const operatorGrant = await (deps.grantOperator ?? grantOperator)({
    operator,
    dataDir,
    // The wrapper was verified above and the new runtime folder was protected
    // while empty and verified after the copy, so neither needs a second pass.
    protectedDirs: [binDir(), dir],
    codeRootsProtected: true,
    run,
    runFile,
    log,
  });
  for (const note of operatorGrant.notes ?? []) log(`  note: ${note}`);

  if (operatorGrant.protection?.ok === false) {
    const detail = (operatorGrant.protection.failed ?? [])
      .map((failure) => `${failure.path}: ${failure.reason}`).join('; ');
    return restorePrevious(`the new runtime permissions could not be secured${detail ? ` (${detail})` : ''}`);
  }
  try { refreshServiceDefinition({ dataDir, runtime, nodeVersion: native.version ?? null }); } catch (error) {
    return restorePrevious(`could not refresh the service definition: ${error.message}`);
  }
  log('Starting the service…');
  const started = await startAgain();
  if (!started.ok) return restorePrevious(`the service did not come up on the new copy: ${started.reason}`);

  // Best effort: the old copy is dead weight, not a failure. `ezz cleanup`
  // offers it later if the ACL-aware removal cannot take it.
  try {
    if (fs.existsSync(prev)) await removeCodeTree({ dir: prev, runFile, log });
  } catch { /* `ezz cleanup` offers it later */ }

  return {
    ok: true,
    granted: acl.applied.map((g) => g.path),
    aclFailures: acl.failed,
    operator: operatorGrant.record,
    operatorNotes: operatorGrant.notes ?? [],
    runtime: { version: native.version, abi: native.abi },
  };
}

/**
 * Writes the service definition from a runtime copy.
 *
 * `nodeVersion` is optional so existing callers keep working, and is taken from
 * the caller, the runtime record, or `runtime.version`. It is what decides
 * between `--import` and the `--experimental-loader` flag in the XML: without
 * it the copied node.exe cannot be asked here (this is synchronous, and every
 * subprocess goes through core/shell.js), so the older flag would be written
 * and every daemon start would print ExperimentalWarning.
 */
export function refreshServiceDefinition({ dataDir, runtime, nodeVersion = null }) {
  const target = serviceXmlPath();
  const temp = path.join(path.dirname(target), `.service-${randomUUID()}.xml`);
  const xml = buildServiceXml({ nodeExe: runtime.nodeExe, entry: runtime.entry,
    dataDir, logDir: logDir(), workingDir: path.join(runtime.dir, 'app'),
    nodeVersion: nodeVersion ?? runtime?.version ?? runtime?.nodeVersion ?? null });
  fs.writeFileSync(temp, xml, { flag: 'wx', mode: 0o600 });
  try { renameWithRetry(temp, target); } finally { fs.rmSync(temp, { force: true }); }
}

export { SERVICE_ID, SERVICE_DISPLAY_NAME };
