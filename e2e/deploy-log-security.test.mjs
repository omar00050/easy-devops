/**
 * EZ-09 and the deployment-log side of EZ-16.
 *
 * The writer is the security boundary. This suite feeds it secrets split over
 * chunks, rotates the app settings, then reads the same files through every
 * consumer that exists: the dashboard route, the Hub command path and the live
 * deploy progress feed.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;
const scratch = (name) => path.join(TEST_DATA_DIR, 'scratch', name);

const results = [];
let group = '';
function setGroup(name) {
  group = name;
  process.stdout.write(`\n-- ${group}\n`);
}
function check(label, passed, detail = '') {
  results.push({ group, label, passed: Boolean(passed), detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 6_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(80);
  }
  return null;
}

const ENV_OLD = 'EZ09_ENV_SECRET_old_6d3c1f';
const TOKEN_OLD = 'ghp_EZ09TOKENold9182';
const ENV_NEW = 'EZ09_ENV_SECRET_new_8f4d';
const TOKEN_NEW = 'ghp_EZ09TOKENnew8241';
const PEM_BODY = 'MIIEthisBodyMustNeverReachDisk';

let logSecurity;
let engine;
let store;
let apps;
let db;
let hubLink;
let hubCommands;
let progress;
let DeploymentsController;

function callDashboardRun(controller, appId, runId) {
  let answer = null;
  let status = 200;
  const res = {
    status(code) { status = code; return this; },
    json(body) { answer = body; return this; },
  };
  let nextError = null;
  controller.run({ params: { id: appId, runId } }, res, (err) => { nextError = err; });
  return { answer, status, nextError };
}

async function main() {
  process.stdout.write('\nDeployment log security\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  logSecurity = await import(srcUrl('core/deploy/logSecurity.js'));
  engine = await import(srcUrl('core/deploy/engine.js'));
  store = await import(srcUrl('core/deploy/store.js'));
  apps = await import(srcUrl('core/deploy/apps.js'));
  db = await import(srcUrl('core/db.js'));
  hubLink = await import(srcUrl('core/hubLink.js'));
  hubCommands = await import(srcUrl('core/deploy/hubCommands.js'));
  progress = await import(srcUrl('core/hub/deployProgress.js'));
  ({ default: DeploymentsController } = await import(srcUrl('dashboard/controllers/deploymentsController.js')));

  setGroup('1. streaming redaction survives every chunk boundary');
  {
    const secret = 'split-boundary-secret-49f2c';
    const privateKey = [
      'before key',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAA',
      '-----END OPENSSH PRIVATE KEY-----',
      'after key',
    ].join('\n');
    const ret = logSecurity.createDeployLogRedactor([secret]);
    const exact = [
      ret.write(`left:${secret.slice(0, 7)}`),
      ret.write(`${secret.slice(7, 18)}`),
      ret.write(`${secret.slice(18)}:right\n`),
    ].join('') + ret.flush();

    check('an exact secret split into three writes is fully redacted',
      exact.includes('left:***:right') && !exact.includes(secret), exact);
    check('flush releases the stream tail exactly once',
      exact.split('left:').length - 1 === 1 && exact.split(':right').length - 1 === 1,
      exact);

    let everyExactBoundary = true;
    for (let split = 1; split < secret.length; split += 1) {
      const each = logSecurity.createDeployLogRedactor([secret]);
      const output = each.write(`a${secret.slice(0, split)}`)
        + each.write(`${secret.slice(split)}z`)
        + each.flush();
      if (output.includes(secret) || !output.includes('a***z')) everyExactBoundary = false;
    }
    check('an exact secret is redacted at every two-chunk boundary', everyExactBoundary);

    const pem = logSecurity.createDeployLogRedactor([]);
    let kept = '';
    for (const piece of [
      privateKey.slice(0, 12),
      privateKey.slice(12, privateKey.indexOf('-----END')),
      privateKey.slice(privateKey.indexOf('-----END')),
    ]) kept += pem.write(piece);
    kept += pem.flush();
    check('a PEM block crossing chunks is removed with its body',
      kept.includes('before key') && kept.includes('after key')
        && !/PRIVATE KEY|b3BlbnNzaC1rZXktdjEAAAAA/.test(kept), kept);

    let everyPemBoundary = true;
    for (let split = 1; split < privateKey.length; split += 1) {
      const each = logSecurity.createDeployLogRedactor([]);
      const output = each.write(privateKey.slice(0, split))
        + each.write(privateKey.slice(split))
        + each.flush();
      if (!output.includes('before key') || !output.includes('after key')
        || /PRIVATE KEY|b3BlbnNzaC1rZXktdjEAAAAA/.test(output)) everyPemBoundary = false;
    }
    check('a PEM block is removed when split at every byte boundary', everyPemBoundary);

    const unclosed = logSecurity.createDeployLogRedactor([]);
    const unclosedOutput = unclosed.write('before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEneverEnds')
      + unclosed.flush();
    check('an unclosed private-key block fails closed', unclosedOutput === 'before\n', unclosedOutput);

    const genericBegin = `${'ordinary before '.repeat(40)}-----BEGIN NOT SENSITIVE MATERIAL ${'ordinary after '.repeat(40)}`;
    check('long generic BEGIN text is not mistaken for a private key',
      logSecurity.sanitizeDeployText(genericBegin) === genericBegin);
  }

  setGroup('2. the writer persists only redacted bytes');

  const created = apps.createApp({
    id: 'log-security-app',
    repoUrl: 'https://github.com/example/log-security.git',
    branch: 'main',
    authType: 'token',
    token: TOKEN_OLD,
    env: { DATABASE_URL: ENV_OLD },
  });
  if (!created.ok) throw new Error(created.errors.join(', '));

  const runId = '20261124-140000-abcdef';
  const run = {
    id: runId,
    appId: created.app.id,
    trigger: 'manual',
    actor: 'test',
    ref: 'main',
    sha: null,
    releaseId: runId,
    status: 'running',
    step: 'build',
    stage: 'build',
    skippedStages: [],
    startedAt: 1_800_000_000_000,
    finishedAt: null,
    error: null,
    warnings: [],
    rolledBackTo: null,
    reason: null,
    logTail: [],
    rollbackSucceeded: null,
    logSecurity: logSecurity.LOG_SECURITY_REDACTED_V1,
  };
  store.writeRun(run, TEST_DATA_DIR);
  const lock = store.acquireLock(created.app.id, { runId, dataDir: TEST_DATA_DIR });
  if (!lock.ok) throw new Error(lock.reason);

  try {
    const snapshot = logSecurity.snapshotDeploySecrets(created.app);
    const writer = engine.makeLogger(created.app.id, runId, snapshot);
    writer.line('build started');
    writer.output(`env=${ENV_OLD.slice(0, 8)}`);
    writer.output(`${ENV_OLD.slice(8)} token=${TOKEN_OLD.slice(0, 6)}`);
    writer.output(`${TOKEN_OLD.slice(6)}:right\n`);
    writer.output('key begins\n-----BEGIN RSA PRI');
    writer.output(`VATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----\n`);
    writer.output('build complete\n');
    writer.flush();

    const stored = fs.readFileSync(store.logFile(created.app.id, runId, TEST_DATA_DIR), 'utf8');
    check('the run record marks the new safe log format',
      store.readRun(created.app.id, runId, TEST_DATA_DIR)?.logSecurity === 'redacted-v1');
    check('the persisted file contains neither environment secret nor token',
      !stored.includes(ENV_OLD) && !stored.includes(TOKEN_OLD) && stored.includes('***'), stored.slice(0, 300));
    check('the persisted file contains no PEM marker or body',
      !/PRIVATE KEY|MIIEthisBodyMustNeverReachDisk/.test(stored));
    check('ordinary build lines remain useful',
      stored.includes('build started') && stored.includes('build complete'));

    check('a diagnostic string with a split secret is sanitized',
      !logSecurity.sanitizeDeployText(`warning ${ENV_OLD}`, snapshot).includes(ENV_OLD));

    // Rotate both credentials after the bytes were persisted. A reader that
    // used today's app values would now leak the old pair.
    const updated = apps.updateApp(created.app.id, {
      authType: 'token',
      token: TOKEN_NEW,
      env: { DATABASE_URL: ENV_NEW },
    });
    check('test credentials were rotated before reading history', updated.ok === true);

    study: {
      const permissions = hubLink.saveHubPermissions({ 'deploy.logs': true });
      check('the Hub log permission used by live progress is enabled',
        permissions['deploy.logs'] === true, JSON.stringify(permissions));
      const viaHub = await hubCommands.handleHubDeployCommand(
        { action: 'run', id: created.app.id, runId },
        { permissions: { 'deploy.logs': true } },
      );
      check('the Hub history returns the redacted stored log after rotation',
        !viaHub.log.includes(ENV_OLD) && !viaHub.log.includes(TOKEN_OLD)
          && viaHub.log.includes('build complete') && viaHub.logUnavailable === undefined,
        viaHub.log.slice(0, 300));

      const viaDashboard = callDashboardRun(new DeploymentsController(), created.app.id, runId);
      check('the dashboard run response returns no rotated secret',
        viaDashboard.status === 200
          && !viaDashboard.answer.log.includes(ENV_OLD)
          && !viaDashboard.answer.log.includes(TOKEN_OLD)
          && viaDashboard.answer.logUnavailable === undefined,
        viaDashboard.nextError?.message ?? '');

      const events = [];
      progress.startDeployProgress({
        dataDir: TEST_DATA_DIR,
        emit: (event, payload) => events.push({ event, payload }),
        onAppsChanged: () => {},
      });
      const event = await waitFor(() => events.find((entry) => entry.payload.runId === runId));
      progress.stopDeployProgress();
      const eventText = JSON.stringify(event?.payload ?? {});
      check('live progress emits the redacted file after the secret rotation',
        event?.event === 'deploy:progress'
          && !eventText.includes(ENV_OLD) && !eventText.includes(TOKEN_OLD)
          && eventText.includes('build complete'),
        eventText.slice(0, 400));
    }

    run.status = 'success';
    run.step = 'done';
    run.stage = 'done';
    run.finishedAt = 1_800_000_010_000;
    store.writeRun(run, TEST_DATA_DIR);
  } finally {
    lock.release();
  }

  setGroup('3. pre-1.4.5 unmarked raw logs fail closed');
  {
    const legacyId = '20261124-140001-bcdef0';
    const legacy = {
      ...run,
      id: legacyId,
      releaseId: legacyId,
      status: 'running',
      step: 'build',
      stage: 'build',
      finishedAt: null,
    };
    delete legacy.logSecurity;
    store.writeRun(legacy, TEST_DATA_DIR);
    fs.writeFileSync(
      store.logFile(created.app.id, legacyId, TEST_DATA_DIR),
      `legacy raw ${ENV_OLD} ${TOKEN_OLD}\n`,
      'utf8',
    );
    const legacyLock = store.acquireLock(created.app.id, { runId: legacyId, dataDir: TEST_DATA_DIR });
    if (!legacyLock.ok) throw new Error(legacyLock.reason);
    try {
      const viaHub = await hubCommands.handleHubDeployCommand(
        { action: 'run', id: created.app.id, runId: legacyId },
        { permissions: { 'deploy.logs': true } },
      );
      check('the Hub returns no bytes from an unmarked legacy log',
        viaHub.log === '' && viaHub.logUnavailable === 'legacy-format'
          && !JSON.stringify(viaHub).includes(ENV_OLD));

      const viaDashboard = callDashboardRun(new DeploymentsController(), created.app.id, legacyId);
      check('the dashboard returns no bytes from an unmarked legacy log',
        viaDashboard.answer?.log === '' && viaDashboard.answer?.logUnavailable === 'legacy-format'
          && !JSON.stringify(viaDashboard.answer).includes(ENV_OLD));

      const events = [];
      progress.startDeployProgress({
        dataDir: TEST_DATA_DIR,
        emit: (event, payload) => events.push({ event, payload }),
        onAppsChanged: () => {},
      });
      const event = await waitFor(() => events.find((entry) => entry.payload.runId === legacyId));
      progress.stopDeployProgress();
      check('live progress omits an unmarked legacy log completely',
        event?.payload?.lines?.length === 0
          && !JSON.stringify(event?.payload ?? {}).includes(ENV_OLD),
        JSON.stringify(event?.payload?.lines ?? []));

      const retirement = await import(srcUrl('core/deploy/logRetirement.js'));
      const whileActive = retirement.retireLegacyDeployLogs({ dataDir: TEST_DATA_DIR });
      check('the migration does not touch an actively locked deployment',
        whileActive.activeApps.includes(created.app.id)
          && fs.existsSync(store.logFile(created.app.id, legacyId, TEST_DATA_DIR)));
    } finally {
      legacyLock.release();
    }

    setGroup('4. legacy bytes, including orphan app folders, are retired before backup');
    const legacyRun = {
      ...legacy,
      status: 'failed',
      step: 'install',
      error: `failed with ${ENV_OLD}`,
      reason: `token ${TOKEN_OLD}`,
      warnings: [`warning ${ENV_OLD}`],
      logTail: [`tail ${TOKEN_OLD}`],
    };
    store.writeRun(legacyRun, TEST_DATA_DIR);

    const orphanId = '20261124-140002-cdef01';
    const orphanAppId = 'orphaned-legacy-app';
    const orphanRoot = path.join(TEST_DATA_DIR, 'ez_deploys', orphanAppId);
    const orphanPaths = store.pathsIn(orphanRoot);
    fs.mkdirSync(orphanPaths.runs, { recursive: true });
    fs.mkdirSync(orphanPaths.logs, { recursive: true });
    store.writeRunAt(orphanPaths, {
      ...legacyRun,
      appId: orphanAppId,
      id: orphanId,
      releaseId: orphanId,
      error: `orphan failure ${ENV_OLD}`,
      warnings: [`orphan warning ${TOKEN_OLD}`],
    });
    const orphanLog = path.join(orphanPaths.logs, `${orphanId}.log`);
    fs.writeFileSync(orphanLog, `orphan raw ${ENV_OLD} ${TOKEN_OLD}\n`, 'utf8');

    const cfg = await import(srcUrl('core/config.js'));
    const originalConfig = cfg.loadConfig();
    const customOrphanId = '20261124-140003-def012';
    const customAppId = 'orphan-custom-root-app';
    const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-external-deploy-root-'));
    const customPaths = store.pathsIn(path.join(customRoot, customAppId));
    const unrelatedRootFile = path.join(customRoot, 'operator-notes.txt');
    fs.writeFileSync(unrelatedRootFile, 'leave this file alone\n', 'utf8');
    fs.mkdirSync(customPaths.runs, { recursive: true });
    fs.mkdirSync(customPaths.logs, { recursive: true });
    store.writeRunAt(customPaths, {
      ...legacyRun,
      appId: customAppId,
      id: customOrphanId,
      releaseId: customOrphanId,
      error: `custom orphan failure ${ENV_OLD}`,
    });
    const customOrphanLog = path.join(customPaths.logs, `${customOrphanId}.log`);
    fs.writeFileSync(customOrphanLog, `custom orphan raw ${TOKEN_OLD}\n`, 'utf8');
    cfg.saveConfig({ ...originalConfig, deployDir: customRoot });

    const purgeCore = await import(srcUrl('core/purge.js'));
    let exportSawRemovedLog = false;
    let exportSawRemovedOrphanLog = false;
    let exportSawRemovedCustomOrphanLog = false;
    const backupCopy = path.join(TEST_DATA_DIR, 'scratch', 'legacy-log-backup-copy.log');
    fs.rmSync(backupCopy, { force: true });
    const blocked = await purgeCore.purge({
      dataDir: TEST_DATA_DIR,
      certificates: 'keep',
      backupDir: path.join(TEST_DATA_DIR, 'scratch', 'legacy-log-backup-aborted'),
      deps: {
        config: (await import(srcUrl('core/config.js'))).loadConfig(),
        service: { uninstall: async () => ({ ok: true, mechanism: 'stub' }) },
        exportBackup: () => {
          const sourceLog = store.logFile(created.app.id, legacyId, TEST_DATA_DIR);
          exportSawRemovedLog = !fs.existsSync(sourceLog);
          exportSawRemovedOrphanLog = !fs.existsSync(orphanLog);
          exportSawRemovedCustomOrphanLog = !fs.existsSync(customOrphanLog);
          if (fs.existsSync(sourceLog)) {
            fs.mkdirSync(path.dirname(backupCopy), { recursive: true });
            fs.copyFileSync(sourceLog, backupCopy);
          }
          return { ok: false, reason: 'stop after the safety check' };
        },
      },
    });
    check('the purge reaches the backup only after legacy log retirement',
      blocked.step === 'backup' && exportSawRemovedLog === true
        && exportSawRemovedOrphanLog === true
        && exportSawRemovedCustomOrphanLog === true,
      JSON.stringify({
        step: blocked.step,
        exportSawRemovedLog,
        exportSawRemovedOrphanLog,
        exportSawRemovedCustomOrphanLog,
      }));

    const retired = store.readRun(created.app.id, legacyId, TEST_DATA_DIR);
    check('the raw legacy log file no longer exists',
      !fs.existsSync(store.logFile(created.app.id, legacyId, TEST_DATA_DIR)));
    check('the run is marked retired rather than trusted',
      retired?.logSecurity === 'retired-v1' && retired?.logRetired === true);
    check('free-form legacy diagnostics are replaced',
      !JSON.stringify(retired).includes(ENV_OLD)
        && !JSON.stringify(retired).includes(TOKEN_OLD)
        && retired?.logTail.length === 0
        && /removed during .* log-security migration/.test(retired?.error ?? ''));
    check('a purge backup contains no copy of the retired raw log',
      !fs.existsSync(backupCopy), backupCopy);
    check('an app folder missing from the registry is retired too',
      !fs.existsSync(orphanLog)
        && !JSON.stringify(store.listRunsAt(orphanPaths)).includes(ENV_OLD)
        && store.listRunsAt(orphanPaths)[0]?.logSecurity === 'retired-v1');
    check('an orphan under a configured external deployment root is retired too',
      !fs.existsSync(customOrphanLog)
        && !JSON.stringify(store.listRunsAt(customPaths)).includes(ENV_OLD)
        && store.listRunsAt(customPaths)[0]?.logSecurity === 'retired-v1');
    check('the external-root retirement leaves unrelated files alone',
      fs.readFileSync(unrelatedRootFile, 'utf8') === 'leave this file alone\n');
    cfg.saveConfig(originalConfig);
    fs.rmSync(customRoot, { recursive: true, force: true });
  }

  setGroup('5. marked and legacy log paths reject links and parent swaps');
  {
    const safeFile = await import(srcUrl('core/safe-file.js'));
    const retirement = await import(srcUrl('core/deploy/logRetirement.js'));
    const paths = store.appPaths(created.app.id, TEST_DATA_DIR);
    const linkedId = '20261124-140004-ef0123';
    const target = path.join(TEST_DATA_DIR, 'scratch', 'linked-log-secret.txt');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `linked secret ${TOKEN_OLD}\n`, 'utf8');

    const markedLinkRun = {
      ...run,
      id: linkedId,
      releaseId: linkedId,
      status: 'running',
      step: 'build',
      stage: 'build',
      finishedAt: null,
      logSecurity: logSecurity.LOG_SECURITY_REDACTED_V1,
    };
    store.writeRun(markedLinkRun, TEST_DATA_DIR);
    const linkedLog = store.logFile(created.app.id, linkedId, TEST_DATA_DIR);
    fs.rmSync(linkedLog, { force: true });
    fs.linkSync(target, linkedLog);

    const linkedLock = store.acquireLock(created.app.id, {
      runId: linkedId,
      dataDir: TEST_DATA_DIR,
    });
    if (!linkedLock.ok) throw new Error(linkedLock.reason);
    try {
      const tail = store.readLogTail(created.app.id, linkedId, { dataDir: TEST_DATA_DIR });
      check('a marked log replaced by a hard link is never read',
        tail.text === '' && !tail.text.includes(TOKEN_OLD), tail.text.slice(0, 120));

      const viaHub = await hubCommands.handleHubDeployCommand(
        { action: 'run', id: created.app.id, runId: linkedId },
        { permissions: { 'deploy.logs': true } },
      );
      check('the Hub returns no bytes through a linked marked log',
        viaHub.log === '' && !JSON.stringify(viaHub).includes(TOKEN_OLD),
        JSON.stringify(viaHub).slice(0, 300));

      const viaDashboard = callDashboardRun(new DeploymentsController(), created.app.id, linkedId);
      check('the dashboard returns no bytes through a linked marked log',
        viaDashboard.answer?.log === ''
          && !JSON.stringify(viaDashboard.answer).includes(TOKEN_OLD),
        JSON.stringify(viaDashboard.answer).slice(0, 300));

      const events = [];
      progress.startDeployProgress({
        dataDir: TEST_DATA_DIR,
        emit: (event, payload) => events.push({ event, payload }),
        onAppsChanged: () => {},
      });
      const event = await waitFor(() => events.find((entry) => entry.payload.runId === linkedId));
      progress.stopDeployProgress();
      check('live progress returns no bytes through a linked marked log',
        event?.payload?.lines?.length === 0
          && !JSON.stringify(event?.payload ?? {}).includes(TOKEN_OLD),
        JSON.stringify(event?.payload ?? {}).slice(0, 300));
    } finally {
      linkedLock.release();
    }

    store.writeRun({ ...markedLinkRun, logSecurity: undefined }, TEST_DATA_DIR);
    const linkedRetirement = retirement.retireLegacyDeployLogs({ dataDir: TEST_DATA_DIR });
    check('legacy retirement refuses a hard-linked raw log',
      linkedRetirement.ok === false
        && linkedRetirement.errors.some((entry) => /linked or non-regular/i.test(entry.reason))
        && fs.existsSync(target)
        && fs.existsSync(linkedLog),
      JSON.stringify(linkedRetirement.errors));
    fs.rmSync(linkedLog, { force: true });

    if (process.platform !== 'win32') {
      store.writeRun({ ...markedLinkRun, logSecurity: undefined }, TEST_DATA_DIR);
      fs.symlinkSync(target, linkedLog, 'file');
      const symlinkRetirement = retirement.retireLegacyDeployLogs({ dataDir: TEST_DATA_DIR });
      check('legacy retirement refuses a symbolic-linked raw log',
        symlinkRetirement.ok === false
          && symlinkRetirement.errors.some((entry) => /linked or non-regular/i.test(entry.reason))
          && fs.existsSync(target)
          && fs.lstatSync(linkedLog).isSymbolicLink(),
        JSON.stringify(symlinkRetirement.errors));
      fs.rmSync(linkedLog, { force: true });
    } else {
      check('legacy retirement refuses a symbolic-linked raw log', true,
        'file symlinks require Windows Developer Mode; directory junctions are checked below');
    }

    store.writeRun(markedLinkRun, TEST_DATA_DIR);
    fs.writeFileSync(linkedLog, `safe marker ${TOKEN_OLD}\n`, 'utf8');
    const oldLogs = `${paths.logs}.real`;
    const externalLogs = scratch('linked-log-directory');
    fs.mkdirSync(externalLogs, { recursive: true });
    fs.writeFileSync(path.join(externalLogs, `${linkedId}.log`), `junction secret ${TOKEN_OLD}\n`, 'utf8');
    fs.renameSync(paths.logs, oldLogs);
    fs.symlinkSync(
      externalLogs,
      paths.logs,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    try {
      const junctionTail = store.readLogTail(created.app.id, linkedId, { dataDir: TEST_DATA_DIR });
      check('a linked deployment logs directory is refused as a whole',
        junctionTail.text === '' && !junctionTail.text.includes(TOKEN_OLD),
        junctionTail.text.slice(0, 120));
    } finally {
      if (process.platform === 'win32') fs.rmdirSync(paths.logs);
      else fs.unlinkSync(paths.logs);
      fs.renameSync(oldLogs, paths.logs);
    }

    const parent = scratch('safe-parent-identity');
    const movedParent = `${parent}-moved`;
    fs.mkdirSync(parent, { recursive: true });
    const snapshot = safeFile.snapshotDirectory(parent);
    fs.renameSync(parent, movedParent);
    fs.mkdirSync(parent);
    let swappedReadRefused = false;
    let swappedWriteRefused = false;
    try {
      const opened = safeFile.openVerifiedChild(path.join(parent, 'log.txt'), {
        expectedDirectoryIdentity: snapshot.stat,
      });
      opened.close();
    } catch (error) {
      swappedReadRefused = /identity changed/i.test(error.message);
    }
    try {
      safeFile.writeFileEventual(path.join(parent, 'run.json'), '{}', {
        expectedDirectoryIdentity: snapshot.stat,
      });
    } catch (error) {
      swappedWriteRefused = /identity changed/i.test(error.message);
    }
    check('a parent-directory swap is detected before a trusted read',
      swappedReadRefused);
    check('a parent-directory swap is detected before an atomic write',
      swappedWriteRefused
        && !fs.existsSync(path.join(parent, 'run.json'))
        && !fs.existsSync(path.join(movedParent, 'run.json')));
  }

  try { db.closeDb(); } catch { /* already closed */ }

  const failed = results.filter((result) => !result.passed);
  process.stdout.write(`\n${'-'.repeat(64)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failed) {
      process.stdout.write(`  [${failure.group}] ${failure.label}${failure.detail ? ` (${failure.detail})` : ''}\n`);
    }
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  try { db?.closeDb(); } catch { /* already closed */ }
  process.exit(1);
});
