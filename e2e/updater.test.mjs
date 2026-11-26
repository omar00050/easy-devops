/**
 * Tests for `ezz update` — updating Easy DevOps itself.
 *
 * Run with:  npm run test:e2e -- updater
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * npm is never actually run: every command goes through an injected stub and
 * the assertions are on what it was asked to run. That matters more here than
 * anywhere else in the suite — a real `npm install -g` would replace the
 * package this test is running from.
 *
 * The case that drove this feature is the first one tested: a git clone, where
 * `npm install -g` installs a SECOND copy from the registry and leaves the
 * service running the clone, so the update reports success and changes nothing.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import assert from 'node:assert/strict';
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

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Check the actual subprocess boundary before normalizing it for the call log.
function npmCommand(file, args) {
  let npmArgs = args;
  if (file === process.execPath) {
    assert.equal(path.basename(args[0]), 'npm-cli.js');
    npmArgs = args.slice(1);
  } else {
    assert.equal(file, 'npm');
  }
  if (npmArgs[0] === 'view') assert.deepEqual(npmArgs, ['view', 'easy-devops', 'version']);
  else {
    assert.equal(npmArgs.length, 3);
    assert.deepEqual(npmArgs.slice(0, 2), ['install', '-g']);
    assert.match(npmArgs[2], /^easy-devops@\d/);
  }
  return ['npm', ...npmArgs].join(' ');
}

function recordingRun(answers = {}) {
  const commands = [];
  const fn = async (file, args) => {
    const command = npmCommand(file, args);
    commands.push(command);
    for (const [pattern, answer] of Object.entries(answers)) {
      if (command.includes(pattern)) {
        if (answer === null) {
          return { success: false, stdout: '', stderr: `${pattern} failed`, exitCode: 1, command };
        }
        return { success: true, stdout: answer, stderr: '', exitCode: 0, command };
      }
    }
    return { success: false, stdout: '', stderr: 'not stubbed', exitCode: 1, command };
  };
  fn.commands = commands;
  return fn;
}

/** An install source of each kind, without touching the real package. */
const SOURCES = {
  npm: {
    kind: 'npm',
    root: path.join('C:', 'npm', 'node_modules', 'easy-devops'),
    npmUpdatable: true,
    reason: 'an npm-installed package',
    howToUpdate: [],
  },
  clone: {
    kind: 'clone',
    root: path.join('D:', 'work', 'Easy_DevOps'),
    npmUpdatable: false,
    reason: 'a git clone at D:\\work\\Easy_DevOps',
    howToUpdate: ['cd D:\\work\\Easy_DevOps', 'git pull', 'npm install', 'ezz service restart'],
  },
};

function serviceStub({
  installed = true,
  mode = 'personal',
  startOk = true,
  stopOk = true,
  alive = true,
  version = '1.2.1',
} = {}) {
  const calls = [];
  return {
    calls,
    async status() { calls.push('status'); return { service: { installed }, mode }; },
    async stop() { calls.push('stop'); return stopOk ? { ok: true } : { ok: false, reason: 'could not stop' }; },
    async start() { calls.push('start'); return startOk ? { ok: true } : { ok: false, reason: 'could not start' }; },
    async waitForDaemon() {
      calls.push('wait');
      return { alive, waitedMs: alive ? 300 : 10_000, lock: alive ? { version } : null };
    },
    recordedState() { return { nodeExe: null }; },
  };
}

function transactionDeps(calls = [], overrides = {}) {
  return {
    captureUpdateState: async (opts) => {
      calls.push('snapshot');
      return { ok: true, root: 'update-snapshot', ...opts, runtimeNodeExe: overrides.runtimeNodeExe ?? null };
    },
    restoreUpdateState: async () => {
      calls.push('restore');
      return { ok: true, restored: true };
    },
    commitUpdateState: () => {
      calls.push('commit');
      return { ok: true, warnings: [] };
    },
    runPostUpdate: async (opts) => {
      calls.push('post-update');
      return overrides.postUpdate ?? { ok: true, step: 'definition', version: opts.version };
    },
    ...overrides.deps,
  };
}

// ─── 1. A clone is not updated with npm ──────────────────────────────────────

async function testClone() {
  setGroup('1. a git clone is updated with git, not npm');

  const updater = await import(srcUrl('core/updater.js'));
  const { describeUnmanaged } = await import(srcUrl('core/installSource.js'));
  const service = serviceStub();
  const run = recordingRun({ 'npm install': 'installed' });

  const result = await updater.performUpdate({
    version: '9.9.9',
    dataDir: scratch('upd-clone'),
    deps: { runFile: run, service, detectInstallSource: () => SOURCES.clone, currentVersion: () => '1.2.1' },
  });

  check('the update refuses', result.ok === false && result.step === 'source', result.step);
  check('NO npm command was run',
    !run.commands.some((c) => /npm install/.test(c)), run.commands.join(' | '));
  check('and the service was never stopped',
    !service.calls.includes('stop'), service.calls.join(' -> '));
  check('it reports that nothing was touched', result.untouched === true);

  const lines = (result.lines ?? []).join('\n');
  check('the output says it is a clone', /git clone/.test(lines), lines.split('\n')[0]);
  check('and gives the git commands instead',
    /git pull/.test(lines) && /ezz service restart/.test(lines), lines.replace(/\n/g, ' | '));
  check('explaining why npm would be wrong, not just that it is',
    /second copy/.test(lines), lines.replace(/\n/g, ' | '));

  // The same explanation is available to any caller, which is why it lives in
  // installSource.js rather than being phrased again in the CLI.
  check('describeUnmanaged produces that explanation',
    describeUnmanaged(SOURCES.clone, 'update').join('\n').includes('git pull'));

  // An unpackaged copy is the third case: also not npm-updatable.
  const loose = await updater.performUpdate({
    version: '9.9.9',
    dataDir: scratch('upd-loose'),
    deps: {
      runFile: recordingRun(),
      service: serviceStub(),
      detectInstallSource: () => ({
        kind: 'unknown',
        root: '/opt/easy-devops',
        npmUpdatable: false,
        reason: 'an unpackaged copy at /opt/easy-devops',
        howToUpdate: ['npm install -g easy-devops'],
      }),
      currentVersion: () => '1.2.1',
    },
  });
  check('an unpackaged copy is refused too', loose.ok === false && loose.step === 'source', loose.step);
}

// ─── 2. The npm path, in order ───────────────────────────────────────────────

async function testNpmUpdate() {
  setGroup('2. an npm install is stopped, replaced, started and verified');

  const updater = await import(srcUrl('core/updater.js'));
  const dataDir = scratch('upd-npm');
  const order = [];

  const run = async (file, args) => {
    const command = npmCommand(file, args);
    order.push(`run:${command}`);
    return { success: true, stdout: 'ok', stderr: '', exitCode: 0, command };
  };

  const service = {
    async status() { order.push('status'); return { service: { installed: true }, mode: 'personal' }; },
    async stop() { order.push('stop'); return { ok: true }; },
    async start() { order.push('start'); return { ok: true }; },
    async waitForDaemon() {
      order.push('wait');
      return { alive: true, waitedMs: 250, lock: { version: '1.3.0' } };
    },
    recordedState() { return {}; },
  };
  const transactional = transactionDeps(order);

  const result = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      runFile: run,
      service,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
      inspectLock: () => ({ lock: { version: '1.3.0' } }),
      ...transactional,
    },
  });

  check('the update succeeds', result.ok === true, result.reason ?? '');
  check('from the old version to the new one',
    result.from === '1.2.1' && result.to === '1.3.0', `${result.from} -> ${result.to}`);
  check('and the running daemon confirms the new version',
    result.versionConfirmed === true && result.runningVersion === '1.3.0');

  const sequence = order.map((o) => (o.startsWith('run:') ? 'install' : o));
  check('the service is stopped BEFORE npm replaces the files',
    sequence.indexOf('stop') < sequence.indexOf('install'), sequence.join(' -> '));
  check('the service definition and runtime are preserved after the stop',
    sequence.indexOf('stop') < sequence.indexOf('snapshot')
      && sequence.indexOf('snapshot') < sequence.indexOf('install'), sequence.join(' -> '));
  check('and started again after',
    sequence.lastIndexOf('start') > sequence.indexOf('install'), sequence.join(' -> '));
  check('the NEW package post-update runs after npm and before start',
    sequence.indexOf('install') < sequence.indexOf('post-update')
      && sequence.indexOf('post-update') < sequence.indexOf('start'), sequence.join(' -> '));
  check('with the heartbeat waited for last',
    sequence.lastIndexOf('wait') > sequence.lastIndexOf('start'), sequence.join(' -> '));
  check('and the transaction is committed only after the target heartbeat',
    sequence.lastIndexOf('commit') > sequence.lastIndexOf('wait'), sequence.join(' -> '));

  check('npm was asked for the exact version',
    order.some((o) => o === 'run:npm install -g easy-devops@1.3.0'),
    order.filter((o) => o.startsWith('run:')).join(' | '));

  const unreadableService = serviceStub();
  unreadableService.status = async () => { throw new Error('SCM query failed'); };
  const unreadableNpm = recordingRun({ 'npm install': 'installed' });
  const unreadable = await updater.performUpdate({
    version: '1.3.0',
    dataDir: scratch('upd-unreadable-service'),
    deps: {
      runFile: unreadableNpm,
      service: unreadableService,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
    },
  });
  check('an unreadable service state fails closed instead of assuming no service',
    unreadable.ok === false
      && unreadable.step === 'status'
      && unreadable.untouched === true
      && unreadableService.calls.length === 0
      && unreadableNpm.commands.length === 0,
    JSON.stringify(unreadable));
}

// ─── 3. Windows Server: the NEW package performs the runtime refresh ─────────

async function testServerCopyRefresh() {
  setGroup('3. Windows Server mode hands runtime refresh to the new package');

  const updater = await import(srcUrl('core/updater.js'));
  const { isWindows } = await import(srcUrl('core/platform.js'));

  if (!isWindows) {
    check('skipped on Linux', true, 'the runtime app copy is Windows-Server-only');
    return;
  }

  const dataDir = scratch('upd-server');
  const order = [];
  const posts = [];
  const transactional = transactionDeps(order, {
    runtimeNodeExe: path.join(dataDir, 'runtime.previous', 'node.exe'),
  });
  const run = async (file, args) => {
    npmCommand(file, args);
    order.push('npm-new');
    return { success: true, stdout: 'ok', stderr: '', exitCode: 0, command: file };
  };
  const serverService = serviceStub({ installed: true, mode: 'server', version: '1.3.0' });
  const serviceStart = serverService.start;
  serverService.start = async (...args) => {
    order.push('start');
    return serviceStart(...args);
  };

  const result = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      runFile: run,
      service: serverService,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
      isElevated: async () => true,
      ...transactional,
      runPostUpdate: async (opts) => {
        order.push('post-update');
        posts.push(opts);
        return { ok: true, step: 'definition', version: '1.3.0' };
      },
    },
  });

  check('the update succeeds', result.ok === true, result.reason ?? '');
  check('exactly one new-package post-update ran', posts.length === 1, String(posts.length));
  check('it was called after npm and before the service start',
    order.indexOf('post-update') > order.indexOf('npm-new') && order.indexOf('post-update') < order.indexOf('start'),
    order.join(' -> '));
  check('it receives Server mode and the preserved runtime node',
    posts[0]?.mode === 'server'
      && posts[0]?.nodeExe === path.join(dataDir, 'runtime.previous', 'node.exe'),
    JSON.stringify(posts[0]));
  check('and the result says so', result.refreshedCopy === true);

  const failingService = serviceStub({ installed: true, mode: 'server' });
  failingService.waitForDaemon = async () => {
    return { alive: true, waitedMs: 100, lock: { version: '1.2.1' } };
  };
  const failed = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      runFile: recordingRun({ 'npm install': 'installed' }),
      service: failingService,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
      isElevated: async () => true,
      ...transactionDeps([], {
        postUpdate: { ok: false, step: 'copy', reason: 'ProgramData is not writable' },
      }),
    },
  });

  check('a copy that cannot be refreshed fails the update',
    failed.ok === false && failed.step === 'copy', failed.step);
  check('rather than leaving the service on the old code silently',
    /not writable/.test(failed.reason), failed.reason);
  check('and it rolls back to the previous version', failed.rolledBack === true);
}

// ─── 3b. Systemd and Personal mode refresh their launcher on update ──────────

async function testUserServiceRefresh() {
  setGroup('3b. a user service definition is refreshed after the package update');

  const updater = await import(srcUrl('core/updater.js'));
  const dataDir = scratch('upd-user-refresh');
  const order = [];
  const posts = [];
  const service = serviceStub({ installed: true, mode: 'personal', version: '1.4.4' });
  const start = service.start;
  service.start = async (...args) => {
    order.push('start');
    return start(...args);
  };
  const run = async (file, args) => {
    npmCommand(file, args);
    order.push('npm-new');
    return { success: true, stdout: 'ok', stderr: '', exitCode: 0, command: file };
  };

  const result = await updater.performUpdate({
    version: '1.4.4',
    dataDir,
    deps: {
      runFile: run,
      service,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.4.3',
      ...transactionDeps(order),
      runPostUpdate: async (opts) => {
        order.push('post-update');
        posts.push(opts);
        return { ok: true, step: 'definition', version: '1.4.4' };
      },
    },
  });

  check('the update succeeds', result.ok === true, result.reason ?? '');
  check('the new Personal service definition refresh runs exactly once',
    posts.length === 1 && posts[0]?.mode === 'personal', JSON.stringify(posts));
  check('the refresh happens before the service starts',
    order.indexOf('post-update') !== -1 && order.indexOf('post-update') < order.indexOf('start'),
    order.join(' -> '));
}

// ─── 4. Rollback ─────────────────────────────────────────────────────────────

async function testRollback() {
  setGroup('4. rollback when the new version does not come up');

  const updater = await import(srcUrl('core/updater.js'));
  const dataDir = scratch('upd-rollback');

  // ── npm itself fails ─────────────────────────────────────────────────────
  const failingNpm = recordingRun({
    'npm install -g easy-devops@1.3.0': null,
    'npm install -g easy-devops@1.2.1': 'installed',
  });
  const service = serviceStub();
  const installCalls = [];
  const installStart = service.start;
  const installWait = service.waitForDaemon;
  service.start = async (...args) => {
    installCalls.push('start');
    return installStart(...args);
  };
  service.waitForDaemon = async (...args) => {
    installCalls.push('wait');
    return installWait(...args);
  };

  const installFailed = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      runFile: failingNpm,
      service,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
      ...transactionDeps(installCalls),
    },
  });

  check('a failing npm install is reported', installFailed.ok === false && installFailed.step === 'install',
    installFailed.step);
  check('and the service is started again', installFailed.restarted === true);
  check('the old package is reinstalled rather than assuming a failed npm is atomic',
    failingNpm.commands.includes('npm install -g easy-devops@1.2.1'),
    failingNpm.commands.join(' | '));
  check('and a verified old heartbeat makes rollback success observable',
    installFailed.rolledBack === true
      && installFailed.rollbackVersionConfirmed === true,
    JSON.stringify(installFailed));
  check('the captured service files are restored before the old heartbeat',
    installCalls.indexOf('restore') !== -1
      && installCalls.indexOf('restore') < installCalls.indexOf('start')
      && installCalls.indexOf('start') < installCalls.indexOf('wait'),
    installCalls.join(' -> '));

  // ── It installs, but the daemon never reports in ─────────────────────────
  const commands = [];
  const run = async (file, args) => {
    const command = npmCommand(file, args);
    commands.push(command);
    return { success: true, stdout: 'ok', stderr: '', exitCode: 0, command };
  };
  const rollbackCalls = [];
  let waits = 0;
  const flapping = serviceStub({ installed: true, mode: 'personal' });
  flapping.waitForDaemon = async () => {
    waits += 1;
    return waits === 1
      ? { alive: false, waitedMs: 10_000, lock: null }
      : { alive: true, waitedMs: 200, lock: { version: '1.2.1' } };
  };

  const verifyFailed = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      runFile: run,
      service: flapping,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
      verifyMs: 10_000,
      ...transactionDeps(rollbackCalls),
    },
  });

  check('a daemon that does not report in fails the update',
    verifyFailed.ok === false && verifyFailed.step === 'verify', verifyFailed.step);
  check('the previous version is reinstalled',
    commands.some((c) => c === 'npm install -g easy-devops@1.2.1'),
    commands.join(' | '));
  check('the rollback is reported', verifyFailed.rolledBack === true);
  check('and the old heartbeat is verified before the service is called restored',
    verifyFailed.restored === true && verifyFailed.rollbackVersionConfirmed === true);
  check('the service snapshot is restored during rollback',
    rollbackCalls.includes('restore'), rollbackCalls.join(' -> '));

  // ── It comes up, but reports the wrong version ───────────────────────────
  let wrongVersionWaits = 0;
  const wrongVersionService = serviceStub({ installed: true, mode: 'personal' });
  wrongVersionService.waitForDaemon = async () => {
    wrongVersionWaits += 1;
    return wrongVersionWaits === 1
      ? { alive: true, waitedMs: 200, lock: { version: '1.2.2' } }
      : { alive: true, waitedMs: 200, lock: { version: '1.2.1' } };
  };
  const wrongVersion = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      runFile: recordingRun({ 'npm install': 'installed' }),
      service: wrongVersionService,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
      ...transactionDeps([]),
    },
  });
  check('a live daemon on any version other than the target is not accepted',
    wrongVersion.ok === false
      && wrongVersion.step === 'verify'
      && /reported v1\.2\.2/.test(wrongVersion.reason),
    wrongVersion.reason);
  check('and that mismatch also triggers a heartbeat-verified rollback',
    wrongVersion.rolledBack === true && wrongVersion.rollbackVersionConfirmed === true,
    JSON.stringify(wrongVersion));

  // ── The old package cannot be reinstalled ────────────────────────────────
  const failedBack = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      runFile: recordingRun({
        'npm install -g easy-devops@1.3.0': 'installed',
        'npm install -g easy-devops@1.2.1': null,
      }),
      service: serviceStub({ installed: true, mode: 'personal', version: '1.2.1' }),
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
      ...transactionDeps([], {
        postUpdate: { ok: false, step: 'definition', reason: 'definition failed' },
      }),
    },
  });
  check('a running old heartbeat cannot make a failed package reinstall look rolled back',
    failedBack.rolledBack === false
      && failedBack.restored === true
      && failedBack.rollbackVersionConfirmed === true,
    JSON.stringify(failedBack));

  // ── The service cannot even be stopped: nothing is replaced ──────────────
  const stuck = recordingRun({ 'npm install': 'installed' });
  const stuckService = serviceStub({ stopOk: false });
  const cannotStop = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      runFile: stuck,
      service: stuckService,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
    },
  });

  check('a service that cannot be stopped aborts the update',
    cannotStop.ok === false && cannotStop.step === 'stop', cannotStop.step);
  check('with the package left alone',
    !stuck.commands.some((c) => /npm install/.test(c)), stuck.commands.join(' | '));
  check('and it says nothing was touched', cannotStop.untouched === true);
  check('but the service it may have stopped is started again',
    stuckService.calls.includes('start') && cannotStop.restarted === true,
    stuckService.calls.join(' -> '));
  check('and the message says the service is running, not that it might be dead',
    /The service is running again/.test(cannotStop.lines.join('\n')),
    cannotStop.lines.join(' | '));

  // A stop failure whose restart also fails must name the start command.
  const deadService = serviceStub({ stopOk: false, startOk: false, alive: false });
  const cannotRestart = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      runFile: recordingRun({ 'npm install': 'installed' }),
      service: deadService,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
    },
  });
  check('a service left down says what to run',
    cannotRestart.ok === false
      && cannotRestart.next === 'ezz service start'
      && /ezz service start/.test(cannotRestart.lines.join('\n')),
    cannotRestart.lines.join(' | '));
}

// ─── 4b. The handoff loads code from the newly installed package ─────────────

async function testPostUpdateHandoff() {
  setGroup('4b. post-update runs from the new package before start');

  const updater = await import(srcUrl('core/updater.js'));
  const dataDir = scratch('upd-handoff');
  const sourceRoot = scratch('upd-new-package');
  let invocation = null;
  const exec = async (file, args, options) => {
    invocation = { file, args, options };
    return {
      success: true,
      stdout: `\n${updater.POST_UPDATE_RESULT_PREFIX}${JSON.stringify({
        ok: true,
        step: 'definition',
        version: '1.3.0',
      })}\n`,
      stderr: '',
      exitCode: 0,
    };
  };

  const result = await updater.runPostUpdateHandoff({
    sourceRoot,
    version: '1.3.0',
    dataDir,
    mode: 'server',
    mechanism: 'winsw',
    nodeExe: path.join(dataDir, 'runtime.previous', 'node.exe'),
    runFile: exec,
  });

  check('the trusted Node binary executes the NEW package entrypoint by argv',
    result.ok === true
      && invocation.file === process.execPath
      && invocation.args[0] === path.join(sourceRoot, 'src', 'cli', 'index.js')
      && invocation.args[1] === '_post-update',
    JSON.stringify(invocation?.args));
  check('the data directory and target version cross the process boundary explicitly',
    invocation.options.env.EASY_DEVOPS_DATA_DIR === dataDir
      && invocation.options.env.EZ_UPDATE_TARGET === '1.3.0'
      && invocation.options.env.EZ_UPDATE_MODE === 'server');
  check('the child keeps the terminal for sudo prompts',
    invocation.options.stdin === 'inherit');

  const wrongVersion = await updater.runPostUpdateHandoff({
    sourceRoot,
    version: '1.3.0',
    dataDir,
    runFile: async () => ({
      success: true,
      stdout: `${updater.POST_UPDATE_RESULT_PREFIX}${JSON.stringify({
        ok: true,
        version: '1.4.4',
      })}`,
    }),
  });
  check('a child that loaded the wrong installed version is refused',
    wrongVersion.ok === false && wrongVersion.step === 'post-update-version',
    JSON.stringify(wrongVersion));

  const noVersion = await updater.runPostUpdateHandoff({
    sourceRoot,
    version: '1.3.0',
    dataDir,
    runFile: async () => ({
      success: true,
      stdout: `${updater.POST_UPDATE_RESULT_PREFIX}${JSON.stringify({ ok: true, step: 'definition' })}`,
    }),
  });
  check('a success marker without the loaded package version is refused',
    noVersion.ok === false && noVersion.step === 'post-update-version',
    JSON.stringify(noVersion));

  // Exercise the actual hidden command module and its structured stdout.
  const { postUpdateCommand } = await import(srcUrl('cli/menus/postUpdate.js'));
  const { applyPostUpdate } = await import(srcUrl('core/service/postUpdate.js'));
  let output = '';
  const calls = [];
  let protectOpts = null;
  const code = await postUpdateCommand({
    env: {
      EASY_DEVOPS_DATA_DIR: dataDir,
      EZ_UPDATE_MODE: 'server',
      EZ_UPDATE_MECHANISM: 'winsw',
      EZ_UPDATE_TARGET: '1.3.0',
      EZ_UPDATE_NODE_EXE: path.join(dataDir, 'node.exe'),
    },
    stdout: { write: (chunk, callback) => {
      output += chunk;
      callback?.();
      return true;
    } },
    deps: {
      installedPackageVersion: () => '1.3.0',
      copyRuntime: (opts) => {
        calls.push('copy');
        return { ok: true, dir: path.join(dataDir, 'runtime'), nodeExe: opts.nodeExe };
      },
      verifyNativeModules: async () => {
        calls.push('native');
        return { ok: true, version: 'v22.0.0', abi: '127' };
      },
      protectServiceFiles: async (opts) => {
        calls.push('protect');
        protectOpts = opts;
        return { ok: true };
      },
      refreshServiceDefinition: () => {
        calls.push('definition');
      },
    },
  });
  check('the command loads and returns the new-version result',
    code === 0 && /__EASY_DEVOPS_POST_UPDATE__/.test(output), output.trim());
  check('the command refreshes copy, native modules, protections and definition',
    calls.join(',') === 'copy,native,protect,definition', calls.join(' -> '));
  check('the protection pass includes both service code roots',
    protectOpts?.dirs?.length === 2
      && path.basename(protectOpts.dirs[0]) === 'runtime'
      && path.basename(protectOpts.dirs[1]) === 'bin',
    JSON.stringify(protectOpts?.dirs));

  const thrownCopy = await applyPostUpdate({
    dataDir,
    mode: 'server',
    mechanism: 'winsw',
    targetVersion: '1.3.0',
    nodeExe: path.join(dataDir, 'missing-node.exe'),
    deps: {
      installedPackageVersion: () => '1.3.0',
      copyRuntime: async (opts) => {
        assert.equal(opts.nodeExe, process.execPath);
        throw new Error('copy exploded');
      },
    },
  });
  check('a thrown post-update failure retains the failing step and missing-node fallback',
    thrownCopy.ok === false && thrownCopy.step === 'copy' && /copy exploded/.test(thrownCopy.reason),
    JSON.stringify(thrownCopy));
}

// ─── 4c. Service artifacts are restored as one transaction ──────────────────

/** node.exe that "runs", for restores that must prove it. */
const PROBE_OK = { runFile: async () => ({ success: true, stdout: 'v22.0.0\n', stderr: '', exitCode: 0 }) };

async function testUpdateTransaction() {
  setGroup('4c. unit/XML and runtime rollback is transactional, with a journal');

  const transaction = await import(srcUrl('core/service/updateTransaction.js'));
  const root = scratch('upd-transaction-windows');
  const dataDir = path.join(root, 'data');
  const runtime = path.join(root, 'runtime');
  const xml = path.join(root, 'service.xml');
  const snapshots = path.join(root, 'snapshots');
  fs.mkdirSync(path.join(runtime, 'app'), { recursive: true });
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'node.exe'), 'old node');
  fs.writeFileSync(path.join(runtime, 'app', 'version.txt'), '1.2.1');
  fs.writeFileSync(xml, '<old />');

  const captured = await transaction.captureUpdateState({
    dataDir,
    mode: 'server',
    mechanism: 'winsw',
    deps: {
      serviceXmlPath: () => xml,
      runtimeDir: () => runtime,
      tmpDir: snapshots,
    },
  });
  check('the Windows runtime is moved aside before the package is replaced',
    captured.ok === true && !fs.existsSync(runtime) && Boolean(captured.runtimeBackup),
    JSON.stringify(captured));

  // Finding 1: a crash-safe record exists BEFORE anything moves, and it names
  // the exact paths a later run needs.
  const journalFile = path.join(dataDir, 'update-journal.json');
  check('the journal sits in the service folder, not in user data',
    captured.journal === journalFile && fs.existsSync(journalFile), captured.journal);
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  check('the journal records the moved runtime and the snapshot',
    journal.runtimeBackup === captured.runtimeBackup
      && journal.root === captured.root
      && journal.stage === 'moved',
    JSON.stringify({ stage: journal.stage, backup: journal.runtimeBackup }));

  fs.mkdirSync(path.join(runtime, 'app'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'node.exe'), 'new node');
  fs.writeFileSync(path.join(runtime, 'app', 'version.txt'), '1.3.0');
  fs.writeFileSync(xml, '<new />');
  const restored = await transaction.restoreUpdateState(captured, {
    deps: { runtimeDir: () => runtime, ...PROBE_OK },
  });
  check('rollback restores the old runtime and XML together',
    restored.ok
      && fs.readFileSync(path.join(runtime, 'node.exe'), 'utf8') === 'old node'
      && fs.readFileSync(path.join(runtime, 'app', 'version.txt'), 'utf8') === '1.2.1'
      && fs.readFileSync(xml, 'utf8') === '<old />',
    JSON.stringify(restored));
  check('and removes both the set-aside new runtime and the journal',
    !fs.existsSync(captured.runtimeBackup) && !fs.existsSync(journalFile));

  // Finding 3: the new copy is not deleted until the old one is proven to run.
  const brokenRoot = scratch('upd-transaction-unverified');
  const brokenRuntime = path.join(brokenRoot, 'runtime');
  const brokenXml = path.join(brokenRoot, 'service.xml');
  const brokenSnapshots = path.join(brokenRoot, 'snapshots');
  fs.mkdirSync(path.join(brokenRuntime, 'app'), { recursive: true });
  fs.mkdirSync(brokenSnapshots, { recursive: true });
  fs.writeFileSync(path.join(brokenRuntime, 'node.exe'), 'old node');
  fs.writeFileSync(brokenXml, '<old />');
  const brokenCapture = await transaction.captureUpdateState({
    dataDir: path.join(brokenRoot, 'data'),
    mode: 'server',
    mechanism: 'winsw',
    deps: { serviceXmlPath: () => brokenXml, runtimeDir: () => brokenRuntime, tmpDir: brokenSnapshots },
  });
  fs.mkdirSync(brokenRuntime, { recursive: true });
  fs.writeFileSync(path.join(brokenRuntime, 'node.exe'), 'new node');
  const unverified = await transaction.restoreUpdateState(brokenCapture, {
    deps: {
      runtimeDir: () => brokenRuntime,
      runFile: async () => ({ success: false, stderr: 'EPERM', stdout: '', exitCode: 1 }),
    },
  });
  const keptAside = fs.readdirSync(brokenRoot).filter((name) => /^runtime\.update-new-/.test(name));
  check('a restore whose node.exe does not run is reported, not called success',
    unverified.ok === false && /does not work/.test(unverified.reason), unverified.reason);
  check('and it keeps BOTH copies and names them',
    fs.readFileSync(path.join(brokenRuntime, 'node.exe'), 'utf8') === 'old node'
      && keptAside.length === 1
      && unverified.reason.includes(keptAside[0]),
    keptAside.join(' | '));

  const unitRoot = scratch('upd-transaction-systemd');
  const unit = path.join(unitRoot, 'easy-devops.service');
  const unitSnapshots = path.join(unitRoot, 'snapshots');
  fs.mkdirSync(unitSnapshots, { recursive: true });
  fs.writeFileSync(unit, '[Service]\nExecStart=old\n');
  const commands = [];
  const capturedUnit = await transaction.captureUpdateState({
    dataDir: path.join(unitRoot, 'data'),
    mode: null,
    mechanism: 'systemd',
    deps: {
      unitPath: () => unit,
      runtimeNodePath: () => path.join(unitRoot, 'missing-node'),
      tmpDir: unitSnapshots,
    },
  });
  fs.writeFileSync(unit, '[Service]\nExecStart=new\n');
  const restoredUnit = await transaction.restoreUpdateState(capturedUnit, {
    deps: {
      runFile: async (file, args) => {
        commands.push([file, ...args].join(' '));
        return { success: true, stdout: '', stderr: '' };
      },
    },
  });
  check('systemd rollback reinstalls the old unit, then reloads systemd',
    restoredUnit.ok
      && commands.length === 2
      && /^sudo install -m 0644/.test(commands[0])
      && commands[1] === 'sudo systemctl daemon-reload',
    commands.join(' | '));

  const personalRoot = scratch('upd-transaction-personal');
  const launcher = path.join(personalRoot, 'startup.cmd');
  const supervisor = path.join(personalRoot, 'supervisor.cmd');
  const personalSnapshots = path.join(personalRoot, 'snapshots');
  fs.mkdirSync(personalSnapshots, { recursive: true });
  fs.writeFileSync(launcher, 'old launcher');
  fs.writeFileSync(supervisor, 'old supervisor');
  const capturedPersonal = await transaction.captureUpdateState({
    dataDir: path.join(personalRoot, 'data'),
    mode: 'personal',
    mechanism: 'startup-supervisor',
    deps: {
      launcherPath: () => launcher,
      supervisorPath: () => supervisor,
      tmpDir: personalSnapshots,
    },
  });
  fs.writeFileSync(launcher, 'new launcher');
  fs.writeFileSync(supervisor, 'new supervisor');
  const restoredPersonal = await transaction.restoreUpdateState(capturedPersonal);
  check('Personal-mode rollback restores both launcher scripts together',
    restoredPersonal.ok
      && fs.readFileSync(launcher, 'utf8') === 'old launcher'
      && fs.readFileSync(supervisor, 'utf8') === 'old supervisor',
    JSON.stringify(restoredPersonal));

  const linkRoot = scratch('upd-transaction-link');
  const linkPath = path.join(linkRoot, 'runtime', 'node');
  const linkUnit = path.join(linkRoot, 'easy-devops.service');
  fs.mkdirSync(path.join(linkRoot, 'runtime'), { recursive: true });
  fs.writeFileSync(linkUnit, '[Service]\nExecStart=old\n');
  fs.writeFileSync(path.join(linkRoot, 'old-node'), 'old');
  fs.writeFileSync(path.join(linkRoot, 'new-node'), 'new');
  let canLink = true;
  try {
    fs.symlinkSync(path.join(linkRoot, 'old-node'), linkPath);
  } catch {
    canLink = false;
  }
  if (canLink) {
    const linkCapture = await transaction.captureUpdateState({
      dataDir: path.join(linkRoot, 'data'),
      mode: null,
      mechanism: 'systemd',
      deps: { unitPath: () => linkUnit, runtimeNodePath: () => linkPath, tmpDir: snapshots },
    });
    fs.rmSync(linkPath, { force: true });
    fs.symlinkSync(path.join(linkRoot, 'new-node'), linkPath);
    const linkRestore = await transaction.restoreUpdateState(linkCapture, {
      deps: {
        runtimeNodePath: () => linkPath,
        runFile: async () => ({ success: true, stdout: '', stderr: '' }),
      },
    });
    check('a re-pointed runtime link is restored with the unit',
      linkRestore.ok === true && fs.readlinkSync(linkPath) === path.join(linkRoot, 'old-node'),
      JSON.stringify(linkRestore));
  } else {
    check('a re-pointed runtime link is restored with the unit',
      true, 'skipped: this machine cannot create symlinks');
  }

  const missingRoot = scratch('upd-transaction-missing-runtime');
  const missingRuntime = path.join(missingRoot, 'runtime');

  const missingXml = path.join(missingRoot, 'service.xml');
  const missingSnapshots = path.join(missingRoot, 'snapshots');
  fs.mkdirSync(missingRuntime, { recursive: true });
  fs.mkdirSync(missingSnapshots, { recursive: true });
  fs.writeFileSync(path.join(missingRuntime, 'node.exe'), 'old node');
  fs.writeFileSync(missingXml, '<old />');
  const capturedMissing = await transaction.captureUpdateState({
    dataDir: path.join(missingRoot, 'data'),
    mode: 'server',
    mechanism: 'winsw',
    deps: {
      serviceXmlPath: () => missingXml,
      runtimeDir: () => missingRuntime,
      tmpDir: missingSnapshots,
    },
  });
  fs.rmSync(capturedMissing.runtimeBackup, { recursive: true, force: true });
  const missingRestore = await transaction.restoreUpdateState(capturedMissing, {
    deps: { runtimeDir: () => missingRuntime, ...PROBE_OK },
  });
  check('rollback refuses to report success when the preserved runtime is missing',
    missingRestore.ok === false && /preserved service runtime is missing/.test(missingRestore.reason),
    JSON.stringify(missingRestore));
  check('and a restore that could not finish keeps the journal for the next run',
    fs.existsSync(capturedMissing.journal), capturedMissing.journal);
}

// ─── 4d. Finding 2: an absent artifact is not a failure ─────────────────────

async function testAbsentArtifacts() {
  setGroup('4d. an absent launcher or unit is skipped, not an error');

  const transaction = await import(srcUrl('core/service/updateTransaction.js'));
  const updater = await import(srcUrl('core/updater.js'));
  const root = scratch('upd-absent');
  const dataDir = path.join(root, 'data');
  const snapshots = path.join(root, 'snapshots');
  fs.mkdirSync(snapshots, { recursive: true });
  const supervisor = path.join(root, 'daemon-supervisor.cmd');

  const captured = await transaction.captureUpdateState({
    dataDir,
    mode: 'personal',
    mechanism: 'startup-supervisor',
    deps: { launcherPath: () => null, supervisorPath: () => supervisor, tmpDir: snapshots },
  });
  check('a missing Startup launcher is recorded as absent, not an abort',
    captured.ok === true
      && captured.files.length === 2
      && captured.files.every((file) => file.absent === true),
    JSON.stringify(captured.files));
  const restored = await transaction.restoreUpdateState(captured);
  check('restoring an absent artifact succeeds and creates nothing',
    restored.ok === true && !fs.existsSync(supervisor), JSON.stringify(restored));

  const unitPath = path.join(root, 'easy-devops.service');
  const unitData = path.join(root, 'unit-data');
  const unitCapture = await transaction.captureUpdateState({
    dataDir: unitData,
    mode: null,
    mechanism: 'systemd',
    deps: {
      unitPath: () => unitPath,
      runtimeNodePath: () => path.join(root, 'runtime-node'),
      tmpDir: snapshots,
    },
  });
  check('a missing systemd unit is not an error either',
    unitCapture.ok === true && unitCapture.files[0]?.absent === true,
    JSON.stringify(unitCapture.files));
  const unitRestore = await transaction.restoreUpdateState(unitCapture, {
    deps: { runFile: async () => ({ success: true, stdout: '', stderr: '' }) },
  });
  check('and restoring it leaves no unit behind either',
    unitRestore.ok === true && !fs.existsSync(unitPath), JSON.stringify(unitRestore));

  // And the whole update proceeds with the launcher absent.
  const order = [];
  const service = serviceStub({ installed: true, mode: 'personal', version: '1.4.7' });
  const start = service.start;
  service.start = async (...args) => { order.push('start'); return start(...args); };
  const result = await updater.performUpdate({
    version: '1.4.7',
    dataDir,
    deps: {
      runFile: recordingRun({ 'npm install': 'installed' }),
      service,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.4.6',
      captureUpdateState: (opts) => transaction.captureUpdateState({
        ...opts,
        dataDir,
        deps: { launcherPath: () => null, supervisorPath: () => supervisor, tmpDir: snapshots },
      }),
      restoreUpdateState: (snapshot) => transaction.restoreUpdateState(snapshot),
      commitUpdateState: transaction.commitUpdateState,
      runPostUpdate: async () => { order.push('post-update'); return { ok: true, step: 'definition' }; },
    },
  });
  check('an update with no launcher installed still succeeds',
    result.ok === true, result.reason ?? '');
  check('and it never starts the service before post-update',
    order.indexOf('post-update') !== -1 && order.indexOf('post-update') < order.indexOf('start'),
    order.join(' -> '));
}

// ─── 4e. Finding 1: an interrupted update is finished by the next run ───────

async function testInterruptedUpdate() {
  setGroup('4e. an interrupted transaction is recovered on the next run');

  const transaction = await import(srcUrl('core/service/updateTransaction.js'));
  const root = scratch('upd-interrupted');
  const dataDir = path.join(root, 'data');
  const runtime = path.join(root, 'runtime');
  const xml = path.join(root, 'service.xml');
  const snapshots = path.join(root, 'snapshots');
  fs.mkdirSync(path.join(runtime, 'app'), { recursive: true });
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'node.exe'), 'old node');
  fs.writeFileSync(path.join(runtime, 'app', 'version.txt'), '1.4.3');
  fs.writeFileSync(xml, '<old />');

  const captured = await transaction.captureUpdateState({
    dataDir,
    mode: 'server',
    mechanism: 'winsw',
    deps: { serviceXmlPath: () => xml, runtimeDir: () => runtime, tmpDir: snapshots },
  });
  check('the update is mid-flight: runtime moved aside and the journal left behind',
    captured.ok === true && !fs.existsSync(runtime) && fs.existsSync(captured.journal));

  // The crash: post-update copied the new runtime in and rewrote the XML.
  fs.mkdirSync(path.join(runtime, 'app'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'node.exe'), 'new node');
  fs.writeFileSync(xml, '<new />');

  const recovered = await transaction.recoverInterruptedUpdate({
    dataDir,
    deps: { runtimeDir: () => runtime, ...PROBE_OK },
  });
  check('the next run finds the journal and puts the previous runtime back',
    recovered.ok === true && recovered.recovered === true
      && fs.readFileSync(path.join(runtime, 'node.exe'), 'utf8') === 'old node'
      && fs.readFileSync(path.join(runtime, 'app', 'version.txt'), 'utf8') === '1.4.3'
      && fs.readFileSync(xml, 'utf8') === '<old />',
    JSON.stringify(recovered));
  check('the journal is gone once the previous state is back',
    !fs.existsSync(captured.journal));
  check('the superseded new copy is removed only after the old one was proven',
    !fs.existsSync(captured.runtimeBackup));

  const again = await transaction.recoverInterruptedUpdate({ dataDir, deps: { runtimeDir: () => runtime, ...PROBE_OK } });
  check('recovering again is a harmless no-op',
    again.ok === true && again.recovered === false, JSON.stringify(again));

  // A journal that cannot be read is reported instead of silently ignored.
  fs.writeFileSync(path.join(dataDir, 'update-journal.json'), '{ not json');
  const corrupt = await transaction.recoverInterruptedUpdate({ dataDir });
  check('an unreadable journal is reported, not ignored',
    corrupt.ok === false && /cannot be read/.test(corrupt.reason), corrupt.reason);
  fs.rmSync(path.join(dataDir, 'update-journal.json'), { force: true });

  // A journal whose owner is still alive belongs to an update that is running
  // right now — the post-update child is a different process — and must be
  // left alone.
  const liveJournal = path.join(dataDir, 'update-journal.json');
  fs.writeFileSync(liveJournal, JSON.stringify({
    version: 1,
    stage: 'moved',
    pid: process.ppid,
    dataDir,
    root: path.join(root, 'other-snapshot'),
    files: [],
    runtimeBackup: path.join(root, 'runtime.other'),
  }));
  const live = await transaction.recoverInterruptedUpdate({
    dataDir,
    deps: { runtimeDir: () => runtime, ...PROBE_OK },
  });
  check('a journal owned by a running update is left untouched',
    live.ok === true && live.active === true && live.recovered === false && fs.existsSync(liveJournal),
    JSON.stringify(live));

  const busy = await transaction.captureUpdateState({
    dataDir,
    mode: 'server',
    deps: { serviceXmlPath: () => xml, runtimeDir: () => runtime, tmpDir: snapshots },
  });
  check('and a second update refuses to start on top of it',
    busy.ok === false && /another update is running/.test(busy.reason), busy.reason);
  fs.rmSync(liveJournal, { force: true });
}

// ─── 4f. Windows A3: the update must never stop silently ────────────────────

async function testWindowsA3Replay() {
  setGroup('4f. Windows A3: after the runtime copy, a failure is reported and rolled back');

  const updater = await import(srcUrl('core/updater.js'));
  const transaction = await import(srcUrl('core/service/updateTransaction.js'));
  const root = scratch('upd-a3');
  const dataDir = path.join(root, 'data');
  const runtime = path.join(root, 'runtime');
  const xml = path.join(root, 'service.xml');
  const snapshots = path.join(root, 'snapshots');
  fs.mkdirSync(path.join(runtime, 'app'), { recursive: true });
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'node.exe'), 'old node');
  fs.writeFileSync(path.join(runtime, 'app', 'version.txt'), '1.4.5');
  fs.writeFileSync(xml, '<old />');

  const order = [];
  const logs = [];
  const service = serviceStub({ installed: true, mode: 'server', version: '1.4.5' });
  const start = service.start;
  const wait = service.waitForDaemon;
  service.start = async (...args) => { order.push('start'); return start(...args); };
  service.waitForDaemon = async (...args) => { order.push('wait'); return wait(...args); };
  const npm = recordingRun({ 'npm install': 'installed' });

  const result = await updater.performUpdate({
    version: '1.4.7',
    dataDir,
    log: (line) => logs.push(line),
    deps: {
      runFile: npm,
      service,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.4.5',
      isElevated: async () => true,
      captureUpdateState: (opts) => {
        order.push('snapshot');
        return transaction.captureUpdateState({
          ...opts,
          dataDir,
          deps: { serviceXmlPath: () => xml, runtimeDir: () => runtime, tmpDir: snapshots },
        });
      },
      restoreUpdateState: (snapshot) => {
        order.push('restore');
        return transaction.restoreUpdateState(snapshot, {
          deps: { runtimeDir: () => runtime, ...PROBE_OK },
        });
      },
      commitUpdateState: (snapshot) => { order.push('commit'); return transaction.commitUpdateState(snapshot); },
      runPostUpdate: async () => {
        // The measured sequence: the copy step succeeded and said so...
        order.push('post-update');
        logs.push('node.exe is already the runtime copy (C:\\ProgramData\\easy-devops\\runtime\\node.exe); kept');
        fs.mkdirSync(path.join(runtime, 'app'), { recursive: true });
        fs.writeFileSync(path.join(runtime, 'node.exe'), 'new node');
        fs.writeFileSync(path.join(runtime, 'app', 'version.txt'), '1.4.7');
        fs.writeFileSync(xml, '<new />');
        // ...and then the protection pass failed.
        return {
          ok: false,
          step: 'permissions',
          reason: 'C:\\ProgramData\\easy-devops\\runtime\\node.exe: EPERM: operation not permitted',
        };
      },
      inspectLock: () => ({ lock: { version: '1.4.5' } }),
    },
  });

  check('the update fails instead of stopping silently after the copy',
    result.ok === false && result.step === 'permissions', result.step);
  check('the copy step really ran and was logged',
    logs.some((line) => /is already the runtime copy/.test(line)), logs.join(' | '));
  check('the output names the step and the error',
    result.lines.join('\n').includes('Failed at: permissions')
      && result.lines.join('\n').includes('EPERM'),
    result.lines.join(' | '));
  check('the old package is put back', npm.commands.includes('npm install -g easy-devops@1.4.5'),
    npm.commands.join(' | '));
  check('the unit/XML and the runtime copy are restored together',
    fs.readFileSync(xml, 'utf8') === '<old />'
      && fs.readFileSync(path.join(runtime, 'node.exe'), 'utf8') === 'old node'
      && fs.readdirSync(root).filter((name) => /^runtime\.update-new-/.test(name)).length === 0,
    `${fs.readFileSync(xml, 'utf8')} / ${fs.readFileSync(path.join(runtime, 'node.exe'), 'utf8')}`);
  check('and the service is started and verified on the old version, never left stopped',
    order.includes('restore')
      && order.indexOf('restore') < order.indexOf('start')
      && result.restarted === true
      && result.rollbackVersionConfirmed === true,
    order.join(' -> '));
  check('it ends with the exact command to run next',
    result.next === 'sc.exe query EasyDevOps' || result.next === 'ezz service recover',
    result.next);
  check('and the reason a caller prints carries that command too',
    new RegExp(`Next: ${result.next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(result.reason),
    result.reason);
  check('no start happened before the new package post-update',
    order.indexOf('post-update') < order.indexOf('start'), order.join(' -> '));
}

// ─── 4g. A rollback that cannot prove the old heartbeat says what to run ────

async function testBrokenRollbackMessage() {
  setGroup('4g. a rollback that does not come back says what is still broken');

  const updater = await import(srcUrl('core/updater.js'));
  const dataDir = scratch('upd-broken-rollback');
  const service = serviceStub({ installed: true, mode: 'server', version: '1.4.5' });
  service.waitForDaemon = async () => ({
    alive: true,
    waitedMs: 400,
    lock: { version: '1.4.6' },
  });

  const result = await updater.performUpdate({
    version: '1.4.7',
    dataDir,
    deps: {
      runFile: recordingRun({ 'npm install': 'installed' }),
      service,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.4.5',
      isElevated: async () => true,
      ...transactionDeps([], {
        postUpdate: { ok: false, step: 'definition', reason: 'the WinSW XML could not be written' },
      }),
      inspectLock: () => ({ lock: { version: '1.4.6' } }),
    },
  });

  const message = result.lines.join('\n');
  check('a daemon reporting the wrong version is not called a successful rollback',
    result.ok === false && result.rollbackVersionConfirmed === false, JSON.stringify(result).slice(0, 200));
  check('the message lists what is still broken',
    /NOT confirmed running/.test(message)
      && /v1\.4\.6/.test(message)
      && /v1\.4\.5/.test(message),
    message.replace(/\n/g, ' | '));
  check('and what to run: the check command and the repair command',
    /sc\.exe query EasyDevOps/.test(message) && /ezz service recover/.test(message),
    message.replace(/\n/g, ' | '));
  check('the next command is the repair path', result.next === 'ezz service recover', result.next);
  check('and the printed reason names it as well',
    /Next: ezz service recover/.test(result.reason), result.reason);
}

// ─── 4h. An older target has no post-update step: fall back to repair ───────

async function testPostUpdateFallback() {
  setGroup('4h. an older target falls back to this version\'s repair');

  const updater = await import(srcUrl('core/updater.js'));
  const dataDir = scratch('upd-fallback');
  const olderRoot = scratch('upd-fallback-older');
  fs.writeFileSync(path.join(olderRoot, 'package.json'),
    JSON.stringify({ name: 'easy-devops', version: '1.4.3' }));

  const handoff = await updater.runPostUpdateHandoff({
    sourceRoot: olderRoot,
    version: '1.4.3',
    dataDir,
    runFile: async () => { throw new Error('the older package must not be launched'); },
  });
  check('a version without the command is detected before it is launched',
    handoff.ok === true && handoff.fallback === true, JSON.stringify(handoff));
  check('and the reason says which version introduced it',
    /1\.4\.7/.test(handoff.reason), handoff.reason);

  const order = [];
  const service = serviceStub({ installed: true, mode: 'personal', version: '1.4.3' });
  const start = service.start;
  service.start = async (...args) => { order.push('start'); return start(...args); };

  const result = await updater.performUpdate({
    version: '1.4.3',
    dataDir,
    deps: {
      runFile: recordingRun({ 'npm install': 'installed' }),
      service,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.4.7',
      ...transactionDeps(order),
      runPostUpdate: async () => { order.push('post-update'); return { ok: true, fallback: true, reason: 'no step' }; },
      runRepair: async () => { order.push('repair'); return { ok: true }; },
    },
  });
  check('the update still succeeds', result.ok === true, result.reason ?? '');
  check('this version\'s repair runs before the start, in place of the hand-off',
    order.indexOf('post-update') < order.indexOf('repair')
      && order.indexOf('repair') < order.indexOf('start'),
    order.join(' -> '));

  const failing = await updater.performUpdate({
    version: '1.4.3',
    dataDir,
    deps: {
      runFile: recordingRun({ 'npm install': 'installed' }),
      // The rollback heartbeat must report the version that was installed
      // before this update, which is `from`.
      service: serviceStub({ installed: true, mode: 'personal', version: '1.4.7' }),
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.4.7',
      ...transactionDeps([]),
      runPostUpdate: async () => ({ ok: true, fallback: true, reason: 'no step' }),
      runRepair: async () => ({ ok: false, reason: 'the launcher could not be rewritten' }),
    },
  });
  check('a failed fallback repair rolls back rather than starting blindly',
    failing.ok === false
      && failing.step === 'repair'
      && failing.rolledBack === true
      && /launcher could not be rewritten/.test(failing.reason),
    failing.reason);
}

// ─── 4i. The new package's post-update is idempotent ────────────────────────

async function testPostUpdateIdempotent() {
  setGroup('4i. the post-update step can run again from repair');

  const { applyPostUpdate } = await import(srcUrl('core/service/postUpdate.js'));
  const dataDir = scratch('upd-idempotent');
  const runtimeDirPath = path.join(dataDir, 'runtime');

  const deps = {
    installedPackageVersion: () => '1.4.7',
    copyRuntime: (opts) => ({ ok: true, dir: opts.dataDir, nodeExe: opts.nodeExe }),
    verifyNativeModules: async () => ({ ok: true, version: 'v22.0.0', abi: '127' }),
    protectServiceFiles: async () => ({ ok: true, protected: [], failed: [] }),
    refreshServiceDefinition: () => {},
    recoverInterruptedUpdate: async () => ({ ok: true, recovered: false }),
  };

  const first = await applyPostUpdate({ dataDir, mode: 'server', mechanism: 'winsw', targetVersion: '1.4.7', deps });
  const second = await applyPostUpdate({ dataDir, mode: 'server', mechanism: 'winsw', targetVersion: '1.4.7', deps });
  check('running it twice from repair succeeds both times',
    first.ok === true && second.ok === true,
    `${JSON.stringify(first)} / ${JSON.stringify(second)}`);
  check('it never touches user data', !fs.existsSync(path.join(runtimeDirPath, 'easy-devops.sqlite')));

  const journal = await applyPostUpdate({
    dataDir,
    mode: 'server',
    mechanism: 'winsw',
    targetVersion: '1.4.7',
    deps: {
      ...deps,
      recoverInterruptedUpdate: async () => ({ ok: false, reason: 'the old runtime is at C:\\x, run `ezz service recover`' }),
    },
  });
  check('an unrecoverable earlier update stops it before it copies anything',
    journal.ok === false && journal.step === 'journal' && /ezz service recover/.test(journal.reason),
    JSON.stringify(journal));
}

// ─── 5. No service installed ─────────────────────────────────────────────────

async function testNoService() {
  setGroup('5. with no service installed, only the package changes');

  const updater = await import(srcUrl('core/updater.js'));
  const run = recordingRun({ 'npm install': 'installed' });
  const service = serviceStub({ installed: false });

  const result = await updater.performUpdate({
    version: '1.3.0',
    dataDir: scratch('upd-noservice'),
    deps: { runFile: run, service, detectInstallSource: () => SOURCES.npm, currentVersion: () => '1.2.1' },
  });

  check('the update succeeds', result.ok === true, result.reason ?? '');
  check('it says no service was involved', result.serviceInstalled === false);
  check('nothing was stopped or started', !service.calls.includes('stop') && !service.calls.includes('start'),
    service.calls.join(' -> '));
  check('but the package was still replaced',
    run.commands.some((c) => /npm install -g easy-devops@1\.3\.0/.test(c)), run.commands.join(' | '));
}

// ─── 6. Checking the registry ────────────────────────────────────────────────

async function testCheck() {
  setGroup('6. checking for a newer version');

  const updater = await import(srcUrl('core/updater.js'));

  const newer = await updater.checkForUpdate({
    deps: { runFile: recordingRun({ 'npm view': '1.3.0' }), currentVersion: () => '1.2.1' },
  });
  check('a newer version is reported as available',
    newer.reachable && newer.updateAvailable && newer.latest === '1.3.0',
    JSON.stringify(newer));

  const same = await updater.checkForUpdate({
    deps: { runFile: recordingRun({ 'npm view': '1.2.1' }), currentVersion: () => '1.2.1' },
  });
  check('the same version is not an update', same.reachable && same.updateAvailable === false);

  const older = await updater.checkForUpdate({
    deps: { runFile: recordingRun({ 'npm view': '1.1.0' }), currentVersion: () => '1.2.1' },
  });
  check('an older registry version is not an update', older.updateAvailable === false);

  const prerelease = await updater.checkForUpdate({
    deps: {
      runFile: recordingRun({ 'npm view': '1.3.0' }),
      currentVersion: () => '1.3.0-rc.2',
    },
  });
  check('a final release supersedes the matching prerelease',
    prerelease.updateAvailable === true, JSON.stringify(prerelease));

  const offline = await updater.checkForUpdate({
    deps: { runFile: recordingRun({ 'npm view': null }), currentVersion: () => '1.2.1' },
  });
  check('an unreachable registry is reported, not guessed at',
    offline.reachable === false && offline.latest === null && offline.updateAvailable === false,
    JSON.stringify(offline));

  // Garbage from the registry must not be treated as a version.
  const junk = await updater.checkForUpdate({
    deps: { runFile: recordingRun({ 'npm view': 'npm WARN something' }), currentVersion: () => '1.2.1' },
  });
  check('non-version output is treated as unreachable', junk.reachable === false, JSON.stringify(junk));

  for (const bad of ['1.3.0 extra', 'unrelated\\n1.3.0', '1.3.0\\nextra', '1.3.0+build']) {
    const result = await updater.checkForUpdate({ deps: { runFile: recordingRun({ 'npm view': bad }) } });
    check(`reject entire registry output ${JSON.stringify(bad)}`, !result.reachable && result.latest === null);
  }
  for (const [from, version] of [['1.2.1', '1.3.0 extra'], ['1.2.1 extra', '1.3.0']]) {
    const service = serviceStub();
    const npm = recordingRun();
    const result = await updater.performUpdate({
      version, deps: { service, runFile: npm, currentVersion: () => from, detectInstallSource: () => SOURCES.npm },
    });
    check(`invalid version refuses before service or npm (${from} to ${version})`,
      result.step === 'version' && result.untouched && !service.calls.length && !npm.commands.length);
  }
  check('accepts a prerelease', updater.isUpdateVersion('1.4.4-rc.2'));
  check('rejects trailing line breaks in stored versions', !updater.isUpdateVersion('1.4.4\\n'));

  check('the comparison handles each position',
    updater.compareVersions('1.10.0', '1.9.0') === 1
    && updater.compareVersions('2.0.0', '1.99.99') === 1
    && updater.compareVersions('1.2.1', '1.2.1') === 0);
  check('prerelease precedence is complete rather than treated as the release',
    updater.compareVersions('1.3.0-rc.1', '1.3.0-rc.2') === -1
      && updater.compareVersions('1.3.0-rc.2', '1.3.0') === -1
      && updater.compareVersions('1.3.0-alpha', '1.3.0-1') === 1);
  check('heartbeat identity includes the prerelease suffix',
    updater.sameVersion('v1.3.0', '1.3.0') === true
      && updater.sameVersion('1.3.0', '1.3.0-rc.2') === false
      && updater.sameVersion(undefined, '1.3.0') === false);
}

// ─── 7. The Hub explanation ──────────────────────────────────────────────────

async function testWhyCliOnly() {
  setGroup('7. the explanation names where the update CAN be run');

  const updater = await import(srcUrl('core/updater.js'));
  const lines = updater.whyCliOnly().join(' ');

  check('it names the Hub as the caller that cannot', /Hub cannot/.test(lines), lines);
  check('and points at the dashboard and this command',
    /Settings > Update/.test(lines) && /ezz update/.test(lines), lines);
  check('with the actual reason, not a policy',
    /being replaced/.test(lines) && /report/.test(lines), lines);
  check('the explanation is ASCII-only',
    [...lines].every((c) => c.charCodeAt(0) <= 126));

  // The CLI prints it on every run, so it has to be short enough to read.
  check('it is three lines or fewer', updater.whyCliOnly().length <= 3,
    String(updater.whyCliOnly().length));
}

// ─── 8. A Windows Server edition with no service registered ─────────────────

async function testServerEditionNoService() {
  setGroup('8. a Windows Server with no service is updated without one');

  const updater = await import(srcUrl('core/updater.js'));
  const dataDir = scratch('upd-server-none');
  const logs = [];
  const calls = [];
  const npm = recordingRun({ 'npm install': 'installed' });
  const service = {
    async status() { calls.push('status'); return { service: { installed: false }, mode: 'server' }; },
    async stop() { calls.push('stop'); return { ok: true }; },
    async start() { calls.push('start'); return { ok: true }; },
    async waitForDaemon() { calls.push('wait'); return { alive: true, lock: { version: '1.4.8' } }; },
    async repair() { calls.push('repair'); return { ok: true }; },
    recordedState() { return {}; },
  };

  const result = await updater.performUpdate({
    version: '1.4.8',
    dataDir,
    log: (line) => logs.push(line),
    deps: {
      runFile: npm,
      service,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.4.6',
      // A non-elevated terminal: with no service to replace, elevation is not
      // needed, so this must not stop the update.
      isElevated: async () => false,
      serviceInstallState: async () => ({
        registered: false,
        edition: 'server',
        personalLauncher: { present: false, files: [] },
      }),
      runPostUpdate: async () => { calls.push('post-update'); return { ok: true }; },
      runRepair: async () => { calls.push('repair'); return { ok: true }; },
    },
  });

  check('the update succeeds', result.ok === true, result.reason ?? '');
  check('the package itself was replaced',
    npm.commands.includes('npm install -g easy-devops@1.4.8'), npm.commands.join(' | '));
  check('the not-installed line is printed exactly once',
    logs.filter((line) => line === updater.NOT_INSTALLED_SERVER_LINE).length === 1,
    logs.join(' | '));
  check('it says the command and shell that install the service',
    /ezz service install/.test(result.notInstalledLine)
      && /Administrator PowerShell/.test(result.notInstalledLine),
    result.notInstalledLine);
  check('nothing is stopped, prepared or started', calls.join(',') === 'status', calls.join(' -> '));
  check('no Personal launcher or repair is used', !calls.includes('repair')
    && !/startup-supervisor|Startup-folder/i.test(logs.join('\n')), calls.join(' -> '));
  check('the elevation gate does not fire for a Server edition that has no service',
    result.step !== 'elevation' && result.ok === true);
  check('it is reported as a package update, not as a failure',
    result.serviceInstalled === false && result.rolledBack === undefined, JSON.stringify(result).slice(0, 180));
  check('the result carries the line for a dashboard caller',
    result.notInstalledLine === updater.NOT_INSTALLED_SERVER_LINE
      && result.lines?.includes(updater.NOT_INSTALLED_SERVER_LINE));

  // A status shape from the previous release still says "installed", and the
  // start is what discovers the truth. That is not a rollback either. No
  // install-state probe is supplied here, so nothing knows in advance.
  const staleCalls = [];
  const stale = serviceStub({ installed: true, mode: 'server', version: '1.4.6' });
  stale.start = async () => {
    stale.calls.push('start');
    return { ok: false, code: 'not_installed', message: 'no service registered' };
  };
  const waitCalls = [];
  stale.waitForDaemon = async () => {
    waitCalls.push('wait');
    return { alive: false, waitedMs: 0, lock: null };
  };
  const staleNpm = recordingRun({ 'npm install': 'installed' });
  const staleLogs = [];
  const staleResult = await updater.performUpdate({
    version: '1.4.8',
    dataDir: scratch('upd-server-none-stale'),
    log: (line) => staleLogs.push(line),
    deps: {
      runFile: staleNpm,
      service: stale,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.4.6',
      isElevated: async () => true,
      ...transactionDeps(staleCalls),
    },
  });
  check('a service start that reports not_installed ends as a package-only success',
    staleResult.ok === true && staleResult.serviceInstalled === false,
    staleResult.reason ?? '');
  check('the not-installed line is printed in that case too',
    staleLogs.includes(updater.NOT_INSTALLED_SERVER_LINE), staleLogs.join(' | '));
  check('there is no heartbeat wait for a service that does not exist',
    waitCalls.length === 0, waitCalls.join(' -> '));
  check('and it never rolls back to the previous package',
    !staleNpm.commands.includes('npm install -g easy-devops@1.4.6'), staleNpm.commands.join(' | '));
  check('the update snapshot is still committed, so no journal is left',
    staleCalls.includes('commit'), staleCalls.join(' -> '));

  // A deadline that is not a number cannot become setTimeout(Infinity).
  const timeouts = [];
  const waiting = serviceStub({ installed: true, mode: 'personal' });
  waiting.waitForDaemon = async ({ timeoutMs }) => {
    timeouts.push(timeoutMs);
    return { alive: true, waitedMs: 10, lock: { version: '1.4.8' } };
  };
  const timed = await updater.performUpdate({
    version: '1.4.8',
    dataDir: scratch('upd-server-none-deadline'),
    verifyMs: Infinity,
    deps: {
      runFile: recordingRun({ 'npm install': 'installed' }),
      service: waiting,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.4.6',
      ...transactionDeps([]),
    },
  });
  check('a non-finite verify deadline becomes a finite one',
    timed.ok === true && timeouts.length === 1 && Number.isFinite(timeouts[0]) && timeouts[0] > 0,
    String(timeouts[0]));
}

// ─── 9. A failed post-update protection pass ────────────────────────────────

async function testPostUpdateProtectionFailure() {
  setGroup('9. a failed post-update protection says what happened and what to run');

  const { applyPostUpdate, permissionsFailureReason } = await import(srcUrl('core/service/postUpdate.js'));
  const { postUpdateCommand } = await import(srcUrl('cli/menus/postUpdate.js'));
  const dataDir = scratch('upd-protect-fail');
  const runtimeDir = path.join(dataDir, 'runtime');
  const failure = {
    path: runtimeDir,
    reason: 'verifying the new permissions failed: runtime\\node.exe is missing from the read-back',
    restored: true,
    next: 'Run `ezz service repair` from an Administrator PowerShell',
  };

  let protectMode = null;
  const dataDirDeps = {
    installedPackageVersion: () => '1.4.8',
    recoverInterruptedUpdate: async () => ({ ok: true, recovered: false }),
    copyRuntime: (opts) => ({ ok: true, dir: runtimeDir, nodeExe: opts.nodeExe }),
    verifyNativeModules: async () => ({ ok: true, version: 'v22.11.0', abi: '127' }),
    protectServiceFiles: async (opts) => {
      protectMode = opts.mode;
      return { ok: false, protected: [], failed: [failure] };
    },
  };

  const failed = await applyPostUpdate({
    dataDir,
    mode: 'server',
    mechanism: 'winsw',
    targetVersion: '1.4.8',
    deps: dataDirDeps,
  });
  check('the failure is reported at the permissions step',
    failed.ok === false && failed.step === 'permissions', failed.step);
  check('every protection call passes the post-update mode', protectMode === 'post-update', String(protectMode));
  check('the reason says the previous permissions were restored', /restored/i.test(failed.reason), failed.reason);
  check('and names the repair command from an Administrator PowerShell',
    /ezz service repair/.test(failed.reason) && /Administrator PowerShell/.test(failed.reason),
    failed.reason);
  check('the result carries the next step for the updater',
    /ezz service repair/.test(String(failed.next)), String(failed.next));
  check('the per-entry state is what makes the wording true',
    failed.restored === true
      && /restored/i.test(permissionsFailureReason([failure]))
      && /NOT restored/i.test(permissionsFailureReason([{ ...failure, restored: false }])));

  // The hidden command is what the updater streams, so the operator sees this.
  let printed = '';
  const code = await postUpdateCommand({
    env: {
      EASY_DEVOPS_DATA_DIR: dataDir,
      EZ_UPDATE_MODE: 'server',
      EZ_UPDATE_MECHANISM: 'winsw',
      EZ_UPDATE_TARGET: '1.4.8',
    },
    stdout: {
      write: (chunk, callback) => {
        printed += chunk;
        callback?.();
        return true;
      },
    },
    deps: dataDirDeps,
  });
  check('the hidden command exits non-zero', code === 1, String(code));
  check('it prints the reason, the restore state and the next step',
    /The post-update step failed \(permissions\)/.test(printed)
      && /restored/i.test(printed)
      && /ezz service repair/.test(printed),
    printed.split('\n').filter(Boolean).slice(-2).join(' | '));

  // And a stop request left over from an earlier stop is cleared first.
  const stopDataDir = scratch('upd-protect-fail-stop');
  const stopFile = path.join(stopDataDir, 'daemon.stop');
  fs.writeFileSync(stopFile, JSON.stringify({ at: new Date().toISOString(), reason: 'ezz service stop' }));
  const stopLogs = [];
  const stopResult = await applyPostUpdate({
    dataDir: stopDataDir,
    mode: 'server',
    mechanism: 'winsw',
    targetVersion: '1.4.8',
    log: (line) => stopLogs.push(line),
    deps: {
      ...dataDirDeps,
      protectServiceFiles: async () => ({ ok: true, protected: [], failed: [] }),
      refreshServiceDefinition: () => {},
    },
  });
  check('a stale stop request is cleared before the runtime copy',
    stopResult.ok === true && !fs.existsSync(stopFile)
      && stopLogs.some((line) => /stop request/i.test(line)),
    stopLogs.join(' | '));
}

// ─── 10. The npm failure excerpt is the end of the output ───────────────────

async function testNpmFailureExcerpt() {
  setGroup('10. a failing npm install is quoted by its last 500 characters');

  const updater = await import(srcUrl('core/updater.js'));
  const early = 'EARLY-BANNER-THAT-NOBODY-NEEDS';
  const late = 'npm ERR! the real reason, printed last';
  const stdout = `${early}\n${'x'.repeat(200 * 1024)}\n${late}`;
  const npm = async (file, args) => {
    const command = npmCommand(file, args);
    if (command.includes('@1.4.8')) {
      return {
        success: false,
        stdout,
        stderr: '',
        exitCode: 1,
        command,
        // What core/shell.js reports when it had to cap the capture.
        truncated: { stdout: 123_456, stderr: 0 },
      };
    }
    return { success: true, stdout: 'installed', stderr: '', exitCode: 0, command };
  };

  const result = await updater.performUpdate({
    version: '1.4.8',
    dataDir: scratch('upd-excerpt'),
    deps: {
      runFile: npm,
      service: serviceStub({ installed: true, mode: 'personal', version: '1.4.7' }),
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.4.7',
      ...transactionDeps([]),
    },
  });

  check('the update fails at the install step',
    result.ok === false && result.step === 'install', result.step);
  check('the quoted output is the END of npm output',
    /the real reason, printed last/.test(result.reason), result.reason.slice(0, 300));
  check('the first 500 characters are not what is quoted',
    !result.reason.includes(early), result.reason.slice(0, 200));
  check('the excerpt says it is the last 500 characters',
    /\(last 500 characters\)/.test(result.reason), result.reason.slice(0, 200));
  check('dropped bytes are reported rather than hidden',
    /123456 earlier byte\(s\) were dropped/.test(result.reason), result.reason.slice(0, 300));
}

// ─── 11. The post-update marker, however much the child prints ──────────────

async function testPostUpdateMarkerIsFound() {
  setGroup('11. the post-update marker is found in a long output');

  const updater = await import(srcUrl('core/updater.js'));
  const dataDir = scratch('upd-long-marker');
  const sourceRoot = scratch('upd-long-marker-package');
  const marker = `${updater.POST_UPDATE_RESULT_PREFIX}${JSON.stringify({
    ok: true,
    step: 'definition',
    version: '1.4.8',
  })}`;
  const noise = 'runtime progress line\n'.repeat(10_000); // ~230 KB

  // (a) The marker is printed first and the output carries on for 200 KB.
  let invocation = null;
  const exec = async (file, args, options) => {
    invocation = { file, args, options };
    return {
      success: true,
      stdout: `${marker}\n${noise}`,
      stderr: '',
      exitCode: 0,
      truncated: { stdout: 0, stderr: 0 },
    };
  };
  const found = await updater.runPostUpdateHandoff({
    sourceRoot, version: '1.4.8', dataDir, runFile: exec,
  });
  check('a marker printed before 200 KB of progress is still found',
    found.ok === true && found.version === '1.4.8', JSON.stringify(found).slice(0, 200));
  check('the child output is read whole, not as a 64 KiB tail',
    invocation.options.output === 'full'
      && invocation.options.maxBytes >= 8 * 1024 * 1024,
    JSON.stringify({ output: invocation.options.output, maxBytes: invocation.options.maxBytes }));
  check('the hand-off keeps a finite timeout',
    Number.isFinite(invocation.options.timeout) && invocation.options.timeout > 0,
    String(invocation.options.timeout));

  // (b) The marker arrives in the stream, split across two chunks, with more
  // output after it and nothing in the captured result.
  const lines = [];
  const streamExec = async (file, args, options) => {
    options.onData(`${noise}${marker.slice(0, 9)}`, 'stdout');
    options.onData(`${marker.slice(9)}\n${noise}`, 'stdout');
    return { success: true, stdout: '', stderr: '', exitCode: 0, truncated: { stdout: 0, stderr: 0 } };
  };
  const streamed = await updater.runPostUpdateHandoff({
    sourceRoot,
    version: '1.4.8',
    dataDir,
    runFile: streamExec,
    log: (line) => lines.push(line),
  });
  check('a marker split across streamed chunks is found',
    streamed.ok === true && streamed.version === '1.4.8', JSON.stringify(streamed).slice(0, 200));
  check('the marker line itself is not reprinted as progress',
    !lines.some((line) => line.includes(updater.POST_UPDATE_RESULT_PREFIX)),
    lines.slice(-2).join(' | '));
  check('progress lines from the new package reach the operator',
    lines.some((line) => /runtime progress line/.test(line)), String(lines.length));

  // (c) No marker and a capped capture: say that output was dropped.
  const missing = await updater.runPostUpdateHandoff({
    sourceRoot,
    version: '1.4.8',
    dataDir,
    runFile: async () => ({
      success: false, stdout: '', stderr: '', exitCode: 1, truncated: { stdout: 999, stderr: 0 },
    }),
  });
  check('a failure with no marker reports the dropped output',
    missing.ok === false && /999 byte\(s\) of its output were dropped/.test(missing.reason),
    missing.reason);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nUpdater: update Easy DevOps itself\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testClone();
  await testNpmUpdate();
  await testServerCopyRefresh();
  await testUserServiceRefresh();
  await testRollback();
  await testPostUpdateHandoff();
  await testUpdateTransaction();
  await testAbsentArtifacts();
  await testInterruptedUpdate();
  await testWindowsA3Replay();
  await testBrokenRollbackMessage();
  await testPostUpdateFallback();
  await testPostUpdateIdempotent();
  await testNoService();
  await testServerEditionNoService();
  await testPostUpdateProtectionFailure();
  await testNpmFailureExcerpt();
  await testPostUpdateMarkerIsFound();
  await testCheck();
  await testWhyCliOnly();

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
