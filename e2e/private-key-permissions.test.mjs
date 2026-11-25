import './lib/guard.mjs';
import { TEST_DATA_DIR } from './lib/guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const { loadAccountKey, replaceCertificateFile, repairPrivateKeys, protectKeyDirectory } = await import('../src/core/ssl/private-keys.js');
const previousUmask = process.platform === 'win32' ? null : process.umask(0o022);
const sslDir = path.join(TEST_DATA_DIR, 'certs');
const key = await protectKeyDirectory(sslDir, 'example.test');
await replaceCertificateFile(key, 'old');
const previous = await fs.stat(key, { bigint: true });
await replaceCertificateFile(key, 'new');
assert.notEqual((await fs.stat(key, { bigint: true })).ino, previous.ino);
assert.equal(await fs.readFile(key, 'utf8'), 'new');
const create = () => loadAccountKey(sslDir, async () => Buffer.from(String(Math.random())));
const accounts = await Promise.all([create(), create()]);
assert.deepEqual(accounts[0], accounts[1]);
const account = path.join(sslDir, '.account/account.key');
if (process.platform !== 'win32') {
  for (const file of [key, account]) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    await fs.chmod(file, 0o644);
    await fs.chmod(path.dirname(file), 0o755);
  }
  await fs.chmod(key, 0o644);
  await replaceCertificateFile(key, 'renewed-under-umask-022');
  assert.equal((await fs.stat(key)).mode & 0o777, 0o600);
}
await repairPrivateKeys(sslDir);
for (const file of [key, account]) {
  if (process.platform === 'win32') {
    const { runFile } = await import('../src/core/shell.js');
    const result = await runFile(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'), [file]);
    assert.equal(result.success, true);
    assert.doesNotMatch(result.stdout, /BUILTIN\\Users:|Everyone:|Authenticated Users:/i);
  } else {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
}
assert.deepEqual(await fs.readdir(path.dirname(key)), ['privkey.pem']);

// Repair must refuse links before changing anything. Directory junctions cover
// Windows reparse points; symbolic links cover the POSIX path.
const linkTarget = path.join(TEST_DATA_DIR, 'private-key-link-target');
const linkedDir = path.join(sslDir, 'linked.example.test');
await fs.mkdir(linkTarget, { recursive: true });
let directoryLinkCreated = false;
try {
  await fs.symlink(linkTarget, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  directoryLinkCreated = true;
} catch (error) {
  if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error?.code)) throw error;
}
if (directoryLinkCreated) {
  try {
    await assert.rejects(
      () => repairPrivateKeys(sslDir),
      /link|junction|symbolic links/i,
      'repair accepted a linked private-key directory',
    );
  } finally {
    if (process.platform === 'win32') await fs.rmdir(linkedDir);
    else await fs.unlink(linkedDir);
  }
}

// A hard link is a deterministic non-reparse alias and must also fail closed.
const hardLinkedDir = await protectKeyDirectory(sslDir, 'hardlinked.example.test');
const hardLinkTarget = path.join(TEST_DATA_DIR, 'private-key-hardlink-target');
await fs.writeFile(hardLinkTarget, 'must never be treated as a private key');
await fs.link(hardLinkTarget, hardLinkedDir);
await assert.rejects(
  () => repairPrivateKeys(sslDir),
  /linked|non-regular|one link/i,
  'repair accepted a hard-linked private key',
);
await fs.unlink(hardLinkedDir);
await fs.unlink(hardLinkTarget);
await fs.rmdir(path.dirname(hardLinkedDir));
await fs.rmdir(linkTarget);

// The service-facing repair path must invoke the same key repair and surface
// its failure. Stub only the platform service mechanism, keeping the real ACL
// and permission implementation under test.
const configModule = await import('../src/core/config.js');
const service = await import('../src/core/service/index.js');
const db = await import('../src/core/db.js');
const savedConfig = configModule.loadConfig();
const savedServiceState = db.dbGet('service-state');
configModule.saveConfig({ ...savedConfig, sslDir });
db.dbSet('service-state', { ...(savedServiceState ?? {}), mode: 'personal' });

if (process.platform !== 'win32') {
  for (const file of [key, account]) {
    await fs.chmod(file, 0o644);
    await fs.chmod(path.dirname(file), 0o755);
  }
}

let repairedDirectory = null;
const repairResult = await service.repair({
  deps: {
    systemd: { repair: async () => ({ ok: true }) },
    windowsPersonal: {
      repair: () => ({ ok: true, nodeExe: process.execPath }),
    },
    windowsService: {
      repair: async () => ({ ok: true, granted: [], operator: null }),
    },
    resolveOperator: async () => ({}),
    repairPrivateKeys: async (directory, options) => {
      repairedDirectory = directory;
      return repairPrivateKeys(directory, options);
    },
  },
});
assert.equal(repairResult.ok, true, repairResult.reason);
assert.equal(repairedDirectory, sslDir);
if (process.platform !== 'win32') {
  for (const file of [key, account]) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
}

const failedRepair = await service.repair({
  deps: {
    systemd: { repair: async () => ({ ok: true }) },
    windowsPersonal: {
      repair: () => ({ ok: true, nodeExe: process.execPath }),
    },
    windowsService: {
      repair: async () => ({ ok: true, granted: [], operator: null }),
    },
    resolveOperator: async () => ({}),
    repairPrivateKeys: async () => {
      throw new Error('controlled key recovery failure');
    },
  },
});
assert.equal(failedRepair.ok, false);
assert.match(failedRepair.reason, /Certificate key permission repair failed: controlled key recovery failure/);

configModule.saveConfig(savedConfig);
if (savedServiceState === undefined) db.dbDelete('service-state');
else db.dbSet('service-state', savedServiceState);

assert.deepEqual(await fs.readdir(sslDir).then((entries) => entries.sort()),
  ['.account', 'example.test']);
if (previousUmask !== null) process.umask(previousUmask);
console.log('PASS  restrictive permissions, atomic replacement, key repair and link refusal');
