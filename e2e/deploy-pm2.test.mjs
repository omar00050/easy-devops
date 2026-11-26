/**
 * PM2 access on a Windows Server, at the deploy and create-app boundaries.
 *
 * Run with:  node e2e/run.mjs deploy-pm2
 *
 * What this holds to the contract:
 *
 *   1. A deployment started by a process that may not use PM2 (the Windows
 *      service) or on a machine without PM2 is REFUSED before the lock, the
 *      run record, a release folder or any step exist. Before 1.4.9 it took
 *      the lock and failed at the `start` step, leaving a failed run and a
 *      half-built release for a reason the Hub could not show.
 *   2. Creating the first app answers with the PM2 state, and, when PM2 is
 *      missing, the one command and the endpoint that installs it. Creating an
 *      app never fails because PM2 is missing.
 *   3. `POST /api/pm2/install` exists, sits behind the session gate, refuses a
 *      service account (403), an install already running (409) and an existing
 *      install (409), and reports a failed `npm i -g pm2` with the command.
 *      The body is ignored, no sudo and no PM2_HOME is used, and the version
 *      is read from npm's own output rather than by running pm2.
 *   4. The two rename sites in the deploy engine ride out a momentary Windows
 *      sharing denial, and the EXDEV path still copies.
 *
 * Everything is stubbed: PM2 is e2e/fixtures/fake-pm2, npm is a stub, git is a
 * map of files, the health probe always answers, and the clock is injected.
 * No real PM2 daemon, npm, process, port or data directory is touched. The one
 * deliberate exception is `fs.renameSync`, patched for a single move and
 * restored immediately.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import express from 'express';
import { createFakePm2, FAKE_PM2_PATH } from './fixtures/fake-pm2/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed: Boolean(passed), detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const ok = (stdout = '') => ({ success: true, stdout, stderr: '', exitCode: 0, truncated: { stdout: 0, stderr: 0 } });

// ─── The contract's exact texts ──────────────────────────────────────────────

const UNKNOWN_MESSAGE = 'PM2 runs under the account that started it; the Easy DevOps service (NT SERVICE\\EasyDevOps) cannot see it.';
const UNKNOWN_FIX = 'Run ezz service repair in an Administrator PowerShell, signed in as the user who runs PM2, so the Hub can name that user. Manage the apps on the server meanwhile.';

/** A runner module that refuses like a service account, and records everything. */
function serviceAccountRunner() {
  const calls = [];
  const refuse = () => ({
    ok: false,
    reason: 'service_account',
    user: null,
    message: UNKNOWN_MESSAGE,
    fix: UNKNOWN_FIX,
  });
  return {
    calls,
    pm2Access: () => refuse(),
    detect: async () => { calls.push('detect'); return { installed: false, version: null, path: null, error: UNKNOWN_MESSAGE }; },
    list: async () => { calls.push('list'); return { ok: false, apps: [], error: UNKNOWN_MESSAGE }; },
    startConfig: async () => { calls.push('startConfig'); return { ok: false, output: UNKNOWN_MESSAGE }; },
    save: async () => { calls.push('save'); return { ok: false, output: UNKNOWN_MESSAGE }; },
  };
}

// ─── A normal deployment, with the fake PM2 ──────────────────────────────────

/** Git, replaced by "create the release directory from these files". */
function makeGitStub() {
  const calls = [];
  let files = {};
  const sha = 'a'.repeat(40);

  const run = async (command, args) => {
    if (Array.isArray(args)) command = [command, ...args].join(' ');
    calls.push(command);

    if (command === 'git --version') return ok('git version 2.43.0');

    const init = /^git init -q (.+)$/.exec(command);
    if (init) {
      const dir = init[1];
      fs.mkdirSync(dir, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      return ok('');
    }

    if (/rev-parse HEAD/.test(command)) return ok(`${sha}\n`);
    return ok('');
  };

  return { run, calls, setFiles(next) { files = next; } };
}

function makeCommandStub() {
  const calls = [];
  return {
    calls,
    runCommandLine: async (command, opts = {}) => {
      calls.push({ command, cwd: opts.cwd });
      opts.onData?.(`ran: ${command}\n`);
      return ok('');
    },
  };
}

/**
 * One `run` for the engine: PM2 commands go to the fake, everything else to
 * the git stub. This is what lets the REAL runner module be exercised against
 * the fake, so the deploy path itself is unchanged.
 */
function makeRoutedRun(git, fake) {
  return async (command, opts) => {
    const cmd = String(command ?? '');
    if (/^(where\.exe pm2|command -v pm2)$/i.test(cmd.trim())) return fake.run(cmd, opts);
    // Windows writes `& "<path>" <verb>` (PowerShell's call operator), so the
    // fake's path is not at the start of the string there.
    if (cmd.includes(FAKE_PM2_PATH)) return fake.run(cmd, opts);
    return git.run(cmd, opts);
  };
}

/**
 * The real runner module with the machine's identity and daemon check pinned,
 * so it talks only to the fake PM2 and never reads the real PM2_HOME.
 */
function pinnedRunner(realRunner, fake) {
  const deps = { isWindows: false, serverMode: false, account: { user: 'tester', home: '/home/tester', serviceAccount: false } };
  return {
    pm2Access: () => realRunner.pm2Access({ deps }),
    detect: (opts = {}) => realRunner.detect({ ...opts, deps }),
    list: (opts = {}) => realRunner.list({ ...opts, deps }),
    statusAll: (name, opts = {}) => realRunner.statusAll(name, { ...opts, deps, isRunning: () => true }),
    startConfig: (file, opts = {}) => realRunner.startConfig(file, { ...opts, deps }),
    reloadConfig: (file, opts = {}) => realRunner.reloadConfig(file, { ...opts, deps }),
    del: (name, opts = {}) => realRunner.del(name, { ...opts, deps }),
    logs: (name, opts = {}) => realRunner.logs(name, { ...opts, deps }),
    save: (opts = {}) => realRunner.save({ ...opts, deps }),
  };
}

function deployDeps(git, commands, runner) {
  return {
    run: git.routed ?? git.run,
    runFile: git.run,
    runCommandLine: commands.runCommandLine,
    runner,
    probe: async () => ({ ok: true, status: 200, error: null }),
    sleep: async () => {},
    now: () => Date.now(),
    sendNotification: async () => ({ ok: true }),
    syncDomain: async () => null,
  };
}

// ─── A request/response pair for a controller, without a listener ────────────

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

/** Calls an Express handler and returns its response. */
async function callHandler(handler, req) {
  const res = fakeResponse();
  let nextError = null;
  await handler(req, res, (err) => { nextError = err; });
  if (nextError) throw nextError;
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function httpJson(port, { method = 'GET', pathname = '/', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      timeout: 5000,
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── 1. Preflight: the service account refuses before anything exists ────────

async function testServiceAccountPreflight(engine, apps, store) {
  setGroup('1. a service account is refused before the lock, run or release folder');

  const id = 'preflight-service';
  const created = apps.createApp({ id, repoUrl: `https://github.com/me/${id}.git` });
  if (!created.ok) throw new Error(`could not register ${id}: ${created.errors.join('; ')}`);

  const paths = store.appPaths(id);
  const runner = serviceAccountRunner();

  const started = engine.startDeployment(id, { deps: { runner } });

  check('the refusal is a refusal, not a started deployment',
    started.ok === false && started.status === 403, `ok=${started.ok} status=${started.status}`);
  check('with reason service_account', started.reason === 'service_account', started.reason);
  check('the exact access message is carried', started.message === UNKNOWN_MESSAGE, started.message);
  check('the exact fix is carried', started.fix === UNKNOWN_FIX, started.fix);
  check('and the error the Hub shows is the message plus the fix',
    started.error === `${UNKNOWN_MESSAGE} ${UNKNOWN_FIX}`, started.error);

  check('no run record was created', store.listRuns(id).length === 0, String(store.listRuns(id).length));
  check('no deploy lock file exists', !fs.existsSync(paths.lock), paths.lock);
  check('the lock was never held', store.lockHolder(id) === null);
  check('no release folder was created',
    store.listReleases(id).length === 0
    && !fs.existsSync(path.join(paths.releases, '20260101-000000-000000')),
    store.listReleases(id).join(','));
  check('the release list is empty', fs.readdirSync(paths.releases).length === 0);
  check('no run log was written', fs.readdirSync(paths.logs).length === 0);
  check('nothing was handed to PM2', runner.calls.length === 0, runner.calls.join(' | '));

  // The Hub is where the owner saw a mid-deploy failure with no explanation.
  // Its deploy command must refuse with the preflight's message and fix.
  const hubCommands = await import(srcUrl('core/deploy/hubCommands.js'));
  const refusal = {
    ok: false,
    status: 403,
    reason: 'service_account',
    message: UNKNOWN_MESSAGE,
    fix: UNKNOWN_FIX,
    error: `${UNKNOWN_MESSAGE} ${UNKNOWN_FIX}`,
  };
  let hubError = null;
  let hubResult = null;
  try {
    hubResult = await hubCommands.handleHubDeployCommand(
      { action: 'deploy', id },
      { deployFn: () => refusal },
    );
  } catch (err) {
    hubError = err;
  }
  check('the Hub deploy command refuses instead of starting a run', hubResult === null, JSON.stringify(hubResult));
  check('and the Hub reads the exact message and fix',
    hubError?.message === `${UNKNOWN_MESSAGE} ${UNKNOWN_FIX}`, hubError?.message);
}

// ─── 2. Preflight: PM2 missing ───────────────────────────────────────────────

async function testMissingPm2Preflight(engine, apps, store, realRunner) {
  setGroup('2. PM2 missing is refused before the lock, run or release folder');

  const id = 'preflight-missing';
  const created = apps.createApp({ id, repoUrl: `https://github.com/me/${id}.git` });
  if (!created.ok) throw new Error(`could not register ${id}: ${created.errors.join('; ')}`);

  const paths = store.appPaths(id);

  const started = engine.startDeployment(id, { deps: { runner: realRunner, pm2Installed: () => false } });

  check('the refusal names the reason', started.ok === false && started.reason === 'not_installed',
    `ok=${started.ok} reason=${started.reason}`);
  check('it is a precondition, not a server error', started.status === 409, String(started.status));
  check('the message is the contract one', started.message === 'PM2 is not installed.', started.message);
  check('the fix is the one command', started.fix === 'npm i -g pm2', started.fix);
  check('the error the person reads includes the reason and the command',
    /PM2 is not installed/.test(started.error) && /npm i -g pm2/.test(started.error), started.error);

  check('no run record was created', store.listRuns(id).length === 0);
  check('no deploy lock file exists', !fs.existsSync(paths.lock), paths.lock);
  check('no release folder was created', store.listReleases(id).length === 0);
  check('no run log was written', fs.readdirSync(paths.logs).length === 0);
}

// ─── 3. The normal deploy path, with the fake PM2 ──────────────────────────

async function testNormalDeploy(engine, apps, store, realRunner) {
  setGroup('3. a normal deployment still runs, against the fake PM2');

  const id = 'normal-deploy';
  const created = apps.createApp({ id, repoUrl: `https://github.com/me/${id}.git` });
  if (!created.ok) throw new Error(`could not register ${id}: ${created.errors.join('; ')}`);

  const fake = createFakePm2({ stateFile: path.join(scratch('pm2-state'), 'apps.json'), apps: [] });
  const git = makeGitStub();
  git.setFiles({
    'ez.json': JSON.stringify({ install: 'npm install', start: 'node server.js', port: 3000, health: { path: '/healthz', timeout: 4 } }),
    'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'node server.js' } }),
    'server.js': '// the real app is never started\n',
  });
  const commands = makeCommandStub();
  const deps = deployDeps(git, commands, pinnedRunner(realRunner, fake));
  deps.run = makeRoutedRun(git, fake);

  const started = engine.startDeployment(id, { deps });
  check('the preflight lets a real deployment start', started.ok === true, started.error ?? '');
  const run = started.ok ? await started.done : { status: 'failed', error: started.error };

  check('the deployment succeeds', run.status === 'success', `${run.status}: ${run.error ?? ''}`);
  check('one release was made', store.listReleases(id).length === 1);
  check('PM2 started the release through the fake',
    fake.calls.some((c) => /\sstart\s+.+ez\.pm2\.json"?$/i.test(c)), fake.calls.slice(-4).join(' | '));
  check('the fake PM2 lists the app under its ez- name',
    fake.apps().some((app) => app.name === `ez-${id}`), fake.apps().map((a) => a.name).join(','));
  check('the process list was saved', fake.calls.some((c) => /\ssave$/i.test(c)));
  check('the app was never started for real', commands.calls.every((c) => !/npm run start|node server\.js/.test(c.command)));
}

// ─── 4. Create-app answers carry the PM2 state and the offer ────────────────

async function testCreateOffers() {
  setGroup('4. creating an app answers with the PM2 state and an install offer');

  const hubCommands = await import(srcUrl('core/deploy/hubCommands.js'));
  const { default: DeploymentsController } = await import(srcUrl('dashboard/controllers/deploymentsController.js'));

  const missing = createFakePm2({ installed: false });
  const missingDeps = { run: missing.run, isRunning: () => false };

  const notInstalled = await hubCommands.pm2StateForNewApp({
    installEndpoint: 'POST /api/pm2/install',
    deps: missingDeps,
  });
  check('not_installed: the state, reason, message and fix come from runner',
    notInstalled.state === 'not_installed'
    && notInstalled.reason === 'not_installed'
    && notInstalled.message === 'PM2 is not installed.'
    && notInstalled.fix === 'Run npm i -g pm2 on the server.',
    JSON.stringify(notInstalled));
  check('not_installed: the offer is the dashboard install endpoint',
    notInstalled.offer?.command === 'npm i -g pm2'
    && notInstalled.offer?.endpoint === 'POST /api/pm2/install',
    JSON.stringify(notInstalled.offer));

  const hubShape = await hubCommands.pm2StateForNewApp({ installEndpoint: null, deps: missingDeps });
  check('the Hub shape is the same object with endpoint null',
    hubShape.state === 'not_installed' && hubShape.offer?.endpoint === null,
    JSON.stringify(hubShape.offer));

  const present = createFakePm2({ apps: ['one'] });
  const available = await hubCommands.pm2StateForNewApp({
    installEndpoint: 'POST /api/pm2/install',
    deps: { run: present.run, isRunning: () => true },
  });
  check('any other state carries no offer',
    available.state === 'available' && available.offer === null, `${available.state}/${String(available.offer)}`);
  check('the user field is always present', 'user' in available && 'user' in notInstalled);

  // The dashboard controller: POST /api/deployments carries it on the 201.
  const controller = new DeploymentsController({ pm2State: async () => notInstalled });
  const res = await callHandler(controller.create.bind(controller), {
    body: { id: 'created-with-offer', repoUrl: 'https://github.com/me/created-with-offer.git' },
    params: {},
    query: {},
  });
  check('the create answered 201', res.statusCode === 201, String(res.statusCode));
  check('the new app is in the body', res.body?.id === 'created-with-offer', String(res.body?.id));
  check('the body carries the pm2 object',
    res.body?.pm2?.state === 'not_installed'
    && res.body?.pm2?.offer?.endpoint === 'POST /api/pm2/install',
    JSON.stringify(res.body?.pm2));

  // The Hub command: same object, endpoint null.
  const hub = await hubCommands.handleHubDeployCommand(
    { action: 'create', app: { id: 'hub-created', repoUrl: 'https://github.com/me/hub-created.git' } },
    { pm2State: async () => hubShape },
  );
  check('the Hub create answered with the app', hub.id === 'hub-created', String(hub.id));
  check('the Hub create carries pm2 with endpoint null',
    hub.pm2?.state === 'not_installed' && hub.pm2?.offer?.endpoint === null,
    JSON.stringify(hub.pm2));

  // A probe that throws must not fail the create.
  const thrower = new DeploymentsController({
    pm2State: async () => hubCommands.pm2StateForNewApp({
      deps: { isRunning: () => false, run: async () => { throw new Error('probe exploded'); } },
    }),
  });
  const probeRes = await callHandler(thrower.create.bind(thrower), {
    body: { id: 'created-probe-failed', repoUrl: 'https://github.com/me/created-probe-failed.git' },
    params: {},
    query: {},
  });
  check('a PM2 probe that throws still creates the app, with the reason',
    probeRes.statusCode === 201
    && probeRes.body?.pm2?.state === 'unavailable'
    && /probe exploded/.test(probeRes.body?.pm2?.message ?? ''),
    JSON.stringify(probeRes.body?.pm2));
}

// ─── 5. POST /api/pm2/install, through the controller ───────────────────────

async function testInstallEndpoint() {
  setGroup('5. POST /api/pm2/install installs standard PM2, or says why not');

  const { default: ProcessesController } = await import(srcUrl('dashboard/controllers/processesController.js'));

  /** A runner whose calls are recorded, for the install path only. */
  const stub = ({ access, detected, install }) => {
    const calls = { access: 0, detect: 0, install: [] };
    return {
      calls,
      pm2Access() { calls.access += 1; return access; },
      async detect() { calls.detect += 1; return detected; },
      async install(...args) { calls.install.push(args); return install(...args); },
    };
  };

  const req = () => ({ body: undefined, params: {}, query: {}, headers: {} });

  // 403: this process may not use PM2 at all.
  {
    const runner = stub({
      access: { ok: false, reason: 'service_account', user: 'admin', message: UNKNOWN_MESSAGE, fix: UNKNOWN_FIX },
      detected: { installed: false },
      install: async () => ({ ok: true, output: '' }),
    });
    let invalidated = 0;
    const controller = new ProcessesController({ runner, invalidate: () => { invalidated += 1; } });
    const res = await callHandler(controller.installPm2.bind(controller), req());
    check('a service account is refused with 403', res.statusCode === 403, String(res.statusCode));
    check('with reason service_account', res.body?.reason === 'service_account', res.body?.reason);
    check('and the exact message and fix',
      res.body?.message === UNKNOWN_MESSAGE && res.body?.fix === UNKNOWN_FIX);
    check('nothing was installed and no probe was run',
      runner.calls.install.length === 0 && runner.calls.detect === 0, JSON.stringify(runner.calls));
    check('the probes were not touched', invalidated === 0, String(invalidated));
  }

  // 409: already installed.
  {
    const runner = stub({
      access: { ok: true },
      detected: { installed: true, version: '6.0.14', path: 'C:\\npm\\pm2.cmd' },
      install: async () => ({ ok: true, output: '' }),
    });
    const controller = new ProcessesController({ runner, invalidate: () => {} });
    const res = await callHandler(controller.installPm2.bind(controller), req());
    check('an existing PM2 is answered 409', res.statusCode === 409, String(res.statusCode));
    check('with reason already_installed', res.body?.reason === 'already_installed', res.body?.reason);
    check('nothing was installed', runner.calls.install.length === 0);
  }

  // 200: a stub npm installs it.
  {
    const runner = stub({
      access: { ok: true },
      detected: { installed: false },
      install: async () => ({ ok: true, output: '+ pm2@6.0.14\nadded 120 packages\n' }),
    });
    let invalidated = 0;
    const controller = new ProcessesController({ runner, invalidate: () => { invalidated += 1; } });
    const res = await callHandler(controller.installPm2.bind(controller), {
      ...req(),
      // A body must change nothing: the command is fixed.
      body: { command: 'rm -rf /', version: '9.9.9', PM2_HOME: 'C:\\ProgramData\\pm2' },
    });
    check('a successful install answers 200', res.statusCode === 200, String(res.statusCode));
    check('with ok true', res.body?.ok === true);
    check('the version comes from npm output, without running pm2',
      res.body?.version === '6.0.14', String(res.body?.version));
    check('the output is passed through', /pm2@6\.0\.14/.test(res.body?.output ?? ''));
    check('install was called exactly once', runner.calls.install.length === 1);
    check('with no arguments: no PM2_HOME, no prefix, nothing from the body',
      runner.calls.install[0].length === 0, JSON.stringify(runner.calls.install[0]));
    check('the PM2 probes were invalidated', invalidated === 1, String(invalidated));
  }

  // 500: npm failed. It is reported with the command to run.
  {
    const runner = stub({
      access: { ok: true },
      detected: { installed: false },
      install: async () => ({ ok: false, output: 'npm ERR! code EACCES' }),
    });
    const controller = new ProcessesController({ runner, invalidate: () => {} });
    const res = await callHandler(controller.installPm2.bind(controller), req());
    check('a failed install answers 500', res.statusCode === 500, String(res.statusCode));
    check('with reason install_failed', res.body?.reason === 'install_failed', res.body?.reason);
    check('the output is included', res.body?.output === 'npm ERR! code EACCES', res.body?.output);
    check('and the exact command to run by hand', res.body?.command === 'npm i -g pm2', res.body?.command);
  }

  // 500: the install itself threw.
  {
    const runner = stub({
      access: { ok: true },
      detected: { installed: false },
      install: async () => { throw new Error('spawn failed'); },
    });
    const controller = new ProcessesController({ runner, invalidate: () => {} });
    const res = await callHandler(controller.installPm2.bind(controller), req());
    check('an install that throws is still a 500 install_failed with the command',
      res.statusCode === 500 && res.body?.reason === 'install_failed' && res.body?.command === 'npm i -g pm2',
      `${res.statusCode}/${res.body?.reason}`);
  }

  // 409: a concurrent request while one install runs.
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const runner = stub({
      access: { ok: true },
      detected: { installed: false },
      install: async () => {
        await gate;
        return { ok: true, output: '+ pm2@6.0.14\n' };
      },
    });
    const controller = new ProcessesController({ runner, invalidate: () => {} });
    const first = controller.installPm2.bind(controller)(req(), fakeResponse());
    // Let the first request get past detect and into install.
    await sleep(20);
    const second = await callHandler(controller.installPm2.bind(controller), req());
    check('a concurrent install answers 409', second.statusCode === 409, String(second.statusCode));
    check('with reason in_progress', second.body?.reason === 'in_progress', second.body?.reason);

    release();
    const firstRes = await first;
    check('the first install still answered 200', firstRes.statusCode === 200, String(firstRes.statusCode));
    check('npm ran exactly once', runner.calls.install.length === 1, String(runner.calls.install.length));

    // And the lock is released: a second, later request is accepted.
    const third = await callHandler(controller.installPm2.bind(controller), req());
    check('after it finishes another install is accepted', third.statusCode === 200, String(third.statusCode));
  }
}

// ─── 6. The route: auth gate and registration order ────────────────────────

async function testRoute() {
  setGroup('6. the route is behind the session gate and not captured by a pattern');

  const { createProcessesRouter } = await import(srcUrl('dashboard/routes/processes.js'));

  const seen = [];
  const answer = (which) => (req, res) => { seen.push(which); return res.json({ ok: true, which }); };
  const stubController = {
    status: answer('status'),
    start: answer('start'),
    stop: answer('stop'),
    restart: answer('restart'),
    installPm2: (req, res) => {
      seen.push('install');
      return res.json({ ok: true, which: 'install', body: req.body ?? null });
    },
    list: answer('list'),
    logs: answer('logs'),
    action: answer('action'),
  };

  const router = createProcessesRouter(stubController);

  // Registration order, read from the Express stack the server will serve.
  const layerIndex = (routePath) => router.stack.findIndex((l) => l.route?.path === routePath);
  const installAt = layerIndex('/pm2/install');
  const actionAt = layerIndex('/processes/:name/:action');
  check('POST /pm2/install is registered', installAt !== -1);
  check('it is registered before /processes/:name/:action',
    installAt !== -1 && actionAt !== -1 && installAt < actionAt, `${installAt} < ${actionAt}`);
  check('and it is a POST',
    installAt !== -1 && router.stack[installAt].route.methods?.post === true);

  const app = express();
  app.use(express.json());
  const port = await freePort();
  const server = http.createServer(app);

  try {
    // Without a session: the shared gate answers 401 before any handler runs.
    app.use('/api', router);
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    const anonymous = await httpJson(port, { method: 'POST', pathname: '/api/pm2/install', body: {} });
    check('without a session the install is 401', anonymous.status === 401, String(anonymous.status));
    check('and no handler ran', seen.length === 0, seen.join(','));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // With a session: the install handler is reached, not a parameterised route,
  // even with a body that names an app and an action.
  const authed = express();
  authed.use(express.json());
  authed.use('/api', (req, _res, next) => { req.session = { authenticated: true }; next(); });
  authed.use('/api', router);
  const port2 = await freePort();
  const server2 = http.createServer(authed);
  try {
    await new Promise((resolve) => server2.listen(port2, '127.0.0.1', resolve));

    const hit = await httpJson(port2, {
      method: 'POST',
      pathname: '/api/pm2/install',
      body: { name: 'demo', action: 'start' },
    });
    check('with a session it reaches the install handler',
      hit.status === 200 && hit.json?.which === 'install', JSON.stringify(hit.json));
    check('it was not read as /processes/:name/:action', !seen.includes('action'), seen.join(','));
    check('the body was passed through untouched (the controller ignores it)',
      hit.json?.body?.name === 'demo', JSON.stringify(hit.json?.body));

    const action = await httpJson(port2, { method: 'POST', pathname: '/api/processes/demo/start' });
    check('the process action route still works',
      action.status === 200 && action.json?.which === 'action', JSON.stringify(action.json));
  } finally {
    await new Promise((resolve) => server2.close(resolve));
  }
}

// ─── 7. The engine's rename sites: retry and EXDEV ─────────────────────────

async function testEngineRenames(engine, apps, store) {
  setGroup('7. moveDirectory rides out EPERM, and the EXDEV copy path still works');

  const fsDefault = (await import('node:fs')).default;
  const originalRename = fsDefault.renameSync;

  /** Patches renameSync for one move and restores it in `finally`. */
  const withRename = async (patched, fn) => {
    fsDefault.renameSync = patched;
    try {
      return await fn();
    } finally {
      fsDefault.renameSync = originalRename;
    }
  };

  const moveDeps = {
    runner: {
      detect: async () => ({ installed: true, version: null, path: 'pm2', error: null }),
      isDaemonRunning: () => false,
    },
    pm2Installed: () => true,
  };

  // EPERM twice, then the same rename succeeds (5 attempts are available).
  {
    const id = 'rename-eprem';
    const created = apps.createApp({ id, repoUrl: `https://github.com/me/${id}.git` });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const paths = store.appPaths(id);
    fs.writeFileSync(path.join(paths.root, 'marker.txt'), 'kept\n');
    const targetDir = scratch('moved-eprem');

    let attempts = 0;
    const patched = (from, to) => {
      if (path.resolve(String(from)) === path.resolve(paths.root)) {
        attempts += 1;
        if (attempts <= 2) {
          const err = new Error('EPERM: operation not permitted, rename');
          err.code = 'EPERM';
          throw err;
        }
      }
      return originalRename.call(fsDefault, from, to);
    };

    const moved = await withRename(patched, () => engine.moveApp(id, targetDir, { deps: moveDeps }));
    check('the move succeeds after two sharing denials', moved.ok === true, moved.error ?? '');
    check('the rename was attempted three times', attempts === 3, String(attempts));
    check('the file arrived with the app',
      fs.existsSync(path.join(targetDir, id, 'marker.txt')));
    check('the old folder is gone', !fs.existsSync(paths.root));
  }

  // EXDEV: the copy-then-delete path is unchanged.
  {
    const id = 'rename-exdev';
    const created = apps.createApp({ id, repoUrl: `https://github.com/me/${id}.git` });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const paths = store.appPaths(id);
    fs.writeFileSync(path.join(paths.root, 'marker.txt'), 'copied\n');
    const targetDir = scratch('moved-exdev');

    let attempts = 0;
    const patched = (from, to) => {
      if (path.resolve(String(from)) === path.resolve(paths.root)) {
        attempts += 1;
        const err = new Error('EXDEV: cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
      }
      return originalRename.call(fsDefault, from, to);
    };

    const moved = await withRename(patched, () => engine.moveApp(id, targetDir, { deps: moveDeps }));
    check('a cross-device move still succeeds', moved.ok === true, moved.error ?? '');
    check('EXDEV is not retried: one attempt, then a copy', attempts === 1, String(attempts));
    check('the file was copied to the new folder',
      fs.existsSync(path.join(targetDir, id, 'marker.txt'))
      && fs.readFileSync(path.join(targetDir, id, 'marker.txt'), 'utf8') === 'copied\n');
    check('and the old folder was removed', !fs.existsSync(paths.root));
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nDeploy preflight and the PM2 install offer\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  const engine = await import(srcUrl('core/deploy/engine.js'));
  const apps = await import(srcUrl('core/deploy/apps.js'));
  const store = await import(srcUrl('core/deploy/store.js'));
  const realRunner = await import(srcUrl('core/runner.js'));
  const db = await import(srcUrl('core/db.js'));

  // A clean registry: every app this suite makes is created here.
  db.dbSet('deployApps', []);

  await testServiceAccountPreflight(engine, apps, store);
  await testMissingPm2Preflight(engine, apps, store, realRunner);
  await testNormalDeploy(engine, apps, store, realRunner);
  await testCreateOffers();
  await testInstallEndpoint();
  await testRoute();
  await testEngineRenames(engine, apps, store);

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
