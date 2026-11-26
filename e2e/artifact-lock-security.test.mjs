/**
 * Cross-process stale-lock recovery.
 *
 * There is no demand check in this suite. Several real Node processes race to
 * recover one stale owner while a separate exclusive file records any overlap.
 */

import './lib/guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';
import { fileURLToPath } from 'node:url';

const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/artifact-lock-contender.mjs');
const root = path.join(TEST_DATA_DIR, 'artifact-lock-race');
assertInsideTestDataDir(root, 'create the artifact-lock race fixture');
fs.mkdirSync(root, { recursive: true });
const dataDir = path.join(root, 'data');
const resultDir = path.join(root, 'results');
const startFile = path.join(root, 'start');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(resultDir, { recursive: true });

const key = 'race';
const lockPath = path.join(dataDir, '.race.lock');
const recoveryPath = `${lockPath}.recovery`;
const old = new Date(Date.now() - 10 * 60_000);
const staleOwner = {
  version: 1,
  key,
  token: 'crashed-owner',
  pid: 0x7ffffffe,
  host: os.hostname(),
  startedAt: old.getTime(),
};
fs.writeFileSync(lockPath, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });
fs.writeFileSync(recoveryPath, `${JSON.stringify({ ...staleOwner, token: 'crashed-recovery' })}\n`, { mode: 0o600 });
fs.utimesSync(lockPath, old, old);
fs.utimesSync(recoveryPath, old, old);

function runContender(index) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper], {
      env: {
        ...process.env,
        EZ_LOCK_DATA_DIR: dataDir,
        EZ_LOCK_KEY: key,
        EZ_LOCK_START_FILE: startFile,
        EZ_LOCK_RESULT_DIR: resultDir,
        EZ_LOCK_CONTENDER: String(index),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`contender ${index} exited ${code}: ${stdout}${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

const contenders = Array.from({ length: 10 }, (_, index) => runContender(index));
await new Promise((resolve) => setTimeout(resolve, 150));
fs.writeFileSync(startFile, 'go\n');
await Promise.all(contenders);

const results = fs.readdirSync(resultDir)
  .filter((name) => /^result-\d+\.json$/.test(name))
  .map((name) => JSON.parse(fs.readFileSync(path.join(resultDir, name), 'utf8')));

assert.equal(results.length, 10);
assert.equal(results.some((entry) => entry.overlap), false);
const unreleased = results.filter((entry) => entry.released !== true);
assert.equal(
  unreleased.length,
  0,
  `contenders that held the lock but could not release their own record: `
  + `${unreleased.map((entry) => entry.contender).join(', ') || 'none'}`,
);
assert.equal(fs.existsSync(path.join(resultDir, 'active')), false);
assert.equal(fs.existsSync(lockPath), false);
assert.equal(fs.existsSync(recoveryPath), false);
// Not just the recovery marker: no claim, candidate or released copy survives.
const leftovers = fs.readdirSync(dataDir);
assert.deepEqual(leftovers, [], `lock files left behind in ${dataDir}: ${leftovers.join(', ')}`);

process.stdout.write('PASS  stale lock recovery remains exclusive across independent processes\n');
