/**
 * Ownership record for certificate files created by Easy DevOps.
 *
 * A configured sslDir can contain unrelated certificates, keys and files. The
 * purge therefore deletes only paths this module recorded after issuance. The
 * manifest is deliberately conservative: no record means no deletion.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  getDataDir,
  WINDOWS_PROGRAM_DATA_ROOT,
  WINDOWS_PROGRAM_FILES_ROOT,
  WINDOWS_PROGRAM_FILES_X86_ROOT,
  WINDOWS_SYSTEM_ROOT,
} from '../platform.js';
import { validateDomainName } from '../validators.js';
import { acquireArtifactLockSync } from './artifact-lock.js';
import { rmdirVerifiedChild, unlinkVerifiedChild } from '../safe-file.js';

export const MANAGED_ARTIFACT_MANIFEST = 'ssl-managed-artifacts.json';
export const MANAGED_ARTIFACT_VERSION = 2;

const MANIFEST_MAX_BYTES = 1024 * 1024;

function normalizedAbsolute(target) {
  if (typeof target !== 'string' || !target || !path.isAbsolute(target)) return null;
  return path.normalize(path.resolve(target));
}

function comparable(target) {
  const normalized = normalizedAbsolute(target);
  return process.platform === 'win32' ? normalized?.toLowerCase() : normalized;
}

function samePath(left, right) {
  const a = comparable(left);
  const b = comparable(right);
  return Boolean(a && b && a === b);
}

function isInside(parent, child) {
  const p = comparable(parent);
  const c = comparable(child);
  if (!p || !c) return false;
  const relative = path.relative(p, c);
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

function existingLstat(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function systemDirectories() {
  const denied = new Set([
    '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/opt',
    '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var',
    '/etc/cron.d', '/etc/init.d', '/etc/letsencrypt', '/etc/nginx',
    '/etc/pam.d', '/etc/pki', '/etc/ssl', '/etc/ssl/certs', '/etc/ssl/private',
    '/etc/sudoers.d', '/etc/systemd', '/usr/bin', '/usr/local', '/usr/local/bin',
    '/usr/sbin', '/usr/share', '/var/lib', '/var/log', '/var/spool', '/var/www',
  ]);

  const windowsRoots = [
    WINDOWS_SYSTEM_ROOT,
    WINDOWS_PROGRAM_FILES_ROOT,
    WINDOWS_PROGRAM_FILES_X86_ROOT,
    WINDOWS_PROGRAM_DATA_ROOT,
  ];
  for (const dir of windowsRoots) {
    if (dir) denied.add(path.win32.normalize(dir).toLowerCase());
  }
  return denied;
}

const SYSTEM_DIRECTORIES = systemDirectories();

function isFilesystemRoot(target) {
  const resolved = normalizedAbsolute(target);
  return Boolean(resolved && path.dirname(resolved) === resolved);
}

function isDeniedSystemDirectory(target) {
  const resolved = normalizedAbsolute(target);
  if (!resolved) return true;
  if (isFilesystemRoot(resolved)) return true;

  if (process.platform === 'win32') {
    const lower = path.win32.normalize(resolved).toLowerCase();
    if (SYSTEM_DIRECTORIES.has(lower)) return true;
    const protectedRoots = [
      WINDOWS_SYSTEM_ROOT,
      WINDOWS_PROGRAM_FILES_ROOT,
      WINDOWS_PROGRAM_FILES_X86_ROOT,
    ];
    return protectedRoots.some((root) => isInside(root, resolved));
  }

  return SYSTEM_DIRECTORIES.has(path.posix.normalize(resolved));
}

function assertNoLinkAncestors(target) {
  const resolved = normalizedAbsolute(target);
  if (!resolved) throw new Error(`Use an absolute path without links: ${target}`);

  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  const components = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    const stat = existingLstat(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing a symbolic link, junction or reparse point at ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Expected a directory at ${current}`);
    }
  }
}

function canonicalExistingDirectory(target, { rejectSystem = true } = {}) {
  const normalized = normalizedAbsolute(target);
  if (!normalized) throw new Error(`Use an absolute certificate directory: ${target}`);
  if (rejectSystem && isDeniedSystemDirectory(normalized)) {
    throw new Error(`Refusing a filesystem root or system directory as sslDir: ${normalized}`);
  }

  assertNoLinkAncestors(normalized);
  const stat = existingLstat(normalized);
  if (!stat) throw new Error(`The certificate directory does not exist: ${normalized}`);
  if (!stat.isDirectory()) throw new Error(`The certificate path is not a directory: ${normalized}`);
  assertPrivateOwnership(stat, normalized, 'certificate directory');

  const real = fs.realpathSync.native(normalized);
  if (!samePath(real, normalized)) {
    throw new Error(`The certificate directory is not canonical: ${normalized} resolves to ${real}`);
  }
  return normalized;
}

function assertPrivateOwnership(stat, target, label) {
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`The ${label} is owned by another user: ${target}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`The ${label} must not be writable by group or other users: ${target}`);
  }
}

function normalizeArtifact(relative, field) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0')) {
    throw new Error(`Invalid managed ${field} path`);
  }
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new Error(`Managed ${field} paths must be relative: ${relative}`);
  }

  const portable = relative.replaceAll('\\', '/');
  const parts = portable.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error(`Unsafe managed ${field} path: ${relative}`);
  }
  return parts.join('/');
}

function isManagedDomainDirectory(name) {
  return name === '.account'
    || (typeof name === 'string' && validateDomainName(name) === null);
}

function normalizeManagedDirectory(directory) {
  const normalized = normalizeArtifact(directory, 'directory');
  if (normalized.includes('/') || !isManagedDomainDirectory(normalized)) {
    throw new Error(`Not a known managed certificate directory: ${directory}`);
  }
  return normalized;
}

function normalizeManagedFile(file) {
  const normalized = normalizeArtifact(file, 'file');
  const parts = normalized.split('/');
  if (parts.length !== 2 || !isManagedDomainDirectory(parts[0])) {
    throw new Error(`Not a known managed certificate file: ${file}`);
  }
  const knownNames = parts[0] === '.account'
    ? new Set(['account.key'])
    : new Set(['fullchain.pem', 'privkey.pem', 'ez-cert.json']);
  if (!knownNames.has(parts[1])) {
    throw new Error(`Not a known managed certificate file: ${file}`);
  }
  return normalized;
}

function artifactAbsolute(sslDir, relative) {
  const normalized = normalizeArtifact(relative, 'artifact');
  const target = path.resolve(sslDir, ...normalized.split('/'));
  if (!isInside(sslDir, target) || samePath(sslDir, target)) {
    throw new Error(`Managed artifact escapes its certificate directory: ${relative}`);
  }
  return target;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function managedManifestPath(dataDir = getDataDir()) {
  const resolved = normalizedAbsolute(dataDir);
  if (!resolved) throw new Error(`Use an absolute Easy DevOps data directory: ${dataDir}`);
  return path.join(resolved, MANAGED_ARTIFACT_MANIFEST);
}

function emptyManifest() {
  return { version: MANAGED_ARTIFACT_VERSION, roots: [] };
}

function fileIdentity(absolute, relative = null) {
  let handle;
  try {
    handle = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Expected one unlinked regular file: ${absolute}`);
    }
    const data = fs.readFileSync(handle);
    return {
      ...(relative ? { path: relative } : {}),
      sha256: createHash('sha256').update(data).digest('hex'),
      size: stat.size,
      dev: String(stat.dev),
      ino: String(stat.ino),
    };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function validateFileIdentity(value, relative) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Managed certificate file ${relative} has no recorded identity.`);
  }
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error(`Managed certificate file ${relative} has an invalid SHA-256 identity.`);
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error(`Managed certificate file ${relative} has an invalid size.`);
  }
  for (const key of ['dev', 'ino']) {
    if (typeof value[key] !== 'string' || !value[key]) {
      throw new Error(`Managed certificate file ${relative} has an invalid ${key} identity.`);
    }
  }
  return {
    path: relative,
    sha256: value.sha256,
    size: value.size,
    dev: value.dev,
    ino: value.ino,
  };
}

function identityMatches(expected, actual) {
  return expected.sha256 === actual.sha256
    && expected.size === actual.size
    && expected.dev === actual.dev
    && expected.ino === actual.ino;
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The managed-certificate manifest must be a JSON object.');
  }
  if (value.version !== MANAGED_ARTIFACT_VERSION || !Array.isArray(value.roots)) {
    throw new Error(`Unsupported managed-certificate manifest version: ${value.version}`);
  }

  const roots = value.roots.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('The managed-certificate manifest contains an invalid root.');
    }
    const sslDir = normalizedAbsolute(entry.sslDir);
    if (!sslDir) throw new Error('Every managed-certificate root must be absolute.');
    if (!Array.isArray(entry.files) || !Array.isArray(entry.directories)) {
      throw new Error(`The managed-certificate root ${sslDir} has invalid artifact lists.`);
    }
    const files = entry.files.map((file) => {
      if (typeof file === 'string') {
        throw new Error(
          `Legacy managed-certificate file ${file} has no identity; record it again before deletion.`,
        );
      }
      const record = file && typeof file === 'object' && !Array.isArray(file) ? file : null;
      const relative = normalizeManagedFile(record?.path);
      return validateFileIdentity(record, relative);
    });
    return {
      sslDir,
      rootCreated: entry.rootCreated === true,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      directories: uniqueSorted(
        entry.directories.map((directory) => normalizeManagedDirectory(directory)),
      ),
    };
  });

  return { version: MANAGED_ARTIFACT_VERSION, roots };
}

/**
 * Loads the manifest without following a link. A malformed or linked manifest
 * is returned as an error so callers can keep every certificate fail-safe.
 */
export function loadManagedArtifactManifest({ dataDir = getDataDir() } = {}) {
  const manifestPath = managedManifestPath(dataDir);
  if (!existingLstat(manifestPath)) {
    return { ok: true, path: manifestPath, manifest: emptyManifest(), reason: null };
  }

  let handle;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = fs.openSync(manifestPath, fs.constants.O_RDONLY | noFollow);
    const stat = handle ? fs.fstatSync(handle) : null;
    if (!stat?.isFile() || stat.nlink !== 1) {
      throw new Error('The managed-certificate manifest is linked or not a regular file.');
    }
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o077) !== 0) {
        throw new Error('The managed-certificate manifest must be readable only by its owner.');
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('The managed-certificate manifest is owned by another user.');
      }
    }
    if (stat.size > MANIFEST_MAX_BYTES) {
      throw new Error('The managed-certificate manifest is unexpectedly large.');
    }
    const text = fs.readFileSync(handle, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed?.version === 1) {
      return {
        ok: false,
        legacyVersion: 1,
        path: manifestPath,
        manifest: emptyManifest(),
        reason: 'The version 1 managed-certificate manifest has no file identities. '
          + 'Certificate deletion is disabled until issuance records the files again.',
      };
    }
    const manifest = validateManifest(parsed);
    return { ok: true, path: manifestPath, manifest, reason: null };
  } catch (error) {
    return {
      ok: false,
      legacyVersion: null,
      path: manifestPath,
      manifest: emptyManifest(),
      reason: error.message,
    };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function atomicWriteManifest(dataDir, manifest) {
  const target = managedManifestPath(dataDir);
  const temporary = path.join(dataDir, `.${MANAGED_ARTIFACT_MANIFEST}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Records only paths that the current issuance created or replaced.
 *
 * Multiple certificate roots are retained. A lock plus same-directory
 * exclusive temporary file prevents concurrent issuances from losing entries
 * and prevents readers from observing a partial manifest.
 */
export async function recordManagedArtifacts({
  dataDir = getDataDir(),
  sslDir,
  files = [],
  directories = [],
  rootCreated = false,
} = {}) {
  const canonicalRoot = canonicalExistingDirectory(sslDir);
  if (isInside(dataDir, canonicalRoot) || isInside(canonicalRoot, dataDir)) {
    throw new Error('The certificate directory must not overlap the Easy DevOps data directory.');
  }

  const fileList = uniqueSorted(files.map((file) => normalizeManagedFile(file)));
  const directoryList = uniqueSorted(
    directories.map((directory) => normalizeManagedDirectory(directory)),
  );

  const lock = acquireArtifactLockSync({
    dataDir,
    key: MANAGED_ARTIFACT_MANIFEST,
    timeoutMs: 10_000,
  });
  try {
    const verifiedRoot = canonicalExistingDirectory(canonicalRoot);
    if (!samePath(verifiedRoot, canonicalRoot)) {
      throw new Error('The certificate directory changed while its files were being recorded.');
    }
    const loaded = loadManagedArtifactManifest({ dataDir });
    if (!loaded.ok && loaded.legacyVersion !== 1) throw new Error(loaded.reason);
    const manifest = loaded.ok ? loaded.manifest : emptyManifest();

    const fileRecords = fileList.map((file) => {
      const absolute = artifactAbsolute(canonicalRoot, file);
      assertNoLinkAncestors(path.dirname(absolute));
      const stat = existingLstat(absolute);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error(`Cannot record a missing, linked or non-regular managed file: ${absolute}`);
      }
      return fileIdentity(absolute, file);
    });
    for (const directory of directoryList) {
      const absolute = artifactAbsolute(canonicalRoot, directory);
      assertNoLinkAncestors(absolute);
      const stat = existingLstat(absolute);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Cannot record a missing, linked or non-directory managed path: ${absolute}`);
      }
    }

    let root = manifest.roots.find((entry) => samePath(entry.sslDir, canonicalRoot));
    if (!root) {
      root = {
        sslDir: canonicalRoot,
        rootCreated: rootCreated === true,
        files: [],
        directories: [],
      };
      manifest.roots.push(root);
    }
    root.rootCreated = root.rootCreated || rootCreated === true;
    const byPath = new Map(root.files.map((record) => [record.path, record]));
    for (const record of fileRecords) byPath.set(record.path, record);
    root.files = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
    root.directories = uniqueSorted([...root.directories, ...directoryList]);
    manifest.roots.sort((a, b) => a.sslDir.localeCompare(b.sslDir));
    atomicWriteManifest(dataDir, manifest);
    return { ...root, files: root.files.map((record) => record.path) };
  } finally {
    lock.release();
  }
}

function validatedManifestRoot(entry, dataDir) {
  const root = canonicalExistingDirectory(entry.sslDir);
  if (isInside(dataDir, root) || isInside(root, dataDir)) {
    throw new Error('The certificate root overlaps the Easy DevOps data directory.');
  }

  for (const directory of entry.directories) {
    const absolute = artifactAbsolute(root, directory);
    assertNoLinkAncestors(absolute);
    const stat = existingLstat(absolute);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing linked or non-directory managed path: ${absolute}`);
    }
    assertPrivateOwnership(stat, absolute, 'managed certificate directory');
  }
  return root;
}

function unmanageableCertificates(root) {
  const kept = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return kept;
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.name === '.account') {
      const key = path.join(absolute, 'account.key');
      if (existingLstat(key)) kept.push(key);
      continue;
    }
    for (const name of ['fullchain.pem', 'privkey.pem', 'ez-cert.json']) {
      const candidate = path.join(absolute, name);
      if (existingLstat(candidate)) kept.push(candidate);
    }
  }
  return kept;
}

function removeManagedFile(file, expected, deps = {}) {
  assertNoLinkAncestors(path.dirname(file));
  const stat = existingLstat(file);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Refusing linked or non-regular managed artifact: ${file}`);
  }
  if (!identityMatches(expected, fileIdentity(file))) {
    throw new Error(`Refusing a replaced managed artifact whose recorded identity changed: ${file}`);
  }

  return unlinkVerifiedChild(file, {
    expectedDirectory: path.dirname(file),
    expected: stat,
    beforeDelete() {
      if (deps.afterValidation) deps.afterValidation(file, expected);
    },
  });
}

function removeManagedDirectory(directory) {
  assertNoLinkAncestors(directory);
  const stat = existingLstat(directory);
  if (!stat) return false;
  return Boolean(rmdirVerifiedChild(directory));
}

/**
 * Deletes manifest-owned files, then removes only recorded empty directories.
 * It never removes a directory recursively and never follows a link.
 */
export async function removeManagedCertificateArtifacts({
  dataDir = getDataDir(),
  loadedManifest: _snapshotIgnored = null,
  unmanagedSslDir = null,
  deps = {},
} = {}) {
  const removedFiles = [];
  const removedDirectories = [];
  const kept = [];
  const errors = [];

  const lock = acquireArtifactLockSync({
    dataDir,
    key: MANAGED_ARTIFACT_MANIFEST,
    timeoutMs: 10_000,
  });
  const loadedManifest = loadManagedArtifactManifest({ dataDir });
  if (!loadedManifest.ok) {
    errors.push({ path: loadedManifest.path, reason: loadedManifest.reason });
    lock.release();
    return {
      ok: false,
      manifestPath: loadedManifest.path,
      removedFiles,
      removedDirectories,
      kept,
      errors,
      roots: [],
    };
  }

  const roots = [];
  const managedRoots = loadedManifest.manifest.roots.map((entry) => entry.sslDir);
  try {
    for (const entry of loadedManifest.manifest.roots) {
    const rootStat = existingLstat(entry.sslDir);
    if (!rootStat) continue;
    let root;
    try {
      root = validatedManifestRoot(entry, dataDir);
    } catch (error) {
      errors.push({ path: entry.sslDir, reason: error.message });
      roots.push({ path: entry.sslDir, status: 'refused' });
      continue;
    }

    roots.push({ path: root, status: 'managed' });
    const files = entry.files
      .map((file) => ({
        relative: file.path,
        expected: file,
        absolute: artifactAbsolute(root, file.path),
      }))
      .sort((left, right) => right.absolute.length - left.absolute.length);
    for (const file of files) {
      try {
        if (removeManagedFile(file.absolute, file.expected, deps)) removedFiles.push(file.absolute);
      } catch (error) {
        errors.push({ path: file.absolute, reason: error.message });
      }
    }

    const directories = entry.directories
      .map((directory) => ({ relative: directory, absolute: artifactAbsolute(root, directory) }))
      .sort((left, right) => right.absolute.length - left.absolute.length);
    for (const directory of directories) {
      try {
        if (removeManagedDirectory(directory.absolute)) {
          removedDirectories.push(directory.absolute);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
          errors.push({ path: directory.absolute, reason: error.message });
        }
      }
    }

    if (entry.rootCreated) {
      try {
        if (removeManagedDirectory(root)) removedDirectories.push(root);
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
          errors.push({ path: root, reason: error.message });
        }
      }
    }

    if (existingLstat(root)) {
      const residual = unmanageableCertificates(root);
      kept.push(...(residual.length ? residual : [root]));
    }
  }
  } finally {
    lock.release();
  }

  const configured = normalizedAbsolute(unmanagedSslDir);
  if (configured && !managedRoots.some((root) => samePath(root, configured))) {
    try {
      const canonical = canonicalExistingDirectory(configured);
      const residual = unmanageableCertificates(canonical);
      kept.push(...(residual.length ? residual : [canonical]));
    } catch (error) {
      if (error?.code !== 'ENOENT' && existingLstat(configured)) kept.push(configured);
    }
  }

  return {
    ok: errors.length === 0,
    manifestPath: loadedManifest.path,
    removedFiles,
    removedDirectories,
    kept: uniqueSorted(kept),
    errors,
    roots,
  };
}

/**
 * Deletes one issuance-managed certificate directory without recursing.
 *
 * The caller holds the SSL lifecycle lock, so no issuance or purge can change
 * the manifest during this operation. Unrecorded files stay in place and keep
 * the directory from being removed.
 */
export function removeManagedCertificateDomain({
  dataDir = getDataDir(),
  sslDir,
  domain,
  deps = {},
} = {}) {
  if (validateDomainName(domain) !== null) {
    return { ok: false, code: 'cert_not_found', domain: String(domain ?? '') };
  }

  let root;
  try {
    root = canonicalExistingDirectory(sslDir);
  } catch (error) {
    return { ok: false, code: 'delete_failed', domain, detail: error.message };
  }

  const lock = acquireArtifactLockSync({
    dataDir,
    key: MANAGED_ARTIFACT_MANIFEST,
    timeoutMs: 10_000,
  });
  try {
    const loaded = loadManagedArtifactManifest({ dataDir });
    if (!loaded.ok) {
      return { ok: false, code: 'delete_failed', domain, detail: loaded.reason };
    }

    const entry = loaded.manifest.roots.find((candidate) => samePath(candidate.sslDir, root));
    if (!entry) {
      return {
        ok: false,
        code: 'cert_not_managed',
        domain,
        detail: 'This certificate was not recorded as created by Easy DevOps, so it was not deleted.',
      };
    }

    try {
      validatedManifestRoot(entry, dataDir);
    } catch (error) {
      return { ok: false, code: 'delete_failed', domain, detail: error.message };
    }

    const files = entry.files
      .filter((file) => file.path.startsWith(`${domain}/`))
      .map((file) => ({
        expected: file,
        absolute: artifactAbsolute(root, file.path),
      }));
    if (files.length === 0) {
      return {
        ok: false,
        code: 'cert_not_managed',
        domain,
        detail: 'No Easy DevOps-owned files are recorded for this certificate, so it was not deleted.',
      };
    }

    const removedFiles = [];
    const errors = [];
    for (const file of files) {
      try {
        if (removeManagedFile(file.absolute, file.expected, deps)) {
          removedFiles.push(file.absolute);
        }
      } catch (error) {
        errors.push({ path: file.absolute, reason: error.message });
      }
    }

    const directory = path.join(root, domain);
    let removedDirectory = false;
    let keptDirectory = existingLstat(directory) !== null;
    if (keptDirectory) {
      try {
        rmdirVerifiedChild(directory);
        removedDirectory = true;
        keptDirectory = false;
      } catch (error) {
        if (error?.code !== 'ENOTEMPTY') {
          errors.push({ path: directory, reason: error.message });
        }
      }
    }

    return {
      ok: errors.length === 0,
      code: errors.length === 0 ? null : 'delete_failed',
      domain,
      directory,
      removedFiles,
      removedDirectory,
      keptDirectory,
      errors,
      detail: errors.map((error) => error.reason).join('; ') || null,
    };
  } finally {
    lock.release();
  }
}

export function describeManagedCertificates({
  dataDir = getDataDir(),
  configuredSslDir = null,
} = {}) {
  const loaded = loadManagedArtifactManifest({ dataDir });
  const configured = normalizedAbsolute(configuredSslDir);
  if (!loaded.ok) {
    return {
      ok: false,
      roots: [],
      refused: [],
      configuredSslDir: configured,
      unmanaged: configured ? [configured] : [],
      reason: loaded.reason,
      manifestPath: loaded.path,
    };
  }
  const roots = [];
  const refused = [];
  for (const entry of loaded.manifest.roots) {
    if (!existingLstat(entry.sslDir)) continue;
    try {
      roots.push(validatedManifestRoot(entry, dataDir));
    } catch (error) {
      refused.push({ path: entry.sslDir, reason: error.message });
    }
  }
  const declaredRoots = loaded.manifest.roots.map((entry) => entry.sslDir);
  return {
    ok: refused.length === 0,
    roots,
    refused,
    configuredSslDir: configured,
    unmanaged: configured && !declaredRoots.some((root) => samePath(root, configured))
      ? [configured]
      : [],
    reason: refused.length ? 'One or more managed-certificate roots failed verification.' : null,
    manifestPath: loaded.path,
  };
}

export function pathIsInside(parent, child) {
  return isInside(parent, child);
}
