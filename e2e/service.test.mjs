/**
 * End-to-end tests for core/runner.js — the only PM2 invoker.
 *
 * PM2 no longer runs Easy DevOps itself: that is a native OS service now, and
 * core/service.js was deleted with this change. What remains, and what this
 * suite covers, is PM2 as the manager of the USER's own applications behind
 * the Processes page. The native service has its own suite:
 * e2e/native-service.test.mjs.
 *
 * Run with:  npm run test:e2e -- service
 *
 * Plain Node script: the easy-devops constitution forbids adding a test
 * framework here, so this uses no runner and no new dependencies.
 *
 * ── Why this does not use the real PM2 ──────────────────────────────────────
 *
 * The first version of this suite ran real PM2 under a temporary PM2_HOME.
 * That is NOT safe on Windows: PM2 there ignores PM2_HOME, so a `pm2 start`
 * meant for the temporary home goes to the user's real daemon. Measured
 * directly — `pm2 jlist` with no PM2_HOME listed the app that had just been
 * started "in isolation".
 *
 * So PM2 is replaced by a STUB EXECUTABLE written into the temp directory. It
 * speaks the parts of PM2's CLI this project uses and prints output in PM2's
 * shape, including the `[PM2]` log noise the jlist parser has to skip. That
 * keeps what actually needed covering — real subprocess spawning, real shell
 * quoting, real output parsing — while making it impossible to reach a real
 * daemon.
 *
 * The jlist field names mirror PM2 6.0.14, verified against real output while
 * developing this: pm2_env.status, pm2_env.pm_uptime as an epoch START time,
 * monit.memory in bytes, pm2_env.restart_time.
 *
 * ── The guard ───────────────────────────────────────────────────────────────
 *
 * guardedRun() refuses to execute any command mentioning pm2 unless it points
 * at the stub inside the temp directory, and aborts the process rather than
 * falling back. The check is on the command actually being executed, not on an
 * environment variable, because PM2_HOME proved to isolate nothing on Windows.
 *
 * schtasks is never executed, the Startup folder is redirected to a temp
 * directory, and no password prompt can appear.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
import './lib/guard.mjs';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

// ─── Isolation, established before anything is imported ──────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-service-'));
const PM2_HOME = path.join(tmpRoot, 'pm2home');
const DATA_DIR = path.join(tmpRoot, 'data');
const STARTUP_DIR = path.join(tmpRoot, 'startup');
const BIN_DIR = path.join(tmpRoot, 'bin');
const STATE_FILE = path.join(tmpRoot, 'stub-state.json');

for (const d of [PM2_HOME, DATA_DIR, STARTUP_DIR, BIN_DIR]) fs.mkdirSync(d, { recursive: true });
// A pre-created 0-byte file so db.js's legacy migration — which RENAMES
// data/easy-devops.sqlite — can never run against the real installation.
fs.writeFileSync(path.join(DATA_DIR, 'easy-devops.sqlite'), '');

process.env.PM2_HOME = PM2_HOME;
process.env.EASY_DEVOPS_DATA_DIR = DATA_DIR;

const REAL_PM2_HOME = path.join(os.homedir(), '.pm2');

/**
 * Entries a PM2 daemon rewrites on its own, continuously, just by being alive.
 *
 * Excluded from the snapshot below because this suite asserts that WE did not
 * modify the user's PM2 state — not that their PM2 sat perfectly still for the
 * ninety seconds the suite takes. With a real daemon running (normal on a
 * machine that uses PM2) `pm2.log` gains a line every few seconds, and the
 * comparison then failed for reasons nothing in the code under test could cause.
 *
 * Everything that would actually show OUR interference is still compared:
 * `dump.pm2` (the saved process list), `module_conf.json`, and any app
 * directory. `dump.pm2` also has its own explicit check in the teardown.
 */
const PM2_SELF_CHURN = new Set(['pm2.log', 'logs', 'pids', 'touch']);

const realPm2Before = snapshotDir(REAL_PM2_HOME, { ignore: PM2_SELF_CHURN });
const realPm2DumpBefore = fs.existsSync(path.join(REAL_PM2_HOME, 'dump.pm2'));
const realPm2PidBefore = fs.existsSync(path.join(REAL_PM2_HOME, 'pm2.pid'));


function snapshotDir(dir, { ignore = new Set() } = {}) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => !ignore.has(n))
      .map((n) => {
        let m = null;
        try { m = fs.statSync(path.join(dir, n)).mtimeMs; } catch { /* vanished */ }
        return `${n}:${m}`;
      })
      .sort()
      .join('|');
  } catch {
    return null;
  }
}

// ─── The stub pm2 executable ─────────────────────────────────────────────────

const STUB_JS = path.join(BIN_DIR, 'pm2-stub.mjs');
const STUB_PM2 = path.join(BIN_DIR, isWin ? 'pm2.cmd' : 'pm2');
const STUB_VERSION = '6.0.14';

fs.writeFileSync(STUB_JS, `
// A stand-in for the PM2 CLI. Implements only what easy-devops uses, and
// prints output shaped like PM2 6.x — including the "[PM2]" noise around JSON.
import fs from 'fs';
const STATE = ${JSON.stringify(STATE_FILE)};
const HOME = process.env.PM2_HOME ?? ${JSON.stringify(PM2_HOME)};
const PID_FILE = HOME + '/pm2.pid';
const DEFAULT_USER = ${JSON.stringify(os.userInfo().username)};

const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { apps: [], modules: [] }; } };
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));

// Any command starts the daemon, exactly like PM2 does. A real daemon outlives
// the CLI call that started it, and isDaemonRunning() verifies the recorded pid
// is still alive — so record the harness's own pid, which stays alive for the
// whole run. (process.pid here would be this short-lived stub, and ppid the
// shell that invoked it; both are gone by the time liveness is checked.)
const LIVE_PID = ${process.pid};
if (!fs.existsSync(PID_FILE)) fs.writeFileSync(PID_FILE, String(LIVE_PID));

const argv = process.argv.slice(2);
const verb = argv[0];
const state = load();
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const unquote = (v) => String(v ?? '').replace(/^"|"$/g, '');
const say = (m) => process.stdout.write('[PM2] ' + m + '\\n');

switch (verb) {
  case '--version': case '-v':
    say('PM2 Successfully daemonized');
    process.stdout.write('${STUB_VERSION}\\n');
    break;

  case 'jlist': {
    say('Spawning PM2 daemon with pm2_home=' + HOME);
    process.stdout.write(JSON.stringify(state.apps.map((a) => ({
      name: a.name,
      pm_id: a.pm_id,
      pid: a.status === 'online' ? a.pid : 0,
      monit: { cpu: a.status === 'online' ? 3 : 0, memory: a.status === 'online' ? 52428800 : 0 },
      pm2_env: {
        status: a.status,
        pm_uptime: a.pm_uptime,
        restart_time: a.restart_time,
        unstable_restarts: 0,
        pm_exec_path: a.script,
        pm_cwd: a.cwd ?? process.cwd(),
        username: a.username ?? DEFAULT_USER,
        env: { EASY_DEVOPS_DATA_DIR: a.dataDir ?? null },
      },
    }))) + '\\n');
    break;
  }

  case 'start': {
    const script = unquote(argv[1]);
    const name = unquote(flag('--name')) || 'unnamed';
    const existing = state.apps.find((a) => a.name === name);
    if (existing) {
      existing.status = 'online';
      existing.restart_time++;
      existing.pm_uptime = Date.now();
    } else {
      state.apps.push({
        name, script, pm_id: state.apps.length, pid: 10000 + state.apps.length,
        status: 'online', pm_uptime: Date.now(), restart_time: 0,
        dataDir: process.env.EASY_DEVOPS_DATA_DIR ?? null,
      });
    }
    save(state);
    say('Starting ' + script + ' in fork_mode (1 instance)');
    say('Done.');
    break;
  }

  case 'stop': case 'restart': case 'reload': case 'delete': {
    const name = unquote(argv[1]);
    const idx = state.apps.findIndex((a) => a.name === name);
    if (idx === -1) {
      process.stderr.write('[PM2][ERROR] Process or Namespace ' + name + ' not found\\n');
      process.exit(1);
    }
    if (verb === 'delete') state.apps.splice(idx, 1);
    else if (verb === 'stop') { state.apps[idx].status = 'stopped'; state.apps[idx].pid = 0; }
    else { state.apps[idx].status = 'online'; state.apps[idx].restart_time++; state.apps[idx].pm_uptime = Date.now(); }
    save(state);
    say('Applying action ' + verb + 'ProcessId on app [' + name + ']');
    break;
  }

  case 'save':
    fs.writeFileSync(HOME + '/dump.pm2', JSON.stringify(state.apps));
    say('Successfully saved in ' + HOME + '/dump.pm2');
    break;

  case 'resurrect':
    say('Resurrecting');
    break;

  case 'ls': case 'list':
    process.stdout.write((state.modules.join('\\n') || '(no modules)') + '\\n');
    break;

  case 'install':
    state.modules.push(unquote(argv[1]));
    save(state);
    say('Module ' + unquote(argv[1]) + ' installed');
    break;

  case 'logs': {
    const name = unquote(argv[1]);
    if (!argv.includes('--nostream')) {
      process.stderr.write('[PM2][ERROR] stub refuses to stream; --nostream is required\\n');
      process.exit(3);
    }
    process.stdout.write(name + ' log line 1\\n' + name + ' log line 2\\n');
    break;
  }

  case 'startup':
    say('Init System found: systemd');
    process.stdout.write('[PM2] To setup the Startup Script, copy/paste the following command:\\n');
    process.stdout.write('sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u tester --hp /home/tester\\n');
    break;

  case 'unstartup':
    process.stdout.write('sudo env PATH=$PATH:/usr/bin pm2 unstartup systemd\\n');
    break;

  case 'kill':
    try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
    say('[v] PM2 Daemon Stopped');
    break;

  default:
    process.stderr.write('[PM2][ERROR] stub does not implement: ' + verb + '\\n');
    process.exit(2);
}
`.trimStart());

if (isWin) {
  // A .cmd shim, exactly like npm's global bin, so quoting is exercised.
  fs.writeFileSync(STUB_PM2, `@echo off\r\n"${process.execPath}" "${STUB_JS}" %*\r\n`);
} else {
  fs.writeFileSync(STUB_PM2, `#!/bin/sh\nexec "${process.execPath}" "${STUB_JS}" "$@"\n`);
  fs.chmodSync(STUB_PM2, 0o755);
}
fs.writeFileSync(STATE_FILE, JSON.stringify({ apps: [], modules: [] }));

// ─── The guard ───────────────────────────────────────────────────────────────

/**
 * Aborts unless a pm2-bearing command points at the stub inside the temp dir.
 *
 * Enforced on the command actually being executed rather than on PM2_HOME,
 * which proved to isolate nothing on Windows.
 */
function assertStubPm2(cmd) {
  const resolvedTmp = path.resolve(tmpRoot);

  if (!(cmd.includes(STUB_PM2) || cmd.includes(STUB_JS))) {
    process.stderr.write(
      '\nABORT: refusing a PM2 command that does not point at the stub.\n' +
      `  command: ${cmd}\n` +
      `  stub   : ${STUB_PM2}\n` +
      '  Running it could have reached the real PM2 daemon.\n'
    );
    process.exit(1);
  }

  if (!path.resolve(STUB_PM2).startsWith(resolvedTmp + path.sep)) {
    process.stderr.write(`\nABORT: the stub path is outside the temp directory: ${STUB_PM2}\n`);
    process.exit(1);
  }
}

const shell = await import(pathToFileURL(path.join(ROOT, 'src/core/shell.js')).href);

let pm2Calls = 0;
let schtasksQueries = 0;

/**
 * True when `cmd` actually invokes a pm2 executable.
 *
 * Matching the bare substring "pm2" is not enough: the Windows task is called
 * "EasyDevOps-PM2", so `schtasks /Query /TN "EasyDevOps-PM2"` looked like a
 * pm2 command and tripped the guard. pm2 has to appear as a command token —
 * at the start, or after a quote, whitespace, path separator or `&`.
 */
function invokesPm2(cmd) {
  // Tokenise and compare basenames instead of pattern-matching paths: it is
  // clearer, needs no backslash escaping, and correctly excludes the Windows
  // task name "EasyDevOps-PM2" whose basename is not pm2.
  return cmd.split(/[\s"'|&()]+/).some((token) => {
    const base = token.split(/[/\\]/).pop().toLowerCase();
    return base === 'pm2' || base === 'pm2.cmd' || base === 'pm2.bat' || base === 'pm2.exe';
  });
}

/** A PATH lookup reads nothing and starts nothing. */
function isPm2Lookup(cmd) {
  return /^(where\.exe|command -v)\s+pm2$/.test(cmd.trim());
}

/**
 * run() that enforces the guard.
 *
 * Two things can reach the user's machine from here, so both are checked:
 * executing a pm2 that is not the stub, and mutating a real scheduled task.
 * A read-only `schtasks /Query` is allowed — it changes nothing, and the
 * install/status paths legitimately run it.
 */
async function guardedRun(cmd, options) {
  if (/\bschtasks\b/i.test(cmd)) {
    if (/\/Create|\/Delete|\/Change|\/Run|\/End/i.test(cmd)) {
      process.stderr.write(
        '\nABORT: refusing to execute a scheduled-task MUTATION.\n' +
        `  command: ${cmd}\n` +
        '  Tests must never create, change or delete a real scheduled task.\n'
      );
      process.exit(1);
    }
    schtasksQueries++;
  }

  if (invokesPm2(cmd) && !isPm2Lookup(cmd)) {
    assertStubPm2(cmd);
    pm2Calls++;
  }

  return shell.run(cmd, options);
}

/** Records commands and executes nothing — for schtasks and elevation checks. */
function spyRun(responses = {}) {
  const calls = [];
  const fn = async (cmd) => {
    calls.push(cmd);
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        return { success: true, stdout: '', stderr: '', exitCode: 0, command: cmd, ...response };
      }
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0, command: cmd };
  };
  fn.calls = calls;
  return fn;
}

const runner = await import(pathToFileURL(path.join(ROOT, 'src/core/runner.js')).href);
const platform = await import(pathToFileURL(path.join(ROOT, 'src/core/platform.js')).href);


/** Shared options: every service/runner call targets the stub. */
const stub = () => ({ run: guardedRun, pm2Path: STUB_PM2, startupDir: STARTUP_DIR });

async function main() {
  process.stdout.write(`\nstub pm2  ${STUB_PM2}\ndata dir  ${DATA_DIR}\n`);

  // ── (0) The guard ──────────────────────────────────────────────────────────
  setGroup('(0) the stub guard');

  const pointsAtStub = (cmd) => cmd.includes(STUB_PM2) || cmd.includes(STUB_JS);
  check('guard accepts a stub command', pointsAtStub(`"${STUB_PM2}" jlist`));
  check('guard rejects a bare `pm2 jlist`', !pointsAtStub('pm2 jlist'));
  check('guard rejects the real global pm2',
    !pointsAtStub('"C:\\Users\\x\\AppData\\Roaming\\npm\\pm2.cmd" delete all'));
  check('the stub lives inside the temp directory',
    path.resolve(STUB_PM2).startsWith(path.resolve(tmpRoot) + path.sep));

  // ── (1) detect ─────────────────────────────────────────────────────────────
  setGroup('(1) runner.detect');

  // `where pm2` would find the REAL pm2, so the lookup is injected.
  const locateStub = async (cmd, opts) => {
    if (/where\.exe pm2|command -v pm2/.test(cmd)) {
      return { success: true, stdout: STUB_PM2, stderr: '', exitCode: 0, command: cmd };
    }
    return guardedRun(cmd, opts);
  };

  const detected = await runner.detect({ run: locateStub });
  check('PM2 is detected as installed', detected.installed === true);
  check('the version is parsed past the daemonisation notice',
    detected.version === STUB_VERSION, String(detected.version));
  check('the path is the stub', detected.path === STUB_PM2, String(detected.path));

  const quick = await runner.detect({ run: locateStub, probeVersion: false });
  check('probeVersion:false skips the version call, so no daemon is started',
    quick.installed === true && quick.version === null);

  const absent = await runner.detect({
    run: async (cmd) => ({ success: false, stdout: '', stderr: 'not found', exitCode: 1, command: cmd }),
  });
  check('a missing PM2 is reported, not guessed at',
    absent.installed === false && absent.path === null);

  check('pickExecutable prefers the Windows shim',
    runner.pickExecutable(['C:\\npm\\pm2', 'C:\\npm\\pm2.cmd']) ===
      (isWin ? 'C:\\npm\\pm2.cmd' : 'C:\\npm\\pm2'));
  check('pickExecutable passes through a single POSIX path',
    runner.pickExecutable(['/usr/bin/pm2']) === '/usr/bin/pm2');

  // ── (2) list / start / stop / restart / delete ────────────────────────────
  setGroup('(2) runner against the stub');

  const empty = await runner.list(stub());
  check('jlist parses with PM2 log noise around it', empty.ok === true, empty.error ?? '');
  check('no apps to begin with', empty.apps.length === 0, `${empty.apps.length}`);

  const dummy = path.join(tmpRoot, 'dummy app.mjs'); // a space, on purpose
  fs.writeFileSync(dummy, 'setInterval(() => {}, 1000);\n');

  const started = await runner.start({ script: dummy, name: 'ez-test-dummy', ...stub() });
  check('start succeeds', started.ok === true, started.output.slice(0, 80));

  const listed = await runner.list(stub());
  const app = listed.apps.find((a) => a.name === 'ez-test-dummy');
  check('the app appears in jlist', Boolean(app));
  check('status is online', app?.status === 'online', String(app?.status));
  check('pid is a number', typeof app?.pid === 'number', String(app?.pid));
  check('memory is reported in bytes', app?.memoryBytes === 52428800, String(app?.memoryBytes));
  check('uptime is a duration, not a timestamp',
    typeof app?.uptimeMs === 'number' && app.uptimeMs < 60_000, `${app?.uptimeMs}ms`);
  check('a script path containing a space survives shell quoting',
    app?.execPath === dummy, String(app?.execPath));
  check('a non-ez app is not marked managed', app?.managed === false);

  const restarted = await runner.restart('ez-test-dummy', stub());
  check('restart succeeds', restarted.ok === true);
  const afterRestart = await runner.list(stub());
  check('restart count went up',
    (afterRestart.apps.find((a) => a.name === 'ez-test-dummy')?.restarts ?? 0) === 1);

  await runner.stop('ez-test-dummy', stub());
  const stoppedApp = (await runner.list(stub())).apps.find((a) => a.name === 'ez-test-dummy');
  check('status is stopped', stoppedApp?.status === 'stopped', String(stoppedApp?.status));
  check('a stopped app reports no uptime', stoppedApp?.uptimeMs === null);
  check('a stopped app reports no pid', stoppedApp?.pid === null);

  const logged = await runner.logs('ez-test-dummy', { lines: 5, ...stub() });
  check('logs returns lines instead of streaming forever',
    logged.ok === true && logged.lines.length >= 2, `${logged.lines.length} line(s)`);

  await runner.del('ez-test-dummy', stub());
  check('delete removes the app',
    !(await runner.list(stub())).apps.some((a) => a.name === 'ez-test-dummy'));

  const missing = await runner.stop('does-not-exist', stub());
  check('acting on an unknown app fails rather than reporting success', missing.ok === false);

  // ── (3) jlist extraction and normalisation ────────────────────────────────
  setGroup('(3) jlist extraction and normalisation');

  check('skips the "[PM2]" prefix and finds the real array',
    runner.extractJsonArray('[PM2] Spawning daemon\n[{"name":"a"}]') === '[{"name":"a"}]');
  check('survives brackets inside strings',
    runner.extractJsonArray('[{"name":"a[0]","cwd":"C:\\\\x]"}]') === '[{"name":"a[0]","cwd":"C:\\\\x]"}]');
  check('returns null when there is no array at all',
    runner.extractJsonArray('[PM2] no json here') === null);
  check('returns null on an unterminated array', runner.extractJsonArray('[{"name":') === null);
  check('handles an empty array', runner.extractJsonArray('[PM2] noise\n[]') === '[]');
  check('ignores a JSON object before the array',
    runner.extractJsonArray('{"not":"it"}\n[{"name":"a"}]') === '[{"name":"a"}]');

  const norm = runner.normalizeApp({
    name: 'ez-dashboard', pm_id: 3, pid: 123, monit: { cpu: 7, memory: 52428800 },
    pm2_env: {
      status: 'online', pm_uptime: Date.now() - 5000, restart_time: 2,
      username: 'someone', env: { EASY_DEVOPS_DATA_DIR: '/tmp/x' },
    },
  });
  check('normalizeApp maps the fields the UI needs',
    norm.cpu === 7 && norm.memoryBytes === 52428800 && norm.restarts === 2 &&
    norm.user === 'someone' && norm.dataDir === '/tmp/x');
  check('normalizeApp marks ez apps as managed', norm.managed === true);
  check('normalizeApp tolerates a missing pm2_env',
    runner.normalizeApp({ name: 'x' }).status === 'unknown');
  check('appName is suffixed in dev mode',
    runner.appName(true) === 'ez-dashboard-dev' && runner.appName(false) === 'ez-dashboard');
  check('isEzApp recognises only our names',
    runner.isEzApp('ez-dashboard') && runner.isEzApp('ez-dashboard-dev') && !runner.isEzApp('my-api'));

  check('parseSudoCommand picks the sudo line out of PM2 guidance',
    runner.parseSudoCommand(
      'To setup the Startup Script, copy/paste the following command:\n' +
      'sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u me --hp /home/me\n'
    ) === 'sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u me --hp /home/me');
  check('parseSudoCommand returns null when PM2 printed none',
    runner.parseSudoCommand('[PM2] Init System already setup') === null);

  // ── (4) daemon liveness ───────────────────────────────────────────────────
  setGroup('(4) daemon liveness, checked without starting a daemon');

  check('pm2HomeDir honours PM2_HOME', runner.pm2HomeDir() === PM2_HOME, runner.pm2HomeDir());
  check('the stub wrote a pid file, so liveness is detected',
    runner.isDaemonRunning() === true);

  const pidFile = path.join(PM2_HOME, 'pm2.pid');
  const savedPid = fs.readFileSync(pidFile, 'utf8');
  fs.writeFileSync(pidFile, '999999999');
  check('a stale pid file is not treated as a running daemon',
    runner.isDaemonRunning() === false);
  fs.unlinkSync(pidFile);
  check('no pid file means no daemon', runner.isDaemonRunning() === false);
  fs.writeFileSync(pidFile, savedPid);

  return finish();
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

async function finish() {
  setGroup('teardown and isolation');

  check('every pm2 command went through the guard', pm2Calls > 0, pm2Calls + ' call(s)');
  check('no real PM2 daemon was started by this run',
    fs.existsSync(path.join(REAL_PM2_HOME, 'pm2.pid')) === realPm2PidBefore,
    fs.existsSync(path.join(REAL_PM2_HOME, 'pm2.pid')) ? 'pm2.pid present' : 'none');
  check('the real ~/.pm2 was not modified',
    snapshotDir(REAL_PM2_HOME, { ignore: PM2_SELF_CHURN }) === realPm2Before,
    realPm2Before === null ? 'does not exist' : 'unchanged');
  check('no dump.pm2 was created in the real ~/.pm2',
    fs.existsSync(path.join(REAL_PM2_HOME, 'dump.pm2')) === realPm2DumpBefore);

  // core/runner.js reaches core/db.js, so this process holds the temp
  // database open; Windows will not delete the directory until it is closed.
  try {
    const dbMod = await import(pathToFileURL(path.join(ROOT, 'src/core/db.js')).href);
    dbMod.closeDb();
  } catch { /* never loaded */ }

  check('temp directory removed', rmWithRetry(tmpRoot), tmpRoot);

  const failed = results.filter((r) => !r.passed);
  process.stdout.write('\n' + '─'.repeat(64) + '\nTOTAL ' + results.length +
    '   PASS ' + (results.length - failed.length) + '   FAIL ' + failed.length + '\n');
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write('  [' + f.group + '] ' + f.label + ' ' + f.detail + '\n');
  }
  process.exit(failed.length ? 1 : 0);
}

function rmWithRetry(dir, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* retry */ }
    if (!fs.existsSync(dir)) return true;
    const until = Date.now() + 400;
    while (Date.now() < until) { /* brief spin; teardown is synchronous */ }
  }
  return !fs.existsSync(dir);
}

main().catch((err) => {
  process.stderr.write('\nHarness error: ' + err.stack + '\n');
  rmWithRetry(tmpRoot);
  process.exit(1);
});
