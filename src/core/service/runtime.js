/**
 * core/service/runtime.js
 *
 * Pinning the Node runtime the service uses, so a version manager cannot break
 * it later.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 *
 * A service unit records an absolute path to a `node` binary. If that path is
 * inside nvm — `~/.nvm/versions/node/v20.11.0/bin/node`, or on Windows the
 * `nvm use` shim — then the service breaks the moment the user runs
 * `nvm install 22` and the old version is removed, or `nvm use` repoints the
 * shim. The failure is confusing: the service simply stops starting, with a
 * "file not found" in a log nobody is watching.
 *
 * Three strategies, because the three situations are genuinely different:
 *
 *  - **Linux**: a symlink at `<dataDir>/runtime/node` pointing at one specific
 *    Node binary. The systemd unit uses the link, so re-pointing it is a
 *    one-line fix (`ezz service repair`) rather than editing a unit file and
 *    reloading systemd.
 *
 *  - **Windows Server mode**: `node.exe` and the application are COPIED into
 *    `C:\ProgramData\easy-devops\runtime`, which only administrators can
 *    write. Copying rather than linking because the service runs as a virtual
 *    account that may not be able to read the user's profile at all, and
 *    because `npm update` replaces the package directory under the user — an
 *    upgrade would otherwise swap the code under a running service.
 *
 *  - **Windows Personal mode**: the absolute path of the current `node.exe` is
 *    recorded at install and checked by `status`. No copy: a personal install
 *    has no elevation and nowhere admin-only to put one. The honest trade-off
 *    is that nvm-windows can still break it, which is why `status` says so
 *    explicitly instead of pretending otherwise.
 *
 * ── Native modules ─────────────────────────────────────────────────────────
 *
 * `better-sqlite3` (under `good.db`) is a compiled addon, built for ONE Node
 * ABI. A runtime copy that pairs a different `node.exe` with the existing
 * `.node` file fails at `require` time with a version error that does not
 * mention Node versions at all. So the copy is verified by actually loading
 * the module with the copied binary, and the fix is named in the message.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { run } from '../shell.js';
import { isWindows, programDataDir, quoteExe } from '../platform.js';

/** Where the pinned runtime lives, per platform. */
export function runtimeDir(dataDir) {
  return isWindows ? path.join(programDataDir(), 'runtime') : path.join(dataDir, 'runtime');
}

/** The path the service unit should invoke. */
export function runtimeNodePath(dataDir) {
  return isWindows
    ? path.join(runtimeDir(dataDir), 'node.exe')
    : path.join(runtimeDir(dataDir), 'node');
}

/** Node's ABI number for the running process. Addons are built per ABI. */
export function currentAbi() {
  return process.versions.modules;
}

/**
 * Looks like a path a version manager owns.
 *
 * Used to warn rather than to refuse: pinning handles it either way, but a
 * user who sees "your node is in nvm" understands why the pin exists.
 *
 * @param {string} nodePath
 * @returns {{ managed: boolean, manager: string|null }}
 */
export function detectVersionManager(nodePath) {
  const p = String(nodePath).replace(/\\/g, '/').toLowerCase();

  if (p.includes('/.nvm/')) return { managed: true, manager: 'nvm' };
  if (p.includes('/appdata/roaming/nvm/') || p.includes('/nvm4w/')) return { managed: true, manager: 'nvm-windows' };
  if (p.includes('/.volta/')) return { managed: true, manager: 'Volta' };
  if (p.includes('/.fnm/') || p.includes('/fnm_multishells/')) return { managed: true, manager: 'fnm' };
  if (p.includes('/.asdf/')) return { managed: true, manager: 'asdf' };
  if (p.includes('/scoop/')) return { managed: true, manager: 'Scoop' };

  return { managed: false, manager: null };
}

/**
 * On Windows, whether an nvm-managed node and an MSI-installed node are both
 * present. That combination is the one that produces the worst confusion: the
 * shell's `node` is nvm's, `C:\Program Files\nodejs\node.exe` is the MSI's,
 * and a service pinned to one while `npm install` ran under the other leaves
 * native modules built for the wrong ABI.
 *
 * @returns {{ mixed: boolean, msiPath: string|null, managed: string|null }}
 */
export function detectMixedWindowsInstalls(nodePath = process.execPath) {
  if (!isWindows) return { mixed: false, msiPath: null, managed: null };

  const msi = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe');
  const msiPresent = fs.existsSync(msi);
  const { managed, manager } = detectVersionManager(nodePath);

  const samePath = path.resolve(nodePath).toLowerCase() === msi.toLowerCase();

  return {
    mixed: msiPresent && managed && !samePath,
    msiPath: msiPresent ? msi : null,
    managed: manager,
  };
}

// ─── Linux: the symlink ───────────────────────────────────────────────────────

/**
 * Creates or re-points `<dataDir>/runtime/node`.
 *
 * The target is resolved with `realpath` first, so a symlink chain through a
 * version manager's shim is collapsed to the actual binary. Pointing the link
 * at another symlink would defeat the purpose entirely.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {string} [opts.nodeExe] Defaults to the running node
 * @returns {{ ok: boolean, link?: string, target?: string, reason?: string }}
 */
export function linkRuntime({ dataDir, nodeExe = process.execPath } = {}) {
  const dir = runtimeDir(dataDir);
  const link = runtimeNodePath(dataDir);

  let target;
  try {
    target = fs.realpathSync(nodeExe);
  } catch (err) {
    return { ok: false, reason: `cannot resolve ${nodeExe}: ${err.message}` };
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Removed rather than overwritten: symlink() fails with EEXIST, and
    // forcing it any other way risks following the old link and replacing the
    // Node binary it points at.
    try { fs.unlinkSync(link); } catch { /* nothing there */ }
    fs.symlinkSync(target, link);
  } catch (err) {
    return { ok: false, reason: `could not create ${link}: ${err.message}` };
  }

  return { ok: true, link, target };
}

/**
 * The state of the Linux runtime link.
 *
 * @param {string} dataDir
 * @returns {{ exists: boolean, broken: boolean, link: string, target: string|null, reason: string }}
 */
export function inspectLink(dataDir) {
  const link = runtimeNodePath(dataDir);

  let target = null;
  try {
    target = fs.readlinkSync(link);
  } catch (err) {
    if (err.code === 'EINVAL') {
      // Not a symlink but it exists — someone copied a binary here. That works,
      // so it is not broken; it is just not what we would have made.
      return { exists: true, broken: false, link, target: link, reason: 'a real file, not a symlink' };
    }
    return { exists: false, broken: false, link, target: null, reason: 'the runtime link does not exist' };
  }

  if (!fs.existsSync(link)) {
    return {
      exists: true,
      broken: true,
      link,
      target,
      reason: `the runtime link points at ${target}, which no longer exists `
        + '(a version manager probably removed that Node version). Fix it with: ezz service repair',
    };
  }

  return { exists: true, broken: false, link, target, reason: 'ok' };
}

// ─── Windows Server: the copy ────────────────────────────────────────────────

/**
 * What gets copied into the admin-only runtime directory.
 *
 * `node_modules` is included because the service must not depend on the user's
 * package directory, which `npm update` replaces wholesale. `dist/ui` is
 * included so a dashboard started from the copy can serve the built UI.
 */
const COPY_ENTRIES = ['package.json', 'src', 'node_modules', 'dist'];

/** Path equality as Windows sees it: case-insensitive, separators normalised. */
function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * copyFileSync, retried briefly on EBUSY/EPERM.
 *
 * A service that has just reported STOPPED can hold node.exe for a moment
 * longer while Windows tears the process down; a few hundred milliseconds of
 * patience turns that race into a success. Anything still locked after the
 * retries is a real lock, and the error says so.
 */
function copyFileRetrying(from, to, { tries = 10, delayMs = 300 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.copyFileSync(from, to);
      return;
    } catch (err) {
      if (attempt >= tries || !(err.code === 'EBUSY' || err.code === 'EPERM')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

/**
 * Copies node.exe and the application into the runtime directory.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {string} opts.appRoot    Repository/package root to copy from
 * @param {string} [opts.nodeExe]
 * @param {(line: string) => void} [opts.log]
 * @returns {{ ok: boolean, dir?: string, nodeExe?: string, entry?: string, reason?: string }}
 */
export function copyRuntime({ dataDir, appRoot, nodeExe = process.execPath, log = () => {} } = {}) {
  const dir = runtimeDir(dataDir);
  const destNode = runtimeNodePath(dataDir);
  const appDir = path.join(dir, 'app');

  try {
    fs.mkdirSync(appDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: `could not create ${dir}: ${err.message}. `
        + 'Writing under ProgramData needs an elevated terminal.',
    };
  }

  try {
    const source = fs.realpathSync(nodeExe);
    // The updater refreshes the copy FROM the copy's own node.exe; copying a
    // file onto itself is at best pointless and at worst a sharing violation.
    if (fs.existsSync(destNode) && samePath(source, fs.realpathSync(destNode))) {
      log(`node.exe is already the runtime copy (${destNode}); kept`);
    } else {
      copyFileRetrying(source, destNode);
      log(`Copied node.exe → ${destNode}`);
    }
  } catch (err) {
    const locked = err.code === 'EBUSY' || err.code === 'EPERM';
    return {
      ok: false,
      reason: `could not copy node.exe: ${err.message}`
        + (locked ? '. Windows locks a running executable: stop the service first (ezz service stop).' : ''),
    };
  }

  for (const entry of COPY_ENTRIES) {
    const from = path.join(appRoot, entry);
    if (!fs.existsSync(from)) {
      // `dist` is absent in a source checkout that has not run build:ui, and
      // that is not a failure: the dashboard falls back to the classic UI.
      log(`  ${entry}: not present, skipped`);
      continue;
    }
    try {
      fs.cpSync(from, path.join(appDir, entry), { recursive: true, force: true });
      log(`  ${entry}: copied`);
    } catch (err) {
      return { ok: false, reason: `could not copy ${entry}: ${err.message}` };
    }
  }

  // The entry point inside the copy, which is what the service XML invokes.
  const entry = path.join(appDir, 'src', 'cli', 'index.js');
  if (!fs.existsSync(entry)) {
    return { ok: false, reason: `the copy is missing its entry point: ${entry}` };
  }

  return { ok: true, dir, nodeExe: destNode, entry };
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Proves a Node binary can actually run the application's native module.
 *
 * Running the real `require` rather than comparing version numbers: an ABI
 * number match is necessary but not sufficient — a half-copied `node_modules`
 * or a module built for a different architecture both pass a number check and
 * fail at load. This is the check that matters, so it is the one performed.
 *
 * @param {Object} opts
 * @param {string} opts.nodeExe
 * @param {string} opts.appDir  Directory whose node_modules should be used
 * @returns {Promise<{ ok: boolean, abi?: string, version?: string, reason?: string, fix?: string }>}
 */
export async function verifyNativeModules({ nodeExe, appDir } = {}) {
  // better-sqlite3 is reached through good.db. Opening an in-memory database
  // and closing it exercises the addon's load path and its entry points
  // without touching any file.
  //
  // Written to a file rather than passed with `node -e`: run() goes through a
  // shell, and PowerShell mangles an inline script's quotes beyond rescue —
  // measured, not assumed. A file sidesteps the quoting problem entirely.
  const probe = [
    'const { createRequire } = require("module");',
    `const r = createRequire(${JSON.stringify(path.join(appDir, 'package.json'))});`,
    'const Database = r("better-sqlite3");',
    'const db = new Database(":memory:");',
    'db.close();',
    'process.stdout.write(JSON.stringify({ abi: process.versions.modules, version: process.version }));',
  ].join('\n');

  const probeFile = path.join(
    os.tmpdir(),
    `ez-runtime-probe-${process.pid}-${Date.now()}.cjs`,
  );

  let result;
  try {
    fs.writeFileSync(probeFile, probe, 'utf8');
    // quoteExe() is the single owner of this: on Windows a quoted executable
    // path needs PowerShell's `&` call operator, and three places here got it
    // wrong by hand-rolling the quoting instead.
    const invoke = `${quoteExe(nodeExe)} "${probeFile}"`;
    result = await run(invoke, { cwd: appDir, timeout: 30_000 });
  } catch (err) {
    return { ok: false, reason: `could not run the runtime probe: ${err.message}` };
  } finally {
    try { fs.rmSync(probeFile, { force: true }); } catch { /* best effort */ }
  }

  if (result.success) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      return { ok: true, abi: parsed.abi, version: parsed.version };
    } catch {
      return { ok: true, abi: null, version: null };
    }
  }

  const output = `${result.stdout}\n${result.stderr}`;

  // The ABI error names a module version, not a Node version, which is why
  // the fix has to be spelled out.
  if (/NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(output)) {
    const wanted = output.match(/NODE_MODULE_VERSION (\d+)/g)?.join(' vs ') ?? 'a different ABI';
    return {
      ok: false,
      reason: `the native module better-sqlite3 was built for a different Node ABI (${wanted}).`,
      fix: 'Rebuild it against the Node version the service will use:\n'
        + `  cd ${appDir}\n`
        + '  npm rebuild better-sqlite3\n'
        + 'then run `ezz service repair`. This happens when the service runs a different Node '
        + 'version than the one `npm install` used — most often with nvm.',
    };
  }

  if (/Cannot find module/i.test(output)) {
    return {
      ok: false,
      reason: 'the runtime copy is missing its dependencies.',
      fix: `Run \`npm install\` in ${appDir}, then \`ezz service repair\`.`,
    };
  }

  return { ok: false, reason: `the runtime could not load better-sqlite3: ${output.trim().slice(0, 400)}` };
}

/**
 * Everything `ezz service status` needs to say about runtimes.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {string|null} [opts.recordedNodeExe] What install recorded (Personal mode)
 * @returns {Promise<Object>}
 */
export async function inspectRuntime({ dataDir, recordedNodeExe = null } = {}) {
  const systemNode = { path: process.execPath, version: process.version, abi: currentAbi() };
  const mixed = detectMixedWindowsInstalls(systemNode.path);
  const manager = detectVersionManager(systemNode.path);

  const out = {
    systemNode,
    manager,
    mixed,
    pinned: null,
    warnings: [],
  };

  if (mixed.mixed) {
    out.warnings.push(
      `Both ${mixed.managed} and the Node MSI installer are present on this machine `
      + `(${mixed.msiPath}). If \`npm install\` runs under one and the service under the other, `
      + 'native modules will be built for the wrong ABI. The service is pinned to one specific '
      + 'binary to avoid this; `ezz service repair` re-pins it to the Node you are using now.',
    );
  }

  if (!isWindows) {
    const link = inspectLink(dataDir);
    out.pinned = {
      kind: 'symlink',
      path: link.link,
      target: link.target,
      exists: link.exists,
      broken: link.broken,
    };
    if (link.broken) out.warnings.push(link.reason);

    if (link.exists && !link.broken) {
      const probe = await run(`${quoteExe(link.link)} --version`, { timeout: 10_000 });
      out.pinned.version = probe.success ? probe.stdout.trim() : null;
      if (!probe.success) {
        out.warnings.push(`${link.link} exists but did not run: ${probe.stderr.trim() || 'no output'}`);
      } else if (out.pinned.version !== systemNode.version) {
        // Not a warning: a service deliberately pinned to an older Node than
        // the shell's is the normal state after the user upgrades. It is
        // reported so the difference is visible rather than surprising.
        out.pinned.differsFromSystem = true;
      }
    }

    return out;
  }

  // Windows: either the Server-mode copy or the recorded Personal-mode path.
  const copied = runtimeNodePath(dataDir);
  if (fs.existsSync(copied)) {
    const probe = await run(`${quoteExe(copied)} --version`, { timeout: 10_000 });
    out.pinned = {
      kind: 'copy',
      path: copied,
      version: probe.success ? probe.stdout.trim() : null,
      exists: true,
      broken: !probe.success,
    };
    if (!probe.success) {
      out.warnings.push(`${copied} exists but did not run. Re-create it with: ezz service repair`);
    }
    return out;
  }

  if (recordedNodeExe) {
    const exists = fs.existsSync(recordedNodeExe);
    const probe = exists ? await run(`${quoteExe(recordedNodeExe)} --version`, { timeout: 10_000 }) : null;
    out.pinned = {
      kind: 'recorded',
      path: recordedNodeExe,
      version: probe?.success ? probe.stdout.trim() : null,
      exists,
      broken: !exists || !probe?.success,
    };

    if (!exists) {
      const { manager: who } = detectVersionManager(recordedNodeExe);
      out.warnings.push(
        `The Node the service was installed with no longer exists:\n  ${recordedNodeExe}\n`
        + (who
          ? `That path belongs to ${who}, so the version was probably removed or switched. `
          : '')
        + 'Fix it with: ezz service repair',
      );
    }
    return out;
  }

  out.pinned = { kind: 'none', path: null, version: null, exists: false, broken: false };
  return out;
}
