/**
 * e2e/service-identity.test.mjs
 *
 * The background service's view of itself — from inside the service.
 *
 * 1.4.8 on a real Windows Server (service RUNNING as NT SERVICE\EasyDevOps)
 * reported `installed: false, starts: not set up` to the Hub. Two causes, both
 * in core/service/index.js:
 *
 *   - `resolveMechanism()` turned an UNKNOWN registration (`registered: null`,
 *     because the daemon never runs `sc query`) into a positive `false`;
 *   - `inspectInstalled()` then trusted that `false` and never looked at the
 *     WinSW wrapper and definition in ProgramData, which the service account
 *     CAN read.
 *
 * This suite runs the status code (a) in a child process with no operator
 * %APPDATA%/%USERPROFILE and a simulated service identity, and (b) in-process
 * with the deps every async entry point already accepts. It also covers the
 * operator record written at install/repair, `primeServiceFacts()`, and the
 * daemon's version-drift answer (unknown, never false, when the installed CLI
 * cannot be read).
 *
 * Run with:  node e2e/run.mjs service-identity
 *
 * Isolation: every file lives under this run's temporary data directory. The
 * WinSW exe+XML and the `.server-mode` marker go into a temporary ProgramData
 * (the redirect core/platform.js allows under EZ_TEST, and only into os.tmpdir);
 * nothing on this machine is registered, started or changed.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

/** A scratch directory inside this run's temporary area only. */
function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'identity', name);
  assertInsideTestDataDir(dir, `create the scratch directory ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A temporary %ProgramData% the EZ_TEST redirect accepts (under os.tmpdir). */
function tempProgramData(name) {
  return scratch(`programdata-${name}`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ─── 1. The cheap state from inside the service (a child process) ────────────

/**
 * The child: a Node process with no operator %APPDATA%/%USERPROFILE, a
 * temporary ProgramData holding the Server-mode marker and the WinSW exe+XML,
 * and a daemon lock it holds with its OWN pid.
 *
 * It simulates the service identity through platform.currentAccount()'s
 * injected `userInfo`, which is the account description the service account
 * provides in production — the real logic decides `serviceAccount`, not a
 * hardcoded flag. Removing the per-user variables is what proves nothing here
 * reads the operator's profile.
 */
function childScript() {
  const file = path.join(scratch('child'), 'service-identity-child.mjs');
  assertInsideTestDataDir(file, 'write the child fixture');
  fs.writeFileSync(file, `
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const src = (rel) => pathToFileURL(path.join(process.env.EZ_SRC_ROOT, 'src', rel)).href;
const platform = await import(src('core/platform.js'));
const locker = await import(src('core/daemon/lock.js'));
const service = await import(src('core/service/index.js'));

const dataDir = platform.getDataDir();
const version = process.env.EZ_LOCK_VERSION;
const acquired = locker.acquire({ dataDir, version, mode: 'daemon' });

let account = null;
if (process.platform === 'win32') {
  // The service account's account description, without needing that token.
  account = platform.currentAccount({
    userInfo: { username: 'EasyDevOps', homedir: 'C:\\\\Windows\\\\ServiceProfiles\\\\EasyDevOps' },
    homedir: 'C:\\\\Windows\\\\ServiceProfiles\\\\EasyDevOps',
  });
}

const state = service.backgroundServiceState({ dataDir, deps: account ? { account } : {} });
const under = platform.runningUnderServiceManager(account ? { account } : {});
const realAccount = platform.currentAccount();

process.stdout.write(JSON.stringify({
  lockAcquired: acquired.ok === true,
  pid: process.pid,
  operatorEnv: {
    APPDATA: process.env.APPDATA ?? null,
    USERPROFILE: process.env.USERPROFILE ?? null,
  },
  account,
  under,
  realAccount,
  dataDir,
  state,
}) + '\\n');

locker.release({ dataDir });
`);
  return file;
}

function runChild({ programData, dataDir, version }) {
  const env = { ...process.env };
  // No per-user profile of the operator reaches the child: this is the shape of
  // a process started by the Windows service manager.
  delete env.APPDATA;
  delete env.LOCALAPPDATA;
  delete env.USERPROFILE;
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  if (!IS_WINDOWS) delete env.HOME;
  // Windows puts a minimal USERPROFILE/HOMEDRIVE pair back into every child
  // process from the token, so the profile is pointed at a path inside this
  // run's temporary area instead — never the operator's own home it inherited.
  const serviceProfile = path.join(programData, 'ServiceProfiles', 'EasyDevOps');
  if (IS_WINDOWS) env.USERPROFILE = serviceProfile;

  env.EZ_TEST = '1';
  env.ProgramData = programData;
  env.EASY_DEVOPS_DATA_DIR = dataDir;
  env.EZ_SRC_ROOT = ROOT;
  env.EZ_LOCK_VERSION = version;
  if (!IS_WINDOWS) env.INVOCATION_ID = 'ez-e2e-service-identity';

  const run = spawnSync(process.execPath, [childScript()], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });

  const line = String(run.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { parsed = null; }
  return { status: run.status, stderr: String(run.stderr ?? ''), parsed, serviceProfile };
}

async function testServiceIdentity() {
  setGroup('1. from inside the service: installed is true, runningAsService is true');

  const LOCK_VERSION = '1.4.8';
  const programData = tempProgramData('service');
  const dataDir = path.join(programData, 'easy-devops');
  assertInsideTestDataDir(dataDir, 'create the simulated Server-mode data directory');

  // The Server-mode marker and the WinSW files, in the temporary ProgramData.
  fs.mkdirSync(path.join(dataDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.server-mode'), '{}\n');
  fs.writeFileSync(path.join(dataDir, 'bin', 'EasyDevOps.exe'), 'MZ::test fixture\n');
  fs.writeFileSync(path.join(dataDir, 'bin', 'EasyDevOps.xml'), '<service/>\n');
  // db.js opens this file; the runner always pre-creates it for a suite.
  fs.writeFileSync(path.join(dataDir, 'easy-devops.sqlite'), '');

  const child = runChild({ programData, dataDir, version: LOCK_VERSION });
  const state = child.parsed?.state ?? {};
  const detail = child.stderr ? child.stderr.split('\n')[0] : JSON.stringify({
    installed: state.installed,
    runningAsService: state.runningAsService,
  });

  check('the child ran the status code to completion',
    child.status === 0 && Boolean(child.parsed), detail);
  check('it really had no operator profile to read',
    child.parsed?.operatorEnv?.APPDATA === null
      && (IS_WINDOWS
        ? child.parsed?.operatorEnv?.USERPROFILE === child.serviceProfile
        : true),
    JSON.stringify(child.parsed?.operatorEnv));
  check('the lock it holds is its own pid',
    child.parsed?.lockAcquired === true && state.pid === child.parsed?.pid,
    JSON.stringify({ lock: child.parsed?.lockAcquired, statePid: state.pid, childPid: child.parsed?.pid }));
  check('the simulated identity is the service account',
    child.parsed?.account?.serviceAccount === true
      && child.parsed?.under === true,
    JSON.stringify(child.parsed?.account));
  check('installed is true, not "not installed"', state.installed === true, String(state.installed));
  check('mode is server', state.mode === 'server', String(state.mode));
  check('mechanism is winsw', state.mechanism === 'winsw', String(state.mechanism));
  check('it starts at boot', state.startsAt === 'boot', String(state.startsAt));
  check('runningAsService is true', state.runningAsService === true, String(state.runningAsService));
  check('running is true', state.running === true, String(state.running));
  check('the data directory is the Server-mode one',
    String(state.dataDir).toLowerCase() === dataDir.toLowerCase(), String(state.dataDir));
  check('the version comes from the daemon lock', state.version === LOCK_VERSION, String(state.version));
}

// ─── 2. The file evidence decides when registration is unknown ───────────────

async function testFileEvidence() {
  setGroup('2. registered unknown: the WinSW files decide; unreadable is unknown');

  if (!IS_WINDOWS) {
    for (const label of [
      'registered null + both WinSW files present is installed',
      'registered null + the XML missing is NOT installed',
      'registered null + unreadable files is UNKNOWN, not false',
      'registered false (sc 1060) is false even with the files on disk',
      'resolveMechanism keeps an unknown registration unknown',
      'a process that is not the service reports runningAsService false',
    ]) check(label, true, 'skipped: Windows only');
    return;
  }

  const service = await import(srcUrl('core/service/index.js'));
  const platform = await import(srcUrl('core/platform.js'));
  const windowsService = await import(srcUrl('core/service/windowsService.js'));

  const previous = process.env.ProgramData;
  const programData = tempProgramData('files');
  process.env.ProgramData = programData;
  platform.resetDataDirCache();

  const dataDir = path.join(programData, 'easy-devops');
  fs.mkdirSync(path.join(dataDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'easy-devops.sqlite'), '');

  const serverMech = (registered) => ({
    platform: 'windows',
    mode: 'server',
    mechanism: 'winsw',
    registered,
  });
  const epermFs = {
    lstatSync() {
      const error = new Error('EPERM: operation not permitted, open EasyDevOps.exe');
      error.code = 'EPERM';
      throw error;
    },
  };

  try {
    writeJson(windowsService.serviceXmlPath(), { service: 'EasyDevOps' });
    fs.writeFileSync(windowsService.winswPath(), 'MZ::test fixture\n');

    const unknown = service.backgroundServiceState({
      dataDir,
      deps: { mechanism: serverMech(null) },
    });
    check('registered null + both WinSW files present is installed',
      unknown.installed === true && unknown.runningAsService === false,
      JSON.stringify({ installed: unknown.installed, runningAsService: unknown.runningAsService }));

    fs.rmSync(windowsService.serviceXmlPath(), { force: true });
    const missing = service.backgroundServiceState({
      dataDir,
      deps: { mechanism: serverMech(null) },
    });
    check('registered null + the XML missing is NOT installed',
      missing.installed === false, String(missing.installed));

    writeJson(windowsService.serviceXmlPath(), { service: 'EasyDevOps' });
    const unreadable = service.backgroundServiceState({
      dataDir,
      deps: { mechanism: serverMech(null), fs: epermFs },
    });
    check('registered null + unreadable files is UNKNOWN, not false',
      unreadable.installed === null && /EPERM/.test(unreadable.detail ?? ''),
      JSON.stringify({ installed: unreadable.installed, detail: unreadable.detail }));

    const refused = service.backgroundServiceState({
      dataDir,
      deps: { mechanism: serverMech(false) },
    });
    check('registered false (sc 1060) is false even with the files on disk',
      refused.installed === false, String(refused.installed));

    // The mechanism no longer invents the answer: null stays null.
    const mech = service.resolveMechanism({ mode: 'server', registered: null, edition: null, leftover: null });
    check('resolveMechanism keeps an unknown registration unknown',
      mech.registered === null, String(mech.registered));

    const plain = service.backgroundServiceState({ dataDir });
    check('a process that is not the service reports runningAsService false',
      plain.runningAsService === false, String(plain.runningAsService));
  } finally {
    if (previous === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = previous;
    platform.resetDataDirCache();
  }
}

// ─── 3. primeServiceFacts(): one live probe, for the synchronous reader ──────

async function testPrimeServiceFacts() {
  setGroup('3. primeServiceFacts() gives the daemon the live registration once');

  const service = await import(srcUrl('core/service/index.js'));
  if (!IS_WINDOWS) {
    for (const label of [
      'isRegistered true -> registered true',
      'isRegistered false -> registered false',
      'isRegistered throwing -> registered null',
      'one probe per process (per injected deps)',
      'the synchronous reader sees the primed answer',
    ]) check(label, true, 'skipped: Windows only');
    return;
  }

  const base = {
    edition: 'server',
    detectLeftoverServerData: async () => ({ leftover: false }),
  };

  let calls = 0;
  const registeredDeps = {
    ...base,
    isRegistered: async () => { calls += 1; return true; },
  };
  const first = await service.primeServiceFacts({ deps: registeredDeps });
  const second = await service.primeServiceFacts({ deps: registeredDeps });
  check('isRegistered true -> registered true',
    first.registered === true && first.primed === true, JSON.stringify(first));
  check('one probe per process (per injected deps)', calls === 1, `${calls} call(s)`);
  check('the second await returns the same answer', second.registered === true);

  const notRegistered = await service.primeServiceFacts({
    deps: { ...base, isRegistered: async () => false },
  });
  check('isRegistered false -> registered false',
    notRegistered.registered === false, JSON.stringify(notRegistered));

  const failed = await service.primeServiceFacts({
    deps: {
      ...base,
      isRegistered: async () => { throw new Error('spawn sc.exe EPERM'); },
    },
  });
  check('isRegistered throwing -> registered stays null',
    failed.registered === null && failed.primed === true, JSON.stringify(failed));

  // The point of priming: backgroundServiceState() is synchronous.
  const primed = await service.primeServiceFacts({
    deps: { ...base, isRegistered: async () => true },
  });
  const state = service.backgroundServiceState({
    dataDir: TEST_DATA_DIR,
    deps: {
      mechanism: {
        platform: 'windows',
        mode: 'server',
        mechanism: 'winsw',
        registered: primed.registered,
      },
    },
  });
  check('the synchronous reader sees the primed answer',
    state.installed === true && state.mode === 'server');
}

// ─── 4. The operator record: install, repair, and the service account ────────

const OPERATOR = { sid: 'S-1-5-21-1111-2222-3333-1001', name: 'Fleet' };
const PM2_PATH = 'C:\\Users\\Fleet\\AppData\\Roaming\\npm\\pm2.cmd';

/** Deps that carry a Server install as far as recording `service-state`. */
function installDeps({ account, detectPm2, registered = true }) {
  return {
    edition: 'server',
    isRegistered: async () => registered,
    detectLeftoverServerData: async () => ({ leftover: false }),
    isElevated: async () => true,
    isServerMode: () => false,
    enableServerMode: async () => ({ ok: true, dataDir: TEST_DATA_DIR, migrated: false }),
    closeDb: () => {},
    reopenDb: () => {},
    resolveOperator: async () => OPERATOR,
    currentAccount: () => account,
    detectPm2: async () => detectPm2,
    startupGraceMs: 50,
    legacy: { run: async () => ({ success: false, stdout: '', stderr: '' }) },
    windowsService: {
      install: async () => ({
        ok: true,
        registered: true,
        runtime: { nodeExe: 'NODE', entry: 'ENTRY' },
        granted: ['data'],
        operator: OPERATOR,
      }),
      queryState: async () => 'RUNNING',
    },
  };
}

async function testOperatorRecord() {
  setGroup('4. the operator record is written at install and repair, never by the service');

  if (!IS_WINDOWS) {
    for (const label of [
      'install as the operator records user, home and pm2Path',
      'it keeps the SID the ACLs use',
      'repair adds the profile to an older record',
      'a service-account process writes no profile',
      'and never replaces a recorded value with null',
    ]) check(label, true, 'skipped: Windows only');
    return;
  }

  const service = await import(srcUrl('core/service/index.js'));
  const db = await import(srcUrl('core/db.js'));

  db.dbDelete('service-state');

  const installed = await service.install({
    mode: 'server',
    log: () => {},
    deps: installDeps({
      account: { user: 'Fleet', home: 'C:\\Users\\Fleet', serviceAccount: false },
      detectPm2: { installed: true, version: null, path: PM2_PATH },
    }),
  });

  const afterInstall = db.dbGet('service-state') ?? {};
  const operator = afterInstall.operator ?? {};
  check('the install finished', installed.ok === true, String(installed.reason ?? 'ok'));
  check('install as the operator records user, home and pm2Path',
    operator.user === 'Fleet'
      && operator.home === 'C:\\Users\\Fleet'
      && operator.pm2Path === PM2_PATH,
    JSON.stringify({ user: operator.user, home: operator.home, pm2Path: operator.pm2Path }));
  check('it keeps the SID the ACLs use',
    operator.sid === OPERATOR.sid && operator.name === OPERATOR.name,
    JSON.stringify({ sid: operator.sid, name: operator.name }));
  check('and records when it was measured',
    typeof operator.recordedAt === 'string' && !Number.isNaN(Date.parse(operator.recordedAt)),
    String(operator.recordedAt));
  const installTime = operator.recordedAt;

  // Repair: the 1.4.8 record has the SID but no profile. Repair fills it in.
  db.dbSet('service-state', {
    ...db.dbGet('service-state'),
    operator: { sid: OPERATOR.sid, name: OPERATOR.name },
  });
  const repaired = await service.repair({
    log: () => {},
    deps: {
      // Injected so no real `sc query` or ProgramData read happens here.
      isRegistered: async () => true,
      edition: 'server',
      detectLeftoverServerData: async () => ({ leftover: false }),
      windowsService: {
        repair: async () => ({ ok: true, granted: ['data'], operator: OPERATOR }),
      },
      resolveOperator: async () => OPERATOR,
      currentAccount: () => ({ user: 'Fleet', home: 'C:\\Users\\Fleet', serviceAccount: false }),
      detectPm2: async () => ({ installed: true, version: null, path: PM2_PATH }),
      repairPrivateKeys: async () => {},
      startupGraceMs: 50,
    },
  });
  const afterRepair = db.dbGet('service-state') ?? {};
  check('repair succeeded', repaired.ok === true, String(repaired.reason ?? 'ok'));
  check('repair adds the profile to an older record',
    afterRepair.operator?.user === 'Fleet'
      && afterRepair.operator?.pm2Path === PM2_PATH
      && afterRepair.operator?.sid === OPERATOR.sid,
    JSON.stringify(afterRepair.operator));

  // A process running as the service account must not write the profile.
  db.dbSet('service-state', {
    ...db.dbGet('service-state'),
    operator: {
      sid: OPERATOR.sid,
      name: OPERATOR.name,
      user: 'Fleet',
      home: 'C:\\Users\\Fleet',
      pm2Path: PM2_PATH,
      recordedAt: installTime,
    },
  });
  const asService = await service.install({
    mode: 'server',
    log: () => {},
    deps: installDeps({
      account: { user: 'EasyDevOps', home: 'C:\\Windows\\ServiceProfiles\\EasyDevOps', serviceAccount: true },
      detectPm2: { installed: false, version: null, path: null },
    }),
  });
  const afterService = db.dbGet('service-state') ?? {};
  check('the install still finished', asService.ok === true, String(asService.reason ?? 'ok'));
  check('a service-account process writes no profile',
    afterService.operator?.recordedAt === installTime
      && afterService.operator?.user === 'Fleet',
    JSON.stringify(afterService.operator));
  check('and never replaces a recorded value with null',
    afterService.operator?.pm2Path === PM2_PATH
      && afterService.operator?.home === 'C:\\Users\\Fleet',
    JSON.stringify({ pm2Path: afterService.operator?.pm2Path }));

  db.dbDelete('service-state');
}

// ─── 5. Linux: the unit file is the evidence, INVOCATION_ID the identity ─────

async function testLinuxRoot() {
  setGroup('5. Linux: unit present + INVOCATION_ID is installed and running as a service');

  if (IS_WINDOWS) {
    for (const label of [
      'the unit file is the installed evidence',
      'INVOCATION_ID says this is the service manager process',
      'startsAt is boot',
    ]) check(label, true, 'skipped: Windows machine');
    return;
  }

  const service = await import(srcUrl('core/service/index.js'));
  const daemonLock = await import(srcUrl('core/daemon/lock.js'));

  const dir = scratch('linux-unit');
  const unitPath = path.join(dir, 'easy-devops.service');
  fs.writeFileSync(unitPath, '[Unit]\nDescription=Easy DevOps\n');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'easy-devops.sqlite'), '');

  const previous = process.env.INVOCATION_ID;
  process.env.INVOCATION_ID = 'ez-e2e-linux-root';
  const acquired = daemonLock.acquire({ dataDir, version: '1.4.8', mode: 'daemon' });
  try {
    const state = service.backgroundServiceState({ dataDir, deps: { unitPath } });
    check('the lock is held by this pid', acquired.ok === true && state.running === true);
    check('the unit file is the installed evidence',
      state.installed === true && state.mechanism === 'systemd',
      JSON.stringify({ installed: state.installed, mechanism: state.mechanism }));
    check('INVOCATION_ID says this is the service manager process',
      state.runningAsService === true, String(state.runningAsService));
    check('startsAt is boot', state.startsAt === 'boot', String(state.startsAt));
  } finally {
    daemonLock.release({ dataDir });
    if (previous === undefined) delete process.env.INVOCATION_ID;
    else process.env.INVOCATION_ID = previous;
  }
}

// ─── 6. Version drift from inside the daemon ─────────────────────────────────

async function testDaemonVersionDrift() {
  setGroup('6. version drift from the daemon: unreadable installed CLI is null');

  const drift = await import(srcUrl('core/service/versionDrift.js'));

  const programData = tempProgramData('drift');
  writeJson(path.join(programData, 'runtime', 'app', 'package.json'), {
    name: 'easy-devops',
    version: '1.4.8',
  });
  const deps = {
    isWindows: true,
    isServerMode: () => true,
    programDataDir: () => programData,
  };

  const unknown = drift.checkDrift({
    dataDir: TEST_DATA_DIR,
    deps: { ...deps, inDaemon: true, installedCliVersion: null, cliVersion: '1.4.8' },
  });
  check('drift is null, never false', unknown.drift === null, String(unknown.drift));
  check('the CLI version is unknown', unknown.cliVersion === null, String(unknown.cliVersion));
  check('and it says why, with the next step implicit in the reason',
    /unknown/i.test(unknown.reason ?? ''), String(unknown.reason));

  const newer = drift.checkDrift({
    dataDir: TEST_DATA_DIR,
    deps: { ...deps, inDaemon: true, installedCliVersion: '1.4.9', cliVersion: '1.4.8' },
  });
  check('a readable newer installed CLI still reports drift',
    newer.drift === true && String(newer.message).includes('v1.4.9'),
    JSON.stringify({ drift: newer.drift, message: newer.message }));

  const same = drift.checkDrift({
    dataDir: TEST_DATA_DIR,
    deps: { ...deps, inDaemon: true, installedCliVersion: '1.4.8', cliVersion: '1.4.8' },
  });
  check('a matching installed CLI is no drift', same.drift === false, String(same.drift));

  const cli = drift.checkDrift({ deps: { isWindows: false, cliVersion: '1.4.6' } });
  check('outside the daemon the existing CLI comparison is unchanged',
    cli.drift === false && cli.mode === 'linux', `${cli.drift}/${cli.mode}`);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nService identity: the state from inside the service\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  setGroup('0. the test environment');
  check('the guard gave this suite a temporary data directory',
    fs.existsSync(TEST_DATA_DIR), TEST_DATA_DIR);
  check('the temporary ProgramData redirect is inside os.tmpdir()',
    path.resolve(TEST_DATA_DIR).toLowerCase()
      .startsWith(path.resolve(os.tmpdir()).toLowerCase()),
    os.tmpdir());

  await testServiceIdentity();
  await testFileEvidence();
  await testPrimeServiceFacts();
  await testOperatorRecord();
  await testLinuxRoot();
  await testDaemonVersionDrift();

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
