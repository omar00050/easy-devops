/**
 * Tests for `ezz cleanup` — the reclaimable-file inventory and its removal.
 *
 * Run with:  npm run test:e2e -- cleanup
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * The interesting assertions are the negative ones. A cleanup command is only
 * as good as the list of things it will not touch, and that list cannot be
 * verified by reading the code: it has to be driven with the protected files
 * actually present. So this suite seeds a data directory that contains both
 * kinds of file and asserts the scan sees exactly the reclaimable ones.
 *
 * Every external tool is stubbed. PM2 and the Node version managers are
 * reached only through injected `deps`, and the assertions are on the commands
 * the stub was asked to run — including the assertion that a scan runs no pm2
 * command at all when PM2's daemon is not up, because every pm2 command starts
 * one.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n-- ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

const DAY = 86_400_000;

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a file of a given size with a given age. */
function seed(target, { bytes = 64, ageDays = 0 } = {}) {
  assertInsideTestDataDir(target, `seed ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'x'.repeat(bytes));
  if (ageDays) {
    const when = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(target, when, when);
  }
  return target;
}

/** A `run` stub that records every command and answers from a table. */
function recordingRun(answers = {}) {
  const commands = [];
  const fn = async (command) => {
    commands.push(command);
    for (const [pattern, answer] of Object.entries(answers)) {
      if (command.includes(pattern)) {
        return { success: true, stdout: answer, stderr: '', exitCode: 0, command, ...(answer === null ? { success: false } : {}) };
      }
    }
    return { success: false, stdout: '', stderr: 'not stubbed', exitCode: 1, command };
  };
  fn.commands = commands;
  return fn;
}

// ─── 1. The inventory ────────────────────────────────────────────────────────

async function testScan() {
  setGroup('1. what the scan finds, and what it never lists');

  const cleanup = await import(srcUrl('core/cleanup.js'));
  const dataDir = scratch('cleanup-scan');
  const nginxDir = scratch('cleanup-nginx');

  // ── Reclaimable ──────────────────────────────────────────────────────────
  const oldLog = seed(path.join(dataDir, 'logs', 'dashboard.log'), { bytes: 2048, ageDays: 30 });
  const supervisorLog = seed(path.join(dataDir, 'daemon-supervisor.log'), { bytes: 512, ageDays: 20 });
  const tmp = seed(path.join(dataDir, 'half-written.tmp'), { bytes: 10 });
  const bak = seed(path.join(nginxDir, 'conf.d', 'example.com.conf.bak'), { bytes: 300, ageDays: 3 });

  // ── Never reclaimable ────────────────────────────────────────────────────
  const freshLog = seed(path.join(dataDir, 'logs', 'today.log'), { bytes: 100, ageDays: 1 });
  const db = seed(path.join(dataDir, 'easy-devops.sqlite'), { bytes: 4096, ageDays: 90 });
  const wal = seed(path.join(dataDir, 'easy-devops.sqlite-wal'), { bytes: 1024, ageDays: 90 });
  const activeConf = seed(path.join(nginxDir, 'conf.d', 'example.com.conf'), { bytes: 300, ageDays: 90 });
  const stopRequest = seed(path.join(dataDir, 'daemon.stop'), { bytes: 50, ageDays: 10 });

  // A certificate directory, which must never be walked at all.
  const sslDir = scratch('cleanup-ssl');
  const certKey = seed(path.join(sslDir, 'example.com', 'privkey.pem'), { bytes: 1700, ageDays: 200 });

  const report = await cleanup.scan({
    dataDir,
    days: 14,
    config: { nginxDir, sslDir },
    deps: {
      run: recordingRun(),
      // No PM2 and no version manager on this imaginary machine.
      isDaemonRunning: () => false,
      runnerDetect: async () => ({ installed: false }),
      listInstalledNode: async () => ({ manager: null, versions: [] }),
    },
  });

  const listed = new Set(report.items.map((i) => path.resolve(i.path)));
  const removable = new Set(report.items.filter((i) => i.removable).map((i) => path.resolve(i.path)));

  check('an old log is reclaimable', removable.has(path.resolve(oldLog)));
  check('the logon supervisor log is reclaimable', removable.has(path.resolve(supervisorLog)));
  check('a .tmp file is reclaimable', removable.has(path.resolve(tmp)));
  check('an nginx .bak file is reclaimable', removable.has(path.resolve(bak)));

  check('a log inside the age threshold is not listed', !listed.has(path.resolve(freshLog)));
  check('the database is never listed', !listed.has(path.resolve(db)));
  check('nor its -wal sibling', !listed.has(path.resolve(wal)));
  check('an active .conf is never listed', !listed.has(path.resolve(activeConf)));
  check('a pending stop request is never listed, it is a deliberate state',
    !listed.has(path.resolve(stopRequest)));
  check('nothing under sslDir is listed',
    ![...listed].some((p) => p.startsWith(path.resolve(sslDir))),
    [...listed].filter((p) => p.startsWith(path.resolve(sslDir))).join(', '));
  check('the certificate key is still on disk', fs.existsSync(certKey));

  // Sizes, which are what make the report worth reading.
  const logItem = report.items.find((i) => path.resolve(i.path) === path.resolve(oldLog));
  check('each item carries its size', logItem?.bytes === 2048, String(logItem?.bytes));
  check('the total counts only what can be freed',
    report.totalBytes === [...removable].reduce((sum, p) => sum + fs.statSync(p).size, 0),
    String(report.totalBytes));
  check('and is rendered in ASCII', /^[\x20-\x7e]+$/.test(cleanup.humanBytes(report.totalBytes)),
    cleanup.humanBytes(report.totalBytes));

  // A dry run is a read: nothing may have been removed.
  check('the scan removed nothing',
    [oldLog, supervisorLog, tmp, bak, freshLog, db, activeConf, stopRequest].every((f) => fs.existsSync(f)));

  // --days moves the line, and nothing else.
  const strict = await cleanup.scan({
    dataDir,
    days: 0,
    config: { nginxDir, sslDir },
    deps: {
      run: recordingRun(),
      isDaemonRunning: () => false,
      runnerDetect: async () => ({ installed: false }),
      listInstalledNode: async () => ({ manager: null, versions: [] }),
    },
  });
  check('--days 0 includes a log from today',
    strict.items.some((i) => path.resolve(i.path) === path.resolve(freshLog)));
  check('but still not the database',
    !strict.items.some((i) => path.resolve(i.path) === path.resolve(db)));
}

// ─── 2. The daemon lock ──────────────────────────────────────────────────────

async function testLock() {
  setGroup('2. a live lock is not litter');

  const cleanup = await import(srcUrl('core/cleanup.js'));
  const lock = await import(srcUrl('core/daemon/lock.js'));
  const dataDir = scratch('cleanup-lock');

  const noPm2 = {
    run: recordingRun(),
    isDaemonRunning: () => false,
    runnerDetect: async () => ({ installed: false }),
    listInstalledNode: async () => ({ manager: null, versions: [] }),
  };

  // This process holds the lock, with a fresh heartbeat: alive by both tests.
  const held = lock.acquire({ dataDir, version: 'cleanup-test', mode: 'daemon' });
  check('the test holds the lock', held.ok === true, held.reason ?? '');

  const live = await cleanup.scan({ dataDir, config: {}, deps: noPm2 });
  check('a live lock is not listed',
    !live.items.some((i) => i.path === lock.lockPath(dataDir)),
    live.items.map((i) => i.path).join(', '));

  lock.release({ dataDir });

  // A dead one: a pid that cannot exist and a stale heartbeat.
  fs.writeFileSync(lock.lockPath(dataDir), JSON.stringify({
    pid: 0x7ffffffe,
    startedAt: Date.now() - 600_000,
    heartbeatAt: Date.now() - 600_000,
    version: 'ghost',
    mode: 'daemon',
  }));

  const dead = await cleanup.scan({ dataDir, config: {}, deps: noPm2 });
  const lockItem = dead.items.find((i) => i.path === lock.lockPath(dataDir));
  check('a dead lock is reclaimable', Boolean(lockItem?.removable), lockItem?.why ?? 'not listed');

  fs.rmSync(lock.lockPath(dataDir), { force: true });
}

// ─── 3. Stale claims ─────────────────────────────────────────────────────────

async function testClaims() {
  setGroup('3. stale notification claims');

  const cleanup = await import(srcUrl('core/cleanup.js'));
  const claim = await import(srcUrl('core/notifications/claim.js'));
  const dataDir = scratch('cleanup-claims');

  const dir = claim.claimDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });

  const stale = seed(path.join(dir, 'old.claim'), { bytes: 80 });
  const old = new Date(Date.now() - claim.CLAIM_TTL_MS - 60_000);
  fs.utimesSync(stale, old, old);

  const fresh = seed(path.join(dir, 'new.claim'), { bytes: 80 });

  const report = await cleanup.scan({
    dataDir,
    config: {},
    deps: {
      run: recordingRun(),
      isDaemonRunning: () => false,
      runnerDetect: async () => ({ installed: false }),
      listInstalledNode: async () => ({ manager: null, versions: [] }),
    },
  });

  const paths = report.items.filter((i) => i.removable).map((i) => path.resolve(i.path));
  check('a claim past its TTL is reclaimable', paths.includes(path.resolve(stale)));
  check('a claim still inside its TTL is left alone, it may be a live send',
    !paths.includes(path.resolve(fresh)));
}

// ─── 4. Runtime backups ──────────────────────────────────────────────────────

async function testRuntimeBackups() {
  setGroup('4. runtime and data backups, newest kept');

  const cleanup = await import(srcUrl('core/cleanup.js'));
  const dataDir = scratch('cleanup-backups');

  // Two data-directory backups beside it, of different ages.
  const parent = path.dirname(dataDir);
  const base = path.basename(dataDir);
  const older = path.join(parent, `${base}.backup-2026-01-01T00-00-00`);
  const newer = path.join(parent, `${base}.backup-2026-06-01T00-00-00`);
  seed(path.join(older, 'easy-devops.sqlite'), { bytes: 1000, ageDays: 300 });
  seed(path.join(newer, 'easy-devops.sqlite'), { bytes: 1000, ageDays: 10 });
  const olderWhen = new Date(Date.now() - 300 * DAY);
  const newerWhen = new Date(Date.now() - 10 * DAY);
  fs.utimesSync(older, olderWhen, olderWhen);
  fs.utimesSync(newer, newerWhen, newerWhen);

  const report = await cleanup.scan({
    dataDir,
    config: {},
    deps: {
      run: recordingRun(),
      isDaemonRunning: () => false,
      runnerDetect: async () => ({ installed: false }),
      listInstalledNode: async () => ({ manager: null, versions: [] }),
    },
  });

  const olderItem = report.items.find((i) => path.resolve(i.path) === path.resolve(older));
  const newerItem = report.items.find((i) => path.resolve(i.path) === path.resolve(newer));

  check('the older data backup is reclaimable', Boolean(olderItem?.removable), olderItem?.why ?? 'not listed');
  check('the newest one is listed but kept',
    Boolean(newerItem) && newerItem.removable === false && newerItem.keep === true,
    newerItem?.why ?? 'not listed');
  check('and the report says why it is kept',
    /kept/i.test(newerItem?.why ?? ''), newerItem?.why ?? '');
}

// ─── 5. PM2 ──────────────────────────────────────────────────────────────────

async function testPm2() {
  setGroup('5. PM2 logs are flushed, never deleted');

  const cleanup = await import(srcUrl('core/cleanup.js'));
  const dataDir = scratch('cleanup-pm2');
  const fakePm2Home = scratch('cleanup-pm2-home');
  seed(path.join(fakePm2Home, 'logs', 'app-out.log'), { bytes: 5000, ageDays: 1 });

  // ── With the daemon down, no pm2 command may run at all ──────────────────
  const quiet = recordingRun();
  const down = await cleanup.scan({
    dataDir,
    config: {},
    deps: {
      run: quiet,
      isDaemonRunning: () => false,
      runnerDetect: async () => ({ installed: true, path: 'pm2' }),
      pm2HomeDir: () => fakePm2Home,
      listInstalledNode: async () => ({ manager: null, versions: [] }),
    },
  });

  const pm2Commands = quiet.commands.filter((c) => /\bpm2\b/.test(c));
  check('a scan runs no pm2 command when the daemon is down',
    pm2Commands.length === 0, pm2Commands.join(' | '));

  const downItem = down.items.find((i) => i.group === 'pm2-logs');
  check('PM2 logs are listed with their size', downItem?.bytes === 5000, String(downItem?.bytes));
  check('but not offered for removal, because flushing would start the daemon',
    downItem?.removable === false, downItem?.why ?? '');

  // ── With the daemon up, the action is a flush ────────────────────────────
  const up = await cleanup.scan({
    dataDir,
    config: {},
    deps: {
      run: recordingRun(),
      isDaemonRunning: () => true,
      runnerDetect: async () => ({ installed: true, path: 'pm2' }),
      runnerList: async () => ({ ok: true, apps: [] }),
      pm2HomeDir: () => fakePm2Home,
      listInstalledNode: async () => ({ manager: null, versions: [] }),
    },
  });

  const upItem = up.items.find((i) => i.group === 'pm2-logs');
  check('with the daemon up it becomes removable', upItem?.removable === true);
  check('and its action is a flush, not a delete', upItem?.action === 'pm2-flush', upItem?.action);

  const flush = recordingRun({ 'pm2 flush': 'flushed' });
  const applied = await cleanup.apply({ items: [upItem], deps: { run: flush } });

  check('apply runs `pm2 flush`',
    flush.commands.some((c) => /pm2 flush/.test(c)), flush.commands.join(' | '));
  check('and deletes no log file itself',
    fs.existsSync(path.join(fakePm2Home, 'logs', 'app-out.log')));
  check('the flush is reported as removed', applied.removed.length === 1);
}

// ─── 6. Node versions ────────────────────────────────────────────────────────

async function testNodeVersions() {
  setGroup('6. installed Node versions are listed, with the evidence');

  const cleanup = await import(srcUrl('core/cleanup.js'));
  const dataDir = scratch('cleanup-node');

  const versions = [
    { version: '18.20.4', isCurrent: false, isDefault: false, path: null },
    { version: '20.11.1', isCurrent: false, isDefault: true, path: null },
    { version: '22.11.0', isCurrent: true, isDefault: false, path: null },
    { version: '16.20.2', isCurrent: false, isDefault: false, path: null },
  ];

  const report = await cleanup.scan({
    dataDir,
    config: {},
    deps: {
      run: recordingRun(),
      isDaemonRunning: () => true,
      runnerDetect: async () => ({ installed: false }),
      listInstalledNode: async () => ({ manager: 'nvm', versions }),
      // The service is pinned to 18.20.4, and a PM2 app runs 16.20.2.
      recordedState: () => ({ nodeExe: '/home/u/.nvm/versions/node/v18.20.4/bin/node' }),
      pm2NodeVersions: async () => new Set(['16.20.2']),
    },
  });

  const byVersion = {};
  for (const item of report.items.filter((i) => i.group === 'node-versions')) {
    byVersion[item.version] = item;
  }

  check('every installed version is listed', Object.keys(byVersion).length === 4,
    Object.keys(byVersion).join(', '));

  check('the pinned version is never removable',
    byVersion['18.20.4']?.removable === false, byVersion['18.20.4']?.why);
  check('and says the service is pinned to it',
    /pinned/i.test(byVersion['18.20.4']?.why ?? ''), byVersion['18.20.4']?.why);

  check('the version manager default is never removable',
    byVersion['20.11.1']?.removable === false, byVersion['20.11.1']?.why);
  check('the version in use by the shell is never removable',
    byVersion['22.11.0']?.removable === false, byVersion['22.11.0']?.why);
  check('a version a PM2 app runs is never removable',
    byVersion['16.20.2']?.removable === false, byVersion['16.20.2']?.why);

  // With all four accounted for, nothing is offered — which is the common and
  // correct outcome on a real machine.
  check('nothing unexplained is offered',
    report.items.filter((i) => i.group === 'node-versions' && i.removable).length === 0);

  // One that nothing refers to.
  const spare = await cleanup.scan({
    dataDir,
    config: {},
    deps: {
      run: recordingRun(),
      isDaemonRunning: () => true,
      runnerDetect: async () => ({ installed: false }),
      listInstalledNode: async () => ({
        manager: 'nvm',
        versions: [...versions, { version: '14.21.3', isCurrent: false, isDefault: false, path: null }],
      }),
      recordedState: () => ({ nodeExe: '/home/u/.nvm/versions/node/v18.20.4/bin/node' }),
      pm2NodeVersions: async () => new Set(['16.20.2']),
    },
  });

  const orphan = spare.items.find((i) => i.version === '14.21.3');
  check('a version nothing refers to is offered', orphan?.removable === true, orphan?.why);
  check('with the reason stated plainly',
    /nothing on this machine refers to it/.test(orphan?.why ?? ''), orphan?.why);

  // Selecting it drives the manager, in its own syntax.
  const uninstall = recordingRun({ 'nvm uninstall': 'Uninstalled node v14.21.3' });
  await cleanup.apply({ items: [orphan], deps: { run: uninstall } });
  check('apply asks the version manager to uninstall it',
    uninstall.commands.some((c) => /nvm uninstall 14\.21\.3/.test(c)),
    uninstall.commands.join(' | '));
}

// ─── 7. Apply touches only what it is given ──────────────────────────────────

async function testApply() {
  setGroup('7. apply removes only the selected items');

  const cleanup = await import(srcUrl('core/cleanup.js'));
  const dataDir = scratch('cleanup-apply');

  const chosen = seed(path.join(dataDir, 'logs', 'chosen.log'), { bytes: 128, ageDays: 40 });
  const notChosen = seed(path.join(dataDir, 'logs', 'left.log'), { bytes: 128, ageDays: 40 });

  const report = await cleanup.scan({
    dataDir,
    config: {},
    deps: {
      run: recordingRun(),
      isDaemonRunning: () => false,
      runnerDetect: async () => ({ installed: false }),
      listInstalledNode: async () => ({ manager: null, versions: [] }),
    },
  });

  const pick = report.items.find((i) => path.resolve(i.path) === path.resolve(chosen));
  const result = await cleanup.apply({ items: [pick], deps: { run: recordingRun() } });

  check('the selected file is gone', !fs.existsSync(chosen));
  check('the one not selected is still there', fs.existsSync(notChosen));
  check('the freed size is reported', result.freedBytes === 128, String(result.freedBytes));

  // Defence in depth: a kept item passed in by a careless caller is refused.
  const keptItem = { group: 'runtime-backups', path: notChosen, bytes: 128, removable: false, keep: true };
  const refused = await cleanup.apply({ items: [keptItem], deps: { run: recordingRun() } });

  check('an item marked keep is refused even if handed in',
    refused.removed.length === 0 && refused.failed.length === 1,
    refused.failed[0]?.reason);
  check('and it is still on disk', fs.existsSync(notChosen));
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nCleanup: the inventory and its removal\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testScan();
  await testLock();
  await testClaims();
  await testRuntimeBackups();
  await testPm2();
  await testNodeVersions();
  await testApply();

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'-'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` - ${f.detail}` : ''}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
