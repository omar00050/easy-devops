/**
 * Tests for "Update" in the dashboard — the status record, the controller's
 * guards, and the hand-off to the detached worker.
 *
 * Run with:  npm run test:e2e -- dashboard-update
 *
 * npm is never run and no worker is ever spawned: the registry check and the
 * spawn are injected stubs. What is tested here is the part that decides —
 * when an update is refused, what the record says, and that the request
 * answers before any of the work begins.
 */

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
function setGroup(g) { group = g; process.stdout.write(`\n-- ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeReq(body = {}, port = 6443) {
  return { body, socket: { localPort: port } };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const NPM_SOURCE = {
  kind: 'npm',
  root: '/usr/lib/node_modules/easy-devops',
  npmUpdatable: true,
  reason: 'an npm-installed package at /usr/lib/node_modules/easy-devops',
  howToUpdate: [],
};

const CLONE_SOURCE = {
  kind: 'clone',
  root: '/home/me/Easy-DevOps',
  npmUpdatable: false,
  reason: 'a git clone at /home/me/Easy-DevOps',
  howToUpdate: ['cd /home/me/Easy-DevOps', 'git pull', 'npm install', 'ezz service restart'],
};

/** The controller with every side effect replaced. */
async function makeController(dataDir, overrides = {}) {
  const { default: UpdateController } = await import(srcUrl('dashboard/controllers/updateController.js'));
  const calls = { spawns: [], checks: 0 };
  const controller = new UpdateController({
    getDataDir: () => dataDir,
    currentVersion: () => '1.3.4',
    detectInstallSource: () => NPM_SOURCE,
    checkForUpdate: async () => {
      calls.checks += 1;
      return { reachable: true, current: '1.3.4', latest: '1.3.5', updateAvailable: true };
    },
    spawnWorker: (options) => {
      calls.spawns.push(options);
      return { pid: 4242 };
    },
    // This suite is about the run record and the hand-off. Whether an update
    // needs elevation is decided by the real Windows check, which must not run
    // here; the elevation answers themselves are covered by service-operator.
    elevationRequired: async () => false,
    ...overrides,
  });
  return { controller, calls };
}

// ─── 1. The status record ────────────────────────────────────────────────────

async function testStatusFile() {
  setGroup('1. updateStatus: the record the new dashboard reads');
  const status = await import(srcUrl('core/updateStatus.js'));
  const dir = scratch('status');

  check('nothing written yet reads as null', status.readStatus(dir) === null);

  const first = status.writeStatus(
    { id: 'run-1', phase: 'starting', from: '1.3.4', to: '1.3.5' },
    { dataDir: dir, replace: true }
  );
  check('a fresh record is written', first.id === 'run-1' && first.phase === 'starting');
  check('and stamps updatedAt', typeof first.updatedAt === 'number');

  const merged = status.writeStatus({ phase: 'updating', workerPid: 99 }, { dataDir: dir });
  check('a patch merges instead of replacing',
    merged.phase === 'updating' && merged.to === '1.3.5' && merged.workerPid === 99);

  const replaced = status.writeStatus({ id: 'run-2', phase: 'starting' }, { dataDir: dir, replace: true });
  check('replace starts from an empty record',
    replaced.id === 'run-2' && replaced.to === undefined && replaced.from === undefined);

  fs.writeFileSync(status.statusPath(dir), '{ not json');
  check('a truncated file reads as null, not an exception', status.readStatus(dir) === null);

  fs.writeFileSync(status.statusPath(dir), JSON.stringify({ hello: 'world' }));
  check('a record without an id/phase is not data', status.readStatus(dir) === null);

  for (const [label, record] of [
    ['an unknown phase', { id: 'bad-phase', phase: 'running-forever' }],
    ['an empty run id', { id: '', phase: 'starting' }],
    ['an overlong run id', { id: 'x'.repeat(201), phase: 'starting' }],
    ['an invalid dashboard PID', { id: 'bad-pid', phase: 'starting', dashboard: { pid: -1, port: 6443 } }],
    ['an invalid dashboard port', { id: 'bad-port', phase: 'starting', dashboard: { pid: 1, port: 70_000 } }],
    ['an invalid worker PID', { id: 'bad-worker-pid', phase: 'updating', workerPid: 0 }],
    ['an incomplete update version', { id: 'bad-version', phase: 'starting', from: '1.3.4 extra', to: '1.3.5' }],
  ]) {
    fs.writeFileSync(status.statusPath(dir), JSON.stringify(record));
    check(`${label} is not a process-control record`, status.readStatus(dir) === null);
  }

  fs.writeFileSync(status.statusPath(dir), JSON.stringify({
    id: 'oversized',
    phase: 'starting',
    padding: 'x'.repeat(300 * 1024),
  }));
  check('an oversized status record fails closed', status.readStatus(dir) === null);

  fs.writeFileSync(status.statusPath(dir), JSON.stringify({
    id: 'growth-race',
    phase: 'starting',
    padding: 'x'.repeat(300 * 1024),
  }));
  const actualFstat = fs.fstatSync;
  try {
    fs.fstatSync = (fd) => {
      const stat = actualFstat(fd);
      return { size: 1, nlink: stat.nlink, isFile: () => stat.isFile() };
    };
    check('a file that grows beyond the limit after fstat is rejected',
      status.readStatus(dir) === null);
  } finally {
    fs.fstatSync = actualFstat;
  }

  const live = { phase: 'updating', updatedAt: Date.now(), workerPid: process.pid };
  check('a live worker pid makes a run active', status.runIsActive(live) === true);
  check('a fresh heartbeat alone makes a run active',
    status.runIsActive({ phase: 'starting', updatedAt: Date.now(), workerPid: null }) === true);
  check('a stale heartbeat with no live worker is not active',
    status.runIsActive({ phase: 'updating', updatedAt: Date.now() - 60_000, workerPid: null }) === false);
  check('a final phase is never active',
    status.runIsActive({ phase: 'done', updatedAt: Date.now(), workerPid: process.pid }) === false);

  const stale = { id: 'run-3', phase: 'updating', updatedAt: Date.now() - 60_000, workerPid: null };
  check('a stale active run is presented as interrupted',
    status.describeRun(stale).phase === 'interrupted');
  check('a finished run is presented unchanged',
    status.describeRun({ id: 'run-4', phase: 'done', updatedAt: 1 }).phase === 'done');
  check('null stays null', status.describeRun(null) === null);
  check('the active window is published', status.STALE_AFTER_MS >= 30_000);
}

// ─── 2. The check endpoint ───────────────────────────────────────────────────

async function testCheck() {
  setGroup('2. check: registry, source and last run in one answer');
  const dir = scratch('check');
  const { controller } = await makeController(dir);
  const res = makeRes();
  await controller.check(makeReq(), res);

  check('200', res.statusCode === 200, String(res.statusCode));
  check('current and latest are passed through',
    res.body.current === '1.3.4' && res.body.latest === '1.3.5');
  check('updateAvailable is passed through', res.body.updateAvailable === true);
  check('the source is described without its root leaking as a field',
    res.body.source.npmUpdatable === true && res.body.source.howToUpdate.length === 0
    && res.body.source.root === undefined);
  check('no run yet is null', res.body.run === null);

  const clone = await makeController(dir, { detectInstallSource: () => CLONE_SOURCE });
  const cloneRes = makeRes();
  await clone.controller.check(makeReq(), cloneRes);
  check('a clone is reported as not npm-updatable',
    cloneRes.body.source.npmUpdatable === false && cloneRes.body.source.kind === 'clone');
  check('with the commands to run instead',
    cloneRes.body.source.howToUpdate.includes('git pull'),
    JSON.stringify(cloneRes.body.source.howToUpdate));
}

// ─── 3. Starting an update: refusals ─────────────────────────────────────────

async function testStartRefusals() {
  setGroup('3. start: the cases it must refuse');
  const status = await import(srcUrl('core/updateStatus.js'));

  const cloneDir = scratch('refuse-clone');
  const clone = await makeController(cloneDir, { detectInstallSource: () => CLONE_SOURCE });
  const cloneRes = makeRes();
  await clone.controller.start(makeReq({ version: '1.3.5' }), cloneRes);
  check('a non-npm copy is 409', cloneRes.statusCode === 409, String(cloneRes.statusCode));
  check('nothing is spawned for it', clone.calls.spawns.length === 0);
  check('the answer carries the source so the UI can explain',
    cloneRes.body.source?.kind === 'clone' && /git clone/.test(cloneRes.body.error));

  const activeDir = scratch('refuse-active');
  status.writeStatus(
    { id: 'busy', phase: 'updating', workerPid: process.pid, from: '1.3.4', to: '1.3.5' },
    { dataDir: activeDir, replace: true }
  );
  const active = await makeController(activeDir);
  const activeRes = makeRes();
  await active.controller.start(makeReq({ version: '1.3.5' }), activeRes);
  check('a live run is 409', activeRes.statusCode === 409, String(activeRes.statusCode));
  check('and the active run is echoed back', activeRes.body.run?.id === 'busy');
  check('no second worker is spawned', active.calls.spawns.length === 0);

  const unreachableDir = scratch('refuse-unreachable');
  const unreachable = await makeController(unreachableDir, {
    checkForUpdate: async () => ({ reachable: false, current: '1.3.4', latest: null, updateAvailable: false }),
  });
  const unreachableRes = makeRes();
  await unreachable.controller.start(makeReq({}), unreachableRes);
  check('an unreachable registry with no version is 502',
    unreachableRes.statusCode === 502, String(unreachableRes.statusCode));

  const badDir = scratch('invalid-registry');
  const bad = await makeController(badDir, {
    checkForUpdate: async () => ({ reachable: true, current: '1.3.4', latest: '1.3.5 extra', updateAvailable: true }),
  });
  const badRes = makeRes();
  await bad.controller.start(makeReq({}), badRes);
  check('invalid registry target cannot start a worker', badRes.statusCode === 502 && !bad.calls.spawns.length);

  const { runPendingUpdate } = await import(srcUrl('dashboard/updateWorker.js'));
  for (const [from, to] of [['1.3.4', '1.3.5 extra'], ['1.3.4 extra', '1.3.5']]) {
    const runId = 'invalid-worker';
    status.writeStatus({ id: runId, phase: 'starting', from, to }, { dataDir: badDir, replace: true });
    let applied = false;
    const code = await runPendingUpdate({ dataDir: badDir, runId, apply: () => { applied = true; } });
    const record = status.readStatus(badDir);
    check('worker refuses an invalid saved version before stopping the dashboard',
      code === 1 && !applied && record === null);
  }

  const uptodateDir = scratch('refuse-uptodate');
  const uptodate = await makeController(uptodateDir, {
    checkForUpdate: async () => ({ reachable: true, current: '1.3.5', latest: '1.3.5', updateAvailable: false }),
  });
  const uptodateRes = makeRes();
  await uptodate.controller.start(makeReq({}), uptodateRes);
  check('up to date with no version is 409',
    uptodateRes.statusCode === 409, String(uptodateRes.statusCode));
  check('and says which version is installed', /1\.3\.5/.test(uptodateRes.body.error));
}

// ─── 4. Starting an update: the accepted run ─────────────────────────────────

async function testStartAccepted() {
  setGroup('4. start: accepted run is recorded before the work begins');
  const status = await import(srcUrl('core/updateStatus.js'));
  const dir = scratch('accept');
  const { controller, calls } = await makeController(dir);
  const res = makeRes();

  await controller.start(makeReq({ version: '9.9.9-rc.1' }, 7777), res);

  check('the client is told the worker started', res.statusCode === 202 && res.body.started === true,
    String(res.statusCode));
  check('the target version is the one asked for', res.body.run?.to === '9.9.9-rc.1');
  check('the run starts in the starting phase', res.body.run?.phase === 'starting');
  check('the dashboard port comes from the request, not the config',
    res.body.run?.dashboard.port === 7777, String(res.body.run?.dashboard.port));

  const written = status.readStatus(dir);
  check('the record is on disk before the response', written?.id === res.body.run.id);
  check('with the worker pid filled in', written?.workerPid === 4242);
  check('and the from version recorded', written?.from === '1.3.4');

  check('exactly one worker is spawned', calls.spawns.length === 1);
  const spawn = calls.spawns[0] ?? {};
  check('the worker is told which run it owns',
    spawn.args?.[0] === '--run-id' && spawn.args?.[1] === res.body.run.id,
    JSON.stringify(spawn.args));
  check('its output goes to the update log',
    String(spawn.logPath).endsWith(path.join('logs', 'update.log')), String(spawn.logPath));
  check('and it is pointed at this data directory', spawn.dataDir === dir);

  // A second start while the first is active is refused; the record stays.
  const again = makeRes();
  await controller.start(makeReq({ version: '9.9.9-rc.1' }), again);
  check('a second start while it runs is refused', again.statusCode === 409 && calls.spawns.length === 1);

  // Only an omitted version requests a registry lookup.
  const fallbackDir = scratch('accept-fallback');
  const fallback = await makeController(fallbackDir);
  const fallbackRes = makeRes();
  await fallback.controller.start(makeReq({ version: 'latest' }), fallbackRes);
  check('a malformed target is refused before lookup or launch', fallbackRes.statusCode === 400 && fallback.calls.checks === 0 && !fallback.calls.spawns.length);

  // A stale active run does not block a new one. Written directly: writeStatus
  // stamps a fresh heartbeat, which is exactly what the fixture must not have.
  const staleDir = scratch('accept-stale');
  fs.writeFileSync(
    status.statusPath(staleDir),
    JSON.stringify({
      id: 'dead', phase: 'updating', workerPid: null,
      updatedAt: Date.now() - 120_000, from: '1.3.4', to: '1.3.5',
    })
  );
  const stale = await makeController(staleDir);
  const staleRes = makeRes();
  await stale.controller.start(makeReq({ version: '1.3.5' }), staleRes);
  check('a stale active run does not block a new one', staleRes.statusCode === 202,
    String(staleRes.statusCode));
  check('and the record is replaced, not merged', staleRes.body.run?.id !== 'dead');

  // Omitted-version starts wait for the registry. The reservation must happen
  // before that await, or two requests can both finish the lookup and spawn.
  const raceDir = scratch('accept-concurrent-start');
  let registryEntered;
  const entered = new Promise((resolve) => { registryEntered = resolve; });
  let releaseRegistry;
  const registryGate = new Promise((resolve) => { releaseRegistry = resolve; });
  const race = await makeController(raceDir, {
    checkForUpdate: async () => {
      race.calls.checks += 1;
      registryEntered();
      await registryGate;
      return { reachable: true, current: '1.3.4', latest: '1.3.5', updateAvailable: true };
    },
  });
  const firstRaceRes = makeRes();
  const firstRace = race.controller.start(makeReq({}), firstRaceRes);
  await entered;
  const secondRaceRes = makeRes();
  await race.controller.start(makeReq({}), secondRaceRes);
  check('a second registry-backed start is refused while the first is looking up',
    secondRaceRes.statusCode === 409 && race.calls.spawns.length === 0,
    `${secondRaceRes.statusCode} spawns=${race.calls.spawns.length}`);
  releaseRegistry();
  await firstRace;
  check('only the reserved request can launch the worker',
    firstRaceRes.statusCode === 202
      && secondRaceRes.statusCode === 409
      && race.calls.checks === 1
      && race.calls.spawns.length === 1,
    `first=${firstRaceRes.statusCode} second=${secondRaceRes.statusCode} checks=${race.calls.checks} spawns=${race.calls.spawns.length}`);

  // Even if two worker processes are started for one run, the per-run claim
  // admits one apply() and the loser exits before touching npm or the dashboard.
  const { runPendingUpdate } = await import(srcUrl('dashboard/updateWorker.js'));
  const workerDir = scratch('worker-concurrent-claim');
  status.writeStatus({
    id: 'claimed-run',
    phase: 'starting',
    from: '1.3.4',
    to: '1.3.5',
    dashboard: { pid: 1, port: 6443 },
  }, { dataDir: workerDir, replace: true });
  let applyEntered;
  const applying = new Promise((resolve) => { applyEntered = resolve; });
  let releaseApply;
  const applyGate = new Promise((resolve) => { releaseApply = resolve; });
  let applies = 0;
  const firstWorker = runPendingUpdate({
    dataDir: workerDir,
    runId: 'claimed-run',
    apply: async () => {
      applies += 1;
      applyEntered();
      await applyGate;
      return 0;
    },
  });
  await applying;
  const secondWorker = await runPendingUpdate({
    dataDir: workerDir,
    runId: 'claimed-run',
    apply: async () => {
      applies += 1;
      return 0;
    },
  });
  releaseApply();
  const firstWorkerCode = await firstWorker;
  check('one worker owns a starting run and a duplicate exits before apply',
    firstWorkerCode === 0 && secondWorker === 1 && applies === 1,
    `first=${firstWorkerCode} second=${secondWorker} applies=${applies}`);
}

// ─── 5. The status endpoint ──────────────────────────────────────────────────

async function testStatusEndpoint() {
  setGroup('5. status: answers without touching the registry');
  const status = await import(srcUrl('core/updateStatus.js'));
  const dir = scratch('status-endpoint');
  status.writeStatus(
    { id: 'done-1', phase: 'done', from: '1.3.4', to: '1.3.5', workerPid: process.pid, updatedAt: Date.now() },
    { dataDir: dir, replace: true }
  );

  const { controller, calls } = await makeController(dir);
  const res = makeRes();
  await controller.getStatus(makeReq(), res);

  check('200', res.statusCode === 200, String(res.statusCode));
  check('the installed version is reported', res.body.current === '1.3.4');
  check('the run is reported', res.body.run?.id === 'done-1' && res.body.run?.phase === 'done');
  check('no registry call is made', calls.checks === 0);
  check('no worker is spawned', calls.spawns.length === 0);

  fs.writeFileSync(
    status.statusPath(dir),
    JSON.stringify({ id: 'dead-1', phase: 'updating', workerPid: null, updatedAt: Date.now() - 120_000 })
  );
  const staleRes = makeRes();
  await controller.getStatus(makeReq(), staleRes);
  check('an abandoned run is served as interrupted',
    staleRes.body.run?.phase === 'interrupted', staleRes.body.run?.phase);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nDashboard update: status record, guards and hand-off\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testStatusFile();
  await testCheck();
  await testStartRefusals();
  await testStartAccepted();
  await testStatusEndpoint();

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
