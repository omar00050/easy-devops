/**
 * Tests for deployments (core/deploy/): ez.json resolution, the app registry,
 * the on-disk store and its lock, the deployment engine, the deploy hook and
 * the generated GitHub workflow.
 *
 * Run with:  npm run test:e2e -- deploy
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * What is real: git (a repository is created in the temporary directory and
 * fetched from), the install/build/hook commands, the processes that get
 * started, and the HTTP health checks against them. What is replaced: PM2. A
 * small in-test runner starts each release's PM2 config as a child process and
 * answers `list`, so a deployment is observed end to end — the new version
 * actually answers on its port — without PM2 on the machine and without
 * touching a PM2 daemon that might be there.
 *
 * Writes only inside the temporary data directory the runner provides.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed: Boolean(passed), detail });
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

/** A port nothing is listening on. */
async function freePort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

function httpRequest({ port, method = 'GET', pathname = '/', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: 4000 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: null, text: '', json: null }); });
    req.on('error', () => resolve({ status: null, text: '', json: null }));
    if (body !== null) req.write(body);
    req.end();
  });
}

// ─── A real git repository to deploy from ─────────────────────────────────────

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** The app every version of the test project runs: answers its version on PORT. */
const SERVER_JS = `
const http = require('http');
const fs = require('fs');
const version = fs.readFileSync(__dirname + '/VERSION', 'utf8').trim();
http.createServer((req, res) => {
  if (req.url === '/env') return res.end(JSON.stringify({ greeting: process.env.GREETING || null, release: process.env.EZ_RELEASE || null }));
  if (req.url === '/healthz') { res.statusCode = 200; return res.end('ok'); }
  res.end(version);
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

function makeRepo(name) {
  const dir = scratch(`repo-${name}`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // Lets a shallow fetch name a commit, the way a hosted repository does.
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  return dir;
}

/** Writes files and commits them. A value of null deletes the file. Returns the commit sha. */
function commit(repo, files, message) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(repo, rel);
    if (content === null) { fs.rmSync(file, { force: true }); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

// ─── A stand-in for PM2 that really runs the release ──────────────────────────

function makeFakePm2() {
  /** @type {Map<string, { child: any, status: string, restarts: number, config: Object }>} */
  const procs = new Map();
  const calls = [];

  // PM2 stops an app by killing its whole process tree. A release started
  // through the launcher is launcher → shell → npm → node, so killing only the
  // first would leave the real app holding its port. Each release therefore
  // gets its own process group, and the group is what is signalled.
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const kill = async (name) => {
    const p = procs.get(name);
    procs.delete(name);
    if (!p) return;

    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-p.child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
    }

    for (let i = 0; i < 100 && alive(p.child.pid); i++) await sleep(20);
    // The port is released a moment after the process is reaped.
    await sleep(50);
  };

  return {
    calls,
    procs,
    installed: true,
    async detect() { return { installed: this.installed, version: null, path: this.installed ? 'pm2' : null, error: null }; },
    isDaemonRunning() { return true; },
    async del(name) { calls.push(['delete', name]); await kill(name); return { ok: true, output: '' }; },
    async startConfig(file) {
      calls.push(['start', file]);
      const config = JSON.parse(fs.readFileSync(file, 'utf8')).apps[0];
      const child = spawn(process.execPath, [config.script, ...(config.args ?? [])], {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: 'ignore',
        detached: process.platform !== 'win32',
      });
      const entry = { child, status: 'online', restarts: 0, config };
      child.on('exit', () => { entry.status = 'errored'; });
      child.on('error', () => { entry.status = 'errored'; });
      procs.set(config.name, entry);
      return { ok: true, output: '' };
    },
    async list() {
      return {
        ok: true,
        error: null,
        apps: [...procs.entries()].map(([name, p]) => ({ name, status: p.status, restarts: p.restarts })),
      };
    },
    async save() { calls.push(['save']); return { ok: true, output: '' }; },
    async stopAll() { for (const name of [...procs.keys()]) await kill(name); },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const ez = await import(srcUrl('core/deploy/ezfile.js'));
  const apps = await import(srcUrl('core/deploy/apps.js'));
  const store = await import(srcUrl('core/deploy/store.js'));
  const engine = await import(srcUrl('core/deploy/engine.js'));
  const hook = await import(srcUrl('core/deploy/hookServer.js'));
  const github = await import(srcUrl('core/deploy/github.js'));
  const gen = await import(srcUrl('core/nginx-conf-generator.js'));
  const events = await import(srcUrl('core/events.js'));
  const { dbGet, dbSet } = await import(srcUrl('core/db.js'));
  const { loadConfig, saveConfig } = await import(srcUrl('core/config.js'));

  // ── 1. ez.json ──────────────────────────────────────────────────────────────
  setGroup('1. ez.json and defaults');
  {
    const full = ez.parseEzFile(JSON.stringify({
      install: 'npm ci', build: ['npm run lint', 'npm run build'], start: 'node dist/server.js',
      port: 3000, health: { path: '/healthz', timeout: 30 }, hooks: { pre: 'echo pre', post: ['echo a', 'echo b'] },
    }));
    check('a complete ez.json parses', full.ok && full.value.port === 3000 && full.value.healthPath === '/healthz'
      && full.value.healthTimeout === 30 && full.value.build.length === 2 && full.value.post.length === 2
      && full.value.start === 'node dist/server.js', JSON.stringify(full.errors));

    check('"health" may be a plain path', ez.parseEzFile('{"start":"x","health":"/up"}').value?.healthPath === '/up');
    check('build: false switches the step off (an empty list, not "unspecified")',
      Array.isArray(ez.parseEzFile('{"start":"x","build":false}').value?.build)
      && ez.parseEzFile('{"start":"x","build":false}').value.build.length === 0);
    check('an empty string is the same as false',
      ez.parseEzFile('{"start":"x","install":""}').value?.install.length === 0);
    check('a UTF-8 BOM is tolerated', ez.parseEzFile('\uFEFF{"start":"x"}').ok);

    const bad = (text) => ez.parseEzFile(text);
    check('invalid JSON is an error', !bad('{ nope').ok);
    check('a non-object is an error', !bad('[1,2]').ok);
    check('a port out of range is an error, not ignored', !bad('{"start":"x","port":70000}').ok && !bad('{"start":"x","port":"abc"}').ok);
    check('a health path without a leading slash is an error', !bad('{"start":"x","health":"healthz"}').ok);
    check('start cannot be a list of several commands', !bad('{"start":["a","b"]}').ok);
    check('start cannot be false', !bad('{"start":false}').ok);
    check('a command containing a newline is refused', !bad(JSON.stringify({ start: 'x', build: 'a\nrm -rf /' })).ok);
    check('a non-string command is refused', !bad('{"start":"x","build":5}').ok);

    const unknown = ez.parseEzFile('{"start":"x","replicas":3,"hooks":{"during":"y"}}');
    check('unknown keys are warnings, not errors', unknown.ok && unknown.warnings.length === 2, unknown.warnings.join(' | '));

    const d = ez.defaultsFromPackageJson;
    check('no package.json → no defaults', Object.keys(d(null)).length === 0);
    check('package-lock.json → npm ci', d({ scripts: { start: 'x' } }, { packageLock: true }).install[0] === 'npm ci');
    check('no lockfile → npm install', d({ scripts: { start: 'x' } }).install[0] === 'npm install');
    check('yarn.lock → yarn', d({ scripts: { start: 'x', build: 'y' } }, { yarnLock: true }).install[0].startsWith('yarn ')
      && d({ scripts: { start: 'x', build: 'y' } }, { yarnLock: true }).build[0] === 'yarn run build');
    check('pnpm-lock.yaml wins over the others',
      d({ scripts: { start: 'x' } }, { pnpmLock: true, yarnLock: true, packageLock: true }).install[0].startsWith('pnpm '));
    check('a build script becomes the build step; none means no build step',
      d({ scripts: { build: 'tsc', start: 'x' } }).build[0] === 'npm run build' && d({ scripts: { start: 'x' } }).build === undefined);
    check('a start script → npm start', d({ scripts: { start: 'node .' } }).start === 'npm start');
    check('no start script but a main → node <main>', d({ main: 'index.js' }).start === 'node index.js');
    check('neither → no start', d({ name: 'x' }).start === undefined);

    const r = ez.resolveSettings({
      ez: { build: ['make'], port: 4000 },
      pkg: { scripts: { start: 'node .', build: 'tsc' } },
      files: { packageLock: true },
      overrides: { port: 5000 },
    });
    check('precedence: override > ez.json > package.json',
      r.ok && r.settings.port === 5000 && r.settings.build[0] === 'make' && r.settings.install[0] === 'npm ci'
      && r.settings.start === 'npm start');
    check('each value records where it came from',
      r.sources.port === 'override' && r.sources.build === 'ez.json' && r.sources.install === 'package.json'
      && r.sources.healthPath === 'default', JSON.stringify(r.sources));
    check('an ez.json build: false beats package.json\'s build script',
      ez.resolveSettings({ ez: { build: [] }, pkg: { scripts: { start: 'x', build: 'tsc' } } }).settings.build.length === 0);

    const none = ez.resolveSettings({ ez: null, pkg: { name: 'x' } });
    check('nothing to start is a clear failure', !none.ok && /start/i.test(none.error));
    check('generic mode: a non-Node project works from ez.json alone',
      ez.resolveSettings({ ez: { install: ['pip install -r requirements.txt'], start: 'python app.py' }, pkg: null }).ok);

    const s = ez.parseStartCommand;
    check('"node server.js" is run by PM2 directly',
      s('node server.js').kind === 'node' && s('node server.js').script === 'server.js');
    check('arguments are kept', s('node dist/main.js --port 3000').args.join(' ') === '--port 3000');
    check('"npm start" goes through the launcher', s('npm start').kind === 'command');
    check('node with flags, pipes or && is a command line, not taken apart',
      s('node --max-old-space-size=512 a.js').kind === 'command' && s('node a.js && echo x').kind === 'command'
      && s('NODE_ENV=production node a.js').kind === 'command' && s('node "my app.js"').kind === 'command');

    const o = ez.normalizeOverrides;
    check('empty form fields override nothing',
      Object.keys(o({ install: '', build: null, start: '', port: '', healthPath: '' }).value).length === 0);
    check('overrides are validated like ez.json', !o({ port: 99999 }).ok && !o({ healthPath: 'x' }).ok && !o({ start: ['a', 'b'] }).ok);
    check('a port given as text is accepted', o({ port: '8080' }).value.port === 8080);

    // Persistent folders
    const persist = (v) => ez.parseEzFile(JSON.stringify({ start: 'x', persist: v }));
    check('persist is a list of folders',
      persist(['data', 'uploads']).value.persist.join() === 'data,uploads'
      && ez.normalizePersistPaths('uploads').paths.join() === 'uploads');
    check('backslashes and leading ./ are normalised',
      ez.normalizePersistPaths(['.\\data\\', 'uploads']).paths.join() === 'data,uploads');
    check('absolute paths, traversal and the deployment\'s own folders are refused',
      !persist('/etc').ok && !persist('../x').ok && !persist('data/../../x').ok && !persist('C:\\data').ok
      && !persist('.git').ok && !persist('node_modules').ok && !persist('a/node_modules').ok
      && persist('').ok && persist('').value.persist.length === 0);
    check('overlapping folders are refused', !persist(['data', 'data/db']).ok && !persist(['Data', 'data/db']).ok);
    check('duplicates collapse; a bad type is an error',
      ez.normalizePersistPaths(['data', 'data']).paths.join() === 'data'
      && ez.normalizePersistPaths(['data', 5]).error !== null);
    check('an override list replaces the repo list; [] means none',
      ez.resolveSettings({ ez: { start: 'x', persist: ['data'] } }).settings.persist.join() === 'data'
      && ez.resolveSettings({ ez: { start: 'x', persist: ['data'] }, overrides: { persist: ['uploads'] } }).settings.persist.join() === 'uploads'
      && ez.resolveSettings({ ez: { start: 'x', persist: ['data'] }, overrides: { persist: [] } }).settings.persist.length === 0);
    check('persist defaults to none', ez.resolveSettings({ ez: { start: 'x' } }).settings.persist.length === 0);
    check('an empty persist form field is "no override"', o({ start: '', persist: '' }).value.persist === undefined);
    check('a bad persist override is an error', !o({ persist: ['../x'] }).ok);
  }

  // ── 2. The app registry ─────────────────────────────────────────────────────
  setGroup('2. App registry and validation');
  {
    const id = apps.validateAppId;
    check('ordinary ids are accepted', id('my-api') === null && id('a') === null && id('app2') === null);
    check('ids that would escape a directory or a shell are refused',
      ['', '../x', 'a/b', 'A', 'my app', 'x;rm', '-x', 'x-', 'a'.repeat(41), '.hidden', 'a_b'].every((v) => id(v) !== null));
    check('reserved names are refused', id('dashboard') !== null && id('dashboard-dev') !== null && id('hook') !== null);
    check('the PM2 name is prefixed', apps.pm2Name('my-api') === 'ez-my-api');

    const url = apps.validateRepoUrl;
    check('https, scp-style and ssh:// URLs are accepted',
      url('https://github.com/me/app.git') === null && url('git@github.com:me/app.git') === null
      && url('ssh://git@gitlab.example.com:2222/me/app.git') === null && url('https://git.example.com:8443/group/sub/app') === null);
    check('anything a shell would act on is refused',
      [
        'https://github.com/me/app.git; rm -rf /', 'https://github.com/me/$(whoami)', 'https://github.com/me/`id`',
        'https://github.com/me/app" --upload-pack="x', 'https://github.com/me/app && x', 'https://github.com/me/a b',
        "https://github.com/me/app'", 'https://github.com/me/app|x', '--upload-pack=touch /tmp/x', 'https://github.com/me/app\n',
      ].every((v) => url(v) !== null));
    check('credentials in the URL are refused (they would reach the log)',
      url('https://user:pass@github.com/me/app.git') !== null && url('https://token@github.com/me/app.git') !== null);
    check('other schemes and local paths are refused',
      url('http://github.com/me/app.git') !== null && url('file:///etc') !== null && url('/srv/repo') !== null && url('git://x/y') !== null);

    const ref = apps.validateRef;
    check('branches, tags and SHAs are accepted',
      ref('main') === null && ref('release/2.1') === null && ref('v1.0.0') === null && ref('9f2c1a7b0d3e4f5a6b7c8d9e0f1a2b3c4d5e6f70') === null);
    check('refs that could be read as options or commands are refused',
      ['', '-x', '--upload-pack=x', 'a b', 'a;b', 'a..b', 'a$b', 'a`b', 'a"b'].every((v) => ref(v) !== null));

    const env = apps.normalizeEnv;
    check('environment variables are accepted and stringified',
      env({ A: '1', B_2: 'x y', C: 3, D: true }).value.C === '3' && env({ D: true }).value.D === 'true');
    check('invalid names are refused', !env({ '1A': 'x' }).ok && !env({ 'A-B': 'x' }).ok && !env({ 'A B': 'x' }).ok && !env({ '': 'x' }).ok);
    check('env must be an object', !env(['A=1']).ok && !env('A=1').ok);
    check('a null value drops the variable', !('A' in env({ A: null, B: 'x' }).value));

    dbSet('deployApps', []);
    const created = apps.createApp({ id: 'web', repoUrl: 'https://github.com/me/web.git' });
    check('an app is created with defaults', created.ok && created.app.branch === 'main'
      && created.app.keepReleases === 5 && created.app.autoRollback === true && created.app.auth.type === 'none');
    check('a duplicate id is a 409', apps.createApp({ id: 'web', repoUrl: 'https://github.com/me/web.git' }).status === 409);
    check('a bad URL is a 400 with a reason', apps.createApp({ id: 'web2', repoUrl: 'nope' }).status === 400);

    check('token auth needs an https URL',
      !apps.createApp({ id: 't1', repoUrl: 'git@github.com:me/x.git', authType: 'token', token: 'ghp_abcdefghij1234567890' }).ok);
    check('a deploy key needs an SSH URL',
      !apps.createApp({ id: 't2', repoUrl: 'https://github.com/me/x.git', authType: 'deployKey' }).ok);
    check('token auth needs a token', !apps.createApp({ id: 't3', repoUrl: 'https://github.com/me/x.git', authType: 'token' }).ok);
    check('a token with shell characters is refused',
      !apps.createApp({ id: 't4', repoUrl: 'https://github.com/me/x.git', authType: 'token', token: 'abc"; rm -rf / #xx' }).ok);

    const withToken = apps.createApp({ id: 'priv', repoUrl: 'https://github.com/me/priv.git', authType: 'token', token: 'ghp_abcdefghij1234567890', env: { SECRET: 's3cret' } });
    check('a token app is created', withToken.ok);

    const updated = apps.updateApp('priv', { branch: 'develop' });
    check('an update keeps the token without it being sent again',
      updated.ok && updated.app.branch === 'develop' && updated.app.auth.token === 'ghp_abcdefghij1234567890' && updated.app.env.SECRET === 's3cret');
    check('updating an unknown app is a 404', apps.updateApp('nope', { branch: 'x' }).status === 404);
    check('an invalid update changes nothing',
      !apps.updateApp('priv', { keepReleases: 500 }).ok && apps.getApp('priv').keepReleases === 5);

    const shown = apps.dashboardApp(apps.getApp('priv'));
    check('the dashboard view never contains the token', !JSON.stringify(shown).includes('ghp_abcdefghij') && shown.hasToken === true);
    const pub = apps.publicApp(apps.getApp('priv'));
    check('the Hub view has variable NAMES only', !JSON.stringify(pub).includes('s3cret') && pub.envKeys.join() === 'SECRET' && pub.env === undefined);

    // Deploy-hook token
    check('no token yet → nothing verifies', apps.verifyHookToken(apps.getApp('web'), 'anything') === false
      && apps.verifyHookToken(apps.getApp('web'), '') === false);
    const issued = apps.rotateHookToken('web');
    check('a token is issued once, with a hint', /^ezd_[A-Za-z0-9_-]{40,}$/.test(issued.token) && issued.hint === issued.token.slice(-4));
    check('only its hash is stored', !JSON.stringify(dbGet('deployApps')).includes(issued.token)
      && /^[0-9a-f]{64}$/.test(apps.getApp('web').hook.tokenHash));
    check('the token verifies, a different one does not',
      apps.verifyHookToken(apps.getApp('web'), issued.token) && !apps.verifyHookToken(apps.getApp('web'), `${issued.token}x`)
      && !apps.verifyHookToken(apps.getApp('priv'), issued.token));
    const again = apps.rotateHookToken('web');
    check('issuing a new one invalidates the old one',
      !apps.verifyHookToken(apps.getApp('web'), issued.token) && apps.verifyHookToken(apps.getApp('web'), again.token));
    apps.revokeHookToken('web');
    check('revoking disables it', !apps.verifyHookToken(apps.getApp('web'), again.token));
    check('rotating for an unknown app returns null', apps.rotateHookToken('nope') === null);

    // Deploy key
    const sshApp = apps.createApp({ id: 'keyed', repoUrl: 'git@github.com:me/keyed.git', authType: 'deployKey' });
    const key = apps.generateDeployKey('keyed');
    const [type, blob, comment] = key.publicKey.split(' ');
    const decoded = Buffer.from(blob, 'base64');
    const firstLen = decoded.readUInt32BE(0);
    check('the public key is in OpenSSH format',
      sshApp.ok && type === 'ssh-rsa' && decoded.subarray(4, 4 + firstLen).toString() === 'ssh-rsa' && comment === 'easy-devops-deploy-keyed');
    const privPath = apps.deployKeyPath('keyed');
    check('the private key is on disk, inside the data directory',
      privPath !== null && privPath.startsWith(TEST_DATA_DIR) && fs.readFileSync(privPath, 'utf8').includes('BEGIN RSA PRIVATE KEY'));
    check('the private key is never in the registry or the dashboard view',
      !JSON.stringify(dbGet('deployApps')).includes('PRIVATE KEY') && apps.dashboardApp(apps.getApp('keyed')).deployKey === key.publicKey);
    if (process.platform !== 'win32') {
      check('the private key is owner-only', (fs.statSync(privPath).mode & 0o077) === 0);
    }
    const keygen = spawnSync('ssh-keygen', ['-l', '-f', privPath], { encoding: 'utf8' });
    if (keygen.status === 0) {
      check('ssh-keygen accepts the generated key', /4096/.test(keygen.stdout), keygen.stdout.trim());
    } else {
      process.stdout.write('   SKIP  ssh-keygen is not available to cross-check the key\n');
    }

    check('deleting an app removes it and its files',
      apps.deleteApp('keyed') && apps.getApp('keyed') === null && !fs.existsSync(store.appPaths('keyed').root));
    check('deleting an unknown app returns null', apps.deleteApp('keyed') === null);
  }

  // ── 3. Store and lock ───────────────────────────────────────────────────────
  setGroup('3. Store, runs and the lock');
  {
    check('app paths refuse a traversal', (() => { try { store.appPaths('../x'); return false; } catch { return true; } })());
    const a = store.newReleaseId(new Date(Date.UTC(2026, 10, 15, 21, 45, 2)));
    check('release ids are time-sortable and directory-safe', /^20261115-214502-[0-9a-f]{6}$/.test(a) && store.isId(a) && !store.isId('../x'));

    const first = store.acquireLock('web', { runId: a });
    check('the lock is taken', first.ok === true);
    const second = store.acquireLock('web', { runId: store.newReleaseId() });
    check('a second taker is refused and told which run holds it', second.ok === false && second.runId === a);
    check('lockHolder() reports it', store.lockHolder('web')?.runId === a);
    first.release();
    check('releasing frees it', store.lockHolder('web') === null && store.acquireLock('web', { runId: a }).ok);
    fs.rmSync(store.appPaths('web').lock, { force: true });

    // A lock left by a process that died.
    fs.writeFileSync(store.appPaths('web').lock, JSON.stringify({ pid: 2 ** 22 + 12345, runId: a, at: Date.now() }));
    const takeover = store.acquireLock('web', { runId: a });
    check('a lock whose owner is gone is taken over', takeover.ok === true);
    takeover.release();

    fs.writeFileSync(store.appPaths('web').lock, JSON.stringify({ pid: process.pid, runId: a, at: Date.now() - store.LOCK_STALE_MS - 1000 }));
    const old = store.acquireLock('web', { runId: a });
    check('a lock older than the stale limit is taken over even if the pid is alive', old.ok === true);
    old.release();

    // release() must not remove a lock that now belongs to someone else.
    const mine = store.acquireLock('web', { runId: 'mine' === 'x' ? '' : a });
    fs.writeFileSync(store.appPaths('web').lock, JSON.stringify({ pid: process.pid, runId: 'someone-else', at: Date.now() }));
    mine.release();
    check('release() leaves a lock it no longer owns', fs.existsSync(store.appPaths('web').lock));
    fs.rmSync(store.appPaths('web').lock, { force: true });

    const ids = [];
    for (let i = 0; i < store.MAX_RUNS_KEPT + 4; i++) {
      const id = store.newReleaseId(new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
      ids.push(id);
      store.writeRun({ id, appId: 'web', status: 'success' });
      fs.writeFileSync(store.logFile('web', id), `log ${i}\n`);
    }
    check('runs are listed newest first', store.listRuns('web', { limit: 3 })[0].id === ids[ids.length - 1]);
    check('pruning keeps the newest and removes the rest with their logs',
      store.pruneRuns('web') === 4 && store.listRuns('web', { limit: 100 }).length === store.MAX_RUNS_KEPT
      && !fs.existsSync(store.logFile('web', ids[0])) && fs.existsSync(store.logFile('web', ids[ids.length - 1])));
    check('a run id that is not an id reads as null', store.readRun('web', '../../etc/passwd') === null);

    const big = ids[ids.length - 1];
    fs.writeFileSync(store.logFile('web', big), `${'x'.repeat(100)}\n`.repeat(2000));
    const tail = store.readLogTail('web', big, { maxBytes: 1000 });
    check('a long log is returned as a tail that starts on a line boundary',
      tail.truncated && tail.text.length <= 1000 && tail.text.startsWith('x'.repeat(100)));

    const rel = [];
    for (let i = 0; i < 6; i++) {
      const id = store.newReleaseId(new Date(Date.UTC(2026, 1, 1, 0, 0, i)));
      rel.push(id);
      fs.mkdirSync(store.releaseDir('web', id), { recursive: true });
    }
    const removed = store.pruneReleases('web', { keep: 2, protect: [rel[0]] });
    check('old releases are removed, but a protected one never is',
      removed.length === 3 && store.listReleases('web').includes(rel[0]) && store.listReleases('web').length === 3);
    for (const id of store.listReleases('web')) fs.rmSync(store.releaseDir('web', id), { recursive: true, force: true });
    for (const r of store.listRuns('web', { limit: 100 })) fs.rmSync(store.runFile('web', r.id), { force: true });
  }

  // ── 4. The engine ───────────────────────────────────────────────────────────
  setGroup('4. Deploying');
  const pm2 = makeFakePm2();
  const sent = [];
  const deps = {
    runner: pm2,
    // The engine's own pauses are shortened; the health deadline is real time.
    sleep: (ms) => sleep(Math.min(ms, 120)),
    sendNotification: async (event, channelIds) => { sent.push({ event, channelIds }); return { ok: true }; },
  };

  const port = await freePort();
  const repo = makeRepo('site');

  /** Registers an app whose "repository" is the local one — the engine trusts the record. */
  const register = (id, overrides = {}) => {
    const now = new Date().toISOString();
    const app = {
      id, repoUrl: repo, branch: 'main', auth: { type: 'none', token: null, publicKey: null },
      settings: { port }, env: { GREETING: 'hello' }, keepReleases: 5, autoRollback: true, notifyChannelIds: ['ch1'],
      hook: { tokenHash: null, tokenHint: null, createdAt: null }, createdAt: now, updatedAt: now,
      ...overrides,
    };
    dbSet('deployApps', [...apps.listApps().filter((a) => a.id !== id), app]);
    return app;
  };
  const deploy = async (id, opts = {}) => {
    const started = engine.startDeployment(id, { deps, ...opts });
    if (!started.ok) return started;
    return { ...started, run: await started.done };
  };
  const body = async (p = port, pathname = '/') => (await httpRequest({ port: p, pathname })).text;
  const logOf = (id, runId) => fs.readFileSync(store.logFile(id, runId), 'utf8');

  try {
    register('site');

    // v1: plain package.json, no ez.json.
    const sha1 = commit(repo, {
      'package.json': JSON.stringify({ name: 'site', scripts: { build: 'node build.js', start: 'node server.js' } }),
      'server.js': SERVER_JS,
      'build.js': "require('fs').writeFileSync('BUILT', 'yes');",
      VERSION: 'v1',
    }, 'v1');

    const d1 = await deploy('site');
    const run1 = d1.run;
    check('a first deployment succeeds', run1?.status === 'success', run1?.error ?? '');
    check('the run records the commit', run1?.sha === sha1 && run1.step === 'done' && typeof run1.finishedAt === 'number');
    check('the app really answers on its port', await body() === 'v1');
    check('the state names the live release', store.readState('site').current === run1.releaseId && store.readState('site').previous === null);

    const dir1 = store.releaseDir('site', run1.releaseId);
    check('the build ran in the release directory', fs.existsSync(path.join(dir1, 'BUILT')));
    check('node_modules-free project still installed without error (npm install ran)', /npm install/.test(logOf('site', run1.id)));
    check('the app\'s environment reaches the process, with PORT and the release id',
      JSON.parse(await body(port, '/env')).greeting === 'hello' && JSON.parse(await body(port, '/env')).release === run1.releaseId);
    check('the log shows where each setting came from', /\[package\.json\]/.test(logOf('site', run1.id)) && /\[override\]/.test(logOf('site', run1.id)));
    check('"npm start" went through the launcher',
      fs.existsSync(path.join(dir1, 'ez-launch.cjs')) && JSON.parse(fs.readFileSync(path.join(dir1, engine.PM2_CONFIG_FILE))).apps[0].script === 'ez-launch.cjs');
    if (process.platform !== 'win32') {
      check('the PM2 config (it holds the environment) is owner-only',
        (fs.statSync(path.join(dir1, engine.PM2_CONFIG_FILE)).mode & 0o077) === 0);
    }
    check('PM2 was asked to save the process list', pm2.calls.some((c) => c[0] === 'save'));
    check('a success notification went to the app\'s channels',
      sent.at(-1)?.event.type === 'deploy' && sent.at(-1).event.subtype === 'success' && sent.at(-1).channelIds.join() === 'ch1');

    // v2: adds an ez.json with explicit commands and hooks.
    commit(repo, {
      VERSION: 'v2',
      'ez.json': JSON.stringify({
        install: false,
        build: 'node build.js',
        start: 'node server.js',
        health: '/healthz',
        hooks: { pre: 'node -e "require(\'fs\').writeFileSync(\'PRE\',\'1\')"', post: 'node -e "require(\'fs\').writeFileSync(\'POST\',\'1\')"' },
      }),
    }, 'v2');

    const d2 = await deploy('site');
    const run2 = d2.run;
    const dir2 = run2 ? store.releaseDir('site', run2.releaseId) : '';
    check('a second deployment succeeds and the new version answers', run2?.status === 'success' && await body() === 'v2', run2?.error ?? '');
    check('the previous release is remembered for a rollback',
      store.readState('site').current === run2.releaseId && store.readState('site').previous === run1.releaseId);
    check('ez.json was used', /ez\.json found at ez\.json/.test(logOf('site', run2.id)) && /\[ez\.json\]/.test(logOf('site', run2.id)));
    check('install: false skipped the install step', !/── Install/.test(logOf('site', run2.id)));
    check('the pre and post hooks ran', fs.existsSync(path.join(dir2, 'PRE')) && fs.existsSync(path.join(dir2, 'POST')));
    check('"node server.js" is run by PM2 directly, with no launcher',
      !fs.existsSync(path.join(dir2, 'ez-launch.cjs')) && JSON.parse(fs.readFileSync(path.join(dir2, engine.PM2_CONFIG_FILE))).apps[0].script === 'server.js');
    check('the old release is still on disk', fs.existsSync(dir1));

    // Two at once.
    const racing = engine.startDeployment('site', { deps });
    const refused = engine.startDeployment('site', { deps });
    check('a second deployment of the same app is refused while one runs',
      racing.ok && refused.ok === false && refused.status === 409 && refused.runId === racing.runId);
    const raced = await racing.done;
    check('and the lock is free again afterwards', raced.status === 'success' && store.lockHolder('site') === null);

    // A build that fails.
    const liveBefore = store.readState('site').current;
    commit(repo, { VERSION: 'v3-broken', 'build.js': 'process.exit(3);' }, 'broken build');
    const d3 = await deploy('site');
    check('a failed build is a failed run, at the build step',
      d3.run.status === 'failed' && d3.run.step === 'build' && /exit code 3/.test(d3.run.error), d3.run.error);
    check('the running release was not touched', await body() === 'v2' && store.readState('site').current === liveBefore);
    check('the half-built directory was removed', !fs.existsSync(store.releaseDir('site', d3.run.releaseId)));
    check('a failure notification was sent, with the reason',
      sent.at(-1).event.subtype === 'failed' && sent.at(-1).event.severity === 'danger' && /Build failed/.test(sent.at(-1).event.message));

    // A release that builds but is not healthy → automatic rollback.
    commit(repo, {
      VERSION: 'v4-unhealthy',
      'build.js': "require('fs').writeFileSync('BUILT', 'yes');",
      'server.js': 'setTimeout(() => process.exit(1), 300);',
      'ez.json': JSON.stringify({ install: false, start: 'node server.js', health: { path: '/healthz', timeout: 4 } }),
    }, 'unhealthy');
    const d4 = await deploy('site');
    check('an unhealthy release is rolled back', d4.run.status === 'rolled_back' && d4.run.step === 'health', `${d4.run.status} ${d4.run.error}`);
    check('the previous version is answering again', await body() === 'v2');
    check('the state still points at the good release',
      store.readState('site').current === liveBefore && d4.run.rolledBackTo === liveBefore);
    check('the notification says it was rolled back', sent.at(-1).event.subtype === 'rolled_back' && sent.at(-1).event.severity === 'warning');
    check('the log explains what happened', /Rolling back to/.test(logOf('site', d4.run.id)) && /is running again/.test(logOf('site', d4.run.id)));

    // The same failure with rollback switched off.
    register('site', { autoRollback: false });
    const d5 = await deploy('site');
    check('with auto-rollback off, the failure stands and the broken process is removed',
      d5.run.status === 'failed' && !pm2.procs.has('ez-site') && store.readState('site').current === liveBefore);
    register('site');

    // Manual rollback to the release before the live one.
    const back = engine.startRollback('site', { deps });
    const backRun = await back.done;
    // The release before the live one is run2: the "two at once" deployment
    // above made a third release from the same commit and became the live one.
    const startsBefore = pm2.calls.filter((c) => c[0] === 'start').length;
    check('a manual rollback starts the previous release without rebuilding',
      back.ok && backRun.status === 'success' && backRun.trigger === 'rollback' && backRun.releaseId === run2.releaseId
      && await body() === 'v2' && !/── (Install|Build)/.test(logOf('site', backRun.id)), backRun.error ?? '');
    check('current and previous swap', store.readState('site').current === run2.releaseId && store.readState('site').previous === liveBefore);
    check('rolling back to the release that is already live is refused',
      engine.startRollback('site', { releaseId: run2.releaseId, deps }).status === 409);

    const toFirst = engine.startRollback('site', { releaseId: run1.releaseId, deps });
    const toFirstRun = await toFirst.done;
    check('any earlier release that is still on disk can be chosen',
      toFirstRun.status === 'success' && await body() === 'v1' && store.readState('site').current === run1.releaseId
      && pm2.calls.filter((c) => c[0] === 'start').length >= startsBefore);
    check('rolling back to a release that is gone is a 404',
      engine.startRollback('site', { releaseId: store.newReleaseId(), deps }).status === 404);

    // An invalid ez.json stops before anything is touched.
    commit(repo, { VERSION: 'v5', 'server.js': SERVER_JS, 'ez.json': '{ "start": "node server.js", "port": "eighty" }' }, 'bad ez.json');
    const d6 = await deploy('site');
    check('an invalid ez.json fails at the settings step, naming the problem',
      d6.run.status === 'failed' && d6.run.step === 'settings' && /port/.test(d6.run.error), d6.run.error);
    check('and what was running keeps running', await body() === 'v1');

    // ez.json in deploy/, a failing post hook, and deploying a specific commit.
    const sha7 = commit(repo, {
      VERSION: 'v7',
      'ez.json': null,
      'deploy/ez.json': JSON.stringify({ install: false, build: false, start: 'node server.js', hooks: { post: 'node -e "process.exit(9)"' } }),
    }, 'v7');
    commit(repo, { VERSION: 'v8' }, 'v8');

    const d7 = await deploy('site', { ref: sha7, trigger: 'webhook', actor: 'deploy hook' });
    if (!d7.run) throw new Error(`deploying a named commit did not start: ${JSON.stringify(d7)}`);
    check('a named commit is deployed, not the branch tip',
      d7.run.status === 'success' && d7.run.sha === sha7 && await body() === 'v7', d7.run.error ?? '');
    check('ez.json is found in deploy/', /ez\.json found at deploy\/ez\.json/.test(logOf('site', d7.run.id)));
    check('a failing post hook is a warning on a live release, not a rollback',
      d7.run.warnings.some((w) => /post-deploy hook failed/.test(w)));
    check('the run records how it was triggered', d7.run.trigger === 'webhook' && d7.run.actor === 'deploy hook');

    check('a ref that could be read as an option is refused before anything runs',
      engine.startDeployment('site', { ref: '--upload-pack=x', deps }).status === 400);
    check('an unknown app is a 404', engine.startDeployment('nope', { deps }).status === 404);

    const d8 = await deploy('site', { ref: 'no-such-branch' });
    check('a ref that does not exist fails at fetch and touches nothing',
      d8.run.status === 'failed' && d8.run.step === 'fetch' && await body() === 'v7');

    // Nothing to start.
    const emptyRepo = makeRepo('empty');
    commit(emptyRepo, { 'README.md': 'nothing to run' }, 'init');
    register('empty', { repoUrl: emptyRepo, settings: {} });
    const d9 = await deploy('empty');
    check('a project with nothing to start says so', d9.run.status === 'failed' && /Nothing to start/.test(d9.run.error));

    // No port: the process only has to stay up.
    const workerRepo = makeRepo('worker');
    commit(workerRepo, { 'worker.js': 'setInterval(() => {}, 1000);', 'ez.json': JSON.stringify({ start: 'node worker.js' }) }, 'worker');
    register('worker', { repoUrl: workerRepo, settings: {}, notifyChannelIds: [] });
    const d10 = await deploy('worker');
    check('an app without a port is healthy when it stays online',
      d10.run.status === 'success' && /no port is configured/.test(logOf('worker', d10.run.id)), d10.run.error ?? '');

    commit(workerRepo, { 'worker.js': 'process.exit(1);' }, 'crashing worker');
    const d11 = await deploy('worker');
    check('an app without a port that exits is caught and rolled back', d11.run.status === 'rolled_back', `${d11.run.status} ${d11.run.error}`);

    // PM2 missing.
    pm2.installed = false;
    const d12 = await deploy('worker');
    check('without PM2 the deployment fails at start, saying how to install it',
      d12.run.status === 'failed' && d12.run.step === 'start' && /npm install -g pm2/.test(d12.run.error));
    pm2.installed = true;

    // A token must never reach the log.
    const TOKEN = 'ghp_SuperSecretToken1234567890';
    register('tokened', { auth: { type: 'token', token: TOKEN, publicKey: null }, settings: { port: await freePort() } });
    const d13 = await deploy('tokened');
    const tokenLog = logOf('tokened', d13.run.id);
    check('a deployment with a token works and logs the header masked',
      d13.run.status === 'success' && tokenLog.includes('Authorization: Basic ***'), d13.run.error ?? '');
    check('neither the token nor its encoded form is in the log',
      !tokenLog.includes(TOKEN) && !tokenLog.includes(Buffer.from(`x-access-token:${TOKEN}`).toString('base64')));
    check('nor in the checkout\'s git config',
      !fs.readFileSync(path.join(store.releaseDir('tokened', d13.run.releaseId), '.git', 'config'), 'utf8').includes('Basic'));

    // A deploy-key app with no key yet.
    register('nokey', { repoUrl: 'git@github.com:me/x.git', auth: { type: 'deployKey', token: null, publicKey: null } });
    const d14 = await deploy('nokey');
    check('a deploy-key app without a key fails with a clear message, without calling the network',
      d14.run.status === 'failed' && /none has been generated/.test(d14.run.error));

    // Old releases are pruned, the live and previous ones never.
    register('site', { keepReleases: 2 });
    commit(repo, { VERSION: 'v9' }, 'v9');
    const d15 = await deploy('site');
    const kept = store.listReleases('site');
    check('old releases are pruned to keepReleases', d15.run.status === 'success' && kept.length <= 3, `${kept.length} kept`);
    check('the live release and the one before it are always kept',
      kept.includes(store.readState('site').current) && kept.includes(store.readState('site').previous));

    // Removing an app.
    const removedApp = await engine.removeApp('worker', { deps });
    check('removing an app stops its process and deletes its files',
      removedApp.ok && !pm2.procs.has('ez-worker') && apps.getApp('worker') === null && !fs.existsSync(store.appPaths('worker').root));
    check('removing an unknown app is a 404', (await engine.removeApp('worker', { deps })).status === 404);

    check('every run left the lock free',
      ['site', 'empty', 'tokened', 'nokey'].every((id) => store.lockHolder(id) === null));
  } finally {
    await pm2.stopAll();
  }

  // ── 4b. Persistent folders ──────────────────────────────────────────────────
  setGroup('4b. Persistent paths');
  {
    const PERSIST_SERVER = `
const http = require('http');
const fs = require('fs');
const path = require('path');
const version = fs.readFileSync(__dirname + '/VERSION', 'utf8').trim();
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.statusCode = 200; return res.end('ok'); }
  if (url.pathname === '/write') {
    fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'uploads', url.searchParams.get('name') || 'note.txt'), 'runtime');
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'data', 'app.json'), '{"n":1}');
    return res.end('written');
  }
  if (url.pathname === '/env') return res.end(JSON.stringify({ shared: process.env.EZ_SHARED_DIR || null }));
  res.end(version);
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

    const pport = await freePort();
    const prepo = makeRepo('persist');
    const pbody = async (pathname = '/') => (await httpRequest({ port: pport, pathname })).text;
    const shared = () => store.appPaths('persist').shared;
    // A symlink, or the hard link Windows falls back to without the privilege.
    const sameFile = (a, b) => {
      try {
        if (fs.lstatSync(a).isSymbolicLink()) {
          const x = fs.realpathSync(a);
          const y = fs.realpathSync(b);
          return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
        }
        const x = fs.statSync(a);
        const y = fs.statSync(b);
        return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
      } catch { return false; }
    };
    register('persist', { repoUrl: prepo, settings: { port: pport }, notifyChannelIds: [] });

    commit(prepo, {
      'package.json': JSON.stringify({ name: 'persist' }),
      'ez.json': JSON.stringify({
        install: false, build: false, start: 'node server.js', health: '/healthz',
        persist: ['data', 'uploads', 'storage/logs'],
      }),
      'server.js': PERSIST_SERVER,
      VERSION: 'p1',
      'uploads/seed.txt': 'from-repo',
      'data/seed.txt': 'from-repo',
      'storage/logs/app.log': 'from-repo',
    }, 'p1');

    const p1 = await deploy('persist');
    const pdir1 = p1.run ? store.releaseDir('persist', p1.run.releaseId) : '';
    check('a deployment with persistent folders succeeds', p1.run?.status === 'success', p1.run?.error ?? '');
    check('each folder is a link in the release, not a copy',
      ['data', 'uploads', 'storage/logs'].every((rel) => fs.lstatSync(path.join(pdir1, rel)).isSymbolicLink()));
    check('the first deployment seeds the shared copy from the repository',
      fs.readFileSync(path.join(shared(), 'uploads', 'seed.txt'), 'utf8') === 'from-repo'
      && fs.readFileSync(path.join(shared(), 'storage', 'logs', 'app.log'), 'utf8') === 'from-repo');
    check('the log says which folders are persistent and that they were seeded',
      /persist\s+data, uploads, storage\/logs/.test(logOf('persist', p1.run.id))
      && /seeded from the repository/.test(logOf('persist', p1.run.id)));
    check('EZ_SHARED_DIR names the shared folder',
      JSON.parse(await pbody('/env')).shared === shared());

    await pbody('/write?name=photo.txt');
    check('data written at runtime lands in the shared folder, through the link',
      fs.readFileSync(path.join(shared(), 'uploads', 'photo.txt'), 'utf8') === 'runtime'
      && fs.readFileSync(path.join(pdir1, 'data', 'app.json'), 'utf8') === '{"n":1}');

    // v2: the repository changes the seeded file; the shared copy must win.
    commit(prepo, { VERSION: 'p2', 'uploads/seed.txt': 'changed-in-repo', 'data/seed.txt': 'changed-in-repo' }, 'p2');
    const p2 = await deploy('persist');
    const pdir2 = p2.run ? store.releaseDir('persist', p2.run.releaseId) : '';
    check('a second deployment keeps the runtime data', await pbody() === 'p2'
      && fs.readFileSync(path.join(pdir2, 'uploads', 'photo.txt'), 'utf8') === 'runtime', p2.run?.error ?? '');
    check('the shared copy wins over the repository copy',
      fs.readFileSync(path.join(shared(), 'uploads', 'seed.txt'), 'utf8') === 'from-repo');
    check('the link points at the same folder in every release',
      fs.realpathSync(path.join(pdir2, 'uploads')) === fs.realpathSync(path.join(pdir1, 'uploads')));

    // A third deployment, with pruning on: the release holding the first copy goes.
    register('persist', { repoUrl: prepo, settings: { port: pport }, keepReleases: 2, notifyChannelIds: [] });
    commit(prepo, { VERSION: 'p3' }, 'p3');
    const p3 = await deploy('persist');
    check('old releases are pruned without touching the shared data',
      p3.run?.status === 'success' && !fs.existsSync(pdir1)
      && fs.existsSync(path.join(shared(), 'uploads', 'photo.txt')), p3.run?.error ?? '');
    await pbody('/write?name=after-prune.txt');
    check('and the live release still writes into it', fs.existsSync(path.join(shared(), 'uploads', 'after-prune.txt')));

    // Rollback: the older release kept its links, so it sees the same data.
    const pback = await (async () => { const s = engine.startRollback('persist', { deps }); return s.ok ? s.done : s; })();
    check('a rollback finds the data through the older release\'s link',
      pback.status === 'success' && await pbody() === 'p2'
      && fs.readFileSync(path.join(pdir2, 'uploads', 'after-prune.txt'), 'utf8') === 'runtime', pback.error ?? '');

    // Delete: the app goes, its data stays and can be brought back by name.
    const kept = await engine.removeApp('persist', { deps });
    check('deleting an app keeps its persistent data by default',
      kept.ok && kept.sharedKept === true && apps.getApp('persist') === null
      && fs.existsSync(path.join(shared(), 'uploads', 'photo.txt')) && !fs.existsSync(path.join(store.appPaths('persist').root, 'releases')));
    check('the reply names the folder that was kept', kept.sharedPath === shared());

    register('persist', { repoUrl: prepo, settings: { port: pport }, notifyChannelIds: [] });
    const p4 = await deploy('persist');
    check('creating the app again finds its old data',
      p4.run?.status === 'success'
      && fs.readFileSync(path.join(store.releaseDir('persist', p4.run.releaseId), 'uploads', 'photo.txt'), 'utf8') === 'runtime', p4.run?.error ?? '');

    const purged = await engine.removeApp('persist', { deps, purgeData: true });
    check('deleting with purgeData removes the shared folder too',
      purged.ok && purged.sharedKept === false && !fs.existsSync(store.appPaths('persist').root));

    // A single file as a persistent path: kept and linked like a folder.
    const filePort = await freePort();
    const fileRepo = makeRepo('persist-file');
    commit(fileRepo, {
      'ez.json': JSON.stringify({
        install: false, build: false, start: 'node server.js', health: '/healthz',
        persist: ['prisma/hub.db'],
      }),
      'server.js': PERSIST_SERVER,
      VERSION: 'f1',
      'prisma/hub.db': 'from-repo',
    }, 'file at persist path');
    register('persist-file', { repoUrl: fileRepo, settings: { port: filePort }, notifyChannelIds: [] });
    const pf = await deploy('persist-file');
    const pfdir = pf.run ? store.releaseDir('persist-file', pf.run.releaseId) : '';
    const fileShared = path.join(store.appPaths('persist-file').shared, 'prisma', 'hub.db');
    check('a single file can be a persistent path',
      pf.run?.status === 'success' && fs.existsSync(fileShared)
      && fs.readFileSync(fileShared, 'utf8') === 'from-repo'
      && sameFile(path.join(pfdir, 'prisma', 'hub.db'), fileShared), pf.run?.error ?? '');
    check('the log marks the path as a file and says where it was seeded from',
      /persist\s+prisma\/hub\.db \(file\) \(seeded from the repository\)/.test(logOf('persist-file', pf.run.id)));

    commit(fileRepo, { 'prisma/hub.db': 'changed-in-repo', VERSION: 'f2' }, 'file changed');
    const pf2 = await deploy('persist-file');
    const pfdir2 = pf2.run ? store.releaseDir('persist-file', pf2.run.releaseId) : '';
    check('the kept copy of a file wins over the repository copy',
      pf2.run?.status === 'success' && fs.readFileSync(fileShared, 'utf8') === 'from-repo'
      && sameFile(path.join(pfdir2, 'prisma', 'hub.db'), fileShared), pf2.run?.error ?? '');

    // A build that recreates a persistent folder: refused before anything is switched.
    const clobberRepo = makeRepo('persist-clobber');
    commit(clobberRepo, {
      'ez.json': JSON.stringify({
        install: false,
        build: 'node -e "const fs=require(\'fs\'); fs.rmSync(\'data\',{recursive:true,force:true}); fs.mkdirSync(\'data\')"',
        start: 'node x.js', persist: ['data'],
      }),
      'x.js': 'setInterval(() => {}, 1000);',
      'data/keep.txt': 'from-repo',
    }, 'build recreates data');
    register('persist-clobber', { repoUrl: clobberRepo, settings: {}, notifyChannelIds: [] });
    const pc = await deploy('persist-clobber');
    check('a build that recreates a persistent folder is a build failure, not silent data loss',
      pc.run?.status === 'failed' && pc.run?.step === 'build' && /replaced the persistent path "data"/.test(pc.run.error), pc.run?.error ?? '');
    check('and the shared data is untouched', fs.readFileSync(path.join(store.appPaths('persist-clobber').shared, 'data', 'keep.txt'), 'utf8') === 'from-repo');

    // Deleting one release: its folder goes, its log and the shared data stay.
    const delPort = await freePort();
    const delRepo = makeRepo('release-del');
    const delEz = JSON.stringify({
      install: false, build: false, start: 'node server.js', health: '/healthz', persist: ['data'],
    });
    register('release-del', { repoUrl: delRepo, settings: { port: delPort }, notifyChannelIds: [] });
    commit(delRepo, {
      'ez.json': delEz, 'server.js': SERVER_JS, VERSION: 'd1', 'data/keep.txt': 'from-repo',
    }, 'd1');
    const d1 = await deploy('release-del');
    commit(delRepo, { VERSION: 'd2' }, 'd2');
    const d2 = await deploy('release-del');
    commit(delRepo, { VERSION: 'd3' }, 'd3');
    const d3 = await deploy('release-del');
    check('three releases are on disk before one is deleted',
      d1.run?.status === 'success' && d2.run?.status === 'success' && d3.run?.status === 'success'
      && [d1, d2, d3].every((d) => fs.existsSync(store.releaseDir('release-del', d.run.releaseId))),
      d3.run?.error ?? '');

    const delLive = engine.removeRelease('release-del', d3.run.releaseId);
    check('the live release cannot be deleted',
      !delLive.ok && delLive.status === 409 && /live/.test(delLive.error), delLive.error ?? '');
    const delFallback = engine.removeRelease('release-del', d2.run.releaseId);
    check('the release an automatic rollback would return to cannot be deleted',
      !delFallback.ok && delFallback.status === 409 && /automatic rollback/.test(delFallback.error), delFallback.error ?? '');
    check('an unknown release is a 404 and a bad id a 400',
      engine.removeRelease('release-del', '20200101-000000-abcdef').status === 404
      && engine.removeRelease('release-del', '../x').status === 400);

    const del = engine.removeRelease('release-del', d1.run.releaseId);
    check('an old release can be deleted',
      del.ok && del.deleted === d1.run.releaseId && !fs.existsSync(store.releaseDir('release-del', d1.run.releaseId)), del.error ?? '');
    check('its run log is kept', fs.existsSync(store.logFile('release-del', d1.run.id)));
    check('the shared data is untouched by the release delete',
      fs.readFileSync(path.join(store.appPaths('release-del').shared, 'data', 'keep.txt'), 'utf8') === 'from-repo');
    const delAgain = engine.removeRelease('release-del', d1.run.releaseId);
    check('deleting the same release twice is a 404', !delAgain.ok && delAgain.status === 404, delAgain.error ?? '');
    await engine.removeApp('release-del', { deps, purgeData: true });
  }

  // ── 5. Events ───────────────────────────────────────────────────────────────
  setGroup('5. Deployment events');
  {
    const ok = events.createDeployEvent('web', 'success', { sha: '9f2c1a7b0d3e' });
    check('success', ok.type === 'deploy' && ok.subtype === 'success' && ok.severity === 'success' && ok.message.includes('(9f2c1a7)') && ok.app === 'web');
    const failed = events.createDeployEvent('web', 'failed', { reason: 'Build failed' });
    check('failure carries the reason', failed.severity === 'danger' && failed.message.endsWith(': Build failed'));
    const rb = events.createDeployEvent('web', 'rolled_back', { reason: 'no answer' });
    check('rolled back is a warning', rb.severity === 'warning' && /previous release was restored/.test(rb.message));
    check('a manual rollback is worded as one', /^🚀 Rollback of web/.test(events.createDeployEvent('web', 'success', { rollback: true }).message));
  }

  // ── 6. The deploy hook ──────────────────────────────────────────────────────
  setGroup('6. The deploy hook');
  {
    dbSet('deployApps', []);
    apps.createApp({ id: 'hooked', repoUrl: 'https://github.com/me/hooked.git' });
    apps.createApp({ id: 'untokened', repoUrl: 'https://github.com/me/other.git' });
    const { token } = apps.rotateHookToken('hooked');

    const started = [];
    let nextResult = null;
    const runId = store.newReleaseId();
    store.writeRun({ id: runId, appId: 'hooked', status: 'running', step: 'build', sha: 'abc', error: null, startedAt: 1, finishedAt: null });

    const handler = hook.createHookHandler({
      deploy: (appId, opts) => { started.push({ appId, opts }); return nextResult ?? { ok: true, runId }; },
    });
    const server = await hook.startHookServer({ port: 0, handler });
    const p = server.port;
    const auth = { Authorization: `Bearer ${token}` };
    // Each test client gets its own rate-limit bucket. The header is honoured
    // because these connections come from loopback, as nginx's would.
    const from = (ip) => ({ 'X-Forwarded-For': ip });

    try {
      const health = await httpRequest({ port: p, pathname: '/.ez-deploy/health' });
      check('the liveness path answers without a token', health.status === 200 && health.json?.ok === true);

      const good = await httpRequest({
        port: p, method: 'POST', pathname: '/.ez-deploy/hooked',
        headers: { ...auth, ...from('10.0.0.1'), 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'abc123' }),
      });
      check('a valid token starts a deployment: 202 with the run id',
        good.status === 202 && good.json.runId === runId && good.json.statusPath === `/.ez-deploy/hooked/runs/${runId}`);
      check('the deployment is started for that app, with the ref, as a webhook',
        started.length === 1 && started[0].appId === 'hooked' && started[0].opts.ref === 'abc123' && started[0].opts.trigger === 'webhook');

      const noBody = await httpRequest({ port: p, method: 'POST', pathname: '/.ez-deploy/hooked', headers: { ...auth, ...from('10.0.0.1') } });
      check('the body is optional', noBody.status === 202 && started[1].opts.ref === null);

      const status = await httpRequest({ port: p, pathname: `/.ez-deploy/hooked/runs/${runId}`, headers: { ...auth, ...from('10.0.0.1') } });
      check('the run status is readable with the same token',
        status.status === 200 && status.json.status === 'running' && status.json.step === 'build');
      check('the status never includes the log', status.json.log === undefined);

      const missingRun = await httpRequest({ port: p, pathname: `/.ez-deploy/hooked/runs/${store.newReleaseId()}`, headers: { ...auth, ...from('10.0.0.1') } });
      check('an unknown run is a 404', missingRun.status === 404);

      const wrong = await httpRequest({ port: p, method: 'POST', pathname: '/.ez-deploy/hooked', headers: { Authorization: 'Bearer nope', ...from('10.0.0.2') } });
      const none = await httpRequest({ port: p, method: 'POST', pathname: '/.ez-deploy/hooked', headers: from('10.0.0.2') });
      const unknownApp = await httpRequest({ port: p, method: 'POST', pathname: '/.ez-deploy/ghost', headers: { ...auth, ...from('10.0.0.2') } });
      const noTokenApp = await httpRequest({ port: p, method: 'POST', pathname: '/.ez-deploy/untokened', headers: { ...auth, ...from('10.0.0.2') } });
      check('a wrong token, no token, an unknown app and an app with no token all get the same 401',
        [wrong, none, unknownApp, noTokenApp].every((r) => r.status === 401 && r.text === wrong.text));
      check('none of them started anything', started.length === 2);

      const otherApps = await httpRequest({ port: p, pathname: `/.ez-deploy/untokened/runs/${runId}`, headers: { ...auth, ...from('10.0.0.2') } });
      check('a token cannot read another app\'s runs', otherApps.status === 401);

      nextResult = { ok: false, status: 409, error: 'A deployment of this app is already running.', runId };
      const busy = await httpRequest({ port: p, method: 'POST', pathname: '/.ez-deploy/hooked', headers: { ...auth, ...from('10.0.0.1') } });
      check('an app that is already deploying is a 409 naming the running run', busy.status === 409 && busy.json.runId === runId);
      nextResult = null;

      const badJson = await httpRequest({ port: p, method: 'POST', pathname: '/.ez-deploy/hooked', headers: { ...auth, ...from('10.0.0.1') }, body: '{ nope' });
      check('a body that is not JSON is a 400', badJson.status === 400);

      const huge = await httpRequest({ port: p, method: 'POST', pathname: '/.ez-deploy/hooked', headers: { ...auth, ...from('10.0.0.1') }, body: 'x'.repeat(40 * 1024) });
      check('an oversized body is refused', huge.status === 413 || huge.status === null, String(huge.status));

      const elsewhere = await httpRequest({ port: p, pathname: '/api/settings', headers: auth });
      const root = await httpRequest({ port: p, pathname: '/' });
      const wrongMethod = await httpRequest({ port: p, method: 'DELETE', pathname: '/.ez-deploy/hooked', headers: auth });
      check('nothing else is served: no dashboard API, no root, no other methods',
        elsewhere.status === 404 && root.status === 404 && wrongMethod.status === 404);

      // Rate limiting: ten failures from one client, then 429 even with the right token.
      const before = started.length;
      for (let i = 0; i < 10; i++) {
        await httpRequest({ port: p, method: 'POST', pathname: '/.ez-deploy/hooked', headers: { Authorization: 'Bearer wrong', ...from('10.9.9.9') } });
      }
      const limited = await httpRequest({ port: p, method: 'POST', pathname: '/.ez-deploy/hooked', headers: { ...auth, ...from('10.9.9.9') } });
      check('after ten failures a client is locked out, even with the right token', limited.status === 429 && started.length === before);
      const other = await httpRequest({ port: p, method: 'POST', pathname: '/.ez-deploy/hooked', headers: { ...auth, ...from('10.9.9.8') } });
      check('another client is not affected', other.status === 202);
    } finally {
      await server.close();
    }

    // The settings and the manager that follows them.
    check('the hook is off by default, on loopback', (() => {
      const s = hook.hookSettings(loadConfig());
      return s.enabled === false && s.bind === '127.0.0.1' && s.port === 6445 && s.domain === null;
    })());
    check('unusable stored values fall back to safe ones', (() => {
      const s = hook.hookSettings({ deployHook: { enabled: 'yes', port: 'x', bind: '10.0.0.5', domain: 5 } });
      return s.enabled === false && s.port === 6445 && s.bind === '127.0.0.1' && s.domain === null;
    })());

    const lines = [];
    const manager = hook.startDeployHookManager({ pollMs: 60_000, log: (l) => lines.push(l) });
    try {
      await manager.check();
      check('switched off: nothing listens', manager.state().listening === false);

      const portA = await freePort();
      saveConfig({ ...loadConfig(), deployHook: { enabled: true, port: portA, bind: '127.0.0.1', domain: null } });
      await manager.check();
      check('switching it on starts the listener, with no restart',
        manager.state().listening === true && (await httpRequest({ port: portA, pathname: '/.ez-deploy/health' })).status === 200);

      const portB = await freePort();
      saveConfig({ ...loadConfig(), deployHook: { enabled: true, port: portB, bind: '127.0.0.1', domain: null } });
      await manager.check();
      check('changing the port moves it',
        (await httpRequest({ port: portB, pathname: '/.ez-deploy/health' })).status === 200
        && (await httpRequest({ port: portA, pathname: '/.ez-deploy/health' })).status === null);

      // A port that is taken: reported once, retried, and picked up when free.
      const blocker = net.createServer();
      const portC = await freePort();
      await new Promise((r) => blocker.listen(portC, '127.0.0.1', r));
      saveConfig({ ...loadConfig(), deployHook: { enabled: true, port: portC, bind: '127.0.0.1', domain: null } });
      await manager.check();
      await manager.check();
      check('a busy port is reported once and does not crash the manager',
        manager.state().listening === false && /already in use/.test(manager.state().error ?? '')
        && lines.filter((l) => /could not listen/.test(l)).length === 1);
      await new Promise((r) => blocker.close(r));
      await manager.check();
      check('and it starts once the port is free', manager.state().listening === true);

      saveConfig({ ...loadConfig(), deployHook: { enabled: false, port: portC, bind: '127.0.0.1', domain: null } });
      await manager.check();
      check('switching it off stops the listener',
        manager.state().listening === false && (await httpRequest({ port: portC, pathname: '/.ez-deploy/health' })).status === null);
    } finally {
      await manager.stop();
    }
  }

  // ── 7. nginx exposure and the GitHub workflow ───────────────────────────────
  setGroup('7. nginx location and GitHub setup');
  {
    const domain = (overrides = {}) => ({
      ...gen.DOMAIN_DEFAULTS, name: 'example.com', port: 3000, ...overrides,
      ssl: { ...gen.DOMAIN_DEFAULTS.ssl, ...(overrides.ssl ?? {}) },
    });
    const nginxDir = scratch('nginx');
    const sslDir = scratch('ssl');

    const plain = gen.buildConf(domain(), nginxDir, sslDir, {});
    check('a domain not chosen for the hook has no hook location', !plain.includes('/.ez-deploy/'));

    const withHook = gen.buildConf(domain(), nginxDir, sslDir, { deployHookPort: 6445 });
    check('the chosen domain forwards /.ez-deploy/ to the listener on loopback',
      withHook.includes('location ^~ /.ez-deploy/') && withHook.includes('proxy_pass http://127.0.0.1:6445;'));
    check('the client address is overwritten, not appended',
      withHook.includes('proxy_set_header X-Forwarded-For $remote_addr;') && !withHook.includes('$proxy_add_x_forwarded_for;\n }\n\n location ^~ /.ez-deploy/'));

    const sslConf = gen.buildConf(domain({ ssl: { enabled: true, redirect: true } }), nginxDir, sslDir, { deployHookPort: 6445 });
    const blocks = sslConf.split(/\n(?=server \{)/);
    const httpsBlock = blocks.find((b) => /listen 443/.test(b)) ?? '';
    const httpBlock = blocks.find((b) => /listen 80;/.test(b)) ?? '';
    check('with SSL on, the hook is in the HTTPS block only',
      httpsBlock.includes('/.ez-deploy/') && !httpBlock.includes('/.ez-deploy/'));

    const p = gen.deployHookPortFor;
    check('only the chosen domain gets the port, and only while the hook is on',
      p('example.com', { deployHook: { enabled: true, port: 6445, domain: 'example.com' } }) === 6445
      && p('other.com', { deployHook: { enabled: true, port: 6445, domain: 'example.com' } }) === null
      && p('example.com', { deployHook: { enabled: false, port: 6445, domain: 'example.com' } }) === null
      && p('example.com', { deployHook: { enabled: true, port: 6445, domain: null } }) === null
      && p('example.com', {}) === null);

    const u = github.hookUrl;
    const domains = [{ name: 'example.com', enabled: true, ssl: { enabled: true } }, { name: 'plain.com', enabled: true, ssl: { enabled: false } }, { name: 'off.com', enabled: false, ssl: { enabled: true } }];
    check('through a domain with SSL: an https URL, marked secure',
      u('web', { enabled: true, port: 6445, bind: '127.0.0.1', domain: 'example.com' }, domains).url === 'https://example.com/.ez-deploy/web'
      && u('web', { enabled: true, port: 6445, bind: '127.0.0.1', domain: 'example.com' }, domains).secure === true);
    check('through a domain without SSL: http, and marked NOT secure',
      u('web', { enabled: true, port: 6445, bind: '127.0.0.1', domain: 'plain.com' }, domains).secure === false
      && /unencrypted/.test(u('web', { enabled: true, port: 6445, bind: '127.0.0.1', domain: 'plain.com' }, domains).note));
    check('direct mode is plain HTTP and says so',
      u('web', { enabled: true, port: 6445, bind: '0.0.0.0', domain: null }, domains).mode === 'direct'
      && u('web', { enabled: true, port: 6445, bind: '0.0.0.0', domain: null }, domains).secure === false);
    check('loopback with no domain is not reachable, and there is no URL to hand out',
      u('web', { enabled: true, port: 6445, bind: '127.0.0.1', domain: null }, domains).url === null);
    check('off, a deleted domain and a disabled domain give no URL',
      u('web', { enabled: false, port: 6445, bind: '0.0.0.0', domain: null }, domains).url === null
      && u('web', { enabled: true, port: 6445, bind: '127.0.0.1', domain: 'gone.com' }, domains).url === null
      && u('web', { enabled: true, port: 6445, bind: '127.0.0.1', domain: 'off.com' }, domains).url === null);

    const yaml = github.buildWorkflow({ appId: 'web', branch: 'main' });
    check('the workflow reads both secrets and never contains a value',
      yaml.includes('${{ secrets.EZ_DEPLOY_URL }}') && yaml.includes('${{ secrets.EZ_DEPLOY_TOKEN }}') && !/ezd_/.test(yaml));
    check('it deploys the pushed commit on the app\'s branch',
      yaml.includes('branches: ["main"]') && yaml.includes('{\\"ref\\":\\"$GITHUB_SHA\\"}'));
    check('it uses no third-party actions', !/uses:/.test(yaml));
    check('one deployment per app at a time', yaml.includes('group: ez-deploy-web') && yaml.includes('cancel-in-progress: false'));
    check('the workflow file path is per app', github.workflowPath('web') === '.github/workflows/ez-deploy-web.yml');

    const setup = github.describeGithubSetup(
      { id: 'web', branch: 'main', authType: 'deployKey', deployKey: 'ssh-rsa AAAA x', hook: { hasToken: true, tokenHint: 'abcd' } },
      { enabled: true, port: 6445, bind: '127.0.0.1', domain: 'example.com' }, domains,
    );
    check('the setup lists the URL secret with its value and the token secret without one',
      setup.secrets[0].name === 'EZ_DEPLOY_URL' && setup.secrets[0].value === 'https://example.com/.ez-deploy/web'
      && setup.secrets[1].name === 'EZ_DEPLOY_TOKEN' && setup.secrets[1].value === null && setup.deployKey === 'ssh-rsa AAAA x');

    // Run the generated script for real, against a real hook listener.
    const haveBash = spawnSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' });
    if (process.platform !== 'win32' && haveBash.status === 0) {
      dbSet('deployApps', []);
      apps.createApp({ id: 'ci', repoUrl: 'https://github.com/me/ci.git' });
      const { token } = apps.rotateHookToken('ci');

      // Indented block under "run: |", de-indented, with the 10s waits shortened.
      const script = yaml.split('\n').slice(yaml.split('\n').findIndex((l) => l.trim() === 'run: |') + 1)
        .map((l) => l.replace(/^ {10}/, '')).join('\n').replace(/sleep 10/g, 'sleep 0.3');
      const scriptFile = path.join(scratch('ci'), 'deploy.sh');
      fs.writeFileSync(scriptFile, script);

      const outcome = async (finalStatus) => {
        const runId = store.newReleaseId();
        let polls = 0;
        const handler = hook.createHookHandler({
          deploy: (appId) => {
            store.writeRun({ id: runId, appId, status: 'running', step: 'build', sha: 'abc', error: null, startedAt: 1, finishedAt: null });
            return { ok: true, runId };
          },
        });
        const server = await hook.startHookServer({
          port: 0,
          handler: async (req, res) => {
            // Finish the run after it has been polled once while running.
            if (req.method === 'GET' && req.url.includes('/runs/') && ++polls === 2) {
              store.writeRun({ id: runId, appId: 'ci', status: finalStatus, step: 'health', sha: 'abc', error: finalStatus === 'success' ? null : 'boom', startedAt: 1, finishedAt: 2 });
            }
            return handler(req, res);
          },
        });
        const child = spawn('bash', [scriptFile], {
          env: { ...process.env, EZ_DEPLOY_URL: `http://127.0.0.1:${server.port}/.ez-deploy/ci`, EZ_DEPLOY_TOKEN: token, GITHUB_SHA: 'abc123' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { out += c; });
        const code = await new Promise((r) => child.on('exit', r));
        await server.close();
        return { code, out };
      };

      const okRun = await outcome('success');
      check('the generated workflow script exits 0 when the deployment succeeds',
        okRun.code === 0 && /Deployed\./.test(okRun.out), okRun.out.split('\n').slice(-3).join(' | '));
      check('it reports progress while waiting', /\.\.\. build/.test(okRun.out));

      const failRun = await outcome('failed');
      check('it exits non-zero when the deployment fails', failRun.code === 1 && /::error::The deployment failed/.test(failRun.out));

      const rbRun = await outcome('rolled_back');
      check('it exits non-zero when the deployment was rolled back', rbRun.code === 1 && /previous release was restored/.test(rbRun.out));

      const noSecrets = spawnSync('bash', [scriptFile], { env: { ...process.env, EZ_DEPLOY_URL: '', EZ_DEPLOY_TOKEN: '' }, encoding: 'utf8' });
      check('it fails with a clear message when the secrets are missing',
        noSecrets.status === 1 && /Set the EZ_DEPLOY_URL and EZ_DEPLOY_TOKEN/.test(noSecrets.stdout));

      const badToken = await (async () => {
        const server = await hook.startHookServer({ port: 0 });
        const r = spawnSync('bash', [scriptFile], {
          env: { ...process.env, EZ_DEPLOY_URL: `http://127.0.0.1:${server.port}/.ez-deploy/ci`, EZ_DEPLOY_TOKEN: 'wrong', GITHUB_SHA: 'abc' },
          encoding: 'utf8',
        });
        await server.close();
        return r;
      })();
      check('it fails immediately when the hook refuses the token',
        badToken.status === 1 && /refused the request/.test(badToken.stdout));
    } else {
      process.stdout.write('   SKIP  bash and curl are needed to run the generated workflow script\n');
    }
  }

  // ── 8. Hub commands and the CI relay ────────────────────────────────────────
  setGroup('8. Deployments from the Hub');
  {
    const hp = await import(srcUrl('core/hubPermissions.js'));
    const hc = await import(srcUrl('core/deploy/hubCommands.js'));

    const need = (action) => hp.permissionForCommand('hub:manageDeploy', { action });
    check('listing apps is monitoring: no permission, like the process list',
      need('list') === null && need('detail') === null && need('github') === null);
    check('each action has its own permission',
      need('deploy') === 'deploy.run' && need('rollback') === 'deploy.rollback' && need('run') === 'deploy.logs'
      && need('create') === 'deploy.manage' && need('update') === 'deploy.manage' && need('delete') === 'deploy.manage'
      && need('issueToken') === 'deploy.manage' && need('getEnv') === 'deploy.env' && need('setEnv') === 'deploy.env');
    check('an unknown action, or a prototype key, is not a command',
      need('nope') === undefined && need('constructor') === undefined && need(undefined) === undefined);
    check('the CI relay needs deploy.ci', hp.permissionForCommand('hub:deployHook', {}) === 'deploy.ci');
    check('every deploy permission is in the tree and off by default',
      ['deploy.run', 'deploy.rollback', 'deploy.logs', 'deploy.manage', 'deploy.env', 'deploy.ci']
        .every((id) => hp.ALL_PERMISSION_IDS.includes(id) && hp.defaultPermissions()[id] === false));
    check('with nothing granted, a deployment from the Hub is refused',
      hp.checkCommandAllowed('hub:manageDeploy', { action: 'deploy' }, hp.defaultPermissions()).allowed === false
      && hp.checkCommandAllowed('hub:manageDeploy', { action: 'list' }, hp.defaultPermissions()).allowed === true);
    check('granting deploy.run does not grant reading the environment',
      hp.checkCommandAllowed('hub:manageDeploy', { action: 'getEnv' }, { ...hp.defaultPermissions(), 'deploy.run': true, 'deploy.manage': true }).allowed === false);

    dbSet('deployApps', []);
    const created = await hc.handleHubDeployCommand({
      action: 'create',
      app: { id: 'from-hub', repoUrl: 'https://github.com/me/from-hub.git', env: { SNEAKED: 'in' }, settings: { port: 3100 } },
    });
    check('an app can be created from the Hub', created.id === 'from-hub' && apps.getApp('from-hub')?.settings.port === 3100);
    check('create ignores env: environment values have their own permission',
      Object.keys(apps.getApp('from-hub').env).length === 0);

    await hc.handleHubDeployCommand({ action: 'setEnv', id: 'from-hub', env: { API_KEY: 'k-123', MODE: 'prod' } });
    const listed = await hc.handleHubDeployCommand({ action: 'list' });
    const mine = listed.apps.find((a) => a.id === 'from-hub');
    check('the list the Hub receives has variable names, never values',
      mine.envKeys.join() === 'API_KEY,MODE' && mine.env === undefined && !JSON.stringify(listed).includes('k-123'));
    check('getEnv returns the values, for the one who holds that permission',
      (await hc.handleHubDeployCommand({ action: 'getEnv', id: 'from-hub' })).env.API_KEY === 'k-123');

    await hc.handleHubDeployCommand({ action: 'update', id: 'from-hub', app: { branch: 'release', env: { API_KEY: 'changed' } } });
    check('update changes settings but cannot touch env',
      apps.getApp('from-hub').branch === 'release' && apps.getApp('from-hub').env.API_KEY === 'k-123');

    const refused = async (payload) => { try { await hc.handleHubDeployCommand(payload); return null; } catch (e) { return e.message; } };
    check('invalid input is refused with the reason', /URL/.test(await refused({ action: 'create', app: { id: 'bad', repoUrl: 'nope' } }) ?? ''));
    check('an unknown app is refused', /No app named/.test(await refused({ action: 'deploy', id: 'ghost' })));
    check('an unknown action is refused', /Unknown deployment action/.test(await refused({ action: 'explode' })));
    check('a malformed release id is refused', /Invalid release id/.test(await refused({ action: 'rollback', id: 'from-hub', releaseId: '../x' })));

    const issued = await hc.handleHubDeployCommand({ action: 'issueToken', id: 'from-hub' });
    check('a deploy token can be issued through the Hub', apps.verifyHookToken(apps.getApp('from-hub'), issued.token));

    // The through-the-Hub URL in the GitHub setup.
    dbSet('hubLink', null);
    const unpaired = await hc.handleHubDeployCommand({ action: 'github', id: 'from-hub' });
    const hubTarget = (s) => s.targets.find((x) => x.id === 'hub');
    check('an unpaired server offers no Hub URL', hubTarget(unpaired).url === null && hubTarget(unpaired).ready === false);
    check('the direct hook is still listed', unpaired.targets.find((x) => x.id === 'hook') !== undefined);

    const u = github.hubHookUrl;
    check('a paired server gets a Hub URL carrying its server id',
      u('web', { origin: 'https://hub.example.com', serverId: 'srv-1' }, true).url === 'https://hub.example.com/api/v1/hooks/deploy/srv-1/web'
      && u('web', { origin: 'https://hub.example.com', serverId: 'srv-1' }, true).secure === true);
    check('without deploy.ci the URL is shown but the note says what to enable',
      /Deploy from CI through the Hub/.test(u('web', { origin: 'https://hub.example.com', serverId: 'srv-1' }, false).note));
    check('a Hub reached over plain HTTP is marked not secure',
      u('web', { origin: 'http://10.0.0.5:4000', serverId: 'srv-1' }, true).secure === false);

    // The CI relay: the SERVER verifies the token the Hub forwarded.
    const bad = await hc.handleHubDeployHook({ action: 'trigger', appId: 'from-hub', token: 'wrong' });
    const ghost = await hc.handleHubDeployHook({ action: 'trigger', appId: 'ghost', token: issued.token });
    const none = await hc.handleHubDeployHook({ action: 'trigger', appId: 'from-hub' });
    const evil = await hc.handleHubDeployHook({ action: 'trigger', appId: '../etc', token: issued.token });
    check('a wrong token, a missing token, an unknown app and a malformed id are all just "unauthorized"',
      [bad, ghost, none, evil].every((r) => r.unauthorized === true && Object.keys(r).length === 1));
    check('a token for one app does not open another',
      (await hc.handleHubDeployHook({ action: 'status', appId: 'ci', token: issued.token, runId: store.newReleaseId() })).unauthorized === true);

    const runId = store.newReleaseId();
    store.writeRun({ id: runId, appId: 'from-hub', status: 'success', step: 'done', sha: 'abc', error: null, startedAt: 1, finishedAt: 2 });
    const status = await hc.handleHubDeployHook({ action: 'status', appId: 'from-hub', token: issued.token, runId });
    check('with the right token a run status is returned, without its log',
      status.found === true && status.run.status === 'success' && status.run.runId === runId && status.run.log === undefined);
    check('an unknown run is "not found", not an error',
      (await hc.handleHubDeployHook({ action: 'status', appId: 'from-hub', token: issued.token, runId: store.newReleaseId() })).found === false);

    // A real deployment through each path.
    const pm2b = makeFakePm2();
    const hubRepo = makeRepo('hub');
    const hubPort = await freePort();
    commit(hubRepo, { 'server.js': SERVER_JS, VERSION: 'hub-v1', 'ez.json': JSON.stringify({ start: 'node server.js', port: hubPort }) }, 'v1');
    dbSet('deployApps', apps.listApps().map((a) => (a.id === 'from-hub' ? { ...a, repoUrl: hubRepo, branch: 'main', settings: {} } : a)));

    // The engine's collaborators are injected through the module the commands call.
    const engineDeps = { runner: pm2b, sleep: (ms) => sleep(Math.min(ms, 120)), sendNotification: async () => ({ ok: true }) };
    try {
      const viaCi = engine.startDeployment('from-hub', { trigger: 'webhook', actor: 'deploy hook (via Hub)', deps: engineDeps });
      const ciRun = await viaCi.done;
      check('a deployment triggered as CI-through-the-Hub runs to success',
        ciRun.status === 'success' && (await httpRequest({ port: hubPort })).text === 'hub-v1', ciRun.error ?? '');

      const detail = await hc.handleHubDeployCommand({ action: 'detail', id: 'from-hub' });
      check('the detail the Hub receives lists runs and releases, with no secrets',
        detail.runs.length >= 1 && detail.releases.some((r) => r.current) && detail.env === undefined
        && !JSON.stringify(detail).includes('k-123'));

      const log = await hc.handleHubDeployCommand({ action: 'run', id: 'from-hub', runId: ciRun.id });
      check('a run\'s log can be read through the Hub', /Deployment succeeded/.test(log.log) && log.status === 'success');

      const busy = store.acquireLock('from-hub', { runId: store.newReleaseId() });
      const blocked = await hc.handleHubDeployHook({ action: 'trigger', appId: 'from-hub', token: issued.token });
      check('the relay reports "already deploying" as a 409 with the running run',
        blocked.started === false && blocked.status === 409 && typeof blocked.runId === 'string');
      check('and a Hub user is told the same', /already running/.test(await refused({ action: 'deploy', id: 'from-hub' })));
      busy.release();
    } finally {
      await pm2b.stopAll();
    }

    await hc.handleHubDeployCommand({ action: 'delete', id: 'from-hub' });
    check('an app can be deleted from the Hub', apps.getApp('from-hub') === null);
  }

  // ── 9. Automatic GitHub setup ───────────────────────────────────────────────
  setGroup('9. Automatic GitHub setup');
  {
    const gh = await import(srcUrl('core/deploy/githubApi.js'));
    const require = (await import('module')).createRequire(import.meta.url);
    const nacl = require('tweetnacl');

    const pr = gh.parseGithubRepo;
    check('owner and repository are read from every URL form',
      pr('https://github.com/acme/web.git')?.repo === 'web' && pr('https://github.com/acme/web')?.owner === 'acme'
      && pr('git@github.com:acme/my.repo.git')?.repo === 'my.repo' && pr('ssh://git@github.com/acme/web.git')?.repo === 'web');
    check('other hosts are not GitHub', pr('https://gitlab.com/acme/web.git') === null && pr('https://github.com.evil.io/a/b') === null);

    // The sealed box, opened with the private key the way GitHub would.
    const keys = nacl.box.keyPair();
    const publicB64 = Buffer.from(keys.publicKey).toString('base64');
    const sealed = gh.sealSecret('ezd_secret-value ✓', publicB64);
    check('a sealed secret opens with the repository\'s private key',
      gh.openSealedSecret(sealed, keys.publicKey, keys.secretKey) === 'ezd_secret-value ✓');
    check('it does not open with another key',
      gh.openSealedSecret(sealed, keys.publicKey, nacl.box.keyPair().secretKey) === null);
    check('sealing the same value twice gives different ciphertext', gh.sealSecret('x', publicB64) !== gh.sealSecret('x', publicB64));
    check('the ciphertext has the sealed-box length (32-byte key + 16-byte tag + message)',
      Buffer.from(gh.sealSecret('12345', publicB64), 'base64').length === 32 + 16 + 5);
    check('a public key of the wrong length is refused', (() => { try { gh.sealSecret('x', 'AAAA'); return false; } catch { return true; } })());

    /** A stand-in for api.github.com that records every request. */
    const fakeGithub = (overrides = {}) => {
      const calls = [];
      const state = { secrets: {}, file: null, keys: [], ...overrides.state };
      const fetchImpl = async (url, init) => {
        const pathname = url.replace('https://api.github.com', '');
        const method = init.method;
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ method, pathname, body, auth: init.headers.Authorization });

        const answer = (status, json) => ({ status, json: async () => { if (json === undefined) throw new Error('no body'); return json; } });
        const forced = overrides.respond?.(method, pathname, body);
        if (forced) return answer(forced.status, forced.json);

        if (method === 'GET' && pathname === '/repos/acme/web') return answer(200, { full_name: 'acme/web' });
        if (method === 'GET' && pathname.endsWith('/actions/secrets/public-key')) return answer(200, { key_id: 'kid-1', key: publicB64 });
        if (method === 'PUT' && pathname.includes('/actions/secrets/')) { state.secrets[pathname.split('/').pop()] = body; return answer(201); }
        if (method === 'GET' && pathname.includes('/contents/')) return state.file ? answer(200, state.file) : answer(404, { message: 'Not Found' });
        if (method === 'PUT' && pathname.includes('/contents/')) { state.file = { content: body.content, sha: 'new-sha' }; state.commit = body; return answer(201, {}); }
        if (method === 'GET' && pathname.startsWith('/repos/acme/web/keys')) return answer(200, state.keys);
        if (method === 'POST' && pathname === '/repos/acme/web/keys') { state.keys.push({ key: body.key.split(' ').slice(0, 2).join(' ') }); state.addedKey = body; return answer(201, {}); }
        return answer(404, { message: 'Not Found' });
      };
      return { calls, state, fetchImpl };
    };

    const input = (fake, extra = {}) => ({
      repoUrl: 'git@github.com:acme/web.git',
      branch: 'main',
      token: 'github_pat_abcdefghij1234567890',
      secrets: { EZ_DEPLOY_URL: 'https://example.com/.ez-deploy/web', EZ_DEPLOY_TOKEN: 'ezd_token-value' },
      workflow: { path: '.github/workflows/ez-deploy-web.yml', content: 'name: Deploy web\n' },
      deployKey: { title: 'Easy DevOps — web', key: 'ssh-rsa AAAAB3Nza easy-devops-deploy-web' },
      fetchImpl: fake.fetchImpl,
      ...extra,
    });

    {
      const fake = fakeGithub();
      const result = await gh.applyGithubSetup(input(fake));
      check('all three parts are applied', result.ok && result.repo === 'acme/web' && result.steps.map((s) => s.id).join() === 'secrets,workflow,deployKey'
        && result.steps.every((s) => s.ok), JSON.stringify(result.steps));
      check('both secrets are stored encrypted, never in clear',
        fake.state.secrets.EZ_DEPLOY_TOKEN.key_id === 'kid-1'
        && gh.openSealedSecret(fake.state.secrets.EZ_DEPLOY_TOKEN.encrypted_value, keys.publicKey, keys.secretKey) === 'ezd_token-value'
        && gh.openSealedSecret(fake.state.secrets.EZ_DEPLOY_URL.encrypted_value, keys.publicKey, keys.secretKey) === 'https://example.com/.ez-deploy/web'
        && !JSON.stringify(fake.calls.map((c) => c.body)).includes('ezd_token-value'));
      check('the workflow is committed to the app\'s branch',
        fake.state.commit.branch === 'main' && Buffer.from(fake.state.commit.content, 'base64').toString() === 'name: Deploy web\n' && fake.state.commit.sha === undefined);
      check('the deploy key is added read-only', fake.state.addedKey.read_only === true && fake.state.addedKey.title === 'Easy DevOps — web');
      check('every request carries the token as a bearer header, to api.github.com only',
        fake.calls.every((c) => c.auth === 'Bearer github_pat_abcdefghij1234567890'));

      // A second run changes nothing that is already right.
      const before = fake.calls.length;
      const again = await gh.applyGithubSetup(input(fake));
      const writes = fake.calls.slice(before).filter((c) => c.method !== 'GET');
      check('running it again does not re-commit the workflow or re-add the key',
        again.ok && writes.every((c) => c.pathname.includes('/actions/secrets/')) && /already/.test(again.steps[1].detail) && /already/.test(again.steps[2].detail));
    }

    {
      const fake = fakeGithub({ state: { file: { content: Buffer.from('old').toString('base64'), sha: 'old-sha' } } });
      await gh.applyGithubSetup(input(fake, { secrets: null, deployKey: null }));
      check('an existing workflow is updated in place, with its sha', fake.state.commit.sha === 'old-sha' && /Update/.test(fake.state.commit.message));
    }

    {
      const fake = fakeGithub({ respond: (m, p) => (m === 'PUT' && p.includes('/contents/') ? { status: 403, json: { message: 'Resource not accessible by personal access token' } } : null) });
      const result = await gh.applyGithubSetup(input(fake));
      check('one part failing does not stop the others, and the answer says what the token lacks',
        result.ok === false && result.steps[0].ok && !result.steps[1].ok && result.steps[2].ok && /Workflows/.test(result.steps[1].detail), result.steps[1].detail);
    }

    {
      const fake = fakeGithub({ respond: (m, p) => (p === '/repos/acme/web' ? { status: 404, json: { message: 'Not Found' } } : null) });
      const result = await gh.applyGithubSetup(input(fake));
      check('a token that cannot see the repository stops before anything is written',
        result.ok === false && result.steps.length === 0 && /access/.test(result.error) && fake.calls.length === 1);
    }

    {
      const fake = fakeGithub({ respond: () => ({ status: 401, json: { message: 'Bad credentials' } }) });
      check('a rejected token is reported as such', /rejected the token/.test((await gh.applyGithubSetup(input(fake))).error));
    }

    {
      const fake = fakeGithub();
      const offline = await gh.applyGithubSetup(input(fake, { fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }));
      check('GitHub being unreachable is an error, not a crash', offline.ok === false && /Could not reach GitHub/.test(offline.error));

      const other = await gh.applyGithubSetup(input(fake, { repoUrl: 'https://gitlab.com/acme/web.git' }));
      check('a repository that is not on github.com is declined without any request',
        other.ok === false && /github\.com/.test(other.error) && fake.calls.length === 0);

      const noToken = await gh.applyGithubSetup(input(fake, { token: 'has spaces and "quotes"' }));
      check('a token that is not token-shaped never reaches a header', noToken.ok === false && fake.calls.length === 0);
    }
  }

  // ── 10. The deployments folder, moving an app, and linked domains ───────────
  setGroup('10. Folders, moving and domains');
  {
    const link = await import(srcUrl('core/deploy/domainLink.js'));
    const { saveDomains, findDomain, createDomain } = await import(srcUrl('core/domains-db.js'));

    const v = store.validateDeployDir;
    const abs = process.platform === 'win32' ? 'D:\\apps\\ez_deploys' : '/srv/ez_deploys';
    check('an absolute folder is accepted, spaces included', v(abs) === null && v(`${abs} two`) === null);
    check('a relative path, the root, and shell characters are refused',
      [
        'relative/path', '', '   ', path.parse(process.cwd()).root, `${abs}"; rm -rf /`, `${abs}$(x)`, `${abs}\`id\``,
        `${abs};x`, `${abs}|x`, `${abs}&x`, `${abs}\nx`, `${abs}'x`,
      ].every((p) => v(p) !== null));

    dbSet('deployApps', []);
    saveConfig({ ...loadConfig(), deployDir: null });
    check('by default new apps go under <data dir>/ez_deploys',
      store.deployRoot() === path.join(TEST_DATA_DIR, 'ez_deploys'));

    const first = apps.createApp({ id: 'one', repoUrl: 'https://github.com/me/one.git' });
    check('an app records the folder it was created in',
      first.ok && first.app.dir === path.join(TEST_DATA_DIR, 'ez_deploys', 'one') && fs.existsSync(path.join(first.app.dir, 'releases')));

    const custom = scratch('custom-root');
    saveConfig({ ...loadConfig(), deployDir: custom });
    const second = apps.createApp({ id: 'two', repoUrl: 'https://github.com/me/two.git' });
    check('after the setting changes, NEW apps are created in the new folder',
      second.app.dir === path.join(custom, 'two') && store.appPaths('two').root === path.join(custom, 'two'));
    check('and existing apps stay exactly where they were',
      store.appPaths('one').root === path.join(TEST_DATA_DIR, 'ez_deploys', 'one'));
    check('the dashboard view shows each app\'s own folder', apps.dashboardApp(apps.getApp('one')).dir === store.appPaths('one').root);

    saveConfig({ ...loadConfig(), deployDir: 'not/absolute' });
    check('an unusable stored setting falls back to the default rather than breaking deployments',
      store.deployRoot() === path.join(TEST_DATA_DIR, 'ez_deploys'));
    saveConfig({ ...loadConfig(), deployDir: null });

    // An app from before the setting existed: no `dir`, files under <data dir>/deploy/<id>.
    const legacyDir = path.join(TEST_DATA_DIR, 'deploy', 'old-app');
    fs.mkdirSync(path.join(legacyDir, 'releases'), { recursive: true });
    const now = new Date().toISOString();
    dbSet('deployApps', [...apps.listApps(), {
      id: 'old-app', repoUrl: 'https://github.com/me/old.git', branch: 'main', auth: { type: 'none' }, settings: {}, env: {},
      hook: {}, createdAt: now, updatedAt: now,
    }]);
    check('an app created before the setting existed is still found in its old folder',
      store.appPaths('old-app').root === legacyDir);

    // ── Moving, with a real deployment running through it.
    const pm2c = makeFakePm2();
    const moveRepo = makeRepo('mover');
    const movePort = await freePort();
    commit(moveRepo, { 'server.js': SERVER_JS, VERSION: 'moved-v1', 'ez.json': JSON.stringify({ start: 'node server.js', port: movePort }) }, 'v1');
    apps.createApp({ id: 'mover', repoUrl: 'https://github.com/me/mover.git' });
    dbSet('deployApps', apps.listApps().map((a) => (a.id === 'mover' ? { ...a, repoUrl: moveRepo } : a)));
    const moveDeps = { runner: pm2c, sleep: (ms) => sleep(Math.min(ms, 120)), sendNotification: async () => ({ ok: true }) };

    try {
      const deployed = await engine.startDeployment('mover', { deps: moveDeps }).done;
      const from = store.appPaths('mover').root;
      check('deployed in its original folder', deployed.status === 'success' && (await httpRequest({ port: movePort })).text === 'moved-v1', deployed.error ?? '');

      const target = scratch('new-home');
      check('a relative destination is refused', (await engine.moveApp('mover', 'somewhere', { deps: moveDeps })).status === 400);
      check('a destination inside the app\'s own folder is refused',
        (await engine.moveApp('mover', path.join(from, 'releases'), { deps: moveDeps })).status === 400);

      fs.mkdirSync(path.join(target, 'mover'), { recursive: true });
      fs.writeFileSync(path.join(target, 'mover', 'someone-elses-file'), 'x');
      check('a destination that already has files in it is refused, and nothing moves',
        (await engine.moveApp('mover', target, { deps: moveDeps })).status === 409 && fs.existsSync(from)
        && (await httpRequest({ port: movePort })).text === 'moved-v1');
      fs.rmSync(path.join(target, 'mover', 'someone-elses-file'));

      const startsBefore = pm2c.calls.length;
      const moved = await engine.moveApp('mover', target, { deps: moveDeps });
      const to = path.join(target, 'mover');
      check('the app is moved to <destination>/<id>', moved.ok && moved.to === to && moved.from === from, moved.error ?? '');
      check('the old folder is gone and the new one has everything',
        !fs.existsSync(from) && fs.existsSync(path.join(to, 'releases', deployed.releaseId, 'server.js'))
        && fs.existsSync(path.join(to, 'logs')) && fs.existsSync(path.join(to, 'state.json')));
      check('the new location is recorded on the app', apps.getApp('mover').dir === to && store.appPaths('mover').root === to);

      const sequence = pm2c.calls.slice(startsBefore).map((c) => c[0]);
      check('PM2 was stopped before the move and started after it', sequence.indexOf('delete') !== -1
        && sequence.indexOf('delete') < sequence.indexOf('start'), sequence.join(','));
      check('the process runs from the new folder',
        pm2c.procs.get('ez-mover')?.config.cwd === path.join(to, 'releases', deployed.releaseId) && moved.restarted === true);
      // moveApp() returns once PM2 has started the process; give it a moment to listen.
      let answered = '';
      for (let i = 0; i < 40 && answered !== 'moved-v1'; i++) { answered = (await httpRequest({ port: movePort })).text; if (answered !== 'moved-v1') await sleep(100); }
      check('and the app answers again', answered === 'moved-v1');
      check('no lock is left behind in either place', store.lockHolder('mover') === null && !fs.existsSync(path.join(to, 'deploy.lock')));
      check('the run history came along', store.listRuns('mover').some((r) => r.id === deployed.id));

      commit(moveRepo, { VERSION: 'moved-v2' }, 'v2');
      const after = await engine.startDeployment('mover', { deps: moveDeps }).done;
      check('the next deployment builds in the new folder',
        after.status === 'success' && fs.existsSync(path.join(to, 'releases', after.releaseId)) && (await httpRequest({ port: movePort })).text === 'moved-v2');
      check('a rollback after a move still works',
        (await engine.startRollback('mover', { deps: moveDeps }).done).status === 'success' && (await httpRequest({ port: movePort })).text === 'moved-v1');

      check('moving to where it already is, is refused', (await engine.moveApp('mover', target, { deps: moveDeps })).status === 409);
      check('moving an unknown app is a 404', (await engine.moveApp('ghost', target, { deps: moveDeps })).status === 404);

      // An app that is not running is moved without being started.
      await pm2c.del('ez-mover');
      const quiet = await engine.moveApp('mover', scratch('third-home'), { deps: moveDeps });
      check('an app that was not running is moved and left stopped',
        quiet.ok && quiet.restarted === false && !pm2c.procs.has('ez-mover') && quiet.warning === null);

      // ── Linked domains. nginx is not here, so the domain writer is injected.
      const domainCalls = [];
      const domainDeps = {
        domainCommand: async (payload) => {
          domainCalls.push(payload);
          if (payload.action === 'create') saveDomains([...(await import(srcUrl('core/domains-db.js'))).getDomains(), createDomain({ name: payload.domain.name, port: payload.domain.port })]);
          if (payload.action === 'update') {
            const all = (await import(srcUrl('core/domains-db.js'))).getDomains();
            saveDomains(all.map((d) => (d.name === payload.name ? { ...d, ...payload.domain, ssl: { ...d.ssl, ...(payload.domain.ssl ?? {}) } } : d)));
          }
          if (payload.action === 'delete') saveDomains((await import(srcUrl('core/domains-db.js'))).getDomains().filter((d) => d.name !== payload.name));
          return { ok: true };
        },
        reload: async () => ({ ok: true, output: '' }),
      };
      saveDomains([]);

      check('the app\'s port comes from its live release when none is set on it', link.appPort(apps.getApp('mover')) === movePort);
      check('an app with no port anywhere cannot be linked',
        (await link.linkDomain('one', { domain: 'one.example.com' }, domainDeps)).status === 409);
      check('an invalid domain name is refused',
        (await link.linkDomain('mover', { domain: 'not a domain' }, domainDeps)).status === 400 && domainCalls.length === 0);

      const linked = await link.linkDomain('mover', { domain: 'App.Example.com' }, domainDeps);
      check('linking an unknown domain creates it, pointed at the app\'s port',
        linked.ok && linked.created === true && linked.domain === 'app.example.com' && linked.port === movePort
        && findDomain('app.example.com')?.port === movePort && linked.nginxReloaded === true);
      check('the app remembers its domain', apps.getApp('mover').domain === 'app.example.com' && apps.dashboardApp(apps.getApp('mover')).domain === 'app.example.com');
      check('no certificate is requested unless asked for', linked.ssl === null);

      saveDomains([...(await import(srcUrl('core/domains-db.js'))).getDomains(), createDomain({ name: 'old.example.com', port: 9999 })]);
      const repointed = await link.linkDomain('mover', { domain: 'old.example.com' }, domainDeps);
      check('linking an existing domain re-points it instead of creating another',
        repointed.created === false && findDomain('old.example.com').port === movePort && domainCalls.at(-1).action === 'update');

      // A deployment that changes the port takes the domain with it.
      const before = domainCalls.length;
      check('a domain already on the right port is left alone',
        (await link.syncLinkedDomain(apps.getApp('mover'), movePort, domainDeps)) === null && domainCalls.length === before);
      const note = await link.syncLinkedDomain(apps.getApp('mover'), movePort + 1, domainDeps);
      check('when the app\'s port changes, the linked domain follows it',
        /now proxies to port/.test(note) && findDomain('old.example.com').port === movePort + 1);
      check('a failure to update the domain is a warning, not an exception',
        /^warning:/.test(await link.syncLinkedDomain(apps.getApp('mover'), movePort + 2, { ...domainDeps, domainCommand: async () => ({ ok: false, error: 'nginx -t failed' }) })));

      // With SSL requested: success switches the domain to HTTPS; failure keeps the link.
      const sslOk = await link.linkDomain('mover', { domain: 'secure.example.com', ssl: true }, {
        ...domainDeps,
        prepare: async () => ({ ok: true }),
        issue: async () => ({ success: true, certPath: '/c/fullchain.pem', keyPath: '/c/privkey.pem', mode: 'proxy' }),
      });
      saveConfig({ ...loadConfig(), acmeEmail: 'ops@example.com' });
      const sslOk2 = await link.linkDomain('mover', { domain: 'secure.example.com', ssl: true }, {
        ...domainDeps,
        prepare: async () => ({ ok: true }),
        issue: async () => ({ success: true, certPath: '/c/fullchain.pem', keyPath: '/c/privkey.pem', mode: 'proxy' }),
      });
      check('without an ACME email no certificate is requested, and the link still stands',
        sslOk.ok && sslOk.ssl.ok === false && /ACME email/.test(sslOk.ssl.detail));
      check('with one, the certificate is issued and the domain switched to HTTPS',
        sslOk2.ssl.ok === true && findDomain('secure.example.com').ssl.enabled === true && findDomain('secure.example.com').ssl.certPath === '/c/fullchain.pem');

      const sslFail = await link.linkDomain('mover', { domain: 'pending.example.com', ssl: true }, {
        ...domainDeps,
        prepare: async () => ({ ok: true }),
        issue: async () => ({ success: false, error: { cause: 'DNS problem: NXDOMAIN\nmore' } }),
      });
      check('a certificate that cannot be issued leaves a working HTTP link and says why',
        sslFail.ok && sslFail.ssl.ok === false && /NXDOMAIN/.test(sslFail.ssl.detail) && !/more/.test(sslFail.ssl.detail)
        && findDomain('pending.example.com').ssl.enabled === false && apps.getApp('mover').domain === 'pending.example.com');

      check('unlinking forgets the link and leaves the domain',
        link.unlinkDomain('mover').ok && apps.getApp('mover').domain === null && findDomain('pending.example.com') !== undefined);

      // Deleting an app, with and without its domain.
      await link.linkDomain('mover', { domain: 'app.example.com' }, domainDeps);
      const kept = await engine.removeApp('two', { deps: { ...moveDeps, deleteDomain: (app) => link.deleteLinkedDomain(app, domainDeps) } });
      check('deleting an app with no domain reports that none was deleted', kept.ok && kept.domainDeleted === false);

      const moverDir = store.appPaths('mover').root;
      const gone = await engine.removeApp('mover', {
        deleteDomain: true,
        deps: { ...moveDeps, deleteDomain: (app) => link.deleteLinkedDomain(app, domainDeps) },
      });
      check('deleting an app with "delete the domain too" removes both',
        gone.ok && gone.domainDeleted === true && findDomain('app.example.com') === undefined && apps.getApp('mover') === null);
      check('its files are deleted from wherever it had been moved to', !fs.existsSync(moverDir));
      check('other domains are untouched', findDomain('old.example.com') !== undefined);

      apps.createApp({ id: 'keeper', repoUrl: 'https://github.com/me/keeper.git', settings: { port: 4555 } });
      await link.linkDomain('keeper', { domain: 'keep.example.com' }, domainDeps);
      await engine.removeApp('keeper', { deps: { ...moveDeps, deleteDomain: (app) => link.deleteLinkedDomain(app, domainDeps) } });
      check('by default deleting an app leaves its domain in place', findDomain('keep.example.com') !== undefined);

      apps.createApp({ id: 'stuck', repoUrl: 'https://github.com/me/stuck.git', settings: { port: 4556 } });
      await link.linkDomain('stuck', { domain: 'stuck.example.com' }, domainDeps);
      const half = await engine.removeApp('stuck', {
        deleteDomain: true,
        deps: { ...moveDeps, deleteDomain: async () => ({ ok: false, error: 'permission denied' }) },
      });
      check('if the domain cannot be removed the app is still deleted, with a warning',
        half.ok && half.domainDeleted === false && /permission denied/.test(half.warning) && apps.getApp('stuck') === null);
    } finally {
      await pm2c.stopAll();
      saveDomains([]);
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
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
