/**
 * Small synchronous filesystem helpers for security-sensitive operations.
 *
 * Node has no unlinkat/openat API. On Linux this module anchors operations to
 * an already-open directory through /proc/self/fd, so replacing an ancestor
 * pathname cannot redirect the operation. On Windows it verifies the directory
 * identity before and after each operation and the opened file by descriptor
 * and pathname identity. Final symlinks and hard links are always refused.
 */

import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from './atomicState.js';

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY = fs.constants.O_DIRECTORY || 0;
const CLOEXEC = fs.constants.O_CLOEXEC || 0;

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino,
  );
}

function samePathIdentity(left, right) {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

export function snapshotDirectory(directory) {
  const stat = lstatIfPresent(directory);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing a linked or non-directory path: ${directory}`);
  }
  return { path: path.resolve(directory), stat };
}

export function requireDirectory(directory, expectedIdentity = null) {
  const snapshot = snapshotDirectory(directory);
  if (!snapshot) throw new Error(`The directory does not exist: ${directory}`);
  if (expectedIdentity && !sameIdentity(expectedIdentity, snapshot.stat)) {
    throw new Error(`The directory identity changed: ${directory}`);
  }
  return snapshot;
}

export function directoryStillMatches(snapshot) {
  const current = lstatIfPresent(snapshot.path);
  return Boolean(
    current
    && !current.isSymbolicLink()
    && current.isDirectory()
    && sameIdentity(snapshot.stat, current),
  );
}

function openDirectoryHandle(snapshot) {
  if (process.platform === 'win32') return null;
  const handle = fs.openSync(
    snapshot.path,
    fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC,
  );
  try {
    const opened = fs.fstatSync(handle);
    if (!opened.isDirectory() || !sameIdentity(opened, snapshot.stat)) {
      throw new Error(`The directory identity changed while opening: ${snapshot.path}`);
    }
    return handle;
  } catch (error) {
    try { fs.closeSync(handle); } catch { /* cleanup */ }
    throw error;
  }
}

function anchored(parentHandle, directory, name) {
  return process.platform === 'linux' && parentHandle !== null
    ? path.join('/proc/self/fd', String(parentHandle), name)
    : path.join(directory, name);
}

function requireChildName(name, label) {
  if (typeof name !== 'string'
      || !name
      || name === '.'
      || name === '..'
      || path.basename(name) !== name
      || name.includes('/')
      || name.includes('\\')) {
    throw new Error(`Refusing an invalid ${label} name: ${String(name)}`);
  }
}

/**
 * Open one direct child for reading or exclusive creation.
 *
 * The returned handle owns both descriptors. Call close() unconditionally.
 */
export function openVerifiedChild(file, {
  expectedDirectory = path.dirname(file),
  expectedDirectoryIdentity = null,
  flags = fs.constants.O_RDONLY,
  mode,
  exclusive = false,
  requireSingleLink = true,
} = {}) {
  const parent = requireDirectory(expectedDirectory, expectedDirectoryIdentity);
  const name = path.basename(file);
  requireChildName(name, 'child');

  let directoryHandle = null;
  let handle;
  try {
    directoryHandle = openDirectoryHandle(parent);
    const openedPath = anchored(directoryHandle, parent.path, name);
    const openFlags = flags | NOFOLLOW | (exclusive ? fs.constants.O_EXCL : 0);
    handle = fs.openSync(openedPath, openFlags, mode);
    const opened = fs.fstatSync(handle);
    if (!opened.isFile() || (requireSingleLink && opened.nlink !== 1)) {
      throw new Error(`Refusing a linked or non-regular file: ${file}`);
    }

    const atPath = lstatIfPresent(file);
    if (!samePathIdentity(opened, atPath) || !directoryStillMatches(parent)) {
      throw new Error(`The filesystem path changed while opening: ${file}`);
    }

    return {
      fd: handle,
      directoryFd: directoryHandle,
      opened,
      parent,
      file: path.resolve(file),
      close() {
        if (handle !== undefined) {
          try { fs.closeSync(handle); } catch { /* already closed */ }
          handle = undefined;
        }
        if (directoryHandle !== null) {
          try { fs.closeSync(directoryHandle); } catch { /* already closed */ }
          directoryHandle = null;
        }
      },
    };
  } catch (error) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* cleanup */ }
    }
    if (exclusive && directoryHandle !== null) {
      try { fs.unlinkSync(anchored(directoryHandle, parent.path, name)); } catch { /* never created */ }
    }
    if (directoryHandle !== null) {
      try { fs.closeSync(directoryHandle); } catch { /* cleanup */ }
    }
    throw error;
  }
}

/** Atomically publish a completed JSON/text payload through an exclusive temp. */
export function writeFileEventual(file, data, {
  expectedDirectory = path.dirname(file),
  expectedDirectoryIdentity = null,
  mode = 0o600,
  tempName = `.${path.basename(file)}.${process.pid}.${cryptoRandom()}.tmp`,
} = {}) {
  const parent = requireDirectory(expectedDirectory, expectedDirectoryIdentity);
  requireChildName(path.basename(file), 'destination');
  requireChildName(tempName, 'temporary');
  const directoryHandle = openDirectoryHandle(parent);
  let tempHandle;
  let tempPath;
  let tempStat;
  try {
    tempPath = anchored(directoryHandle, parent.path, tempName);
    tempHandle = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | NOFOLLOW | CLOEXEC,
      mode,
    );
    tempStat = fs.fstatSync(tempHandle);
    if (!tempStat.isFile() || tempStat.nlink !== 1) {
      throw new Error(`Refusing a linked or non-regular temporary file: ${tempPath}`);
    }
    fs.writeFileSync(tempHandle, data);
    fs.fsyncSync(tempHandle);
    tempStat = fs.fstatSync(tempHandle);
    if (!tempStat.isFile() || tempStat.nlink !== 1) {
      throw new Error(`Refusing a linked or non-regular temporary file: ${tempPath}`);
    }
    fs.closeSync(tempHandle);
    tempHandle = undefined;

    if (!samePathIdentity(tempStat, lstatIfPresent(tempPath))
        || !directoryStillMatches(parent)) {
      throw new Error(`The destination directory changed before publication: ${parent.path}`);
    }
    // The publication rename rides out a momentary Windows sharing denial with
    // the shared retry (core/atomicState.js): a reader holding the old
    // `state.json` open for microseconds must not fail a deploy.
    renameWithRetry(
      anchored(directoryHandle, parent.path, tempName),
      anchored(directoryHandle, parent.path, path.basename(file)),
    );
    if (!samePathIdentity(tempStat, lstatIfPresent(file))
        || !directoryStillMatches(parent)) {
      throw new Error(`The destination directory changed during publication: ${parent.path}`);
    }
  } finally {
    if (tempHandle !== undefined) {
      try { fs.closeSync(tempHandle); } catch { /* cleanup */ }
    }
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch { /* renamed or never created */ }
    }
    if (directoryHandle !== null) {
      try { fs.closeSync(directoryHandle); } catch { /* cleanup */ }
    }
  }
}

/** Remove one verified direct-child file, without following a replacement. */
export function unlinkVerifiedChild(file, {
  expectedDirectory = path.dirname(file),
  expectedDirectoryIdentity = null,
  expected,
  beforeDelete,
} = {}) {
  const opened = openVerifiedChild(file, { expectedDirectory, expectedDirectoryIdentity });
  try {
    if (expected && !sameIdentity(expected, opened.opened)) {
      throw new Error(`The file identity changed before deletion: ${file}`);
    }
    if (beforeDelete) beforeDelete(opened, file);
    const atPath = lstatIfPresent(file);
    if (!samePathIdentity(opened.opened, atPath) || !directoryStillMatches(opened.parent)) {
      throw new Error(`The file or its directory changed before deletion: ${file}`);
    }
    fs.unlinkSync(anchored(opened.directoryFd, opened.parent.path, path.basename(file)));
    if (!directoryStillMatches(opened.parent)) {
      throw new Error(`The file directory changed during deletion: ${file}`);
    }
    return true;
  } finally {
    opened.close();
  }
}

/** Remove one verified empty direct-child directory. */
export function rmdirVerifiedChild(directory, {
  expectedDirectory = path.dirname(directory),
  expectedDirectoryIdentity = null,
} = {}) {
  const parent = requireDirectory(expectedDirectory, expectedDirectoryIdentity);
  const target = requireDirectory(directory);
  const directoryHandle = openDirectoryHandle(parent);
  try {
    const atPath = lstatIfPresent(anchored(directoryHandle, parent.path, path.basename(directory)));
    if (!sameIdentity(target.stat, atPath) || !directoryStillMatches(parent)) {
      throw new Error(`The directory parent changed before deletion: ${directory}`);
    }
    fs.rmdirSync(anchored(directoryHandle, parent.path, path.basename(directory)));
    if (!directoryStillMatches(parent)) {
      throw new Error(`The directory parent changed during deletion: ${directory}`);
    }
    return target;
  } finally {
    if (directoryHandle !== null) {
      try { fs.closeSync(directoryHandle); } catch { /* cleanup */ }
    }
  }
}

function cryptoRandom() {
  // Keep the helper dependency-free without exposing a weak Math.random name
  // in callers that generate quarantine or temporary names.
  return `${Date.now().toString(36)}${process.hrtime.bigint().toString(36)}`;
}

