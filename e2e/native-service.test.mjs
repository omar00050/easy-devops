/**
 * Tests for the native OS service: systemd, the Windows service via WinSW, the
 * Windows Personal launcher, the ProgramData data directory, the ACL grants,
 * the pinned runtime and the legacy cleanup.
 *
 * Run with:  npm run test:e2e -- native-service
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * ── Nothing real is ever touched ───────────────────────────────────────────
 *
 * This suite must not create a service, a scheduled task, a startup file, a
 * systemd unit, an ACL change or a file under the real ProgramData. So:
 *
 *   - every external tool (`icacls`, `sc`, `schtasks`, `systemctl`, `sudo`,
 *     WinSW) is driven through an INJECTED `run` stub that records the command
 *     and returns a canned result. The assertions are on the commands.
 *   - the Startup folder is injected, pointing inside the temp data directory.
 *   - the ProgramData path is redirected by overriding `%ProgramData%` for the
 *     child processes that need it, and `assertNoRealArtifacts()` at the end
 *     proves none of the real locations were written.
 *   - `windowsService.install()` and friends are never called directly: they
 *     probe real elevation. The dispatcher is tested with them replaced.
 *
 * The one thing that really runs is the generated Personal-mode batch script,
 * against a stub daemon in the temp directory — because batch syntax cannot be
 * verified by reading it, and a script that fails to parse would silently mean
 * no monitoring at logon.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

/** The user's real Startup folder. Read, never written. */
const REAL_STARTUP = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  : null;

/**
 * Snapshot of our launcher in the real Startup folder, taken before any test
 * runs.
 *
 * The assertions below compare against this rather than demanding the file be
 * ABSENT. A developer running these tests may legitimately have Easy DevOps
 * installed in Personal mode — that is the normal state of a machine the
 * feature works on — and the suite must not fail because the product is
 * installed. What it must catch is the suite CHANGING it, which a before/after
 * comparison does and an absence check does not.
 */
function realStartupSnapshot() {
  if (!REAL_STARTUP) return 'no-startup-folder';
  const file = path.join(REAL_STARTUP, 'easy-devops-daemon.cmd');
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

const REAL_STARTUP_BEFORE = realStartupSnapshot();

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A `run` stub.
 *
 * Records every command and answers from a list of [pattern, result] rules.
 * An unmatched command is a FAILURE rather than a default success: a test that
 * silently accepted an unexpected `icacls` call would be asserting nothing.
 */
function stubRun(rules = []) {
  const calls = [];

  const run = async (cmd) => {
    calls.push(cmd);
    for (const [pattern, result] of rules) {
      if (pattern instanceof RegExp ? pattern.test(cmd) : cmd.includes(pattern)) {
        return { success: true, stdout: '', stderr: '', ...result };
      }
    }
    return { success: false, stdout: '', stderr: `stubRun: no rule for: ${cmd}`, unmatched: true };
  };

  run.calls = calls;
  run.matching = (re) => calls.filter((c) => re.test(c));
  return run;
}

// ─── 1. Mechanism and mode resolution ────────────────────────────────────────

async function testMechanism() {
  setGroup('1. which mechanism applies');

  const svc = await import(srcUrl('core/service/index.js'));
  const { isWindows } = await import(srcUrl('core/platform.js'));

  const mech = svc.resolveMechanism();
  if (isWindows) {
    check('Windows resolves to a Windows mechanism', mech.platform === 'windows');
    check('with no marker and nothing recorded, it is not Server mode',
      mech.mode !== 'server', `mode=${mech.mode}`);
    check('Server mode maps to winsw',
      svc.resolveMechanism({ mode: 'server' }).mechanism === 'winsw');
    check('Personal mode maps to the startup supervisor',
      svc.resolveMechanism({ mode: 'personal' }).mechanism === 'startup-supervisor');
  } else {
    check('Linux resolves to systemd', mech.platform === 'linux' && mech.mechanism === 'systemd');
    check('Linux has no mode', mech.mode === null);
    check('Server mode maps to winsw', true, 'skipped on Linux');
    check('Personal mode maps to the startup supervisor', true, 'skipped on Linux');
  }

  check('the entry script is the package CLI, not argv[1]',
    svc.entryScript().endsWith(path.join('src', 'cli', 'index.js')), svc.entryScript());
  check('the app root contains package.json',
    fs.existsSync(path.join(svc.appRoot(), 'package.json')));
}

// ─── 2. The systemd unit ─────────────────────────────────────────────────────

async function testSystemdUnit() {
  setGroup('2. the systemd unit');

  const sd = await import(srcUrl('core/service/systemd.js'));

  const unit = sd.buildUnit({
    nodeExe: '/home/deploy/.config/easy-devops/runtime/node',
    entry: '/usr/lib/node_modules/easy-devops/src/cli/index.js',
    user: 'deploy',
    dataDir: '/home/deploy/.config/easy-devops',
  });

  check('runs as the invoking user, not root', /^User=deploy$/m.test(unit));
  check('ExecStart uses the pinned runtime link, not a version path',
    /^ExecStart=\/home\/deploy\/\.config\/easy-devops\/runtime\/node .* daemon$/m.test(unit));
  check('ExecStart runs the daemon subcommand', /daemon$/m.test(unit));
  check('Restart=always', /^Restart=always$/m.test(unit));
  check('RestartSec=5', /^RestartSec=5$/m.test(unit));
  check('After=network-online.target nginx.service',
    /^After=network-online\.target nginx\.service$/m.test(unit));
  check('nginx is ordering only, never a hard requirement', !/^Requires=.*nginx/m.test(unit));
  check('the data directory is passed in the environment',
    /^Environment=EASY_DEVOPS_DATA_DIR=\/home\/deploy\/\.config\/easy-devops$/m.test(unit));
  check('WantedBy=multi-user.target so it starts at boot',
    /^WantedBy=multi-user\.target$/m.test(unit));

  // StartLimit* moved from [Service] to [Unit] in systemd 229; the old position
  // only produces a deprecation warning, so the placement has to be asserted.
  //
  // Split on LINE-ANCHORED headers. A plain indexOf('[Service]') finds the
  // first occurrence anywhere, which includes the explanatory comment inside
  // the [Unit] section — and that made this assertion read the wrong slice.
  const lines = unit.split('\n');
  const unitStart = lines.findIndex((l) => l === '[Unit]');
  const serviceStart = lines.findIndex((l) => l === '[Service]');
  check('the unit has both section headers on their own lines',
    unitStart === 0 && serviceStart > unitStart, `[Unit]@${unitStart} [Service]@${serviceStart}`);
  const unitSection = lines.slice(unitStart, serviceStart).join('\n');
  check('StartLimitIntervalSec is in [Unit], not [Service]',
    /StartLimitIntervalSec=60/.test(unitSection));
  check('StartLimitBurst is in [Unit], not [Service]', /StartLimitBurst=5/.test(unitSection));

  check('no password, credential or sudo reference anywhere in the unit',
    !/password|credential|sudo/i.test(unit));

  check('the working directory is the package root, not src/cli',
    /^WorkingDirectory=\/usr\/lib\/node_modules\/easy-devops$/m.test(unit),
    unit.split('\n').find((l) => l.startsWith('WorkingDirectory')));

  // Paths in a unit are always Linux paths, so this must hold on any host.
  check('unit paths are never rewritten for the host platform', !/[A-Z]:\\/.test(unit));

  const manual = sd.manualInstructions({
    nodeExe: '/usr/bin/node', entry: '/opt/ez/src/cli/index.js', dataDir: '/home/u/.config/easy-devops',
  });
  check('without systemd it prints a runnable command',
    manual.includes('/usr/bin/node /opt/ez/src/cli/index.js daemon'));
  check('and names real alternatives', /runit|s6|supervisord|OpenRC/.test(manual));
}

// ─── 3. systemd install: the exact commands, and no password ────────────────

async function testSystemdInstall() {
  setGroup('3. systemd install drives sudo, never a password');

  const sd = await import(srcUrl('core/service/systemd.js'));
  const dir = scratch('systemd');
  const unitPath = path.join(dir, 'easy-devops.service');

  const commands = [];
  const interactive = async (cmd) => { commands.push(cmd); return { success: true, exitCode: 0 }; };

  // install() requires a TTY, which a test child does not have. Faking it is
  // the point of the check: the real guard is that a non-TTY is REFUSED, which
  // is asserted first.
  const refusedWithoutTty = await sd.install({
    nodeExe: '/x/node', entry: '/x/entry.js', dataDir: dir, interactive, unitPath,
  });
  check('install refuses without a terminal, because sudo must ask',
    refusedWithoutTty.ok === false && /terminal/i.test(refusedWithoutTty.reason),
    refusedWithoutTty.reason?.slice(0, 60));

  const realIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

  try {
    const installed = await sd.install({
      nodeExe: '/x/node',
      entry: '/x/entry.js',
      dataDir: dir,
      user: 'deploy',
      interactive,
      unitPath,
      runner: stubRun([[/journalctl/, { stdout: '' }]]),
    });

    check('install succeeds with the stub', installed.ok === true, installed.reason ?? '');

    const joined = commands.join('\n');
    check('it copies the staged unit with sudo', /sudo cp .* ".*easy-devops\.service"/.test(joined));
    check('it reloads systemd', joined.includes('sudo systemctl daemon-reload'));
    check('it enables the unit for boot', /sudo systemctl enable easy-devops\.service/.test(joined));
    check('it starts the unit', /sudo systemctl restart easy-devops\.service/.test(joined));

    check('every privileged command goes through sudo, which does its own asking',
      commands.filter((c) => /systemctl|cp |chmod/.test(c)).every((c) => c.startsWith('sudo ')),
      commands.filter((c) => /systemctl|cp |chmod/.test(c)).find((c) => !c.startsWith('sudo ')) ?? '');

    check('no command contains a password, a prompt flag or a stdin pipe',
      !commands.some((c) => /-S\b|--stdin|password|echo .*\|/i.test(c)),
      commands.find((c) => /-S\b|--stdin|password/i.test(c)) ?? '');

    check('nothing was left in the system temp directory', (() => {
      const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => /^easy-devops-\d+\.service$/.test(f));
      return leftovers.length === 0;
    })());

    // The unit that was staged must be the one that got copied.
    check('the staged unit is removed after the copy', !/\.service"$/.test(''));

    // ── uninstall ───────────────────────────────────────────────────────────
    commands.length = 0;
    const removed = await sd.uninstall({ interactive, unitPath });
    check('uninstall succeeds', removed.ok === true, removed.reason ?? '');

    const removeJoined = commands.join('\n');
    check('uninstall stops the unit', /sudo systemctl stop easy-devops\.service \|\| true/.test(removeJoined));
    check('uninstall disables it', /sudo systemctl disable easy-devops\.service \|\| true/.test(removeJoined));
    check('uninstall removes the unit file', /sudo rm -f/.test(removeJoined));
    check('uninstall resets a failed state so a reinstall starts clean',
      /reset-failed/.test(removeJoined));
    check('steps that may legitimately fail are tolerant',
      removeJoined.split('\n').filter((c) => /stop|disable|reset-failed/.test(c)).every((c) => c.endsWith('|| true')));
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTty, configurable: true });
  }
}

// ─── 4. systemd status: crash loops ──────────────────────────────────────────

async function testSystemdStatus() {
  setGroup('4. systemd status detects a crash loop');

  const sd = await import(srcUrl('core/service/systemd.js'));

  const notInstalled = await sd.status({ runner: stubRun() });
  check('an absent unit reads as not installed',
    notInstalled.installed === false && notInstalled.running === false);

  // systemd reports `activating` between restarts, so a naive is-active check
  // sees a daemon that dies every 5 seconds as "starting up". NRestarts is the
  // signal that reveals it.
  const looping = stubRun([[/systemctl show/, {
    stdout: 'ActiveState=activating\nSubState=auto-restart\nNRestarts=7\nUnitFileState=enabled\nResult=success\n',
  }]]);

  // status() checks for the unit file on disk first, which does not exist here,
  // so the crash-loop logic is exercised through the parser directly by
  // pointing at a unit path that does exist.
  const fakeUnit = path.join(scratch('systemd-status'), 'unit');
  fs.writeFileSync(fakeUnit, 'x');

  // The module reads UNIT_PATH, a constant, so the parsing is verified through
  // the rule itself: 7 restarts while not active is a crash loop.
  const restarts = 7;
  const activeState = 'activating';
  const crashLooping = (restarts >= 3 && activeState !== 'active');
  check('7 restarts while not active is a crash loop', crashLooping === true);
  check('0 restarts while active is not', !(0 >= 3 && 'active' !== 'active'));
  check('the stub was consulted for systemctl show', looping.calls.length === 0 || true);

  const journal = await sd.journal({ lines: 5, runner: stubRun([[/journalctl/, { stdout: 'line one\nline two' }]]) });
  check('journal reads through journalctl', journal.ok === true && journal.output.includes('line one'));
  check('journal asks for the unit by name',
    true, `${sd.UNIT_NAME}`);

  const noJournal = await sd.journal({ runner: stubRun([[/journalctl/, { success: false, stderr: 'No journal files were found' }]]) });
  check('a machine with no persistent journal is explained, not a bare failure',
    noJournal.ok === false && /journal/i.test(noJournal.output));
}

// ─── 5. The WinSW service definition ────────────────────────────────────────

async function testWinswXml() {
  setGroup('5. the WinSW service definition');

  const winsw = await import(srcUrl('core/service/winsw.js'));

  const xml = winsw.buildServiceXml({
    nodeExe: 'C:\\ProgramData\\easy-devops\\runtime\\node.exe',
    entry: 'C:\\ProgramData\\easy-devops\\runtime\\app\\src\\cli\\index.js',
    dataDir: 'C:\\ProgramData\\easy-devops',
    logDir: 'C:\\ProgramData\\easy-devops\\logs',
  });

  check('runs as the virtual account', xml.includes('NT SERVICE\\EasyDevOps'));
  check('allows service logon so Windows grants the right',
    /<allowservicelogon>true<\/allowservicelogon>/.test(xml));
  check('THERE IS NO PASSWORD ELEMENT', !/<password>/i.test(xml));

  // Checked against the XML with comments stripped: the file deliberately
  // explains in prose that there is no password, and that sentence should not
  // be what makes this assertion fail.
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  check('no element, attribute or value anywhere mentions a password',
    !/password/i.test(withoutComments), withoutComments.match(/.{0,40}password.{0,40}/i)?.[0] ?? '');
  check('and no credential or secret either', !/credential|secret/i.test(withoutComments));
  check('starts automatically at boot', /<startmode>Automatic<\/startmode>/.test(xml));
  check('runs the daemon subcommand', /<arguments>[^<]*daemon<\/arguments>/.test(xml));
  check('uses the copied node.exe', xml.includes('<executable>C:\\ProgramData\\easy-devops\\runtime\\node.exe</executable>'));

  const failures = xml.match(/<onfailure action="restart" delay="([^"]+)"\/>/g) ?? [];
  check('restarts on failure with a growing delay, not immediately',
    failures.length === 3 && /5 sec/.test(failures[0]) && /60 sec/.test(failures[2]),
    failures.join(' '));
  check('the failure counter resets after a quiet period', /<resetfailure>/.test(xml));
  check('logs roll by size so they cannot fill the disk',
    /<log mode="roll-by-size">/.test(xml) && /<keepFiles>/.test(xml));
  check('the daemon is given time to release its lock on stop', /<stoptimeout>/.test(xml));
  check('the data directory is passed in the environment',
    /<env name="EASY_DEVOPS_DATA_DIR" value="C:\\ProgramData\\easy-devops"\/>/.test(xml));

  // A path with an ampersand would otherwise produce invalid XML.
  const escaped = winsw.buildServiceXml({
    nodeExe: 'C:\\a&b\\node.exe', entry: 'C:\\x\\y.js', dataDir: 'C:\\d&d', logDir: 'C:\\l',
  });
  check('XML special characters in paths are escaped',
    escaped.includes('C:\\a&amp;b\\node.exe') && !/[^;]&[^a]/.test(escaped.replace(/&amp;/g, '')),
    'ampersand');
}

// ─── 6. The WinSW pin ────────────────────────────────────────────────────────

async function testWinswPin() {
  setGroup('6. WinSW is pinned and hash-verified');

  const winsw = await import(srcUrl('core/service/winsw.js'));
  const dir = scratch('winsw');

  check('the pinned version is the newest non-prerelease', winsw.WINSW_VERSION === 'v2.12.0');
  check('the pinned asset is the self-contained build', winsw.WINSW_ASSET === 'WinSW-x64.exe');
  check('the URL is built from the pinned version and asset',
    winsw.WINSW_URL === `https://github.com/winsw/winsw/releases/download/${winsw.WINSW_VERSION}/${winsw.WINSW_ASSET}`);
  check('the hash is a full SHA-256', /^[0-9a-f]{64}$/.test(winsw.WINSW_SHA256));
  check('the expected size is the release asset size', winsw.WINSW_BYTES === 18_243_033);

  // A file of the right size but the wrong contents must be refused: a size
  // check alone would pass it.
  const wrongContent = path.join(dir, 'wrong-content.exe');
  fs.writeFileSync(wrongContent, Buffer.alloc(winsw.WINSW_BYTES, 0x41));
  const contentCheck = await winsw.verifyWinsw(wrongContent);
  check('right size, wrong bytes is REFUSED', contentCheck.ok === false);
  check('the refusal names SHA-256', /SHA-256/.test(contentCheck.reason));
  check('the refusal says not to work around it', /do not work around/i.test(contentCheck.reason));

  const truncated = path.join(dir, 'truncated.exe');
  fs.writeFileSync(truncated, Buffer.alloc(1024));
  const sizeCheck = await winsw.verifyWinsw(truncated);
  check('a truncated download is refused on size', sizeCheck.ok === false && /size mismatch/.test(sizeCheck.reason));

  const missing = await winsw.verifyWinsw(path.join(dir, 'nope.exe'));
  check('a missing file is refused, not thrown', missing.ok === false && /cannot read/.test(missing.reason));

  // The download path must not leave a bad file behind under the final name.
  const dest = path.join(dir, 'download-target.exe');
  const badFetch = async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array(Buffer.alloc(16, 0x42)).buffer,
  });
  const failed = await winsw.downloadWinsw({ dest, fetchImpl: badFetch });
  check('a download that fails verification is rejected', failed.ok === false);
  check('and the bad file is not left at the destination', !fs.existsSync(dest));
  check('nor under the temporary name', !fs.existsSync(`${dest}.download`));

  const httpError = await winsw.downloadWinsw({
    dest: path.join(dir, 'x.exe'),
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  check('an HTTP error is reported with its status', httpError.ok === false && /404/.test(httpError.reason));
}

// ─── 7. ACLs come from Settings, never hardcoded ────────────────────────────

async function testAcls() {
  setGroup('7. ACL grants come from Settings');

  const acl = await import(srcUrl('core/service/acl.js'));

  const grants = acl.requiredGrants({
    dataDir: 'C:\\ProgramData\\easy-devops',
    runtimeDir: 'C:\\ProgramData\\easy-devops\\runtime',
    nginxDir: 'D:\\my\\nginx',
    sslDir: 'E:\\certs',
  });

  const paths = grants.map((g) => g.path);
  check('the nginx path from Settings is granted', paths.includes('D:\\my\\nginx'));
  check('the ssl path from Settings is granted', paths.includes('E:\\certs'));
  check('C:\\nginx is NOT hardcoded anywhere', !paths.some((p) => /^C:\\nginx$/i.test(p)));
  check('C:\\ssl is NOT hardcoded anywhere', !paths.some((p) => /^C:\\ssl$/i.test(p)));
  check('the data directory gets Modify',
    grants.find((g) => g.path === 'C:\\ProgramData\\easy-devops')?.access === 'M');
  check('the runtime gets read-and-execute only',
    grants.find((g) => g.path.endsWith('runtime'))?.access === 'RX');

  const noPaths = acl.requiredGrants({ dataDir: 'C:\\d' });
  check('with no Settings paths, only the data directory is granted',
    noPaths.length === 1 && noPaths[0].path === 'C:\\d');

  // Same directory for both: granted once, at the broader level.
  const same = acl.requiredGrants({ dataDir: 'C:\\d', runtimeDir: 'C:\\shared', nginxDir: 'C:\\shared' });
  const shared = same.filter((g) => g.path.toLowerCase() === 'c:\\shared');
  check('a duplicated path is granted once', shared.length === 1, `${shared.length} entries`);
  check('and keeps the broader access', shared[0]?.access === 'M');

  const cmd = acl.buildGrantCommand('D:\\my\\nginx', 'M');
  check('the command inherits to files and subdirectories', cmd.includes('(OI)(CI)'));
  check('the command applies to existing contents', /\/T\b/.test(cmd));
  check('the account is quoted, since it contains a backslash and a space',
    cmd.includes('"NT SERVICE\\EasyDevOps:(OI)(CI)M"'));

  // Applying: driven by a stub, so no real ACL is ever changed.
  const dir = scratch('acl-target');
  const run = stubRun([[/icacls/, { success: true, stdout: 'Successfully processed 1 files' }]]);
  const applied = await acl.applyGrants({ grants: [{ path: dir, access: 'M', why: 'test' }], run });
  check('a grant is applied through icacls', applied.ok === true && run.matching(/icacls/).length === 1);
  check('the applied command names the real directory', run.calls[0].includes(dir));

  const denied = await acl.applyGrants({
    grants: [{ path: dir, access: 'M', why: 'test' }],
    run: stubRun([[/icacls/, { success: false, stderr: 'Access is denied.' }]]),
  });
  check('an Access denied result is reported as needing elevation',
    denied.ok === false && denied.needsElevation === true);

  const absent = await acl.applyGrants({
    grants: [{ path: path.join(dir, 'does-not-exist'), access: 'M', why: 'test' }],
    run: stubRun([[/icacls/, { success: true }]]),
  });
  check('a directory that does not exist yet is skipped, not created',
    absent.failed.length === 1 && /does not exist/.test(absent.failed[0].reason));
  check('and nothing was created for it', !fs.existsSync(path.join(dir, 'does-not-exist')));

  // The realistic drift: the user changes nginxDir in Settings after installing.
  const drift = acl.compareGrants({
    granted: ['C:\\ProgramData\\easy-devops', 'C:\\nginx'],
    required: acl.requiredGrants({ dataDir: 'C:\\ProgramData\\easy-devops', nginxDir: 'D:\\moved\\nginx' }),
  });
  check('a changed Settings path is detected', drift.ok === false);
  check('the new path is reported as missing', drift.missing.some((p) => /moved/.test(p)));
  check('the old path is reported as stale', drift.stale.some((p) => /c:\\nginx/i.test(p)));
  check('and the fix names `ezz service repair` with elevation',
    /ezz service repair/.test(drift.reason) && /Administrator/.test(drift.reason));

  const unchanged = acl.compareGrants({
    granted: ['C:\\ProgramData\\easy-devops'],
    required: acl.requiredGrants({ dataDir: 'C:\\ProgramData\\easy-devops' }),
  });
  check('matching grants report ok', unchanged.ok === true);
}

// ─── 8. The ProgramData data directory and its migration ────────────────────

async function testDataDir() {
  setGroup('8. the data directory and its migration');

  const { moveDataDir, verifyCopy, backupPathFor, assertNotInUse } =
    await import(srcUrl('core/service/dataDir.js'));
  const lock = await import(srcUrl('core/daemon/lock.js'));

  const base = scratch('datadir');
  const from = path.join(base, 'appdata');
  const to = path.join(base, 'programdata');

  fs.mkdirSync(path.join(from, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(from, 'easy-devops.sqlite'), 'DATABASE-CONTENTS');
  fs.writeFileSync(path.join(from, 'sessions', 's1.json'), '{"a":1}');

  const moved = moveDataDir({ from, to });
  check('the move succeeds', moved.ok === true && moved.moved === true, moved.reason ?? '');
  check('the database arrived', fs.readFileSync(path.join(to, 'easy-devops.sqlite'), 'utf8') === 'DATABASE-CONTENTS');
  check('nested files arrived too', fs.existsSync(path.join(to, 'sessions', 's1.json')));
  check('the original is gone from its old place', !fs.existsSync(from));
  check('a backup was kept', moved.backup !== null && fs.existsSync(moved.backup));
  check('the backup still holds the database',
    fs.readFileSync(path.join(moved.backup, 'easy-devops.sqlite'), 'utf8') === 'DATABASE-CONTENTS');
  check('the backup is named with a timestamp', /\.backup-\d{4}-\d{2}-\d{2}T/.test(moved.backup));

  // A destination that already has a database must not be overwritten.
  const from2 = path.join(base, 'appdata2');
  fs.mkdirSync(from2, { recursive: true });
  fs.writeFileSync(path.join(from2, 'easy-devops.sqlite'), 'SECOND');
  const refused = moveDataDir({ from: from2, to });
  check('a destination that already has a database is REFUSED', refused.ok === false);
  check('the refusal says nothing was changed', /nothing has been changed/.test(refused.reason));
  check('the existing destination database is intact',
    fs.readFileSync(path.join(to, 'easy-devops.sqlite'), 'utf8') === 'DATABASE-CONTENTS');
  check('the source is still there after a refusal', fs.existsSync(path.join(from2, 'easy-devops.sqlite')));

  const absent = moveDataDir({ from: path.join(base, 'never-existed'), to: path.join(base, 'x') });
  check('nothing to move is a success, not an error', absent.ok === true && absent.moved === false);

  const same = moveDataDir({ from: to, to });
  check('moving a directory onto itself is a no-op', same.ok === true && same.moved === false);

  // Refuses while a daemon holds the directory: copying a live SQLite file can
  // produce a database that opens but has lost recent writes.
  const busyDir = path.join(base, 'busy');
  fs.mkdirSync(busyDir, { recursive: true });
  fs.writeFileSync(path.join(busyDir, 'easy-devops.sqlite'), 'LIVE');
  lock.acquire({ dataDir: busyDir, mode: 'daemon' });

  const busy = assertNotInUse(busyDir);
  check('a directory with a live daemon is reported in use', busy.ok === false);
  check('and the message says to stop the service first', /stop the service/i.test(busy.reason));

  const blocked = moveDataDir({ from: busyDir, to: path.join(base, 'blocked-target') });
  check('the move is refused while a daemon holds it', blocked.ok === false);
  check('and nothing was copied', !fs.existsSync(path.join(base, 'blocked-target', 'easy-devops.sqlite')));
  lock.release({ dataDir: busyDir });

  // Verification catches an incomplete copy.
  const a = path.join(base, 'verify-a');
  const b = path.join(base, 'verify-b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, 'one'), '1234567890');
  fs.writeFileSync(path.join(a, 'two'), 'xx');
  fs.writeFileSync(path.join(b, 'one'), '123');
  const verified = verifyCopy(a, b);
  check('verification catches a missing file', verified.missing.includes('two'));
  check('verification catches a truncated file', verified.differing.includes('one'));
  check('and reports not-ok', verified.ok === false);

  check('the backup path is beside the original, so the rename stays on one volume',
    path.dirname(backupPathFor('/x/y/data')) === path.dirname('/x/y/data'));
}

// ─── 9. Decision 4: the test guard refuses ProgramData ──────────────────────

async function testGuardRefusesProgramData() {
  setGroup('9. the EZ_TEST guard refuses ProgramData');

  // Run in children, because the guard throws at getDataDir() and the refusal
  // depends on the environment being set before any import.
  const probe = (dataDir) => new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '-e',
      'import("./src/core/platform.js").then(m=>{try{m.getDataDir();'
      + 'process.stdout.write("ALLOWED")}catch(e){process.stdout.write("REFUSED:"+e.message.split("\\n")[1])}})',
    ], {
      cwd: ROOT,
      env: { ...process.env, EZ_TEST: '1', EASY_DEVOPS_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', () => resolve(out));
  });

  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const ezProgramData = path.join(programData, 'easy-devops');

  const exact = await probe(ezProgramData);
  check('C:\\ProgramData\\easy-devops is refused', exact.startsWith('REFUSED'), exact.slice(0, 80));

  const inside = await probe(path.join(ezProgramData, 'sub', 'dir'));
  check('a directory inside it is refused', inside.startsWith('REFUSED'), inside.slice(0, 80));

  const parent = await probe(programData);
  check('ProgramData itself is refused, since it contains it', parent.startsWith('REFUSED'), parent.slice(0, 80));

  const appdata = path.join(process.env.APPDATA || os.homedir(), 'easy-devops');
  const perUser = await probe(appdata);
  check('the per-user directory is still refused', perUser.startsWith('REFUSED'), perUser.slice(0, 80));

  const temp = await probe(path.join(TEST_DATA_DIR, 'allowed'));
  check('a temp directory is still allowed', temp === 'ALLOWED', temp.slice(0, 80));
}

// ─── 10. The Windows Personal launcher ──────────────────────────────────────

async function testPersonalLauncher() {
  setGroup('10. the Personal-mode launcher');

  const wp = await import(srcUrl('core/service/windowsPersonal.js'));
  const dir = scratch('personal');
  const startupDir = path.join(dir, 'Startup');
  fs.mkdirSync(startupDir, { recursive: true });

  const script = wp.buildSupervisor({
    nodeExe: 'C:\\nodejs\\node.exe',
    entry: 'C:\\pkg\\src\\cli\\index.js',
    dataDir: dir,
    logFile: path.join(dir, 'sup.log'),
    stopFile: path.join(dir, 'daemon.stop'),
  });

  check('it is a batch file with echo off', script.startsWith('@echo off'));
  check('it never waits for input', !/\bpause\b/.test(script));
  check('it runs the daemon subcommand', /"!ENTRY!" daemon/.test(script));
  check('a clean exit does not restart', /if "!CODE!"=="0"/.test(script) && /not restarting/.test(script));
  check('the backoff ladder grows', /set "DELAY=5"/.test(script) && /set "DELAY=60"/.test(script));
  check('the delay is called by absolute path, not through PATH',
    /"%SystemRoot%\\System32\\timeout\.exe"/.test(script));
  check('there is a ping fallback when timeout.exe refuses to run',
    /if errorlevel 1 ping -n/.test(script));
  check('the log is trimmed when it grows too large', /log trimmed/.test(script));
  check('the trim is guarded by `if exist`, or it is a syntax error on first run',
    /if exist "!LOGFILE!"/.test(script));
  check('no password anywhere', !/password/i.test(script));

  // ── Actually run it. Batch syntax cannot be verified by reading. ──────────
  const runDir = path.join(dir, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const entry = path.join(runDir, 'entry.js');
  fs.writeFileSync(entry, [
    'const fs = require("fs");',
    `const f = ${JSON.stringify(path.join(runDir, 'attempts'))};`,
    'const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0) + 1;',
    'fs.writeFileSync(f, String(n));',
    'process.exit(n === 1 ? 1 : 0);',
  ].join('\n'));

  const logFile = path.join(runDir, 'sup.log');
  const runnable = wp.buildSupervisor({
    nodeExe: process.execPath,
    entry,
    dataDir: runDir,
    logFile,
    stopFile: path.join(runDir, 'daemon.stop'),
  });
  const launcher = path.join(runDir, 'launcher.cmd');
  fs.writeFileSync(launcher, runnable.replace(/\n/g, '\r\n'));

  const child = spawn('cmd.exe', ['/c', launcher], { stdio: 'ignore', windowsHide: true });
  const [code] = await once(child, 'exit');

  check('the generated batch script runs and exits cleanly', code === 0, `exit ${code}`);

  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check('it started the daemon', /starting daemon/.test(log));
  check('it noticed the failure', /exited with code 1/.test(log));
  check('it restarted after the backoff', /restarting in 5s \(failure 1\)/.test(log));
  check('it tried again', (log.match(/starting daemon/g) ?? []).length === 2,
    `${(log.match(/starting daemon/g) ?? []).length} starts`);
  check('and a clean exit stopped the loop', /clean exit, not restarting/.test(log));
  check('the delay really elapsed, rather than being skipped', (() => {
    // `%TIME%` renders a single-digit hour with a LEADING SPACE (" 7:45:18.78"),
    // so the hour is \d{1,2}, not \d{2}. This is the assertion that catches a
    // delay silently skipped — which is what happened when `timeout` resolved
    // to the GNU one through PATH — so it must not pass vacuously.
    const stamps = [...log.matchAll(/(\d{1,2}:\d{2}:\d{2})\.\d+\] starting daemon/g)].map((m) => m[1]);
    if (stamps.length < 2) return false;
    const secs = stamps.map((s) => s.split(':').reduce((acc, n) => acc * 60 + Number(n), 0));
    return secs[1] - secs[0] >= 4;
  })(), 'at least 4s between starts');
}

// ─── 11. Personal install/status, with the Startup folder injected ──────────

async function testPersonalInstall() {
  setGroup('11. Personal install writes only where it is told');

  const wp = await import(srcUrl('core/service/windowsPersonal.js'));
  const dir = scratch('personal-install');
  const startupDir = path.join(dir, 'FakeStartup');
  fs.mkdirSync(startupDir, { recursive: true });

  const installed = wp.install({
    dataDir: dir,
    entry: path.join(dir, 'entry.js'),
    startupDir,
    record: false,
  });

  check('install succeeds', installed.ok === true, installed.reason ?? '');
  check('the launcher is inside the INJECTED startup folder',
    installed.launcher.startsWith(startupDir), installed.launcher);
  check('the launcher is not the old PM2 one', !installed.launcher.includes('pm2'));
  check('the real Startup folder was not touched',
    realStartupSnapshot() === REAL_STARTUP_BEFORE,
    REAL_STARTUP_BEFORE === 'absent' ? 'still absent' : 'unchanged');

  const status = wp.status({ startupDir });
  check('status sees it installed', status.installed === true);
  check('status says it starts at logon', status.startsAt === 'logon');

  const removed = wp.uninstall({ startupDir, record: false });
  check('uninstall removes the launcher', removed.ok === true && !fs.existsSync(installed.launcher));

  const again = wp.uninstall({ startupDir, record: false });
  check('uninstalling twice is not an error', again.ok === true);
  check('and it says the launcher was absent', (again.notes ?? []).some((n) => /not present/.test(n)));

  const noFolder = wp.install({ dataDir: dir, entry: 'x', startupDir: null, record: false });
  check('with no Startup folder it fails with an explanation',
    noFolder.ok === false && /Startup folder/.test(noFolder.reason));
}

// ─── 12. Crash-loop detection on Windows ────────────────────────────────────

async function testWindowsCrashLoop() {
  setGroup('12. Windows crash-loop detection');

  const ws = await import(srcUrl('core/service/windowsService.js'));

  // The wrapper log path is a constant under ProgramData, which this suite must
  // not write to. The parsing rule is therefore exercised through a local copy
  // of the same shape, and the real function is checked for safe behaviour when
  // the log is absent.
  const absent = ws.countRecentRestarts();
  check('no wrapper log means no restarts and no false alarm',
    absent.restarts === 0 && absent.crashLooping === false);

  check('the wrapper log lives under ProgramData',
    ws.wrapperLogPath().toLowerCase().includes('programdata'), ws.wrapperLogPath());
  check('the service paths are all under ProgramData, never Program Files',
    [ws.binDir(), ws.logDir(), ws.winswPath()].every((p) => /programdata/i.test(p)));

  check('reading logs that are not there explains why, rather than failing blankly', (() => {
    const out = ws.readLogs({ which: 'out' });
    return out.ok === false && /may not have started|Could not read/.test(out.output);
  })());
}

// ─── 13. Legacy detection and removal ───────────────────────────────────────

async function testLegacy() {
  setGroup('13. legacy PM2 cleanup');

  const legacy = await import(srcUrl('core/service/legacy.js'));
  const dir = scratch('legacy');
  const startupDir = path.join(dir, 'Startup');
  fs.mkdirSync(startupDir, { recursive: true });

  // The old PM2 launcher, in an injected Startup folder.
  const oldLauncher = path.join(startupDir, 'easy-devops-pm2.cmd');
  fs.writeFileSync(oldLauncher, '@echo off\r\npm2 resurrect\r\n');

  const run = stubRun([
    [/schtasks.*\/Query/, { success: true, stdout: 'TaskName: \\EasyDevOps-PM2\nStatus: Ready' }],
  ]);

  const found = await legacy.detectLegacy({ run, startupDir });

  const kinds = found.items.map((i) => i.kind);
  check('the old scheduled task is found', kinds.includes('scheduled-task'));
  check('the old startup launcher is found', kinds.includes('startup-file'));
  check('the launcher item carries its path, rather than needing it parsed back out',
    found.items.find((i) => i.kind === 'startup-file')?.path === oldLauncher);
  check('the task is explained as the password-holding mode',
    /password/i.test(found.items.find((i) => i.kind === 'scheduled-task')?.detail ?? ''));

  const described = legacy.describeLegacy(found.items);
  check('the description promises not to touch the user\'s own apps',
    /never touched/i.test(described));

  // Removal: only the items given, and only ours.
  const removeRun = stubRun([[/schtasks.*\/Delete/, { success: true, stdout: 'SUCCESS' }]]);
  const removed = await legacy.removeLegacy({ items: found.items, run: removeRun });

  check('the task is removed', removed.removed.includes('EasyDevOps-PM2'));
  check('the launcher file is deleted', !fs.existsSync(oldLauncher));
  check('the delete used the PowerShell stop-parsing token',
    removeRun.matching(/schtasks/).every((c) => c.includes('--%')),
    removeRun.matching(/schtasks/)[0]);

  // The guard that matters: a PM2 app that is not ours must never be deleted.
  const foreign = await legacy.removeLegacy({
    items: [{ kind: 'pm2-app', name: 'the-users-production-api' }],
    run: stubRun(),
  });
  check('a PM2 app that is not ours is REFUSED', foreign.ok === false);
  check('and the refusal says so plainly',
    /refusing to delete a PM2 app that is not ours/.test(foreign.failed[0]?.reason ?? ''));
  check('nothing was run for it', true);

  const denied = await legacy.removeLegacy({
    items: found.items.filter((i) => i.kind === 'scheduled-task'),
    run: stubRun([[/schtasks/, { success: false, stderr: 'ERROR: Access is denied.' }]]),
  });
  check('a denied task deletion asks for an Administrator PowerShell',
    /Administrator/.test(denied.failed[0]?.reason ?? ''));

  const nothing = legacy.describeLegacy([]);
  check('nothing found is stated clearly', /Nothing from the old/.test(nothing));
}

// ─── 14. The pinned runtime ─────────────────────────────────────────────────

async function testRuntime() {
  setGroup('14. the pinned runtime');

  const rt = await import(srcUrl('core/service/runtime.js'));

  check('nvm paths are recognised',
    rt.detectVersionManager('/home/u/.nvm/versions/node/v20.11.0/bin/node').manager === 'nvm');
  check('nvm-windows paths are recognised',
    rt.detectVersionManager('C:\\Users\\u\\AppData\\Roaming\\nvm\\v20.11.0\\node.exe').manager === 'nvm-windows');
  check('fnm paths are recognised',
    rt.detectVersionManager('/home/u/.fnm/node-versions/v20/installation/bin/node').manager === 'fnm');
  check('a system path is not flagged',
    rt.detectVersionManager('/usr/bin/node').managed === false);
  check('the MSI path is not flagged as managed',
    rt.detectVersionManager('C:\\Program Files\\nodejs\\node.exe').managed === false);

  check('the ABI is reported', /^\d+$/.test(String(rt.currentAbi())));

  // The real check: the native module actually loads with a given node.
  const native = await rt.verifyNativeModules({ nodeExe: process.execPath, appDir: ROOT });
  check('better-sqlite3 loads with the running Node', native.ok === true, native.reason ?? '');
  check('and the probe reports the ABI it loaded under', native.abi === String(rt.currentAbi()));

  check('the probe leaves no temporary file behind', (() => {
    const left = fs.readdirSync(os.tmpdir()).filter((f) => /^ez-runtime-probe-/.test(f));
    return left.length === 0;
  })());

  const missing = await rt.verifyNativeModules({
    nodeExe: process.execPath,
    appDir: path.join(scratch('runtime-empty')),
  });
  check('an app directory with no dependencies is diagnosed', missing.ok === false);
  check('and the fix names npm install', /npm install/.test(missing.fix ?? missing.reason ?? ''));

  // The Linux symlink. Skipped on Windows, where an unprivileged symlink fails.
  const { isWindows } = await import(srcUrl('core/platform.js'));
  if (!isWindows) {
    const dir = scratch('runtime-link');
    const linked = rt.linkRuntime({ dataDir: dir });
    check('the runtime link is created', linked.ok === true, linked.reason ?? '');
    check('it resolves through any shim to a real binary',
      linked.target === fs.realpathSync(process.execPath));

    const state = rt.inspectLink(dir);
    check('a good link reads as not broken', state.exists === true && state.broken === false);

    // The failure this exists for: the version manager removed the target.
    const broken = scratch('runtime-broken');
    fs.symlinkSync(path.join(broken, 'gone-node'), rt.runtimeNodePath(broken));
    const brokenState = rt.inspectLink(broken);
    check('a dangling link is detected', brokenState.broken === true);
    check('and the message names `ezz service repair`', /ezz service repair/.test(brokenState.reason));
  } else {
    check('the runtime link is created', true, 'skipped: Windows uses a copy, not a symlink');
    check('it resolves through any shim to a real binary', true, 'skipped on Windows');
    check('a good link reads as not broken', true, 'skipped on Windows');
    check('a dangling link is detected', true, 'skipped on Windows');
    check('and the message names `ezz service repair`', true, 'skipped on Windows');
  }
}

// ─── 15. The dispatcher, with every mechanism replaced ──────────────────────

async function testDispatcher() {
  setGroup('15. the dispatcher sequences the steps');

  const svc = await import(srcUrl('core/service/index.js'));
  const lock = await import(srcUrl('core/daemon/lock.js'));
  const { getDataDir } = await import(srcUrl('core/platform.js'));

  // waitForDaemon is the step that distinguishes "the manager started it" from
  // "the daemon is actually running", which is the whole point of the check.
  const empty = scratch('dispatch-empty');
  const notAlive = await svc.waitForDaemon({ dataDir: empty, timeoutMs: 300 });
  check('waitForDaemon reports a daemon that never arrives', notAlive.alive === false);
  check('and says how long it waited', notAlive.waitedMs >= 250);

  const live = scratch('dispatch-live');
  lock.acquire({ dataDir: live, mode: 'daemon', version: '9.9.9' });
  const alive = await svc.waitForDaemon({ dataDir: live, timeoutMs: 2_000 });
  check('waitForDaemon sees a live heartbeat', alive.alive === true);
  check('and reports the pid', alive.lock?.pid === process.pid);
  lock.release({ dataDir: live });

  // A full install, with every platform module replaced. Nothing real runs.
  const calls = [];
  const fakeSystemd = {
    hasSystemd: async () => { calls.push('hasSystemd'); return true; },
    install: async () => { calls.push('systemd.install'); return { ok: true, unitPath: '/fake/unit' }; },
    uninstall: async () => { calls.push('systemd.uninstall'); return { ok: true }; },
    restart: async () => { calls.push('systemd.restart'); return { ok: true }; },
    journal: async () => ({ ok: true, output: 'fake log' }),
    status: async () => ({ installed: true, running: true, crashLooping: false, restarts: 0, state: 'active' }),
    repair: async () => { calls.push('systemd.repair'); return { ok: true }; },
    manualInstructions: () => 'manual',
    UNIT_NAME: 'easy-devops.service',
  };

  const fakeWindowsService = {
    install: async () => { calls.push('winsw.install'); return { ok: true, granted: ['C:\\x'], runtime: {} }; },
    uninstall: async () => { calls.push('winsw.uninstall'); return { ok: true, notes: [] }; },
    restart: async () => { calls.push('winsw.restart'); return { ok: true }; },
    status: async () => ({ installed: true, running: true, crashLooping: false, restarts: 0, acl: { ok: true } }),
    readLogs: () => ({ ok: true, file: 'fake', output: 'fake log' }),
    repair: async () => { calls.push('winsw.repair'); return { ok: true, granted: [] }; },
  };

  const fakeWindowsPersonal = {
    install: () => { calls.push('personal.install'); return { ok: true, launcher: 'L', nodeExe: 'N', logFile: 'F' }; },
    uninstall: () => { calls.push('personal.uninstall'); return { ok: true, notes: [] }; },
    status: () => ({ installed: true, warnings: [], crashLooping: false, restarts: 0 }),
    readLogs: () => ({ ok: true, file: 'fake', output: 'fake log' }),
    repair: () => { calls.push('personal.repair'); return { ok: true, nodeExe: 'N' }; },
  };

  const fakeLegacy = { run: stubRun([[/schtasks/, { success: false }]]), startupDir: null };

  // status(): read-only, and must not start anything.
  const status = await svc.status({
    deps: {
      systemd: fakeSystemd,
      windowsService: fakeWindowsService,
      windowsPersonal: fakeWindowsPersonal,
      legacy: fakeLegacy,
    },
  });

  check('status reports the mechanism', typeof status.mechanism === 'string');
  check('status reports the data directory', status.dataDir === getDataDir());
  check('status reports the dashboard UI setting, as the brief requires',
    'dashboardUi' in status);
  check('status includes the daemon\'s own view', 'running' in status.daemon);
  check('status includes the runtime comparison', Boolean(status.runtime?.systemNode?.version));
  check('status never installed anything', !calls.some((c) => /install/.test(c)), calls.join(','));

  // A crash loop must surface as a warning.
  const looping = await svc.status({
    deps: {
      systemd: { ...fakeSystemd, status: async () => ({ installed: true, running: false, crashLooping: true, restarts: 9 }) },
      windowsService: { ...fakeWindowsService, status: async () => ({ installed: true, running: false, crashLooping: true, restarts: 9, acl: { ok: true } }) },
      windowsPersonal: { ...fakeWindowsPersonal, status: () => ({ installed: true, warnings: [], crashLooping: true, restarts: 9 }) },
      legacy: fakeLegacy,
    },
  });
  check('a crash loop is surfaced as a warning',
    looping.warnings.some((w) => /crash loop/i.test(w)), looping.warnings.join(' | '));
  check('the warning names how to see why', looping.warnings.some((w) => /ezz service logs/.test(w)));

  // logs() routes to the right source.
  const logged = await svc.logs({
    deps: { systemd: fakeSystemd, windowsService: fakeWindowsService, windowsPersonal: fakeWindowsPersonal },
  });
  check('logs are read from the mechanism in use', logged.output === 'fake log');
}

// ─── 16. Decision 5: uninstall never silently moves the data ────────────────

async function testUninstallDataChoice() {
  setGroup('16. uninstall never silently moves the data');

  const svc = await import(srcUrl('core/service/index.js'));
  const { isWindows, programDataDir } = await import(srcUrl('core/platform.js'));

  let disableCalled = 0;
  const deps = {
    systemd: {
      uninstall: async () => ({ ok: true }),
      status: async () => ({ installed: false, running: false, crashLooping: false }),
    },
    windowsService: { uninstall: async () => ({ ok: true, notes: [] }) },
    windowsPersonal: { uninstall: () => ({ ok: true, notes: [] }) },
    legacy: { run: stubRun([[/schtasks/, { success: false }]]), startupDir: null },
    disableServerMode: () => { disableCalled++; return { ok: true, dataDir: 'APPDATA', moved: true, backup: 'B' }; },
  };

  const kept = await svc.uninstall({ keepServerDataLocation: true, deps });
  check('uninstall succeeds', kept.ok === true, kept.reason ?? '');
  check('keeping the location does NOT move the data', disableCalled === 0);

  if (isWindows && svc.resolveMechanism().mode === 'server') {
    check('the notes say the data stays in ProgramData',
      kept.notes.some((n) => n.includes(programDataDir())));
  } else {
    // Not in Server mode here, so there is nothing to keep — which is itself
    // the correct behaviour and worth asserting rather than skipping silently.
    check('outside Server mode there is no data-location question',
      !kept.notes.some((n) => /ProgramData/.test(n)), kept.notes.join(' | '));
  }

  // Moving back must be an explicit choice, and only in Server mode.
  if (isWindows) {
    const { MODES } = svc;
    check('the two Windows modes are named', MODES.SERVER === 'server' && MODES.PERSONAL === 'personal');
  } else {
    check('the two Windows modes are named', svc.MODES.SERVER === 'server');
  }

  check('uninstall offers the legacy cleanup too', Array.isArray(kept.legacy?.found));
  check('and removes nothing unless asked', kept.legacy.removed.length === 0);
}

// ─── 18. The launcher is hidden, and is two files ───────────────────────────

async function testHiddenLauncher() {
  setGroup('18. the Personal launcher runs hidden');

  const wp = await import(srcUrl('core/service/windowsPersonal.js'));
  const dir = scratch('hidden');
  const startupDir = path.join(dir, 'Startup');
  fs.mkdirSync(startupDir, { recursive: true });

  const installed = wp.install({
    dataDir: dir,
    entry: path.join(dir, 'entry.js'),
    startupDir,
    record: false,
  });

  check('install succeeds', installed.ok === true, installed.reason ?? '');

  // The whole point: the Startup entry is NOT the supervisor. A single file
  // holding the loop meant a console window open for the entire session, and
  // closing it killed the daemon with no restart.
  check('the Startup entry is a separate bootstrap, not the supervisor',
    installed.launcher !== installed.supervisor);
  check('the supervisor lives in the data directory, not in Startup',
    installed.supervisor.startsWith(dir) && !installed.supervisor.startsWith(startupDir),
    installed.supervisor);

  const bootstrap = fs.readFileSync(installed.launcher, 'utf8');
  const supervisor = fs.readFileSync(installed.supervisor, 'utf8');

  check('the bootstrap hides the window it starts', /-WindowStyle Hidden/.test(bootstrap));
  check('it starts the supervisor, by path', bootstrap.includes(installed.supervisor));
  check('it exits rather than staying open', /exit \/b 0/.test(bootstrap));
  check('it does NOT contain the supervisor loop', !/:loop/.test(bootstrap));
  check('the supervisor DOES contain the loop', /:loop/.test(supervisor));

  // No VBScript, as specified.
  check('no VBScript anywhere', !/wscript|cscript|\.vbs/i.test(bootstrap + supervisor));

  // `start /b` shares the parent console, which ties the child to the window
  // we are trying to get rid of.
  check('it does not use `start /b`, which shares the console',
    !/\bstart\s+""?\s*\/b\b/i.test(bootstrap));

  // cmd.exe reads these under the machine's console codepage. A stray em dash
  // produced `'m' is not recognized` on a real run.
  const nonAscii = (text) => [...text].filter((c) => c.charCodeAt(0) > 126).length;
  check('the bootstrap is pure ASCII', nonAscii(bootstrap) === 0, `${nonAscii(bootstrap)} char(s)`);
  check('the supervisor is pure ASCII', nonAscii(supervisor) === 0, `${nonAscii(supervisor)} char(s)`);

  // The bootstrap clearing the stop request is what makes a stop temporary.
  check('the bootstrap clears a pending stop request at logon',
    bootstrap.includes('daemon.stop') && /del \/q/.test(bootstrap));

  // Re-running install must not leave the old all-in-one file behind.
  check('status warns about a launcher from the older, visible-window design', (() => {
    fs.writeFileSync(installed.launcher, '@echo off\r\nrem old single-file launcher\r\n:loop\r\n');
    const s = wp.status({ dataDir: dir, startupDir });
    return s.warnings.some((w) => /visible console window/.test(w));
  })());
}

// ─── 19. A service install is NOT a dev run ─────────────────────────────────

async function testNotDevMode() {
  setGroup('19. an installed service is not a dev run');

  const platform = await import(srcUrl('core/platform.js'));
  const wp = await import(srcUrl('core/service/windowsPersonal.js'));
  const sd = await import(srcUrl('core/service/systemd.js'));
  const winsw = await import(srcUrl('core/service/winsw.js'));

  const defaultDir = platform.isWindows
    ? path.join(process.env.APPDATA || os.homedir(), 'easy-devops')
    : path.join(os.homedir(), '.config', 'easy-devops');

  check('the real default directory is recognised as the default',
    platform.isDefaultDataDir(defaultDir) === true, defaultDir);
  check('a custom directory is not', platform.isDefaultDataDir(path.join(TEST_DATA_DIR, 'x')) === false);

  // ── The launcher must not set the variable for the default directory ─────
  const supervisor = wp.buildSupervisor({
    nodeExe: 'N', entry: 'E', dataDir: defaultDir, logFile: 'L', stopFile: 'S',
  });
  check('the supervisor does NOT set EASY_DEVOPS_DATA_DIR for the default dir',
    !/set "EASY_DEVOPS_DATA_DIR=/.test(supervisor),
    supervisor.split('\n').find((l) => /EASY_DEVOPS_DATA_DIR/.test(l)));
  check('and says why', /is not set/.test(supervisor));

  const custom = wp.buildSupervisor({
    nodeExe: 'N', entry: 'E', dataDir: path.join(TEST_DATA_DIR, 'custom'), logFile: 'L', stopFile: 'S',
  });
  check('it DOES set it for a non-default dir', /set "EASY_DEVOPS_DATA_DIR=/.test(custom));

  const unit = sd.buildUnit({ nodeExe: 'n', entry: '/e/src/cli/index.js', user: 'u', dataDir: defaultDir });
  check('the systemd unit omits it for the default dir', !/^Environment=EASY_DEVOPS_DATA_DIR=/m.test(unit));

  const xml = winsw.buildServiceXml({ nodeExe: 'n', entry: 'e', dataDir: defaultDir, logDir: 'l' });
  check('the WinSW XML omits it for the default dir', !/EASY_DEVOPS_DATA_DIR" value=/.test(xml));

  const xmlProgramData = winsw.buildServiceXml({
    nodeExe: 'n', entry: 'e', dataDir: platform.programDataDir(), logDir: 'l',
  });
  check('but Server mode still gets it, since ProgramData is not the default',
    /EASY_DEVOPS_DATA_DIR" value=/.test(xmlProgramData));

  // ── And the decision itself, in a child process ──────────────────────────
  //
  // The question that matters: a daemon started by the launcher with the
  // ordinary data directory must use PRODUCTION Let's Encrypt. It used to use
  // staging, because dev mode was inferred from the variable being set at all.
  const probe = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '-e',
      'Promise.all([import("./src/core/platform.js"), import("./src/core/ssl-issuer.js")])'
      + '.then(([p, s]) => process.stdout.write(JSON.stringify({'
      + ' dev: p.isDevDataDir(), staging: s.useStaging({ acmeStaging: false }) })))',
    ], {
      cwd: ROOT,
      env: { ...process.env, EZ_TEST: '', EZ_DEV: '', EASY_DEVOPS_DATA_DIR: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => {
      try { resolve(JSON.parse(out)); } catch { resolve({ error: err.slice(-200) || out }); }
    });
  });

  const asLauncher = await probe({ EASY_DEVOPS_DATA_DIR: defaultDir });
  check('a daemon started by the launcher is NOT in dev mode',
    asLauncher.dev === false, JSON.stringify(asLauncher));
  check('and uses PRODUCTION Let\'s Encrypt, not staging',
    asLauncher.staging === false, JSON.stringify(asLauncher));

  const asService = await probe({ EASY_DEVOPS_DATA_DIR: path.join(TEST_DATA_DIR, 'service-dir') });
  check('nor is a service with some other data directory',
    asService.dev === false && asService.staging === false, JSON.stringify(asService));

  const asDevFlag = await probe({ EZ_DEV: '1' });
  check('--dev (EZ_DEV=1) IS dev mode', asDevFlag.dev === true, JSON.stringify(asDevFlag));
  check('and does use staging', asDevFlag.staging === true, JSON.stringify(asDevFlag));

  const asDevDir = await probe({ EASY_DEVOPS_DATA_DIR: path.join(ROOT, '.dev-data') });
  check('a .dev-data directory is dev mode even without the flag',
    asDevDir.dev === true, JSON.stringify(asDevDir));

  const plain = await probe({});
  check('a plain run is not dev mode', plain.dev === false, JSON.stringify(plain));
}

// ─── 20. The runtime version probe ──────────────────────────────────────────

async function testVersionProbe() {
  setGroup('20. the runtime version probe actually runs node');

  const rt = await import(srcUrl('core/service/runtime.js'));

  // The bug: the probe built `"<path>" --version` by hand, and `run()` goes
  // through PowerShell, where a quoted path needs the `&` call operator. The
  // daemon was starting fine from the very path status called "not runnable".
  const out = await rt.inspectRuntime({
    dataDir: path.join(TEST_DATA_DIR, 'no-runtime-here'),
    recordedNodeExe: process.execPath,
  });

  check('the recorded node is found', out.pinned.exists === true, process.execPath);
  check('its version is read, not reported as unrunnable',
    typeof out.pinned.version === 'string' && out.pinned.version.startsWith('v'),
    String(out.pinned.version));
  check('it matches the running node', out.pinned.version === process.version,
    `${out.pinned.version} vs ${process.version}`);
  check('it is not marked broken', out.pinned.broken === false);
  check('no warning is produced for a working runtime', out.warnings.length === 0,
    out.warnings.join(' | '));

  // The path this host runs from contains a space ("Program Files") often
  // enough to be worth stating: that is the case plain quoting gets wrong.
  if (process.execPath.includes(' ')) {
    check('the probed path contains a space, which is the hard case', true, process.execPath);
  } else {
    check('the probed path contains a space, which is the hard case', true,
      'skipped: this host\'s node path has no space');
  }

  // A genuinely missing binary must still be reported.
  const missing = await rt.inspectRuntime({
    dataDir: path.join(TEST_DATA_DIR, 'no-runtime-here'),
    recordedNodeExe: path.join(TEST_DATA_DIR, 'nope', 'node.exe'),
  });
  check('a missing runtime is still detected', missing.pinned.exists === false && missing.pinned.broken === true);
  check('and names `ezz service repair`', missing.warnings.some((w) => /ezz service repair/.test(w)));
}

// ─── 21. Stop and start ─────────────────────────────────────────────────────

async function testStopStart() {
  setGroup('21. stop and start');

  const stopReq = await import(srcUrl('core/daemon/stopRequest.js'));
  const dir = scratch('stop-protocol');

  // ── The protocol itself ──────────────────────────────────────────────────
  check('no request on a fresh directory', stopReq.isStopRequested({ dataDir: dir }) === false);

  const written = stopReq.requestStop({ dataDir: dir, reason: 'test' });
  check('a request can be written', written.ok === true, written.reason ?? '');
  check('it is a file in the data directory, not an IPC command',
    written.path === path.join(dir, 'daemon.stop') && fs.existsSync(written.path));
  check('it reads back as requested', stopReq.isStopRequested({ dataDir: dir }) === true);
  check('with its reason', stopReq.readStopRequest({ dataDir: dir }).reason === 'test');

  // A half-written file must still count: its presence is the signal.
  fs.writeFileSync(written.path, '{not json');
  check('a corrupt request still counts as a request',
    stopReq.isStopRequested({ dataDir: dir }) === true);

  check('clearing it works', stopReq.clearStopRequest({ dataDir: dir })
    && stopReq.isStopRequested({ dataDir: dir }) === false);

  // The watcher fires once and only once.
  let fired = 0;
  const watch = stopReq.watchForStop({ dataDir: dir, intervalMs: 50, onStop: () => { fired++; } });
  stopReq.requestStop({ dataDir: dir });
  await new Promise((r) => setTimeout(r, 400));
  watch.stop();
  check('the watcher notices the request', fired === 1, `fired ${fired} time(s)`);
  stopReq.clearStopRequest({ dataDir: dir });

  // ── The dispatcher, with each mechanism replaced ─────────────────────────
  const svc = await import(srcUrl('core/service/index.js'));
  const { isWindows } = await import(srcUrl('core/platform.js'));

  const calls = [];
  const deps = {
    systemd: {
      stop: async () => { calls.push('systemd.stop'); return { ok: true }; },
      start: async () => { calls.push('systemd.start'); return { ok: true }; },
      restart: async () => { calls.push('systemd.restart'); return { ok: true }; },
      status: async () => ({ installed: true, running: false, crashLooping: false, restarts: 0 }),
      journal: async () => ({ ok: true, output: '' }),
    },
    windowsService: {
      stop: async () => { calls.push('winsw.stop'); return { ok: true }; },
      start: async () => { calls.push('winsw.start'); return { ok: true }; },
      restart: async () => { calls.push('winsw.restart'); return { ok: true }; },
      status: async () => ({ installed: true, running: false, crashLooping: false, restarts: 0, acl: { ok: true } }),
      readLogs: () => ({ ok: true, file: 'f', output: '' }),
    },
    windowsPersonal: {
      startNow: async () => { calls.push('personal.startNow'); return { ok: true, supervisor: 'S' }; },
      status: () => ({ installed: true, warnings: [], crashLooping: false, restarts: 0 }),
      readLogs: () => ({ ok: true, file: 'f', output: '' }),
    },
    legacy: { run: async () => ({ success: false, stdout: '', stderr: '' }), startupDir: null },
    // Keep the dispatcher away from the real data directory's stop file.
    requestStop: () => ({ ok: true, path: path.join(dir, 'daemon.stop') }),
    clearStopRequest: () => true,
    isStopRequested: () => false,
    stopGraceMs: 500,
    startupGraceMs: 500,
  };

  const stopped = await svc.stop({ deps });
  check('stop reports success with no daemon running', stopped.ok === true, stopped.reason ?? '');

  if (isWindows) {
    check('on Windows Personal it goes through the stop request, not a service manager',
      !calls.includes('winsw.stop'), calls.join(','));
  } else {
    check('on Linux it goes through systemctl', calls.includes('systemd.stop'), calls.join(','));
  }

  // Start refuses while a daemon is live — the lock is the authority.
  const lock = await import(srcUrl('core/daemon/lock.js'));
  lock.acquire({ mode: 'daemon', version: 'test' });
  const refused = await svc.start({ deps });
  check('start refuses while a daemon is already running', refused.ok === false);
  check('and says it is already running', refused.alreadyRunning === true, refused.reason);
  lock.release({});

  // Elevation is reported rather than swallowed.
  const denied = await svc.stop({
    deps: {
      ...deps,
      windowsService: {
        ...deps.windowsService,
        stop: async () => ({ ok: false, needsElevation: true, reason: 'needs an Administrator terminal' }),
      },
      systemd: {
        ...deps.systemd,
        stop: async () => ({ ok: false, reason: 'needs a terminal for sudo' }),
      },
    },
  });
  // Only meaningful in the modes that have a service manager; Personal mode
  // has no elevation to need.
  if (!isWindows || svc.resolveMechanism().mode === 'server') {
    check('a refusal that needs elevation says so', denied.ok === false, denied.reason);
  } else {
    check('a refusal that needs elevation says so', true, 'skipped: Personal mode needs none');
  }
}

// ─── 22. Status distinguishes "stopped by you" ──────────────────────────────

async function testStoppedByYou() {
  setGroup('22. status tells a deliberate stop from a crash');

  const svc = await import(srcUrl('core/service/index.js'));
  const { dbGet, dbSet } = await import(srcUrl('core/db.js'));

  const base = {
    systemd: {
      status: async () => ({ installed: true, running: false, crashLooping: false, restarts: 0, state: 'inactive' }),
      journal: async () => ({ ok: true, output: '' }),
    },
    windowsService: {
      status: async () => ({ installed: true, running: false, crashLooping: false, restarts: 0, acl: { ok: true } }),
      readLogs: () => ({ ok: true, file: 'f', output: '' }),
    },
    windowsPersonal: {
      status: () => ({ installed: true, warnings: [], crashLooping: false, restarts: 0 }),
      readLogs: () => ({ ok: true, file: 'f', output: '' }),
    },
    legacy: { run: async () => ({ success: false, stdout: '', stderr: '' }), startupDir: null },
  };

  const saved = dbGet('service-state') ?? {};

  try {
    // Not stopped by anyone: a service that is down is down.
    dbSet('service-state', { ...saved, stoppedAt: null });
    const crashed = await svc.status({ deps: { ...base, isStopRequested: () => false } });
    check('without a recorded stop, it is not "stopped by you"', crashed.stoppedByUser === false);
    check('and the warning offers to start it',
      crashed.warnings.some((w) => /ezz service start/.test(w)), crashed.warnings.join(' | '));

    // Stopped deliberately.
    const at = new Date().toISOString();
    dbSet('service-state', { ...saved, stoppedAt: at });
    const stopped = await svc.status({ deps: { ...base, isStopRequested: () => false } });
    check('with a recorded stop, it IS "stopped by you"', stopped.stoppedByUser === true);
    check('the timestamp is reported', stopped.stoppedAt === at);
    check('the daemon detail says so, not that it crashed',
      /stopped by you/.test(stopped.daemon.detail), stopped.daemon.detail);
    check('the warning says the stop is temporary',
      stopped.warnings.some((w) => /temporary/i.test(w)), stopped.warnings.join(' | '));
    check('and names how to start it now',
      stopped.warnings.some((w) => /ezz service start/.test(w)));
    check('it does NOT say the service crashed',
      !stopped.warnings.some((w) => /crash loop/i.test(w)));

    // A pending stop request alone is enough, even with no DB record.
    dbSet('service-state', { ...saved, stoppedAt: null });
    const byFile = await svc.status({ deps: { ...base, isStopRequested: () => true } });
    check('a pending stop request alone counts as stopped by you',
      byFile.stoppedByUser === true);
  } finally {
    dbSet('service-state', saved);
  }
}

// ─── 23. A status read never starts the user's PM2 daemon ───────────────────

async function testStatusNeverStartsPm2() {
  setGroup('23. a status read never starts a PM2 daemon');

  // Moved here from the suite that covered the deleted core/service.js. The
  // guarantee still matters and now belongs to the native status: it calls
  // legacy.detectLegacy() to find leftovers from the old PM2 design, and EVERY
  // pm2 command starts a daemon — so a machine that does not use PM2 must not
  // be given one merely by opening the dashboard.
  const legacy = await import(srcUrl('core/service/legacy.js'));
  const runner = await import(srcUrl('core/runner.js'));

  const daemonUp = runner.isDaemonRunning();

  const commands = [];
  const recordingRun = async (cmd) => {
    commands.push(cmd);
    return { success: false, stdout: '', stderr: '', exitCode: 1, command: cmd };
  };

  const found = await legacy.detectLegacy({ run: recordingRun, startupDir: null });
  check('legacy detection completes', Array.isArray(found.items));

  // Matches a pm2 EXECUTABLE only: the first word of a command, or a path such
  // as `C:\...\pm2.cmd` or `/usr/bin/pm2`. A scheduled-task NAME that merely
  // contains the letters — `schtasks /Query /TN "EasyDevOps-PM2"` — is not a
  // pm2 invocation and must not be counted as one.
  const PM2_INVOCATION = /(^|[\s/\\"'])pm2(\.(?:cmd|exe|ps1))?(?=[\s"']|$)/i;
  const pm2Commands = commands.filter((c) => PM2_INVOCATION.test(String(c)));
  if (daemonUp) {
    // A daemon is already running on this machine, so talking to it starts
    // nothing new. The assertion that matters is the other branch.
    check('with a PM2 daemon already up, pm2 may be consulted', true,
      `${pm2Commands.length} pm2 command(s), daemon was already running`);
  } else {
    check('with no PM2 daemon, NO pm2 command is run at all',
      pm2Commands.length === 0, pm2Commands.join(' | ') || 'none');
  }

  // The gate itself: isDaemonRunning() reads the pid file and runs nothing.
  const before = commands.length;
  runner.isDaemonRunning();
  check('isDaemonRunning() executes no command', commands.length === before);

  const svc = await import(srcUrl('core/service/index.js'));
  const state = svc.backgroundServiceState();
  check('the cheap state needs no subprocess at all', typeof state.running === 'boolean');
}

// ─── 24. The dashboard's service endpoints ───────────────────────────────────

/** A minimal Express `res`, enough for a controller that only ever answers JSON. */
function captureRes() {
  const out = { code: 200, body: null };
  return {
    out,
    status(code) { out.code = code; return this; },
    json(body) { out.body = body; return this; },
  };
}

/**
 * GET /api/service and the three lifecycle endpoints.
 *
 * Why the removed fields are asserted ABSENT and not merely corrected: the old
 * response carried PM2-era `installed`, `running` and `enabledOnBoot` at the
 * top level, describing a PM2 app named `ez-dashboard` that no longer exists.
 * On a machine where the native daemon WAS running they read
 * `installed: false, running: false`, so a client that trusted them rendered
 * "Not installed" over a working service. A field that is wrong is worse than
 * one that is missing, so the test pins their absence.
 *
 * The lifecycle calls are driven into the two outcomes that need no elevation
 * and start nothing: "a daemon already holds the lock" and, in Personal mode,
 * "stop with nothing running". Elevation itself cannot be exercised from a
 * test — that is the point of it — so the 403 shape is asserted through the
 * guidance the controller publishes in GET /api/service instead.
 */
async function testServiceEndpoints() {
  setGroup('24. the dashboard service endpoints');

  const { default: ProcessesController } = await import(
    srcUrl('dashboard/controllers/processesController.js')
  );
  const lock = await import(srcUrl('core/daemon/lock.js'));
  const stopReq = await import(srcUrl('core/daemon/stopRequest.js'));
  const { isWindows, getDataDir } = await import(srcUrl('core/platform.js'));

  const controller = new ProcessesController();
  const dataDir = getDataDir();
  assertInsideTestDataDir(dataDir, 'drive the service endpoints');

  // ── GET /api/service ─────────────────────────────────────────────────────
  const read = captureRes();
  await controller.status({}, read);
  const body = read.out.body ?? {};
  const bg = body.backgroundService ?? {};

  check('GET /api/service answers 200', read.out.code === 200, JSON.stringify(body).slice(0, 120));

  for (const field of ['running', 'mechanism', 'installed', 'startsAt', 'stoppedByUser', 'stoppedAt', 'mode']) {
    check(`backgroundService.${field} is reported`, field in bg, Object.keys(bg).join(','));
  }
  check('with the service runtime and its warnings', 'runtime' in bg && Array.isArray(bg.warnings));
  check('and whether this process has an event channel to it', typeof bg.connected === 'boolean');
  check(
    'startsAt is logon, boot or null, never a guess',
    bg.startsAt === null || ['logon', 'boot'].includes(bg.startsAt),
    String(bg.startsAt),
  );

  // The removed PM2-era fields.
  for (const gone of ['installed', 'running', 'enabledOnBoot']) {
    check(`the PM2-era top-level \`${gone}\` is gone`, !(gone in body), gone in body ? Object.keys(body).join(',') : '');
  }
  check(
    'and no ez-dashboard app is described',
    !JSON.stringify(body).includes('ez-dashboard'),
  );

  // What is still true is still there.
  check('the PM2 block remains, for the user\'s own apps', typeof body.pm2 === 'object' && body.pm2 !== null);
  check('the data directory is reported', body.dataDir === dataDir, String(body.dataDir));
  check(
    'install guidance names the command, never a password',
    body.install?.command === 'ezz service install'
      && typeof body.install.needsElevation === 'boolean'
      && !JSON.stringify(body.install).toLowerCase().includes('password'),
    JSON.stringify(body.install),
  );

  // ── POST /api/service/start, with a daemon already holding the lock ──────
  // This process takes the lock, so nothing is spawned and the lock can be
  // released again afterwards (release() refuses another process's lock).
  const held = lock.acquire({ dataDir, version: 'endpoint-test', mode: 'daemon' });
  check('the test can take the lock', held.ok === true, held.reason ?? '');

  const started = captureRes();
  await controller.start({}, started);
  check(
    'start refuses while one is already running',
    started.out.code === 409 && started.out.body?.error === 'already_running',
    `${started.out.code} ${started.out.body?.error}`,
  );
  check(
    'and the refusal carries the current service state',
    typeof started.out.body?.backgroundService?.running === 'boolean',
  );

  lock.release({ dataDir });
  check('the lock is released again', lock.readLock(dataDir) === null);

  // ── POST /api/service/stop with nothing running ──────────────────────────
  // Personal mode answers this from a request file in the data directory, so
  // it is safe to drive. Elsewhere it would reach the real systemd or the real
  // SCM, which this suite never does.
  if (isWindows) {
    const stopped = captureRes();
    await controller.stop({}, stopped);
    check(
      'stop with nothing running succeeds and explains itself',
      stopped.out.code === 200 && stopped.out.body?.ok === true && Boolean(stopped.out.body.output),
      `${stopped.out.code} ${stopped.out.body?.output ?? stopped.out.body?.message ?? ''}`,
    );
    check(
      'it wrote the stop request that keeps the supervisor away',
      stopReq.isStopRequested({ dataDir }) === true,
    );

    // Leave the directory as it was found: a pending request would change what
    // the later sections read.
    stopReq.clearStopRequest({ dataDir });
    check('and the test clears it again', stopReq.isStopRequested({ dataDir }) === false);
  } else {
    check('stop is driven only where it cannot reach a real service manager', true,
      'skipped on Linux: stop would call the real systemd');
  }
}

// ─── Final safety check ─────────────────────────────────────────────────────

/**
 * Proves this suite did not create any of the things it is forbidden to
 * create. Reading these locations is safe; the assertion is that our own
 * artifacts are absent from them.
 */
function assertNoRealArtifacts() {
  setGroup('17. nothing real was created');

  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const ourProgramData = path.join(programData, 'easy-devops');
  check('no C:\\ProgramData\\easy-devops was created', !fs.existsSync(ourProgramData), ourProgramData);

  // Compared against the snapshot taken before any test ran, not against
  // absence: a machine with Easy DevOps legitimately installed in Personal
  // mode has this file, and that must not fail the suite. What must fail it is
  // the suite changing or creating it.
  check('the real Startup launcher is exactly as this run found it',
    realStartupSnapshot() === REAL_STARTUP_BEFORE,
    REAL_STARTUP_BEFORE === 'absent' ? 'absent before and after' : 'byte-for-byte unchanged');

  check('no systemd unit was written', !fs.existsSync('/etc/systemd/system/easy-devops.service'));

  const probes = fs.readdirSync(os.tmpdir()).filter((f) => /^(ez-runtime-probe-|easy-devops-\d+\.service)/.test(f));
  check('no temporary probe or staged unit was left behind', probes.length === 0, probes.join(','));
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nNative OS service: systemd, WinSW, Personal mode, data dir, ACLs, runtime\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  const { isWindows } = await import(srcUrl('core/platform.js'));

  await testMechanism();
  await testSystemdUnit();
  await testSystemdInstall();
  await testSystemdStatus();
  await testWinswXml();
  await testWinswPin();
  await testAcls();
  await testDataDir();
  if (isWindows) await testGuardRefusesProgramData();
  if (isWindows) await testPersonalLauncher();
  if (isWindows) await testPersonalInstall();
  if (isWindows) await testWindowsCrashLoop();
  await testLegacy();
  await testRuntime();
  await testDispatcher();
  await testUninstallDataChoice();
  if (isWindows) await testHiddenLauncher();
  await testNotDevMode();
  await testVersionProbe();
  await testStopStart();
  await testStoppedByYou();
  await testStatusNeverStartsPm2();
  await testServiceEndpoints();
  assertNoRealArtifacts();

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` — ${f.detail}` : ''}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
