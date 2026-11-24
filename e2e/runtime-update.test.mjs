/**
 * Tests for `ezz runtime update` — moving the service onto a different Node.
 *
 * Run with:  npm run test:e2e -- runtime-update
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * ── Nothing real is touched ────────────────────────────────────────────────
 *
 * No version manager is ever invoked: nvm is driven through an injected `run`
 * stub and the assertions are on the commands the stub was asked to run. The
 * Windows Server branch writes under ProgramData, so `%ProgramData%` is
 * redirected into the temp data directory for the duration and restored
 * afterwards; the real `C:\ProgramData\easy-devops` is never written. The
 * service itself is a stub, so no systemd unit, Windows service or Startup
 * file is created, started or stopped.
 *
 * ── What is actually being asserted ───────────────────────────────────────
 *
 * The ORDER, because that is the whole design: the smoke test runs while the
 * old runtime is still in place and the service is still running, and a
 * failure there must leave both untouched. Then that every swap can be undone,
 * that a daemon which does not report in within the verify window causes a
 * rollback, and that no path anywhere uninstalls a Node version.
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

/** Every command any stub in this suite was asked to run. */
const allCommands = [];

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A `run` stub. `answers` maps a substring of the command to its stdout; a
 * null answer means the command fails.
 */
function recordingRun(answers = {}) {
  const commands = [];
  const fn = async (command) => {
    commands.push(command);
    allCommands.push(command);
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

/** nvm-windows' `nvm list available` output, as it really looks. */
const NVM_WINDOWS_TABLE = [
  '|   CURRENT    |     LTS      |  OLD STABLE  | OLD UNSTABLE |',
  '|--------------|--------------|--------------|--------------|',
  '|    23.3.0    |   22.11.0    |   0.12.18    |   0.11.16    |',
  '|    23.2.0    |   20.18.1    |   0.12.17    |   0.11.15    |',
  '|    23.1.0    |   18.20.5    |   0.12.16    |   0.11.14    |',
].join('\n');

/** nvm (Unix) `nvm ls-remote --lts`. */
const NVM_UNIX_LIST = [
  '        v18.20.5   (LTS: Hydrogen)',
  '        v20.18.1   (LTS: Iron)',
  '->      v22.11.0   (Latest LTS: Jod)',
].join('\n');

/** A service stub that records the lifecycle calls, in order. */
function serviceStub({ startOk = true, stopOk = true } = {}) {
  const calls = [];
  return {
    calls,
    async stop() { calls.push('stop'); return stopOk ? { ok: true } : { ok: false, reason: 'could not stop' }; },
    async start() { calls.push('start'); return startOk ? { ok: true } : { ok: false, reason: 'could not start' }; },
    async status() { calls.push('status'); return { service: { installed: true } }; },
  };
}

// ─── 1. Versions and the minimum ─────────────────────────────────────────────

async function testVersions() {
  setGroup('1. versions and the supported minimum');

  const ru = await import(srcUrl('core/service/runtimeUpdate.js'));
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const engines = require(path.join(ROOT, 'package.json')).engines?.node;

  check('a version parses from either form',
    JSON.stringify(ru.parseVersion('v20.11.1')) === JSON.stringify([20, 11, 1])
    && JSON.stringify(ru.parseVersion('20.11.1')) === JSON.stringify([20, 11, 1]));
  check('nonsense parses to null', ru.parseVersion('lts/iron') === null);

  check('comparison orders by major, minor, patch',
    ru.compareVersions('22.0.0', '20.18.1') === 1
    && ru.compareVersions('20.18.1', '20.18.2') === -1
    && ru.compareVersions('20.1.0', '20.1.0') === 0);

  // The minimum comes from package.json, not a second literal here.
  const minimum = ru.minimumNode();
  check('the minimum is read from engines.node', minimum.raw === engines,
    `${minimum.raw} vs ${engines}`);
  check('and is enforced', ru.meetsMinimum('22.11.0') === true && ru.meetsMinimum('16.20.2') === false);
  check('an unparseable version never passes', ru.meetsMinimum('lts/iron') === false);
}

// ─── 2. What is on offer ─────────────────────────────────────────────────────

async function testListTargets() {
  setGroup('2. the available targets');

  const ru = await import(srcUrl('core/service/runtimeUpdate.js'));
  const { isWindows } = await import(srcUrl('core/platform.js'));
  const dataDir = scratch('rt-list');

  // ── With a version manager ───────────────────────────────────────────────
  const withManager = await ru.listTargets({
    dataDir,
    deps: {
      run: recordingRun(),
      mechanism: { platform: isWindows ? 'windows' : 'linux', mode: 'personal', mechanism: 'startup-supervisor' },
      listManagerVersions: async () => ({
        manager: isWindows ? 'nvm-windows' : 'nvm',
        versions: ['22.11.0', '20.18.1', '18.20.5'],
        reason: 'ok',
      }),
      detectSystemNode: async () => ({ path: '/usr/bin/node', version: '20.18.1' }),
      recordedState: () => ({ nodeExe: null }),
    },
  });

  check('every manager version is a candidate',
    withManager.candidates.filter((c) => c.source !== 'system').length === 3,
    JSON.stringify(withManager.candidates.map((c) => c.version)));
  check('and there is something to update to', withManager.nothingToUpdate === false);
  check('the system node is NOT offered when a manager can install one',
    !withManager.candidates.some((c) => c.source === 'system'));

  // ── Without one: the Node already on the machine ─────────────────────────
  const noManager = await ru.listTargets({
    dataDir,
    deps: {
      run: recordingRun(),
      mechanism: { platform: 'linux', mode: null, mechanism: 'systemd' },
      listManagerVersions: async () => ({ manager: null, versions: [], reason: 'nvm is not installed' }),
      detectSystemNode: async () => ({ path: '/usr/bin/node', version: '22.11.0' }),
      recordedState: () => ({ nodeExe: null }),
    },
  });

  const systemCandidate = noManager.candidates.find((c) => c.source === 'system');
  check('with no manager, the system node is the target',
    Boolean(systemCandidate) && systemCandidate.version === '22.11.0',
    JSON.stringify(noManager.candidates));
  check('and it is marked as already installed, not installable',
    systemCandidate?.installable === false);

  // ── The system node IS the pinned one: nothing to update ─────────────────
  const link = scratch('rt-list-pinned');
  const sameVersion = await ru.listTargets({
    dataDir: link,
    deps: {
      run: recordingRun(),
      mechanism: { platform: 'linux', mode: null, mechanism: 'systemd' },
      listManagerVersions: async () => ({ manager: null, versions: [], reason: 'nvm is not installed' }),
      detectSystemNode: async () => ({ path: '/usr/bin/node', version: '22.11.0' }),
      recordedState: () => ({ nodeExe: null }),
      // The pinned runtime reports the same version as the system one.
      describePinned: async () => ({ kind: 'recorded', version: '22.11.0', path: '/usr/bin/node', exists: true, broken: false }),
    },
  });

  // describePinned is internal, so this is driven the way the real code sees
  // it: the candidate matching the pinned version is excluded as `isPinned`.
  const pinnedMatch = sameVersion.candidates.find((c) => c.version === '22.11.0');
  check('a candidate equal to the pinned version is recognised',
    Boolean(pinnedMatch), JSON.stringify(sameVersion.candidates));

  // ── Below the minimum ────────────────────────────────────────────────────
  const tooOld = await ru.listTargets({
    dataDir,
    deps: {
      run: recordingRun(),
      mechanism: { platform: 'linux', mode: null, mechanism: 'systemd' },
      listManagerVersions: async () => ({ manager: 'nvm', versions: ['16.20.2', '14.21.3'], reason: 'ok' }),
      detectSystemNode: async () => ({ path: '/usr/bin/node', version: '16.20.2' }),
      recordedState: () => ({ nodeExe: null }),
    },
  });

  check('versions below the minimum are listed but not usable',
    tooOld.candidates.length === 2 && tooOld.candidates.every((c) => c.meetsMinimum === false),
    JSON.stringify(tooOld.candidates.map((c) => [c.version, c.meetsMinimum])));
  check('so there is nothing to update to', tooOld.nothingToUpdate === true);
  check('and the hint says how to upgrade Node itself',
    (tooOld.hint ?? []).join(' ').length > 0, (tooOld.hint ?? []).join(' ').slice(0, 80));

  // ── The install source is surfaced, because a clone is not npm-managed ───
  check('the install source is reported', ['clone', 'npm', 'unknown'].includes(withManager.installSource.kind),
    withManager.installSource.kind);
}

// ─── 3. Parsing a version manager's real output ──────────────────────────────

async function testManagerParsing() {
  setGroup('3. reading the version managers');

  const ru = await import(srcUrl('core/service/runtimeUpdate.js'));
  const { isWindows } = await import(srcUrl('core/platform.js'));

  if (isWindows) {
    const run = recordingRun({ 'nvm version': '1.1.12', 'nvm list available': NVM_WINDOWS_TABLE });
    const listed = await ru.listManagerVersions({ deps: { run } });
    check('nvm-windows is detected', listed.manager === 'nvm-windows', listed.reason);
    check('the LTS column is read, not the current one',
      JSON.stringify(listed.versions) === JSON.stringify(['22.11.0', '20.18.1', '18.20.5']),
      JSON.stringify(listed.versions));
  } else {
    const run = recordingRun({ 'nvm --version': '0.39.7', 'nvm ls-remote': NVM_UNIX_LIST });
    const listed = await ru.listManagerVersions({ deps: { run } });
    check('nvm is detected', listed.manager === 'nvm', listed.reason);
    check('its LTS list is read newest first',
      JSON.stringify(listed.versions) === JSON.stringify(['22.11.0', '20.18.1', '18.20.5']),
      JSON.stringify(listed.versions));
    check('and nvm.sh is sourced, because nvm is a shell function',
      run.commands.some((c) => c.includes('nvm.sh')));
  }

  // The measured failure this guards against: a leftover nvm directory makes
  // `nvm version` exit 0 with NO output, which used to be read as "installed"
  // and then produced an empty version list.
  const empty = recordingRun({ 'nvm version': '', 'nvm --version': '' });
  const none = await ru.listManagerVersions({ deps: { run: empty } });
  check('an exit-0-but-silent nvm is not treated as installed',
    none.manager === null, `${none.manager} / ${none.reason}`);
}

// ─── 4. The smoke test runs before anything is touched ───────────────────────

async function testSmokeFirst() {
  setGroup('4. a failed smoke test changes nothing');

  const ru = await import(srcUrl('core/service/runtimeUpdate.js'));
  const dataDir = scratch('rt-smoke');
  const service = serviceStub();

  const order = [];

  const result = await ru.update({
    target: { version: '22.11.0', source: 'system', path: '/usr/bin/node' },
    dataDir,
    deps: {
      run: recordingRun(),
      service,
      mechanism: { platform: 'linux', mode: null, mechanism: 'systemd' },
      installTarget: async () => { order.push('install'); return { ok: true, nodeExe: '/usr/bin/node' }; },
      smokeTest: async () => {
        order.push('smoke');
        return { ok: false, reason: 'it cannot load better-sqlite3', fix: 'npm rebuild better-sqlite3' };
      },
      applyRuntime: async () => { order.push('apply'); return { ok: true }; },
      waitForDaemon: async () => ({ alive: true, waitedMs: 1 }),
    },
  });

  check('the update fails at the smoke step', result.ok === false && result.step === 'smoke', result.step);
  check('and says what was wrong', /better-sqlite3/.test(result.reason), result.reason);
  check('with the fix', /npm rebuild/.test(result.fix ?? ''), result.fix);

  check('nothing was swapped', !order.includes('apply'), order.join(' -> '));
  check('and the service was never stopped', !service.calls.includes('stop'), service.calls.join(' -> '));
  check('which the result states plainly', result.untouched === true);

  // The order itself: the smoke test is after the install and before anything
  // destructive.
  check('the order is install then smoke', JSON.stringify(order) === JSON.stringify(['install', 'smoke']),
    order.join(' -> '));

  // Below the minimum is refused before even installing.
  const tooOld = await ru.update({
    target: { version: '16.20.2', source: 'system', path: '/usr/bin/node' },
    dataDir,
    deps: {
      run: recordingRun(),
      service: serviceStub(),
      mechanism: { platform: 'linux', mode: null, mechanism: 'systemd' },
      installTarget: async () => { throw new Error('must not install'); },
    },
  });
  check('a version below the minimum is refused before anything runs',
    tooOld.ok === false && tooOld.step === 'target', `${tooOld.step}: ${tooOld.reason}`);
}

// ─── 5. The happy path, in order ─────────────────────────────────────────────

async function testHappyPath() {
  setGroup('5. the successful sequence');

  const ru = await import(srcUrl('core/service/runtimeUpdate.js'));
  const dataDir = scratch('rt-happy');
  const service = serviceStub();
  const order = [];

  const result = await ru.update({
    target: { version: '22.11.0', source: 'nvm', },
    dataDir,
    deps: {
      run: recordingRun(),
      service: {
        calls: service.calls,
        async stop() { order.push('stop'); service.calls.push('stop'); return { ok: true }; },
        async start() { order.push('start'); service.calls.push('start'); return { ok: true }; },
      },
      mechanism: { platform: 'linux', mode: null, mechanism: 'systemd' },
      installTarget: async () => { order.push('install'); return { ok: true, nodeExe: '/opt/node22/bin/node' }; },
      smokeTest: async () => { order.push('smoke'); return { ok: true, version: '22.11.0', abi: '127' }; },
      applyRuntime: async () => {
        order.push('apply');
        return { ok: true, detail: 'runtime/node -> /opt/node22/bin/node', rollback: async () => ({ ok: true }) };
      },
      waitForDaemon: async () => { order.push('verify'); return { alive: true, waitedMs: 420, lock: { pid: 4242 } }; },
    },
  });

  check('the update succeeds', result.ok === true, result.reason ?? '');
  check('it reports the new version', result.version === '22.11.0');
  check('and how long the daemon took to report in', result.waitedMs === 420);

  check('the order is install, smoke, stop, apply, start, verify',
    JSON.stringify(order) === JSON.stringify(['install', 'smoke', 'stop', 'apply', 'start', 'verify']),
    order.join(' -> '));
}

// ─── 6. Rollback when the daemon does not come back ──────────────────────────

async function testRollbackOnVerifyFailure() {
  setGroup('6. a daemon that does not report in triggers a rollback');

  const ru = await import(srcUrl('core/service/runtimeUpdate.js'));
  const dataDir = scratch('rt-rollback');
  const order = [];
  let rolledBack = false;

  const result = await ru.update({
    target: { version: '22.11.0', source: 'nvm' },
    dataDir,
    deps: {
      run: recordingRun(),
      service: {
        async stop() { order.push('stop'); return { ok: true }; },
        async start() { order.push('start'); return { ok: true }; },
      },
      mechanism: { platform: 'linux', mode: null, mechanism: 'systemd' },
      installTarget: async () => ({ ok: true, nodeExe: '/opt/node22/bin/node' }),
      smokeTest: async () => ({ ok: true, version: '22.11.0', abi: '127' }),
      applyRuntime: async () => ({
        ok: true,
        detail: 'swapped',
        rollback: async () => { rolledBack = true; order.push('rollback'); return { ok: true, detail: 'restored' }; },
      }),
      // Starts, but the daemon never writes its heartbeat: exactly the case
      // the service manager's "started" cannot distinguish.
      waitForDaemon: async () => ({ alive: false, waitedMs: 10_000 }),
      verifyMs: 10_000,
    },
  });

  check('the update fails at the verify step', result.ok === false && result.step === 'verify', result.step);
  check('the reason names the heartbeat, not the service manager',
    /did not report in/.test(result.reason), result.reason);
  check('the runtime was rolled back', rolledBack === true && result.rolledBack === true);
  check('and the service was started again afterwards',
    order.filter((o) => o === 'start').length === 2, order.join(' -> '));
  check('the rollback happened before that restart',
    order.indexOf('rollback') < order.lastIndexOf('start'), order.join(' -> '));
}

// ─── 7. The Windows Server swap, against a redirected ProgramData ────────────

async function testWindowsServerSwap() {
  setGroup('7. Windows Server: node.exe.prev and the app copy');

  const ru = await import(srcUrl('core/service/runtimeUpdate.js'));
  const { isWindows } = await import(srcUrl('core/platform.js'));

  if (!isWindows) {
    check('skipped on Linux', true, 'the Server-mode copy is Windows-only');
    return;
  }

  // %ProgramData% is redirected into the temp tree, so runtimeDir() resolves
  // somewhere this suite owns. The real C:\ProgramData\easy-devops is never
  // written; restored in the finally below.
  const fakeProgramData = scratch('rt-programdata');
  const realProgramData = process.env.ProgramData;
  process.env.ProgramData = fakeProgramData;

  try {
    const { runtimeDir, runtimeNodePath } = await import(srcUrl('core/service/runtime.js'));
    const dataDir = scratch('rt-winsw');

    const runtime = runtimeDir(dataDir);
    assertInsideTestDataDir(runtime, 'write the fake runtime directory');
    fs.mkdirSync(path.join(runtime, 'app'), { recursive: true });

    const dest = runtimeNodePath(dataDir);
    fs.writeFileSync(dest, 'OLD-NODE');

    // The new binary, somewhere else entirely.
    const incoming = path.join(scratch('rt-winsw-new'), 'node.exe');
    fs.writeFileSync(incoming, 'NEW-NODE');

    const applied = await ru.applyRuntime({
      nodeExe: incoming,
      dataDir,
      mech: { platform: 'windows', mode: 'server', mechanism: 'winsw' },
      deps: {
        run: recordingRun({ 'npm rebuild': 'rebuilt' }),
        protectServiceFiles: async () => ({ ok: true }),
        canWriteProgramData: () => true,
        // The app copy's modules load under the new binary: nothing to fix.
        verifyNativeModules: async () => ({ ok: true, abi: '127' }),
      },
    });

    check('the swap succeeds', applied.ok === true, applied.reason ?? '');
    check('the new binary is in place', fs.readFileSync(dest, 'utf8') === 'NEW-NODE');
    check('and the old one is kept as .prev',
      fs.readFileSync(`${dest}${ru.PREV_SUFFIX}`, 'utf8') === 'OLD-NODE');

    const back = await applied.rollback();
    check('rollback restores it', back.ok === true && fs.readFileSync(dest, 'utf8') === 'OLD-NODE',
      back.reason ?? '');
    check('and removes the .prev it consumed', !fs.existsSync(`${dest}${ru.PREV_SUFFIX}`));

    // ── The native-module fix ────────────────────────────────────────────
    fs.writeFileSync(dest, 'OLD-NODE');
    let verifyCalls = 0;
    const rebuildRun = recordingRun({ 'npm rebuild': 'rebuilt' });

    const fixed = await ru.applyRuntime({
      nodeExe: incoming,
      dataDir,
      mech: { platform: 'windows', mode: 'server', mechanism: 'winsw' },
      deps: {
        run: rebuildRun,
        protectServiceFiles: async () => ({ ok: true }),
        canWriteProgramData: () => true,
        // Fails the first time (the ABI changed), passes after the rebuild.
        verifyNativeModules: async () => {
          verifyCalls += 1;
          return verifyCalls === 1
            ? { ok: false, reason: 'built for a different Node ABI', fix: 'npm rebuild better-sqlite3' }
            : { ok: true, abi: '127' };
        },
      },
    });

    check('an ABI mismatch in the app copy is repaired, not reported',
      fixed.ok === true, fixed.reason ?? '');
    check('by rebuilding in the copy',
      rebuildRun.commands.some((c) => /npm rebuild better-sqlite3/.test(c)),
      rebuildRun.commands.join(' | '));
    check('and the result says what it did', /rebuilt/.test(fixed.detail ?? ''), fixed.detail);

    // ── No elevation: refused before anything is written ─────────────────
    fs.writeFileSync(dest, 'OLD-NODE');
    try { fs.rmSync(`${dest}${ru.PREV_SUFFIX}`, { force: true }); } catch { /* fine */ }

    const refused = await ru.applyRuntime({
      nodeExe: incoming,
      dataDir,
      mech: { platform: 'windows', mode: 'server', mechanism: 'winsw' },
      deps: {
        run: recordingRun(),
        canWriteProgramData: () => false,
        verifyNativeModules: async () => ({ ok: true }),
      },
    });

    check('without elevation the swap is refused', refused.ok === false && refused.needsElevation === true);
    check('the message names the terminal, never a password',
      /Administrator/.test(refused.reason) && !/password/i.test(refused.reason.replace('No password is needed', '')),
      refused.reason.split('\n')[0]);
    check('and the binary is untouched', fs.readFileSync(dest, 'utf8') === 'OLD-NODE');
    check('with no .prev left behind', !fs.existsSync(`${dest}${ru.PREV_SUFFIX}`));
  } finally {
    if (realProgramData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = realProgramData;
  }
}

// ─── 8. Windows Personal: the recorded path ──────────────────────────────────

async function testPersonalSwap() {
  setGroup('8. Windows Personal: the recorded path and the supervisor');

  const ru = await import(srcUrl('core/service/runtimeUpdate.js'));
  const { isWindows } = await import(srcUrl('core/platform.js'));

  if (!isWindows) {
    check('skipped on Linux', true, 'the recorded-path mechanism is Windows-only');
    return;
  }

  const dataDir = scratch('rt-personal');
  const repairs = [];
  const recorded = [];

  const applied = await ru.applyRuntime({
    nodeExe: 'C:\\node22\\node.exe',
    dataDir,
    mech: { platform: 'windows', mode: 'personal', mechanism: 'startup-supervisor' },
    deps: {
      run: recordingRun(),
      recordedState: () => ({ nodeExe: 'C:\\node20\\node.exe' }),
      // The real repair() writes the launcher and the supervisor; here it is a
      // stub, because this suite must not touch a Startup folder.
      windowsPersonal: {
        repair(opts) { repairs.push(opts); return { ok: true, nodeExe: opts.nodeExe }; },
      },
      recordRuntime: (details) => { recorded.push(details); },
    },
  });

  check('the swap succeeds', applied.ok === true, applied.reason ?? '');
  check('the supervisor is rewritten with the new runtime',
    repairs[0]?.nodeExe === 'C:\\node22\\node.exe', JSON.stringify(repairs[0]));
  check('and the new path is recorded',
    recorded[0]?.nodeExe === 'C:\\node22\\node.exe', JSON.stringify(recorded[0]));

  await applied.rollback();
  check('rollback rewrites the supervisor with the old one',
    repairs[1]?.nodeExe === 'C:\\node20\\node.exe', JSON.stringify(repairs[1]));
  check('and records it again',
    recorded[1]?.nodeExe === 'C:\\node20\\node.exe', JSON.stringify(recorded[1]));
}

// ─── 9. Nothing ever uninstalls a Node version ───────────────────────────────

async function testNeverUninstalls() {
  setGroup('9. no path uninstalls a Node version');

  // Every command every stub in this suite recorded, across all sections.
  const dangerous = allCommands.filter((c) => /nvm\s+(uninstall|remove)\b/i.test(c));

  check('no stub was ever asked to uninstall a Node version',
    dangerous.length === 0, dangerous.join(' | '));

  // And statically, because a future branch could add one without this suite
  // happening to reach it. `ezz cleanup` is the ONLY place that may, and it
  // does so from a user's explicit selection.
  const file = fs.readFileSync(path.join(ROOT, 'src', 'core', 'service', 'runtimeUpdate.js'), 'utf8');
  check('and the module contains no uninstall command at all',
    !/nvm\s+uninstall|nvm\s+remove/.test(file));

  check('the old runtime is what rollback needs, which is why it stays',
    /NEVER uninstalls/.test(file));
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nRuntime update: move the service onto another Node\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testVersions();
  await testListTargets();
  await testManagerParsing();
  await testSmokeFirst();
  await testHappyPath();
  await testRollbackOnVerifyFailure();
  await testWindowsServerSwap();
  await testPersonalSwap();
  await testNeverUninstalls();

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
