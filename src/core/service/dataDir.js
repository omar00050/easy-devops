/**
 * core/service/dataDir.js
 *
 * Moving the data directory between `%APPDATA%\easy-devops` (per user) and
 * `C:\ProgramData\easy-devops` (machine-wide, for the Windows service).
 *
 * ── Why the data has to move at all ────────────────────────────────────────
 *
 * The service runs as the virtual account `NT SERVICE\EasyDevOps`. That
 * account has no access to the installing user's `%APPDATA%`, and its own
 * profile is not that user's — so if the data stayed per-user, the service and
 * the CLI would be looking at two different databases and neither would see
 * the other's domains. ProgramData is the one location both can share.
 *
 * ── Why it is a copy-verify-then-remove, not a rename ──────────────────────
 *
 * `fs.renameSync` across volumes fails with EXDEV, and `%APPDATA%` and
 * ProgramData can genuinely be on different volumes (a redirected profile, a
 * small system disk). More importantly, a rename that fails halfway leaves the
 * user with no complete copy anywhere. So: copy everything, verify it, keep a
 * timestamped backup of the source, and only then remove the original.
 *
 * ── Why the database must not be open ──────────────────────────────────────
 *
 * SQLite keeps a WAL alongside the main file. Copying the main file while
 * another process is mid-transaction can produce a database that opens but is
 * missing the most recent writes. Every caller here is `ezz service
 * install/uninstall`, which runs before the daemon is started or after it is
 * stopped; `assertNotInUse()` makes that a checked precondition rather than an
 * assumption.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

import {
  isWindows,
  programDataDir,
  serverModeMarkerPath,
  resetDataDirCache,
  getDataDir,
} from '../platform.js';
import { inspect } from '../daemon/lock.js';

/** Per-user directory, computed without the Server-mode marker in the way. */
export function userDataDir() {
  return isWindows
    ? path.join(process.env.APPDATA || '', 'easy-devops')
    : path.join(process.env.HOME || '', '.config', 'easy-devops');
}

/**
 * Refuses to move the data while something is using it.
 *
 * @param {string} dir
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function assertNotInUse(dir) {
  const state = inspect({ dataDir: dir });
  if (state.running) {
    return {
      ok: false,
      reason: `a daemon is running against ${dir} (pid ${state.lock?.pid}). `
        + 'Stop the service first: ezz service uninstall, or stop it in services.msc.',
    };
  }
  return { ok: true };
}

/**
 * Copies a directory tree.
 *
 * `fs.cpSync` with `recursive` exists in Node 16.7+, which is inside the
 * supported floor, and it preserves timestamps. It is used rather than a
 * hand-rolled walk so symlinks and empty directories behave predictably.
 */
function copyTree(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false,
  });
}

function pathExists(file) {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) ?? null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function isLink(stat) {
  return Boolean(stat?.isSymbolicLink());
}

/**
 * Refuse any existing path component that can redirect filesystem operations.
 *
 * Windows junctions and other reparse points appear as symbolic links through
 * Node's lstat(). The walk is repeated after creating a directory so a link
 * inserted in the meantime cannot be followed by the copy or marker write.
 */
function unsafePathComponent(dir) {
  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;

  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = pathExists(current);
    } catch (error) {
      return `${current} could not be inspected: ${error.message}`;
    }
    if (!stat) break;
    if (isLink(stat)) return `${current} is a link or reparse point`;
    if (current !== resolved && !stat.isDirectory()) {
      return `${current} is not a directory`;
    }
  }
  return null;
}

/**
 * Verify that an existing tree contains no links, reparse points, or hard
 * linked destination files. The source may contain hard links because it is
 * only read. A destination hard link would let force-overwrite change a file
 * outside the approved directory.
 */
function unsafeTreeEntry(dir, { destination = false } = {}) {
  let root;
  try {
    root = pathExists(dir);
  } catch (error) {
    return `${dir} could not be inspected: ${error.message}`;
  }
  if (!root) return null;
  if (isLink(root)) return `${dir} is a link or reparse point`;
  if (!root.isDirectory()) return `${dir} is not a directory`;

  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      return `${current} could not be inspected: ${error.message}`;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (error) {
        return `${full} could not be inspected: ${error.message}`;
      }
      if (isLink(stat)) return `${full} is a link or reparse point`;
      if (stat.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!stat.isFile()) return `${full} is not a regular file`;
      if (destination && stat.nlink !== 1) {
        return `${full} is a hard link; refusing to overwrite it`;
      }
    }
  }
  return null;
}

function ensureSafeDirectory(dir) {
  const redirected = unsafePathComponent(dir);
  if (redirected) return { ok: false, reason: redirected };

  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;

  for (const part of parts) {
    current = path.join(current, part);
    const existing = pathExists(current);
    if (!existing) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        return { ok: false, reason: `could not create ${current}: ${error.message}` };
      }
      continue;
    }
    if (isLink(existing)) {
      return { ok: false, reason: `${current} became a link or reparse point` };
    }
    if (!existing.isDirectory()) {
      return { ok: false, reason: `${current} is not a directory` };
    }
  }

  const after = unsafePathComponent(dir);
  return after
    ? { ok: false, reason: after }
    : { ok: true };
}

function writeMarker(target, marker, payload) {
  const before = pathExists(marker);
  if (before) {
    if (isLink(before)) return { ok: false, reason: `${marker} is a link or reparse point` };
    if (!before.isFile() || before.nlink !== 1) {
      return { ok: false, reason: `${marker} is not a regular file` };
    }
    return { ok: true, existed: true };
  }

  const temp = path.join(path.dirname(marker), `.server-mode.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, payload);
    fs.closeSync(fd);
    fd = undefined;
    if (unsafePathComponent(target) || unsafePathComponent(marker)) {
      throw new Error('the Server-mode directory changed during migration');
    }
    fs.renameSync(temp, marker);
    return { ok: true, existed: false };
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    return { ok: false, reason: error.message };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Every file in a tree, as paths relative to its root. */
function listFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Checks that every file in `from` arrived in `to` with the same size.
 *
 * Size rather than a hash: these are SQLite files and session blobs that can
 * be tens of megabytes, and the failure this guards against is a truncated or
 * missing copy, which size catches. A silent bit flip is not the risk here.
 *
 * @returns {{ ok: boolean, missing: string[], differing: string[] }}
 */
export function verifyCopy(from, to) {
  const missing = [];
  const differing = [];

  for (const rel of listFiles(from)) {
    const src = path.join(from, rel);
    const dst = path.join(to, rel);

    if (!fs.existsSync(dst)) {
      missing.push(rel);
      continue;
    }
    try {
      if (fs.statSync(src).size !== fs.statSync(dst).size) differing.push(rel);
    } catch {
      differing.push(rel);
    }
  }

  return { ok: missing.length === 0 && differing.length === 0, missing, differing };
}

/** `<dir>.backup-<timestamp>`, beside the original so it is on the same volume. */
export function backupPathFor(dir, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${dir}.backup-${stamp}`;
}

/**
 * Moves the data directory, keeping a backup of the source.
 *
 * Order: copy → verify → back up the source → remove the source. The backup is
 * a RENAME of the original, which is why it is created last and placed beside
 * it: renaming is atomic within a volume, so at no point does the only copy of
 * the data not exist.
 *
 * @param {Object} opts
 * @param {string} opts.from
 * @param {string} opts.to
 * @param {boolean} [opts.keepBackup] Leave the backup in place (default true)
 * @param {(line: string) => void} [opts.log]
 * `originalAt` always says where the original data is afterwards: the backup
 * path when the rename worked, or `from` itself when it could not be renamed
 * (Windows refuses to rename a directory while a file in it is open). It is
 * null only when there was no original, or it was removed on request.
 *
 * @returns {{ ok: true, moved: boolean, backup: string|null, originalAt: string|null, reason?: string }
 *          | { ok: false, reason: string }}
 */
export function moveDataDir({ from, to, keepBackup = true, log = () => {} }) {
  let fromStat;
  try {
    fromStat = pathExists(from);
  } catch (error) {
    return { ok: false, reason: `${from} could not be inspected: ${error.message}` };
  }
  if (!fromStat) {
    // Nothing to move is a success: a fresh install has no per-user data, and
    // the service simply starts with an empty ProgramData directory.
    return { ok: true, moved: false, backup: null, originalAt: null, reason: `${from} does not exist` };
  }
  if (!fromStat.isDirectory() || isLink(fromStat)) {
    return { ok: false, reason: `${from} is not a safe, real directory` };
  }

  if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) {
    return { ok: true, moved: false, backup: null, originalAt: from, reason: 'source and destination are the same' };
  }

  const busy = assertNotInUse(from);
  if (!busy.ok) return { ok: false, reason: busy.reason };

  // Validate both trees before the first mkdir or copy. Existing links could
  // otherwise redirect the complete data-tree copy outside either directory.
  const unsafeSource = unsafeTreeEntry(from);
  if (unsafeSource) {
    return { ok: false, reason: `source is not safe to copy: ${unsafeSource}. Nothing was changed.` };
  }
  const unsafeDestination = unsafeTreeEntry(to, { destination: true });
  if (unsafeDestination) {
    return { ok: false, reason: `destination is not safe to write: ${unsafeDestination}. Nothing was changed.` };
  }

  // A destination that already holds a database is not overwritten: that is
  // either a previous install's data or a second machine's, and silently
  // replacing it would destroy whichever one the user actually wanted.
  const destDb = path.join(to, 'easy-devops.sqlite');
  let destDbStat;
  try {
    destDbStat = pathExists(destDb);
  } catch (error) {
    return { ok: false, reason: `${destDb} could not be inspected: ${error.message}. Nothing was changed.` };
  }
  if (destDbStat) {
    return {
      ok: false,
      reason: `${to} already contains a database. Move or remove it first if you want to replace it; `
        + 'nothing has been changed.',
    };
  }

  log(`Copying ${from} → ${to}`);
  const ensured = ensureSafeDirectory(to);
  if (!ensured.ok) {
    return { ok: false, reason: `destination is not safe to write: ${ensured.reason}. Nothing was changed.` };
  }
  try {
    const beforeCopy = unsafeTreeEntry(from) || unsafeTreeEntry(to, { destination: true });
    if (beforeCopy) throw new Error(beforeCopy);
    copyTree(from, to);
    const afterCopy = unsafeTreeEntry(to, { destination: true });
    if (afterCopy) throw new Error(afterCopy);
  } catch (err) {
    return { ok: false, reason: `copy failed: ${err.message}. Nothing was removed.` };
  }

  const verified = verifyCopy(from, to);
  if (!verified.ok) {
    return {
      ok: false,
      reason: 'the copy is incomplete, so the original was left untouched: '
        + [
          verified.missing.length ? `missing ${verified.missing.length} file(s): ${verified.missing.slice(0, 5).join(', ')}` : '',
          verified.differing.length ? `${verified.differing.length} file(s) differ in size: ${verified.differing.slice(0, 5).join(', ')}` : '',
        ].filter(Boolean).join('; '),
    };
  }
  log('Copy verified.');

  const backup = backupPathFor(from);
  try {
    fs.renameSync(from, backup);
    log(`Original kept at ${backup}`);
  } catch (err) {
    // The copy is good and verified, so the data is safe in two places. Not
    // being able to rename the original is worth reporting but not worth
    // undoing a verified migration over.
    log(`Original left in place at ${from} (it could not be renamed: ${err.code ?? err.message})`);
    return {
      ok: true,
      moved: true,
      backup: null,
      originalAt: from,
      reason: `the data was copied and verified, but the original could not be renamed: ${err.message}. `
        + `It is still at ${from} — remove it by hand once you are satisfied.`,
    };
  }

  if (!keepBackup) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
      log('Backup removed as requested.');
      return { ok: true, moved: true, backup: null, originalAt: null };
    } catch (err) {
      return { ok: true, moved: true, backup, originalAt: backup, reason: `the backup could not be removed: ${err.message}` };
    }
  }

  return { ok: true, moved: true, backup, originalAt: backup };
}

/**
 * One line saying where the user's original data is after a migration.
 *
 * Exists because 1.4.0 printed `backup at null`: the rename to a backup name
 * fails on Windows while the database inside is open, the original then stays
 * where it was, and `backup` is null for exactly that reason. The data was
 * never lost — the message just did not say where it was.
 *
 * @param {{ backup?: string|null, originalAt?: string|null }} result
 * @returns {string}
 */
export function describeOriginal(result) {
  if (result?.backup) return `the original is kept as a backup at ${result.backup}`;
  if (result?.originalAt) return `the original was left in place at ${result.originalAt}; remove it by hand once you are satisfied`;
  return 'there was no earlier data to keep';
}

/**
 * Switches this machine into Server mode: data under ProgramData, marker
 * written, per-user data migrated once.
 *
 * Idempotent. Running it again when the marker already exists re-checks the
 * data rather than migrating a second time, because the per-user directory at
 * that point is a backup, not the live data.
 *
 * @param {Object} [opts]
 * @param {(line: string) => void} [opts.log]
 * @returns {{ ok: boolean, dataDir: string, migrated: boolean, backup: string|null, originalAt?: string|null,
 *             reason?: string }}
 */
export function enableServerMode({ log = () => {} } = {}) {
  if (!isWindows) {
    return { ok: false, dataDir: getDataDir(), migrated: false, backup: null, reason: 'Server mode is Windows-only' };
  }

  const target = programDataDir();
  const marker = serverModeMarkerPath();

  const safeTarget = ensureSafeDirectory(target);
  if (!safeTarget.ok) {
    return {
      ok: false,
      dataDir: target,
      migrated: false,
      backup: null,
      reason: `could not create ${target}: ${safeTarget.reason}. `
        + 'Creating a directory under ProgramData needs an elevated terminal.',
    };
  }

  let markerStat;
  try {
    markerStat = pathExists(marker);
  } catch (error) {
    return {
      ok: false,
      dataDir: target,
      migrated: false,
      backup: null,
      reason: `could not inspect ${marker}: ${error.message}. Nothing was changed.`,
    };
  }
  if (markerStat) {
    if (isLink(markerStat)) {
      return {
        ok: false,
        dataDir: target,
        migrated: false,
        backup: null,
        reason: `${marker} is a link or reparse point; refusing to treat it as the Server-mode marker`,
      };
    }
    if (!markerStat.isFile() || markerStat.nlink !== 1) {
      return {
        ok: false,
        dataDir: target,
        migrated: false,
        backup: null,
        reason: `${marker} is not a regular Server-mode marker`,
      };
    }
    log(`Already in Server mode: ${target}`);
    return { ok: true, dataDir: target, migrated: false, backup: null, reason: 'the marker already exists' };
  }

  const moved = moveDataDir({ from: userDataDir(), to: target, log });
  if (!moved.ok) {
    // The marker is NOT written when the migration failed. Writing it would
    // point every process at a directory that does not hold the user's data.
    return { ok: false, dataDir: target, migrated: false, backup: null, reason: moved.reason };
  }

  const marked = writeMarker(
    target,
    marker,
    `${JSON.stringify({ enabledAt: new Date().toISOString(), migratedFrom: userDataDir(), backup: moved.backup })}\n`,
  );
  if (!marked.ok) {
    return {
      ok: false,
      dataDir: target,
      migrated: moved.moved,
      backup: moved.backup,
      reason: `the data was migrated but the marker could not be written: ${marked.reason}`,
    };
  }

  resetDataDirCache();
  log(`Server mode enabled. Data directory: ${target}`);

  return { ok: true, dataDir: target, migrated: moved.moved, backup: moved.backup, originalAt: moved.originalAt, reason: moved.reason };
}

/**
 * Leaves Server mode, moving the data back to `%APPDATA%`.
 *
 * Only ever called when the user explicitly chooses it at uninstall —
 * decision 5. The default on uninstall is to KEEP the server location, because
 * the ProgramData directory holds the live data and silently moving it back
 * would be a surprise.
 *
 * @param {Object} [opts]
 * @param {(line: string) => void} [opts.log]
 * @returns {{ ok: boolean, dataDir: string, moved: boolean, backup: string|null, reason?: string }}
 */
export function disableServerMode({ log = () => {} } = {}) {
  if (!isWindows) {
    return { ok: false, dataDir: getDataDir(), moved: false, backup: null, reason: 'Server mode is Windows-only' };
  }

  const source = programDataDir();
  const target = userDataDir();
  const marker = serverModeMarkerPath();

  if (!fs.existsSync(marker)) {
    return { ok: true, dataDir: target, moved: false, backup: null, reason: 'not in Server mode' };
  }

  // The marker is removed FIRST so that a failure halfway cannot leave every
  // process pointed at a directory whose contents have already been moved
  // away. If the move then fails, the data is still in ProgramData and the
  // reason says so — recoverable by hand, and nothing is lost.
  try {
    fs.rmSync(marker, { force: true });
  } catch (err) {
    return { ok: false, dataDir: source, moved: false, backup: null, reason: `could not remove ${marker}: ${err.message}` };
  }
  resetDataDirCache();

  const moved = moveDataDir({ from: source, to: target, log });
  if (!moved.ok) {
    return {
      ok: false,
      dataDir: source,
      moved: false,
      backup: null,
      reason: `${moved.reason} Server mode is now off, so the data in ${source} is no longer being read — `
        + `move it to ${target} by hand.`,
    };
  }

  log(`Server mode disabled. Data directory: ${target}`);
  return { ok: true, dataDir: target, moved: moved.moved, backup: moved.backup, originalAt: moved.originalAt, reason: moved.reason };
}
