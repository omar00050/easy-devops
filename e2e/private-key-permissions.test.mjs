import './lib/guard.mjs';
import { TEST_DATA_DIR } from './lib/guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const { loadAccountKey, replaceCertificateFile, repairPrivateKeys, protectKeyDirectory } = await import('../src/core/ssl/private-keys.js');
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
console.log('PASS  exclusive account key creation, atomic renewal, private permissions and repair');
