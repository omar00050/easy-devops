/**
 * e2e/version-drift.test.mjs
 *
 * Run with:  node e2e/run.mjs version-drift
 *
 * A Windows Server install has two copies of this package: the CLI npm
 * updated, and the runtime copy the service actually runs. A plain
 * `npm i -g easy-devops` updates only the first, and nothing used to say so
 * (finding A3: `out.log` said v1.4.4 while `ezz --version` said 1.4.6).
 *
 * This suite checks:
 *
 *   - checkDrift() reads both versions from files and reports a mismatch;
 *   - no drift when they match, in Personal mode, or on Linux;
 *   - status() carries serviceVersion / cliVersion / versionDrift;
 *   - a normal `ezz` command warns in a pipe and never relaunches;
 *   - a matching or non-Server install says nothing;
 *   - the daemon's drift check announces a pair exactly once;
 *   - the daemon starts with a warning when the protections record is missing,
 *     and refuses only a data directory inside the package.
 *
 * The fake Windows Server directories live inside this run's temporary area.
 * Platform decisions are injected where the test is not about the real machine;
 * no check reads process.platform.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

/** This repository's real CLI version, so the test does not hardcode it. */
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// ─── Fake Windows Server installs, inside the runner's temp area ─────────────

/**
 * The parent of a fake `easy-devops` data directory, exactly as
 * programDataDir() would compute it: `<ProgramData>\easy-devops`.
 */
function writeFakeInstall(name, version, { serverMode = true } = {}) {
  const parent = path.join(TEST_DATA_DIR, 'platform', name);
  assertInsideTestDataDir(parent, `create the fake platform root ${name}`);
  const data = path.join(parent, 'easy-devops');
  const app = path.join(data, 'runtime', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
    name: 'easy-devops',
    version,
    private: true,
  }));
  if (serverMode) fs.writeFileSync(path.join(data, '.server-mode'), '');
  return { parent, data };
}

const SERVER = writeFakeInstall('server-old', '1.4.4');
const MATCH = writeFakeInstall('server-match', CLI_VERSION);
const PERSONAL = writeFakeInstall('personal-old', '1.4.4', { serverMode: false });

// The real platform helpers read ProgramData under EZ_TEST, so the suite's own
// default (used by status() and startDaemon) resolves the fake server install.
// Set before any src/ module is imported.
process.env.ProgramData = SERVER.parent;

// ─── CLI child process helper ────────────────────────────────────────────────

function runCli(args, { programData, dataDir, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      EZ_TEST: '1',
      EASY_DEVOPS_DATA_DIR: dataDir,
      ProgramData: programData,
    };
    delete env.CI;
    delete env.FORCE_COLOR;

    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'src/cli/index.js'), ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, out: stdout + stderr, timedOut, ms: Date.now() - started });
    });
  });
}

/** A scratch data directory for a child, with a valid empty SQLite file. */
function cliData(name) {
  const dir = path.join(TEST_DATA_DIR, 'cli', name);
  assertInsideTestDataDir(dir, `create the CLI data dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const db = path.join(dir, 'easy-devops.sqlite');
  if (!fs.existsSync(db)) fs.writeFileSync(db, '');
  return dir;
}

/** A scratch directory for the start-up checks, inside this run's temp area. */
function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'startup', name);
  assertInsideTestDataDir(dir, `create the start-up scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A real SQLite file in good.db's shape, used only to build fixtures. The
 * product reads key names through core/db.js; values never leave this file.
 */
function createDatabase(file, keys, valuePrefix) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new Database(file);
  try {
    handle.exec('CREATE TABLE IF NOT EXISTS gooddb (key TEXT PRIMARY KEY, value TEXT)');
    const insert = handle.prepare('INSERT OR REPLACE INTO gooddb (key, value) VALUES (?, ?)');
    for (const key of keys) {
      insert.run(key, JSON.stringify({ note: `${valuePrefix}-${key}` }));
    }
  } finally {
    handle.close();
  }
}

// ─── 1. checkDrift reads the two packages ────────────────────────────────────

async function testCheckDrift() {
  setGroup('1. checkDrift reads both package versions');
  const drift = await import(srcUrl('core/service/versionDrift.js'));

  const old = drift.checkDrift({
    dataDir: TEST_DATA_DIR,
    deps: {
      isWindows: true,
      isServerMode: () => true,
      programDataDir: () => SERVER.data,
      cliVersion: '1.4.6',
    },
  });
  check('reports the runtime copy version', old.serviceVersion === '1.4.4', String(old.serviceVersion));
  check('reports the CLI version', old.cliVersion === '1.4.6', String(old.cliVersion));
  check('reports drift', old.drift === true);
  check('the message names both versions and the repair command',
    String(old.message).includes('v1.4.4')
      && String(old.message).includes('v1.4.6')
      && String(old.message).includes('ezz service repair'));

  const same = drift.checkDrift({
    deps: {
      isWindows: true,
      isServerMode: () => true,
      programDataDir: () => MATCH.data,
      cliVersion: CLI_VERSION,
    },
  });
  check('no drift when the versions match', same.drift === false, `${same.serviceVersion}/${same.cliVersion}`);

  const personal = drift.checkDrift({
    deps: {
      isWindows: true,
      isServerMode: () => false,
      programDataDir: () => PERSONAL.data,
      cliVersion: '1.4.6',
    },
  });
  check('no drift in Windows Personal mode', personal.drift === false && personal.mode === 'personal');

  const linux = drift.checkDrift({ deps: { isWindows: false, cliVersion: '1.4.6' } });
  check('no drift on Linux', linux.drift === false && linux.mode === 'linux');

  // An unreadable runtime manifest is unknown, never a drift claim.
  const missing = drift.checkDrift({
    deps: {
      isWindows: true,
      isServerMode: () => true,
      programDataDir: () => path.join(TEST_DATA_DIR, 'platform', 'no-such-install'),
      cliVersion: '1.4.6',
    },
  });
  check('an unreadable runtime copy is unknown, not drift',
    missing.drift === false && missing.serviceVersion === null && Boolean(missing.reason));
}

// ─── 2. status() carries the three fields ────────────────────────────────────

async function testStatusFields() {
  setGroup('2. status() returns serviceVersion, cliVersion and versionDrift');
  const service = await import(srcUrl('core/service/index.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));

  dbSet('service-state', { mode: 'server', mechanism: 'winsw', granted: ['data'] });

  const message = 'The background service runs v1.4.4 but the CLI is v1.4.6. '
    + 'Run `ezz service repair` as administrator to update the service.';

  const s = await service.status({
    deps: {
      checkDrift: () => ({
        drift: true,
        cliVersion: '1.4.6',
        serviceVersion: '1.4.4',
        mode: 'server',
        reason: null,
        message,
      }),
      windowsService: {
        status: async () => ({ installed: true, running: true, state: 'RUNNING', enabledOnBoot: true, warnings: [] }),
      },
      inspectRuntime: async () => ({ systemNode: { path: null, version: null, abi: null }, pinned: null, warnings: [] }),
      detectLegacy: async () => ({ found: false, items: [] }),
      readStopRequest: () => ({ requested: false }),
    },
  });

  check('serviceVersion', s.serviceVersion === '1.4.4', String(s.serviceVersion));
  check('cliVersion', s.cliVersion === '1.4.6', String(s.cliVersion));
  check('versionDrift', s.versionDrift === true);
  check('status warns with the same sentence', (s.warnings ?? []).includes(message));
}

// ─── 3. The CLI warns in a pipe, and only when it should ─────────────────────

async function testCliWarning() {
  setGroup('3. every ezz command warns, non-interactively');

  const old = await runCli(['hub', 'status'], {
    programData: SERVER.parent,
    dataDir: cliData('old'),
  });

  check('the warning is printed', old.stderr.includes('background service runs v1.4.4'), old.stderr.trim().split('\n')[0] ?? '');
  check('it names the CLI version', old.stderr.includes(`the CLI is v${CLI_VERSION}`));
  check('it names the command that fixes it', old.stderr.includes('ezz service repair'));
  check('nothing is relaunched in a pipe',
    !/Relaunch as administrator|Handed off to an elevated/i.test(old.out));

  const matching = await runCli(['hub', 'status'], {
    programData: MATCH.parent,
    dataDir: cliData('matching'),
  });
  check('no warning when the versions match',
    !matching.stderr.includes('background service runs'));

  const personal = await runCli(['hub', 'status'], {
    programData: PERSONAL.parent,
    dataDir: cliData('personal'),
  });
  check('no warning outside Windows Server mode',
    !personal.stderr.includes('background service runs'));
}

// ─── 4. The daemon announces one pair exactly once ──────────────────────────

async function testDaemonNotificationOnce() {
  setGroup('4. the daemon announces a version pair exactly once');
  const drift = await import(srcUrl('core/service/versionDrift.js'));

  drift.resetVersionDriftNotifications();
  const published = [];
  const deps = {
    isWindows: true,
    isServerMode: () => true,
    installedCliVersion: '1.4.6',
    publish: (event, payload) => published.push({ event, payload }),
  };

  const first = await drift.runVersionDriftCheck({ version: '1.4.4', deps });
  const second = await drift.runVersionDriftCheck({ version: '1.4.4', deps });

  check('the first check reports the newer install',
    first.newerInstalled === true && first.notified === true);
  check('the second check is deduplicated',
    second.notified === false && second.deduped === true);
  check('exactly one notification was published', published.length === 1, `${published.length}`);
  check('it is notification:new of type service_drift',
    published[0]?.event === 'notification:new'
      && published[0]?.payload?.type === 'service_drift'
      && published[0]?.payload?.message.includes('v1.4.4')
      && published[0]?.payload?.message.includes('v1.4.6'));

  const older = await drift.runVersionDriftCheck({
    version: '1.5.0',
    deps: { isWindows: true, isServerMode: () => true, installedCliVersion: '1.4.6', publish: () => {} },
  });
  check('a service newer than the installed package is not announced', older.notified === false);
}

// ─── 5. Start-up tolerance and the one unsafe refusal ───────────────────────

async function testStartupTolerance() {
  setGroup('5. start-up tolerance keeps the daemon running');
  const drift = await import(srcUrl('core/service/versionDrift.js'));

  // An install that stopped at a step is the only permission-ish thing a
  // record can prove. The old line here — "no recorded permission check" —
  // came from a stale record and sent a healthy 1.4.7 server to repair.
  const progressFile = path.join(TEST_DATA_DIR, drift.INSTALL_PROGRESS_FILE);
  fs.writeFileSync(progressFile, JSON.stringify({
    version: CLI_VERSION,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: { dataDir: 'done', runtime: 'failed' },
    failedStep: 'runtime',
    error: 'the runtime step failed',
  }));

  try {
    const assessed = drift.assessStartup({
      dataDir: TEST_DATA_DIR,
      version: '1.4.4',
      record: { mode: 'server', mechanism: 'winsw' },
      deps: {
        isWindows: true,
        isServerMode: () => true,
        programDataDir: () => SERVER.data,
        installedCliVersion: '1.4.6',
      },
    });
    check('an interrupted install is a warning, not a failure',
      assessed.ok === true && assessed.refused === false);
    check('the warning says where install stopped and what resumes it',
      assessed.warnings.some((w) => /Install not finished \(stopped at runtime\)/.test(w)
        && /ezz service install/.test(w) && /resume/.test(w)),
      assessed.warnings.join(' | '));
    check('it no longer claims a missing recorded permission check',
      !assessed.warnings.some((w) => /permission check/i.test(w)));

    const unsafe = drift.assessStartup({
      dataDir: path.join(ROOT, 'data'),
      record: {},
      packageRoot: ROOT,
      deps: { isWindows: true, isServerMode: () => true, programDataDir: () => SERVER.data },
    });
    check('a data directory inside the package is refused',
      unsafe.refused === true && /inside the Easy DevOps package/.test(unsafe.reason));
    check('the refusal says what to do', String(unsafe.next).includes('ezz service repair'));

    // The real start path: a Server-mode record with an install that stopped.
    // The jobs are isolated so the monitors cannot reach the machine's nginx.
    const { dbSet, closeDb } = await import(srcUrl('core/db.js'));
    const nowhere = path.join(TEST_DATA_DIR, 'no-such-nginx');
    dbSet('config', {
      nginxDir: nowhere,
      sslDir: path.join(TEST_DATA_DIR, 'no-such-ssl'),
      dashboardPort: 0,
      dashboardAuth: 'none',
      dashboardBindAddress: '127.0.0.1',
      dashboardUi: 'new',
      dashboardUiMigrated: true,
      acmeEmail: '',
      os: 'win32',
    });
    dbSet('domains', []);
    dbSet('service-state', { mode: 'server', mechanism: 'winsw' });

    const { startDaemon } = await import(srcUrl('core/daemon/run.js'));
    const lines = [];
    const handle = await startDaemon({
      dataDir: TEST_DATA_DIR,
      hub: false,
      intervals: { nginx: 3_600_000, domains: 3_600_000, certs: 3_600_000 },
      log: (line) => lines.push(line),
      deps: {
        startup: {
          isWindows: true,
          isServerMode: () => true,
          programDataDir: () => SERVER.data,
          installedCliVersion: '1.4.6',
        },
        runVersionDriftCheck: async () => ({ notified: false }),
      },
    });

    try {
      check('the daemon kept running', handle.ok === true, lines.find((l) => /Running/.test(l)) ?? '');
      check('it logged the interrupted-install warning',
        lines.some((l) => /warning/.test(l) && /Install not finished/.test(l)));
      check('the warning is exposed to status/Hub',
        (handle.state().startupWarnings ?? []).some((w) => /Install not finished/.test(w)));
    } finally {
      await handle.stop();
      try { closeDb(); } catch { /* already closed */ }
    }
  } finally {
    fs.rmSync(progressFile, { force: true });
  }
}

// ─── 6. The start-up check finds each state the owner's server was in ────────

async function testStartupHealthCheck() {
  setGroup('6. the start-up check finds leftover data, a stopped install and drift');
  const drift = await import(srcUrl('core/service/versionDrift.js'));
  const emptyDir = scratch('empty-data');

  // No service installed at all: unknown, never the CLI's own version.
  const none = drift.readServiceVersion({
    dataDir: emptyDir,
    deps: {
      isWindows: true,
      isServerMode: () => false,
      programDataDir: () => path.join(TEST_DATA_DIR, 'platform', 'startup-no-install'),
      startupDir: path.join(TEST_DATA_DIR, 'platform', 'startup-no-launcher'),
      cliVersion: '1.4.6',
    },
  });
  check('no service installed means no service version',
    none.version === null, String(none.version));
  check('and the reason says no service is installed',
    /no Easy DevOps service/.test(String(none.reason)), String(none.reason));

  // A registered service's own definition without the marker is Server mode.
  const xml = writeFakeInstall('server-xml', '1.4.4', { serverMode: false });
  fs.mkdirSync(path.join(xml.data, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(xml.data, 'bin', 'EasyDevOps.xml'), '<service/>');
  const xmlDeps = { isWindows: true, isServerMode: () => false, programDataDir: () => xml.data };
  check('a registered definition without the marker is Server mode',
    drift.driftMode({ dataDir: emptyDir, deps: xmlDeps }) === 'server');
  const xmlDrift = drift.checkDrift({ dataDir: emptyDir, deps: { ...xmlDeps, cliVersion: '1.4.6' } });
  check('and its runtime copy is compared',
    xmlDrift.drift === true && xmlDrift.serviceVersion === '1.4.4',
    `${xmlDrift.serviceVersion}/${xmlDrift.cliVersion}`);

  // Runtime copy 1.4.4 against a 1.4.6 CLI: drift through the start-up check.
  const serverDrift = await drift.serviceStartupProblems({
    dataDir: emptyDir,
    deps: { isWindows: true, isServerMode: () => true, programDataDir: () => SERVER.data, cliVersion: '1.4.6' },
  });
  check('the start-up check finds the drift',
    serverDrift.problems[0]?.kind === 'version-drift', String(serverDrift.problems[0]?.kind));
  check('and names the repair command',
    /ezz service repair/.test(String(serverDrift.problems[0]?.message))
      && /v1\.4\.4/.test(String(serverDrift.problems[0]?.message)));

  // Leftover Server data: both key counts and both flags, never a value.
  const leftoverRoot = scratch('leftover');
  const programRoot = path.join(leftoverRoot, 'programdata', 'easy-devops');
  const userRoot = path.join(leftoverRoot, 'appdata', 'easy-devops');
  const REAL_KEYS = ['config', 'domains', 'hub-link', 'hub-permissions', 'notification_channels',
    'notification_state', 'service-state', 'session_secret', 'setup-code', 'sslAutoRenewState',
    'system-detection', 'update-pre-dashboard', 'dashboard-pid', 'dashboard-port', 'domain_notification_config'];
  const SMALL_KEYS = ['config', 'system-detection', 'update-pre-dashboard', 'service-state'];
  createDatabase(path.join(programRoot, 'easy-devops.sqlite'), REAL_KEYS, 'REAL-SECRET');
  createDatabase(path.join(userRoot, 'easy-devops.sqlite'), SMALL_KEYS, 'SMALL-SECRET');

  const leftover = await drift.serviceStartupProblems({
    dataDir: userRoot,
    deps: { isWindows: true, isServerMode: () => false, programDataDir: () => programRoot, cliVersion: '1.4.6' },
  });
  const primary = leftover.problems[0] ?? {};
  check('leftover Server data is the first problem', primary.kind === 'leftover-data', String(primary.kind));
  check('the warning names both key counts',
    String(primary.message).includes('15 keys') && String(primary.message).includes('4 keys'),
    String(primary.message));
  check('and the two flags that answer it',
    String(primary.message).includes('--adopt-existing-data')
      && String(primary.message).includes('--set-aside-existing-data'));
  check('it names the install command that asks', /ezz service install/.test(String(primary.args?.join(' '))) 
    || /ezz service install/.test(String(primary.message)));
  check('warning text leaks no value', !String(primary.message).includes('REAL-SECRET')
    && !String(primary.message).includes('SMALL-SECRET'));

  // An install that stopped at the runtime step.
  const progressDir = scratch('progress');
  fs.writeFileSync(path.join(progressDir, 'install-progress.json'), JSON.stringify({
    version: '1.4.7',
    steps: { dataDir: 'done', runtime: 'failed' },
    failedStep: 'runtime',
    error: 'verifying the new permissions failed',
  }));
  const progress = await drift.serviceStartupProblems({
    dataDir: progressDir,
    deps: { isWindows: true, isServerMode: () => true, programDataDir: () => SERVER.data, cliVersion: '1.4.6' },
  });
  check('an install that stopped is reported before drift',
    progress.problems[0]?.kind === 'install-unfinished', String(progress.problems[0]?.kind));
  check('the resume line names the step and the command',
    /Install not finished \(stopped at runtime\)/.test(String(progress.problems[0]?.message))
      && /ezz service install/.test(String(progress.problems[0]?.message))
      && /resume/.test(String(progress.problems[0]?.message)),
    String(progress.problems[0]?.message));

  // Linux: the unit's ExecStart entry package, not the CLI's own version.
  const linuxRoot = scratch('linux-unit');
  const unitApp = path.join(linuxRoot, 'app');
  fs.mkdirSync(path.join(unitApp, 'src', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(unitApp, 'package.json'),
    JSON.stringify({ name: 'easy-devops', version: '1.4.4', private: true }));
  fs.writeFileSync(path.join(unitApp, 'src', 'cli', 'index.js'), '');
  const unitPath = path.join(linuxRoot, 'easy-devops.service');
  fs.writeFileSync(unitPath, [
    '[Unit]',
    'Description=Easy DevOps background service',
    '',
    '[Service]',
    'Type=simple',
    `Environment="EASY_DEVOPS_DATA_DIR=${linuxRoot.replaceAll('\\', '/')}/data"`,
    `ExecStart=/usr/bin/node --import file:///x/register.mjs ${path.join(unitApp, 'src', 'cli', 'index.js').replaceAll('\\', '/')} daemon`,
    '',
  ].join('\n'));
  const linux = await drift.serviceStartupProblems({
    dataDir: scratch('linux-data'),
    deps: { isWindows: false, unitPath, cliVersion: '1.4.6' },
  });
  check('a unit running an older copy is drift', linux.problems[0]?.kind === 'version-drift',
    String(linux.problems[0]?.kind));
  check('the Linux message names sudo and the repair command',
    /The background service runs v1\.4\.4 but the CLI is v1\.4\.6/.test(String(linux.problems[0]?.message))
      && /sudo ezz service repair/.test(String(linux.problems[0]?.message)),
    String(linux.problems[0]?.message));
  check('and a machine with no unit file has no drift',
    (await drift.serviceStartupProblems({
      dataDir: scratch('linux-none'),
      deps: { isWindows: false, unitPath: path.join(linuxRoot, 'no-such.service'), cliVersion: '1.4.6' },
    })).problems.length === 0);

  // Non-interactive: the warning and the command, and no elevation prompt.
  const written = [];
  let prompted = 0;
  const quiet = await drift.runServiceStartupCheck({
    dataDir: progressDir,
    deps: {
      isWindows: true,
      isServerMode: () => true,
      programDataDir: () => SERVER.data,
      cliVersion: '1.4.6',
      isInteractive: () => false,
      write: (text) => written.push(text),
      requireElevation: async () => { prompted += 1; return { proceed: false, code: 0 }; },
    },
  });
  check('a pipe gets the warning and the exact command',
    /Install not finished/.test(written.join(''))
      && /ezz service install/.test(written.join('')),
    written.join('').replace(/\s+/g, ' ').slice(0, 120));
  check('a pipe is told the daemon cannot fix it itself',
    /cannot update its own files/.test(written.join('')));
  check('a pipe never calls the elevation prompt',
    prompted === 0 && quiet.asked === false && quiet.handedOff === false);

  // Interactive Windows: one offer, the install command, handed off.
  const offers = [];
  const offered = await drift.runServiceStartupCheck({
    dataDir: progressDir,
    deps: {
      isWindows: true,
      isServerMode: () => true,
      programDataDir: () => SERVER.data,
      cliVersion: '1.4.6',
      isInteractive: () => true,
      write: () => {},
      requireElevation: async (opts) => { offers.push(opts); return { proceed: false, code: 0 }; },
    },
  });
  check('an interactive terminal is offered the install once',
    offers.length === 1 && offers[0].args.join(' ') === 'service install',
    offers.map((o) => o.args.join(' ')).join(','));
  check('and a handed-off run says so', offered.handedOff === true && offered.exitCode === 0);

  // Drift alone offers repair, not install.
  const repairOffers = [];
  await drift.runServiceStartupCheck({
    dataDir: emptyDir,
    deps: {
      isWindows: true,
      isServerMode: () => true,
      programDataDir: () => SERVER.data,
      cliVersion: '1.4.6',
      isInteractive: () => true,
      write: () => {},
      requireElevation: async (opts) => { repairOffers.push(opts); return { proceed: true }; },
    },
  });
  check('drift alone offers `service repair`',
    repairOffers.length === 1 && repairOffers[0].args.join(' ') === 'service repair');

  // Linux never elevates from here.
  let linuxPrompted = 0;
  const linuxQuiet = [];
  await drift.runServiceStartupCheck({
    dataDir: scratch('linux-data-2'),
    deps: {
      isWindows: false,
      unitPath,
      cliVersion: '1.4.6',
      isInteractive: () => true,
      write: (text) => linuxQuiet.push(text),
      requireElevation: async () => { linuxPrompted += 1; return { proceed: true }; },
    },
  });
  check('Linux prints the sudo command for the user to run',
    linuxPrompted === 0 && /sudo ezz service repair/.test(linuxQuiet.join(''))
      && /sudo asks for your password/.test(linuxQuiet.join('')));
}

// ─── 7. The leftover-data flags ──────────────────────────────────────────────

async function testLeftoverFlags() {
  setGroup('7. the leftover-data flags are refused when they cannot mean one thing');

  const both = await runCli(
    ['service', 'install', '--adopt-existing-data', '--set-aside-existing-data'],
    { programData: SERVER.parent, dataDir: cliData('flags-both') },
  );
  check('both flags together are refused',
    both.code === 1 && /not both/.test(both.out), both.out.trim().split('\n')[0] ?? '');
  check('and the refusal says nothing was changed', /Nothing was changed/i.test(both.out));

  const wrong = await runCli(['hub', 'status', '--adopt-existing-data'], {
    programData: SERVER.parent,
    dataDir: cliData('flags-wrong'),
  });
  check('the flag outside `service install` is refused',
    wrong.code === 1 && /only apply to `ezz service install`/.test(wrong.out),
    wrong.out.trim().split('\n')[0] ?? '');

  const help = await runCli(['--help'], { programData: SERVER.parent, dataDir: cliData('flags-help') });
  check('the help lists both flags',
    help.stdout.includes('--adopt-existing-data') && help.stdout.includes('--set-aside-existing-data'));
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nVersion drift\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testCheckDrift();
  await testStatusFields();
  await testCliWarning();
  await testDaemonNotificationOnce();
  await testStartupTolerance();
  await testStartupHealthCheck();
  await testLeftoverFlags();

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) {
      process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` — ${f.detail}` : ''}\n`);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
