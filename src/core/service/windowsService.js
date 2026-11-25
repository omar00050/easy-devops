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
import path from 'path';

import { run as shellRun, runFile as shellRunFile } from '../shell.js';
import { programDataDir, isWindows, WINDOWS_SC, windowsElevationCheckCmd } from '../platform.js';
import {
  SERVICE_ID,
  SERVICE_DISPLAY_NAME,
  WINSW_EXE_NAME,
  WINSW_XML_NAME,
  LEGACY_WINSW_NAME,
  buildServiceXml,
  downloadWinsw,
  verifyWinsw,
} from './winsw.js';
import {
  requiredGrants, applyGrants, revokeGrants, compareGrants, systemTool,
} from './acl.js';
import { runtimeDir, copyRuntime, verifyNativeModules } from './runtime.js';
import {
  grantOperator,
  revokeOperator,
  revokeServiceControl,
  restoreServiceControl,
  restoreOperatorDataAccess,
  readServiceSddl,
  operatorAceState,
  prepareProtectedDir,
} from './operator.js';
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
    const deadline = Date.now() + deleteWaitMs;
    let lastState = true;
    let lastError = null;
    do {
      lastState = await isRegistered({ run, runFile });
      if (lastState === false) return { ok: true, removed: true };
      lastError = lastState === null
        ? `SCM did not return a usable state for ${SERVICE_ID}`
        : null;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, deletePollMs));
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
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    const directory = pending.pop();
    directories.push(directory);
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      remainingStageMs(deadline, stage, timeoutMs);
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
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    await fs.promises.unlink(file);
  }
  for (const directory of directories.reverse()) {
    remainingStageMs(deadline, stage, timeoutMs);
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
 *   1. the runtime copy, so there is something to run
 *   2. verify native modules load with the copied node.exe — before a service
 *      is registered against a runtime that cannot start
 *   3. WinSW, verified against its pinned hash
 *   4. the XML
 *   5. ACLs, so the service account can reach what it needs
 *   6. register, then start
 *
 * Steps 2 and 3 are refusals, not warnings. Registering a service that cannot
 * run, or installing an unverified binary with service privileges, are both
 * worse than stopping with an explanation.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {string} opts.appRoot
 * @param {Object} [opts.config]    Live settings, for the ACL paths
 * @param {(line: string) => void} [opts.log]
 * @param {Function} [opts.run]
 * @param {Function} [opts.fetchImpl]
 * @param {Object} [opts.deps]  Injected for tests: canWrite, isWindows, copyRuntime, verifyNativeModules,
 *                              verifyWinsw
 * @returns {Promise<{ ok: boolean, reason?: string, granted?: string[], runtime?: Object,
 *                     registrationFailed?: boolean }>}
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
  if (elevated === false || !(deps.canWrite ?? canWriteProgramData)()) {
    return { ok: false, reason: elevationMessage(), needsElevation: true };
  }

  // A service left by an earlier attempt must be stopped and unregistered
  // before runtime/bin can be replaced. Deleting a running wrapper is refused
  // by Windows, and leaving either executable directory for a merge would let
  // content written by another account survive into the service runtime.
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
  if (existing) {
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

  // ── 0. The folders the service runs code from, protected while empty ──────
  //
  // An earlier install may have left the installing user a grant on the data
  // directory, which a new folder would inherit. Runtime and bin are replaced
  // outright, while the data directory is protected in place.
  for (const dir of [dataDir, runtimeDir(dataDir), binDir()]) {
    const prepared = await (deps.prepareProtectedDir ?? prepareProtectedDir)({
      dir,
      sid: operator?.sid ?? null,
      serviceAccount: false,
      fresh: dir !== dataDir,
      runFile,
      log,
    });
    if (!prepared.ok) return { ok: false, reason: `${prepared.reason}. Nothing was registered.` };
  }

  // ── 1. The pinned runtime ────────────────────────────────────────────────
  log('Copying the runtime…');
  const runtime = (deps.copyRuntime ?? copyRuntime)({ dataDir, appRoot, log });
  if (!runtime.ok) return { ok: false, reason: runtime.reason };

  // ── 2. Prove it can actually run ─────────────────────────────────────────
  log('Checking that native modules load with the copied node.exe…');
  const native = await (deps.verifyNativeModules ?? verifyNativeModules)({
    nodeExe: runtime.nodeExe,
    appDir: path.join(runtime.dir, 'app'),
  });
  if (!native.ok) {
    return {
      ok: false,
      reason: `${native.reason}\n\n${native.fix ?? ''}`.trim(),
    };
  }
  log(`  ok — Node ${native.version}, ABI ${native.abi}`);

  // ── 3. WinSW, hash-verified, stored as EasyDevOps.exe ────────────────────
  const winsw = await downloadWinsw({ dest: winswPath(), log, fetchImpl, verify: deps.verifyWinsw });
  if (!winsw.ok) return { ok: false, reason: winsw.reason };
  removeLegacyWinsw(log);

  // ── 4. The service definition ────────────────────────────────────────────
  const xml = buildServiceXml({
    nodeExe: runtime.nodeExe,
    entry: runtime.entry,
    dataDir,
    logDir: logDir(),
    workingDir: path.join(runtime.dir, 'app'),
  });

  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.writeFileSync(serviceXmlPath(), xml, 'utf8');
    log(`Wrote ${serviceXmlPath()}`);
  } catch (err) {
    return { ok: false, reason: `could not write the service definition: ${err.message}` };
  }

  // ── 5. Register, so the virtual account exists ───────────────────────────
  //
  // The ACL grants have to come AFTER this: `NT SERVICE\EasyDevOps` does not
  // exist as a security principal until a service of that name is registered,
  // and icacls refuses an unknown account.
  //
  // No path argument: WinSW v2 ignores it and reads `EasyDevOps.xml` beside
  // `EasyDevOps.exe`. Passing it suggested otherwise, which is how the name
  // mismatch went unnoticed.
  log('Registering the service…');
  // Elevation is confirmed in the normal case, so no prompt appears. When it
  // could not be confirmed, say what a prompt would be before it shows up.
  if (elevated !== true) log(UAC_NOTE);
  const registered = await runFile(winswPath(), ['install'], { timeout: 120_000 });
  if (!registered.success) {
    const output = outputOf(registered);

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

    return {
      ok: false,
      registrationFailed: true,
      reason: `WinSW could not register the service:\n${output.slice(0, 600)}\n\n`
        + `Hint: ${WINSW_EXE_NAME} and ${WINSW_XML_NAME} must sit side by side in ${binDir()}; `
        + `fix the cause above and run ezz service install again in an Administrator PowerShell. ${leftover}`,
    };
  }

  // ── 6. ACLs, from the live Settings — never a hardcoded path ─────────────
  log('Granting the service account access…');
  const grants = requiredGrants({
    dataDir,
    nginxDir: config.nginxDir ?? null,
    sslDir: config.sslDir ?? null,
  });
  const acl = await applyGrants({ grants, runFile, log });

  if (!acl.ok) {
    // Not fatal: the service is registered and the data directory grant is the
    // one that must work. A missing nginxDir grant degrades specific features
    // and is reported rather than rolled back, because rolling back a working
    // install over a directory that does not exist yet would be worse.
    for (const failure of acl.failed) {
      log(`  warning: ${failure.path} — ${failure.reason}`);
    }
  }

  // ── 6b. The installing user: start/stop, and the data directory ─────────
  //
  // Before the first start, so the service never runs from a runtime folder
  // that is not yet administrator-only. See operator.js.
  log('Allowing your account to start and stop the service without elevation…');
  const operatorGrant = await (deps.grantOperator ?? grantOperator)({
    operator,
    dataDir,
    protectedDirs: [binDir(), runtimeDir(dataDir)],
    run,
    runFile,
    log,
  });
  for (const note of operatorGrant.notes) log(`  note: ${note}`);

  if (operatorGrant.protection?.ok === false) {
    return { ok: false, registered: true, operator: operatorGrant.record, reason: 'The service files could not be protected. Run service repair before starting.' };
  }

  // ── 7. Start ─────────────────────────────────────────────────────────────
  log('Starting the service…');
  const started = await runFile(winswPath(), ['start'], { timeout: 60_000 });
  if (!started.success) {
    const output = `${started.stdout ?? ''}\n${started.stderr ?? ''}`.trim();
    return {
      ok: false,
      reason: `the service was registered but would not start:\n${output.slice(0, 400)}\n\n`
        + `Logs: ${errLogPath()} — more at ${TROUBLESHOOTING_URL}#logs`,
      registered: true,
      // Registration and the grants did succeed, and the caller records them:
      // status must not report a registered service as "not installed".
      granted: acl.applied.map((g) => g.path),
      aclFailures: acl.failed,
      operator: operatorGrant.record,
      runtime: { nodeExe: runtime.nodeExe, entry: runtime.entry, version: native.version, abi: native.abi },
    };
  }

  return {
    ok: true,
    granted: acl.applied.map((g) => g.path),
    aclFailures: acl.failed,
    operator: operatorGrant.record,
    operatorNotes: operatorGrant.notes,
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
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await queryState({ run, runFile });
    if (state === wanted || (wanted === 'STOPPED' && state === 'MISSING')) return { reached: true, state };
    await new Promise((r) => setTimeout(r, intervalMs));
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
    timeoutMs: stopWaitMs,
  });
  if (!settled.reached) {
    return {
      ok: false,
      reason: `the stop was accepted but the service was still ${settled.state ?? 'not reporting'} after `
        + `${Math.round(stopWaitMs / 1000)}s. Check the wrapper log: ${wrapperLogPath()}`,
    };
  }
  return { ok: true };
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
 * The service's state.
 *
 * @param {Object} [opts]
 * @returns {Promise<Object>}
 */
export async function status({
  dataDir,
  config = {},
  run = shellRun,
  runFile = shellRunFile,
  granted = [],
  operatorSid = null,
  deps = {},
} = {}) {
  const fsImpl = deps.fs ?? fs;
  const wrapperFile = inspectPath(fsImpl, winswPath());
  const xmlFile = inspectPath(fsImpl, serviceXmlPath());
  const filesPresent = wrapperFile.exists && xmlFile.exists;
  const fileInspectionError = wrapperFile.error ?? xmlFile.error;

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

  const sc = scExecutor({ run, runFile });
  const [config2, sddl] = await Promise.all([
    sc(['qc', SERVICE_ID], { timeout: 20_000 }).catch((error) => ({
      success: false,
      stdout: '',
      stderr: error?.message ?? String(error),
      exitCode: null,
    })),
    operatorSid
      ? readServiceSddl({ run, runFile }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const startType = `${config2.stdout ?? ''}`.match(/START_TYPE\s*:\s*\d+\s+([\w_]+)/i)?.[1] ?? null;

  const loop = countRecentRestarts();

  const aclCheck = compareGrants({
    granted,
    required: requiredGrants({
      dataDir,
      nginxDir: config.nginxDir ?? null,
      sslDir: config.sslDir ?? null,
    }),
  });

  return {
    installed: true,
    registered,
    filesPresent,
    fileInspectionError,
    warnings: [
      ...(scWarning ? [scWarning] : []),
      ...(fileInspectionError
        ? [`Could not inspect the service files in ${binDir()}: ${fileInspectionError}`]
        : []),
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
    acl: aclCheck,
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
  if (elevated !== true || !(deps.canWrite ?? canWriteProgramData)()) {
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
        reason: `Could not determine whether the service is installed. The service manager query failed, and ${winswPath()} could not be inspected: ${wrapperFile.error}. Nothing was stopped or changed.`,
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
      reason: `Could not read the service definition: ${error.message}`
        + (back.ok ? ' The service was started again.' : ` The service did not start again: ${back.reason}`),
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
        + (back.ok ? 'The service was started again.' : `The service did not start again: ${back.reason}`),
      restarted: back.ok,
    };
  }
  if (!wrapper.ok && wrapper.code) {
    const back = await startAgain();
    return {
      ok: false,
      reason: `${wrapper.reason}. The service wrapper was not replaced. `
        + (back.ok ? 'The service was started again.' : `The service did not start again: ${back.reason}`),
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
          + (back.ok ? 'The service was started again.' : `The service did not start again: ${back.reason}`),
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
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(prev, dir);
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
        + `\nLogs: ${errLogPath()} — more at ${TROUBLESHOOTING_URL}#repair-while-running`,
      restored,
      restarted: back.ok,
    };
  };

  try {
    fs.rmSync(prev, { recursive: true, force: true });
    if (fs.existsSync(dir)) fs.renameSync(dir, prev);
  } catch (err) {
    const back = await startAgain();
    return {
      ok: false,
      reason: `could not set the current runtime copy aside (${err.code ?? err.message}), so nothing was changed`
        + (back.ok ? '; the service is running again.' : `; the service did not start again: ${back.reason}`),
    };
  }

  // The new folder is protected while it is still empty, before anything the
  // service will run is copied into it.
  const prepared = await (deps.prepareProtectedDir ?? prepareProtectedDir)({
    dir, sid: operator?.sid ?? null, runFile, log,
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

  log('Re-applying the service account grants…');
  const grants = requiredGrants({
    dataDir,
    nginxDir: config.nginxDir ?? null,
    sslDir: config.sslDir ?? null,
  });
  const acl = await applyGrants({ grants, runFile, log });

  // The fresh runtime folder inherits again, so it is protected again before
  // the service starts on it; then the installing user's rights are renewed.
  log('Allowing your account to start and stop the service without elevation…');
  const operatorGrant = await (deps.grantOperator ?? grantOperator)({
    operator,
    dataDir,
    protectedDirs: [binDir(), dir],
    run,
    runFile,
    log,
  });
  for (const note of operatorGrant.notes) log(`  note: ${note}`);

  if (operatorGrant.protection?.ok === false) return restorePrevious('the new runtime permissions could not be secured');
  try { refreshServiceDefinition({ dataDir, runtime }); } catch (error) {
    return restorePrevious(`could not refresh the service definition: ${error.message}`);
  }
  log('Starting the service…');
  const started = await startAgain();
  if (!started.ok) return restorePrevious(`the service did not come up on the new copy: ${started.reason}`);

  try { fs.rmSync(prev, { recursive: true, force: true }); } catch { /* `ezz cleanup` offers it later */ }

  return {
    ok: true,
    granted: acl.applied.map((g) => g.path),
    aclFailures: acl.failed,
    operator: operatorGrant.record,
    operatorNotes: operatorGrant.notes,
    runtime: { version: native.version, abi: native.abi },
  };
}

export function refreshServiceDefinition({ dataDir, runtime }) {
  const target = serviceXmlPath();
  const temp = path.join(path.dirname(target), `.service-${randomUUID()}.xml`);
  const xml = buildServiceXml({ nodeExe: runtime.nodeExe, entry: runtime.entry,
    dataDir, logDir: logDir(), workingDir: path.join(runtime.dir, 'app') });
  fs.writeFileSync(temp, xml, { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temp, target); } finally { fs.rmSync(temp, { force: true }); }
}

export { SERVICE_ID, SERVICE_DISPLAY_NAME };
