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
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

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
  check('a missing protections record is a warning, not a failure',
    assessed.ok === true && assessed.refused === false);
  check('the warning says to run the repair',
    assessed.warnings.some((w) => /permission check/i.test(w) && /ezz service repair/.test(w)));

  const unsafe = drift.assessStartup({
    dataDir: path.join(ROOT, 'data'),
    record: {},
    packageRoot: ROOT,
    deps: { isWindows: true, isServerMode: () => true, programDataDir: () => SERVER.data },
  });
  check('a data directory inside the package is refused',
    unsafe.refused === true && /inside the Easy DevOps package/.test(unsafe.reason));
  check('the refusal says what to do', String(unsafe.next).includes('ezz service repair'));

  // The real start path: a Server-mode record with no recorded protections.
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
    check('it logged the missing-protections warning',
      lines.some((l) => /warning/.test(l) && /permission check/i.test(l)));
    check('the warning is exposed to status/Hub',
      (handle.state().startupWarnings ?? []).some((w) => /permission check/i.test(w)));
  } finally {
    await handle.stop();
    try { closeDb(); } catch { /* already closed */ }
  }
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
