import './lib/guard.mjs';
import { TEST_DATA_DIR } from './lib/guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const { applyGrants, revokeGrants } = await import('../src/core/service/acl.js');
const dir = path.join(TEST_DATA_DIR, 'approved space');
const other = path.join(TEST_DATA_DIR, 'other');
const link = path.join(TEST_DATA_DIR, 'alias');
fs.mkdirSync(dir); fs.mkdirSync(other); fs.symlinkSync(dir, link, 'junction');
const calls = [];
const runFile = async (exe, args) => {
  if (path.win32.basename(exe) === 'icacls.exe') calls.push(args);
  return { success: true, stdout: '', stderr: '' };
};
for (const target of [other, link, path.parse(dir).root, path.join(dir, 'missing'), dir]) {
  const approvedDirs = target === other ? [dir] : [target];
  const grant = await applyGrants({ grants: [{ path: target }], approvedDirs, runFile });
  const revoke = await revokeGrants({ paths: [target], approvedDirs, runFile });
  assert.equal(grant.ok, target === dir);
  assert.equal(revoke.ok, target === dir);
}
assert.deepEqual(calls.map(args => args.slice(0, 2)), [[dir, '/grant'], [dir, '/remove:g']]);
console.log('PASS  only existing approved canonical directories reach native grant and revoke');
