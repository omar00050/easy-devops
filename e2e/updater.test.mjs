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

function recordingRun(answers = {}) {
  const commands = [];
  const fn = async (command) => {
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

function serviceStub({ installed = true, mode = 'personal', startOk = true, stopOk = true, alive = true } = {}) {
  const calls = [];
  return {
    calls,
    async status() { calls.push('status'); return { service: { installed }, mode }; },
    async stop() { calls.push('stop'); return stopOk ? { ok: true } : { ok: false, reason: 'could not stop' }; },
    async start() { calls.push('start'); return startOk ? { ok: true } : { ok: false, reason: 'could not start' }; },
    async waitForDaemon() { calls.push('wait'); return { alive, waitedMs: alive ? 300 : 10_000 }; },
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
    deps: { run, service, detectInstallSource: () => SOURCES.clone, currentVersion: () => '1.2.1' },
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
      run: recordingRun(),
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

  const run = async (command) => {
    order.push(`run:${command}`);
    return { success: true, stdout: 'ok', stderr: '', exitCode: 0, command };
  };

  const service = {
    async status() { order.push('status'); return { service: { installed: true }, mode: 'personal' }; },
    async stop() { order.push('stop'); return { ok: true }; },
    async start() { order.push('start'); return { ok: true }; },
    async waitForDaemon() { order.push('wait'); return { alive: true, waitedMs: 250 }; },
  };

  const result = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      run,
      service,
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
      // The daemon reports the new version after the restart, which is the
      // only real proof that the new code is what came up.
      inspectLock: () => ({ lock: { version: '1.3.0' } }),
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
  check('and started again after',
    sequence.lastIndexOf('start') > sequence.indexOf('install'), sequence.join(' -> '));
  check('with the heartbeat waited for last',
    sequence.lastIndexOf('wait') > sequence.lastIndexOf('start'), sequence.join(' -> '));

  check('npm was asked for the exact version',
    order.some((o) => o === 'run:npm install -g easy-devops@1.3.0'),
    order.filter((o) => o.startsWith('run:')).join(' | '));
}

// ─── 3. Windows Server: the runtime copy is refreshed ────────────────────────

async function testServerCopyRefresh() {
  setGroup('3. Windows Server mode refreshes the runtime copy');

  const updater = await import(srcUrl('core/updater.js'));
  const { isWindows } = await import(srcUrl('core/platform.js'));

  if (!isWindows) {
    check('skipped on Linux', true, 'the runtime app copy is Windows-Server-only');
    return;
  }

  const dataDir = scratch('upd-server');
  const copies = [];

  const result = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      run: recordingRun({ 'npm install': 'installed' }),
      service: serviceStub({ installed: true, mode: 'server' }),
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
      inspectLock: () => ({ lock: { version: '1.3.0' } }),
      // Server mode refuses before stopping anything unless this process is
      // elevated; this test is about the runtime copy, not the gate.
      isElevated: async () => true,
      copyRuntime: (opts) => { copies.push(opts); return { ok: true, dir: 'runtime' }; },
    },
  });

  check('the update succeeds', result.ok === true, result.reason ?? '');
  check('the runtime copy was refreshed', copies.length === 1, String(copies.length));
  check('from the package that npm just updated',
    copies[0]?.appRoot === SOURCES.npm.root, copies[0]?.appRoot);
  check('and the result says so', result.refreshedCopy === true);

  // Without this the service keeps running the OLD code from the copy, which
  // is the bug that made this step necessary.
  const failed = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      run: recordingRun({ 'npm install': 'installed' }),
      service: serviceStub({ installed: true, mode: 'server' }),
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
      isElevated: async () => true,
      copyRuntime: () => ({ ok: false, reason: 'ProgramData is not writable' }),
    },
  });

  check('a copy that cannot be refreshed fails the update',
    failed.ok === false && failed.step === 'copy', failed.step);
  check('rather than leaving the service on the old code silently',
    /could not be refreshed/.test(failed.reason), failed.reason);
  check('and it rolls back to the previous version', failed.rolledBack === true);
}

// ─── 4. Rollback ─────────────────────────────────────────────────────────────

async function testRollback() {
  setGroup('4. rollback when the new version does not come up');

  const updater = await import(srcUrl('core/updater.js'));
  const dataDir = scratch('upd-rollback');

  // ── npm itself fails ─────────────────────────────────────────────────────
  const failingNpm = recordingRun({ 'npm install -g easy-devops@1.3.0': null });
  const service = serviceStub();

  const installFailed = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: { run: failingNpm, service, detectInstallSource: () => SOURCES.npm, currentVersion: () => '1.2.1' },
  });

  check('a failing npm install is reported', installFailed.ok === false && installFailed.step === 'install',
    installFailed.step);
  check('and the service is started again', installFailed.restarted === true);

  // ── It installs, but the daemon never reports in ─────────────────────────
  const commands = [];
  const run = async (command) => {
    commands.push(command);
    return { success: true, stdout: 'ok', stderr: '', exitCode: 0, command };
  };

  const verifyFailed = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      run,
      service: serviceStub({ alive: false }),
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
      verifyMs: 10_000,
    },
  });

  check('a daemon that does not report in fails the update',
    verifyFailed.ok === false && verifyFailed.step === 'verify', verifyFailed.step);
  check('the previous version is reinstalled',
    commands.some((c) => c === 'npm install -g easy-devops@1.2.1'),
    commands.join(' | '));
  check('the rollback is reported', verifyFailed.rolledBack === true);
  check('and so is whether the service came back', typeof verifyFailed.restored === 'boolean');

  // ── The service cannot even be stopped: nothing is replaced ──────────────
  const stuck = recordingRun({ 'npm install': 'installed' });
  const cannotStop = await updater.performUpdate({
    version: '1.3.0',
    dataDir,
    deps: {
      run: stuck,
      service: serviceStub({ stopOk: false }),
      detectInstallSource: () => SOURCES.npm,
      currentVersion: () => '1.2.1',
    },
  });

  check('a service that cannot be stopped aborts the update',
    cannotStop.ok === false && cannotStop.step === 'stop', cannotStop.step);
  check('with the package left alone',
    !stuck.commands.some((c) => /npm install/.test(c)), stuck.commands.join(' | '));
  check('and it says nothing was touched', cannotStop.untouched === true);
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
    deps: { run, service, detectInstallSource: () => SOURCES.npm, currentVersion: () => '1.2.1' },
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
    deps: { run: recordingRun({ 'npm view': '1.3.0' }), currentVersion: () => '1.2.1' },
  });
  check('a newer version is reported as available',
    newer.reachable && newer.updateAvailable && newer.latest === '1.3.0',
    JSON.stringify(newer));

  const same = await updater.checkForUpdate({
    deps: { run: recordingRun({ 'npm view': '1.2.1' }), currentVersion: () => '1.2.1' },
  });
  check('the same version is not an update', same.reachable && same.updateAvailable === false);

  const older = await updater.checkForUpdate({
    deps: { run: recordingRun({ 'npm view': '1.1.0' }), currentVersion: () => '1.2.1' },
  });
  check('an older registry version is not an update', older.updateAvailable === false);

  const offline = await updater.checkForUpdate({
    deps: { run: recordingRun({ 'npm view': null }), currentVersion: () => '1.2.1' },
  });
  check('an unreachable registry is reported, not guessed at',
    offline.reachable === false && offline.latest === null && offline.updateAvailable === false,
    JSON.stringify(offline));

  // Garbage from the registry must not be treated as a version.
  const junk = await updater.checkForUpdate({
    deps: { run: recordingRun({ 'npm view': 'npm WARN something' }), currentVersion: () => '1.2.1' },
  });
  check('non-version output is treated as unreachable', junk.reachable === false, JSON.stringify(junk));

  check('the comparison handles each position',
    updater.compareVersions('1.10.0', '1.9.0') === 1
    && updater.compareVersions('2.0.0', '1.99.99') === 1
    && updater.compareVersions('1.2.1', '1.2.1') === 0);
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

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nUpdater: update Easy DevOps itself\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testClone();
  await testNpmUpdate();
  await testServerCopyRefresh();
  await testRollback();
  await testNoService();
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
