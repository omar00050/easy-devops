/**
 * core/service/versionDrift.js
 *
 * The CLI package and the copy of it the background service runs are two
 * different files in Windows Server mode.
 *
 *   CLI      npm's global package (`npm i -g easy-devops`)
 *   service  C:\ProgramData\easy-devops\runtime\app  (copyRuntime)
 *
 * A plain `npm i -g easy-devops` on a Windows Server therefore updates the
 * command a person types and nothing else: the service keeps running the old
 * copy, including its old security problems, and nothing says so (finding A3
 * on a real server: `out.log` said v1.4.4 while `ezz --version` said 1.4.6).
 *
 * Everything here is a read of one or two `package.json` files. There is no
 * subprocess, no prompt and no database access, so it is safe to call from
 * every `ezz` command and from a status read. A value that cannot be read is
 * reported as unknown and never turned into a drift claim.
 *
 * OS branching stays in platform.js: the defaults below are the injected
 * platform functions, and a test replaces them instead of touching
 * `process.platform`.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { isWindows, isServerMode, programDataDir, DEV_MODE_ENV } from '../platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** This package's root on disk (`src/core/service` -> package root). */
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');

/** How often a running daemon re-checks the installed package version. */
export const DRIFT_CHECK_MS = 6 * 60 * 60 * 1000;

/** The package every version below describes. */
export const PACKAGE_NAME = 'easy-devops';

/**
 * Reads `package.json` and returns its version, or null.
 *
 * JSON.parse + a string check rather than `require()`, which caches: a package
 * replaced on disk must not be masked by a version this process loaded earlier.
 *
 * @param {string} file
 * @param {string} [expectedName] When given, the manifest must name this package
 * @returns {string|null}
 */
function readVersion(file, expectedName = null) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (expectedName && manifest?.name !== expectedName) return null;
  const version = manifest?.version;
  return typeof version === 'string' && version.trim() ? version.trim() : null;
}

function tryReadVersion(file, expectedName = null) {
  try {
    return { version: readVersion(file, expectedName), reason: null };
  } catch (error) {
    return {
      version: null,
      reason: error?.code === 'ENOENT'
        ? `${file} does not exist`
        : `${file} could not be read: ${error?.message ?? String(error)}`,
    };
  }
}

/** Parses a version into numeric core parts and optional prerelease parts. */
function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

/**
 * -1 / 0 / 1 by SemVer precedence, including prereleases.
 *
 * Local rather than imported from core/updater.js: that module reaches the
 * database and the service module graph, and this check runs before almost
 * every CLI command.
 */
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

function platformOf(deps = {}) {
  return deps.isWindows ?? isWindows;
}

function serverModeOf(deps = {}) {
  return (deps.isServerMode ?? isServerMode)();
}

function dataRoot(deps = {}) {
  return (deps.programDataDir ?? programDataDir)();
}

/**
 * `server` / `personal` / `linux` — the same labels the service module uses.
 * Linux and Windows Personal run the package the CLI runs, so they cannot
 * drift; only Windows Server has a separate runtime copy.
 */
export function driftMode({ deps = {} } = {}) {
  if (!platformOf(deps)) return 'linux';
  return serverModeOf(deps) ? 'server' : 'personal';
}

/**
 * This process's own package version — the CLI the user typed.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.deps]
 * @returns {string|null}
 */
export function cliVersion({ deps = {} } = {}) {
  if (typeof deps.cliVersion === 'function') return deps.cliVersion();
  if (typeof deps.cliVersion === 'string') return deps.cliVersion;

  const root = deps.packageRoot ?? PACKAGE_ROOT;
  return tryReadVersion(path.join(root, 'package.json'), PACKAGE_NAME).version;
}

/**
 * The version of the package the SERVICE actually runs.
 *
 * Windows Server: `<ProgramData>\easy-devops\runtime\app\package.json`, the
 * copy created by core/service/runtime.js.
 * Linux / Windows Personal: the package the unit or launcher points at, which
 * is this package, so the CLI version is the service version.
 *
 * Never throws. An unreadable manifest is `version: null` plus a reason.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {Object} [opts.deps]
 * @returns {{ version: string|null, path: string|null, source: 'cli'|'runtime', reason: string|null }}
 */
export function readServiceVersion({ dataDir = undefined, deps = {} } = {}) {
  const cli = cliVersion({ deps });

  if (driftMode({ deps }) !== 'server') {
    return { version: cli, path: null, source: 'cli', reason: null };
  }

  const file = path.join(dataRoot(deps), 'runtime', 'app', 'package.json');
  const read = tryReadVersion(file, PACKAGE_NAME);
  return { version: read.version, path: file, source: 'runtime', reason: read.reason };
}

/**
 * Whether the CLI and the service disagree.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {Object} [opts.deps]
 * @returns {{ drift: boolean, cliVersion: string|null, serviceVersion: string|null,
 *            mode: 'server'|'personal'|'linux', reason: string|null, message: string|null }}
 */
export function checkDrift({ dataDir = undefined, deps = {} } = {}) {
  const mode = driftMode({ deps });
  const cli = cliVersion({ deps });

  if (mode !== 'server') {
    return { drift: false, cliVersion: cli, serviceVersion: cli, mode, reason: null, message: null };
  }

  const service = readServiceVersion({ dataDir, deps });
  const drift = Boolean(cli && service.version && compareVersions(cli, service.version) !== 0);

  return {
    drift,
    cliVersion: cli,
    serviceVersion: service.version,
    mode,
    reason: service.reason,
    message: drift ? driftMessage({ serviceVersion: service.version, cliVersion: cli }) : null,
  };
}

/** The one sentence every surface prints, so they cannot drift apart. */
export function driftMessage({ serviceVersion, cliVersion: cli }) {
  return `The background service runs v${serviceVersion} but the CLI is v${cli}. `
    + 'Run `ezz service repair` as administrator to update the service.';
}

/**
 * Candidate directories for npm's GLOBAL copy of this package.
 *
 * Derived from the same places npm itself uses, and read without running
 * anything. The runtime copy is deliberately excluded: it is the service, not
 * the install a person updated.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.deps]
 * @returns {string[]}
 */
export function globalPackageRoots({ deps = {} } = {}) {
  const win = platformOf(deps);
  // Only Windows Server has a runtime copy to exclude. programDataDir() is a
  // Windows path and must not be resolved as a relative path elsewhere.
  const runtimeApp = win ? path.resolve(dataRoot(deps), 'runtime', 'app').toLowerCase() : null;
  const roots = [];
  const push = (root) => {
    if (!root) return;
    const resolved = path.resolve(root);
    if (runtimeApp && resolved.toLowerCase() === runtimeApp) return;
    if (!roots.includes(resolved)) roots.push(resolved);
  };

  const entries = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (win) {
    for (const dir of entries) push(path.join(dir, 'node_modules', PACKAGE_NAME));
    if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'npm', 'node_modules', PACKAGE_NAME));
    push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', PACKAGE_NAME));
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    if (programFilesX86) push(path.join(programFilesX86, 'nodejs', 'node_modules', PACKAGE_NAME));
    if (process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'npm', 'node_modules', PACKAGE_NAME));
  } else {
    // A global bin directory's sibling `lib/node_modules` is npm's layout.
    for (const dir of entries) {
      if (path.basename(dir) !== 'bin') continue;
      push(path.join(path.dirname(dir), 'lib', 'node_modules', PACKAGE_NAME));
    }
    push(path.join('/usr', 'lib', 'node_modules', PACKAGE_NAME));
    push(path.join('/usr', 'local', 'lib', 'node_modules', PACKAGE_NAME));
    if (process.env.HOME) push(path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules', PACKAGE_NAME));
  }

  return roots;
}

/**
 * The version of the package the CLI runs from, for the daemon to compare its
 * own version with. In Windows Server mode the daemon runs from the runtime
 * copy, so the global package is resolved; elsewhere they are the same package.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.deps]
 * @returns {string|null}
 */
export function readInstalledCliVersion({ dataDir = undefined, deps = {} } = {}) {
  if (deps.installedCliVersion !== undefined) return deps.installedCliVersion;

  if (driftMode({ deps }) !== 'server') return cliVersion({ deps });

  for (const root of globalPackageRoots({ deps })) {
    const read = tryReadVersion(path.join(root, 'package.json'), PACKAGE_NAME);
    if (read.version) return read.version;
  }
  return null;
}

/**
 * The daemon's own comparison: its runtime version against the installed CLI.
 *
 * @param {Object} opts
 * @param {string} opts.version The daemon's own version
 * @param {Object} [opts.deps]
 * @returns {{ drift: boolean, serviceVersion: string|null, installedVersion: string|null,
 *            cliVersion: string|null, newerInstalled: boolean, mode: string }}
 */
export function checkDaemonDrift({ dataDir = undefined, version, deps = {} } = {}) {
  const serviceVersion = version ? String(version) : readServiceVersion({ dataDir, deps }).version;
  const installedVersion = readInstalledCliVersion({ dataDir, deps });
  const same = serviceVersion && installedVersion
    ? compareVersions(serviceVersion, installedVersion) === 0
    : true;

  return {
    drift: Boolean(serviceVersion && installedVersion && !same),
    serviceVersion,
    installedVersion,
    cliVersion: installedVersion,
    newerInstalled: Boolean(serviceVersion && installedVersion
      && compareVersions(installedVersion, serviceVersion) > 0),
    mode: driftMode({ deps }),
  };
}

/** A `notification:new` event for a newer installed package. */
export function versionDriftNotification(check) {
  return {
    id: `service-version-drift-${check.serviceVersion}-${check.installedVersion}`,
    type: 'service_drift',
    subtype: 'newer_installed',
    severity: 'warning',
    message: driftMessage({ serviceVersion: check.serviceVersion, cliVersion: check.installedVersion }),
    serviceVersion: check.serviceVersion,
    installedVersion: check.installedVersion,
    timestamp: Date.now(),
  };
}

/**
 * Pairs already announced by THIS process. One notification per
 * `service -> installed` pair, however often the six-hour check runs. A daemon
 * restart is a fresh process and may announce the pair once more, which is
 * what makes a still-unfixed drift visible again after a reboot.
 */
const notifiedPairs = new Set();

/** For tests: forget what has been announced. */
export function resetVersionDriftNotifications() {
  notifiedPairs.clear();
}

/**
 * Checks once and publishes at most one `notification:new` for a newer
 * installed package. The publisher is injected so this module stays free of
 * the job bus and remains testable without one.
 *
 * @param {Object} opts
 * @param {string} [opts.version] The daemon's own version
 * @param {Object} [opts.deps] Injected platform, version and `publish`
 * @returns {Promise<Object>}
 */
export async function runVersionDriftCheck({ dataDir = undefined, version, deps = {} } = {}) {
  const check = (deps.checkDaemonDrift ?? checkDaemonDrift)({ dataDir, version, deps });

  if (!check.newerInstalled) return { ...check, notified: false, deduped: false };

  const key = `${check.serviceVersion}->${check.installedVersion}`;
  if (notifiedPairs.has(key)) return { ...check, notified: false, deduped: true };
  notifiedPairs.add(key);

  const event = (deps.buildEvent ?? versionDriftNotification)(check);
  try {
    if (typeof deps.publish === 'function') deps.publish('notification:new', event);
  } catch {
    /* a missing bus must not stop the daemon */
  }

  return { ...check, notified: true, deduped: false, event };
}

/** True when `child` is `parent` or inside it, case-insensitively on Windows. */
function isInside(child, parent, { win = isWindows } = {}) {
  if (!child || !parent) return false;
  const norm = (value) => (win ? path.resolve(value).toLowerCase() : path.resolve(value));
  const inside = norm(child);
  const root = norm(parent);
  return inside === root || inside.startsWith(root + path.sep);
}

/**
 * What the daemon checks once at start, and what `status` re-derives cheaply.
 *
 * It applies nothing that needs elevation. A stale stop request is cleared by
 * the caller (it owns the lock and the request file), and is reported here as
 * applied. Everything else is a warning for status, the Hub and the dashboard
 * banner; the daemon keeps running.
 *
 * It refuses for exactly one state: a data directory inside the package
 * folder, which an update would wipe. That is unsafe to run from, and the
 * message says what to move and what to run next.
 *
 * @param {Object} opts
 * @param {string} [opts.dataDir]
 * @param {string} [opts.version] The daemon's own version
 * @param {Object|null} [opts.record] The `service-state` record, when available
 * @param {boolean} [opts.installed] A native service is installed
 * @param {boolean} [opts.staleStopRequest] A spent stop request was found
 * @param {Object} [opts.deps]
 * @returns {{ ok: boolean, refused: boolean, warnings: string[], applied: string[],
 *            drift: Object|null, reason: string|null, next: string|null }}
 */
export function assessStartup({
  dataDir = undefined,
  version = null,
  record = null,
  installed = true,
  staleStopRequest = false,
  deps = {},
} = {}) {
  const warnings = [];
  const applied = [];
  const mode = driftMode({ deps });
  const root = deps.packageRoot ?? PACKAGE_ROOT;

  // `--dev` deliberately keeps its throwaway data in the checkout. It is not a
  // real installation, and an update does not run over it, so it is not the
  // unsafe state this refuses.
  const devData = process.env[DEV_MODE_ENV] === '1'
    || path.basename(path.resolve(dataDir ?? '.')) === '.dev-data';

  if (dataDir && !devData && isInside(dataDir, root, { win: platformOf(deps) })) {
    return {
      ok: false,
      refused: true,
      warnings,
      applied,
      drift: null,
      reason: `the data directory ${dataDir} is inside the Easy DevOps package folder ${root}. `
        + 'An update replaces that folder, so the database and settings would be lost. '
        + 'Move the data outside the package (or run `ezz service repair` to restore the '
        + 'recorded location), then start the service again.',
      next: 'ezz service repair',
    };
  }

  const drift = checkDaemonDrift({ dataDir, version, deps });
  if (drift.newerInstalled) {
    warnings.push(driftMessage({
      serviceVersion: drift.serviceVersion,
      cliVersion: drift.installedVersion,
    }));
  }

  // Windows Server only: the protections are applied by install/repair and
  // recorded there. A record without them was written by a release before
  // 1.4.7, or the install was interrupted — the files may be unprotected.
  if (mode === 'server' && installed) {
    const protections = record?.protections ?? record?.protection ?? null;
    const granted = Array.isArray(record?.granted) ? record.granted : [];
    const recorded = Boolean(
      (protections && protections.ok !== false) || granted.length > 0,
    );
    if (!recorded) {
      warnings.push(
        'The service files have no recorded permission check, so they may be missing or out of date. '
        + 'Run `ezz service repair` in an Administrator PowerShell before relying on this service.',
      );
    }
  }

  if (staleStopRequest) applied.push('cleared a stop request left by an earlier daemon');

  return { ok: true, refused: false, warnings, applied, drift, reason: null, next: null };
}

/**
 * The warnings a status read can show without trusting a running daemon.
 * Re-derived from the same inputs as `assessStartup`.
 *
 * @param {Object} opts
 * @returns {string[]}
 */
export function startupWarnings({ dataDir = undefined, version = null, record = null, installed = true, deps = {} } = {}) {
  const result = assessStartup({ dataDir, version, record, installed, deps });
  return result.refused ? [result.reason] : result.warnings;
}
