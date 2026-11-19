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
import path from 'path';

import { run as shellRun } from '../shell.js';
import { programDataDir, isWindows } from '../platform.js';
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
import { requiredGrants, applyGrants, revokeGrants, compareGrants } from './acl.js';
import { runtimeDir, copyRuntime, verifyNativeModules } from './runtime.js';

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
export function canWriteProgramData() {
  const dir = programDataDir();

  // Probes the directory if it already exists, and otherwise probes its
  // PARENT. Creating `C:\ProgramData\easy-devops` as a side effect of asking
  // "am I elevated?" would leave a directory behind on a machine that never
  // installed anything — and this question is asked on paths that then
  // decline to proceed. Install creates the directory explicitly.
  const target = fs.existsSync(dir) ? dir : path.dirname(dir);
  const probe = path.join(target, `.ez-write-probe-${process.pid}`);

  try {
    fs.writeFileSync(probe, 'probe');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** The message to print when elevation is missing. */
export function elevationMessage() {
  return [
    'Installing the Windows service needs an Administrator terminal.',
    '',
    'Right-click PowerShell → "Run as administrator", then:',
    '',
    '  ezz service install',
    '',
    'You will not be asked for a password: the service runs as the virtual',
    'account NT SERVICE\\EasyDevOps, which Windows manages itself.',
  ].join('\n');
}

/** Combined output of a shell result, trimmed. */
function outputOf(result) {
  return `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.trim();
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
export async function isRegistered({ run = shellRun } = {}) {
  const result = await run(`sc query ${SERVICE_ID}`, { timeout: 20_000 });
  const output = outputOf(result);
  if (result.success || /STATE\s*:/i.test(output)) return true;
  if (/1060|does not exist/i.test(output)) return false;
  return null;
}

/**
 * Removes a registration of SERVICE_ID, whatever state it is in.
 *
 * WinSW's own `stop`/`uninstall` first, when the wrapper is present and has
 * its definition beside it — that is the clean path. Then, if the Service
 * Control Manager still knows the name, `sc stop` + `sc delete`, which work
 * without the wrapper. A service that is marked for deletion while a handle
 * is open (services.msc, for instance) disappears once that handle closes;
 * `sc delete` reports success in that case, and so does this.
 *
 * @returns {Promise<{ ok: boolean, removed: boolean, reason?: string }>}
 */
export async function unregister({ run = shellRun, log = () => {} } = {}) {
  let removed = false;

  if (fs.existsSync(winswPath()) && fs.existsSync(serviceXmlPath())) {
    await run(`& "${winswPath()}" stop`, { timeout: 60_000 });
    const viaWinsw = await run(`& "${winswPath()}" uninstall`, { timeout: 60_000 });
    if (viaWinsw.success) removed = true;
  }

  const still = await isRegistered({ run });
  if (still === false) return { ok: true, removed };

  await run(`sc stop ${SERVICE_ID}`, { timeout: 60_000 });
  const deleted = await run(`sc delete ${SERVICE_ID}`, { timeout: 30_000 });
  const output = outputOf(deleted);

  if (deleted.success || /1060|does not exist/i.test(output)) {
    log(`Removed the ${SERVICE_ID} service registration.`);
    return { ok: true, removed: true };
  }
  if (/1072|marked for deletion/i.test(output)) {
    return {
      ok: true,
      removed: true,
      reason: 'Windows has marked the service for deletion; close services.msc (or reboot) to finish it.',
    };
  }
  return { ok: false, removed, reason: output.slice(0, 400) || `sc delete ${SERVICE_ID} failed` };
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
  log = () => {},
  run = shellRun,
  fetchImpl = fetch,
  deps = {},
} = {}) {
  if (!(deps.isWindows ?? isWindows)) return { ok: false, reason: 'Server mode is Windows-only' };

  if (!(deps.canWrite ?? canWriteProgramData)()) {
    return { ok: false, reason: elevationMessage(), needsElevation: true };
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
  // A registration left by an earlier attempt (an interrupted install, or one
  // that pointed at a wrapper that has since moved) is removed first:
  // `winsw install` refuses a name that already exists, and re-registering is
  // the only way to make it point at this wrapper and this definition.
  const existing = await isRegistered({ run });
  if (existing) {
    log(`A ${SERVICE_ID} service is already registered; removing it before registering again…`);
    const cleared = await unregister({ run, log });
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

  // No path argument: WinSW v2 ignores it and reads `EasyDevOps.xml` beside
  // `EasyDevOps.exe`. Passing it suggested otherwise, which is how the name
  // mismatch went unnoticed.
  log('Registering the service…');
  const registered = await run(`& "${winswPath()}" install`, { timeout: 120_000 });
  if (!registered.success) {
    const output = outputOf(registered);

    // WinSW can fail after the Service Control Manager accepted the name, so
    // a failed register is followed by a clean-up: nothing half-registered is
    // left for the next attempt to trip over.
    const cleanup = await unregister({ run, log });
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
    runtimeDir: runtimeDir(dataDir),
    nginxDir: config.nginxDir ?? null,
    sslDir: config.sslDir ?? null,
  });
  const acl = await applyGrants({ grants, run, log });

  if (!acl.ok) {
    // Not fatal: the service is registered and the data directory grant is the
    // one that must work. A missing nginxDir grant degrades specific features
    // and is reported rather than rolled back, because rolling back a working
    // install over a directory that does not exist yet would be worse.
    for (const failure of acl.failed) {
      log(`  warning: ${failure.path} — ${failure.reason}`);
    }
  }

  // ── 7. Start ─────────────────────────────────────────────────────────────
  log('Starting the service…');
  const started = await run(`& "${winswPath()}" start`, { timeout: 60_000 });
  if (!started.success) {
    const output = `${started.stdout ?? ''}\n${started.stderr ?? ''}`.trim();
    return {
      ok: false,
      reason: `the service was registered but would not start:\n${output.slice(0, 400)}\n\n`
        + `Logs: ${errLogPath()}`,
      registered: true,
    };
  }

  return {
    ok: true,
    granted: acl.applied.map((g) => g.path),
    aclFailures: acl.failed,
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
export async function uninstall({ dataDir, config = {}, log = () => {}, run = shellRun } = {}) {
  if (!isWindows) return { ok: false, reason: 'Server mode is Windows-only' };

  if (!canWriteProgramData()) {
    return {
      ok: false,
      needsElevation: true,
      reason: 'Removing the Windows service needs an Administrator terminal.\n\n'
        + '  Right-click PowerShell → "Run as administrator", then: ezz service uninstall',
    };
  }

  const notes = [];

  // WinSW's own stop + uninstall when the wrapper is there, and `sc delete`
  // for a registration whose wrapper is missing — so a service left behind by
  // a failed or interrupted install can always be removed.
  const removed = await unregister({ run, log });
  if (!removed.ok) {
    return { ok: false, reason: `the service could not be unregistered:\n${removed.reason}` };
  }
  if (removed.reason) notes.push(removed.reason);
  if (removed.removed) log('Service unregistered.');
  else notes.push('no service was registered, so there was nothing to unregister');

  removeLegacyWinsw(log);

  // Revoked while the account still resolves. After the service is gone the
  // SID may no longer map to a name, and icacls would refuse — so the order
  // here is the reverse of install's for a reason.
  log('Removing the service account grants…');
  const revoked = await revokeGrants({
    paths: [dataDir, runtimeDir(dataDir), config.nginxDir, config.sslDir].filter(Boolean),
    run,
    log,
  });
  if (!revoked.ok) {
    for (const failure of revoked.failed) notes.push(`could not clear grants on ${failure.path}`);
  }

  return { ok: true, notes };
}

/** `winsw restart`. */
export async function restart({ run = shellRun } = {}) {
  if (!fs.existsSync(winswPath())) {
    return { ok: false, reason: 'the service is not installed' };
  }
  const result = await run(`& "${winswPath()}" restart`, { timeout: 90_000 });
  return {
    ok: result.success,
    reason: result.success ? null : `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 400),
  };
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
  return `${action} the Windows service needs an Administrator terminal.\n\n`
    + '  Right-click PowerShell → "Run as administrator", then:\n'
    + `    ezz service ${action.toLowerCase()}\n\n`
    + '  No password is needed — only elevation.';
}

/**
 * `sc stop` — temporary. The service stays registered and set to Automatic, so
 * it starts again at the next boot. `ezz service uninstall` is the permanent
 * removal.
 */
export async function stop({ run = shellRun } = {}) {
  if (!fs.existsSync(winswPath())) {
    return { ok: false, reason: 'the service is not installed, so there is nothing to stop' };
  }

  // `sc stop` rather than `winsw stop`: it is the Service Control Manager's own
  // verb, so it works even when the WinSW wrapper binary is missing or broken,
  // and its "Access is denied" is the authoritative answer on elevation.
  const result = await run(`sc stop ${SERVICE_ID}`, { timeout: 60_000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  if (result.success) return { ok: true };

  if (/Access is denied/i.test(output)) {
    return { ok: false, needsElevation: true, reason: elevationFor('Stopping') };
  }
  // 1062: the service has not been started. Already stopped is a success.
  if (/1062|has not been started/i.test(output)) {
    return { ok: true, alreadyStopped: true };
  }

  return { ok: false, reason: output.trim().slice(0, 400) || `sc stop ${SERVICE_ID} failed` };
}

/** `sc start`. */
export async function start({ run = shellRun } = {}) {
  if (!fs.existsSync(winswPath())) {
    return { ok: false, reason: 'the service is not installed; run `ezz service install` first' };
  }

  const result = await run(`sc start ${SERVICE_ID}`, { timeout: 60_000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  if (result.success) return { ok: true };

  if (/Access is denied/i.test(output)) {
    return { ok: false, needsElevation: true, reason: elevationFor('Starting') };
  }
  // 1056: an instance is already running.
  if (/1056|already running/i.test(output)) {
    return { ok: true, alreadyRunning: true };
  }

  return { ok: false, reason: output.trim().slice(0, 400) || `sc start ${SERVICE_ID} failed` };
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
 * @param {Object} [opts]
 * @param {number} [opts.windowMs] How far back to look (default 10 minutes)
 * @returns {{ restarts: number, crashLooping: boolean, since: Date|null }}
 */
export function countRecentRestarts({ windowMs = 10 * 60_000, now = Date.now() } = {}) {
  let text;
  try {
    text = fs.readFileSync(wrapperLogPath(), 'utf8');
  } catch {
    return { restarts: 0, crashLooping: false, since: null };
  }

  // WinSW writes lines like:
  //   2026-11-14 04:17:03,123 INFO  - Starting <exe>
  // Only the tail is examined: a months-old log is large and its early history
  // says nothing about whether the service is looping right now.
  const lines = text.split(/\r?\n/).slice(-4000);
  const cutoff = now - windowMs;

  let restarts = 0;
  let earliest = null;

  for (const line of lines) {
    if (!/\b(Starting|Restarting)\b/i.test(line)) continue;

    const stamp = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    if (!stamp) continue;

    const at = Date.parse(`${stamp[1]}T${stamp[2]}`);
    if (!Number.isFinite(at) || at < cutoff) continue;

    restarts++;
    if (earliest === null || at < earliest) earliest = at;
  }

  // Three starts in ten minutes is not normal operation: the daemon is meant
  // to start once and stay up. One or two can be a deliberate restart plus an
  // upgrade, so the threshold is above that.
  return {
    restarts,
    crashLooping: restarts >= 3,
    since: earliest ? new Date(earliest) : null,
  };
}

/**
 * The service's state.
 *
 * @param {Object} [opts]
 * @returns {Promise<Object>}
 */
export async function status({ dataDir, config = {}, run = shellRun, granted = [] } = {}) {
  const installed = fs.existsSync(winswPath()) && fs.existsSync(serviceXmlPath());

  if (!installed) {
    return {
      installed: false,
      running: false,
      enabledOnBoot: false,
      state: 'not installed',
      restarts: 0,
      crashLooping: false,
      winswPath: winswPath(),
    };
  }

  // `sc query` rather than `winsw status`: it does not depend on the wrapper
  // being runnable, so a broken WinSW still reports a registered service.
  const query = await run(`sc query ${SERVICE_ID}`, { timeout: 20_000 });
  const output = `${query.stdout ?? ''}\n${query.stderr ?? ''}`;

  const stateMatch = output.match(/STATE\s*:\s*\d+\s+(\w+)/i);
  const scState = stateMatch ? stateMatch[1].toUpperCase() : null;

  const config2 = await run(`sc qc ${SERVICE_ID}`, { timeout: 20_000 });
  const startType = `${config2.stdout ?? ''}`.match(/START_TYPE\s*:\s*\d+\s+([\w_]+)/i)?.[1] ?? null;

  const loop = countRecentRestarts();

  const aclCheck = compareGrants({
    granted,
    required: requiredGrants({
      dataDir,
      runtimeDir: runtimeDir(dataDir),
      nginxDir: config.nginxDir ?? null,
      sslDir: config.sslDir ?? null,
    }),
  });

  return {
    installed: true,
    running: scState === 'RUNNING',
    enabledOnBoot: startType ? /AUTO_START/i.test(startType) : null,
    state: scState ? scState.toLowerCase() : 'unknown',
    startType,
    restarts: loop.restarts,
    crashLooping: loop.crashLooping,
    crashLoopSince: loop.since,
    acl: aclCheck,
    winswPath: winswPath(),
    logs: { out: outLogPath(), err: errLogPath(), wrapper: wrapperLogPath() },
  };
}

/** Recent log lines, newest last. */
export function readLogs({ lines = 50, which = 'out' } = {}) {
  const file = which === 'err' ? errLogPath() : which === 'wrapper' ? wrapperLogPath() : outLogPath();

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {
      ok: false,
      file,
      output: err.code === 'ENOENT'
        ? `No log yet at ${file}. The service may not have started.`
        : `Could not read ${file}: ${err.message}`,
    };
  }

  const all = text.split(/\r?\n/).filter(Boolean);
  return { ok: true, file, output: all.slice(-Math.max(1, Math.min(5000, Number(lines) || 50))).join('\n') };
}

/**
 * Re-applies what install set up, without unregistering the service.
 *
 * The two things that drift: the ACL grants, when a path changes in Settings,
 * and the runtime copy, when the application is upgraded under it. Both are
 * re-done; the service is then restarted so it picks them up.
 */
export async function repair({ dataDir, appRoot, config = {}, log = () => {}, run = shellRun } = {}) {
  if (!isWindows) return { ok: false, reason: 'Server mode is Windows-only' };

  if (!canWriteProgramData()) {
    return {
      ok: false,
      needsElevation: true,
      reason: 'Repairing the Windows service needs an Administrator terminal.\n\n'
        + '  Right-click PowerShell → "Run as administrator", then: ezz service repair',
    };
  }

  if (!fs.existsSync(winswPath())) {
    return { ok: false, reason: 'the service is not installed; run `ezz service install` instead' };
  }

  // The wrapper itself is re-verified: a tampered or truncated WinSW is worth
  // catching at repair time too, not only at install.
  const wrapper = await verifyWinsw(winswPath());
  if (!wrapper.ok) {
    log('The installed WinSW did not verify; re-downloading.');
    const again = await downloadWinsw({ dest: winswPath(), log });
    if (!again.ok) return { ok: false, reason: again.reason };
  }

  log('Refreshing the runtime copy…');
  const runtime = copyRuntime({ dataDir, appRoot, log });
  if (!runtime.ok) return { ok: false, reason: runtime.reason };

  const native = await verifyNativeModules({
    nodeExe: runtime.nodeExe,
    appDir: path.join(runtime.dir, 'app'),
  });
  if (!native.ok) return { ok: false, reason: `${native.reason}\n\n${native.fix ?? ''}`.trim() };

  log('Re-applying the service account grants…');
  const grants = requiredGrants({
    dataDir,
    runtimeDir: runtimeDir(dataDir),
    nginxDir: config.nginxDir ?? null,
    sslDir: config.sslDir ?? null,
  });
  const acl = await applyGrants({ grants, run, log });

  const restarted = await restart({ run });
  if (!restarted.ok) {
    return { ok: false, reason: `permissions were re-applied but the restart failed: ${restarted.reason}` };
  }

  return {
    ok: true,
    granted: acl.applied.map((g) => g.path),
    aclFailures: acl.failed,
    runtime: { version: native.version, abi: native.abi },
  };
}

export { SERVICE_ID, SERVICE_DISPLAY_NAME };
