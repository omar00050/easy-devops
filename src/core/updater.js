/**
 * core/updater.js
 *
 * Updating Easy DevOps itself.
 *
 * ── Why the request cannot do the work ────────────────────────────────────
 *
 * npm replaces the files the caller is running from, and the background
 * service has to be stopped so those files can be replaced — on Windows an
 * open handle makes the install fail outright. A request that arrives over
 * HTTP or over the Hub socket cannot survive its own server being stopped, so
 * it could report neither success nor failure: the connection would simply
 * end mid-update, and whatever happened next would be invisible.
 *
 * So the work is owned by a caller that outlives it:
 *
 *   - `ezz update` runs it in a terminal, where someone is watching and a
 *     failure can be rolled back while they are still there;
 *   - Settings > Update in the dashboard records the run and hands it to a
 *     detached worker (dashboard/updateWorker.js) that survives the restart,
 *     performs THIS flow, starts the dashboard again, and leaves the outcome
 *     in core/updateStatus.js for the new dashboard to read.
 *
 * The Hub has neither, which is what whyCliOnly() explains.
 *
 * ── Why the install source is detected first ───────────────────────────────
 *
 * On a git clone, `npm install -g easy-devops` installs a SECOND copy from the
 * registry and leaves the service running the clone. The update then reports
 * success and changes nothing that runs. So the source is established before
 * anything else, and a clone is told to `git pull` instead — which this tool
 * deliberately does not run on the user's behalf: a pull can conflict, and the
 * working tree may hold work in progress. See core/installSource.js.
 *
 * ── The order, and why each step is where it is ────────────────────────────
 *
 *   1. read the service state (mode, mechanism) — before anything is touched;
 *   2. stop, then capture the unit/XML, launchers and Windows runtime copy in
 *      a journaled transaction (core/service/updateTransaction.js);
 *   3. npm install -g the target;
 *   4. run the NEW package's `_post-update` in a fresh process: unit/XML,
 *      runtime copy, protections and stubs, by the code being installed. A
 *      target that predates that command falls back to this version's repair;
 *   5. start, and require the daemon's own heartbeat to report the target
 *      version — a matching package on disk is not proof;
 *   6. on any failure: restore the package, unit/XML and runtime together,
 *      start again, and require the OLD heartbeat.
 *
 * Every failure returns through one place, with the step, the error, and the
 * exact command to run next. Nothing here may end silently with the service
 * stopped: that is the bug this flow exists to fix (1.4.4-1.4.6 stopped after
 * "node.exe is already the runtime copy ...; kept" and printed nothing).
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

import { runFile } from './shell.js';
import { getDataDir, isWindows } from './platform.js';
import { closeDb, initDb } from './db.js';
import { detectInstallSource, describeUnmanaged } from './installSource.js';
import { inspect as inspectLock } from './daemon/lock.js';
import { loadConfig } from './config.js';
import { MODES } from './service/index.js';
import { isElevated } from './service/windowsService.js';
import {
  captureUpdateState,
  commitUpdateState,
  restoreUpdateState,
} from './service/updateTransaction.js';

const require = createRequire(import.meta.url);

/** The npm package name, in one place. */
export const PACKAGE = 'easy-devops';

/** How long to wait for the daemon to report in after the restart. */
export const VERIFY_MS = 10_000;

/** Structured result emitted by the newly installed `_post-update` command. */
export const POST_UPDATE_RESULT_PREFIX = '__EASY_DEVOPS_POST_UPDATE__';

/**
 * The first release whose package carries the `_post-update` command.
 *
 * An update can be asked to install an OLDER version — a deliberate downgrade,
 * or a target published before the hand-off existed. Such a package has no
 * post-update step to run, so the updater falls back to its own repair logic
 * rather than launching that package's interactive menu by accident.
 */
export const POST_UPDATE_SINCE = '1.4.7';

/**
 * The one line a Windows Server edition with no registered service gets.
 *
 * There is nothing to stop, prepare or start, and the Personal Startup
 * launcher is never an answer on a Server edition (1.4.7 finding C4). The
 * package update itself still proceeds.
 */
export const NOT_INSTALLED_SERVER_LINE = 'The Easy DevOps service is not installed on this Windows Server; '
  + 'run `ezz service install` from an Administrator PowerShell.';

/**
 * Per-stream cap for the post-update child's output.
 *
 * The marker is the LAST line the child prints, and a runtime copy can log
 * thousands of progress lines before it. The old 64 KiB tail is what made a
 * marker printed early in a long output unfindable; 8 MiB is the same generous
 * default core/shell.js uses for `output: 'full'`.
 */
export const POST_UPDATE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** A positive, finite millisecond timeout, or the default when it is not. */
function finiteMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** The command that shows this machine's service state, by mechanism. */
export function serviceCheckCommand(mechanism) {
  if (mechanism === 'systemd') return 'sudo systemctl status easy-devops';
  if (mechanism === 'winsw') return 'sc.exe query EasyDevOps';
  return 'ezz service status';
}

/**
 * The lines a failed update ends with: the step, the error, the state of the
 * service, and the exact command to run next.
 */
function failureLines({ step, reason, mechanism, untouched, attemptedStop, restored, reinstallFailed, check = null }) {
  const lines = [`Failed at: ${step}`];
  for (const line of String(reason ?? '').split('\n')) lines.push(line);
  const checkCommand = check ?? serviceCheckCommand(mechanism);
  if (untouched) {
    lines.push('Nothing was changed.');
    if (attemptedStop) {
      // The package is untouched, but a stop that failed may still have
      // stopped the service. Say which it is rather than assuming.
      lines.push(restored === true
        ? 'The service is running again.'
        : 'The service is NOT confirmed running.');
      if (restored !== true) {
        lines.push('To start it: ezz service start');
        lines.push('To repair it: ezz service recover');
      }
    } else {
      lines.push('The service was left as it was.');
    }
    lines.push(`To check it: ${checkCommand}`);
  } else if (reinstallFailed === true) {
    lines.push(restored
      ? 'The service is running again, but the previous package could not be reinstalled, so the files on disk'
        + ' and the running service are not the same version.'
      : 'The previous package could not be reinstalled and the service is NOT confirmed running.');
    lines.push(`To check it: ${checkCommand}`);
    lines.push('To repair it: ezz service recover');
  } else if (restored === true) {
    lines.push('The service is running the previous version again.');
    lines.push(`To check it: ${checkCommand}`);
  } else {
    lines.push('The background service is NOT confirmed running.');
    lines.push(`To check it: ${checkCommand}`);
    lines.push('To repair it: ezz service recover');
  }
  return lines;
}

/** This package's version, read fresh so a post-update read is accurate. */
export function currentVersion() {
  return String(require('../../package.json').version);
}

export function isUpdateVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value);
}

function runNpm(args, options, exec = runFile) {
  if (process.env.EZ_TEST === '1' && exec === runFile) {
    throw new Error('Updater tests must supply an npm runner.');
  }
  if (!isWindows) return exec('npm', args, options);

  // Windows npm launchers are shell scripts. Run npm's JS entry with Node
  // directly, including when the launcher's directory is separate from Node.
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const dir of dirs.filter((item) => path.isAbsolute(item))) {
    const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(cli)) return exec(process.execPath, [cli, ...args], options);
  }
  return { success: false, stderr: 'Could not locate npm-cli.js. Install npm alongside Node and retry.' };
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

/** -1 / 0 / 1 by SemVer precedence, including prereleases. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1;
  }
  if (!pa.prerelease && !pb.prerelease) return 0;
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;

  for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i += 1) {
    const left = pa.prerelease[i];
    const right = pb.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left) - Number(right);
      if (difference !== 0) return difference > 0 ? 1 : -1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}

/** Exact release identity, allowing only the conventional leading `v`. */
export function sameVersion(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const normalized = (value) => String(value).trim().replace(/^v/, '');
  return normalized(a) === normalized(b);
}

/**
 * What the registry has.
 *
 * @param {Object} [opts]
 * @returns {Promise<{ reachable: boolean, current: string, latest: string|null, updateAvailable: boolean }>}
 */
export async function checkForUpdate({ deps = {} } = {}) {
  const current = deps.currentVersion ? deps.currentVersion() : currentVersion();

  const result = await runNpm(['view', PACKAGE, 'version'], { timeout: 30_000 }, deps.runFile);
  const latest = result.success ? result.stdout.replace(/\r?\n$/, '') : null;

  if (!isUpdateVersion(latest)) {
    return { reachable: false, current, latest: null, updateAvailable: false };
  }

  return {
    reachable: true,
    current,
    latest,
    updateAvailable: compareVersions(latest, current) > 0,
  };
}

/**
 * Updates the package, restarts the service, verifies it, and rolls back if it
 * did not come up.
 *
 * The dashboard is NOT handled here: a detached dashboard is a CLI concern
 * (cli/menus/dashboard.js owns starting and stopping it) and core must not
 * import from cli/. The caller stops and restarts it around this call.
 *
 * @param {Object} opts
 * @param {string} opts.version Target version
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<Object>}
 */
export async function performUpdate({
  version,
  dataDir = getDataDir(),
  log = () => {},
  deps = {},
} = {}) {
  const service = deps.service ?? (await import('./service/index.js'));
  const source = (deps.detectInstallSource ?? detectInstallSource)();
  const from = deps.currentVersion ? deps.currentVersion() : currentVersion();
  const exec = deps.runFile ?? runFile;
  // Every wait here is bounded. `Infinity`, a zero or a value derived from an
  // undefined deadline becomes the default rather than a setTimeout overflow
  // (1.4.7 finding C7).
  const verifyMs = finiteMs(deps.verifyMs, VERIFY_MS);

  let installed = null;
  let mechanism = null;
  let recorded = {};
  // A Windows Server edition with no registered service: the package update
  // proceeds, the service steps are skipped, and this is never a failure.
  let serverNotRegistered = false;

  /**
   * Every failure leaves through here, so none of them can be silent: the
   * result carries the step, the error, the state of the service, and the
   * exact command that checks or repairs it on this machine.
   */
  const fail = (fields) => {
    const untouched = fields.untouched === true;
    const alive = fields.restored === true;
    const confirmed = alive && fields.rollbackVersionConfirmed !== false;
    let next = fields.next;
    if (!next && serverNotRegistered) {
      // No service exists here, so neither "start" nor "recover" applies; the
      // package itself is what still needs attention.
      next = 'ezz service status';
    }
    if (!next) {
      if (untouched) {
        next = fields.attemptedStop && fields.restored !== true && fields.rollbackVersionConfirmed !== true
          ? 'ezz service start'
          : serviceCheckCommand(mechanism);
      } else if (fields.reinstallFailed === true) next = `npm install -g ${PACKAGE}@${from}`;
      else if (confirmed) next = serviceCheckCommand(mechanism);
      else next = 'ezz service recover';
    }
    return {
      ok: false,
      from,
      to: version,
      ...fields,
      // The advice is in `reason` too, not only in `next`: every caller that
      // exists today prints the reason, and a failure nobody can act on is the
      // bug this path was rewritten for.
      reason: fields.reason ? `${fields.reason}\nNext: ${next}` : `Next: ${next}`,
      next,
      lines: fields.lines ?? failureLines({
        step: fields.step,
        reason: fields.reason,
        mechanism,
        untouched,
        attemptedStop: fields.attemptedStop === true,
        restored: confirmed,
        reinstallFailed: fields.reinstallFailed === true,
        check: serverNotRegistered ? 'ezz service status' : null,
      }),
    };
  };

  if (!isUpdateVersion(version) || !isUpdateVersion(from)) {
    return fail({
      step: 'version',
      reason: 'Use a valid release or prerelease version.',
      untouched: true,
    });
  }

  // 1. Can npm update THIS copy at all?
  if (!source.npmUpdatable) {
    return fail({
      step: 'source',
      source,
      // Not an error the caller has to phrase: the module that knows why also
      // knows what to run instead.
      lines: describeUnmanaged(source, 'update'),
      next: source.howToUpdate?.[0] ?? 'npm install -g easy-devops',
      reason: `this copy is ${source.reason}, which npm does not update in place`,
      untouched: true,
    });
  }

  // 2. What is installed, decided BEFORE the files are replaced.
  try {
    installed = await service.status();
  } catch (error) {
    return fail({
      step: 'status',
      reason: `the current service state could not be read, so nothing was changed: ${error.message}`,
      untouched: true,
    });
  }
  const serviceInstalled = Boolean(installed?.service?.installed);
  const serverMode = installed?.mode === MODES.SERVER;
  // A Server-mode service is always WinSW, so the check command is exact even
  // for an older status shape that does not report the mechanism.
  mechanism = installed?.mechanism ?? (serverMode ? 'winsw' : null);
  try { recorded = service.recordedState?.() ?? {}; } catch { /* optional metadata */ }

  // 2a. Windows Server edition with no service registered.
  //
  // 1.4.7's repair fell back to the Personal Startup launcher here; an update
  // must never do that. The edition is what makes the difference, and it is
  // read once from the service module (or an injected probe in tests) rather
  // than guessed from a status shape that may belong to the previous release.
  if (isWindows) {
    let state = null;
    try {
      if (deps.serviceInstallState) {
        state = await deps.serviceInstallState({});
      } else if (!serviceInstalled || serverMode) {
        const probe = typeof service.serviceInstallState === 'function'
          ? () => service.serviceInstallState()
          : null;
        state = probe ? await probe() : null;
      }
    } catch { /* an unreadable state does not change the package update */ }
    serverNotRegistered = state?.registered === false && state?.edition === 'server';
  }
  // What is left for the service steps. A stale status that still says
  // "installed" does not override the edition probe.
  let serviceSteps = serviceInstalled && !serverNotRegistered;

  // 2b. Windows Server mode: the service runs from a copy under ProgramData
  // that only administrators may replace, and that is deliberate (replacing
  // node.exe would run code as the service account). Asked of Windows before
  // anything is stopped, so a normal terminal changes nothing at all.
  if (isWindows && serverMode && serviceSteps) {
    const elevated = await (deps.isElevated ?? isElevated)({});
    if (elevated === false) {
      return fail({
        step: 'elevation',
        needsElevation: true,
        untouched: true,
        command: 'ezz update',
        next: 'ezz update',
        reason: 'Updating a Windows Server-mode install replaces the runtime copy the service runs, which only '
          + 'administrators can change. Run `ezz update` from PowerShell opened with "Run as administrator".',
      });
    }
  }

  // 3. Stop the service. Its files are the ones npm is about to replace, and
  // on Windows an open handle makes the install fail rather than wait.
  if (serviceSteps) {
    log('Stopping the background service...');
    let stopped;
    try {
      stopped = await service.stop({ log });
    } catch (error) {
      stopped = { ok: false, reason: error.message };
    }
    if (!stopped.ok && stopped.code === 'not_installed') {
      // The status was stale: on this Windows Server there is no service to
      // stop. That is not an error, and it is never a rollback.
      serviceSteps = false;
      serverNotRegistered = true;
      log(NOT_INSTALLED_SERVER_LINE);
    } else if (!stopped.ok && !stopped.alreadyStopped) {
      // A stop that fails may still have stopped it. Put it back either way,
      // so a failed update never leaves the service down.
      const back = await restoreStoppedService({
        service,
        dataDir,
        verifyMs,
        inspectLockFn: deps.inspectLock,
        from,
        log,
      });
      return fail({
        step: 'stop',
        reason: [stopped.reason, back.reason].filter(Boolean).join(' '),
        needsElevation: stopped.needsElevation ?? false,
        untouched: true,
        attemptedStop: true,
        restarted: back.started,
        restored: back.started,
        rollbackVersionConfirmed: back.versionConfirmed,
      });
    }
  } else if (serverNotRegistered) {
    log(NOT_INSTALLED_SERVER_LINE);
  } else {
    log('No background service is installed; updating the package only.');
  }

  // The package is npm-owned and can be reinstalled. The unit/XML and Windows
  // runtime copy are not. Put a restorable copy aside after the service has
  // stopped, before npm or the new post-update command can change them.
  let transaction = { ok: true, root: null };
  if (serviceSteps) {
    try {
      transaction = await (deps.captureUpdateState ?? captureUpdateState)({
        dataDir,
        mode: installed?.mode ?? null,
        mechanism,
      });
    } catch (error) {
      transaction = { ok: false, reason: error.message };
    }
    if (!transaction.ok) {
      const back = await restoreStoppedService({
        service,
        dataDir,
        verifyMs,
        inspectLockFn: deps.inspectLock,
        restoreUpdateStateFn: deps.restoreUpdateState,
        from,
        log,
      });
      return fail({
        step: 'snapshot',
        reason: `the current service files could not be preserved, so nothing was replaced: ${transaction.reason}`,
        restarted: back.started,
        restored: back.ok,
        rollbackReason: back.reason,
      });
    }
  }

  // 4. Replace the package. The SQLite handle is closed first: on Windows an
  // open database file cannot be renamed, and npm renames the whole directory.
  closeDb();

  log(`Installing ${PACKAGE}@${version}...`);
  let install;
  try {
    install = await runNpm(['install', '-g', `${PACKAGE}@${version}`], { timeout: 600_000 }, exec);
  } catch (error) {
    install = { success: false, stdout: '', stderr: error.message };
  }

  let dbError = null;
  try { initDb(); } catch (error) { dbError = error; }

  if (!install.success || dbError) {
    const back = await rollback({
      version: from,
      service,
      exec,
      serviceInstalled: serviceSteps,
      transaction,
      dataDir,
      verifyMs,
      inspectLockFn: deps.inspectLock,
      restoreUpdateStateFn: deps.restoreUpdateState,
      log,
    });
    return fail({
      step: 'install',
      serviceInstalled: serviceSteps,
      reason: [
        dbError
          ? `the package was installed but its database could not be reopened: ${dbError.message}`
          : `npm install -g ${PACKAGE}@${version} failed:\n${trim(install)}`,
        back.reason,
      ].filter(Boolean).join(' '),
      rolledBack: back.ok,
      reinstallFailed: back.reinstallFailed === true,
      restarted: back.started,
      restored: back.started,
      rollbackVersionConfirmed: back.versionConfirmed,
      rollbackReason: back.reason,
    });
  }

  /**
   * The package changed and there is no service to prepare or start. Not a
   * failure: on a machine with no registered service this IS the update, and
   * on a Windows Server edition it prints the command that installs one.
   * Anything captured for a status that turned out to be stale is committed,
   * so no journal is left behind for the next run to "recover".
   */
  const finishWithoutService = async () => {
    const warnings = [];
    if (transaction?.ok && (transaction.root || transaction.runtimeBackup || transaction.journal)) {
      try {
        const committed = await (deps.commitUpdateState ?? commitUpdateState)(transaction, { log });
        warnings.push(...(committed?.warnings ?? []));
      } catch (error) {
        warnings.push(`could not remove the update snapshot: ${error.message}`);
        log(`warning: ${warnings[warnings.length - 1]}`);
      }
    }
    return {
      ok: true,
      from,
      to: version,
      serviceInstalled: false,
      serviceNotInstalled: serverNotRegistered,
      ...(serverNotRegistered ? {
        notInstalledLine: NOT_INSTALLED_SERVER_LINE,
        lines: [NOT_INSTALLED_SERVER_LINE],
      } : {}),
      refreshedCopy: installed?.mode === MODES.SERVER || installed?.mechanism === 'winsw',
      cleanupWarnings: warnings,
      source,
    };
  };

  // 5. No service means there is nothing for post-update to prepare.
  if (!serviceSteps) {
    return finishWithoutService();
  }

  // 6. The updater that is running is the OLD package. Start a fresh process
  // from the NEW package so unit/XML/runtime repair is executed by the code it
  // is preparing, before any service start.
  let postUpdate;
  try {
    postUpdate = await (deps.runPostUpdate ?? runPostUpdateHandoff)({
      sourceRoot: source.root,
      version,
      dataDir,
      mode: installed?.mode ?? null,
      mechanism,
      nodeExe: transaction.runtimeNodeExe || recorded.nodeExe || process.execPath,
      runFile: exec,
      // The child's own progress lines (a 10,700-file runtime takes a while)
      // reach the operator through this log instead of being swallowed.
      log,
    });
  } catch (error) {
    postUpdate = { ok: false, step: 'post-update', reason: error.message };
  }

  // The installed target may predate the post-update command — a deliberate
  // downgrade, or any release before 1.4.7. Then this update's own repair
  // logic prepares the service, which is what every release before the
  // hand-off did.
  if (postUpdate.ok && postUpdate.fallback) {
    log(postUpdate.reason || 'The installed version has no post-update step; using this version\'s service repair.');
    let repaired;
    try {
      const repair = deps.runRepair ?? (typeof service.repair === 'function'
        ? (options) => service.repair(options)
        : null);
      if (!repair) throw new Error('this copy has no service repair step to fall back to');
      repaired = await repair({ log });
    } catch (error) {
      repaired = { ok: false, reason: error.message };
    }
    if (!repaired?.ok) {
      // A Windows Server with no registered service has nothing to repair.
      // That is not a failed update, and it is never a reason to roll back.
      if (repaired?.code === 'not_installed') {
        serverNotRegistered = true;
        log(NOT_INSTALLED_SERVER_LINE);
        return finishWithoutService();
      }
      postUpdate = {
        ok: false,
        step: 'repair',
        reason: `the installed version has no post-update step, and this version's service repair failed: `
          + `${repaired?.reason ?? 'no result'}`,
      };
    }
  }

  if (!postUpdate.ok && postUpdate.code === 'not_installed') {
    serverNotRegistered = true;
    log(NOT_INSTALLED_SERVER_LINE);
    return finishWithoutService();
  }

  if (!postUpdate.ok) {
    const rolled = await rollback({
      version: from,
      service,
      exec,
      serviceInstalled: serviceSteps,
      transaction,
      dataDir,
      verifyMs,
      inspectLockFn: deps.inspectLock,
      restoreUpdateStateFn: deps.restoreUpdateState,
      log,
    });
    return fail({
      step: postUpdate.step || 'post-update',
      serviceInstalled: serviceSteps,
      reason: [
        postUpdate.reason || 'the newly installed post-update step failed',
        rolled.reason,
      ].filter(Boolean).join(' '),
      rolledBack: rolled.ok,
      reinstallFailed: rolled.reinstallFailed === true,
      restarted: rolled.started,
      restored: rolled.started,
      rollbackVersionConfirmed: rolled.versionConfirmed,
      rollbackReason: rolled.reason,
    });
  }

  // 7. Start, wait for the daemon's own heartbeat, and require the heartbeat
  // to report the target version. A matching package on disk is not proof.
  log('Starting the service on the new version...');
  let started;
  try {
    started = await service.start({ log });
  } catch (error) {
    started = { ok: false, reason: error.message };
  }
  if (!started.ok && started.code === 'not_installed') {
    // Between the status read and here the service turned out not to exist on
    // this Windows Server. The package is installed; say which command adds
    // the service, and never roll back for it.
    serverNotRegistered = true;
    log(NOT_INSTALLED_SERVER_LINE);
    return finishWithoutService();
  }
  let alive;
  try {
    alive = started.ok
      ? await service.waitForDaemon({ dataDir, timeoutMs: verifyMs })
      : { alive: false, waitedMs: 0 };
  } catch (error) {
    alive = { alive: false, waitedMs: 0, reason: error.message };
  }
  let running = alive.alive ? (alive.lock?.version ?? null) : null;
  if (alive.alive && !running) {
    try {
      running = (deps.inspectLock ?? inspectLock)({ dataDir }).lock?.version ?? null;
    } catch { /* reported as an unverified heartbeat below */ }
  }
  const versionConfirmed = sameVersion(running, version);

  if (started.ok && alive.alive && versionConfirmed) {
    let committed;
    try {
      committed = await (deps.commitUpdateState ?? commitUpdateState)(transaction, { log });
    } catch (error) {
      committed = { warnings: [`could not remove the update snapshot: ${error.message}`] };
      log(`warning: ${committed.warnings[0]}`);
    }
    return {
      ok: true,
      from,
      to: version,
      serviceInstalled: true,
      runningVersion: running,
      versionConfirmed,
      waitedMs: alive.waitedMs,
      refreshedCopy: installed?.mode === MODES.SERVER || installed?.mechanism === 'winsw',
      cleanupWarnings: committed.warnings ?? [],
      source,
    };
  }

  // 8. It did not come up as the target version: restore package, definitions
  // and runtime together, then require the old heartbeat.
  const why = started.ok
    ? alive.alive
      ? `the daemon reported v${running ?? 'an unknown version'}, not v${version}`
      : `it started but the daemon did not report in within ${Math.round(verifyMs / 1000)}s`
    : `the service could not be started: ${started.reason}`;

  log(`The new version did not come up (${why}). Rolling back to v${from}...`);
  const rolled = await rollback({
    version: from,
    service,
    exec,
    serviceInstalled: serviceSteps,
    transaction,
    dataDir,
    verifyMs,
    inspectLockFn: deps.inspectLock,
    restoreUpdateStateFn: deps.restoreUpdateState,
    log,
  });

  return fail({
    step: 'verify',
    serviceInstalled: serviceSteps,
    reason: [why, rolled.reason].filter(Boolean).join(' '),
    rolledBack: rolled.ok,
    reinstallFailed: rolled.reinstallFailed === true,
    restarted: rolled.started,
    restored: rolled.started,
    rollbackVersionConfirmed: rolled.versionConfirmed,
    rollbackReason: rolled.reason,
  });
}

/**
 * Whether the installed package at `sourceRoot` can run the `_post-update`
 * hand-off. A package that cannot is not a failure: it is an older target,
 * and this updater prepares the service itself.
 */
export function postUpdateSupport(sourceRoot) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  } catch {
    // No readable manifest — a synthetic or unusual layout. Keep the previous
    // behaviour and let the hand-off's own exit code decide.
    return { supported: true, assumed: true, version: null };
  }
  const found = String(manifest?.version ?? '');
  if (!isUpdateVersion(found)) {
    return { supported: true, assumed: true, version: found || null };
  }
  const release = found.replace(/-.*$/, '');
  if (compareVersions(release, POST_UPDATE_SINCE) < 0) {
    return {
      supported: false,
      version: found,
      reason: `the installed v${found} has no post-update step (it arrived in v${POST_UPDATE_SINCE}); `
        + 'using this version\'s service repair instead.',
    };
  }
  if (!fs.existsSync(path.join(sourceRoot, 'src', 'cli', 'menus', 'postUpdate.js'))) {
    return {
      supported: false,
      version: found,
      reason: `the installed v${found} does not contain its post-update command; `
        + 'using this version\'s service repair instead.',
    };
  }
  return { supported: true, version: found };
}

/**
 * Starts the newly installed package's post-update code in a new process.
 * Direct argv avoids shell quoting. `stdin: inherit` keeps sudo's password
 * prompt on the operator's terminal.
 *
 * The marker is the LAST line the child prints, after thousands of progress
 * lines from the runtime copy. 1.4.7 read the child's captured stdout, whose
 * tail is 64 KiB (core/shell.js): everything the child printed before that was
 * gone, so a marker printed early — or simply more than 64 KiB before the end —
 * was never found and a successful post-update was reported as a failure.
 *
 * So the child's output is read with `output: 'full'` (a generous cap, never a
 * silent cut) AND scanned line by line as it arrives, so the marker is found
 * wherever it is printed. Progress lines are passed to `log`.
 *
 * @param {Object} opts
 * @param {(line: string) => void} [opts.log]
 * @param {number} [opts.maxOutputBytes] Per-stream capture cap (default 8 MiB)
 */
export async function runPostUpdateHandoff({
  sourceRoot,
  version,
  dataDir,
  mode,
  mechanism,
  nodeExe,
  runFile: exec = runFile,
  log = () => {},
  maxOutputBytes = POST_UPDATE_MAX_OUTPUT_BYTES,
}) {
  const support = postUpdateSupport(sourceRoot);
  if (!support.supported) {
    return { ok: true, fallback: true, step: 'post-update-missing', reason: support.reason };
  }

  // The streamed scan: complete lines only, so a marker split across chunks is
  // still recognised, and nothing is kept beyond one line at a time.
  let markerLine = null;
  let pending = '';
  const scan = (text, stream) => {
    pending += text;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (!markerLine && line.startsWith(POST_UPDATE_RESULT_PREFIX)) {
        markerLine = line;
        continue;
      }
      if (stream !== 'stdout') continue;
      // Progress from the new package, one line at a time.
      if (line.trim()) log(line);
    }
    // A progress line can be enormous; the marker is one short line, so only
    // the start of an unfinished line is worth keeping.
    if (pending.length > 1_000_000) pending = pending.slice(0, 1_000_000);
  };

  const entry = path.join(sourceRoot, 'src', 'cli', 'index.js');
  const result = await exec(process.execPath, [entry, '_post-update'], {
    cwd: sourceRoot,
    timeout: 1_800_000,
    stdin: 'inherit',
    output: 'full',
    maxBytes: maxOutputBytes,
    onData: scan,
    env: {
      EASY_DEVOPS_DATA_DIR: dataDir,
      EZ_UPDATE_TARGET: version,
      EZ_UPDATE_MODE: mode ?? '',
      EZ_UPDATE_MECHANISM: mechanism ?? '',
      EZ_UPDATE_NODE_EXE: nodeExe ?? '',
    },
  });

  const capturedMarker = String(result?.stdout ?? '').split(/\r?\n/)
    .find((line) => line.startsWith(POST_UPDATE_RESULT_PREFIX));
  const marker = markerLine ?? capturedMarker ?? null;
  let parsed = null;
  if (marker) {
    try {
      parsed = JSON.parse(marker.slice(POST_UPDATE_RESULT_PREFIX.length));
    } catch { /* reported below */ }
  }
  if (!result?.success || !parsed?.ok) {
    const dropped = (Number(result?.truncated?.stdout) || 0) + (Number(result?.truncated?.stderr) || 0);
    const droppedNote = dropped > 0
      ? ` (${dropped} byte(s) of its output were dropped because it exceeded the capture cap)`
      : '';
    return {
      ok: false,
      step: parsed?.step ?? 'post-update',
      reason: (parsed?.reason
        || String(result?.stderr ?? '').trim()
        || result?.error
        || 'the newly installed post-update command exited without a result') + droppedNote,
    };
  }
  if (!sameVersion(parsed.version, version)) {
    return {
      ok: false,
      step: 'post-update-version',
      reason: parsed.version
        ? `the post-update command ran v${parsed.version}, expected v${version}`
        : `the post-update command did not report the version it loaded; expected v${version}`,
    };
  }
  return parsed;
}

/** Starts the service and waits for its own heartbeat. Never throws. */
async function startAndVerify({ service, dataDir, verifyMs, inspectLockFn, expectVersion, log }) {
  let started;
  try {
    started = await service.start({ log });
  } catch (error) {
    started = { ok: false, reason: error.message };
  }
  let alive;
  if (started?.ok) {
    try {
      alive = await service.waitForDaemon({ dataDir, timeoutMs: finiteMs(verifyMs, VERIFY_MS) });
    } catch (error) {
      alive = { alive: false, reason: error.message };
    }
  } else {
    alive = { alive: false };
  }
  let running = alive.alive ? (alive.lock?.version ?? null) : null;
  if (alive.alive && !running) {
    try {
      running = (inspectLockFn ?? inspectLock)({ dataDir }).lock?.version ?? null;
    } catch { /* reported as an unverified heartbeat below */ }
  }
  const versionConfirmed = sameVersion(running, expectVersion);
  return {
    started: Boolean(started?.ok && alive.alive),
    alive: Boolean(alive.alive),
    startedOk: Boolean(started?.ok),
    startReason: started?.reason ?? null,
    runningVersion: running,
    versionConfirmed,
    waitedMs: alive.waitedMs ?? null,
    reason: !started?.ok
      ? `the service could not be started again: ${started?.reason ?? 'unknown error'}`
      : !alive.alive
        ? `the service started but its heartbeat did not return${alive.reason ? `: ${alive.reason}` : ''}`
        : !versionConfirmed
          ? `the running service reported v${running ?? 'an unknown version'}, expected v${expectVersion}`
          : null,
  };
}

async function restoreStoppedService({
  service,
  dataDir,
  verifyMs,
  inspectLockFn,
  restoreUpdateStateFn = restoreUpdateState,
  transaction = null,
  from,
  log = () => {},
}) {
  let state = { ok: true, restored: true };
  if (transaction) {
    try {
      state = await restoreUpdateStateFn(transaction, { log });
    } catch (error) {
      state = { ok: false, reason: error.message };
    }
  }

  // Started even when the files could not be restored: a service left stopped
  // is the failure this whole path exists to prevent, and the new files may
  // still run where the restored ones could not.
  const running = await startAndVerify({
    service,
    dataDir,
    verifyMs,
    inspectLockFn,
    expectVersion: from,
    log,
  });

  if (!state.ok) {
    return {
      ...running,
      ok: false,
      stateRestored: false,
      reason: [`service files could not be restored: ${state.reason}`, running.reason]
        .filter(Boolean)
        .join(' '),
    };
  }
  return {
    ...running,
    ok: running.started && running.versionConfirmed,
    stateRestored: true,
  };
}

/** Reinstalls the old package and restores every service artifact together. */
async function rollback({
  version,
  service,
  exec,
  serviceInstalled,
  transaction,
  dataDir,
  verifyMs,
  inspectLockFn,
  restoreUpdateStateFn,
  log,
}) {
  let stopped;
  try {
    stopped = serviceInstalled ? await service.stop({ log }) : { ok: true };
  } catch (error) {
    stopped = { ok: false, reason: error.message };
  }
  if (!stopped.ok && !stopped.alreadyStopped) {
    // It may be down already: put it back on whatever version it can run and
    // say so, rather than leaving nothing running.
    const running = await startAndVerify({
      service,
      dataDir,
      verifyMs,
      inspectLockFn,
      expectVersion: version,
      log,
    });
    return {
      ...running,
      ok: false,
      reason: `the failed new service could not be stopped before rollback (${stopped.reason}). `
        + (running.reason ?? ''),
    };
  }

  closeDb();
  let back;
  try {
    back = await runNpm(['install', '-g', `${PACKAGE}@${version}`], { timeout: 600_000 }, exec);
  } catch (error) {
    back = { success: false, stdout: '', stderr: error.message };
  }
  back ??= { success: false, stdout: '', stderr: 'npm returned no result' };
  let dbError = null;
  try { initDb(); } catch (error) { dbError = error; }

  if (!serviceInstalled) {
    const failures = [];
    if (!back.success) failures.push(`could not reinstall v${version}: ${trim(back)}`);
    if (dbError) failures.push(`the package database could not be reopened after rollback: ${dbError.message}`);
    return {
      ok: failures.length === 0,
      started: false,
      stateRestored: false,
      versionConfirmed: false,
      reason: failures.join(' ') || null,
    };
  }

  const restored = await restoreStoppedService({
    service,
    dataDir,
    verifyMs,
    inspectLockFn,
    restoreUpdateStateFn,
    transaction,
    from: version,
    log,
  });
  if (!back.success) {
    restored.ok = false;
    restored.reinstallFailed = true;
    restored.reason = `could not reinstall v${version}: ${trim(back)}`
      + (restored.reason ? ` ${restored.reason}` : '')
      + (transaction?.root ? ` The previous service files remain at ${transaction.root}.` : '');
  } else if (dbError && !restored.versionConfirmed) {
    restored.ok = false;
    restored.reason = `the package database could not be reopened after rollback: ${dbError.message}`;
  }
  return restored;
}

/**
 * The end of a command's output, for an error message.
 *
 * 1.4.7 kept the FIRST 500 characters, which for npm is the banner and the
 * first progress lines — never the error, which is printed last. This keeps
 * the newest 500 and says when that is what it is. Output core/shell.js dropped
 * is reported too, so a cut capture is never mistaken for the whole story.
 */
function trim(result = {}) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const dropped = (Number(result.truncated?.stdout) || 0) + (Number(result.truncated?.stderr) || 0);
  // Count characters, not UTF-16 units: the slice is the last 500 characters,
  // and a surrogate pair at the boundary must not be split.
  const characters = [...text];
  const cut = characters.length > 500;
  const excerpt = cut ? characters.slice(-500).join('') : text;
  const notes = [];
  if (cut) notes.push('(last 500 characters)');
  if (dropped > 0) {
    notes.push(`(${dropped} earlier byte(s) were dropped because the captured output was capped)`);
  }
  return [notes.join(' '), excerpt].filter(Boolean).join('\n');
}

/**
 * The lines explaining why the Hub cannot run an update.
 *
 * Printed by `ezz update` on every run: the question "why can't I do this from
 * the Hub?" is asked once per user, and the answer belongs where they are
 * already looking. The dashboard CAN do it (Settings > Update, via the
 * detached worker), so the lines say so rather than claiming otherwise.
 *
 * @returns {string[]}
 */
export function whyCliOnly() {
  return [
    'The Hub cannot run this: the process performing the update is being',
    'replaced and stopped, so it could not report back. Use Settings > Update',
    'in the dashboard, or `ezz update` in a terminal - same flow either way.',
  ];
}

/** Where the dashboard is reachable, for the "it is back" line. */
export function dashboardUrl() {
  const config = loadConfig();
  return `http://localhost:${config.dashboardPort}`;
}
