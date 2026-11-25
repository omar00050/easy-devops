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
import { pipeline } from 'node:stream/promises';

import {
  isWindows,
  programDataDir,
  serverModeMarkerPath,
  resetDataDirCache,
  getDataDir,
} from '../platform.js';
import { inspect, lockPath, STALE_AFTER_MS } from '../daemon/lock.js';
import {
  UNINSTALL_STAGE_TIMEOUT_MS,
  remainingStageMs,
} from './stageTimeout.js';

function throwIfStageInterrupted(error, signal) {
  if (error?.code === 'EZ_STAGE_TIMEOUT' || signal?.aborted) throw error;
}

/** Top-level folders that contain executable service code, never user data. */
export const SERVER_CODE_DIR_NAMES = Object.freeze(['runtime', 'runtime.prev', 'bin']);

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

/** Asynchronous equivalent used by the deadline-aware migration path. */
async function assertNotInUseForMigration(dir, {
  deadline = Infinity,
  signal,
  stage = 'Moving data',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  fsApi = fs,
} = {}) {
  remainingStageMs(deadline, stage, timeoutMs);
  signal?.throwIfAborted();

  let raw;
  try {
    raw = await fsApi.promises.readFile(lockPath(dir), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true };
    throw error;
  }

  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    // Matches inspect(): a truncated lock has no usable live owner.
    return { ok: true };
  }
  if (!Number.isInteger(lock?.pid)) return { ok: true };

  const age = Date.now() - (Number(lock.heartbeatAt) || 0);
  let alive = false;
  try {
    process.kill(lock.pid, 0);
    alive = true;
  } catch (error) {
    alive = error?.code === 'EPERM';
  }
  if (alive || age < STALE_AFTER_MS) {
    return {
      ok: false,
      reason: `a daemon is running against ${dir} (pid ${lock.pid}). `
        + 'Stop the service first: ezz service uninstall, or stop it in services.msc.',
    };
  }
  return { ok: true };
}

function isExcluded(target, excludes) {
  return excludes.some((excluded) => {
    const relative = path.relative(excluded, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..' && !path.isAbsolute(relative));
  });
}

/**
 * Copies a directory tree without ever blocking the event loop.
 *
 * Files are streamed so the uninstall deadline can abort a large file. The
 * caller copies into a fresh sibling directory, which makes `wx` safe: a link
 * or a stale file can never redirect or receive the copy.
 */
async function copyTree(from, to, {
  excludes = [],
  deadline = Infinity,
  signal,
  stage = 'Moving data',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  fsApi = fs,
} = {}) {
  const pending = [{ source: from, destination: to }];

  while (pending.length) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    const current = pending.pop();
    await fsApi.promises.mkdir(current.destination, { recursive: true });
    const entries = await fsApi.promises.readdir(current.source, { withFileTypes: true });

    for (const entry of entries) {
      remainingStageMs(deadline, stage, timeoutMs);
      signal?.throwIfAborted();
      const source = path.join(current.source, entry.name);
      if (isExcluded(source, excludes)) continue;
      const destination = path.join(current.destination, entry.name);
      const stat = await fsApi.promises.lstat(source);
      if (stat.isSymbolicLink()) {
        throw new Error(`${source} is a link or reparse point`);
      }
      if (stat.isDirectory()) {
        pending.push({ source, destination });
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`${source} is not a regular file`);
      }

      await pipeline(
        fsApi.createReadStream(source, { signal }),
        fsApi.createWriteStream(destination, { flags: 'wx', mode: stat.mode }),
        { signal },
      );
      try {
        await fsApi.promises.utimes(destination, stat.atime, stat.mtime);
      } catch {
        // Timestamps are not part of copy integrity. Size verification follows.
      }
    }
  }
}

/**
 * Remove a staging tree created by this process without a synchronous
 * recursive delete that could outlive the stage deadline.
 */
async function removeStagingTree(root, {
  deadline = Infinity,
  signal,
  stage = 'Moving data',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  fsApi = fs,
} = {}) {
  let rootStat;
  try {
    rootStat = await fsApi.promises.lstat(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${root} is a link, reparse point, or non-directory`);
  }

  const pending = [root];
  const directories = [];
  const files = [];
  while (pending.length) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    const directory = pending.pop();
    directories.push(directory);
    const entries = await fsApi.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      remainingStageMs(deadline, stage, timeoutMs);
      signal?.throwIfAborted();
      const full = path.join(directory, entry.name);
      const stat = await fsApi.promises.lstat(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing a reparse point at ${full}`);
      }
      if (stat.isDirectory()) pending.push(full);
      else if (stat.isFile()) files.push(full);
      else throw new Error(`refusing a non-file entry at ${full}`);
    }
  }

  for (const file of files) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    await fsApi.promises.unlink(file);
  }
  for (const directory of directories.reverse()) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    await fsApi.promises.rmdir(directory);
  }
}

async function pathExists(file, fsApi = fs) {
  try {
    return await fsApi.promises.lstat(file);
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
async function unsafePathComponent(dir, {
  deadline = Infinity,
  signal,
  stage = 'Moving data',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  fsApi = fs,
} = {}) {
  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;

  for (const part of parts) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    current = path.join(current, part);
    let stat;
    try {
      stat = await pathExists(current, fsApi);
    } catch (error) {
      if (error?.code === 'EZ_STAGE_TIMEOUT' || signal?.aborted) throw error;
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
async function unsafeTreeEntry(dir, {
  destination = false,
  excludes = [],
  deadline = Infinity,
  stage = 'Moving data',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  signal,
  fsApi = fs,
} = {}) {
  let root;
  try {
    root = await fsApi.promises.lstat(dir);
  } catch (error) {
    throwIfStageInterrupted(error, signal);
    if (error?.code === 'ENOENT') return null;
    return `${dir} could not be inspected: ${error.message}`;
  }
  if (isLink(root)) return `${dir} is a link or reparse point`;
  if (!root.isDirectory()) return `${dir} is not a directory`;

  const pending = [dir];
  while (pending.length) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    const current = pending.pop();
    let entries;
    try {
      entries = await fsApi.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      throwIfStageInterrupted(error, signal);
      return `${current} could not be inspected: ${error.message}`;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (isExcluded(full, excludes)) continue;
      let stat;
      try {
        stat = await fsApi.promises.lstat(full);
      } catch (error) {
        throwIfStageInterrupted(error, signal);
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

async function ensureSafeDirectory(dir, {
  deadline = Infinity,
  signal,
  stage = 'Moving data',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  fsApi = fs,
} = {}) {
  const redirected = await unsafePathComponent(dir, {
    deadline, signal, stage, timeoutMs, fsApi,
  });
  if (redirected) return { ok: false, reason: redirected };

  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;

  for (const part of parts) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    current = path.join(current, part);
    const existing = await pathExists(current, fsApi);
    if (!existing) {
      try {
        await fsApi.promises.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code === 'EZ_STAGE_TIMEOUT' || signal?.aborted) throw error;
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

  const after = await unsafePathComponent(dir, {
    deadline, signal, stage, timeoutMs, fsApi,
  });
  return after
    ? { ok: false, reason: after }
    : { ok: true };
}

async function writeMarker(target, marker, payload, {
  deadline = Infinity,
  signal,
  stage = 'Restoring Server mode',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  fsApi = fs,
} = {}) {
  remainingStageMs(deadline, stage, timeoutMs);
  signal?.throwIfAborted();
  const before = await pathExists(marker, fsApi);
  if (before) {
    if (isLink(before)) return { ok: false, reason: `${marker} is a link or reparse point` };
    if (!before.isFile() || before.nlink !== 1) {
      return { ok: false, reason: `${marker} is not a regular file` };
    }
    return { ok: true, existed: true };
  }

  const temp = path.join(path.dirname(marker), `.server-mode.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsApi.promises.open(temp, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.close();
    handle = null;
    const unsafeTarget = await unsafePathComponent(target, {
      deadline, signal, stage, timeoutMs, fsApi,
    });
    const unsafeMarker = await unsafePathComponent(marker, {
      deadline, signal, stage, timeoutMs, fsApi,
    });
    if (unsafeTarget || unsafeMarker) {
      throw new Error('the Server-mode directory changed during migration');
    }
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    await fsApi.promises.rename(temp, marker);
    return { ok: true, existed: false };
  } catch (error) {
    try { await fsApi.promises.rm(temp, { force: true }); } catch { /* best effort */ }
    if (error?.code === 'EZ_STAGE_TIMEOUT' || signal?.aborted) throw error;
    return { ok: false, reason: error.message };
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* already closed */ }
    }
  }
}

/** Every file in a tree, as paths relative to its root. */
async function listFiles(dir, {
  base = dir,
  excludes = [],
  deadline = Infinity,
  stage = 'Verifying data copy',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  signal,
  fsApi = fs,
} = {}) {
  const out = [];
  let entries;
  try {
    entries = await fsApi.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throwIfStageInterrupted(error, signal);
    return out;
  }

  for (const entry of entries) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    const full = path.join(dir, entry.name);
    if (isExcluded(full, excludes)) continue;
    if (entry.isDirectory()) {
      out.push(...await listFiles(full, {
        base, excludes, deadline, stage, timeoutMs, signal, fsApi,
      }));
    } else {
      out.push(path.relative(base, full));
    }
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
export async function verifyCopy(from, to, {
  excludes = [],
  deadline = Infinity,
  stage = 'Verifying data copy',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  signal,
  fsApi = fs,
} = {}) {
  const missing = [];
  const differing = [];
  const files = await listFiles(from, {
    excludes, deadline, stage, timeoutMs, signal, fsApi,
  });

  for (const rel of files) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    const src = path.join(from, rel);
    const dst = path.join(to, rel);

    try {
      const [sourceStat, destinationStat] = await Promise.all([
        fsApi.promises.stat(src),
        fsApi.promises.stat(dst),
      ]);
      if (sourceStat.size !== destinationStat.size) differing.push(rel);
    } catch (error) {
      throwIfStageInterrupted(error, signal);
      if (error?.code === 'ENOENT') {
        missing.push(rel);
        continue;
      }
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
export async function moveDataDir({
  from,
  to,
  keepBackup = true,
  log = () => {},
  excludes = [],
  deadline = Infinity,
  signal,
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  fsApi = fs,
} = {}) {
  let fromStat;
  try {
    fromStat = await pathExists(from, fsApi);
  } catch (error) {
    throwIfStageInterrupted(error, signal);
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

  const busy = await assertNotInUseForMigration(from, {
    deadline, signal, stage: 'Moving data', timeoutMs, fsApi,
  });
  if (!busy.ok) return { ok: false, reason: busy.reason };

  const resolvedFrom = path.resolve(from);
  const excluded = excludes.map((entry) => path.resolve(entry));
  for (const entry of excluded) {
    const relative = path.relative(resolvedFrom, entry);
    if (relative === '' || relative.startsWith(`..${path.sep}`)
        || relative === '..' || path.isAbsolute(relative)) {
      return { ok: false, reason: `excluded path is not strictly inside the source: ${entry}` };
    }
  }

  // Validate both trees before the first mkdir or copy. Existing links could
  // otherwise redirect the complete data-tree copy outside either directory.
  const unsafeSource = await unsafeTreeEntry(from, {
    excludes: excluded,
    deadline,
    stage: 'Moving data',
    timeoutMs,
    signal,
    fsApi,
  });
  if (unsafeSource) {
    return { ok: false, reason: `source is not safe to copy: ${unsafeSource}. Nothing was changed.` };
  }
  const unsafeDestination = await unsafeTreeEntry(to, {
    destination: true,
    deadline,
    stage: 'Moving data',
    timeoutMs,
    signal,
    fsApi,
  });
  if (unsafeDestination) {
    return { ok: false, reason: `destination is not safe to write: ${unsafeDestination}. Nothing was changed.` };
  }

  // A non-empty destination is never merged with or overwritten by a move.
  // It may be a previous install, a second machine, or a partial migration.
  try {
    const destinationStat = await pathExists(to, fsApi);
    if (destinationStat) {
      if (isLink(destinationStat) || !destinationStat.isDirectory()) {
        return { ok: false, reason: `${to} is not a safe destination directory. Nothing was changed.` };
      }
      const existing = await fsApi.promises.readdir(to);
      if (existing.length) {
        return {
          ok: false,
          reason: `${to} is not empty. Move or remove its contents first; nothing has been changed.`,
        };
      }
    }
  } catch (error) {
    throwIfStageInterrupted(error, signal);
    return { ok: false, reason: `${to} could not be inspected: ${error.message}. Nothing was changed.` };
  }

  log(`Copying ${from} → ${to}`);
  const ensured = await ensureSafeDirectory(path.dirname(to), {
    deadline, signal, stage: 'Moving data', timeoutMs, fsApi,
  });
  if (!ensured.ok) {
    return { ok: false, reason: `destination is not safe to write: ${ensured.reason}. Nothing was changed.` };
  }

  const staging = path.join(
    path.dirname(to),
    `.${path.basename(to)}.migrate-${randomUUID()}`,
  );
  let copied = false;
  try {
    await fsApi.promises.mkdir(staging, { recursive: false, mode: 0o700 });
    const beforeCopy = await unsafeTreeEntry(from, {
      excludes: excluded,
      deadline,
      stage: 'Moving data',
      timeoutMs,
      signal,
      fsApi,
    });
    if (beforeCopy) throw new Error(beforeCopy);
    await copyTree(from, staging, {
      excludes: excluded,
      deadline,
      signal,
      stage: 'Moving data',
      timeoutMs,
      fsApi,
    });
    const afterCopy = await unsafeTreeEntry(staging, {
      destination: true,
      deadline,
      stage: 'Verifying data copy',
      timeoutMs,
      signal,
      fsApi,
    });
    if (afterCopy) throw new Error(afterCopy);

    const verified = await verifyCopy(from, staging, {
      excludes: excluded,
      deadline,
      stage: 'Verifying data copy',
      timeoutMs,
      signal,
      fsApi,
    });
    if (!verified.ok) {
      throw new Error('the copy is incomplete: '
        + [
          verified.missing.length ? `missing ${verified.missing.length} file(s): ${verified.missing.slice(0, 5).join(', ')}` : '',
          verified.differing.length ? `${verified.differing.length} file(s) differ in size: ${verified.differing.slice(0, 5).join(', ')}` : '',
        ].filter(Boolean).join('; '));
    }

    remainingStageMs(deadline, 'Verifying data copy', timeoutMs);
    signal?.throwIfAborted();
    const destinationNow = await pathExists(to, fsApi);
    if (destinationNow) await fsApi.promises.rmdir(to);
    await fsApi.promises.rename(staging, to);
    copied = true;
    remainingStageMs(deadline, 'Moving data', timeoutMs);
    signal?.throwIfAborted();
  } catch (err) {
    let cleanup = '';
    try {
      await removeStagingTree(staging, {
        stage: 'Rolling back data move',
        timeoutMs,
        fsApi,
      });
    } catch (cleanupError) {
      // Leave an unsafe or locked staging directory for the operator to inspect.
      cleanup = ` The partial staging directory was left at ${staging}: ${cleanupError.message}`;
    }
    // A cancelled rename may have completed after the timer fired. The marker
    // is still in the source at this point, so removing this verified copy
    // restores a clean retry state.
    try {
      await removeStagingTree(to, {
        stage: 'Rolling back data move',
        timeoutMs,
        fsApi,
      });
    } catch (cleanupError) {
      cleanup += ` The verified destination could not be removed: ${cleanupError.message}`;
    }
    throwIfStageInterrupted(err, signal);
    return {
      ok: false,
      reason: `copy failed: ${err.message}. The original was not removed`
        + (copied ? '' : ` and no live destination was installed.`)
        + cleanup,
    };
  }
  log('Copy verified.');

  let backup = backupPathFor(from);
  if (await pathExists(backup, fsApi)) backup = `${backup}-${randomUUID().slice(0, 8)}`;
  let sourceRenamed = false;
  try {
    remainingStageMs(deadline, 'Moving data', timeoutMs);
    signal?.throwIfAborted();
    await fsApi.promises.rename(from, backup);
    sourceRenamed = true;
    // rename() is not cancellable. If it completed after the stage deadline,
    // the caller has already received a timeout. Restore the source before
    // returning control so a later async completion cannot leave the move
    // half-committed.
    remainingStageMs(deadline, 'Moving data', timeoutMs);
    signal?.throwIfAborted();
    log(`Original kept at ${backup}`);
  } catch (err) {
    let sourceRestored = !sourceRenamed;
    let destinationRemoved = false;
    let rollbackFailure = '';

    // Once the source has moved, it must be restored before the uncommitted
    // destination is removed. Keeping both copies is safer than deleting the
    // destination when the rename back cannot be completed.
    if (sourceRenamed) {
      try {
        await fsApi.promises.rename(backup, from);
        sourceRestored = true;
        log(`Restored the original live directory at ${from}`);
      } catch (restoreError) {
        rollbackFailure = ` The source could not be restored from ${backup} to ${from}: ${restoreError.message}.`
          + ` Keep both ${backup} and ${to} for recovery.`;
      }
    }

    if (sourceRestored) {
      try {
        await removeStagingTree(to, {
          stage: 'Rolling back data move',
          timeoutMs,
          fsApi,
        });
        destinationRemoved = true;
      } catch (cleanupError) {
        rollbackFailure += ` The verified destination could not be removed: ${cleanupError.message}`;
      }
    }

    if (err?.code === 'EZ_STAGE_TIMEOUT' || signal?.aborted) {
      err.message += sourceRestored
        ? ` The original source was restored at ${from}`
          + (destinationRemoved
            ? ' and the uncommitted destination was removed.'
            : `; the uncommitted destination remains at ${to}.`)
        : rollbackFailure;
      throw err;
    }

    log(`Original left in place at ${from}; the move was not activated`);
    return {
      ok: false,
      moved: false,
      backup: sourceRestored ? null : backup,
      originalAt: sourceRestored ? from : backup,
      reason: `the data was copied and verified, but the live directory could not be switched: ${err.message}. `
        + (sourceRestored
          ? `The original remains live at ${from}.${rollbackFailure}`
          : `The original remains at ${backup}, and the verified destination is at ${to}.${rollbackFailure}`),
    };
  }

  if (!keepBackup) {
    try {
      await fsApi.promises.rm(backup, { recursive: true, force: true });
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
export async function enableServerMode({ log = () => {} } = {}) {
  if (!isWindows) {
    return { ok: false, dataDir: getDataDir(), migrated: false, backup: null, reason: 'Server mode is Windows-only' };
  }

  const target = programDataDir();
  const marker = serverModeMarkerPath();

  const safeTarget = await ensureSafeDirectory(target);
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
    markerStat = await pathExists(marker);
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

  const moved = await moveDataDir({ from: userDataDir(), to: target, log });
  if (!moved.ok) {
    // The marker is NOT written when the migration failed. Writing it would
    // point every process at a directory that does not hold the user's data.
    return { ok: false, dataDir: target, migrated: false, backup: null, reason: moved.reason };
  }

  const marked = await writeMarker(
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
export async function disableServerMode({
  log = () => {},
  deadline = Infinity,
  signal,
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  deps = {},
} = {}) {
  if (!isWindows) {
    return { ok: false, dataDir: getDataDir(), moved: false, backup: null, reason: 'Server mode is Windows-only' };
  }

  const source = programDataDir();
  const target = userDataDir();
  const marker = serverModeMarkerPath();

  let markerStat;
  try {
    markerStat = await pathExists(marker);
  } catch (error) {
    throwIfStageInterrupted(error, signal);
    return {
      ok: false,
      dataDir: source,
      moved: false,
      backup: null,
      reason: `could not inspect ${marker}: ${error.message}`,
    };
  }
  if (!markerStat) {
    return { ok: true, dataDir: target, moved: false, backup: null, reason: 'not in Server mode' };
  }
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.nlink !== 1) {
    return {
      ok: false,
      dataDir: source,
      moved: false,
      backup: null,
      reason: `${marker} is a link, reparse point, hard link, or non-regular marker; nothing was changed`,
    };
  }

  let markerHandle;
  try {
    markerHandle = await fs.promises.open(marker, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = await markerHandle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 64 * 1024) {
      throw new Error('the opened marker is not a bounded regular single-link file');
    }
    const markerPayload = await markerHandle.readFile('utf8');
    if (Buffer.byteLength(markerPayload, 'utf8') > 64 * 1024) {
      throw new Error('the opened marker is larger than 64 KiB');
    }
  } catch (error) {
    throwIfStageInterrupted(error, signal);
    return {
      ok: false,
      dataDir: source,
      moved: false,
      backup: null,
      reason: `could not read ${marker}: ${error.message}`,
    };
  } finally {
    if (markerHandle) {
      try { await markerHandle.close(); } catch { /* already closed */ }
    }
  }

  let moved;
  try {
    moved = await (deps.moveDataDir ?? moveDataDir)({
      from: source,
      to: target,
      log,
      excludes: [
        marker,
        ...SERVER_CODE_DIR_NAMES.map((name) => path.join(source, name)),
      ],
      deadline,
      signal,
      timeoutMs,
    });
  } catch (error) {
    if (error?.code === 'EZ_STAGE_TIMEOUT' || signal?.aborted) {
      error.message = `${error.message} The Server-mode marker remains in ${source}; the live data stays there unless the move explicitly completed.`;
      throw error;
    }
    return {
      ok: false,
      dataDir: source,
      moved: false,
      backup: null,
      reason: `${error.message} The Server-mode marker remains in ${source}.`,
    };
  }
  if (!moved.ok) {
    return {
      ok: false,
      dataDir: source,
      moved: false,
      backup: null,
      reason: `${moved.reason} The Server-mode marker remains in ${source}.`,
    };
  }

  resetDataDirCache();
  log(`Server mode disabled. Data directory: ${target}`);
  return { ok: true, dataDir: target, moved: moved.moved, backup: moved.backup, originalAt: moved.originalAt, reason: moved.reason };
}
