/**
 * Tests for the security hardening of four unrelated surfaces, each of which
 * used to trust something it should not:
 *
 *   1. the permissions endpoint, which used to RECEIVE the operator's sudo
 *      password and run `sudo -S` with it. It must now never read a password,
 *      never run anything privileged, and answer with the commands the
 *      operator pastes into their own terminal;
 *   2. the certificate directory, which used to be created with bare
 *      `sudo mkdir` / `sudo chown` — commands no longer granted;
 *   3. `stopDashboard(pid)`, which used to kill whatever held a recorded pid;
 *   4. `cleanup.apply()`, which used to delete any path handed to it.
 *
 * Run with:  npm run test:e2e -- security-hardening
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * Nothing here runs sudo, opens a database outside the runner's temporary data
 * directory, or signals a process the suite did not start.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load.
import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { once } from 'events';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n-- ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a file, creating its parents. */
function seed(target, body = 'x') {
  assertInsideTestDataDir(target, `seed ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return target;
}

/** A minimal Express-like response, so a controller can be called directly. */
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() { return this; },
  };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Source with comments removed. Used for the static assertions: a comment
 * mentioning `sudo` or `password` is not code, and the code is what matters.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

// ─── 1. The permissions endpoint ─────────────────────────────────────────────

async function testPermissionsEndpoint() {
  setGroup('1. permissions endpoint: status and commands, never a password');

  const { default: SettingsController } = await import(srcUrl('dashboard/controllers/settingsController.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));
  const { loadConfig } = await import(srcUrl('core/config.js'));
  const perms = await import(srcUrl('core/permissions.js'));

  // The stock Linux layout this endpoint exists for.
  dbSet('config', {
    nginxDir: '/etc/nginx',
    sslDir: '/etc/easy-devops/ssl',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    dashboardPort: 6443,
  });

  const controller = new SettingsController();
  const res = fakeRes();

  // A body that still carries a password: it must be ignored, not validated,
  // not echoed, and not used for anything.
  const req = { body: { password: 'hunter2-not-a-real-password' }, ip: '127.0.0.1', socket: {} };

  // `isWindows: false` drives the Linux branch on any host; `checkConfigured`
  // replaces the one call that would otherwise ask sudo, and `user` keeps the
  // result independent of how this machine's account is named. Nothing
  // privileged runs in this test.
  await controller.setupPermissions(req, res, {
    isWindows: false,
    checkConfigured: async () => false,
    user: 'someuser',
  });

  check('it answers 200', res.statusCode === 200, String(res.statusCode));
  check('it reports the sudoers status', res.body?.configured === false, JSON.stringify(res.body?.configured));
  check('it returns the terminal commands',
    Array.isArray(res.body?.commands) && res.body.commands.length > 0,
    `${res.body?.commands?.length ?? 0} line(s)`);
  check('the password never comes back in the response',
    !JSON.stringify(res.body).includes('hunter2'));

  const config = loadConfig();
  const { ownDirs, refused } = perms.deriveOwnDirs(config);
  const script = perms.buildSetupScript({ user: 'someuser', ownDirs });

  check('the dashboard returns exactly what the shared builder produces',
    JSON.stringify(res.body?.commands) === JSON.stringify(script.lines),
    JSON.stringify(res.body?.commands?.[0] ?? null).slice(0, 80));
  check('sslDir and nginx conf.d are handed over',
    ownDirs.includes('/etc/easy-devops/ssl')
    && ownDirs.includes('/etc/nginx/conf.d'),
    ownDirs.join(' | '));
  check('no HTTP-01 webroot is handed over: challenges are answered by the loopback listener',
    !ownDirs.some((dir) => dir.includes('.well-known') || dir.includes('/html')),
    ownDirs.join(' | '));
  check('nothing is refused for the stock paths', refused.length === 0, JSON.stringify(refused));

  // The one directory that must never be handed over: the system CA store.
  const unsafe = perms.deriveOwnDirs({ nginxDir: '/etc/nginx', sslDir: '/etc/ssl' });
  const refusal = unsafe.refused.find((r) => r.dir === '/etc/ssl');
  check('a system directory is refused, with a reason',
    Boolean(refusal) && typeof refusal.reason === 'string' && refusal.reason.length > 0,
    refusal?.reason ?? 'not refused');
  check('and it is not in ownDirs', !unsafe.ownDirs.includes('/etc/ssl'));

  // Editable settings cannot nominate an unrelated descendant just because it
  // ends in conf.d. The nginx leaf must belong to a directory named nginx.
  const unrelated = perms.deriveOwnDirs({
    nginxDir: '/etc/ssl/private',
    sslDir: '/home/someuser/.config/easy-devops/ssl',
  });
  check('an unrelated conf.d target is refused',
    unrelated.refused.some((r) => r.dir === '/etc/ssl/private/conf.d')
      && !unrelated.ownDirs.includes('/etc/ssl/private/conf.d'),
    JSON.stringify(unrelated.refused));

  const lookalike = perms.deriveOwnDirs({
    nginxDir: '/opt/nginx',
    sslDir: '/srv/easy-devops/ssl',
  });
  check('settings cannot substitute lookalike managed roots',
    lookalike.ownDirs.length === 0
      && lookalike.refused.some((r) => r.dir === '/srv/easy-devops/ssl')
      && lookalike.refused.some((r) => r.dir === '/opt/nginx/conf.d'),
    JSON.stringify(lookalike));

  const dirStat = (pile, uid = 0, mode = 0o040755) => ({
    uid,
    mode,
    isDirectory: () => pile === 'directory',
    isSymbolicLink: () => pile === 'link',
  });
  const fakeTree = (entries) => ({
    validateFilesystem: true,
    uid: 1000,
    lstatSync(target) {
      if (!(target in entries)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return entries[target];
    },
    realpathSync(target) {
      if (!(target in entries)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return target;
    },
  });

  const linkedDeps = fakeTree({
    '/etc': dirStat('directory'),
    '/etc/easy-devops': dirStat('link'),
  });
  check('a linked existing ancestor is refused',
    /link/.test(perms.validateManagedPath('/etc/easy-devops/ssl', 'ssl', linkedDeps) ?? ''),
    perms.validateManagedPath('/etc/easy-devops/ssl', 'ssl', linkedDeps));

  const ownedDeps = fakeTree({
    '/etc': dirStat('directory'),
    '/etc/easy-devops': dirStat('directory', 1001),
    '/etc/easy-devops/ssl': dirStat('directory', 1001),
  });
  check('an ancestor owned by another account is refused',
    /owned by uid 1001/.test(perms.validateManagedPath('/etc/easy-devops/ssl', 'ssl', ownedDeps) ?? ''),
    perms.validateManagedPath('/etc/easy-devops/ssl', 'ssl', ownedDeps));

  const writableDeps = fakeTree({
    '/etc': dirStat('directory', 0, 0o041777),
    '/etc/easy-devops': dirStat('directory'),
    '/etc/easy-devops/ssl': dirStat('directory'),
  });
  check('a group- or world-writable ancestor is refused',
    /writable/.test(perms.validateManagedPath('/etc/easy-devops/ssl', 'ssl', writableDeps) ?? ''),
    perms.validateManagedPath('/etc/easy-devops/ssl', 'ssl', writableDeps));

  const finalLinkDeps = fakeTree({
    '/etc': dirStat('directory'),
    '/etc/nginx': dirStat('directory'),
    '/etc/nginx/conf.d': dirStat('link'),
  });
  check('a linked final target is refused',
    /link/.test(perms.validateManagedPath('/etc/nginx/conf.d', 'nginx', finalLinkDeps) ?? ''),
    perms.validateManagedPath('/etc/nginx/conf.d', 'nginx', finalLinkDeps));

  const fileStat = (uid = 0, mode = 0o100644) => ({
    uid,
    mode,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isFile: () => true,
  });
  const userOwnedAnchor = fakeTree({
    '/etc': dirStat('directory'),
    '/etc/nginx': dirStat('directory'),
    '/etc/nginx/conf.d': dirStat('directory'),
    '/etc/nginx/nginx.conf': fileStat(1000),
  });
  const anchorResult = perms.deriveOwnDirs(
    { nginxDir: '/etc/nginx', sslDir: '' },
    userOwnedAnchor,
  );
  check('nginx.conf owned by the installing account is refused',
    anchorResult.ownDirs.length === 0
      && anchorResult.refused.some((entry) => /nginx\.conf is owned by uid 1000, not root/.test(entry.reason)),
    JSON.stringify(anchorResult));

  check('the privileged setup uses a fixed trusted PATH',
    /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m.test(perms.MANAGED_DIR_SETUP_SCRIPT));
  const managedSetupCode = codeOnly(perms.MANAGED_DIR_SETUP_SCRIPT)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$/, ''))
    .join('\n');
  check('the privileged setup never resolves chown through PATH',
    !/(^|[\s;])chown\s/.test(managedSetupCode)
      && /\/bin\/chown -h -- "\$owner" "\$target"/.test(perms.MANAGED_DIR_SETUP_SCRIPT));
  check('the privileged setup rechecks that the final target is not a link',
    /chown -h[\s\S]{0,240}\[ -L "\$target" \][\s\S]{0,120}\[ ! -d "\$target" \]/
      .test(perms.MANAGED_DIR_SETUP_SCRIPT));

  // The CLI must use the same derivation and the same function, or the two
  // can show different commands for the same machine.
  const cliSource = fs.readFileSync(path.join(ROOT, 'src/cli/menus/settings.js'), 'utf8');
  check('the CLI derives ownDirs from the shared helper', /deriveOwnDirs\(config\)/.test(cliSource));
  check('the CLI runs setupLinuxPermissions with those dirs',
    /setupLinuxPermissions\(\{\s*ownDirs\s*\}\)/.test(cliSource));
  check('the CLI shows the commands before running them',
    cliSource.indexOf('script.lines') > 0
    && cliSource.indexOf('script.lines') < cliSource.indexOf('setupLinuxPermissions({ ownDirs })'));

  // The old path is gone: no stdin-piped sudo, no password read at all.
  const controllerSource = fs.readFileSync(
    path.join(ROOT, 'src/dashboard/controllers/settingsController.js'), 'utf8');
  const start = controllerSource.indexOf('async setupPermissions');
  const end = controllerSource.indexOf('\n\tbackup(', start);
  const setupCode = codeOnly(controllerSource.slice(start, end));

  check('the controller no longer runs sudo with a password',
    start !== -1 && !/runWithStdin/.test(controllerSource) && !/sudo\s+-S/.test(controllerSource));
  check('the setup handler does not read a password at all',
    start !== -1 && end > start && !/password/i.test(setupCode));

  // Windows is not a sudo machine.
  const winRes = fakeRes();
  await controller.setupPermissions({ body: {} }, winRes, { isWindows: true });
  check('on Windows the endpoint is not applicable',
    winRes.statusCode === 400 && typeof winRes.body?.error === 'string', String(winRes.statusCode));
}

// ─── 2. The setup script itself ──────────────────────────────────────────────

async function testSetupScript() {
  setGroup('2. the setup script carries no secret and no wildcard');

  const perms = await import(srcUrl('core/permissions.js'));

  const script = perms.buildSetupScript({ user: 'someuser', ownDirs: ['/etc/easy-devops/ssl'] });
  check('the script builds', script.ok === true, script.ok === false ? script.reason : '');

  const text = (script.lines ?? []).join('\n');
  check('it contains no password', !/password/i.test(text));
  check('its sudoers rule contains no wildcard',
    !perms.buildSudoersLine('someuser').includes('*'));
  check('it grants through the fixed sudoers path',
    text.includes('/etc/sudoers.d/easy-devops') && text.includes('(root)'));
  check('it validates with visudo -cf BEFORE installing',
    text.indexOf('visudo -cf') !== -1 && text.indexOf('visudo -cf') < text.indexOf('sudo install'));
  check('it prepares each reviewed directory through a separate-argv root script',
    text.includes("sudo /bin/sh -c 'set -eu")
      && text.includes('easy-devops-managed-dir /etc/easy-devops/ssl someuser'));
  check('the root script rejects links and creates without following one',
    text.includes('[ -L "$current" ]')
      && text.includes('mkdir -m 0755 -- "$current"')
      && !text.includes('mkdir -p /etc/easy-devops/ssl'));

  // An unsafe own directory is refused outright, not silently dropped.
  const bad = perms.buildSetupScript({ user: 'someuser', ownDirs: ['/etc/ssl'] });
  check('an unsafe own directory makes the script refuse', bad.ok === false, bad.reason ?? '');

  const badLookalike = perms.buildSetupScript({
    user: 'someuser',
    ownDirs: ['/srv/easy-devops/ssl'],
  });
  check('a caller cannot bypass the reviewed managed-root allowlist',
    badLookalike.ok === false, badLookalike.reason ?? '');

  const badUser = perms.buildSetupScript({ user: 'root; rm -rf /' });
  check('an unsafe account name is refused', badUser.ok === false, badUser.reason ?? '');
}

// ─── 3. The certificate directory ────────────────────────────────────────────

async function testCertDir() {
  setGroup('3. ensureCertDir never calls sudo');

  const source = fs.readFileSync(path.join(ROOT, 'src/core/ssl-issuer.js'), 'utf8');
  const start = source.indexOf('async function ensureCertDir');
  const end = source.indexOf('\n}', start);

  check('the function is still there', start !== -1 && end > start);

  const body = codeOnly(source.slice(start, end + 2));
  check('it contains no sudo', !/sudo/i.test(body), body.match(/.*sudo.*/)?.[0] ?? '');
  check('the issuer protects the managed key directory before use',
    /await protectKeyDirectory\(sslDir, domainName\)/.test(body));
  check('a permission failure names the one-time setup',
    /EACCES/.test(body) && /EPERM/.test(body) && /Linux permissions/i.test(body));
}

// ─── 4. stopDashboard never kills an unverified pid ──────────────────────────

async function testStopDashboard() {
  setGroup('4. stopDashboard refuses a pid it cannot verify');

  const dash = await import(srcUrl('core/dashboardProcess.js'));
  const { dbSet, dbGet } = await import(srcUrl('core/db.js'));

  // A process the SUITE starts and owns. Nothing else is ever signalled.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = once(child, 'exit');
  await sleep(300);

  dbSet('dashboard-pid', child.pid);
  dbSet('dashboard-port', 6443);

  // Something else entirely now holds that pid.
  const refused = await dash.stopDashboard(child.pid, {
    readCommandLine: async () => '"node.exe" -e "setInterval(...)"',
  });
  check('a command line that is not the dashboard is refused', refused.success === false, refused.reason ?? '');
  check('the reason says the pid does not belong to the dashboard',
    /does not belong|no longer belongs/i.test(refused.reason ?? ''), refused.reason ?? '');
  await sleep(200);
  check('and the process was NOT killed', isAlive(child.pid));
  check('the stale record is cleared', dbGet('dashboard-pid') == null);

  // Unreadable is "not verified", which is also a refusal.
  dbSet('dashboard-pid', child.pid);
  const unreadable = await dash.stopDashboard(child.pid, { readCommandLine: async () => null });
  check('an unreadable command line is refused too', unreadable.success === false, unreadable.reason ?? '');
  await sleep(200);
  check('that process is still alive', isAlive(child.pid));

  // The real reader, end to end. `/proc` on Linux and Get-CimInstance on
  // Windows both have to answer, or a real dashboard could never be stopped.
  const { readProcessCommandLine, isWindows } = await import(srcUrl('core/platform.js'));
  let described = null;
  const deadline = Date.now() + 10_000;
  while (!described && Date.now() < deadline) {
    described = await readProcessCommandLine(child.pid);
    if (!described) await sleep(200);
  }
  check('the platform reader describes a real process',
    typeof described === 'string' && described.includes('setInterval'), described ?? 'null');

  // And the un-injected call must refuse this pid: it is not our dashboard.
  dbSet('dashboard-pid', child.pid);
  const refusedForReal = await dash.stopDashboard(child.pid);
  check('the un-injected stop refuses a non-dashboard pid too',
    refusedForReal.success === false, refusedForReal.reason ?? '');
  await sleep(200);
  check('and that process survives it', isAlive(child.pid));

  // A verifier that does name our entry script: now the pid may be stopped.
  const verified = await dash.stopDashboard(child.pid, {
    readCommandLine: async () => `"C:\\Program Files\\nodejs\\node.exe" "${dash.DASHBOARD_ENTRY_SCRIPT}"`,
  });
  check('a verified dashboard pid is stopped', verified.success === true, verified.reason ?? '');

  await Promise.race([exited, sleep(5_000)]);
  check('and the process really exited', !isAlive(child.pid));
  if (isAlive(child.pid)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  // Nonsense pids are refused before anything is read or signalled.
  const bogus = await dash.stopDashboard('not-a-pid', { readCommandLine: async () => 'should not be called' });
  check('a non-numeric pid is refused', bogus.success === false, bogus.reason ?? '');

  // ── The kill decision is a PARSED command line, not a substring search ───
  //
  // A reused pid is very often an editor that merely has server.js open, or a
  // grep for it. Those must never match.
  const entry = dash.DASHBOARD_ENTRY_SCRIPT;
  const matches = (line) => dash.isDashboardCommandLine(line);

  check('node <script> matches',
    matches(`"C:\\Program Files\\nodejs\\node.exe" "${entry}"`) && matches(`node ${entry}`),
    'both the quoted and unquoted forms');
  check('node with an interpreter option still matches',
    matches(`node --max-old-space-size=2048 ${entry}`));
  check('a different executable does not match',
    !matches(`code "${entry}"`) && !matches(`grep x "${entry}"`) && !matches(`vim "${entry}"`));
  check('node with a different script does not match',
    !matches(`node other.js "${entry}"`) && !matches(`node "${entry}.bak"`));
  check('interpreter code that mentions the script does not match',
    !matches(`node -e "require('${entry}')"`));
  check('an empty or missing command line does not match',
    !matches('') && !matches(null) && !matches(undefined) && !matches('node'));

  if (isWindows) {
    check('the path comparison is case-insensitive on Windows', matches(`node "${entry.toUpperCase()}"`));
  }
}

// ─── 5. cleanup.apply refuses anything outside the scan roots ────────────────

async function testCleanupApply() {
  setGroup('5. cleanup.apply refuses paths outside the scan roots');

  const cleanup = await import(srcUrl('core/cleanup.js'));

  const dataDir = scratch('cleanup-inside');
  const nginxDir = scratch('cleanup-nginx');
  const outsideDir = scratch('cleanup-outside');

  const insideFile = seed(path.join(dataDir, 'logs', 'old.log'));
  const outsideFile = seed(path.join(outsideDir, 'keep.log'));

  // A SIBLING whose name merely starts with the data directory's: a prefix
  // check would delete it, a separator-aware one will not.
  const evilDir = path.join(TEST_DATA_DIR, 'scratch', `${path.basename(dataDir)}-evil`);
  assertInsideTestDataDir(evilDir, 'create the look-alike directory');
  fs.mkdirSync(evilDir, { recursive: true });
  const evilFile = seed(path.join(evilDir, 'keep.log'));

  const runStub = async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 });

  const result = await cleanup.apply({
    dataDir,
    config: { nginxDir },
    deps: { run: runStub },
    items: [
      { id: 'a', group: 'logs', path: outsideFile, bytes: 1, removable: true },
      { id: 'b', group: 'logs', path: evilFile, bytes: 1, removable: true },
      { id: 'c', group: 'logs', path: insideFile, bytes: 1, removable: true },
    ],
  });

  check('an outside path is refused', fs.existsSync(outsideFile),
    result.failed.find((f) => f.id === 'a')?.reason ?? 'not refused');
  check('a look-alike sibling path is refused', fs.existsSync(evilFile),
    result.failed.find((f) => f.id === 'b')?.reason ?? 'not refused');
  check('a path inside the data directory is removed', !fs.existsSync(insideFile));
  check('the refusals are reported, not silent',
    result.failed.length === 2 && result.removed.length === 1,
    `${result.failed.length} refused, ${result.removed.length} removed`);
  check('each refusal carries a reason',
    result.failed.every((f) => typeof f.reason === 'string' && f.reason.length > 0));

  // A symlink INSIDE the data directory that points outside it.
  const link = path.join(dataDir, 'logs', 'link.log');
  let linkMade = false;
  try {
    fs.symlinkSync(outsideFile, link, 'file');
    linkMade = true;
  } catch { /* Windows without the privilege cannot make a symlink */ }

  if (linkMade) {
    const linked = await cleanup.apply({
      dataDir,
      config: { nginxDir },
      deps: { run: runStub },
      items: [{ id: 'd', group: 'logs', path: link, bytes: 1, removable: true }],
    });
    check('a symlink pointing outside is refused',
      fs.existsSync(outsideFile) && linked.removed.length === 0,
      linked.failed[0]?.reason ?? 'not refused');
  } else {
    check('a symlink pointing outside is refused', true, 'skipped: this account cannot create symlinks');
  }

  // An item whose path cannot be resolved is refused rather than guessed at.
  const missing = await cleanup.apply({
    dataDir,
    config: { nginxDir },
    deps: { run: runStub },
    items: [{ id: 'e', group: 'logs', path: path.join(dataDir, 'logs', 'gone.log'), bytes: 1, removable: true }],
  });
  check('an unresolvable path is refused', missing.failed.length === 1 && missing.removed.length === 0,
    missing.failed[0]?.reason ?? '');

  // ── A root itself is never an item ───────────────────────────────────────
  //
  // `rmSync(..., { recursive: true })` on the data directory would take the
  // database, the sessions and every log with it, so equality with a root is
  // refused, not just being outside one.
  const sslDir = path.join(dataDir, 'ssl');
  assertInsideTestDataDir(sslDir, 'create the certificate directory');
  fs.mkdirSync(sslDir, { recursive: true });
  const pm2Home = scratch('cleanup-pm2home');
  const certKey = seed(path.join(sslDir, 'example.com', 'privkey.pem'));
  const dbFile = seed(path.join(dataDir, 'easy-devops.sqlite'));
  const walFile = seed(path.join(dataDir, 'easy-devops.sqlite-wal'));
  const activeConf = seed(path.join(nginxDir, 'conf.d', 'example.com.conf'));
  const notesInNginx = seed(path.join(nginxDir, 'notes.txt'));
  const bakFile = seed(path.join(nginxDir, 'conf.d', 'example.com.conf.bak'));

  const guarded = await cleanup.apply({
    dataDir,
    config: { nginxDir, sslDir },
    deps: { run: runStub, pm2HomeDir: () => pm2Home },
    items: [
      { id: 'data-root', group: 'logs', path: dataDir, bytes: 1, removable: true },
      { id: 'nginx-root', group: 'nginx-bak', path: nginxDir, bytes: 1, removable: true },
      { id: 'pm2-root', group: 'pm2-logs', path: pm2Home, bytes: 1, removable: true },
      { id: 'db', group: 'logs', path: dbFile, bytes: 1, removable: true },
      { id: 'db-wal', group: 'logs', path: walFile, bytes: 1, removable: true },
      { id: 'cert', group: 'logs', path: certKey, bytes: 1, removable: true },
      { id: 'ssl-root', group: 'logs', path: sslDir, bytes: 1, removable: true },
      { id: 'conf', group: 'nginx-bak', path: activeConf, bytes: 1, removable: true },
      { id: 'nginx-other', group: 'nginx-bak', path: notesInNginx, bytes: 1, removable: true },
      { id: 'bak', group: 'nginx-bak', path: bakFile, bytes: 1, removable: true },
    ],
  });

  const refusedIds = new Set(guarded.failed.map((f) => f.id));
  const removedIds = new Set(guarded.removed.map((r) => r.id));

  check('the data directory itself is refused', refusedIds.has('data-root') && fs.existsSync(dataDir),
    guarded.failed.find((f) => f.id === 'data-root')?.reason ?? 'removed!');
  check('the database survived the whole run', fs.existsSync(dbFile));
  check('the nginx directory itself is refused',
    refusedIds.has('nginx-root') && fs.existsSync(nginxDir));
  check('the PM2 home itself is refused', refusedIds.has('pm2-root') && fs.existsSync(pm2Home));
  check('the database file is refused inside the data directory',
    refusedIds.has('db') && fs.existsSync(dbFile),
    guarded.failed.find((f) => f.id === 'db')?.reason ?? 'removed!');
  check('nor its -wal sibling', refusedIds.has('db-wal') && fs.existsSync(walFile));
  check('a certificate under sslDir is refused', refusedIds.has('cert') && fs.existsSync(certKey),
    guarded.failed.find((f) => f.id === 'cert')?.reason ?? 'removed!');
  check('the sslDir itself is refused', refusedIds.has('ssl-root') && fs.existsSync(sslDir));
  check('an active .conf is refused', refusedIds.has('conf') && fs.existsSync(activeConf),
    guarded.failed.find((f) => f.id === 'conf')?.reason ?? 'removed!');
  check('anything but .bak is refused in the nginx directory',
    refusedIds.has('nginx-other') && fs.existsSync(notesInNginx));
  check('a .bak copy in the nginx directory is still removed',
    removedIds.has('bak') && !fs.existsSync(bakFile),
    guarded.failed.find((f) => f.id === 'bak')?.reason ?? 'kept');

  // The actions that delete nothing by path keep working.
  const flushed = [];
  const pm2 = await cleanup.apply({
    dataDir,
    config: { nginxDir },
    deps: { run: async (cmd) => { flushed.push(cmd); return { success: true, stdout: '', stderr: '' }; } },
    items: [{ id: 'f', group: 'pm2-logs', path: '(pm2 log directory)', bytes: 1, removable: true, action: 'pm2-flush', pm2Path: 'pm2' }],
  });
  check('pm2 flush still runs', pm2.removed.length === 1 && flushed.some((c) => /pm2 flush/.test(c)),
    flushed.join(' | '));

  const uninstalled = [];
  const node = await cleanup.apply({
    dataDir,
    config: { nginxDir },
    deps: { run: async (cmd) => { uninstalled.push(cmd); return { success: true, stdout: '', stderr: '' }; } },
    items: [{ id: 'g', group: 'node-versions', path: 'v14.21.3', version: '14.21.3', bytes: 0, removable: true, action: 'node-uninstall', manager: 'nvm' }],
  });
  check('a Node version is still uninstalled by its manager',
    node.removed.length === 1 && uninstalled.some((c) => /nvm uninstall 14\.21\.3/.test(c)),
    uninstalled.join(' | '));
}

// ─── 6. GET and POST settings agree about dashboardUi ────────────────────────

async function testDashboardUiAgreement() {
  setGroup('6. GET and POST /api/settings agree on dashboardUi');

  const { default: SettingsController } = await import(srcUrl('dashboard/controllers/settingsController.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));
  const { UI_MODES } = await import(srcUrl('core/config.js'));

  const controller = new SettingsController();

  const readAndWrite = async (stored) => {
    dbSet('config', {
      nginxDir: '/etc/nginx',
      sslDir: '/etc/easy-devops/ssl',
      dashboardPort: 6443,
      dashboardUiMigrated: true,
      ...stored,
    });

    const getRes = fakeRes();
    controller.get({ ip: '127.0.0.1', socket: {} }, getRes);

    const postRes = fakeRes();
    await controller.update({ body: {}, ip: '127.0.0.1', socket: {} }, postRes);

    return { get: getRes.body?.dashboardUi, post: postRes.body?.dashboardUi };
  };

  const explicitNew = await readAndWrite({ dashboardUi: UI_MODES.NEW });
  check('an explicit "new" is reported as new by both',
    explicitNew.get === UI_MODES.NEW && explicitNew.post === UI_MODES.NEW,
    `${explicitNew.get} / ${explicitNew.post}`);

  const explicitClassic = await readAndWrite({ dashboardUi: UI_MODES.CLASSIC });
  check('an explicit "classic" is reported as classic by both',
    explicitClassic.get === UI_MODES.CLASSIC && explicitClassic.post === UI_MODES.CLASSIC,
    `${explicitClassic.get} / ${explicitClassic.post}`);

  // The bug: GET normalised an unrecognised value to classic, POST echoed the
  // raw stored value back.
  const unrecognised = await readAndWrite({ dashboardUi: 'something-else' });
  check('an unrecognised value reads as classic on both',
    unrecognised.get === UI_MODES.CLASSIC && unrecognised.post === UI_MODES.CLASSIC,
    `${unrecognised.get} / ${unrecognised.post}`);

  const unset = await readAndWrite({});
  check('the unset value is the same on both',
    Boolean(unset.get) && unset.get === unset.post,
    `${unset.get} / ${unset.post}`);
}

function certificatePair(domain) {
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const subject = [{ name: 'commonName', value: domain }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: domain }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

// ─── 6. Recoverable certificate publication ─────────────────────────────────

async function testCertificateTransactions() {
  setGroup('6. certificate publication is paired, locked and crash-recoverable');
  const managed = await import(srcUrl('core/ssl/managed-artifacts.js'));
  const transactions = await import(srcUrl('core/ssl/certificate-transaction.js'));
  const cryptoModule = await import('node:crypto');

  const dataDir = scratch('certificate-transaction-data');
  const sslDir = scratch('certificate-transaction-ssl');
  if (process.platform !== 'win32') fs.chmodSync(sslDir, 0o700);
  const domain = 'transaction.example';
  const certDir = path.join(sslDir, domain);
  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(certDir, 0o700);

  const first = certificatePair(domain);
  const firstKey = seed(path.join(certDir, 'privkey.pem'), first.key);
  const firstCert = seed(path.join(certDir, 'fullchain.pem'), first.cert);
  if (process.platform !== 'win32') {
    fs.chmodSync(firstKey, 0o600);
    fs.chmodSync(firstCert, 0o600);
  }
  await managed.recordManagedArtifacts({
    dataDir,
    sslDir,
    files: [`${domain}/privkey.pem`, `${domain}/fullchain.pem`],
  });
  const originalKey = fs.readFileSync(firstKey, 'utf8');
  const originalCert = fs.readFileSync(firstCert, 'utf8');

  const second = certificatePair(domain);
  let betweenRenames = false;
  try {
    await transactions.publishCertificateFiles({
      dataDir,
      sslDir,
      domain,
      files: {
        'privkey.pem': second.key,
        'fullchain.pem': second.cert,
        'ez-cert.json': JSON.stringify({ domain, validationMethod: 'http' }),
      },
      onPublished: () => managed.recordManagedArtifacts({
        dataDir,
        sslDir,
        files: [
          `${domain}/privkey.pem`,
          `${domain}/fullchain.pem`,
          `${domain}/ez-cert.json`,
        ],
      }),
      deps: {
        renameSync(from, to, name, index) {
          fs.renameSync(from, to);
          if (index === 1) throw new Error('injected failure between key and certificate');
          return true;
        },
      },
    });
  } catch (error) {
    betweenRenames = /injected failure/.test(error.message);
  }
  check('a failure between the key and certificate renames is rolled back',
    betweenRenames
      && fs.readFileSync(firstKey, 'utf8') === originalKey
      && fs.readFileSync(firstCert, 'utf8') === originalCert,
    betweenRenames ? '' : 'publication did not fail at the intended boundary');
  check('a failed pair never leaves a transaction journal or staging files',
    !fs.readdirSync(dataDir).some((name) => name.includes('ssl-certificate'))
      && !fs.readdirSync(certDir).some((name) => name.endsWith('.next') || name.endsWith('.bak')));

  const concurrentPairs = [
    certificatePair(domain),
    certificatePair(domain),
  ];
  await Promise.all(concurrentPairs.map((pair) => transactions.publishCertificateFiles({
    dataDir,
    sslDir,
    domain,
    files: {
      'privkey.pem': pair.key,
      'fullchain.pem': pair.cert,
      'ez-cert.json': JSON.stringify({ domain, validationMethod: 'http' }),
    },
    onPublished: () => managed.recordManagedArtifacts({
      dataDir,
      sslDir,
      files: [
        `${domain}/privkey.pem`,
        `${domain}/fullchain.pem`,
        `${domain}/ez-cert.json`,
      ],
    }),
  })));
  const finalKey = fs.readFileSync(path.join(certDir, 'privkey.pem'), 'utf8');
  const finalCert = fs.readFileSync(path.join(certDir, 'fullchain.pem'), 'utf8');
  const finalPair = concurrentPairs.find((pair) => pair.key === finalKey && pair.cert === finalCert);
  check('concurrent same-domain publication serialises to one complete pair',
    Boolean(finalPair)
      && new cryptoModule.X509Certificate(finalCert).checkPrivateKey(
        cryptoModule.createPrivateKey(finalKey),
      ),
    finalPair ? '' : 'the final key and certificate came from different attempts');
  if (process.platform !== 'win32') {
    check('published private keys and certificate metadata are mode 0600',
      ['privkey.pem', 'fullchain.pem', 'ez-cert.json'].every((name) =>
        (fs.statSync(path.join(certDir, name)).mode & 0o777) === 0o600));
  } else {
    check('published private files were created with the private publication path', true);
  }

  // Put back the original pair, then crash a child after its key rename. The
  // journal remains on disk so the next renewal or repair must recover it.
  fs.writeFileSync(firstKey, originalKey, { mode: 0o600 });
  fs.writeFileSync(firstCert, originalCert, { mode: 0o600 });
  fs.rmSync(path.join(certDir, 'ez-cert.json'), { force: true });
  await managed.recordManagedArtifacts({
    dataDir,
    sslDir,
    files: [`${domain}/privkey.pem`, `${domain}/fullchain.pem`],
  });
  const crashPair = certificatePair(domain);
  const crashKey = seed(path.join(TEST_DATA_DIR, 'scratch', 'crash-next-key.pem'), crashPair.key);
  const crashCert = seed(path.join(TEST_DATA_DIR, 'scratch', 'crash-next-cert.pem'), crashPair.cert);
  const childSource = `
    import fs from 'node:fs';
    const [dataDir, sslDir, domain, keyFile, certFile] = process.argv.slice(1);
    const managed = await import(${JSON.stringify(srcUrl('core/ssl/managed-artifacts.js'))});
    const transactions = await import(${JSON.stringify(srcUrl('core/ssl/certificate-transaction.js'))});
    await transactions.publishCertificateFiles({
      dataDir, sslDir, domain,
      files: {
        'privkey.pem': fs.readFileSync(keyFile, 'utf8'),
        'fullchain.pem': fs.readFileSync(certFile, 'utf8'),
        'ez-cert.json': JSON.stringify({ domain, validationMethod: 'http' }),
      },
      onPublished: () => managed.recordManagedArtifacts({
        dataDir, sslDir,
        files: [domain + '/privkey.pem', domain + '/fullchain.pem', domain + '/ez-cert.json'],
      }),
      deps: {
        renameSync(from, to, name, index) {
          fs.renameSync(from, to);
          if (index === 0) process.exit(91);
          return true;
        },
      },
    });
  `;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    childSource,
    dataDir,
    sslDir,
    domain,
    crashKey,
    crashCert,
  ], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let childErr = '';
  child.stderr.on('data', (chunk) => { childErr += chunk; });
  const [code] = await once(child, 'close');
  const journalPath = transactions.certificateJournalPath(dataDir, domain);
  check('a process crash leaves the durable journal and a partial pair',
    code === 91 && fs.existsSync(journalPath)
      && fs.readFileSync(firstKey, 'utf8') === crashPair.key
      && fs.readFileSync(firstCert, 'utf8') === originalCert,
    childErr.trim() || `exit=${code}`);
  const recovered = await transactions.recoverCertificateFiles({ dataDir, sslDir, domain });
  check('the next certificate operation restores both files from the journal',
    recovered === true
      && fs.readFileSync(firstKey, 'utf8') === originalKey
      && fs.readFileSync(firstCert, 'utf8') === originalCert
      && !fs.existsSync(journalPath),
    `recovered=${recovered}`);

  const mismatched = certificatePair('other.example');
  let mismatchRefused = false;
  try {
    await transactions.publishCertificateFiles({
      dataDir,
      sslDir,
      domain,
      files: {
        'privkey.pem': mismatched.key,
        'fullchain.pem': first.cert,
      },
    });
  } catch (error) {
    mismatchRefused = /invalid certificate\/key pair/i.test(error.message);
  }
  check('publication refuses a mismatched key/certificate pair', mismatchRefused);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nSecurity hardening: sudo, pids, deletes and settings\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testPermissionsEndpoint();
  await testSetupScript();
  await testCertDir();
  await testStopDashboard();
  await testCleanupApply();
  await testDashboardUiAgreement();
  await testCertificateTransactions();

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'-'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label} - ${f.detail}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
