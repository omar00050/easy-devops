/**
 * PM2 access on a Windows Server service account.
 *
 * The rule this suite holds runner to: a process running as
 * `NT SERVICE\EasyDevOps` on a Windows Server in Server mode must spawn
 * NOTHING — no `where.exe`, no pm2, no npm — and must not read another user's
 * profile. It reports `unavailable` with the exact reason instead. Everywhere
 * else (Linux, Windows Personal, the operator's own CLI/dashboard on a Server)
 * the old behaviour is unchanged.
 *
 * Identity, Server mode, the PM2 daemon check and `run` are all injected, so
 * this suite never starts a real PM2 daemon, never reads the real PM2_HOME and
 * never touches the real data directory.
 *
 * Run with: node e2e/run.mjs pm2-access
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createFakePm2 } from './fixtures/fake-pm2/index.mjs';

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

// ─── The contract's exact texts ──────────────────────────────────────────────

const UNKNOWN_MESSAGE = 'PM2 runs under the account that started it; the Easy DevOps service (NT SERVICE\\EasyDevOps) cannot see it.';
const UNKNOWN_FIX = 'Run ezz service repair in an Administrator PowerShell, signed in as the user who runs PM2, so the Hub can name that user. Manage the apps on the server meanwhile.';

const namedMessage = (user) => `PM2 runs under the user ${user}; the Easy DevOps service (NT SERVICE\\EasyDevOps) cannot see it.`;
const namedFix = (user) => `Manage these apps on the server as ${user} (the Easy DevOps dashboard there, or pm2 list). Hub process actions and Hub deploys need that PM2, so this server refuses them.`;

const SERVICE_DEPS = Object.freeze({
  isWindows: true,
  serverMode: true,
  account: Object.freeze({
    user: 'EasyDevOps',
    home: 'C:\\Windows\\ServiceProfiles\\EasyDevOps',
    serviceAccount: true,
  }),
});

const OPERATOR = Object.freeze({
  user: 'admin',
  home: 'C:\\Users\\admin',
  pm2Path: 'C:\\Users\\admin\\AppData\\Roaming\\npm\\pm2.cmd',
  recordedAt: new Date().toISOString(),
});

const operatorDeps = (serverMode = true) => ({
  isWindows: true,
  serverMode,
  account: { user: 'admin', home: 'C:\\Users\\admin', serviceAccount: false },
});

/** Checks every field of a refused result against the contract. */
function checkRefused(label, result, expected) {
  const problems = [];
  if (result?.unavailable !== true) problems.push('unavailable is not true');
  if (result?.reason !== 'service_account') problems.push(`reason=${String(result?.reason)}`);
  if (result?.message !== expected.message) problems.push('message differs');
  if (result?.fix !== expected.fix) problems.push('fix differs');
  if ((result?.user ?? null) !== (expected.user ?? null)) problems.push(`user=${String(result?.user)}`);
  check(label, problems.length === 0, problems.join('; '));
}

/**
 * Every runner export that would spawn pm2 or npm. Each is called with the
 * service identity and a `run` that records; none may reach it.
 */
function spawningCalls(runner, run, deps) {
  return {
    detect: () => runner.detect({ run, deps }),
    list: () => runner.list({ run, deps }),
    start: () => runner.start({ script: 'C:\\apps\\server.js', name: 'demo', run, deps }),
    startConfig: () => runner.startConfig('C:\\apps\\ecosystem.json', { run, deps }),
    stop: () => runner.stop('demo', { run, deps }),
    restart: () => runner.restart('demo', { run, deps }),
    reload: () => runner.reload('demo', { run, deps }),
    reloadConfig: () => runner.reloadConfig('C:\\apps\\ecosystem.json', { run, deps }),
    del: () => runner.del('demo', { run, deps }),
    logs: () => runner.logs('demo', { run, deps }),
    save: () => runner.save({ run, deps }),
    startup: () => runner.startup({ run, deps }),
    unstartup: () => runner.unstartup({ run, deps }),
    install: () => runner.install({ run, deps }),
    status: () => runner.status('demo', {
      run,
      deps,
      // Must never be reached: if it is, the access check came too late.
      isRunning: () => { throw new Error('isRunning must not run for a service account'); },
    }),
    statusAll: () => runner.statusAll('demo', {
      run,
      deps,
      isRunning: () => { throw new Error('isRunning must not run for a service account'); },
    }),
  };
}

async function checkAllRefused(runner, labelPrefix, expected) {
  const fake = createFakePm2({ apps: [] });
  const calls = spawningCalls(runner, fake.run, SERVICE_DEPS);
  for (const [name, call] of Object.entries(calls)) {
    let result;
    try {
      result = await call();
    } catch (err) {
      check(`${labelPrefix}: ${name} returns instead of throwing`, false, err.message);
      continue;
    }
    checkRefused(`${labelPrefix}: ${name} refuses with the exact text`, result, expected);
  }

  check(`${labelPrefix}: nothing was spawned`, fake.calls.length === 0,
    fake.calls.slice(0, 3).join(' | '));
  check(`${labelPrefix}: isDaemonRunning is false without a profile read`,
    runner.isDaemonRunning({ deps: SERVICE_DEPS }) === false);

  const state = await runner.pm2State({
    deps: { ...SERVICE_DEPS, run: fake.run, isRunning: () => { throw new Error('must not run'); } },
  });
  check(`${labelPrefix}: pm2State says unavailable with the exact text`,
    state.state === 'unavailable'
      && state.reason === 'service_account'
      && state.message === expected.message
      && state.fix === expected.fix
      && state.user === (expected.user ?? null),
    JSON.stringify({ state: state.state, reason: state.reason, user: state.user }));
}

// ─── 1. Service account: nothing spawns, exact texts ─────────────────────────

async function testServiceAccount(runner, db) {
  setGroup('1. the service account on Windows Server mode spawns nothing');

  const access = runner.pm2Access({ deps: SERVICE_DEPS });
  check('pm2Access refuses', access.ok === false && access.reason === 'service_account');
  check('with no recorded operator the message is the unknown-account one',
    access.message === UNKNOWN_MESSAGE, access.message);
  check('with no recorded operator the fix names ezz service repair',
    access.fix === UNKNOWN_FIX, access.fix);
  check('and the user is null', access.user === null, String(access.user));

  db.dbSet('service-state', {});
  await checkAllRefused(runner, 'no operator', {
    message: UNKNOWN_MESSAGE, fix: UNKNOWN_FIX, user: null,
  });

  db.dbSet('service-state', {
    operator: { ...OPERATOR, recordedAt: new Date().toISOString() },
  });

  const named = runner.pm2Access({ deps: SERVICE_DEPS });
  check('pm2Access names the recorded operator when there is one',
    named.ok === false && named.user === 'admin', String(named.user));
  check('and uses the exact message naming that user',
    named.message === namedMessage('admin'), named.message);
  check('and the exact fix naming that user',
    named.fix === namedFix('admin'), named.fix);

  await checkAllRefused(runner, 'operator recorded', {
    message: namedMessage('admin'), fix: namedFix('admin'), user: 'admin',
  });

  // The refusal is only for the service account. The operator on the same
  // Windows Server keeps today's PM2 (covered in group 2).
  check('the same identity without Server mode is allowed',
    runner.pm2Access({ deps: operatorDeps(false) }).ok === true);
}

// ─── 2. The operator on Windows Server: the standard PM2, as today ───────────

async function testOperator(runner) {
  setGroup('2. the operator on Windows Server mode still runs the standard PM2');

  const stateFile = path.join(scratch('operator'), 'pm2-state.json');
  const dashboard = createFakePm2({ stateFile, apps: [] });
  const cli = createFakePm2({ stateFile, apps: [] });
  const deps = operatorDeps(true);

  check('pm2Access allows the operator', runner.pm2Access({ deps }).ok === true);

  const detected = await runner.detect({ run: dashboard.run, deps });
  check('detect finds PM2 through where.exe',
    detected.installed === true && detected.version === '6.0.14',
    `${detected.installed}/${detected.version}`);

  const empty = await runner.list({ run: dashboard.run, deps });
  check('the list starts empty', empty.ok === true && empty.apps.length === 0);

  const started = await runner.start({
    script: 'C:\\apps\\server.js', name: 'shared-app', run: dashboard.run, deps,
  });
  check('start runs the fake pm2', started.ok === true, started.output);

  // A second caller — the CLI — reads the same on-disk PM2 list.
  const fromCli = await runner.list({ run: cli.run, deps });
  check('the CLI sees the app the dashboard started',
    fromCli.ok === true && fromCli.apps.some((a) => a.name === 'shared-app'),
    fromCli.apps.map((a) => a.name).join(','));

  const stopped = await runner.stop('shared-app', { run: cli.run, deps });
  const afterStop = await runner.list({ run: dashboard.run, deps });
  check('stop is visible to the other caller',
    stopped.ok === true
      && afterStop.apps.find((a) => a.name === 'shared-app')?.status === 'stopped',
    afterStop.apps.find((a) => a.name === 'shared-app')?.status);

  const restarted = await runner.restart('shared-app', { run: dashboard.run, deps });
  const afterRestart = await runner.list({ run: cli.run, deps });
  check('restart is visible to the other caller',
    restarted.ok === true
      && afterRestart.apps.find((a) => a.name === 'shared-app')?.status === 'online');

  const removed = await runner.del('shared-app', { run: cli.run, deps });
  const afterDelete = await runner.list({ run: dashboard.run, deps });
  check('delete is visible to the other caller',
    removed.ok === true && afterDelete.apps.length === 0);

  // status() reads through the same fake, with the daemon check injected.
  const status = await runner.status('never-there', {
    run: dashboard.run, deps, isRunning: () => true,
  });
  check('status reads the list without a real daemon',
    status.ok === true && status.app === null, String(status.error));
}

// ─── 3. Linux root and Windows Personal: unchanged ───────────────────────────

async function testUnchanged(runner) {
  setGroup('3. Linux root and Windows Personal behave exactly as before');

  const linuxRoot = {
    isWindows: false,
    serverMode: true,
    account: { user: 'root', home: '/root', serviceAccount: false },
  };
  check('Linux root under Server mode is allowed',
    runner.pm2Access({ deps: linuxRoot }).ok === true);

  const fakeLinux = createFakePm2({ apps: ['linux-app'] });
  const listed = await runner.list({ run: fakeLinux.run, deps: linuxRoot });
  check('Linux root lists through pm2', listed.ok === true && listed.apps.length === 1);

  const personal = operatorDeps(false);
  check('Windows Personal mode (no Server marker) is allowed',
    runner.pm2Access({ deps: personal }).ok === true);

  const fakePersonal = createFakePm2({ apps: ['personal-app'] });
  const started = await runner.start({
    script: 'C:\\apps\\personal.js', name: 'personal-app-2', run: fakePersonal.run, deps: personal,
  });
  const personalList = await runner.list({ run: fakePersonal.run, deps: personal });
  check('Windows Personal still starts and lists',
    started.ok === true && personalList.apps.some((a) => a.name === 'personal-app-2'));

  check('a normal account is not the service account',
    runner.pm2Access({ deps: personal }).ok === true);
}

// ─── 4. pm2State: every state, never starting a daemon ──────────────────────

async function testPm2State(runner, db) {
  setGroup('4. pm2State covers every state without starting a daemon');

  db.dbSet('service-state', {});
  const deps = operatorDeps(true);

  const available = createFakePm2({ apps: ['one', 'two'] });
  const availableState = await runner.pm2State({
    deps: { ...deps, run: available.run, isRunning: () => true },
  });
  check('available: daemon up with apps',
    availableState.state === 'available'
      && availableState.reason === null
      && availableState.message === null
      && availableState.fix === null,
    availableState.state);

  const empty = createFakePm2({ apps: [] });
  const emptyState = await runner.pm2State({
    deps: { ...deps, run: empty.run, isRunning: () => true },
  });
  check('empty: daemon up with no apps',
    emptyState.state === 'empty' && emptyState.message === null && emptyState.fix === null,
    emptyState.state);

  const notRunning = createFakePm2({ apps: [] });
  const notRunningState = await runner.pm2State({
    deps: { ...deps, run: notRunning.run, isRunning: () => false },
  });
  check('not_running: installed but the daemon is down',
    notRunningState.state === 'not_running'
      && notRunningState.message === 'PM2 is installed but its daemon is not running.'
      && notRunningState.fix === 'Start an app with PM2, or run pm2 resurrect.',
    notRunningState.state);
  check('not_running never asks PM2 for a version or a list',
    !notRunning.calls.some((c) => /--version|\sjlist$/i.test(c)),
    notRunning.calls.join(' | '));

  const missing = createFakePm2({ installed: false });
  const missingState = await runner.pm2State({
    deps: { ...deps, run: missing.run, isRunning: () => false },
  });
  check('not_installed: where.exe finds nothing',
    missingState.state === 'not_installed'
      && missingState.message === 'PM2 is not installed.'
      && missingState.fix === 'Run npm i -g pm2 on the server.',
    missingState.state);

  const failing = createFakePm2({ failJlist: 'connect EACCES \\\\.\\pipe\\rpc.sock' });
  const failingState = await runner.pm2State({
    deps: { ...deps, run: failing.run, isRunning: () => true },
  });
  check('list_failed: the daemon did not answer',
    failingState.state === 'unavailable'
      && failingState.reason === 'list_failed'
      && failingState.message === 'PM2 did not answer: connect EACCES \\\\.\\pipe\\rpc.sock'
      && failingState.fix === 'Run pm2 list on the server.',
    `${failingState.state}/${failingState.reason}`);

  const service = createFakePm2({ apps: [] });
  const serviceState = await runner.pm2State({
    deps: { ...SERVICE_DEPS, run: service.run, isRunning: () => { throw new Error('must not run'); } },
  });
  check('unavailable: the service account is refused, nothing spawned',
    serviceState.state === 'unavailable'
      && serviceState.reason === 'service_account'
      && serviceState.message === UNKNOWN_MESSAGE
      && serviceState.fix === UNKNOWN_FIX
      && service.calls.length === 0,
    serviceState.state);
}

// ─── 5. currentAccount / runningUnderServiceManager ─────────────────────────

async function testAccount(platform) {
  setGroup('5. who this process is (currentAccount)');

  const windows = process.platform === 'win32';

  const byUser = platform.currentAccount({
    env: {},
    userInfo: () => ({ username: 'EasyDevOps' }),
    homedir: () => 'C:\\Users\\admin',
  });
  check('user EasyDevOps is the service account',
    byUser.user === 'EasyDevOps' && byUser.serviceAccount === windows,
    JSON.stringify(byUser));

  const byProfile = platform.currentAccount({
    env: {},
    userInfo: () => ({ username: 'admin' }),
    homedir: () => 'C:\\Windows\\ServiceProfiles\\EasyDevOps',
  });
  check('a home under ServiceProfiles is the service account',
    byProfile.serviceAccount === windows, JSON.stringify(byProfile));

  const bySystemProfile = platform.currentAccount({
    env: {},
    userInfo: () => ({ username: 'admin' }),
    homedir: () => 'C:\\Windows\\System32\\config\\systemprofile',
  });
  check('a home under System32\\config\\systemprofile is the service account',
    bySystemProfile.serviceAccount === windows, JSON.stringify(bySystemProfile));

  const normal = platform.currentAccount({
    env: {},
    userInfo: () => ({ username: 'admin' }),
    homedir: () => 'C:\\Users\\admin',
  });
  check('a normal administrator is not the service account',
    normal.user === 'admin' && normal.serviceAccount === false, JSON.stringify(normal));

  const unreadable = platform.currentAccount({
    env: { USERNAME: 'admin' },
    userInfo: () => { throw new Error('no such account'); },
    homedir: () => 'C:\\Users\\admin',
  });
  check('an unreadable account falls back to the environment and never throws',
    unreadable.user === 'admin' && unreadable.serviceAccount === false,
    JSON.stringify(unreadable));

  const domainStyle = platform.currentAccount({
    env: {},
    userInfo: () => ({ username: 'NT SERVICE\\EasyDevOps' }),
    homedir: () => 'C:\\Users\\admin',
  });
  check('a DOMAIN\\name spelling of EasyDevOps is recognised',
    domainStyle.serviceAccount === windows, JSON.stringify(domainStyle));

  const systemd = platform.runningUnderServiceManager({
    env: { INVOCATION_ID: 'abc123' },
    account: { serviceAccount: false },
  });
  check('INVOCATION_ID means systemd only on Linux',
    systemd === !windows, `runningUnderServiceManager=${systemd}, windows=${windows}`);

  const asService = platform.runningUnderServiceManager({
    env: { INVOCATION_ID: 'abc123' },
    account: { serviceAccount: true },
  });
  check('the service account is under the service manager on Windows',
    asService === true, String(asService));
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nPM2 access: Windows Server service account\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  const runner = await import(srcUrl('core/runner.js'));
  const platform = await import(srcUrl('core/platform.js'));
  const db = await import(srcUrl('core/db.js'));

  await testServiceAccount(runner, db);
  await testOperator(runner);
  await testUnchanged(runner);
  await testPm2State(runner, db);
  await testAccount(platform);

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
