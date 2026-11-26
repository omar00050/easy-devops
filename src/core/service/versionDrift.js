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
 * Everything here is a read of a few files — one or two `package.json`, the
 * daemon's lock, the systemd unit, the install record, and (only when a
 * ProgramData database is actually there) a read-only database inspection.
 * There is no subprocess, no prompt and no write, so it is safe to call from
 * every `ezz` command and from a status read. A value that cannot be read is
 * reported as unknown and never turned into a drift claim.
 *
 * OS branching stays in platform.js: the defaults below are the injected
 * platform functions, and a test replaces them instead of touching
 * `process.platform`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  isWindows,
  isServerMode,
  programDataDir,
  getDataDir,
  getStartupFolder,
  DEV_MODE_ENV,
} from '../platform.js';
import { inspect as inspectDaemonLock } from '../daemon/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** This package's root on disk (`src/core/service` -> package root). */
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * A registered Windows service's own definition, beside the wrapper WinSW runs.
 *
 * Its presence is evidence that a service was installed even when the
 * Server-mode marker is gone — the state 1.4.7 left on the owner's server. A
 * file check only: nothing is opened, run or queried.
 */
export const WINDOWS_SERVICE_DEFINITION = path.join('bin', 'EasyDevOps.xml');

/** The systemd unit, matching UNIT_PATH in core/service/systemd.js. */
export const LINUX_UNIT_PATH = '/etc/systemd/system/easy-devops.service';

/** The Startup launcher and the supervisor, matching core/service/windowsPersonal.js. */
export const PERSONAL_LAUNCHER_FILE = 'easy-devops-daemon.cmd';
export const PERSONAL_SUPERVISOR_FILE = 'daemon-supervisor.cmd';

/**
 * The install record, matching INSTALL_PROGRESS_FILE in
 * core/service/windowsService.js. Duplicated on purpose: this check runs before
 * almost every CLI command and must stay a file read, not an import of the
 * service manager's module graph.
 */
export const INSTALL_PROGRESS_FILE = 'install-progress.json';

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

function dataDirectory(dataDir, deps = {}) {
  return dataDir ?? (deps.getDataDir ?? getDataDir)();
}

/**
 * The ProgramData root this process may look at.
 *
 * Under EZ_TEST a suite never reads the real machine-wide installation, not
 * even for a file check — the same rule core/service/dataDir.js applies to the
 * database: a root inside the system temp folder (what the EZ_TEST-aware
 * %ProgramData% override resolves to) belongs to the suite, the real one does
 * not. `null` means "do not look".
 */
function programDataRoot(deps = {}) {
  const root = dataRoot(deps);
  if (testSkipsRealPath(deps.programDataDir)) {
    const temp = path.resolve(os.tmpdir()).toLowerCase();
    const resolved = path.resolve(root).toLowerCase();
    if (!(resolved === temp || resolved.startsWith(temp + path.sep))) return null;
  }
  return root;
}

/** True when the path exists. A read: never a write, never a subprocess. */
function fileExists(file) {
  if (!file) return false;
  try {
    return Boolean(fs.statSync(file));
  } catch {
    return false;
  }
}

/**
 * Under EZ_TEST a suite must not read the machine's real service files.
 *
 * The same rule as core/service/dataDir.js: an injected path belongs to the
 * suite; anything else is the real installation and answers "not there".
 */
function testSkipsRealPath(injected) {
  return process.env.EZ_TEST === '1' && injected === undefined;
}

/**
 * Whether a native service is defined on this machine — a FILE check only.
 *
 *  - Linux:              the systemd unit exists.
 *  - Windows Server:     the Server-mode marker, or `bin\EasyDevOps.xml`.
 *  - Windows Personal:   the Startup launcher, or the supervisor beside the data.
 *
 * No `sc query`, no `systemctl`, no registry: this is what makes the start-up
 * check cheap enough for every command.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {Object} [opts.deps]
 * @returns {{ exists: boolean, kind: 'systemd'|'winsw'|'startup-supervisor'|null, path: string|null }}
 */
export function serviceDefinition({ dataDir = undefined, deps = {} } = {}) {
  if (!platformOf(deps)) {
    const unitPath = deps.unitPath ?? LINUX_UNIT_PATH;
    const exists = testSkipsRealPath(deps.unitPath) ? false : fileExists(unitPath);
    return { exists, kind: 'systemd', path: unitPath };
  }

  const programRoot = programDataRoot(deps);
  const xml = programRoot ? path.join(programRoot, WINDOWS_SERVICE_DEFINITION) : null;
  if (serverModeOf(deps) || (xml && fileExists(xml))) {
    return { exists: true, kind: 'winsw', path: xml };
  }

  const startupDir = deps.startupDir ?? (testSkipsRealPath(deps.startupDir) ? null : getStartupFolder());
  const launcher = startupDir ? path.join(startupDir, PERSONAL_LAUNCHER_FILE) : null;
  if (fileExists(launcher)) return { exists: true, kind: 'startup-supervisor', path: launcher };

  const supervisor = dataDir ? path.join(dataDir, PERSONAL_SUPERVISOR_FILE) : null;
  if (fileExists(supervisor)) return { exists: true, kind: 'startup-supervisor', path: supervisor };

  return { exists: false, kind: null, path: launcher };
}

/**
 * `server` / `personal` / `linux` — the same labels the service module uses.
 * Linux and Windows Personal run the package the CLI runs, so they cannot
 * drift; only Windows Server has a separate runtime copy.
 *
 * Server mode is claimed by the marker OR by a registered service's own
 * definition (`bin\EasyDevOps.xml`). The marker alone was the 1.4.7 bug: with
 * no marker the CLI decided "%APPDATA%" while ProgramData still held the real
 * data and the service.
 */
export function driftMode({ dataDir = undefined, deps = {} } = {}) {
  if (!platformOf(deps)) return 'linux';
  if (serverModeOf(deps)) return 'server';
  const definition = serviceDefinition({ dataDir, deps });
  if (definition.kind === 'winsw') return 'server';
  return 'personal';
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
 * The package root a systemd `ExecStart` entry names, by the layout we ship.
 * The same rule as packageRootFor() in core/service/systemd.js.
 */
function packageRootForEntry(entry) {
  const dir = path.posix.dirname(entry);
  if (path.posix.basename(dir) === 'cli' && path.posix.basename(path.posix.dirname(dir)) === 'src') {
    return path.posix.dirname(path.posix.dirname(dir));
  }
  return dir;
}

/** Splits one ExecStart value into arguments, honouring unitArg's quoting. */
function unitArguments(value) {
  const tokens = String(value).match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
  return tokens.map((token) => {
    if (!token.startsWith('"')) return token;
    try { return JSON.parse(token); } catch { return token.slice(1, -1); }
  });
}

/** The `<root>/src/cli/index.js` argument of a unit's ExecStart, or null. */
function unitEntryScript(text) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq === -1 || line.slice(0, eq).trim() !== 'ExecStart') continue;
    const entry = unitArguments(line.slice(eq + 1).trim())
      .find((arg) => /(?:^|[\\/])src[\\/]cli[\\/]index\.js$/.test(arg));
    if (entry) return entry;
  }
  return null;
}

/** The version of the package the installed unit's ExecStart runs. */
function readUnitPackage({ deps = {} } = {}) {
  const unitPath = deps.unitPath ?? LINUX_UNIT_PATH;
  if (testSkipsRealPath(deps.unitPath)) {
    return { version: null, path: unitPath, reason: 'EZ_TEST=1, so the real systemd unit was not read' };
  }

  let text;
  try {
    text = fs.readFileSync(unitPath, 'utf8');
  } catch (error) {
    return {
      version: null,
      path: unitPath,
      reason: error?.code === 'ENOENT'
        ? `${unitPath} does not exist`
        : `${unitPath} could not be read: ${error?.message ?? String(error)}`,
    };
  }

  const entry = unitEntryScript(text);
  if (!entry) {
    return { version: null, path: unitPath, reason: `${unitPath} names no Easy DevOps entry in ExecStart` };
  }

  const file = path.posix.join(packageRootForEntry(entry), 'package.json');
  const read = tryReadVersion(file, PACKAGE_NAME);
  return { version: read.version, path: file, reason: read.reason };
}

/**
 * The version the daemon itself reports, from its lock file.
 *
 * core/daemon/lock.js records `version` on every heartbeat, so a RUNNING daemon
 * answers this without any subprocess. A lock whose owner is gone is ignored:
 * after `ezz service repair` replaced the runtime copy, a dead lock still
 * describes the code that ran before the repair, and trusting it would report
 * a drift that no longer exists.
 */
function daemonReportedVersion({ dataDir = undefined, deps = {} } = {}) {
  const dir = dataDirectory(dataDir, deps);
  let state = null;
  try {
    state = (deps.inspectLock ?? inspectDaemonLock)({ dataDir: dir, now: deps.now });
  } catch {
    state = null;
  }
  const version = state?.running && typeof state.lock?.version === 'string'
    ? state.lock.version.trim()
    : '';
  return { version: version || null, path: dir ? path.join(dir, 'daemon.lock') : null };
}

/**
 * The version of the package the SERVICE actually runs.
 *
 * In order:
 *  1. what a RUNNING daemon reports in its lock file — it is the one running;
 *  2. Windows Server: `<ProgramData>\easy-devops\runtime\app\package.json`;
 *  3. Linux: the package the installed unit's ExecStart entry belongs to;
 *  4. Windows Personal: this package, because the launcher runs it.
 *
 * With no service definition and no recorded install the answer is `null`:
 * reporting the CLI's own version as the service's was the 1.4.7 bug ("Service
 * version 1.4.7" with no service installed at all).
 *
 * Never throws. An unreadable manifest is `version: null` plus a reason.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {Object} [opts.deps]
 * @returns {{ version: string|null, path: string|null,
 *   source: 'daemon'|'runtime'|'unit'|'launcher'|'cli', reason: string|null }}
 */
export function readServiceVersion({ dataDir = undefined, deps = {} } = {}) {
  const dir = dataDirectory(dataDir, deps);
  const mode = driftMode({ dataDir: dir, deps });

  const daemon = daemonReportedVersion({ dataDir: dir, deps });
  if (daemon.version) {
    return { version: daemon.version, path: daemon.path, source: 'daemon', reason: null };
  }

  const definition = serviceDefinition({ dataDir: dir, deps });

  if (mode === 'server') {
    const programRoot = programDataRoot(deps);
    if (!programRoot) {
      return {
        version: null,
        path: null,
        source: 'runtime',
        reason: 'EZ_TEST=1, so the real ProgramData runtime copy was not read',
      };
    }
    const file = path.join(programRoot, 'runtime', 'app', 'package.json');
    if (!definition.exists) {
      return {
        version: null,
        path: file,
        source: 'runtime',
        reason: `no Easy DevOps service is registered (${definition.path ?? 'its definition'} is missing), `
          + `so the runtime copy under ${programRoot} is not the service`,
      };
    }
    const read = tryReadVersion(file, PACKAGE_NAME);
    return { version: read.version, path: file, source: 'runtime', reason: read.reason };
  }

  if (mode === 'linux') {
    const unit = readUnitPackage({ deps });
    return { version: unit.version, path: unit.path, source: 'unit', reason: unit.reason };
  }

  if (!definition.exists) {
    return {
      version: null,
      path: definition.path,
      source: 'launcher',
      reason: 'no Easy DevOps service is installed, so there is no service version',
    };
  }
  return {
    version: cliVersion({ deps }),
    path: path.join(deps.packageRoot ?? PACKAGE_ROOT, 'package.json'),
    source: 'cli',
    reason: null,
  };
}

/**
 * Whether the CLI and the service disagree.
 *
 * Personal mode has no second copy, so it can never drift. A null service
 * version is "unknown", never drift.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {Object} [opts.deps]
 * @returns {{ drift: boolean, cliVersion: string|null, serviceVersion: string|null,
 *            mode: 'server'|'personal'|'linux', reason: string|null, message: string|null }}
 */
export function checkDrift({ dataDir = undefined, deps = {} } = {}) {
  const mode = driftMode({ dataDir, deps });
  const cli = cliVersion({ deps });

  // Windows Personal runs this same package, so there is no second copy to
  // compare against.
  if (mode === 'personal') {
    const service = readServiceVersion({ dataDir, deps });
    return { drift: false, cliVersion: cli, serviceVersion: service.version, mode, reason: service.reason, message: null };
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

/** The versions-only half of driftMessage(): the sentence, without the command. */
export function driftSummary({ serviceVersion, cliVersion: cli }) {
  return `The background service runs v${serviceVersion} but the CLI is v${cli}.`;
}

/** The one sentence every surface prints, so they cannot drift apart. */
export function driftMessage({ serviceVersion, cliVersion: cli }) {
  return `${driftSummary({ serviceVersion, cliVersion: cli })} `
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

// ─── The start-up health check (`ezz` on a server that needs repair) ─────────

/**
 * The install record, read as a plain file.
 *
 * A missing, half-written or unreadable file is "no record": it only ever costs
 * a re-run of steps that are idempotent anyway.
 *
 * @param {string} dataDir
 * @param {Object} [deps]
 * @returns {{ failedStep: string|null, version: string|null }|null}
 */
function readInstallProgressRecord(dataDir, deps = {}) {
  if (typeof deps.readInstallProgress === 'function') {
    try {
      const read = deps.readInstallProgress(dataDir);
      return read && typeof read.failedStep === 'string' ? read : null;
    } catch {
      return null;
    }
  }
  if (!dataDir) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, INSTALL_PROGRESS_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      failedStep: typeof parsed.failedStep === 'string' ? parsed.failedStep : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
    };
  } catch {
    return null;
  }
}

/**
 * The one sentence an interrupted install prints, used by the CLI and by the
 * daemon's start-up check so they cannot drift apart.
 *
 * @param {string} failedStep A step name from windowsService.INSTALL_STEPS
 * @returns {string}
 */
export function installUnfinishedMessage(failedStep) {
  return `Install not finished (stopped at ${failedStep}): run \`ezz service install\` to resume.`;
}

/** "15 keys", or an honest unknown. */
function describeKeys(side) {
  const db = side?.db ?? null;
  if (db && db.ok !== false && Number.isFinite(db.keyCount)) return `${db.keyCount} keys`;
  return 'an unknown number of keys';
}

function leftoverProblem(leftover, { dataDir, win }) {
  const programDir = leftover?.programData?.dir ?? 'C:\\ProgramData\\easy-devops';
  const args = ['service', 'install'];
  return {
    kind: 'leftover-data',
    // Key COUNTS only: never a key name, never a value. The comparison is what
    // tells the owner which side holds the real data.
    message: `An earlier Server-mode install's data is in ${programDir} `
      + `(${describeKeys(leftover?.programData)}) but this CLI is using ${dataDir} `
      + `(${describeKeys(leftover?.userData)}). `
      + 'Run `ezz service install` to choose: it will ask, or pass '
      + '`--adopt-existing-data` (keep the ProgramData data as it is) or '
      + '`--set-aside-existing-data` (move it to easy-devops.old-<date> first).',
    args,
    command: `${win ? '' : 'sudo '}ezz ${args.join(' ')}`,
    what: 'Installing the background service',
  };
}

function installUnfinishedProblem(progress, { win }) {
  const args = ['service', 'install'];
  return {
    kind: 'install-unfinished',
    message: installUnfinishedMessage(progress.failedStep),
    args,
    command: `${win ? '' : 'sudo '}ezz ${args.join(' ')}`,
    what: 'Resuming the background service install',
  };
}

function versionDriftProblem(drift, { win }) {
  const args = ['service', 'repair'];
  return {
    kind: 'version-drift',
    message: win
      ? driftMessage({ serviceVersion: drift.serviceVersion, cliVersion: drift.cliVersion })
      : `${driftSummary({ serviceVersion: drift.serviceVersion, cliVersion: drift.cliVersion })} `
        + 'Run `sudo ezz service repair` to update the service.',
    args,
    command: `${win ? '' : 'sudo '}ezz ${args.join(' ')}`,
    what: 'Updating the background service',
  };
}

/**
 * What a plain `ezz` command should notice about the service, in the order that
 * decides the fix:
 *
 *  (a) an earlier Server-mode install's data left in ProgramData while the CLI
 *      uses another directory — install chooses, and must not overwrite;
 *  (b) an install that stopped at a step — install resumes;
 *  (c) the service's copy runs a different version from the CLI — repair.
 *
 * FILE READS ONLY: the ProgramData database is opened read-only by
 * detectLeftoverServerData and only when the marker is missing AND a database
 * file is actually there, so a healthy machine never pays for it. No `sc.exe`,
 * no `icacls`, no registry, no `systemctl`.
 *
 * Returns every problem found — the caller reports and acts on the FIRST one,
 * because (a)'s install also settles (b) and (c), and offering `repair` to a
 * server that needs `install` is the false advice this release removes.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {Object} [opts.deps]
 * @returns {Promise<{ dataDir: string, mode: string, problems: Object[] }>}
 */
export async function serviceStartupProblems({ dataDir = undefined, deps = {} } = {}) {
  const dir = dataDirectory(dataDir, deps);
  const win = platformOf(deps);
  const problems = [];

  if (win) {
    const programRoot = programDataRoot(deps);
    if (programRoot
        && !fileExists(path.join(programRoot, '.server-mode'))
        && fileExists(path.join(programRoot, 'easy-devops.sqlite'))) {
      let leftover = null;
      try {
        const detect = deps.detectLeftoverServerData
          ?? (await import('./dataDir.js')).detectLeftoverServerData;
        leftover = await detect({ programDataDir: programRoot, userDataDir: dir });
      } catch {
        // A detection failure is not a reason to warn wrongly, and not a reason
        // to fail the command the user typed.
        leftover = null;
      }
      if (leftover?.leftover) problems.push(leftoverProblem(leftover, { dataDir: dir, win }));
    }
  }

  const progress = readInstallProgressRecord(dir, deps);
  if (progress?.failedStep) problems.push(installUnfinishedProblem(progress, { win }));

  let drift = null;
  try {
    drift = (deps.checkDrift ?? checkDrift)({ dataDir: dir, deps });
  } catch {
    drift = null;
  }
  if (drift?.drift) problems.push(versionDriftProblem(drift, { win }));

  return { dataDir: dir, mode: driftMode({ dataDir: dir, deps }), problems };
}

function defaultInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Prints the start-up warning and, in an interactive terminal only, offers the
 * fix. It never fixes anything by itself.
 *
 * Windows: `requireElevation()` shows its "Relaunch as administrator?" prompt
 * (injected by the CLI, which owns that module) and hands off to an elevated
 * window. Linux: there is no elevation helper, and sudo must ask in the user's
 * own terminal, so the exact `sudo` command is printed and nothing is run —
 * never a password, never a non-interactive sudo. A pipe, a script or CI gets
 * the warning and the command only.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {Object} [opts.deps] `write`, `isInteractive`, `requireElevation`, detection deps
 * @returns {Promise<{ problems: Object[], problem: Object|null, asked: boolean,
 *   handedOff: boolean, exitCode: number }>}
 */
export async function runServiceStartupCheck({ dataDir = undefined, deps = {} } = {}) {
  const report = await serviceStartupProblems({ dataDir, deps });
  const write = deps.write ?? ((text) => process.stderr.write(text));
  const win = platformOf(deps);

  if (report.problems.length === 0) {
    return { ...report, problem: null, asked: false, handedOff: false, exitCode: 0 };
  }

  const problem = report.problems[0];
  write(`\n  Warning: ${problem.message}\n`);
  write('  The background service cannot update its own files; run the command above once.\n\n');

  if (!(deps.isInteractive ?? defaultInteractive)()) {
    return { ...report, problem, asked: false, handedOff: false, exitCode: 0 };
  }

  if (!win) {
    write('  Run that command in this terminal; sudo asks for your password there.\n\n');
    return { ...report, problem, asked: false, handedOff: false, exitCode: 0 };
  }

  if (typeof deps.requireElevation !== 'function') {
    return { ...report, problem, asked: false, handedOff: false, exitCode: 0 };
  }

  let gate;
  try {
    gate = await deps.requireElevation({ args: problem.args, what: problem.what });
  } catch {
    // A failed prompt is not a failed command; the warning has been printed.
    return { ...report, problem, asked: true, handedOff: false, exitCode: 0 };
  }

  return {
    ...report,
    problem,
    asked: true,
    handedOff: Boolean(gate && gate.proceed === false && gate.code === 0),
    exitCode: gate && gate.proceed === false ? Number(gate.code ?? 0) : 0,
  };
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
 * @param {Object|null} [opts.record] The `service-state` record (kept in the
 *   signature for callers; permissions are no longer judged from it)
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
  const mode = driftMode({ dataDir, deps });
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

  // Windows Server only, and only while the record says an install STOPPED:
  // a daemon starting on a half-installed server must say where install
  // stopped, because `repair` would hit the same step.
  //
  // The old line here — "the service files have no recorded permission check"
  // — came from a stale `service-state` record and told a healthy 1.4.7 server
  // to run repair, which then hit the ACL bug. Permissions are now measured
  // live by `status`; this file only reports what a record can prove.
  if (mode === 'server' && installed) {
    const progress = readInstallProgressRecord(dataDir, deps);
    if (progress?.failedStep) warnings.push(installUnfinishedMessage(progress.failedStep));
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
