import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = process.env.EZ_LOCK_DATA_DIR;
const key = process.env.EZ_LOCK_KEY;
const startFile = process.env.EZ_LOCK_START_FILE;
const resultDir = process.env.EZ_LOCK_RESULT_DIR;
const contender = process.env.EZ_LOCK_CONTENDER;

if (!dataDir || !key || !startFile || !resultDir || !contender) {
  throw new Error('artifact-lock contender is missing its test environment');
}

while (!fs.existsSync(startFile)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const moduleUrl = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/core/ssl/artifact-lock.js'),
).href;
const { acquireArtifactLock, ARTIFACT_LOCK_RECOVERY_GUARD_STALE_MS } = await import(moduleUrl);

/**
 * The lock's own documented numbers, not a guess at machine speed.
 *
 * One abandoned recovery guard is the longest a waiter can be held up by a
 * marker it did not create (`ARTIFACT_LOCK_RECOVERY_GUARD_STALE_MS`); the extra
 * ten seconds is room for ten contenders to take the lock one after another.
 * A hardcoded budget smaller than the guard timeout turns a slow-but-correct
 * recovery into a red suite, which is how this race was first reported.
 */
const timeoutMs = ARTIFACT_LOCK_RECOVERY_GUARD_STALE_MS + 10_000;

const activeFile = path.join(resultDir, 'active');
const resultFile = path.join(resultDir, `result-${contender}.json`);
const startedAt = Date.now();
let lock;
let overlap = false;
let released = null;

try {
  lock = await acquireArtifactLock({ dataDir, key, timeoutMs });
  try {
    fs.writeFileSync(activeFile, contender, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    overlap = true;
  }

  await new Promise((resolve) => setTimeout(resolve, 75));
  if (!overlap) fs.unlinkSync(activeFile);
} finally {
  released = lock ? lock.release() : null;
}

fs.writeFileSync(resultFile, `${JSON.stringify({
  contender,
  overlap,
  released,
  timeoutMs,
  startedAt,
  finishedAt: Date.now(),
})}\n`);
