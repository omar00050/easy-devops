/**
 * Filesystem transaction around an updater-run service refresh.
 *
 * npm owns the package rollback. This module preserves the service artifacts
 * npm does not know about: the systemd unit or WinSW definition, the Windows
 * runtime copy, and Windows Personal's two launch scripts.
 *
 * ── The journal ─────────────────────────────────────────────────────────────
 *
 * The Windows runtime copy is MOVED aside (`<runtime>.update-<id>`) because a
 * copy of ~10k files is slow and because Windows refuses to overwrite a
 * running executable. Moving it is the one operation here that leaves the
 * machine without a working runtime if the process dies in the middle, so a
 * small journal is written to `update-journal.json` in the service's own
 * folder BEFORE anything moves:
 *
 *   - while it exists, the previous update did not commit;
 *   - the next update, the new package's post-update, and `ezz service
 *     recover` all call `recoverInterruptedUpdate()` first, which puts the
 *     previous runtime and unit/XML back.
 *
 * It is deliberately a separate file beside `daemon.lock`, never inside the
 * database, the settings or any other user data: nothing the user owns is ever
 * moved by this module.
 *
 * ── What may be missing ─────────────────────────────────────────────────────
 *
 * An absent artifact is not an error. A machine in Personal mode may have no
 * Startup launcher installed, a freshly installed unit may be missing, and an
 * update must still work; the absent entry is recorded as absent and skipped,
 * so a later restore does not invent a file that was never there.
 *
 * ── Ordering on restore ─────────────────────────────────────────────────────
 *
 * The new runtime is renamed aside, the previous one is renamed back, and only
 * once `node.exe` in it actually runs is the set-aside copy removed. A restore
 * that fails leaves BOTH copies on disk and reports their paths, because a
 * half-deleted runtime is the one state nobody can diagnose.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { runFile } from '../shell.js';
import { getDataDir, isWindows } from '../platform.js';
import { runtimeDir, runtimeNodePath } from './runtime.js';
import { serviceXmlPath } from './windowsService.js';
import { launcherPath, supervisorPath } from './windowsPersonal.js';
import { UNIT_NAME, UNIT_PATH } from './systemd.js';

/** The journal's file name, in the service's own folder. */
export const JOURNAL_NAME = 'update-journal.json';

/** The journal schema. Bumped only when an older journal cannot be read. */
export const JOURNAL_VERSION = 1;

/** The executable inside the Windows runtime copy. */
const RUNTIME_NODE = 'node.exe';

function exists(file) {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) ?? null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * rename(2), retried briefly on the codes Windows uses for "another process
 * has this open". A rename of our own files should not fail because a reader
 * looked at them at the wrong moment.
 */
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const transient = ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code);
      if (!transient || attempt >= 50) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** Makes a rename durable. Unavailable on some Windows filesystems. */
function syncDirectory(directory) {
  let handle;
  try {
    handle = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(handle);
  } catch {
    /* not fatal: the rename itself already happened */
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* already closed */ }
    }
  }
}

/** Where the update journal lives: the service's own folder. */
export function updateJournalPath(dataDir = getDataDir(), deps = {}) {
  return deps.journalPath ?? path.join(dataDir, JOURNAL_NAME);
}

/** The journal, or null when no update was interrupted. */
export function readUpdateJournal({ dataDir = getDataDir(), deps = {} } = {}) {
  const file = updateJournalPath(dataDir, deps);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { unreadable: true, journal: file, dataDir, reason: error.message };
  }
  try {
    return { ...JSON.parse(text), journal: file };
  } catch (error) {
    return { unreadable: true, journal: file, dataDir, reason: `it is not valid JSON: ${error.message}` };
  }
}

/** Writes the journal atomically: a temporary file, fsync, then one rename. */
function writeJournal(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    renameWithRetry(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* reported below */ }
    throw error;
  }
  syncDirectory(path.dirname(file));
}

/** Removes the journal. A failure is reported, never thrown: the work is done. */
function removeJournal(file, log) {
  if (!file) return true;
  try {
    fs.rmSync(file, { force: true });
    syncDirectory(path.dirname(file));
    return true;
  } catch (error) {
    log?.(`warning: could not remove the update journal ${file}: ${error.message}`);
    return false;
  }
}

function snapshotFile(file, name, root) {
  const target = path.join(root, name);
  fs.copyFileSync(file, target);
  fs.chmodSync(target, 0o600);
  return { name, path: file, snapshot: target, absent: false };
}

/** Records an artifact that was not there, so nothing is invented on restore. */
function absentFile(name, file = null, reason = null) {
  return { name, path: file, snapshot: null, absent: true, reason };
}

function replaceFile(source, target) {
  const temporary = `${target}.rollback-${randomUUID()}`;
  const displaced = `${target}.displaced-${randomUUID()}`;
  fs.copyFileSync(source, temporary);
  try {
    fs.chmodSync(temporary, 0o600);
    if (exists(target)) fs.renameSync(target, displaced);
    try {
      fs.renameSync(temporary, target);
      fs.rmSync(displaced, { force: true });
    } catch (error) {
      if (exists(displaced)) fs.renameSync(displaced, target);
      throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * What this update must preserve, and how. Kept separate from the doing so the
 * journal can be written before the first file is touched.
 */
function planArtifacts({ dataDir, mode, deps }) {
  if (mode === 'server') {
    const activeRuntime = (deps.runtimeDir ?? runtimeDir)(dataDir);
    const runtimeBackup = `${activeRuntime}.update-${randomUUID()}`;
    return {
      activeRuntime,
      runtimeBackup,
      runtimeLink: null,
      files: [{ name: 'service.xml', path: (deps.serviceXmlPath ?? serviceXmlPath)() }],
    };
  }

  if (mode === 'personal') {
    return {
      activeRuntime: null,
      runtimeBackup: null,
      runtimeLink: null,
      files: [
        { name: 'startup.cmd', path: (deps.launcherPath ?? launcherPath)() },
        { name: 'supervisor.cmd', path: (deps.supervisorPath ?? supervisorPath)(dataDir) },
      ],
    };
  }

  const link = (deps.runtimeNodePath ?? runtimeNodePath)(dataDir);
  let runtimeLink = null;
  const stat = exists(link);
  if (stat?.isSymbolicLink()) runtimeLink = fs.readlinkSync(link);

  return {
    activeRuntime: null,
    runtimeBackup: null,
    runtimeLink,
    files: [{ name: UNIT_NAME, path: (deps.unitPath ?? (() => UNIT_PATH))() }],
  };
}

/**
 * Captures restorable service state, journal first. The caller must stop the
 * service first when `mode` is Windows Server, because Windows locks a running
 * node.exe.
 */
export async function captureUpdateState({
  dataDir = getDataDir(),
  mode,
  mechanism,
  log = () => {},
  deps = {},
} = {}) {
  const journal = updateJournalPath(dataDir, deps);

  // An update that never finished is finished (or its previous runtime put
  // back) before this one records anything of its own. A journal owned by a
  // process that is still running means another update is in progress.
  const recovered = await recoverInterruptedUpdate({ dataDir, log, deps });
  if (!recovered.ok) {
    return {
      ok: false,
      journal,
      reason: `an earlier update was interrupted and could not be repaired first: ${recovered.reason}`,
    };
  }
  if (recovered.active) {
    return {
      ok: false,
      journal,
      reason: `another update is running (${recovered.reason}). Wait for it to finish, then run \`ezz update\` again.`,
    };
  }

  const plan = planArtifacts({ dataDir, mode, deps });
  // The mechanism decides how a file is restored (sudo install versus a copy),
  // so it is recorded even when the caller's status did not name it.
  const resolvedMechanism = mechanism ?? (
    mode === 'server' ? 'winsw'
      : mode === 'personal' ? 'startup-supervisor'
        : isWindows ? 'startup-supervisor' : 'systemd'
  );
  let root;
  try {
    root = (deps.mkdtemp ?? fs.mkdtempSync)(
      path.join(deps.tmpDir ?? os.tmpdir(), 'easy-devops-update-'),
    );
  } catch (error) {
    return { ok: false, journal, reason: `could not create a place to keep the service files: ${error.message}` };
  }

  const snapshot = {
    ok: true,
    root,
    journal,
    dataDir,
    mode: mode ?? null,
    mechanism: resolvedMechanism,
    files: [],
    activeRuntime: plan.activeRuntime,
    runtimeBackup: plan.runtimeBackup,
    runtimeNodeExe: null,
    runtimeLink: plan.runtimeLink,
    runtimeMoved: false,
    runtimeAbsent: false,
  };

  // The journal goes down BEFORE anything is moved. Everything a restore needs
  // is in it, so a crash from here on is recoverable by the next run.
  const startedAt = new Date().toISOString();
  try {
    writeJournal(journal, {
      version: JOURNAL_VERSION,
      stage: 'prepared',
      startedAt,
      pid: process.pid,
      dataDir,
      mode: snapshot.mode,
      mechanism: snapshot.mechanism,
      root,
      files: plan.files.map((file) => ({
        name: file.name,
        path: file.path ?? null,
        absent: !file.path || !exists(file.path),
      })),
      activeRuntime: plan.activeRuntime,
      runtimeBackup: plan.runtimeBackup,
      runtimeNodeName: plan.runtimeBackup ? RUNTIME_NODE : null,
      runtimeLink: plan.runtimeLink,
    });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    return {
      ok: false,
      journal,
      reason: `could not write the update journal at ${journal}: ${error.message}. Nothing was changed.`,
    };
  }

  try {
    for (const file of plan.files) {
      if (!file.path) {
        snapshot.files.push(absentFile(file.name, null, 'this machine has no such location'));
        log(`  ${file.name}: no such location on this machine; nothing to preserve`);
        continue;
      }
      if (!exists(file.path)) {
        snapshot.files.push(absentFile(file.name, file.path));
        log(`  ${file.path}: not present; nothing to preserve`);
        continue;
      }
      snapshot.files.push(snapshotFile(file.path, file.name, root));
      log(`  kept a copy of ${file.path}`);
    }

    if (plan.runtimeBackup) {
      if (exists(plan.activeRuntime)) {
        renameWithRetry(plan.activeRuntime, plan.runtimeBackup);
        snapshot.runtimeMoved = true;
        snapshot.runtimeNodeExe = path.join(plan.runtimeBackup, RUNTIME_NODE);
        log(`Kept the previous service runtime at ${plan.runtimeBackup}`);
      } else {
        snapshot.runtimeAbsent = true;
        log(`  ${plan.activeRuntime}: no runtime copy exists; nothing to move aside`);
      }
    }

    // The manifest is for a human reading the snapshot folder; the journal is
    // what recovery reads, and it now says the move really happened.
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    writeJournal(journal, {
      version: JOURNAL_VERSION,
      stage: snapshot.runtimeMoved ? 'moved' : 'prepared',
      startedAt,
      pid: process.pid,
      dataDir,
      mode: snapshot.mode,
      mechanism: snapshot.mechanism,
      root,
      files: snapshot.files.map((file) => ({
        name: file.name,
        path: file.path,
        snapshot: file.snapshot,
        absent: file.absent,
      })),
      activeRuntime: snapshot.activeRuntime,
      runtimeBackup: snapshot.runtimeBackup,
      runtimeNodeExe: snapshot.runtimeNodeExe,
      runtimeLink: snapshot.runtimeLink,
    });

    return snapshot;
  } catch (error) {
    const restored = await restoreUpdateState(snapshot, { log, deps });
    if (restored.ok) {
      return {
        ok: false,
        journal,
        reason: `the service files could not be preserved: ${error.message}. Everything that had been moved was restored.`,
      };
    }
    return {
      ok: false,
      journal,
      reason: `the service files could not be preserved: ${error.message}. `
        + `Restoring them also failed: ${restored.reason} `
        + `The previous files are kept at ${root} and the journal is ${journal}. `
        + 'Run `ezz service recover`.',
    };
  }
}

function restoreSystemdFile(file, { run = runFile, stdin = 'inherit', log } = {}) {
  const result = run('sudo', ['install', '-m', '0644', '--', file.snapshot, file.path], {
    stdin,
    timeout: 300_000,
  });
  return Promise.resolve(result).then((installed) => {
    if (!installed?.success) {
      return { ok: false, reason: installed?.stderr || `could not restore ${file.path}` };
    }
    log?.(`Restored ${file.path}`);
    return { ok: true };
  });
}

/**
 * Proves a restored runtime copy can run. The whole point of keeping the old
 * copy is that the service can start from it, and "the directory is back" is
 * not the same claim as "node.exe in it runs".
 */
async function verifyRuntimeCopy(directory, { run = runFile } = {}) {
  const node = path.join(directory, RUNTIME_NODE);
  if (!exists(node)) {
    return { ok: false, reason: `${node} is missing` };
  }
  let probe;
  try {
    probe = await run(node, ['--version'], { timeout: 30_000 });
  } catch (error) {
    return { ok: false, reason: `${node} could not be run: ${error.message}` };
  }
  if (!probe?.success) {
    return {
      ok: false,
      reason: `${node} did not run: ${String(probe?.stderr ?? '').trim() || 'no output'}`,
    };
  }
  return { ok: true, version: String(probe.stdout ?? '').trim() };
}

/**
 * Puts the previous runtime copy back without ever deleting the only working
 * copy.
 *
 *   1. rename the NEW runtime aside,
 *   2. rename the previous one into place,
 *   3. prove node.exe in it runs,
 *   4. only then remove the set-aside new copy.
 *
 * Any failure keeps both copies and reports where they are.
 */
async function restoreRuntimeCopy(snapshot, { log = () => {}, deps = {} } = {}) {
  const active = snapshot.activeRuntime ?? (deps.runtimeDir ?? runtimeDir)(snapshot.dataDir);
  const backup = snapshot.runtimeBackup;
  const restoredMarker = path.join(snapshot.root ?? os.tmpdir(), 'runtime-restored');
  const alreadyRestored = snapshot.runtimeRestored === true || (snapshot.root && exists(restoredMarker));

  if (alreadyRestored) {
    if (!exists(active)) {
      return {
        ok: false,
        restored: false,
        reason: `the service runtime was reported restored but is missing: ${active}`,
        snapshot: snapshot.root,
      };
    }
    return { ok: true };
  }

  if (!exists(backup)) {
    // Nothing was ever moved: a crash before the rename, or a restore that
    // already completed. A live runtime is the proof.
    if (exists(active)) {
      log('The service runtime was never moved; nothing to restore.');
      return { ok: true, untouched: true };
    }
    return {
      ok: false,
      restored: false,
      reason: `the preserved service runtime is missing: ${backup}`,
      snapshot: snapshot.root,
    };
  }

  const displaced = `${active}.update-new-${randomUUID()}`;
  let setAside = false;
  if (exists(active)) {
    try {
      renameWithRetry(active, displaced);
      setAside = true;
    } catch (error) {
      return {
        ok: false,
        restored: false,
        reason: `the new service runtime at ${active} could not be moved aside (${error.message}). `
          + `Both copies are kept: the new one at ${active}, the previous one at ${backup}.`,
        activeRuntime: active,
        previousRuntime: backup,
      };
    }
  }

  try {
    renameWithRetry(backup, active);
  } catch (error) {
    let note = '';
    if (setAside) {
      try {
        renameWithRetry(displaced, active);
        note = ' The new runtime copy was put back and is in use.';
      } catch {
        note = ` The new runtime copy is kept at ${displaced}.`;
      }
    }
    return {
      ok: false,
      restored: false,
      reason: `the previous service runtime at ${backup} could not be put back: ${error.message}.${note}`,
      activeRuntime: active,
      previousRuntime: backup,
    };
  }

  const verified = await verifyRuntimeCopy(active, { run: deps.runFile ?? runFile });
  if (!verified.ok) {
    return {
      ok: false,
      restored: false,
      reason: `the previous runtime was put back at ${active}, but it does not work: ${verified.reason}. `
        + `The previous copy is at ${active}${setAside ? `, the new one is kept at ${displaced}` : ''}. `
        + 'Run `ezz service repair` once node.exe can be run there.',
      activeRuntime: active,
      previousRuntime: active,
      setAside: setAside ? displaced : null,
    };
  }

  if (setAside) {
    try {
      fs.rmSync(displaced, { recursive: true, force: true });
    } catch (error) {
      log(`warning: the superseded runtime copy could not be removed (${displaced}): ${error.message}`);
    }
  }

  snapshot.runtimeRestored = true;
  if (snapshot.root) {
    try {
      fs.writeFileSync(restoredMarker, 'restored\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      log(`warning: could not record the runtime restore marker: ${error.message}`);
    }
  }
  log(`Restored the previous service runtime copy (${verified.version || 'node.exe runs'}).`);
  return { ok: true };
}

/** Re-points the Linux runtime link at the target it had before the update. */
function restoreRuntimeLink(snapshot, { log = () => {}, deps = {} } = {}) {
  const target = snapshot.runtimeLink;
  if (!target) return { ok: true };
  const link = (deps.runtimeNodePath ?? runtimeNodePath)(snapshot.dataDir);
  try {
    const stat = exists(link);
    if (stat?.isSymbolicLink()) {
      const current = fs.readlinkSync(link);
      if (current === target) return { ok: true };
      fs.unlinkSync(link);
    } else if (stat) {
      // A real file where the link should be: leave it alone and say so.
      return { ok: true, skipped: `${link} is a real file, not a symlink` };
    }
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    log(`Restored the runtime link ${link} -> ${target}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `could not restore the runtime link ${link}: ${error.message}` };
  }
}

/** Restores every captured artifact, retaining the journal on any failure. */
export async function restoreUpdateState(snapshot, { log = () => {}, deps = {} } = {}) {
  if (!snapshot?.root && !snapshot?.runtimeBackup && !(snapshot?.files ?? []).length) {
    removeJournal(snapshot?.journal, log);
    return { ok: true, restored: true };
  }

  const journal = snapshot.journal ?? updateJournalPath(snapshot.dataDir, deps);

  try {
    if (snapshot.runtimeBackup) {
      const restored = await restoreRuntimeCopy(snapshot, { log, deps });
      if (!restored.ok) return restored;
    }

    const link = restoreRuntimeLink(snapshot, { log, deps });
    if (!link.ok) return link;

    for (const file of snapshot.files ?? []) {
      if (file?.absent || !file?.snapshot) {
        log(`  ${file?.path ?? file?.name ?? 'a service file'} was not present; nothing to restore`);
        continue;
      }
      if (snapshot.mechanism === 'systemd') {
        const restored = await restoreSystemdFile(file, { run: deps.runFile ?? runFile, log });
        if (!restored.ok) return restored;
      } else {
        replaceFile(file.snapshot, file.path);
        log(`Restored ${file.path}`);
      }
    }

    if (snapshot.mechanism === 'systemd') {
      const reload = await (deps.runFile ?? runFile)(
        'sudo',
        ['systemctl', 'daemon-reload'],
        { stdin: 'inherit', timeout: 300_000 },
      );
      if (!reload.success) {
        return { ok: false, reason: reload.stderr || `systemctl daemon-reload failed for ${UNIT_NAME}` };
      }
    }

    if (snapshot.root) fs.rmSync(snapshot.root, { recursive: true, force: true });
    removeJournal(journal, log);
    return { ok: true, restored: true };
  } catch (error) {
    return { ok: false, restored: false, reason: error.message, snapshot: snapshot.root, journal };
  }
}

/**
 * Whether a pid belongs to a live process. Another user's process answers
 * EPERM, which still means alive.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Finishes an update that was interrupted, and is safe to call when there is
 * nothing to finish.
 *
 * Called by the next update and by the new package's post-update step before
 * either records or replaces anything. `ezz service recover` belongs here too:
 * it is the command an operator runs when the machine is already broken.
 *
 * A journal whose owner is still alive belongs to an update that is running
 * right now — the post-update child of that very update is a different process
 * — so it is never touched. The result says `active` instead.
 *
 * @returns {Promise<{ ok: boolean, recovered: boolean, active?: boolean, reason: string|null, journal?: string }>}
 */
export async function recoverInterruptedUpdate({
  dataDir = getDataDir(),
  log = () => {},
  deps = {},
} = {}) {
  let record;
  try {
    record = readUpdateJournal({ dataDir, deps });
  } catch (error) {
    return { ok: false, recovered: false, reason: `could not read the update journal: ${error.message}` };
  }
  if (!record) return { ok: true, recovered: false, reason: null };

  if (record.unreadable) {
    return {
      ok: false,
      recovered: false,
      journal: record.journal,
      reason: `the update journal ${record.journal} cannot be read (${record.reason}). `
        + 'The previous service files may still be at their `.update-` path; '
        + `inspect it, then remove the journal and run \`ezz service recover\`.`,
    };
  }

  const owner = Number(record.pid);
  if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && isProcessAlive(owner)) {
    return {
      ok: true,
      recovered: false,
      active: true,
      journal: record.journal,
      reason: `an update started by pid ${owner} is still running`,
    };
  }

  log(`An interrupted update was recorded in ${record.journal}; finishing it first...`);
  const snapshot = {
    root: record.root ?? null,
    journal: record.journal,
    dataDir: record.dataDir ?? dataDir,
    mode: record.mode ?? null,
    mechanism: record.mechanism ?? null,
    files: Array.isArray(record.files) ? record.files : [],
    activeRuntime: record.activeRuntime ?? null,
    runtimeBackup: record.runtimeBackup ?? null,
    runtimeNodeExe: record.runtimeNodeExe ?? null,
    runtimeLink: record.runtimeLink ?? null,
  };

  const restored = await restoreUpdateState(snapshot, { log, deps });
  if (!restored.ok) {
    return { ok: false, recovered: false, journal: record.journal, reason: restored.reason };
  }
  return { ok: true, recovered: true, restored: true, journal: record.journal, reason: null };
}

/** Removes a successful transaction's backup, journal and temporary manifest. */
export function commitUpdateState(snapshot, { log = () => {} } = {}) {
  if (!snapshot) return { ok: true, warnings: [] };
  const warnings = [];
  if (snapshot.runtimeBackup) {
    try {
      fs.rmSync(snapshot.runtimeBackup, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`could not remove ${snapshot.runtimeBackup}: ${error.message}`);
    }
  }
  if (snapshot.root) {
    try {
      fs.rmSync(snapshot.root, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`could not remove ${snapshot.root}: ${error.message}`);
    }
  }
  // The journal goes last: while it exists, a crash means "restore the previous
  // runtime", so it must not outlive a runtime backup that is already gone.
  if (!removeJournal(snapshot.journal, log)) {
    warnings.push(`could not remove the update journal ${snapshot.journal}`);
  }
  for (const warning of warnings) log(`warning: ${warning}`);
  return { ok: warnings.length === 0, warnings };
}
