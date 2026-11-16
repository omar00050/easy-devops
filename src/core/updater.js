/**
 * core/updater.js
 *
 * Updating Easy DevOps itself.
 *
 * ── Why this is not a dashboard feature, and not a Hub command ─────────────
 *
 * The process that would perform the update is the process being replaced.
 * `npm install -g` overwrites the package directory the dashboard is running
 * from, and the background service has to be stopped so the files it holds
 * open can be replaced — on Windows an open handle makes the install fail
 * outright. A request that arrives over HTTP or over the Hub socket cannot
 * survive its own server being stopped, so it could report neither success nor
 * failure: the connection would simply end mid-update, and whatever happened
 * next would be invisible.
 *
 * Doing it from a terminal means someone is watching, the output is visible,
 * and a failure can be rolled back while they are still there. That is not a
 * limitation to be engineered around; it is the correct shape for an operation
 * that replaces the running code. A later design could hand the work to a
 * short-lived detached helper that reports back afterwards — until then, the
 * CLI is the honest answer and the output says so.
 *
 * ── Why the install source is detected first ───────────────────────────────
 *
 * On a git clone, `npm install -g easy-devops` installs a SECOND copy from the
 * registry and leaves the service running the clone. The update then reports
 * success and changes nothing that runs. So the source is established before
 * anything else, and a clone is told to `git pull` instead — which this tool
 * deliberately does not run on the user's behalf: a pull can conflict, and the
 * working tree may hold work in progress. See core/installSource.js.
 */

import path from 'path';
import { createRequire } from 'module';

import { run } from './shell.js';
import { getDataDir, isWindows } from './platform.js';
import { closeDb, initDb } from './db.js';
import { detectInstallSource, describeUnmanaged } from './installSource.js';
import { inspect as inspectLock } from './daemon/lock.js';
import { loadConfig } from './config.js';
import { copyRuntime, runtimeDir } from './service/runtime.js';
import { MODES } from './service/index.js';

const require = createRequire(import.meta.url);

/** The npm package name, in one place. */
export const PACKAGE = 'easy-devops';

/** How long to wait for the daemon to report in after the restart. */
export const VERIFY_MS = 10_000;

/** This package's version, read fresh so a post-update read is accurate. */
export function currentVersion() {
  return String(require('../../package.json').version);
}

/** -1 / 0 / 1 by semver-ish triple. */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? '').replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/**
 * What the registry has.
 *
 * @param {Object} [opts]
 * @returns {Promise<{ reachable: boolean, current: string, latest: string|null, updateAvailable: boolean }>}
 */
export async function checkForUpdate({ deps = {} } = {}) {
  const exec = deps.run ?? run;
  const current = deps.currentVersion ? deps.currentVersion() : currentVersion();

  const result = await exec(`npm view ${PACKAGE} version`, { timeout: 30_000 });
  const latest = result.success ? result.stdout.trim().split('\n').pop()?.trim() : null;

  if (!latest || !/^\d+\.\d+\.\d+/.test(latest)) {
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
  const exec = deps.run ?? run;
  const service = deps.service ?? (await import('./service/index.js'));
  const source = (deps.detectInstallSource ?? detectInstallSource)();
  const from = deps.currentVersion ? deps.currentVersion() : currentVersion();

  // 1. Can npm update THIS copy at all?
  if (!source.npmUpdatable) {
    return {
      ok: false,
      step: 'source',
      source,
      from,
      // Not an error the caller has to phrase: the module that knows why also
      // knows what to run instead.
      lines: describeUnmanaged(source, 'update'),
      reason: `this copy is ${source.reason}, which npm does not update in place`,
      untouched: true,
    };
  }

  // 2. What is installed, decided BEFORE the files are replaced.
  let installed = null;
  try {
    installed = await service.status();
  } catch { /* unreadable: treated as "no service" below */ }
  const serviceInstalled = Boolean(installed?.service?.installed);
  const serverMode = installed?.mode === MODES.SERVER;

  // 3. Stop the service. Its files are the ones npm is about to replace, and
  // on Windows an open handle makes the install fail rather than wait.
  if (serviceInstalled) {
    log('Stopping the background service...');
    const stopped = await service.stop({ log });
    if (!stopped.ok && !stopped.alreadyStopped) {
      return {
        ok: false,
        step: 'stop',
        from,
        reason: stopped.reason,
        needsElevation: stopped.needsElevation ?? false,
        untouched: true,
      };
    }
  } else {
    log('No background service is installed; updating the package only.');
  }

  // 4. Replace the package. The SQLite handle is closed first: on Windows an
  // open database file cannot be renamed, and npm renames the whole directory.
  closeDb();

  log(`Installing ${PACKAGE}@${version}...`);
  const install = await exec(`npm install -g ${PACKAGE}@${version}`, { timeout: 600_000 });

  initDb();

  if (!install.success) {
    const restarted = serviceInstalled ? await service.start({ log }) : { ok: true };
    return {
      ok: false,
      step: 'install',
      from,
      reason: `npm install -g ${PACKAGE}@${version} failed:\n${trim(install)}`,
      restarted: restarted.ok,
    };
  }

  // 5. Windows Server mode runs from a COPY under ProgramData, so replacing
  // the package has not changed what the service executes. Refresh it, or the
  // update silently does nothing to the running service.
  let copied = null;
  if (isWindows && serverMode) {
    log('Refreshing the service runtime copy...');
    copied = (deps.copyRuntime ?? copyRuntime)({
      dataDir,
      appRoot: source.root,
      nodeExe: path.join(runtimeDir(dataDir), 'node.exe'),
      log: (line) => log(`  ${line}`),
    });
    if (!copied.ok) {
      const rolled = await rollback({ version: from, service, exec, serviceInstalled, log });
      return {
        ok: false,
        step: 'copy',
        from,
        reason: `the package was updated but the service copy could not be refreshed: ${copied.reason}`,
        rolledBack: rolled.ok,
        restored: rolled.started,
      };
    }
  }

  // 6. Start, and wait for the daemon's own heartbeat.
  if (!serviceInstalled) {
    return { ok: true, from, to: version, serviceInstalled: false, source };
  }

  log('Starting the service on the new version...');
  const started = await service.start({ log });
  const alive = started.ok
    ? await service.waitForDaemon({ dataDir, timeoutMs: deps.verifyMs ?? VERIFY_MS })
    : { alive: false, waitedMs: 0 };

  if (started.ok && alive.alive) {
    // The lock carries the version the running daemon reports, which is the
    // only proof that the NEW code is what came up.
    const running = (deps.inspectLock ?? inspectLock)({ dataDir }).lock?.version ?? null;
    return {
      ok: true,
      from,
      to: version,
      serviceInstalled: true,
      runningVersion: running,
      versionConfirmed: running ? compareVersions(running, version) === 0 : false,
      waitedMs: alive.waitedMs,
      refreshedCopy: Boolean(copied?.ok),
      source,
    };
  }

  // 7. It did not come up: put the old version back.
  const why = started.ok
    ? `it started but the daemon did not report in within ${Math.round((deps.verifyMs ?? VERIFY_MS) / 1000)}s`
    : `the service could not be started: ${started.reason}`;

  log(`The new version did not come up (${why}). Rolling back to v${from}...`);
  const rolled = await rollback({ version: from, service, exec, serviceInstalled, log });

  return {
    ok: false,
    step: 'verify',
    from,
    to: version,
    reason: why,
    rolledBack: rolled.ok,
    restored: rolled.started,
    rollbackReason: rolled.reason,
  };
}

/** Reinstalls a known-good version and starts the service again. */
async function rollback({ version, service, exec, serviceInstalled, log }) {
  closeDb();
  const back = await exec(`npm install -g ${PACKAGE}@${version}`, { timeout: 600_000 });
  initDb();

  if (!back.success) {
    return { ok: false, started: false, reason: `could not reinstall v${version}: ${trim(back)}` };
  }

  if (!serviceInstalled) return { ok: true, started: true };

  const started = await service.start({ log });
  return { ok: true, started: Boolean(started.ok) };
}

function trim(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(0, 500);
}

/**
 * The lines explaining why this is a terminal-only operation.
 *
 * Printed by `ezz update` on every run, successful or not: the question "why
 * can't I do this from the dashboard?" is asked once per user, and the answer
 * belongs where they are already looking.
 *
 * @returns {string[]}
 */
export function whyCliOnly() {
  return [
    'Updating from the dashboard or the Hub is not possible yet:',
    'the process that performs the update is the one being replaced and',
    'stopped, so it could not report what happened. A terminal can.',
  ];
}

/** Where the dashboard is reachable, for the "it is back" line. */
export function dashboardUrl() {
  const config = loadConfig();
  return `http://localhost:${config.dashboardPort}`;
}
