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
assert(calls[1].includes('/T'));
assert(calls[1].includes('/L'));
assert(calls[1].includes('/Q'));

// A reparse point is found by the preflight before icacls can run recursively.
const safeTree = path.join(TEST_DATA_DIR, 'safe-tree');
const outside = path.join(TEST_DATA_DIR, 'outside-tree');
fs.mkdirSync(path.join(safeTree, 'nested'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
fs.symlinkSync(outside, path.join(safeTree, 'nested', 'escape'), 'junction');
const beforeLink = calls.length;
const linkedRevoke = await revokeGrants({
  paths: [safeTree],
  approvedDirs: [safeTree],
  runFile,
});
assert.equal(linkedRevoke.ok, false);
assert.match(linkedRevoke.failed[0]?.reason ?? '', /link|reparse/i);
assert.equal(calls.length, beforeLink, 'no recursive icacls may run after the link preflight fails');

// A hard link can make an ACL change reach outside the approved root.
const hardTree = path.join(TEST_DATA_DIR, 'hard-tree');
const hardOutside = path.join(TEST_DATA_DIR, 'hard-outside.txt');
fs.mkdirSync(hardTree);
fs.writeFileSync(hardOutside, 'outside');
fs.linkSync(hardOutside, path.join(hardTree, 'linked-file'));
const beforeHardLink = calls.length;
const hardRevoke = await revokeGrants({
  paths: [hardTree],
  approvedDirs: [hardTree],
  runFile,
});
assert.equal(hardRevoke.ok, false);
assert.match(hardRevoke.failed[0]?.reason ?? '', /hard-linked/i);
assert.equal(calls.length, beforeHardLink, 'no recursive icacls may run after a hard-link preflight fails');

// Cancellation reaches traversal before any native permission change.
const cancelTree = path.join(TEST_DATA_DIR, 'cancel-tree');
fs.mkdirSync(cancelTree);
fs.writeFileSync(path.join(cancelTree, 'data'), 'x');
const beforeCancel = calls.length;
const controller = new AbortController();
controller.abort(new Error('cancel test'));
await assert.rejects(
  revokeGrants({
    paths: [cancelTree],
    approvedDirs: [cancelTree],
    runFile,
    signal: controller.signal,
  }),
  /cancel test/,
);
assert.equal(calls.length, beforeCancel);

let deadlineError;
try {
  await revokeGrants({
    paths: [cancelTree],
    approvedDirs: [cancelTree],
    runFile,
    deadline: Date.now() - 1,
    timeoutMs: 30,
  });
} catch (error) {
  deadlineError = error;
}
assert.equal(deadlineError?.code, 'EZ_STAGE_TIMEOUT');
assert.equal(deadlineError?.stage, 'Removing service-account permissions');
assert.equal(calls.length, beforeCancel);

console.log('PASS  ACL revoke is direct, bounded, abortable, and preflighted against links');
