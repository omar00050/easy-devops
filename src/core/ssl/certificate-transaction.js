/**
 * Durable key/certificate publication.
 *
 * Two atomic file replacements cannot be one filesystem transaction. A private
 * per-domain lock prevents concurrent issuance, while a small journal lets the
 * next operation restore the previous pair after a process crash between the
 * key and certificate renames.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../platform.js';
import { validateDomainName } from '../validators.js';
import { acquireArtifactLock } from './artifact-lock.js';
import { renameWithRetry, retrySharing } from '../atomicState.js';

const JOURNAL_VERSION = 1;
const JOURNAL_MAX_BYTES = 64 * 1024;
const FILE_NAMES = new Set(['privkey.pem', 'fullchain.pem', 'ez-cert.json']);

function lstatIfPresent(target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readRegularFile(target) {
  let handle;
  try {
    handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Refusing a linked or non-regular certificate file: ${target}`);
    }
    return { data: fs.readFileSync(handle), stat };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function writeExclusive(target, data) {
  const handle = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, data);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
}

function atomicJsonWrite(target, value) {
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
    // The next operation reads this journal to recover an interrupted
    // publication, so it must never observe half a document: the rename retries
    // a momentary sharing denial through the shared helper.
    renameWithRetry(temporary, target);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function readJournal(target) {
  const stat = lstatIfPresent(target);
  if (!stat) return null;
  let handle;
  try {
    handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(handle);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > JOURNAL_MAX_BYTES) {
      throw new Error(`Unsafe certificate transaction journal: ${target}`);
    }
    if (process.platform !== 'win32') {
      if ((opened.mode & 0o077) !== 0) {
        throw new Error(`Certificate transaction journal permissions are not 0600: ${target}`);
      }
      if (typeof process.getuid === 'function' && opened.uid !== process.getuid()) {
        throw new Error(`Certificate transaction journal is owned by another user: ${target}`);
      }
    }
    const value = JSON.parse(fs.readFileSync(handle, 'utf8'));
    validateJournal(value, target);
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function validateJournal(value, target) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== JOURNAL_VERSION
    || typeof value.domain !== 'string'
    || validateDomainName(value.domain) !== null
    || typeof value.certDir !== 'string'
    || !path.isAbsolute(value.certDir)
    || !Array.isArray(value.files)
    || value.files.length < 2
    || value.files.length > FILE_NAMES.size
    || !['prepared', 'committed'].includes(value.phase)) {
    throw new Error(`Invalid certificate transaction journal: ${target}`);
  }
  const names = new Set();
  for (const entry of value.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !FILE_NAMES.has(entry.name)
      || names.has(entry.name)
      || typeof entry.staged !== 'string'
      || typeof entry.backup !== 'string'
      || typeof entry.original !== 'boolean'
      || (entry.original
        && (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)))) {
      throw new Error(`Invalid certificate transaction entry in ${target}`);
    }
    names.add(entry.name);
    const certDir = path.resolve(value.certDir);
    for (const candidate of [entry.staged, entry.backup]) {
      const relative = path.relative(certDir, path.resolve(candidate));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Certificate transaction path escapes ${certDir}: ${candidate}`);
      }
    }
  }
}

function syncDirectory(directory) {
  let handle;
  try {
    handle = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(handle);
  } catch {
    /* Directory fsync is unavailable on some Windows filesystems. */
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* already closed */ }
    }
  }
}

/**
 * The certificate pair keeps its own, longer schedule than a state file: 50
 * waits of 10 ms (about half a second), because a key and a chain are re-read
 * by nginx and by the Hub's certificate reader while they are being replaced.
 * It still runs through the shared retry, so the codes it rides out and its
 * "give up and rethrow the same error" behaviour cannot drift from every other
 * writer in the package.
 */
const CERTIFICATE_RENAME_DELAYS_MS = Object.freeze(Array.from({ length: 50 }, () => 10));

function renameCertificateFile(from, to) {
  retrySharing(() => fs.renameSync(from, to), { delays: CERTIFICATE_RENAME_DELAYS_MS });
}

function safeCleanupFile(target, certDir) {
  const relative = path.relative(path.resolve(certDir), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
  const stat = lstatIfPresent(target);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Refusing to clean up a linked or non-regular transaction file: ${target}`);
  }
  fs.unlinkSync(target);
}

function restoreOriginal(entry, certDir) {
  const target = path.join(certDir, entry.name);
  if (!entry.original) {
    const stat = lstatIfPresent(target);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Refusing to roll back over a linked or non-regular file: ${target}`);
    }
    fs.unlinkSync(target);
    return;
  }

  const backup = readRegularFile(entry.backup);
  if (sha256(backup.data) !== entry.sha256) {
    throw new Error(`The certificate rollback backup changed: ${entry.backup}`);
  }
  const temporary = path.join(certDir, `.${entry.name}.${crypto.randomUUID()}.rollback`);
  try {
    writeExclusive(temporary, backup.data);
    renameCertificateFile(temporary, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function recoverJournal(journalPath, certDir) {
  const journal = readJournal(journalPath);
  if (!journal) return false;
  if (path.resolve(journal.certDir) !== path.resolve(certDir)) {
    throw new Error(`Certificate transaction journal points at another directory: ${journalPath}`);
  }

  if (journal.phase === 'prepared') {
    for (const entry of [...journal.files].reverse()) restoreOriginal(entry, certDir);
  }
  for (const entry of journal.files) {
    safeCleanupFile(entry.staged, certDir);
    safeCleanupFile(entry.backup, certDir);
  }
  fs.unlinkSync(journalPath);
  syncDirectory(certDir);
  syncDirectory(path.dirname(journalPath));
  return true;
}

function journalFor(domain, certDir, files, payloads) {
  const nonce = crypto.randomUUID();
  return {
    version: JOURNAL_VERSION,
    domain,
    certDir,
    phase: 'prepared',
    files: files.map((name) => {
      const target = path.join(certDir, name);
      const stat = lstatIfPresent(target);
      if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)) {
        throw new Error(`Refusing a linked or non-regular certificate file: ${target}`);
      }
      const original = stat ? readRegularFile(target) : null;
      return {
        name,
        staged: path.join(certDir, `.${name}.${nonce}.next`),
        backup: path.join(certDir, `.${name}.${nonce}.bak`),
        original: Boolean(original),
        sha256: original ? sha256(original.data) : null,
        expectedSha256: sha256(payloads[name]),
      };
    }),
  };
}

export function certificateJournalPath(dataDir, domain) {
  const digest = crypto.createHash('sha256').update(domain).digest('hex').slice(0, 24);
  return path.join(dataDir, `.ssl-certificate-${digest}.journal.json`);
}

/** Recover a prior interrupted publication before renewal or repair. */
export async function recoverCertificateFiles({
  dataDir = getDataDir(),
  sslDir,
  domain,
} = {}) {
  if (typeof domain !== 'string' || validateDomainName(domain) !== null) {
    throw new Error('A valid domain is required to recover a certificate transaction.');
  }
  const certDir = path.join(sslDir, domain);
  const lock = await acquireArtifactLock({
    dataDir,
    key: `ssl-certificate-${domain}`,
    timeoutMs: 5 * 60_000,
  });
  try {
    return recoverJournal(certificateJournalPath(dataDir, domain), certDir);
  } finally {
    lock.release();
  }
}

/**
 * Publish all certificate files as one recoverable operation.
 *
 * `onPublished` runs after all renames and before the journal is marked
 * committed. In issuance this records the manifest identities, so a manifest
 * failure rolls the files back.
 */
export async function publishCertificateFiles({
  dataDir = getDataDir(),
  sslDir,
  domain,
  files,
  onPublished = async () => {},
  deps = {},
} = {}) {
  if (typeof domain !== 'string' || validateDomainName(domain) !== null) {
    throw new Error('A valid domain is required for certificate publication.');
  }
  if (!path.isAbsolute(String(sslDir ?? ''))) {
    throw new Error('Certificate publication requires an absolute SSL directory.');
  }
  const certDir = path.join(sslDir, domain);
  if (path.relative(path.resolve(sslDir), path.resolve(certDir)) !== domain) {
    throw new Error('The certificate directory escapes the SSL directory.');
  }
  const certDirStat = lstatIfPresent(certDir);
  if (!certDirStat?.isDirectory() || certDirStat.isSymbolicLink()) {
    throw new Error(`The certificate directory is missing, linked or not a directory: ${certDir}`);
  }

  const names = Object.keys(files);
  if (!names.includes('privkey.pem') || !names.includes('fullchain.pem')
    || names.some((name) => !FILE_NAMES.has(name))) {
    throw new Error('Certificate publication requires a private key and a certificate chain.');
  }
  for (const [name, data] of Object.entries(files)) {
    if (!Buffer.isBuffer(data) && typeof data !== 'string') {
      throw new Error(`Certificate file ${name} has no textual or binary data.`);
    }
  }

  let certificate;
  let privateKey;
  try {
    certificate = new crypto.X509Certificate(files['fullchain.pem']);
    privateKey = crypto.createPrivateKey(files['privkey.pem']);
    if (!certificate.checkPrivateKey(privateKey)) {
      throw new Error('The private key does not match the certificate.');
    }
  } catch (error) {
    throw new Error(`Refusing an invalid certificate/key pair: ${error.message}`);
  }

  const lock = await acquireArtifactLock({
    dataDir,
    key: `ssl-certificate-${domain}`,
    timeoutMs: 5 * 60_000,
  });
  const journalPath = certificateJournalPath(dataDir, domain);
  try {
    recoverJournal(journalPath, certDir);
    const payloads = Object.fromEntries(names.map((name) => [
      name,
      Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name], 'utf8'),
    ]));
    const journal = journalFor(domain, certDir, names, payloads);
    let journalDurable = false;

    try {
      for (const entry of journal.files) {
        if (entry.original) {
          const original = readRegularFile(path.join(certDir, entry.name));
          if (!original || sha256(original.data) !== entry.sha256) {
            throw new Error(`Certificate file changed while preparing: ${entry.name}`);
          }
          writeExclusive(entry.backup, original.data);
        }
        writeExclusive(entry.staged, payloads[entry.name]);
      }
      atomicJsonWrite(journalPath, journal);
      journalDurable = true;

      for (const [index, entry] of journal.files.entries()) {
        if (!lock.isOwner()) throw new Error('The certificate publication lock was lost.');
        const source = entry.staged;
        const target = path.join(certDir, entry.name);
        const moved = deps.renameSync ? deps.renameSync(source, target, entry.name, index) : null;
        if (moved === false) throw new Error(`Certificate rename was refused for ${entry.name}`);
        if (!deps.renameSync) renameCertificateFile(source, target);
        if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
      }
      syncDirectory(certDir);

      await onPublished();
      if (!lock.isOwner()) throw new Error('The certificate publication lock was lost.');
      journal.phase = 'committed';
      atomicJsonWrite(journalPath, journal);
      for (const entry of journal.files) {
        safeCleanupFile(entry.staged, certDir);
        safeCleanupFile(entry.backup, certDir);
      }
      fs.unlinkSync(journalPath);
      syncDirectory(certDir);
      syncDirectory(dataDir);
      return {
        certPath: path.join(certDir, 'fullchain.pem'),
        keyPath: path.join(certDir, 'privkey.pem'),
      };
    } catch (error) {
      if (!journalDurable) {
        for (const entry of journal.files) {
          for (const target of [entry.staged, entry.backup]) {
            try { safeCleanupFile(target, certDir); } catch { /* incomplete staging */ }
          }
        }
        throw error;
      }
      try {
        for (const entry of [...journal.files].reverse()) restoreOriginal(entry, certDir);
        for (const entry of journal.files) {
          safeCleanupFile(entry.staged, certDir);
          safeCleanupFile(entry.backup, certDir);
        }
        fs.unlinkSync(journalPath);
      } catch (rollbackError) {
        throw new Error(
          `${error.message}. Automatic rollback failed: ${rollbackError.message}. `
          + `The durable journal remains at ${journalPath}.`,
        );
      }
      throw error;
    }
  } finally {
    lock.release();
  }
}
