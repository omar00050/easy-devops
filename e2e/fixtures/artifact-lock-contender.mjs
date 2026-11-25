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
const { acquireArtifactLock } = await import(moduleUrl);

const activeFile = path.join(resultDir, 'active');
const resultFile = path.join(resultDir, `result-${contender}.json`);
const startedAt = Date.now();
let lock;
let overlap = false;

try {
  lock = await acquireArtifactLock({ dataDir, key, timeoutMs: 15_000 });
  try {
    fs.writeFileSync(activeFile, contender, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    overlap = true;
  }

  await new Promise((resolve) => setTimeout(resolve, 75));
  if (!overlap) fs.unlinkSync(activeFile);
} finally {
  lock?.release();
}

fs.writeFileSync(resultFile, `${JSON.stringify({
  contender,
  overlap,
  startedAt,
  finishedAt: Date.now(),
})}\n`);
