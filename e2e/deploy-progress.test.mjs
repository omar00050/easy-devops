/**
 * Tests for core/hub/deployProgress.js — live deployment progress read from
 * the files the engine already writes.
 *
 * Run with:  npm run test:e2e -- deploy-progress
 *
 * No Hub, no PM2, no git and no subprocess: a fake socket collects the events,
 * and a real per-app lock, run record and log are written in the temporary
 * data directory. The poller itself is the real module.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed: Boolean(passed), detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  return null;
}

const ENV_SECRET = 'env-secret-value-4d8c2f';
const AUTH_TOKEN = 'deploy-token-91ba7e';

let store;
let db;
let hubLink;
let progress;

function appFor(id, env = {}, token = null) {
  const dir = path.join(TEST_DATA_DIR, 'apps', id);
  assertInsideTestDataDir(dir, `create the ${id} app folder`);
  return {
    id,
    dir,
    env,
    auth: token ? { type: 'token', token } : { type: 'none' },
  };
}

function makeRun(appId, runId, { status = 'running', step = 'build' } = {}) {
  return {
    id: runId,
    appId,
    trigger: 'manual',
    actor: null,
    ref: 'main',
    sha: null,
    releaseId: runId,
    status,
    step,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    warnings: [],
    rolledBackTo: null,
    reason: null,
    logTail: [],
    rollbackSucceeded: null,
  };
}

/** Writes the app, its run record and its lock, and returns the lock. */
function beginRun(app, run) {
  db.dbSet('deployApps', [app]);
  store.writeRun(run, TEST_DATA_DIR);
  const lock = store.acquireLock(app.id, { runId: run.id, dataDir: TEST_DATA_DIR });
  if (!lock.ok) throw new Error(`could not take the test lock: ${lock.reason}`);
  return lock;
}

async function testRedactionAndLifecycle() {
  setGroup('1. progress, redaction, deploy.logs, done and the app list');

  const app = appFor('demo-app', { DB_PASSWORD: ENV_SECRET }, AUTH_TOKEN);
  hubLink.saveHubPermissions({ 'deploy.logs': true });

  const runId = '20261118-120000-aaaaaa';
  const run = makeRun(app.id, runId, { step: 'build' });
  const lock = beginRun(app, run);

  const log = store.logFile(app.id, runId, TEST_DATA_DIR);
  fs.writeFileSync(log, [
    'start build',
    `DB_PASSWORD=${ENV_SECRET}`,
    `Authorization: Bearer ${AUTH_TOKEN}`,
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAkeybodyline',
    '-----END RSA PRIVATE KEY-----',
    'step one complete',
  ].join('\n') + '\n');

  const events = [];
  let appPushes = 0;
  progress.startDeployProgress({
    dataDir: TEST_DATA_DIR,
    emit: (event, payload) => events.push({ event, payload }),
    onAppsChanged: () => { appPushes += 1; },
  });

  try {
    const first = await waitFor(() => events[0]);
    check('a deploy:progress event is emitted', first?.event === 'deploy:progress', first?.event);
    check('it names the app, the run and the real status',
      first?.payload.appId === app.id && first?.payload.runId === runId && first?.payload.status === 'running',
      JSON.stringify({ appId: first?.payload.appId, runId: first?.payload.runId, status: first?.payload.status }));
    check('steps use the record\'s single `step` field',
      JSON.stringify(first?.payload.steps) === JSON.stringify([{ name: 'build', status: 'running' }]),
      JSON.stringify(first?.payload.steps));
    check('it is not done and carries an ISO time',
      first?.payload.done === false && !Number.isNaN(Date.parse(first?.payload.at ?? '')),
      String(first?.payload.at));

    const text = (first?.payload.lines ?? []).join('\n');
    check('the engine log lines arrive', text.includes('start build') && text.includes('step one complete'));
    check('an environment value arrives as ***', !text.includes(ENV_SECRET) && text.includes('***'));
    check('the deploy token never arrives', !text.includes(AUTH_TOKEN));
    check('private-key lines are dropped entirely',
      !(first?.payload.lines ?? []).some((line) => /PRIVATE KEY|keybodyline/.test(line)),
      text.slice(0, 120));
    check('a fresh deploy:apps is requested when the run starts', appPushes >= 1, `${appPushes}`);

    // The run ends, in this "other process" as far as the poller is concerned.
    fs.appendFileSync(log, 'final line\n');
    run.status = 'success';
    run.step = 'done';
    run.finishedAt = Date.now();
    store.writeRun(run, TEST_DATA_DIR);
    lock.release();

    const final = await waitFor(() => events.find((e) => e.payload.done === true));
    check('one final event says done', Boolean(final), final ? 'seen' : 'no done event');
    check('the final event has the finished status and step',
      final?.payload.status === 'success'
        && JSON.stringify(final?.payload.steps) === JSON.stringify([{ name: 'done', status: 'success' }]),
      JSON.stringify({ status: final?.payload.status, steps: final?.payload.steps }));
    check('the last log lines are included in the final event',
      (final?.payload.lines ?? []).includes('final line'));
    check('a fresh deploy:apps is requested when the run ends', appPushes >= 2, `${appPushes}`);

    const count = events.length;
    await sleep(1_500);
    check('polling stops after the final event', events.length === count, `${count} → ${events.length}`);
    check('only one done event is sent', events.filter((e) => e.payload.done).length === 1);
  } finally {
    progress.stopDeployProgress();
    lock.release();
  }
}

async function testLogsPermission() {
  setGroup('2. without deploy.logs only steps and status are sent');

  const app = appFor('quiet-app', { DB_PASSWORD: ENV_SECRET }, AUTH_TOKEN);
  hubLink.saveHubPermissions({ 'deploy.logs': false });

  const runId = '20261118-120001-bbbbbb';
  const run = makeRun(app.id, runId, { step: 'install' });
  const lock = beginRun(app, run);

  const log = store.logFile(app.id, runId, TEST_DATA_DIR);
  fs.writeFileSync(log, [
    `DB_PASSWORD=${ENV_SECRET}`,
    `Authorization: Bearer ${AUTH_TOKEN}`,
    'this line must not leave',
  ].join('\n') + '\n');

  const events = [];
  progress.startDeployProgress({
    dataDir: TEST_DATA_DIR,
    emit: (event, payload) => events.push({ event, payload }),
  });

  try {
    const first = await waitFor(() => events[0]);
    check('the event still carries status and steps',
      first?.payload.status === 'running'
        && JSON.stringify(first?.payload.steps) === JSON.stringify([{ name: 'install', status: 'running' }]),
      JSON.stringify(first?.payload));
    check('lines is an empty array', Array.isArray(first?.payload.lines) && first.payload.lines.length === 0,
      JSON.stringify(first?.payload.lines));
    const payloadText = JSON.stringify(first?.payload ?? {});
    check('no secret appears anywhere in the event',
      !payloadText.includes(ENV_SECRET) && !payloadText.includes(AUTH_TOKEN));
  } finally {
    progress.stopDeployProgress();
    lock.release();
  }
}

async function testBatchLimits() {
  setGroup('3. a large log is batched newest-first within the limits');

  const app = appFor('batch-app');
  hubLink.saveHubPermissions({ 'deploy.logs': true });

  const runId = '20261118-120002-cccccc';
  const run = makeRun(app.id, runId, { step: 'build' });
  const lock = beginRun(app, run);

  const many = [];
  for (let i = 0; i < 250; i++) many.push(`line-${String(i).padStart(3, '0')}`);
  const longLine = 'L'.repeat(5_000);
  many.push(longLine);

  const log = store.logFile(app.id, runId, TEST_DATA_DIR);
  fs.writeFileSync(log, `${many.join('\n')}\n`);

  const events = [];
  progress.startDeployProgress({
    dataDir: TEST_DATA_DIR,
    emit: (event, payload) => events.push({ event, payload }),
    onAppsChanged: () => {},
  });

  try {
    const first = await waitFor(() => events[0]);
    const lines = first?.payload.lines ?? [];
    check('at most 200 lines per event', lines.length === 200, `${lines.length}`);
    check('the count left out is reported as skipped', first?.payload.skipped === 51, `${first?.payload.skipped}`);
    check('the newest line is present, capped at 2000 characters',
      lines[lines.length - 1]?.length === 2_000 && /^L+$/.test(lines[lines.length - 1] ?? ''),
      `${lines[lines.length - 1]?.length}`);
    check('the oldest lines were dropped', !lines.includes('line-000') && !lines.includes('line-050'));
    check('the first kept line is the 51st from the end',
      lines[0] === 'line-051', lines[0]);
  } finally {
    progress.stopDeployProgress();
    lock.release();
  }
}

async function testPartialAndTruncatedLog() {
  setGroup('4. a partial line waits for its newline, and truncation restarts the read');

  const app = appFor('cursor-app');
  hubLink.saveHubPermissions({ 'deploy.logs': true });

  const runId = '20261118-120003-dddddd';
  const run = makeRun(app.id, runId, { step: 'build' });
  const lock = beginRun(app, run);

  const log = store.logFile(app.id, runId, TEST_DATA_DIR);
  fs.writeFileSync(log, 'one\ntwo-part'); // deliberately no trailing newline

  const events = [];
  progress.startDeployProgress({
    dataDir: TEST_DATA_DIR,
    emit: (event, payload) => events.push({ event, payload }),
    onAppsChanged: () => {},
  });

  try {
    const first = await waitFor(() => events[0]);
    check('a complete line is sent', (first?.payload.lines ?? []).includes('one'));
    check('the partial last line is held back',
      !(first?.payload.lines ?? []).some((line) => line.includes('two-part')),
      JSON.stringify(first?.payload.lines));

    fs.appendFileSync(log, 'ial\n');
    const second = await waitFor(() => events.find((e) => (e.payload.lines ?? []).includes('two-partial')));
    check('the line arrives once its newline does', Boolean(second));

    fs.writeFileSync(log, 'fresh\n'); // truncation: the old offset is now past EOF
    const third = await waitFor(() => events.find((e) => (e.payload.lines ?? []).includes('fresh')));
    check('a truncated log is read again from the start', Boolean(third));
  } finally {
    progress.stopDeployProgress();
    lock.release();
  }
}

async function main() {
  process.stdout.write('\nDeployment progress: files → agent → Hub\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  store = await import(srcUrl('core/deploy/store.js'));
  db = await import(srcUrl('core/db.js'));
  hubLink = await import(srcUrl('core/hubLink.js'));
  progress = await import(srcUrl('core/hub/deployProgress.js'));

  try {
    await testRedactionAndLifecycle();
    await testLogsPermission();
    await testBatchLimits();
    await testPartialAndTruncatedLog();
  } finally {
    progress.stopDeployProgress();
    try { db.closeDb(); } catch { /* already closed */ }
  }

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` — ${f.detail}` : ''}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
