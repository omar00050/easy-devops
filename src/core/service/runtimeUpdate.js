/**
 * core/service/runtimeUpdate.js
 *
 * Moving the installed service onto a different Node runtime, safely.
 *
 * ── Why this needs a command of its own ────────────────────────────────────
 *
 * The service is pinned to ONE Node binary on purpose (see runtime.js): a unit
 * that resolves `node` from PATH breaks the moment a version manager repoints
 * or removes it. The cost of that pin is that upgrading Node no longer reaches
 * the service — it keeps running the old binary until something re-points it.
 * Doing that by hand means editing a unit file, or copying an exe into
 * ProgramData, and then discovering at the next restart whether the native
 * modules still load.
 *
 * ── The order, which is the whole design ───────────────────────────────────
 *
 *   1. Decide the target, and refuse one below the package's minimum.
 *   2. SMOKE TEST the new binary while the old one is still in place and the
 *      service is still running. Nothing is touched until this passes.
 *   3. Stop the service.
 *   4. Swap, keeping whatever is needed to put the old one back.
 *   5. Start, and wait for the daemon's own heartbeat - not the service
 *      manager's "started", which only means a process was spawned.
 *   6. On any failure in 4 or 5: roll back, start again, and say what happened.
 *
 * Step 2 is the one that matters. A runtime that cannot load better-sqlite3 is
 * the common failure (an ABI built for another Node), and it is detectable
 * before the service is stopped. Verifying afterwards would mean discovering
 * it with the service already down.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 *  - It NEVER uninstalls a Node version. The old one is what rollback needs,
 *    and a version manager's other consumers are none of our business.
 *  - It never downloads a runtime. Either a version manager installs it, or
 *    the target is the Node already on the machine.
 *  - It never asks for a password. On Windows Server mode the runtime lives
 *    under ProgramData, so the swap needs an Administrator terminal; that is
 *    checked BEFORE anything is stopped, and the answer is the command to run.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'module';

import { run, runFile } from '../shell.js';
import { isWindows, getDataDir } from '../platform.js';
import { detectInstallSource } from '../installSource.js';
import * as windowsPersonal from './windowsPersonal.js';
import { protectServiceFiles } from './operator.js';
import { canWriteProgramData, isElevated } from './windowsService.js';
import {
  runtimeDir,
  runtimeNodePath,
  installRuntimeStubs,
  inspectLink,
  linkRuntime,
  verifyNativeModules,
  detectVersionManager,
} from './runtime.js';
import {
  MODES,
  resolveMechanism,
  appRoot,
  entryScript,
  recordedState,
  recordRuntime,
  waitForDaemon,
} from './index.js';

const require = createRequire(import.meta.url);

/** How long to watch a restarted daemon before calling the update good. */
export const VERIFY_MS = 10_000;

/** The previous `node.exe`, kept beside the new one so rollback is a rename. */
export const PREV_SUFFIX = '.prev';

// ─── Versions ────────────────────────────────────────────────────────────────

/** `v20.11.1` / `20.11.1` -> [20, 11, 1]; null when unparseable. */
export function parseVersion(value) {
  const m = String(value ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1. Unparseable sorts last. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/**
 * The minimum Node this package supports.
 *
 * Read from `engines.node` rather than written here again: a second literal is
 * a second thing to forget.
 *
 * @returns {{ raw: string, major: number }}
 */
export function minimumNode() {
  const raw = String(require('../../../package.json').engines?.node ?? '>=18.0.0');
  const major = Number(raw.match(/(\d+)/)?.[1] ?? 18);
  return { raw, major };
}

/** Whether a version satisfies the package minimum. */
export function meetsMinimum(version, minimum = minimumNode()) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return parsed[0] >= minimum.major;
}

// ─── What is available ───────────────────────────────────────────────────────

/**
 * The LTS versions a version manager can install.
 *
 * Both tools are asked in their own syntax and both are allowed to be absent;
 * nvm-windows prints a table, nvm (Unix) one version per line and needs its
 * script sourced first because it is a shell function, not a binary.
 *
 * @param {Object} [opts]
 * @returns {Promise<{ manager: string|null, versions: string[], reason: string }>}
 */
export async function listManagerVersions({ deps = {} } = {}) {
  const exec = deps.run ?? run;

  if (isWindows) {
    const probe = await exec('nvm version', { timeout: 20_000 });
    if (!answered(probe)) return { manager: null, versions: [], reason: 'nvm-windows is not installed' };

    const listed = await exec('nvm list available', { timeout: 60_000 });
    if (!listed.success) {
      return { manager: 'nvm-windows', versions: [], reason: 'could not read the available versions' };
    }

    // nvm-windows prints four columns: CURRENT | LTS | OLD STABLE | OLD
    // UNSTABLE. The LTS one is what a service should run, and it is the SECOND
    // column — which is not `split('|')[1]`, because the row begins with a pipe
    // and that produces an empty first cell. Reading index 1 took the CURRENT
    // column and offered 23.x as "LTS"; dropping the empty cells makes the
    // index mean what it says.
    const versions = [];
    for (const line of listed.stdout.split('\n')) {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
      const lts = cells[1]?.match(/^\d+\.\d+\.\d+$/) ? cells[1] : null;
      if (lts) versions.push(lts);
    }
    return { manager: 'nvm-windows', versions: dedupeDesc(versions), reason: 'ok' };
  }

  const probe = await exec(nvmShell('nvm --version'), { timeout: 20_000 });
  if (!answered(probe)) return { manager: null, versions: [], reason: 'nvm is not installed' };

  const listed = await exec(nvmShell('nvm ls-remote --lts'), { timeout: 60_000 });
  if (!listed.success) {
    return { manager: 'nvm', versions: [], reason: 'could not read the available versions' };
  }

  const versions = [];
  for (const line of listed.stdout.split('\n')) {
    const m = line.match(/v(\d+\.\d+\.\d+)/);
    if (m) versions.push(m[1]);
  }
  return { manager: 'nvm', versions: dedupeDesc(versions), reason: 'ok' };
}

/**
 * Whether a version probe actually answered.
 *
 * Exit code alone is not enough. A leftover `%APPDATA%\nvm` directory with no
 * nvm in it makes `nvm version` exit 0 with NO output through a shell -
 * measured on a real machine, where it made this code report nvm-windows as
 * installed and then offer an empty version list. A version probe has to print
 * something version-shaped to count.
 */
function answered(result) {
  return Boolean(result?.success) && /\d+\.\d+/.test(String(result.stdout ?? ''));
}

/** nvm is a shell function, so it has to be sourced before it can be called. */
function nvmShell(command) {
  return `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; ${command}`;
}

/** Newest first, no duplicates. */
function dedupeDesc(versions) {
  return [...new Set(versions)].sort((a, b) => compareVersions(b, a));
}

/**
 * The Node on PATH, which on a machine with no version manager is the only
 * thing we can re-pin to.
 *
 * `process.execPath` is NOT used: this CLI may itself be running under the
 * pinned runtime (the service invokes it that way), and the question is what
 * the user's shell resolves.
 *
 * @returns {Promise<{ path: string|null, version: string|null }>}
 */
export async function detectSystemNode({ deps = {} } = {}) {
  const exec = deps.run ?? run;

  const which = await exec(isWindows ? 'where.exe node' : 'command -v node', { timeout: 15_000 });
  const first = which.success ? which.stdout.split('\n')[0]?.trim() : '';
  if (!first) return { path: null, version: null };

  const probe = await (deps.runFile ?? runFile)(first, ['--version'], { timeout: 15_000 });
  return {
    path: first,
    version: probe.success ? probe.stdout.trim().replace(/^v/, '') : null,
  };
}

/**
 * Everything `ezz runtime status` and the update picker need.
 *
 * @param {Object} [opts]
 * @returns {Promise<Object>}
 */
export async function listTargets({ dataDir = getDataDir(), deps = {} } = {}) {
  const mech = deps.mechanism ?? resolveMechanism();
  const minimum = minimumNode();
  const pinned = await describePinned({ dataDir, mech, deps });
  const manager = await (deps.listManagerVersions ?? listManagerVersions)({ deps });
  const system = await (deps.detectSystemNode ?? detectSystemNode)({ deps });
  const source = (deps.detectInstallSource ?? detectInstallSource)();

  const candidates = [];

  for (const version of manager.versions.slice(0, 12)) {
    candidates.push({
      version,
      source: manager.manager,
      installable: true,
      meetsMinimum: meetsMinimum(version, minimum),
      isPinned: pinned.version ? compareVersions(version, pinned.version) === 0 : false,
    });
  }

  // With no version manager - or with one that cannot list anything, which a
  // broken install does - the Node already on the machine is the target: the
  // user upgrades it however they normally would (MSI, apt, brew) and this
  // re-pins the service to it.
  if ((!manager.manager || manager.versions.length === 0) && system.version) {
    candidates.push({
      version: system.version,
      source: 'system',
      path: system.path,
      installable: false,
      meetsMinimum: meetsMinimum(system.version, minimum),
      isPinned: pinned.version ? compareVersions(system.version, pinned.version) === 0 : false,
    });
  }

  const usable = candidates.filter((c) => c.meetsMinimum && !c.isPinned);

  return {
    mechanism: mech.mechanism,
    mode: mech.mode,
    dataDir,
    minimum,
    pinned,
    manager,
    systemNode: system,
    installSource: source,
    candidates,
    // The one thing a caller has to know before offering anything.
    nothingToUpdate: usable.length === 0,
    hint: usable.length === 0 ? upgradeHint({ manager, system, pinned }) : null,
  };
}

/** What the pinned runtime is, per mechanism. */
async function describePinned({ dataDir, mech, deps = {} }) {
  const recorded = (deps.recordedState ?? recordedState)();

  if (!isWindows) {
    const link = inspectLink(dataDir);
    const probe = link.exists && !link.broken
      ? await (deps.runFile ?? runFile)(link.link, ['--version'], { timeout: 15_000 })
      : null;
    return {
      kind: 'symlink',
      path: link.link,
      target: link.target,
      exists: link.exists,
      broken: link.broken,
      version: probe?.success ? probe.stdout.trim().replace(/^v/, '') : null,
    };
  }

  const copied = runtimeNodePath(dataDir);
  if (mech.mode === MODES.SERVER || fs.existsSync(copied)) {
    const probe = fs.existsSync(copied)
      ? await (deps.runFile ?? runFile)(copied, ['--version'], { timeout: 15_000 })
      : null;
    return {
      kind: 'copy',
      path: copied,
      exists: fs.existsSync(copied),
      broken: Boolean(probe && !probe.success),
      version: probe?.success ? probe.stdout.trim().replace(/^v/, '') : null,
    };
  }

  const nodeExe = recorded.nodeExe ?? null;
  const exists = Boolean(nodeExe && fs.existsSync(nodeExe));
  const probe = exists ? await (deps.runFile ?? runFile)(nodeExe, ['--version'], { timeout: 15_000 }) : null;
  return {
    kind: 'recorded',
    path: nodeExe,
    exists,
    broken: Boolean(nodeExe && !exists),
    version: probe?.success ? probe.stdout.trim().replace(/^v/, '') : null,
    manager: nodeExe ? detectVersionManager(nodeExe) : { managed: false, manager: null },
  };
}

/** What to tell someone who has nothing to update to. */
function upgradeHint({ manager, system, pinned }) {
  const lines = [];

  if (manager.manager) {
    lines.push(`${manager.manager} has no LTS version newer than the pinned ${pinned.version ?? 'runtime'}.`);
    lines.push('');
    lines.push('Refresh its list and try again:');
    lines.push(isWindows ? '  nvm list available' : '  nvm ls-remote --lts');
    return lines;
  }

  lines.push(
    system.version
      ? `The Node on this machine (v${system.version}) is the one the service already uses.`
      : 'No Node version manager is installed and no node was found on PATH.',
  );
  lines.push('');
  lines.push('Upgrade Node first, then run `ezz runtime update` to re-pin the service:');
  if (isWindows) {
    lines.push('  nvm-windows   https://github.com/coreybutler/nvm-windows/releases');
    lines.push('  or the official installer   https://nodejs.org/en/download');
  } else {
    lines.push('  nvm           https://github.com/nvm-sh/nvm#installing-and-updating');
    lines.push('  or your distribution\'s package manager / https://nodejs.org/en/download');
  }
  return lines;
}

// ─── Installing a target ─────────────────────────────────────────────────────

/**
 * Installs a version with the detected version manager and returns the path to
 * its binary.
 *
 * `system` targets are already installed by definition, so nothing runs.
 *
 * @param {Object} opts
 * @returns {Promise<{ ok: boolean, nodeExe?: string, reason?: string }>}
 */
export async function installTarget({ target, deps = {} } = {}) {
  const exec = deps.run ?? run;

  if (typeof target?.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(target.version)) return { ok: false, reason: 'no target version given' };

  if (target.source === 'system') {
    if (!target.path) return { ok: false, reason: 'the system node path is unknown' };
    return { ok: true, nodeExe: target.path };
  }

  if (target.source === 'nvm-windows') {
    const installed = await (deps.runFile ?? runFile)('nvm.exe', ['install', target.version], { timeout: 600_000 });
    if (!installed.success) {
      return { ok: false, reason: `nvm install ${target.version} failed: ${trimOutput(installed)}` };
    }
    // nvm-windows keeps versions under its own root; ask it rather than guess.
    const root = await exec('nvm root', { timeout: 15_000 });
    const base = root.success ? root.stdout.replace(/^.*?:/, '').trim() : '';
    const candidate = base ? path.join(base, `v${target.version}`, 'node.exe') : '';
    if (candidate && fs.existsSync(candidate)) return { ok: true, nodeExe: candidate };
    return {
      ok: false,
      reason: `nvm reported success but node.exe was not found for v${target.version}`,
    };
  }

  const installed = await (deps.runFile ?? runFile)('bash', ['-c', nvmShell('nvm install "$1"'), 'nvm', target.version], { timeout: 600_000 });
  if (!installed.success) {
    return { ok: false, reason: `nvm install ${target.version} failed: ${trimOutput(installed)}` };
  }

  const located = await (deps.runFile ?? runFile)('bash', ['-c', nvmShell('nvm which "$1"'), 'nvm', target.version], { timeout: 20_000 });
  const nodeExe = located.success ? located.stdout.trim().split('\n').pop()?.trim() : '';
  if (nodeExe && fs.existsSync(nodeExe)) return { ok: true, nodeExe };

  return { ok: false, reason: `nvm installed v${target.version} but its path could not be resolved` };
}

function trimOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(0, 300);
}

// ─── The smoke test ──────────────────────────────────────────────────────────

/**
 * Proves a candidate binary can actually run Easy DevOps, before anything is
 * touched.
 *
 * Three checks, in increasing cost:
 *   1. it runs at all, and its version meets the minimum
 *   2. it can load the native module (`verifyNativeModules`, the usual failure)
 *   3. it can execute the CLI entry point - against a THROWAWAY data
 *      directory, so a smoke test can never read or write the real one
 *
 * @param {Object} opts
 * @returns {Promise<{ ok: boolean, version?: string, abi?: string, reason?: string, fix?: string }>}
 */
export async function smokeTest({ nodeExe, appDir = appRoot(), entry = entryScript(), probeDataDir, deps = {} } = {}) {
  const versionProbe = await (deps.runFile ?? runFile)(nodeExe, ['--version'], { timeout: 20_000 });
  if (!versionProbe.success) {
    return { ok: false, reason: `${nodeExe} did not run: ${trimOutput(versionProbe)}` };
  }

  const version = versionProbe.stdout.trim().replace(/^v/, '');
  const minimum = minimumNode();
  if (!meetsMinimum(version, minimum)) {
    return {
      ok: false,
      version,
      reason: `v${version} is below the minimum this version of Easy DevOps supports (${minimum.raw}).`,
      fix: `Choose Node ${minimum.major} or newer.`,
    };
  }

  const native = await (deps.verifyNativeModules ?? verifyNativeModules)({ nodeExe, appDir });
  if (!native.ok) return { ok: false, version, reason: native.reason, fix: native.fix };

  // The entry point, with its own data directory. EZ_DEV is NOT set: this must
  // exercise the production path, and the isolated directory is what keeps it
  // harmless.
  const dir = probeDataDir ?? path.join(runtimeDir(getDataDir()), 'smoke');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, version, reason: `could not create the smoke-test directory: ${err.message}` };
  }

  const entryProbe = await (deps.runFile ?? runFile)(nodeExe, [entry, '--version'], {
    timeout: 60_000,
    cwd: appDir,
    env: { ...process.env, EASY_DEVOPS_DATA_DIR: dir },
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

  if (!entryProbe.success) {
    return {
      ok: false,
      version,
      abi: native.abi,
      reason: `v${version} could not run Easy DevOps itself: ${trimOutput(entryProbe)}`,
    };
  }

  return { ok: true, version, abi: native.abi };
}

// ─── The swap ────────────────────────────────────────────────────────────────

/**
 * Points the service at a new binary, and returns how to undo it.
 *
 * Every branch returns a `rollback()` that restores exactly what it changed —
 * the caller does not have to know which mechanism it was.
 *
 * @param {Object} opts
 * @returns {Promise<{ ok: boolean, reason?: string, needsElevation?: boolean, rollback?: () => Promise<Object>, detail?: string }>}
 */
export async function applyRuntime({
  nodeExe,
  dataDir = getDataDir(),
  mech = resolveMechanism(),
  log = () => {},
  deps = {},
} = {}) {
  if (!isWindows) return applyLinux({ nodeExe, dataDir, log, deps });
  if (mech.mode === MODES.SERVER) return applyWindowsServer({ nodeExe, dataDir, log, deps });
  return applyWindowsPersonal({ nodeExe, dataDir, log, deps });
}

/** Linux: re-point the symlink. */
async function applyLinux({ nodeExe, dataDir, log, deps = {} }) {
  const before = inspectLink(dataDir);
  const link = (deps.linkRuntime ?? linkRuntime)({ dataDir, nodeExe });
  if (!link.ok) return { ok: false, reason: link.reason };

  log(`Re-pointed ${link.link} at ${link.target}`);

  return {
    ok: true,
    detail: `${link.link} -> ${link.target}`,
    async rollback() {
      if (!before.exists || !before.target) return { ok: false, reason: 'there was no previous link to restore' };
      const back = (deps.linkRuntime ?? linkRuntime)({ dataDir, nodeExe: before.target });
      return back.ok ? { ok: true, detail: `restored ${before.target}` } : back;
    },
  };
}

/**
 * Proves a runtime binary in place runs, before anything that is only kept for
 * rollback is removed.
 */
async function verifyRuntimeExe(nodeExe, deps = {}) {
  if (deps.verifyNode) return deps.verifyNode(nodeExe);
  let probe;
  try {
    probe = await (deps.runFile ?? runFile)(nodeExe, ['--version'], { timeout: 20_000 });
  } catch (error) {
    return { ok: false, reason: `${nodeExe} could not be run: ${error.message}` };
  }
  return probe.success
    ? { ok: true, version: String(probe.stdout ?? '').trim() }
    : { ok: false, reason: `${nodeExe} did not run: ${trimOutput(probe)}` };
}

/**
 * Windows Server mode: replace node.exe in the admin-only runtime directory,
 * keeping the old one as node.exe.prev, and make the app copy's native modules
 * match the new ABI.
 *
 * The app copy is the subtle part. `<runtime>/app/node_modules` holds
 * better-sqlite3 built for the OLD ABI; pairing it with a new node.exe fails at
 * require time with an error that never mentions Node versions. So after the
 * swap the module is rebuilt in the copy, and if that fails (no build tools on
 * a server, which is normal) the copy is refreshed from the package root, whose
 * modules were built by whatever npm the user runs.
 */
async function applyWindowsServer({ nodeExe, dataDir, log, deps = {} }) {
  const canWrite = await (deps.canWriteProgramData ?? canWriteProgramData)();
  if (!canWrite) {
    return {
      ok: false,
      needsElevation: true,
      reason: [
        'Updating the runtime writes under ProgramData, which needs an Administrator terminal.',
        '',
        'Right-click PowerShell -> "Run as administrator", then:',
        '',
        '  ezz runtime update',
        '',
        'No password is needed - only elevation.',
      ].join('\n'),
    };
  }

  const dest = runtimeNodePath(dataDir);
  const prev = `${dest}${PREV_SUFFIX}`;
  const appDir = path.join(runtimeDir(dataDir), 'app');
  const hadPrevious = fs.existsSync(dest);

  try {
    if (hadPrevious) {
      // One generation only: the older .prev has already been superseded, and
      // `ezz cleanup` is what removes it.
      try { fs.rmSync(prev, { force: true }); } catch { /* nothing there */ }
      fs.renameSync(dest, prev);
      log(`Kept the previous runtime at ${prev}`);
    }
    fs.copyFileSync(fs.realpathSync(nodeExe), dest);
    log(`Copied ${nodeExe} -> ${dest}`);
  } catch (err) {
    // Put it back immediately: a half-swapped runtime directory is the one
    // state nobody can diagnose.
    if (hadPrevious && !fs.existsSync(dest) && fs.existsSync(prev)) {
      try { fs.renameSync(prev, dest); } catch { /* reported below */ }
    }
    return { ok: false, reason: `could not replace ${dest}: ${err.message}` };
  }

  const rollback = async () => {
    if (!fs.existsSync(prev)) {
      return { ok: false, reason: `there is no previous runtime to restore: ${prev} is missing` };
    }
    // Rename the failed copy aside, rename the previous one back, prove it
    // runs, and only then remove the failed copy. Deleting the new binary
    // first would lose both if the rename back failed.
    const failed = `${dest}.failed-${randomUUID()}`;
    let setAside = false;
    try {
      if (fs.existsSync(dest)) {
        fs.renameSync(dest, failed);
        setAside = true;
      }
      fs.renameSync(prev, dest);
    } catch (err) {
      if (setAside) {
        try { fs.renameSync(failed, dest); } catch { /* keep both, reported below */ }
      }
      return {
        ok: false,
        reason: `could not restore ${dest} from ${prev}: ${err.message}. `
          + `Both copies are kept: ${dest}${setAside ? ` and ${failed}` : ''}.`,
      };
    }

    const verified = await verifyRuntimeExe(dest, deps);
    if (!verified.ok) {
      return {
        ok: false,
        reason: `the previous runtime was put back at ${dest}, but it does not run: ${verified.reason}. `
          + `The failed copy is kept at ${failed}. Run \`ezz service repair\` once node.exe runs there.`,
      };
    }
    if (setAside) {
      try { fs.rmSync(failed, { force: true }); } catch (err) {
        log(`warning: the failed runtime copy could not be removed (${failed}): ${err.message}`);
      }
    }
    return { ok: true, detail: `restored ${dest} from ${PREV_SUFFIX} (${verified.version ?? 'node runs'})` };
  };

  const native = await fixAppCopyModules({ nodeExe: dest, appDir, log, deps });
  if (!native.ok) return { ok: false, reason: native.reason, fix: native.fix, rollback };

  const protection = await (deps.protectServiceFiles ?? protectServiceFiles)({ dirs: [path.dirname(dest)], log });
  if (!protection.ok) return { ok: false, unsafeRuntime: true, reason: 'Could not secure the runtime. Run service repair before starting it.', rollback };
  return { ok: true, detail: `${dest} (${native.detail})`, rollback };
}

/**
 * Makes the app copy's native modules load under a new node.exe.
 *
 * Verify first: when the ABI did not change there is nothing to do, and
 * rebuilding anyway would be a long pointless step on every patch upgrade.
 */
async function fixAppCopyModules({ nodeExe, appDir, log, deps = {} }) {
  const exec = deps.run ?? run;
  const verify = deps.verifyNativeModules ?? verifyNativeModules;

  if (!fs.existsSync(appDir)) {
    return { ok: true, detail: 'no app copy to fix' };
  }

  const verifyCopy = async () => {
    try { installRuntimeStubs(appDir); } catch (err) { return { ok: false, reason: err.message }; }
    return verify({ nodeExe, appDir });
  };
  const first = await verifyCopy();
  if (first.ok) return { ok: true, detail: 'native modules already match' };

  log('The native modules were built for a different Node ABI; rebuilding in the copy...');
  const rebuilt = await exec('npm rebuild better-sqlite3', { cwd: appDir, timeout: 600_000 });

  if (rebuilt.success) {
    const after = await verifyCopy();
    if (after.ok) return { ok: true, detail: 'native modules rebuilt' };
  }

  // No build tools is the normal case on a server. The package root's modules
  // were built by the user's own npm, so copying them is the realistic fix.
  log('Rebuilding did not work; refreshing node_modules from the package instead...');
  const from = path.join(appRoot(), 'node_modules');
  if (fs.existsSync(from)) {
    try {
      fs.cpSync(from, path.join(appDir, 'node_modules'), { recursive: true, force: true });
    } catch (err) {
      return { ok: false, reason: `could not refresh the runtime copy's node_modules: ${err.message}` };
    }
    const after = await verifyCopy();
    if (after.ok) return { ok: true, detail: 'node_modules refreshed from the package' };
    return { ok: false, reason: after.reason, fix: after.fix };
  }

  return { ok: false, reason: first.reason, fix: first.fix };
}

/** Windows Personal mode: the recorded path, and the supervisor that uses it. */
async function applyWindowsPersonal({ nodeExe, dataDir, log, deps = {} }) {
  const recorded = (deps.recordedState ?? recordedState)();
  const before = recorded.nodeExe ?? null;

  const repaired = (deps.windowsPersonal ?? windowsPersonal).repair({
    dataDir,
    entry: entryScript(),
    nodeExe,
    log,
  });
  if (!repaired.ok) return { ok: false, reason: repaired.reason };

  (deps.recordRuntime ?? recordRuntime)({ nodeExe: repaired.nodeExe ?? nodeExe });
  log(`Recorded the service runtime as ${repaired.nodeExe ?? nodeExe}`);

  return {
    ok: true,
    detail: repaired.nodeExe ?? nodeExe,
    async rollback() {
      if (!before) return { ok: false, reason: 'there was no previous runtime path recorded' };
      const back = (deps.windowsPersonal ?? windowsPersonal).repair({
        dataDir,
        entry: entryScript(),
        nodeExe: before,
        log,
      });
      if (!back.ok) return back;
      (deps.recordRuntime ?? recordRuntime)({ nodeExe: before });
      return { ok: true, detail: `restored ${before}` };
    },
  };
}

// ─── The whole operation ─────────────────────────────────────────────────────

/**
 * Updates the service's runtime, verifying and rolling back on failure.
 *
 * @param {Object} opts
 * @param {Object} opts.target     A candidate from listTargets()
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<Object>}
 */
export async function update({
  target,
  dataDir = getDataDir(),
  log = () => {},
  deps = {},
} = {}) {
  const mech = deps.mechanism ?? resolveMechanism();
  const service = deps.service ?? (await import('./index.js'));

  // 0. Windows Server mode: the runtime folder is administrator-only on
  // purpose. Asked of Windows before anything is installed or stopped — the
  // write probe alone is not enough once the installing user may write the
  // data directory around it.
  if (isWindows && mech.mode === MODES.SERVER) {
    const elevated = await (deps.isElevated ?? isElevated)({});
    if (elevated === false) {
      return {
        ok: false,
        step: 'elevation',
        needsElevation: true,
        untouched: true,
        reason: 'Moving the service to another Node version replaces node.exe in an administrator-only folder. '
          + 'Run `ezz runtime update` from PowerShell opened with "Run as administrator". No password is needed.',
      };
    }
  }

  // 1. The target has to be installable and allowed.
  if (typeof target?.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(target.version)) return { ok: false, step: 'target', reason: 'no target version was chosen' };
  if (!meetsMinimum(target.version)) {
    const minimum = minimumNode();
    return {
      ok: false,
      step: 'target',
      reason: `v${target.version} is below the minimum this version of Easy DevOps supports (${minimum.raw}).`,
    };
  }

  log(`Installing Node v${target.version}...`);
  const installed = await (deps.installTarget ?? installTarget)({ target, deps });
  if (!installed.ok) return { ok: false, step: 'install', reason: installed.reason };
  log(`  runtime: ${installed.nodeExe}`);

  // 2. Smoke test BEFORE anything is touched. The service is still running.
  log('Smoke-testing Easy DevOps with it, before changing anything...');
  const smoke = await (deps.smokeTest ?? smokeTest)({ nodeExe: installed.nodeExe, deps });
  if (!smoke.ok) {
    return {
      ok: false,
      step: 'smoke',
      reason: smoke.reason,
      fix: smoke.fix,
      // Nothing was stopped or changed, which is worth saying plainly.
      untouched: true,
    };
  }
  log(`  v${smoke.version} runs Easy DevOps and loads its native modules.`);

  // 3. Stop.
  log('Stopping the service...');
  const stopped = await service.stop({ log });
  if (!stopped.ok && !stopped.alreadyStopped) {
    return {
      ok: false,
      step: 'stop',
      reason: stopped.reason,
      needsElevation: stopped.needsElevation ?? false,
      untouched: true,
    };
  }

  // 4. Swap.
  log('Swapping the runtime...');
  const applied = await (deps.applyRuntime ?? applyRuntime)({
    nodeExe: installed.nodeExe,
    dataDir,
    mech,
    log,
    deps,
  });

  if (!applied.ok) {
    // The swap can fail in two places: before the binary was replaced (an
    // elevation refusal, a copy error) and after it (the app copy's native
    // modules could not be made to load). The second one leaves a new binary
    // in place, so it hands back a rollback and it has to be used.
    let back = null;
    try {
      back = applied.rollback ? await applied.rollback() : null;
    } catch (error) {
      back = { ok: false, reason: error.message };
    }
    let restarted;
    if (applied.unsafeRuntime) {
      // Deliberate: an unprotected or unverified runtime copy must not be
      // started as the service account. The message says what to run.
      restarted = { ok: false, reason: 'the runtime was left unsecured' };
    } else {
      try {
        restarted = await service.start({ log });
      } catch (error) {
        restarted = { ok: false, reason: error.message };
      }
    }
    const next = restarted.ok ? serviceCheck(mech) : 'ezz service recover';
    return {
      ok: false,
      step: 'swap',
      reason: `${applied.reason}${restarted.ok ? '' : ` The service is NOT running: ${restarted.reason ?? 'it was not started'}.`}`
        + `\nNext: ${next}`,
      fix: applied.fix,
      needsElevation: applied.needsElevation ?? false,
      rolledBack: back ? back.ok : false,
      rollbackDetail: back ? (back.detail ?? back.reason) : null,
      restarted: restarted.ok,
      next,
      lines: [
        'Failed at: swap',
        `${applied.reason}`,
        restarted.ok ? 'The service is running.' : 'The service is NOT confirmed running.',
        `Next: ${next}`,
      ],
    };
  }

  // 5. Start and verify against the daemon's own heartbeat.
  log('Starting the service on the new runtime...');
  let started;
  try {
    started = await service.start({ log });
  } catch (error) {
    started = { ok: false, reason: error.message };
  }
  let alive;
  if (started.ok) {
    try {
      alive = await (deps.waitForDaemon ?? waitForDaemon)({ dataDir, timeoutMs: deps.verifyMs ?? VERIFY_MS });
    } catch (error) {
      alive = { alive: false, waitedMs: 0, reason: error.message };
    }
  } else {
    alive = { alive: false, waitedMs: 0 };
  }

  if (started.ok && alive.alive) {
    log(`  the daemon reported in after ${alive.waitedMs}ms (pid ${alive.lock?.pid ?? '?'}).`);
    return {
      ok: true,
      version: smoke.version,
      abi: smoke.abi,
      nodeExe: installed.nodeExe,
      mechanism: mech.mechanism,
      detail: applied.detail,
      waitedMs: alive.waitedMs,
    };
  }

  // 6. Roll back.
  const why = started.ok
    ? `it started but the daemon did not report in within ${Math.round((deps.verifyMs ?? VERIFY_MS) / 1000)}s`
    : `it could not be started: ${started.reason}`;

  log(`The new runtime did not work (${why}). Rolling back...`);
  let back;
  try {
    back = applied.rollback ? await applied.rollback() : { ok: false, reason: 'no rollback was available' };
  } catch (error) {
    back = { ok: false, reason: error.message };
  }
  // Started even when the runtime rollback failed: a stopped service is the
  // failure this command exists to prevent, and whatever binary is in place
  // may still run. If it does not, the result says exactly what to run.
  let restarted;
  try {
    restarted = await service.start({ log });
  } catch (error) {
    restarted = { ok: false, reason: error.message };
  }
  let aliveAgain;
  if (restarted.ok) {
    try {
      aliveAgain = await (deps.waitForDaemon ?? waitForDaemon)({ dataDir, timeoutMs: deps.verifyMs ?? VERIFY_MS });
    } catch (error) {
      aliveAgain = { alive: false, reason: error.message };
    }
  } else {
    aliveAgain = { alive: false };
  }

  const broken = [];
  if (!back.ok) broken.push(back.detail ?? back.reason ?? 'the previous runtime could not be restored');
  if (!restarted.ok) broken.push(`the service could not be started: ${restarted.reason ?? 'unknown error'}`);
  else if (!aliveAgain.alive) broken.push('the service started but its daemon heartbeat did not return');

  const nextCommand = back.ok && restarted.ok && aliveAgain.alive ? serviceCheck(mech) : 'ezz service recover';

  return {
    ok: false,
    step: 'verify',
    reason: `${[why, ...broken].join(' ')}\nNext: ${nextCommand}`,
    rolledBack: back.ok,
    rollbackDetail: back.detail ?? back.reason,
    restored: Boolean(restarted.ok && aliveAgain.alive),
    version: smoke.version,
    next: nextCommand,
    lines: [
      'Failed at: verify',
      why,
      back.ok
        ? `The previous runtime was put back (${back.detail ?? 'ok'}).`
        : `The previous runtime was NOT put back: ${back.detail ?? back.reason ?? 'unknown error'}.`,
      Boolean(restarted.ok && aliveAgain.alive)
        ? 'The service is running.'
        : 'The service is NOT confirmed running.',
      ...(back.ok && restarted.ok && aliveAgain.alive ? [] : ['To repair it: ezz service recover']),
    ],
  };
}

/** The command that shows this service's state, without a platform check. */
function serviceCheck(mech = {}) {
  if (mech.mechanism === 'systemd') return 'sudo systemctl status easy-devops';
  if (mech.mechanism === 'winsw') return 'sc.exe query EasyDevOps';
  return 'ezz service status';
}
