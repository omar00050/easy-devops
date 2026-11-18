/**
 * Tests for the hub permission catalog and the local command gate.
 *
 * Run with:  npm run test:e2e -- hub-permissions
 *
 * Plain Node script: the easy-devops constitution forbids adding a test
 * framework here, so this uses no dependencies and no runner.
 *
 * Isolation: storage tests run in a child process with a temporary
 * EASY_DEVOPS_DATA_DIR and a pre-created zero-byte SQLite file, so db.js's
 * legacy migration (which renames data/easy-devops.sqlite) can never run
 * against the real installation. The real data directory is asserted
 * untouched at the end.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
import './lib/guard.mjs';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MARKER = '@@RESULTS@@';

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

// ── Child: storage + migration against a temp data dir ───────────────────────

const CHILD = String.raw`
const out = [];
const check = (label, passed, detail = '') => out.push({ label, passed, detail });

const hl = await import('./src/core/hubLink.js');
const hp = await import('./src/core/hubPermissions.js');
const { dbSet, dbGet } = await import('./src/core/db.js');

// --- new link: everything off -------------------------------------------
const fresh = hl.getHubPermissions();
check('new link grants nothing', Object.values(fresh).every(v => v === false));
check('every catalog id is present', hp.ALL_PERMISSION_IDS.every(id => id in fresh));

// --- saving a single leaf -----------------------------------------------
hl.saveHubPermissions({ 'nginx.reload': true });
check('single leaf saved', hl.getHubPermissions()['nginx.reload'] === true);
check('siblings untouched', hl.getHubPermissions()['nginx.stop'] === false);

// --- comingSoon can never be granted ------------------------------------
hl.saveHubPermissions({ 'ssl.issueDns': true });
check('comingSoon cannot be enabled', hl.getHubPermissions()['ssl.issueDns'] === false);

// --- unknown ids are dropped --------------------------------------------
hl.saveHubPermissions({ 'nginx.selfDestruct': true, '__proto__': true });
const after = hl.getHubPermissions();
check('unknown id ignored', after['nginx.selfDestruct'] === undefined);
check('no prototype pollution', ({}).polluted === undefined);

// --- group set ----------------------------------------------------------
hl.saveHubPermissions({ groups: { domains: true } });
const dom = hl.getHubPermissions();
check('group enables all its children',
  ['domains.create','domains.edit','domains.toggle','domains.delete'].every(id => dom[id] === true));
check('group state is on', hp.groupState('domains', dom) === 'on');

hl.saveHubPermissions({ 'domains.delete': false });
check('group becomes partial', hp.groupState('domains', hl.getHubPermissions()) === 'partial');

hl.saveHubPermissions({ groups: { domains: false } });
check('group off clears children', hp.groupState('domains', hl.getHubPermissions()) === 'off');

// --- revision counter ----------------------------------------------------
const before = hl.getHubRevision();
hl.saveHubPermissions({ 'nginx.test': true });
check('saving bumps the revision', hl.getHubRevision() > before);

// --- migration from the legacy three booleans ----------------------------
dbSet('hub-permissions', { reloadNginx: true, manageDomains: true, manageSSL: true });
const migrated = hl.getHubPermissions();
check('reloadNginx -> five nginx service perms',
  ['nginx.start','nginx.stop','nginx.restart','nginx.reload','nginx.test'].every(id => migrated[id] === true));
check('manageDomains -> all domains.*',
  ['domains.create','domains.edit','domains.toggle','domains.delete'].every(id => migrated[id] === true));
check('manageSSL -> renew + renewAll only',
  migrated['ssl.renew'] === true && migrated['ssl.renewAll'] === true);
check('manageSSL does NOT grant issue', migrated['ssl.issue'] === false);
check('manageSSL does NOT grant delete', migrated['ssl.delete'] === false);
check('previously ungated reads are granted',
  migrated['nginx.config.view'] === true && migrated['nginx.logs.view'] === true);
check('config.edit stays off (new capability)', migrated['nginx.config.edit'] === false);
check('legacy keys are gone', !('reloadNginx' in migrated));

// --- migration is idempotent ---------------------------------------------
const rev1 = hl.getHubRevision();
const again = hl.getHubPermissions();
check('second read is identical', JSON.stringify(again) === JSON.stringify(migrated));
check('second read does not re-migrate', hl.getHubRevision() === rev1);

// partial legacy state
dbSet('hub-permissions', { reloadNginx: false, manageDomains: true, manageSSL: false });
const partial = hl.getHubPermissions();
check('partial legacy migrates correctly',
  partial['domains.create'] === true && partial['nginx.start'] === false && partial['ssl.renew'] === false);

console.log('@@RESULTS@@' + JSON.stringify(out));
process.exit(0);
`;

async function main() {
  const hp = await import(pathToFileURL(path.join(ROOT, 'src/core/hubPermissions.js')).href);

  // ── Catalog shape ───────────────────────────────────────────────────────
  setGroup('Catalog');

  check('tree has groups', hp.PERMISSION_TREE.length > 0, `${hp.PERMISSION_TREE.length} groups`);
  check('every group has an id, label and children',
    hp.PERMISSION_TREE.every((g) => g.id && g.label && Array.isArray(g.children) && g.children.length > 0));
  check('every leaf has a label and description',
    hp.ALL_PERMISSION_IDS.length > 0 &&
    hp.PERMISSION_TREE.every((g) => g.children.every((c) => c.id && c.label && c.description)));
  check('leaf ids are prefixed with their group',
    hp.PERMISSION_TREE.every((g) => g.children.every((c) => c.id.startsWith(`${g.id}.`))));
  check('leaf ids are unique',
    new Set(hp.ALL_PERMISSION_IDS).size === hp.ALL_PERMISSION_IDS.length);

  const required = [
    'nginx.start', 'nginx.stop', 'nginx.restart', 'nginx.reload', 'nginx.test',
    'nginx.config.view', 'nginx.config.edit', 'nginx.logs.view',
    'domains.create', 'domains.edit', 'domains.toggle', 'domains.delete',
    'ssl.renew', 'ssl.renewAll', 'ssl.issue', 'ssl.delete',
    'process.start', 'process.stop', 'process.restart',
  ];
  const missing = required.filter((id) => !hp.ALL_PERMISSION_IDS.includes(id));
  check('all required ids present', missing.length === 0, missing.join(', ') || 'none missing');

  check('grantable excludes comingSoon',
    hp.GRANTABLE_PERMISSION_IDS.every((id) => !hp.COMING_SOON_PERMISSION_IDS.includes(id)));
  check('there is at least one comingSoon entry', hp.COMING_SOON_PERMISSION_IDS.length > 0,
    hp.COMING_SOON_PERMISSION_IDS.join(', '));

  // Monitoring must NOT be a permission.
  const monitoringWords = ['metric', 'status.view', 'health', 'monitor'];
  check('monitoring is not gated',
    !hp.ALL_PERMISSION_IDS.some((id) => monitoringWords.some((w) => id.toLowerCase().includes(w))));

  // ── Parent / child logic ────────────────────────────────────────────────
  setGroup('Parent / child logic');

  let perms = hp.defaultPermissions();
  check('defaults deny everything', Object.values(perms).every((v) => v === false));
  check('empty group state is off', hp.groupState('nginx', perms) === 'off');

  perms = hp.setGroup(perms, 'nginx', true);
  check('setGroup turns children on', hp.groupState('nginx', perms) === 'on');
  check('setGroup leaves other groups alone', hp.groupState('domains', perms) === 'off');

  perms = hp.setPermission(perms, 'nginx.stop', false);
  check('one child off makes the group partial', hp.groupState('nginx', perms) === 'partial');

  perms = hp.setGroup(perms, 'nginx', false);
  check('setGroup false clears children', hp.groupState('nginx', perms) === 'off');

  // comingSoon must not drag a fully-granted group into "partial" forever.
  let sslPerms = hp.setGroup(hp.defaultPermissions(), 'ssl', true);
  check('comingSoon excluded from group state', hp.groupState('ssl', sslPerms) === 'on');
  check('comingSoon stays off after setGroup', sslPerms['ssl.issueDns'] === false);

  check('setPermission ignores unknown ids',
    hp.setPermission(hp.defaultPermissions(), 'nope.nope', true)['nope.nope'] === undefined);
  check('normalize drops unknown keys',
    hp.normalizePermissions({ 'bogus.id': true })['bogus.id'] === undefined);
  check('normalize survives garbage input',
    Object.values(hp.normalizePermissions(null)).every((v) => v === false));

  // ── Local command gate ──────────────────────────────────────────────────
  setGroup('Local command re-check');

  const granted = hp.setGroup(hp.defaultPermissions(), 'nginx', true);

  check('reload allowed when granted',
    hp.checkCommandAllowed('hub:reloadNginx', {}, granted).allowed === true);
  check('stop allowed when granted',
    hp.checkCommandAllowed('hub:nginxAction', { action: 'stop' }, granted).allowed === true);
  check('stop refused when denied',
    hp.checkCommandAllowed('hub:nginxAction', { action: 'stop' }, hp.defaultPermissions()).allowed === false);
  check('refusal names the permission',
    hp.checkCommandAllowed('hub:nginxAction', { action: 'stop' }, hp.defaultPermissions())
      .reason.includes('nginx.stop'));

  check('domain delete maps to domains.delete',
    hp.permissionForCommand('hub:manageDomain', { action: 'delete' }) === 'domains.delete');
  check('ssl issue maps to ssl.issue',
    hp.permissionForCommand('hub:manageSSL', { action: 'issue' }) === 'ssl.issue');
  // null, not undefined: the action is known and needs no permission. An
  // undefined here would be refused as an unknown action.
  check('ssl suggest needs no permission',
    hp.permissionForCommand('hub:manageSSL', { action: 'suggest' }) === null);
  check('ssl suggest is allowed with nothing granted',
    hp.checkCommandAllowed('hub:manageSSL', { action: 'suggest', domain: 'a.com' },
      hp.defaultPermissions()).allowed === true);
  check('saveConfig maps to nginx.config.edit',
    hp.permissionForCommand('hub:saveConfig') === 'nginx.config.edit');

  check('unknown command is refused',
    hp.checkCommandAllowed('hub:rm-rf', {}, granted).allowed === false);
  check('unknown action is refused',
    hp.checkCommandAllowed('hub:nginxAction', { action: 'explode' }, granted).allowed === false);
  check('a granted-but-comingSoon permission is still refused',
    hp.checkCommandAllowed('hub:manageSSL', { action: 'issueDns' }, { 'ssl.issueDns': true }).allowed === false);

  const procGranted = hp.setGroup(hp.defaultPermissions(), 'process', true);
  check('process stop maps to process.stop',
    hp.permissionForCommand('hub:manageProcess', { action: 'stop' }) === 'process.stop');
  check('process reload has no permission',
    hp.permissionForCommand('hub:manageProcess', { action: 'reload' }) === undefined);
  check('process restart allowed when granted',
    hp.checkCommandAllowed('hub:manageProcess', { action: 'restart' }, procGranted).allowed === true);
  check('process stop refused when denied',
    hp.checkCommandAllowed('hub:manageProcess', { action: 'stop' }, hp.defaultPermissions()).allowed === false);

  // ── Storage + migration (child process, temp data dir) ──────────────────
  setGroup('Storage and migration (isolated)');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-perm-'));
  fs.writeFileSync(path.join(dataDir, 'easy-devops.sqlite'), '');
  const legacyDb = path.join(ROOT, 'data', 'easy-devops.sqlite');
  const legacyBefore = fs.existsSync(legacyDb) ? fs.statSync(legacyDb).mtimeMs : null;

  const childFile = path.join(ROOT, 'hubperm.child.tmp.mjs');
  fs.writeFileSync(childFile, CHILD);

  const child = spawn(process.execPath, [childFile], {
    cwd: ROOT,
    env: { ...process.env, EASY_DEVOPS_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, APPDATA: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const [code] = await once(child, 'exit');

  const at = stdout.indexOf(MARKER);
  if (at === -1) {
    check('child produced results', false, `exit ${code}: ${stderr.slice(0, 300)}`);
  } else {
    for (const r of JSON.parse(stdout.slice(at + MARKER.length))) {
      check(r.label, r.passed, r.detail);
    }
  }

  fs.rmSync(childFile, { force: true });

  setGroup('Isolation');
  const legacyAfter = fs.existsSync(legacyDb) ? fs.statSync(legacyDb).mtimeMs : null;
  check('data/easy-devops.sqlite untouched', legacyAfter === legacyBefore);
  check('no .migrated file created', !fs.existsSync(`${legacyDb}.migrated`));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.stdout.write('   cleaned up temp data dir\n');
  } catch (err) {
    process.stdout.write(`   WARNING: temp dir left behind (${err.code}): ${dataDir}\n`);
  }

  // ── Sudoers output ──────────────────────────────────────────────────────
  setGroup('Sudoers rules');

  const permSrc = fs.readFileSync(path.join(ROOT, 'src/core/permissions.js'), 'utf8');
  const block = permSrc.slice(permSrc.indexOf('const SUDO_RULES'), permSrc.indexOf('].join('));

  check('no bare /usr/bin/systemctl grant',
    !/'\/usr\/bin\/systemctl',/.test(block));
  check('start/stop/reload/restart nginx are granted',
    ['start', 'stop', 'reload', 'restart'].every((v) => block.includes(`/usr/bin/systemctl ${v} nginx`)));
  check('certbot grant removed (acme-client is in-process)', !block.includes('certbot'));

  // Every sudo -n command in the codebase must be covered by a rule.
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js')) files.push(f);
    }
  })(path.join(ROOT, 'src'));

  const used = new Set();
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/sudo -n ([^\s'"`;]+(?: [a-z-]+)*)/g)) {
      used.add(m[1].trim());
    }
  }

  const uncovered = [...used].filter((cmd) => {
    const bin = cmd.split(' ')[0];
    const base = bin.startsWith('/') ? bin : `/usr/bin/${bin}`;
    return !block.includes(base);
  });
  check('every `sudo -n` command has a rule', uncovered.length === 0,
    uncovered.join(' | ') || `${used.size} commands checked`);

  // ── Summary ─────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label} ${f.detail}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
