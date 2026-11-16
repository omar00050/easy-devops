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
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true, errorOnExist: false });
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
 * @returns {{ ok: true, moved: boolean, backup: string|null, reason?: string }
 *          | { ok: false, reason: string }}
 */
export function moveDataDir({ from, to, keepBackup = true, log = () => {} }) {
  if (!fs.existsSync(from)) {
    // Nothing to move is a success: a fresh install has no per-user data, and
    // the service simply starts with an empty ProgramData directory.
    return { ok: true, moved: false, backup: null, reason: `${from} does not exist` };
  }

  if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) {
    return { ok: true, moved: false, backup: null, reason: 'source and destination are the same' };
  }

  const busy = assertNotInUse(from);
  if (!busy.ok) return { ok: false, reason: busy.reason };

  // A destination that already holds a database is not overwritten: that is
  // either a previous install's data or a second machine's, and silently
  // replacing it would destroy whichever one the user actually wanted.
  const destDb = path.join(to, 'easy-devops.sqlite');
  if (fs.existsSync(destDb)) {
    return {
      ok: false,
      reason: `${to} already contains a database. Move or remove it first if you want to replace it; `
        + 'nothing has been changed.',
    };
  }

  log(`Copying ${from} → ${to}`);
  try {
    copyTree(from, to);
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
    return {
      ok: true,
      moved: true,
      backup: null,
      reason: `the data was copied and verified, but the original could not be renamed: ${err.message}. `
        + `It is still at ${from} — remove it by hand once you are satisfied.`,
    };
  }

  if (!keepBackup) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
      log('Backup removed as requested.');
      return { ok: true, moved: true, backup: null };
    } catch (err) {
      return { ok: true, moved: true, backup, reason: `the backup could not be removed: ${err.message}` };
    }
  }

  return { ok: true, moved: true, backup };
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
 * @returns {{ ok: boolean, dataDir: string, migrated: boolean, backup: string|null, reason?: string }}
 */
export function enableServerMode({ log = () => {} } = {}) {
  if (!isWindows) {
    return { ok: false, dataDir: getDataDir(), migrated: false, backup: null, reason: 'Server mode is Windows-only' };
  }

  const target = programDataDir();
  const marker = serverModeMarkerPath();

  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      dataDir: target,
      migrated: false,
      backup: null,
      reason: `could not create ${target}: ${err.message}. `
        + 'Creating a directory under ProgramData needs an elevated terminal.',
    };
  }

  if (fs.existsSync(marker)) {
    log(`Already in Server mode: ${target}`);
    return { ok: true, dataDir: target, migrated: false, backup: null, reason: 'the marker already exists' };
  }

  const moved = moveDataDir({ from: userDataDir(), to: target, log });
  if (!moved.ok) {
    // The marker is NOT written when the migration failed. Writing it would
    // point every process at a directory that does not hold the user's data.
    return { ok: false, dataDir: target, migrated: false, backup: null, reason: moved.reason };
  }

  try {
    fs.writeFileSync(
      marker,
      `${JSON.stringify({ enabledAt: new Date().toISOString(), migratedFrom: userDataDir(), backup: moved.backup })}\n`,
      'utf8',
    );
  } catch (err) {
    return {
      ok: false,
      dataDir: target,
      migrated: moved.moved,
      backup: moved.backup,
      reason: `the data was migrated but the marker could not be written: ${err.message}`,
    };
  }

  resetDataDirCache();
  log(`Server mode enabled. Data directory: ${target}`);

  return { ok: true, dataDir: target, migrated: moved.moved, backup: moved.backup, reason: moved.reason };
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
  return { ok: true, dataDir: target, moved: moved.moved, backup: moved.backup, reason: moved.reason };
}
