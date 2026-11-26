/**
 * e2e/hub-agent-service-pm2.test.mjs
 *
 * What the Hub agent tells the Hub about the native service and PM2 (1.4.9).
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * A real Windows Server 2025, 1.4.8, service RUNNING as
 * `NT SERVICE\EasyDevOps`. The local dashboard showed "Running, installed,
 * starts at boot, 14 PM2 apps"; the Hub showed "INSTALLED: No, STARTS: Not set
 * up, PM2: not installed" and a warning that Easy DevOps was not a background
 * service, plus "Waiting for the process list…" for ever.
 *
 * Two agent-side causes:
 *   - `service:state` was built in the daemon, which never runs `sc query`, so
 *     an UNKNOWN registration became `installed: false`;
 *   - `processes:list` encoded "PM2 is not visible from the service account"
 *     as `{ daemonRunning: false, apps: [] }` — identical to "nothing to
 *     report" — and the agent never said WHY.
 *
 * ── How this is tested ─────────────────────────────────────────────────────
 *
 * A fake socket target (`{ connected, emit }`) receives every payload, so the
 * exact contract shape is asserted without a Hub. PM2 is the shared fake at
 * e2e/fixtures/fake-pm2, driven through `runner`'s injectable `run`: nothing
 * here starts a real PM2 daemon, reads the real PM2_HOME, or spawns pm2/npm.
 *
 * The Windows service identity is simulated through the deps
 * `core/service/index.js` and `core/platform.js` already accept — never by
 * changing this process's token — and the reboot case runs in a child process
 * with no operator %APPDATA%/%USERPROFILE at all. Nothing on this machine is
 * registered, started or changed; every file lives under this run's temporary
 * data directory.
 *
 * Run with:  node e2e/run.mjs hub-agent-service-pm2
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { createFakePm2 } from './fixtures/fake-pm2/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n-- ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'agent-service', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, { timeoutMs = 3_000, everyMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(everyMs);
  }
  return false;
}

// ─── The contract's exact texts ──────────────────────────────────────────────

const UNKNOWN_MESSAGE = 'PM2 runs under the account that started it; the Easy DevOps service (NT SERVICE\\EasyDevOps) cannot see it.';
const UNKNOWN_FIX = 'Run ezz service repair in an Administrator PowerShell, signed in as the user who runs PM2, so the Hub can name that user. Manage the apps on the server meanwhile.';

const namedMessage = (user) => `PM2 runs under the user ${user}; the Easy DevOps service (NT SERVICE\\EasyDevOps) cannot see it.`;
const namedFix = (user) => `Manage these apps on the server as ${user} (the Easy DevOps dashboard there, or pm2 list). Hub process actions and Hub deploys need that PM2, so this server refuses them.`;

const SERVICE_ACCOUNT = Object.freeze({
  user: 'EasyDevOps',
  home: 'C:\\Windows\\ServiceProfiles\\EasyDevOps',
  serviceAccount: true,
});

const SERVICE_PM2_DEPS = Object.freeze({
  isWindows: true,
  serverMode: true,
  account: SERVICE_ACCOUNT,
});

const OPERATOR = Object.freeze({
  user: 'admin',
  home: 'C:\\Users\\admin',
  pm2Path: 'C:\\Users\\admin\\AppData\\Roaming\\npm\\pm2.cmd',
  recordedAt: new Date().toISOString(),
});

const operatorPm2Deps = ({ serverMode = true } = {}) => ({
  isWindows: true,
  serverMode,
  account: { user: 'admin', home: 'C:\\Users\\admin', serviceAccount: false },
  // The operator the Windows Server install recorded: pm2State names it.
  operator: OPERATOR,
});

const linuxRootPm2Deps = {
  isWindows: false,
  serverMode: true,
  account: { user: 'root', home: '/root', serviceAccount: false },
  // Linux has no recorded operator; a missing record is unknown, not false.
  operator: null,
};

// ─── Fake targets and fixtures ───────────────────────────────────────────────

/** A socket stand-in: records every event the agent emits. */
function createTarget() {
  const events = [];
  return {
    connected: true,
    events,
    emit(event, payload) { events.push({ event, payload }); },
    all(event) { return events.filter((e) => e.event === event).map((e) => e.payload); },
    last(event) { return this.all(event).at(-1) ?? null; },
  };
}

/** A shell `run` that must never be reached, recording any attempt. */
function noSpawnRun() {
  const calls = [];
  return {
    calls,
    run: async (command) => {
      calls.push(String(command));
      throw new Error(`a subprocess must not run here: ${command}`);
    },
  };
}

/** A service-shaped state, for the mapping checks that do not need Windows. */
function baseServiceState(overrides = {}) {
  return {
    installed: true,
    running: true,
    detail: null,
    mechanism: 'winsw',
    mode: 'server',
    startsAt: 'boot',
    stoppedByUser: false,
    jobsRunningHere: true,
    runningAsService: true,
    version: '1.4.9',
    dataDir: TEST_DATA_DIR,
    serverMode: true,
    startedAt: Date.now() - 60_000,
    pid: process.pid,
    ...overrides,
  };
}

/** A pm2State result, for the mapping checks. */
function basePm2State(overrides = {}) {
  return {
    state: 'available',
    reason: null,
    message: null,
    fix: null,
    user: null,
    version: null,
    ...overrides,
  };
}

/** The contract's 1.4.9 `pm2` object, in field order. */
function pm2Object({ state, reason = null, message = null, fix = null, user = null }) {
  return { state, reason, message, fix, user };
}

/**
 * A list for payload-shape checks that inject a pm2State: it must never reach
 * the real shell, and these payloads do not assert app contents.
 */
const noApps = async () => ({ ok: true, apps: [] });

const OLD_SERVICE_STATE_FIELDS = Object.freeze({
  installed: ['boolean', 'object'], // object === null
  running: ['boolean'],
  status: ['string', 'object'],
  mechanism: ['string', 'object'],
  mode: ['string', 'object'],
  startsAt: ['string', 'object'],
  stoppedByUser: ['boolean'],
  jobsRunningHere: ['boolean'],
  enabledOnBoot: ['boolean', 'object'],
  dev: ['boolean'],
  pm2Installed: ['boolean', 'object'],
  pm2Version: ['string', 'object'],
  uptimeMs: ['number', 'object'],
  versionDrift: ['object'],
});

/** @param {*} value @returns {string} `typeof`, with null kept distinct. */
function typeOf(value) {
  return value === null ? 'object' : typeof value;
}

// ─── 1. Service identity on Windows Server mode ─────────────────────────────

async function testServiceIdentity(agent, service, platform, db, lock) {
  setGroup('1. from inside the Windows service: the true service state, PM2 refused');

  if (!IS_WINDOWS) {
    for (const label of [
      'installed is true from inside the service',
      'runningAsService is true and startsAt is boot',
      'enabledOnBoot is true and mode is server',
      'runAs is NT SERVICE\\EasyDevOps',
      'pm2.state is unavailable with the exact texts (no operator)',
      'with a recorded operator the texts name that user',
      'pm2Installed is null, never false',
      'nothing spawned: zero pm2/npm subprocesses',
      'processes:list is sent on every cycle with a reason',
      'hub:manageProcess is refused before anything runs',
    ]) check(label, true, 'skipped: Windows only');
    return;
  }

  const previousProgramData = process.env.ProgramData;
  const programData = scratch('programdata-service');
  // programDataDir() is <ProgramData>/easy-devops; the marker lives there.
  fs.mkdirSync(path.join(programData, 'easy-devops'), { recursive: true });
  fs.writeFileSync(path.join(programData, 'easy-devops', '.server-mode'), '{}\n');
  process.env.ProgramData = programData;
  platform.resetDataDirCache();

  const acquired = lock.acquire({ dataDir: TEST_DATA_DIR, version: '1.4.9', mode: 'daemon' });
  const serviceDeps = {
    mechanism: { platform: 'windows', mode: 'server', mechanism: 'winsw', registered: null },
    account: SERVICE_ACCOUNT,
    runningUnderServiceManager: true,
  };
  const spawned = noSpawnRun();

  try {
    check('the lock this process holds is its own pid',
      acquired.ok === true && acquired.lock?.pid === process.pid,
      String(acquired.reason ?? `pid ${acquired.lock?.pid}`));

    // ── No operator recorded: the texts must not invent one ────────────────
    db.dbSet('service-state', {});
    const first = createTarget();
    await agent.pushServiceState({
      target: first,
      deps: {
        serviceDeps,
        account: SERVICE_ACCOUNT,
        pm2Deps: SERVICE_PM2_DEPS,
        run: spawned.run,
        checkDrift: () => null,
      },
    });
    const state = first.last('service:state');

    check('service:state is emitted', Boolean(state));
    check('installed is true from inside the service',
      state?.installed === true && state?.runningAsService === true,
      JSON.stringify({ installed: state?.installed, runningAsService: state?.runningAsService }));
    check('running stays true',
      state?.running === true,
      JSON.stringify({ running: state?.running }));
    check('startsAt is boot and enabledOnBoot is true',
      state?.startsAt === 'boot' && state?.enabledOnBoot === true,
      JSON.stringify({ startsAt: state?.startsAt, enabledOnBoot: state?.enabledOnBoot }));
    check('mode is server and mechanism is winsw',
      state?.mode === 'server' && state?.mechanism === 'winsw',
      `${state?.mode}/${state?.mechanism}`);
    check('serverMode is true', state?.serverMode === true, String(state?.serverMode));
    check('runAs is NT SERVICE\\EasyDevOps',
      state?.runAs === 'NT SERVICE\\EasyDevOps', String(state?.runAs));
    check('the version comes from the daemon lock', state?.version === '1.4.9', String(state?.version));
    check('the data directory is sent',
      typeof state?.dataDir === 'string' && state.dataDir.length > 0, String(state?.dataDir));
    check('pm2.state is unavailable with the unknown-account message',
      state?.pm2?.state === 'unavailable'
        && state?.pm2?.reason === 'service_account'
        && state?.pm2?.message === UNKNOWN_MESSAGE
        && state?.pm2?.fix === UNKNOWN_FIX
        && state?.pm2?.user === null,
      JSON.stringify(state?.pm2));
    check('pm2Installed is null (unknown), never false',
      state?.pm2Installed === null, String(state?.pm2Installed));
    check('versionDrift may be null', state?.versionDrift === null, String(state?.versionDrift));

    // ── With a recorded operator, the texts name that user ─────────────────
    db.dbSet('service-state', { operator: { ...OPERATOR } });
    const second = createTarget();
    await agent.pushServiceState({
      target: second,
      deps: {
        serviceDeps,
        account: SERVICE_ACCOUNT,
        pm2Deps: SERVICE_PM2_DEPS,
        run: spawned.run,
        checkDrift: () => null,
      },
    });
    const named = second.last('service:state');
    check('with a recorded operator the message names that user',
      named?.pm2?.message === namedMessage('admin'), String(named?.pm2?.message));
    check('and the fix names that user',
      named?.pm2?.fix === namedFix('admin'), String(named?.pm2?.fix));
    check('and pm2.user is that user', named?.pm2?.user === 'admin', String(named?.pm2?.user));
    check('pm2Installed is still null', named?.pm2Installed === null, String(named?.pm2Installed));
    check('installed stays true', named?.installed === true, String(named?.installed));

    // ── processes:list on every cycle, never skipped, never bare ───────────
    const cycles = createTarget();
    await agent.pushProcesses({ target: cycles, deps: { pm2Deps: SERVICE_PM2_DEPS, run: spawned.run } });
    await agent.pushProcesses({ target: cycles, deps: { pm2Deps: SERVICE_PM2_DEPS, run: spawned.run } });
    const lists = cycles.all('processes:list');
    check('processes:list is sent on EVERY cycle, not skipped', lists.length === 2, `${lists.length} payload(s)`);
    check('every payload says daemonRunning is unknown (null)',
      lists.every((p) => p?.daemonRunning === null),
      JSON.stringify(lists.map((p) => p?.daemonRunning)));
    check('every payload carries the pm2 reason, never a bare empty list',
      lists.every((p) => p?.pm2?.reason === 'service_account'
        && p?.pm2?.message === namedMessage('admin')
        && Array.isArray(p?.apps) && p.apps.length === 0),
      JSON.stringify(lists.at(-1)));

    // ── hub:manageProcess is refused before anything runs ─────────────────
    const hubPermissions = await import(srcUrl('core/hubLink.js'));
    hubPermissions.saveHubPermissions({ 'process.stop': true, 'process.restart': true });

    let untouched = 0;
    const refusingRunner = {
      pm2Access: () => ({ ok: false, reason: 'service_account', user: 'admin', message: namedMessage('admin'), fix: namedFix('admin') }),
      detect: async () => { untouched += 1; throw new Error('detect must not run for a service account'); },
      list: async () => { untouched += 1; throw new Error('list must not run for a service account'); },
      stop: async () => { untouched += 1; throw new Error('stop must not run for a service account'); },
      restart: async () => { untouched += 1; throw new Error('restart must not run for a service account'); },
      currentUser: () => 'EasyDevOps',
    };
    const refusalTarget = createTarget();
    await agent.handleManageProcess(
      { action: 'stop', name: 'some-app', requestId: 'req-refused-service' },
      null,
      { target: refusalTarget, runner: refusingRunner },
    );
    const refusal = refusalTarget.last('command:result');
    check('the Hub gets a command:result for the refusal', Boolean(refusal));
    check('it is not ok', refusal?.ok === false, String(refusal?.ok));
    check('the error is the contract message',
      refusal?.error === namedMessage('admin'), String(refusal?.error));
    check('data carries { ok, reason, message, fix, user }',
      refusal?.data?.ok === false
        && refusal?.data?.reason === 'service_account'
        && refusal?.data?.message === namedMessage('admin')
        && refusal?.data?.fix === namedFix('admin')
        && refusal?.data?.user === 'admin',
      JSON.stringify(refusal?.data));
    check('nothing was detected, listed, stopped or restarted',
      untouched === 0, `${untouched} call(s)`);

    check('nothing spawned a pm2 or npm subprocess at all',
      spawned.calls.length === 0, spawned.calls.slice(0, 3).join(' | '));
  } finally {
    lock.release({ dataDir: TEST_DATA_DIR });
    db.dbDelete('service-state');
    if (previousProgramData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = previousProgramData;
    platform.resetDataDirCache();
  }
}

// ─── 2. The operator, Linux root, and every PM2 state ────────────────────────

async function testOperatorAndStates(agent, runner) {
  setGroup('2. operator and Linux root: every PM2 state in processes:list');

  const dir = scratch('operator');
  const stateFile = path.join(dir, 'pm2-state.json');

  /** One cycle at the agent level, with the user's own standard PM2. */
  const cycle = async ({ fake, pm2Deps, isRunning = true }) => {
    const target = createTarget();
    fake.clearCalls();
    await agent.pushProcesses({
      target,
      deps: {
        pm2Deps: { ...pm2Deps, isRunning: () => isRunning },
        // The fake's `run`; readPm2 wraps it to keep the one `jlist`.
        run: fake.run,
      },
    });
    return { payload: target.last('processes:list'), calls: [...fake.calls] };
  };

  // ── available ─────────────────────────────────────────────────────────────
  const available = createFakePm2({ stateFile, apps: ['one', 'two'] });
  const avail = await cycle({ fake: available, pm2Deps: operatorPm2Deps() });
  check('available: daemonRunning is true and the apps are sent',
    avail.payload?.daemonRunning === true
      && avail.payload?.apps?.length === 2
      && avail.payload.apps.map((a) => a.name).join(',') === 'one,two',
    JSON.stringify({ daemonRunning: avail.payload?.daemonRunning, apps: avail.payload?.apps?.map((a) => a.name) }));
  check('available: the pm2 object is the contract shape',
    JSON.stringify(avail.payload?.pm2) === JSON.stringify(pm2Object({ state: 'available', user: 'admin' })),
    JSON.stringify(avail.payload?.pm2));
  const jlists = avail.calls.filter((c) => /\sjlist$/i.test(c)).length;
  check('available: exactly ONE jlist per cycle (no double list)', jlists === 1, `${jlists} jlist call(s)`);
  check('available: the version is never probed (that would start a daemon)',
    !avail.calls.some((c) => /--version$/.test(c)), avail.calls.join(' | '));

  // ── empty ─────────────────────────────────────────────────────────────────
  const empty = createFakePm2({ stateFile: path.join(dir, 'empty.json'), apps: [] });
  const emptyCycle = await cycle({ fake: empty, pm2Deps: operatorPm2Deps() });
  check('empty: daemonRunning is true and the app list is empty',
    emptyCycle.payload?.daemonRunning === true && emptyCycle.payload?.apps?.length === 0,
    JSON.stringify(emptyCycle.payload?.apps));
  check('empty: the state is empty with no message',
    emptyCycle.payload?.pm2?.state === 'empty'
      && emptyCycle.payload?.pm2?.message === null
      && emptyCycle.payload?.pm2?.fix === null,
    JSON.stringify(emptyCycle.payload?.pm2));

  // ── not_running: the pid file says no, so nothing is started ─────────────
  const notRunning = createFakePm2({ stateFile: path.join(dir, 'not-running.json'), apps: [] });
  const notRunningCycle = await cycle({ fake: notRunning, pm2Deps: operatorPm2Deps(), isRunning: false });
  check('not_running: daemonRunning is false with the exact message and fix',
    notRunningCycle.payload?.daemonRunning === false
      && notRunningCycle.payload?.apps?.length === 0
      && notRunningCycle.payload?.pm2?.state === 'not_running'
      && notRunningCycle.payload?.pm2?.message === 'PM2 is installed but its daemon is not running.'
      && notRunningCycle.payload?.pm2?.fix === 'Start an app with PM2, or run pm2 resurrect.',
    JSON.stringify(notRunningCycle.payload?.pm2));
  check('not_running: no daemon was started (no jlist, no --version)',
    !notRunningCycle.calls.some((c) => /\sjlist$|--version$/.test(c)),
    notRunningCycle.calls.join(' | '));

  // ── not_installed ─────────────────────────────────────────────────────────
  const missing = createFakePm2({ stateFile: path.join(dir, 'missing.json'), installed: false });
  const missingCycle = await cycle({ fake: missing, pm2Deps: operatorPm2Deps(), isRunning: false });
  check('not_installed: daemonRunning is false with the exact message and fix',
    missingCycle.payload?.daemonRunning === false
      && missingCycle.payload?.apps?.length === 0
      && missingCycle.payload?.pm2?.state === 'not_installed'
      && missingCycle.payload?.pm2?.message === 'PM2 is not installed.'
      && missingCycle.payload?.pm2?.fix === 'Run npm i -g pm2 on the server.',
    JSON.stringify(missingCycle.payload?.pm2));

  // ── list_failed ───────────────────────────────────────────────────────────
  const failing = createFakePm2({
    stateFile: path.join(dir, 'failing.json'),
    failJlist: 'connect EACCES \\\\.\\pipe\\rpc.sock',
  });
  const failedCycle = await cycle({ fake: failing, pm2Deps: operatorPm2Deps() });
  check('list_failed: daemonRunning is null with the exact message and fix',
    failedCycle.payload?.daemonRunning === null
      && failedCycle.payload?.apps?.length === 0
      && failedCycle.payload?.pm2?.state === 'unavailable'
      && failedCycle.payload?.pm2?.reason === 'list_failed'
      && failedCycle.payload?.pm2?.message === 'PM2 did not answer: connect EACCES \\\\.\\pipe\\rpc.sock'
      && failedCycle.payload?.pm2?.fix === 'Run pm2 list on the server.',
    JSON.stringify(failedCycle.payload?.pm2));

  // ── Linux root: unchanged, the same PM2 as the daemon ────────────────────
  const linux = createFakePm2({ stateFile: path.join(dir, 'linux.json'), apps: ['linux-app'] });
  const linuxCycle = await cycle({ fake: linux, pm2Deps: linuxRootPm2Deps });
  check('Linux root: available with its apps, exactly as before',
    linuxCycle.payload?.daemonRunning === true
      && linuxCycle.payload?.apps?.length === 1
      && linuxCycle.payload?.apps[0]?.name === 'linux-app'
      && linuxCycle.payload?.pm2?.state === 'available',
    JSON.stringify(linuxCycle.payload?.pm2));

  // ── service:state reports pm2Installed true for a visible PM2 ────────────
  const target = createTarget();
  await agent.pushServiceState({
    target,
    deps: {
      serviceState: () => baseServiceState({
        mode: 'personal',
        mechanism: 'startup-supervisor',
        startsAt: 'logon',
        runningAsService: false,
        serverMode: false,
      }),
      account: { user: 'admin', home: 'C:\\Users\\admin', serviceAccount: false },
      pm2Deps: operatorPm2Deps({ serverMode: false }),
      run: available.run,
      checkDrift: () => ({ drift: false, cliVersion: '1.4.9', serviceVersion: '1.4.9', mode: 'personal', reason: null, message: null }),
    },
  });
  const state = target.last('service:state');
  check('a visible PM2 makes pm2Installed true',
    state?.pm2Installed === true && state?.pm2?.state === 'available',
    JSON.stringify({ pm2Installed: state?.pm2Installed, state: state?.pm2?.state }));
  check('Windows Personal runAs is the OS user',
    state?.runAs === 'admin', String(state?.runAs));
  check('enabledOnBoot follows startsAt (logon is not boot)',
    state?.enabledOnBoot === false, String(state?.enabledOnBoot));

  // ── after a process action the list is pushed again ──────────────────────
  const permissions = await import(srcUrl('core/hubLink.js'));
  permissions.saveHubPermissions({ 'process.restart': true });

  const acting = createFakePm2({ stateFile: path.join(dir, 'acting.json'), apps: ['shared-app'] });
  const actingDeps = operatorPm2Deps();
  // Self-contained: every call, including the push after the action, goes
  // through this fake and never the real shell.
  const actingRunner = {
    pm2Access: () => runner.pm2Access({ deps: actingDeps }),
    pm2State: async () => runner.pm2State({ deps: { ...actingDeps, isRunning: () => true, run: acting.run } }),
    detect: async () => runner.detect({ run: acting.run, deps: actingDeps }),
    list: async (opts = {}) => runner.list({
      run: acting.run,
      pm2Path: opts.pm2Path ?? 'pm2',
      deps: actingDeps,
    }),
    restart: async (name, opts = {}) => runner.restart(name, {
      run: acting.run,
      pm2Path: opts.pm2Path ?? 'pm2',
      deps: actingDeps,
    }),
    stop: async (name, opts = {}) => runner.stop(name, {
      run: acting.run,
      pm2Path: opts.pm2Path ?? 'pm2',
      deps: actingDeps,
    }),
    currentUser: () => 'admin',
  };
  const actionTarget = createTarget();
  await agent.handleManageProcess(
    { action: 'restart', name: 'shared-app', requestId: 'req-restart-ok' },
    null,
    { target: actionTarget, runner: actingRunner },
  );
  const result = actionTarget.last('command:result');
  const pushedAfter = await waitUntil(() => actionTarget.all('processes:list').length > 0);
  const pushed = actionTarget.all('processes:list');
  check('the operator action succeeds',
    result?.ok === true && result?.data?.name === 'shared-app',
    JSON.stringify(result));
  check('after a process action processes:list is pushed again',
    pushedAfter && pushed[0]?.apps?.some((a) => a.name === 'shared-app'),
    JSON.stringify(pushed.map((p) => p?.apps?.map((a) => a.name))));
  permissions.saveHubPermissions({});
}

// ─── 3. Reboot simulation, in a fresh process ───────────────────────────────

/**
 * The child: a brand-new agent process on a Windows Server in Server mode.
 *
 * No lock is taken (so this is not `runningAsService`), `primeServiceFacts()`
 * is never called (the daemon never calls it either), and there is no operator
 * %APPDATA%/%USERPROFILE. The WinSW wrapper and definition are the only
 * evidence, exactly as after a reboot with nobody signed in.
 */
const REBOOT_CHILD = `
import path from 'path';
import { pathToFileURL } from 'url';

const src = (rel) => pathToFileURL(path.join(process.env.EZ_SRC_ROOT, 'src', rel)).href;
const platform = await import(src('core/platform.js'));
const service = await import(src('core/service/index.js'));
const db = await import(src('core/db.js'));
const agent = await import(src('core/hub/agent.js'));

db.dbSet('service-state', {
  mode: 'server',
  operator: {
    user: 'admin',
    home: 'C:\\\\Users\\\\admin',
    pm2Path: 'C:\\\\Users\\\\admin\\\\AppData\\\\Roaming\\\\npm\\\\pm2.cmd',
    recordedAt: new Date().toISOString(),
  },
});

// The facts a fresh daemon process has: no live registration was ever probed.
const registeredBefore = service.resolveMechanism().registered;

const servicePm2 = {
  isWindows: true,
  serverMode: true,
  account: {
    user: 'EasyDevOps',
    home: 'C:\\\\Windows\\\\ServiceProfiles\\\\EasyDevOps',
    serviceAccount: true,
  },
};

const events = [];
const target = { connected: true, emit: (event, payload) => events.push({ event, payload }) };
let spawned = 0;
const runShell = async (command) => {
  spawned += 1;
  throw new Error('a subprocess must not run: ' + command);
};

await agent.pushServiceState({
  target,
  deps: {
    account: servicePm2.account,
    pm2Deps: servicePm2,
    run: runShell,
    checkDrift: () => null,
  },
});
await agent.pushProcesses({ target, deps: { pm2Deps: servicePm2, run: runShell } });

process.stdout.write(JSON.stringify({
  spawned,
  registeredBefore,
  operatorEnv: {
    APPDATA: process.env.APPDATA ?? null,
    USERPROFILE: process.env.USERPROFILE ?? null,
  },
  dataDir: platform.getDataDir(),
  state: events.find((e) => e.event === 'service:state')?.payload ?? null,
  processes: events.find((e) => e.event === 'processes:list')?.payload ?? null,
}) + '\\n');
`;

function runRebootChild({ programData, dataDir }) {
  const file = path.join(scratch('child'), 'reboot-agent.mjs');
  assertInsideTestDataDir(file, 'write the reboot fixture');
  fs.writeFileSync(file, REBOOT_CHILD, 'utf8');

  const env = { ...process.env };
  // No per-user profile of the operator reaches this process: that is the shape
  // of a process the Windows service manager started.
  delete env.APPDATA;
  delete env.LOCALAPPDATA;
  delete env.USERPROFILE;
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  if (!IS_WINDOWS) delete env.HOME;
  if (IS_WINDOWS) env.USERPROFILE = path.join(programData, 'ServiceProfiles', 'EasyDevOps');

  env.EZ_TEST = '1';
  env.ProgramData = programData;
  env.EASY_DEVOPS_DATA_DIR = dataDir;
  env.EZ_SRC_ROOT = ROOT;

  const run = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  const line = String(run.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { parsed = null; }
  return { status: run.status, stderr: String(run.stderr ?? ''), parsed };
}

async function testRebootSimulation() {
  setGroup('3. a reboot: a fresh process still knows the service is installed');

  if (!IS_WINDOWS) {
    for (const label of [
      'installed is true from the WinSW files alone',
      'runningAsService is false, and installed is never false',
      'PM2 is unavailable with the reason, pm2Installed is null',
      'processes:list has a reason and daemonRunning null',
      'nothing was spawned',
    ]) check(label, true, 'skipped: Windows only');
    return;
  }

  const programData = scratch('programdata-reboot');
  const dataDir = path.join(programData, 'easy-devops');
  assertInsideTestDataDir(dataDir, 'create the simulated Server-mode data directory');
  fs.mkdirSync(path.join(dataDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.server-mode'), '{}\n');
  fs.writeFileSync(path.join(dataDir, 'bin', 'EasyDevOps.exe'), 'MZ::test fixture\n');
  fs.writeFileSync(path.join(dataDir, 'bin', 'EasyDevOps.xml'), '<service/>\n');
  fs.writeFileSync(path.join(dataDir, 'easy-devops.sqlite'), '');

  const child = runRebootChild({ programData, dataDir });
  const state = child.parsed?.state ?? {};
  const processes = child.parsed?.processes ?? {};

  check('the child ran the agent code to completion',
    child.status === 0 && Boolean(child.parsed), child.stderr.split('\n')[0] ?? '');
  check('it really had no operator profile to read',
    child.parsed?.operatorEnv?.APPDATA === null
      && String(child.parsed?.operatorEnv?.USERPROFILE ?? '').toLowerCase()
        .includes('serviceprofiles'),
    JSON.stringify(child.parsed?.operatorEnv));
  check('a fresh process has no primed registration facts',
    child.parsed?.registeredBefore === null, String(child.parsed?.registeredBefore));
  check('installed is true from the WinSW files alone',
    state.installed === true, String(state.installed));
  check('installed is NEVER false here', state.installed !== false, String(state.installed));
  check('runningAsService is false for this process',
    state.runningAsService === false, String(state.runningAsService));
  check('startsAt is boot and enabledOnBoot is true',
    state.startsAt === 'boot' && state.enabledOnBoot === true,
    `${state.startsAt}/${state.enabledOnBoot}`);
  check('mode is server', state.mode === 'server', String(state.mode));
  check('PM2 is unavailable naming the recorded operator',
    state.pm2?.state === 'unavailable'
      && state.pm2?.reason === 'service_account'
      && state.pm2?.message === namedMessage('admin')
      && state.pm2?.user === 'admin',
    JSON.stringify(state.pm2));
  check('pm2Installed is null, never false',
    state.pm2Installed === null, String(state.pm2Installed));
  check('processes:list has daemonRunning null and the reason',
    processes.daemonRunning === null
      && processes.pm2?.reason === 'service_account'
      && processes.pm2?.message === namedMessage('admin'),
    JSON.stringify({ daemonRunning: processes.daemonRunning, pm2: processes.pm2 }));
  check('the app list is never empty without a reason',
    !(Array.isArray(processes.apps) && processes.apps.length === 0 && !processes.pm2?.reason),
    JSON.stringify(processes.apps));
  check('nothing was spawned: no pm2, no npm, no sc.exe from the agent',
    child.parsed?.spawned === 0, String(child.parsed?.spawned));
}

// ─── 4. Old-Hub compatibility ───────────────────────────────────────────────

async function testOldHubCompatibility(agent) {
  setGroup('4. old Hubs: every pre-1.4.9 field is still there, same type');

  const target = createTarget();
  await agent.pushServiceState({
    target,
    deps: {
      serviceState: () => baseServiceState({ installed: true, startsAt: 'boot', startedAt: Date.now() - 1234 }),
      account: { user: 'admin', home: 'C:\\Users\\admin', serviceAccount: false },
      pm2State: async () => basePm2State({ state: 'not_running', reason: 'not_running', message: 'm', fix: 'f' }),
      list: noApps,
      checkDrift: () => ({ drift: false, cliVersion: '1.4.9', serviceVersion: '1.4.9', mode: 'server', reason: null, message: null }),
      dev: false,
    },
  });
  const state = target.last('service:state') ?? {};

  const problems = [];
  for (const [field, types] of Object.entries(OLD_SERVICE_STATE_FIELDS)) {
    if (!(field in state)) { problems.push(`${field} is missing`); continue; }
    if (!types.includes(typeOf(state[field]))) {
      problems.push(`${field} is ${typeOf(state[field])}, expected ${types.join('|')}`);
    }
  }
  check('every pre-1.4.9 service:state field is present with its old type',
    problems.length === 0, problems.join('; '));
  check('enabledOnBoot is true for installed + startsAt boot',
    state.enabledOnBoot === true, String(state.enabledOnBoot));
  check('pm2Installed is true for not_running (PM2 is installed)',
    state.pm2Installed === true, String(state.pm2Installed));
  check('uptimeMs still comes from the lock start time',
    typeof state.uptimeMs === 'number' && state.uptimeMs >= 1234, String(state.uptimeMs));
  check('status still carries the state detail', state.status === null, String(state.status));
  check('versionDrift is the drift object, unchanged',
    state.versionDrift?.drift === false && state.versionDrift?.cliVersion === '1.4.9',
    JSON.stringify(state.versionDrift));

  // ── enabledOnBoot = installed===true ? startsAt==='boot' : (false ? false : null)
  const cases = [
    { label: 'installed true + boot', state: { installed: true, startsAt: 'boot' }, expected: true },
    { label: 'installed true + logon', state: { installed: true, startsAt: 'logon' }, expected: false },
    { label: 'installed false', state: { installed: false, startsAt: 'boot' }, expected: false },
    { label: 'installed unknown (null)', state: { installed: null, startsAt: 'boot' }, expected: null },
    {
      label: 'runningAsService true forces installed true',
      state: { installed: false, runningAsService: true, startsAt: 'boot' },
      expected: true,
      installed: true,
    },
  ];
  for (const testCase of cases) {
    const caseTarget = createTarget();
    await agent.pushServiceState({
      target: caseTarget,
      deps: {
        serviceState: () => baseServiceState({ runningAsService: false, ...testCase.state }),
        account: { user: 'admin', home: 'C:\\Users\\admin', serviceAccount: false },
        pm2State: async () => basePm2State({ state: 'empty' }),
        list: noApps,
        checkDrift: () => null,
        dev: false,
      },
    });
    const payload = caseTarget.last('service:state') ?? {};
    check(`enabledOnBoot: ${testCase.label}`,
      payload.enabledOnBoot === testCase.expected,
      String(payload.enabledOnBoot));
    if (testCase.installed !== undefined) {
      check(`installed: ${testCase.label}`,
        payload.installed === testCase.installed, String(payload.installed));
    }
  }

  // ── unknown stays unknown, and a throwing probe is not a failure ─────────
  const nullTarget = createTarget();
  await agent.pushServiceState({
    target: nullTarget,
    deps: {
      serviceState: () => baseServiceState({ installed: null, runningAsService: false, startsAt: null }),
      account: { user: 'admin', home: 'C:\\Users\\admin', serviceAccount: false },
      pm2State: async () => basePm2State({
        state: 'unavailable', reason: 'list_failed', message: 'PM2 did not answer: boom', fix: 'Run pm2 list on the server.',
      }),
      list: noApps,
      checkDrift: () => { throw new Error('drift probe failed'); },
      dev: false,
    },
  });
  const unknown = nullTarget.last('service:state') ?? {};
  check('an unreadable service state stays unknown, never false',
    unknown.installed === null && unknown.enabledOnBoot === null,
    JSON.stringify({ installed: unknown.installed, enabledOnBoot: unknown.enabledOnBoot }));
  check('an unavailable PM2 makes pm2Installed null',
    unknown.pm2Installed === null, String(unknown.pm2Installed));
  check('a failing drift probe becomes null, not a lost payload',
    unknown.versionDrift === null, String(unknown.versionDrift));
  check('the payload still carries the 1.4.9 fields',
    typeof unknown.runningAsService === 'boolean'
      && 'version' in unknown
      && 'dataDir' in unknown
      && typeof unknown.serverMode === 'boolean'
      && 'runAs' in unknown
      && typeof unknown.pm2?.state === 'string',
    JSON.stringify({ pm2: unknown.pm2, runAs: unknown.runAs }));

  // ── a push never waits for a dead socket ─────────────────────────────────
  const down = { connected: false, emit: () => { throw new Error('must not emit'); } };
  let threw = false;
  try {
    await agent.pushServiceState({
      target: down,
      deps: { serviceState: () => baseServiceState(), pm2State: async () => basePm2State({}) },
    });
    await agent.pushProcesses({ target: down, deps: { pm2State: async () => basePm2State({}) } });
  } catch { threw = true; }
  check('a disconnected socket is skipped quietly', threw === false);

  // ── a PM2 failure does not take the service state with it ────────────────
  const broken = createTarget();
  await agent.pushServiceState({
    target: broken,
    deps: {
      serviceState: () => baseServiceState({ runAs: 'admin' }),
      account: { user: 'admin', home: 'C:\\Users\\admin', serviceAccount: false },
      pm2State: async () => { throw new Error('spawn EPERM'); },
      checkDrift: () => null,
      dev: false,
    },
  });
  const survived = broken.last('service:state');
  check('a PM2 read that fails still sends service:state, with the reason',
    survived?.installed === true
      && survived?.pm2?.reason === 'list_failed'
      && survived?.pm2?.message === 'PM2 did not answer: spawn EPERM'
      && survived?.pm2Installed === null,
    JSON.stringify({ installed: survived?.installed, pm2: survived?.pm2 }));

  const brokenProcesses = createTarget();
  await agent.pushProcesses({
    target: brokenProcesses,
    deps: { pm2State: async () => { throw new Error('spawn EPERM'); } },
  });
  const failedList = brokenProcesses.last('processes:list');
  check('a failing PM2 read still sends processes:list with a reason',
    failedList?.daemonRunning === null
      && failedList?.pm2?.reason === 'list_failed'
      && Array.isArray(failedList?.apps),
    JSON.stringify(failedList));
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nHub agent: the service and PM2 the Hub is shown\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  const agent = await import(srcUrl('core/hub/agent.js'));
  const runner = await import(srcUrl('core/runner.js'));
  const service = await import(srcUrl('core/service/index.js'));
  const platform = await import(srcUrl('core/platform.js'));
  const db = await import(srcUrl('core/db.js'));
  const lock = await import(srcUrl('core/daemon/lock.js'));

  const previousProgramData = process.env.ProgramData;
  const previousUserProfile = process.env.USERPROFILE;

  try {
    await testServiceIdentity(agent, service, platform, db, lock);
    await testOperatorAndStates(agent, runner);
    await testRebootSimulation();
    await testOldHubCompatibility(agent);
  } finally {
    if (previousProgramData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = previousProgramData;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    platform.resetDataDirCache();
    try { db.dbDelete('service-state'); } catch { /* already gone */ }
  }

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failed) {
      process.stdout.write(`  [${failure.group}] ${failure.label}${failure.detail ? ` — ${failure.detail}` : ''}\n`);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error) + '\n');
  process.exit(1);
});
