/**
 * Tests for deploy keys: creating an app and its key in one step, regenerating,
 * testing the connection with GitHub's host keys pinned, and adding the public
 * key to GitHub.
 *
 * Run with:  npm run test:e2e -- deploy-keys
 *
 * Nothing here talks to GitHub or to ssh: testDeployKey() gets a stub runner and
 * every GitHub call gets a stub fetch. The key material is real, generated in
 * this process, so the file format and fingerprints are checked for real.
 *
 * Writes only inside the temporary data directory the runner provides.
 */

// MUST be the first import (see e2e/lib/guard.mjs).
import './lib/guard.mjs';
import { TEST_DATA_DIR } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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

/** Do POSIX permission bits mean anything here? Detected, never assumed from the OS. */
function hasPosixModes() {
  const probe = path.join(TEST_DATA_DIR, `mode-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'x', { mode: 0o600 });
    fs.chmodSync(probe, 0o600);
    return (fs.statSync(probe).mode & 0o077) === 0;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { force: true });
  }
}
const POSIX_MODES = hasPosixModes();

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

async function call(controller, method, req) {
  const res = fakeRes();
  let nextError = null;
  await controller[method](req, res, (err) => { nextError = err; });
  return { status: res.statusCode, body: res.body, error: nextError };
}

const seenResponses = [];
function remember(result) {
  if (result?.body !== undefined) seenResponses.push(JSON.stringify(result.body));
  return result;
}

const materialOf = (key) => String(key ?? '').trim().split(/\s+/).slice(0, 2).join(' ');

function fakeGithub({ keys = [], repo = 'acme/add' } = {}) {
  const calls = [];
  const state = { keys: keys.map((k) => ({ ...k })), added: null, deleted: [] };
  const fetchImpl = async (url, init = {}) => {
    const pathname = url.replace('https://api.github.com', '');
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, pathname, body, auth: init.headers?.Authorization });

    const reply = (status, json) => ({
      status,
      json: async () => {
        if (json === undefined) throw new Error('no body');
        return json;
      },
    });

    const base = `/repos/${repo}`;
    if (method === 'GET' && pathname.startsWith(`${base}/keys`)) return reply(200, state.keys);
    if (method === 'POST' && pathname === `${base}/keys`) {
      const added = { id: 100 + state.keys.length, key: body.key, title: body.title };
      state.keys.push(added);
      state.added = body;
      return reply(201, {});
    }
    if (method === 'DELETE' && pathname.startsWith(`${base}/keys/`)) {
      const id = Number(pathname.split('/').pop());
      state.keys = state.keys.filter((k) => k.id !== id);
      state.deleted.push(id);
      return reply(204, undefined);
    }
    return reply(404, { message: 'Not Found' });
  };
  return { calls, state, fetchImpl };
}

async function main() {
  const { dbGet, dbSet } = await import(srcUrl('core/db.js'));
  const apps = await import(srcUrl('core/deploy/apps.js'));
  const store = await import(srcUrl('core/deploy/store.js'));
  const dk = await import(srcUrl('core/deploy/deployKey.js'));
  const gh = await import(srcUrl('core/deploy/githubApi.js'));
  const hc = await import(srcUrl('core/deploy/hubCommands.js'));
  const hp = await import(srcUrl('core/hubPermissions.js'));
  const Controller = (await import(srcUrl('dashboard/controllers/deploymentsController.js'))).default;
  const dashboard = new Controller();

  dbSet('deployApps', []);

  // ── 1. Create with the key in the same step ────────────────────────────────
  setGroup('1. Create an app and its key in one step');
  {
    const created = remember(await call(dashboard, 'create', {
      body: { id: 'dk-create', repoUrl: 'git@github.com:acme/app.git', authType: 'deployKey' },
    }));
    const body = created.body ?? {};
    check('dashboard create is 201', created.status === 201, String(created.status));
    check('the response carries the public key, fingerprint and add URL',
      typeof body.deployKey?.publicKey === 'string'
      && body.deployKey.fingerprint === dk.fingerprintOf(body.deployKey.publicKey)
      && body.deployKey.addUrl === 'https://github.com/acme/app/settings/keys/new',
      JSON.stringify(body.deployKey));
    check('no private key appears anywhere in the JSON', !JSON.stringify(body).includes('PRIVATE KEY'));

    const priv = store.appPaths('dk-create').deployKey;
    check('the key file exists in the app folder', fs.existsSync(priv));
    const pem = fs.readFileSync(priv, 'utf8');
    const raw = Buffer.from(
      pem.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, '').replace(/\s+/g, ''),
      'base64',
    );
    check('the private key is openssh-key-v1', raw.subarray(0, 15).toString() === 'openssh-key-v1\0');
    if (POSIX_MODES) {
      check('the key file is owner-only (600)', (fs.statSync(priv).mode & 0o077) === 0,
        (fs.statSync(priv).mode & 0o777).toString(8));
    } else {
      process.stdout.write('   SKIP  this filesystem has no POSIX permission bits\n');
    }

    check('creating an app does not start a deployment',
      store.listRuns('dk-create').length === 0
      && store.listReleases('dk-create').length === 0
      && store.lockHolder('dk-create') === null
      && store.readState('dk-create').current === null);

    const noKey = remember(await call(dashboard, 'create', {
      body: {
        id: 'dk-nokey', repoUrl: 'git@github.com:acme/nokey.git', authType: 'deployKey', generateKey: false,
      },
    }));
    check('generateKey:false creates an app with no key',
      noKey.status === 201 && noKey.body?.deployKey === null
      && !fs.existsSync(store.appPaths('dk-nokey').deployKey));

    const other = remember(await call(dashboard, 'create', {
      body: { id: 'dk-gitlab', repoUrl: 'git@gitlab.com:acme/app.git', authType: 'deployKey' },
    }));
    check('a non-GitHub repository gets a key with addUrl null',
      other.status === 201 && other.body?.deployKey?.publicKey && other.body.deployKey.addUrl === null
      && other.body.deployKeyFingerprint === dk.fingerprintOf(other.body.deployKey.publicKey));

    const viaHub = remember({
      body: await hc.handleHubDeployCommand({
        action: 'create',
        app: { id: 'dk-hub', repoUrl: 'git@github.com:acme/hub.git', authType: 'deployKey', generateKey: true },
      }),
    });
    check('the Hub create path generates the same key object',
      typeof viaHub.body?.deployKey?.publicKey === 'string'
      && viaHub.body.deployKey.fingerprint === dk.fingerprintOf(viaHub.body.deployKey.publicKey)
      && viaHub.body.deployKey.addUrl === 'https://github.com/acme/hub/settings/keys/new');
    check('the Hub create path does not start a deployment',
      store.listRuns('dk-hub').length === 0 && store.listReleases('dk-hub').length === 0
      && store.lockHolder('dk-hub') === null);
    check('the Hub create response has no private key', !JSON.stringify(viaHub.body).includes('PRIVATE KEY'));
  }

  // ── 2. Pinned host keys ───────────────────────────────────────────────────
  setGroup('2. GitHub host keys are the published ones');
  for (const line of dk.GITHUB_HOST_KEYS) {
    const [type] = line.split(/\s+/);
    check(`${type} fingerprint matches GitHub's published value`,
      dk.fingerprintOf(line) === dk.GITHUB_HOST_FINGERPRINTS[type]);
  }

  // ── 3. Regenerate ─────────────────────────────────────────────────────────
  setGroup('3. Regenerate');
  {
    const before = apps.dashboardApp(apps.getApp('dk-create'));
    const pathOnDisk = store.appPaths('dk-create').deployKey;
    const oldFile = fs.readFileSync(pathOnDisk, 'utf8');
    const regenerated = remember(await call(dashboard, 'deployKey', { params: { id: 'dk-create' } }));
    const body = regenerated.body ?? {};
    const after = apps.dashboardApp(apps.getApp('dk-create'));
    check('regenerate is 200 with the new key and the previous fingerprint',
      regenerated.status === 200
      && body.fingerprint === dk.fingerprintOf(body.publicKey)
      && body.fingerprint !== before.deployKeyFingerprint
      && body.previousFingerprint === before.deployKeyFingerprint
      && body.addUrl === 'https://github.com/acme/app/settings/keys/new');
    check('regenerate replaces the file and the stored record',
      fs.readFileSync(pathOnDisk, 'utf8') !== oldFile
      && after.deployKey === body.publicKey && after.deployKeyFingerprint === body.fingerprint);
    check('regenerate response has no private key', !JSON.stringify(body).includes('PRIVATE KEY'));

    const hubKey = remember({
      body: await hc.handleHubDeployCommand({ action: 'regenerateKey', id: 'dk-nokey' }),
    });
    check('the Hub regenerate action works and reports a null previous fingerprint',
      hubKey.body?.fingerprint === dk.fingerprintOf(hubKey.body.publicKey)
      && hubKey.body.previousFingerprint === null && hubKey.body.addUrl === 'https://github.com/acme/nokey/settings/keys/new');

    const lock = store.acquireLock('dk-create', { runId: 'held-run' });
    const refused = remember(await call(dashboard, 'deployKey', { params: { id: 'dk-create' } }));
    let hubRefusal = '';
    try {
      await hc.handleHubDeployCommand({ action: 'regenerateKey', id: 'dk-create' });
    } catch (err) {
      hubRefusal = err.message;
    }
    lock.release();
    check('regenerate is refused while the deploy lock is held',
      refused.status === 409
      && refused.body?.error === 'A deployment is running; regenerate the key after it finishes.');
    check('the Hub refuses it for the same reason',
      hubRefusal === 'A deployment is running; regenerate the key after it finishes.', hubRefusal);

    const tokenApp = apps.createApp({
      id: 'dk-token', repoUrl: 'https://github.com/acme/token.git', authType: 'token', token: 'ghp_abcdefghij1234567890',
    });
    const notDeployKey = remember(await call(dashboard, 'deployKey', { params: { id: 'dk-token' } }));
    check('regenerate needs deployKey auth and an SSH URL',
      tokenApp.ok && notDeployKey.status === 400, String(notDeployKey.status));
    const missing = remember(await call(dashboard, 'deployKey', { params: { id: 'dk-ghost' } }));
    check('regenerate for an unknown app is 404', missing.status === 404);
  }

  // ── 4. Test the connection (stub runner; no ssh) ─────────────────────────
  setGroup('4. Test the connection');
  {
    const app = apps.getApp('dk-create');
    const freshNoKey = apps.createApp({
      id: 'dk-test-nokey', repoUrl: 'git@github.com:acme/nokey2.git', authType: 'deployKey',
    });
    check('a deploy-key app with no key still exists', freshNoKey.ok);
    const knownHosts = path.join(store.appPaths('dk-create').root, 'known_hosts');
    const calls = [];
    const okRun = async (cmd, opts) => {
      calls.push({ cmd, opts });
      return { success: true, stdout: 'abc123\trefs/heads/main\n', stderr: '', exitCode: 0 };
    };
    const tested = await dk.testDeployKey('dk-create', { run: okRun });
    const ssh = calls[0]?.opts?.env?.GIT_SSH_COMMAND ?? '';
    check('a successful test reports the branch and fingerprint',
      tested.ok === true && tested.branchFound === true && tested.fingerprint === app.auth.keyFingerprint);
    check('GIT_SSH_COMMAND pins the host key: yes, known_hosts, never accept-new',
      ssh.includes('StrictHostKeyChecking=yes')
      && ssh.includes('UserKnownHostsFile=')
      && !ssh.includes('accept-new'));
    const lines = fs.readFileSync(knownHosts, 'utf8').trim().split(/\r?\n/);
    check('known_hosts holds exactly GitHub\'s pinned lines',
      lines.length === dk.GITHUB_HOST_KEYS.length
      && lines.every((line, i) => line === `github.com ${dk.GITHUB_HOST_KEYS[i]}`));
    check('the test runner is called with git ls-remote and prompting disabled',
      /git ls-remote --heads/.test(calls[0]?.cmd ?? '')
      && calls[0]?.opts?.env?.GIT_TERMINAL_PROMPT === '0');

    const failure = async (stderr, exitCode = 1) => dk.testDeployKey('dk-create', {
      run: async () => ({ success: false, stdout: '', stderr, exitCode }),
    });
    const publickey = await failure('git@github.com: Permission denied (publickey).');
    check('a rejected key maps to "add the public key to the repository"',
      publickey.ok === false && publickey.status === 200 && /rejected the key/.test(publickey.error), publickey.error);

    const changed = await failure('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.');
    check('a changed host key maps to the interception warning',
      changed.ok === false && /did not present GitHub's published host key/.test(changed.error), changed.error);

    const notFound = await failure('ERROR: Repository not found.\nfatal: Could not read from remote repository.');
    check('a missing repository maps to "the key cannot read it"',
      notFound.ok === false && /cannot read that repository/.test(notFound.error), notFound.error);

    const timedOut = await failure('', null);
    check('an unanswered connection maps to the 20-second timeout',
      timedOut.ok === false && /within 12 seconds/.test(timedOut.error), timedOut.error);

    let networkCalls = 0;
    const never = async () => { networkCalls += 1; return { success: false, stdout: '', stderr: '', exitCode: 1 }; };
    const gitlab = await dk.testDeployKey('dk-gitlab', { run: never });
    check('a non-GitHub host is refused without running ssh',
      gitlab.ok === false && gitlab.status === 400 && networkCalls === 0, String(gitlab.status));

    const noKey = await dk.testDeployKey('dk-test-nokey', { run: never });
    check('an app with no key is 409 without running ssh',
      noKey.ok === false && noKey.status === 409 && networkCalls === 0, String(noKey.status));
    const unknown = await dk.testDeployKey('dk-nowhere', { run: never });
    check('an unknown app is 404', unknown.ok === false && unknown.status === 404);

    const route400 = remember(await call(dashboard, 'deployKeyTest', { params: { id: 'dk-gitlab' }, body: {} }));
    const route409 = remember(await call(dashboard, 'deployKeyTest', { params: { id: 'dk-test-nokey' }, body: {} }));
    check('the dashboard route passes 400 and 409 through unchanged',
      route400.status === 400 && route409.status === 409,
      `${route400.status}/${route409.status}`);
  }

  // ── 5. Add the key to GitHub (stub fetch; no network) ─────────────────────
  setGroup('5. Add the key to GitHub');
  {
    const app = apps.getApp('dk-create');
    const key = app.auth.publicKey;
    const material = materialOf(key);
    const token = 'ghp_DeployKeyToken1234567890';

    const fresh = fakeGithub({ repo: 'acme/app' });
    const added = await gh.addDeployKey({
      repoUrl: app.repoUrl, token, title: 'Easy DevOps — dk-create', key, fetchImpl: fresh.fetchImpl,
    });
    const post = fresh.calls.find((c) => c.method === 'POST');
    check('the key is POSTed read-only, with no comment',
      added.ok === true && post?.body?.read_only === true
      && post.body.key === material && !post.body.key.includes('dk-create'), JSON.stringify(post?.body));
    check('the request carries the token as a bearer header to api.github.com only',
      fresh.calls.every((c) => c.auth === `Bearer ${token}`));

    const already = fakeGithub({
      repo: 'acme/app',
      keys: [{ id: 7, key: material, title: 'some other title' }],
    });
    const again = await gh.addDeployKey({
      repoUrl: app.repoUrl, token, title: 'Easy DevOps — dk-create', key, fetchImpl: already.fetchImpl,
    });
    check('a key already on the repository is not POSTed again',
      again.ok === true && !already.calls.some((c) => c.method === 'POST') && /already/.test(again.steps[0].detail));

    const old = fakeGithub({
      repo: 'acme/old',
      keys: [{ id: 9, key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOldKeyMaterial', title: 'Easy DevOps — dk-old' }],
    });
    const replaced = await gh.addDeployKey({
      repoUrl: 'git@github.com:acme/old.git',
      token,
      title: 'Easy DevOps — dk-old',
      key,
      fetchImpl: old.fetchImpl,
    });
    check('the regenerated-away key with the same title is deleted as its own step',
      replaced.ok === true && old.state.deleted.includes(9)
      && replaced.steps.map((s) => s.id).join() === 'deployKey,oldKey'
      && /previous deploy key/.test(replaced.steps[1].detail),
      JSON.stringify(replaced.steps));

    const deny = async () => ({ status: 403, json: async () => ({ message: 'Resource not accessible by personal access token' }) });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = deny;
    const denied = remember(await call(dashboard, 'deployKeyGithub', {
      params: { id: 'dk-create' }, body: { token },
    }));
    globalThis.fetch = originalFetch;
    check('a GitHub refusal answers 422 with the explanation, not 5xx',
      denied.status === 422 && /GitHub refused \(403/.test(denied.body?.error ?? '')
      && /Administration/.test(denied.body?.error ?? ''), denied.body?.error);
    check('the refused request never echoes the token', !JSON.stringify(denied.body).includes(token));

    const allow = fakeGithub({ repo: 'acme/app' });
    globalThis.fetch = allow.fetchImpl;
    const allowed = remember(await call(dashboard, 'deployKeyGithub', {
      params: { id: 'dk-create' }, body: { token },
    }));
    globalThis.fetch = originalFetch;
    check('the dashboard route adds the key and returns its steps',
      allowed.status === 200 && allowed.body?.ok === true
      && allowed.body.steps.some((s) => s.id === 'deployKey' && s.ok));
    check('the allowed request never echoes the token either', !JSON.stringify(allowed.body).includes(token));

    const hubAllow = fakeGithub({ repo: 'acme/hub' });
    globalThis.fetch = hubAllow.fetchImpl;
    const hubAdded = remember({
      body: await hc.handleHubDeployCommand({ action: 'addKeyToGithub', id: 'dk-hub', token }),
    });
    globalThis.fetch = originalFetch;
    check('the Hub action adds the key and never echoes the token',
      hubAdded.body?.ok === true && !JSON.stringify(hubAdded.body).includes(token));

    const fallback = apps.createApp({
      id: 'dk-fallback', repoUrl: 'https://github.com/acme/fallback.git', authType: 'token', token,
    });
    const pair = dk.createEd25519Pair('easy-devops-deploy-dk-fallback');
    apps.setDeployKeyRecord('dk-fallback', {
      publicKey: pair.publicKey, fingerprint: pair.fingerprint, createdAt: new Date().toISOString(),
    });
    const fallbackGithub = fakeGithub({ repo: 'acme/fallback' });
    globalThis.fetch = fallbackGithub.fetchImpl;
    const fallbackResult = remember(await call(dashboard, 'deployKeyGithub', {
      params: { id: 'dk-fallback' }, body: {},
    }));
    globalThis.fetch = originalFetch;
    check('without a typed token the app\'s own token is tried',
      fallback.ok && fallbackResult.status === 200
      && fallbackGithub.calls.every((c) => c.auth === `Bearer ${token}`)
      && !JSON.stringify(fallbackResult.body).includes(token));

    const noKey = await call(dashboard, 'deployKeyGithub', { params: { id: 'dk-test-nokey' }, body: { token } });
    check('adding a key to an app that has none is 409',
      noKey.status === 409 && /Generate the deploy key first/.test(noKey.body?.error ?? ''));
  }

  // ── 6. Permissions ────────────────────────────────────────────────────────
  setGroup('6. Permissions');
  for (const action of ['regenerateKey', 'testKey', 'addKeyToGithub']) {
    check(`${action} needs deploy.manage on the agent side`,
      hp.permissionForCommand('hub:manageDeploy', { action }) === 'deploy.manage'
      && hp.checkCommandAllowed('hub:manageDeploy', { action }, hp.defaultPermissions()).allowed === false
      && hp.checkCommandAllowed('hub:manageDeploy', { action }, { 'deploy.manage': true }).allowed === true);
  }

  // ── 7. Nothing secret left any response ───────────────────────────────────
  setGroup('7. No private key in any response');
  check('every response captured by this suite is free of "PRIVATE KEY"',
    seenResponses.every((text) => !text.includes('PRIVATE KEY')));
  check('the registry and the public views never contain the private key',
    !JSON.stringify(dbGet('deployApps')).includes('PRIVATE KEY')
    && !JSON.stringify(apps.publicApp(apps.getApp('dk-create'))).includes('PRIVATE KEY'));

  // ── Summary ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${results.length} PASS ${failed.length} FAIL\n`);
  if (failed.length > 0) {
    for (const f of failed) process.stdout.write(`   FAILED: ${f.group} — ${f.label}${f.detail ? ` (${f.detail})` : ''}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`\nSuite error: ${err.stack}\n`);
  process.exit(1);
});
