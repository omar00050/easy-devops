/**
 * Full-stack smoke test for the hub-first pairing flow.
 *
 * Run with:  npm run test:e2e -- pairing-smoke
 * Requires:  cd hub_backend && npm run build
 *            cd hub_backend && DATABASE_URL="file:./test.db" npx prisma migrate deploy
 *
 * Starts the real hub_backend and the real easy-devops dashboard on RANDOM
 * free ports, against an isolated prisma/test.db and a temporary config dir,
 * then performs a complete pairing end to end:
 *
 *   1. register a hub account + create a server with { name } only
 *   2. take the returned connection string
 *   3. POST it to the dashboard's /api/hub/connect
 *   4. poll /api/hub/status until the agent reports "connected"
 *   5. confirm the hub now sees the server as online
 *   6. verify the dashboard status payload never contains the secret
 *
 * Neither the real hub.db nor the real easy-devops config is touched.
 * Secrets are never printed.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
import './lib/guard.mjs';

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { issueSetupCode } from './lib/firstRun.mjs';
import { once } from 'events';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This script lives in <project>/e2e/, so the project root is one level up.
const ROOT = path.resolve(__dirname, '..');
const HUB_DIR = path.join(ROOT, 'hub_backend');
const REAL_LEGACY_DB = path.join(ROOT, 'data', 'easy-devops.sqlite');
const REAL_HUB_DB = path.join(HUB_DIR, 'prisma', 'hub.db');

// Ports are allocated at run time. Fixed ports made this test collide with a
// running stack, which it would then drive — including an unlink at teardown.
let HUB_PORT = 0;
let DASH_PORT = 0;
let HUB = '';
let DASH = '';

/** Asks the OS for a port nothing is using. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
const JWT_SECRET = 'smoke-only-secret-value-at-least-32-chars';

const procs = [];
const results = [];
const check = (label, passed, detail = '') => {
  results.push({ label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
};

async function waitFor(url, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} did not come up at ${url}`);
}

function start(label, cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  procs.push({ label, p });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) process.stderr.write(`[${label}] ${s.slice(0, 300)}\n`);
  });
  return p;
}

async function stopAll() {
  for (const { label, p } of procs) {
    if (p.exitCode !== null) continue;
    try {
      // Kill the whole tree on Windows so child node processes die too.
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        p.kill('SIGTERM');
      }
    } catch { /* already gone */ }
    await Promise.race([once(p, 'exit'), new Promise((r) => setTimeout(r, 4000))]);
    process.stdout.write(`   stopped ${label}\n`);
  }
}

// Minimal cookie jar for the dashboard's session cookie.
let cookie = '';
async function dash(method, pathname, body) {
  const res = await fetch(`${DASH}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // The dashboard requires this on state-changing requests — see
      // src/dashboard/lib/localRequest.js.
      'X-EZ-Request': '1',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

async function hubApi(method, pathname, { token, body } = {}) {
  const res = await fetch(`${HUB}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

/**
 * Refuses to run if the chosen ports are somehow taken.
 *
 * This test drives whatever is listening on those ports. If a real stack is
 * already running it will talk to the live hub and the live dashboard — and
 * its teardown step ends with DELETE /api/hub/link, which would unlink the
 * real server and leave test accounts in the real hub.db.
 */
async function assertPortsFree() {
  // Last safety net only: the ports are random, so this should never trip.
  const inUse = [];
  for (const [label, port] of [['hub_backend', HUB_PORT], ['dashboard', DASH_PORT]]) {
    const busy = await new Promise((resolve) => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
      setTimeout(() => { sock.destroy(); resolve(false); }, 1500);
    });
    if (busy) inUse.push(`${label} (port ${port})`);
  }

  if (inUse.length > 0) {
    process.stderr.write(
      `\nRefusing to run: ${inUse.join(' and ')} already in use.\n` +
      'This test would drive your running stack and modify real data.\n' +
      'Stop those processes first, then re-run.\n\n'
    );
    process.exit(1);
  }
}

async function main() {
  HUB_PORT = await freePort();
  DASH_PORT = await freePort();
  HUB = `http://localhost:${HUB_PORT}`;
  DASH = `http://localhost:${DASH_PORT}`;
  process.stdout.write(`
Using random ports — hub ${HUB_PORT}, dashboard ${DASH_PORT}
`);

  await assertPortsFree();

  const hubDbBefore = fs.existsSync(REAL_HUB_DB) ? fs.statSync(REAL_HUB_DB).mtimeMs : null;
  const legacyBefore = fs.existsSync(REAL_LEGACY_DB) ? fs.statSync(REAL_LEGACY_DB).mtimeMs : null;

  // Temporary easy-devops config dir, with a pre-created 0-byte DB so that
  // db.js's legacy migration (which renames data/easy-devops.sqlite) never runs.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ezdevops-smoke-'));
  const cfgDir = path.join(tmpRoot, 'easy-devops');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'easy-devops.sqlite'), '');

  process.stdout.write('\n── Starting the stack\n');

  start('hub_backend', process.execPath, [path.join('dist', 'src', 'index.js')], {
    cwd: HUB_DIR,
    env: {
      ...process.env,
      DATABASE_URL: 'file:./test.db',
      PORT: String(HUB_PORT),
      PUBLIC_HUB_URL: HUB,
      FRONTEND_URL: 'http://localhost:3030',
      JWT_SECRET,
      NODE_ENV: 'test',
    },
  });
  await waitFor(`${HUB}/health`, 'hub_backend');
  check(`hub_backend is healthy on ${HUB_PORT}`, true);

  start('dashboard', process.execPath, [path.join('src', 'dashboard', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Both guard variables are passed through explicitly rather than left
      // to inheritance: a child that loses them would resolve the REAL data
      // directory, and EZ_TEST=1 makes that throw rather than happen quietly.
      EZ_TEST: '1',
      EASY_DEVOPS_DATA_DIR: cfgDir,
      APPDATA: tmpRoot,
      HOME: tmpRoot,
      USERPROFILE: tmpRoot,
      DASHBOARD_PORT: String(DASH_PORT),
    },
  });
  await waitFor(DASH, 'dashboard');
  check(`easy-devops dashboard is up on ${DASH_PORT} (temp config)`, true);

  // ── Hub side: account + server ─────────────────────────────────────────────
  process.stdout.write('\n── Hub: create account and server\n');

  const stamp = Date.now();
  const reg = await hubApi('POST', '/api/v1/auth/register', {
    body: { email: `smoke-${stamp}@e2e.test`, password: 'password-smoke-123' },
  });
  check('registered a hub account', reg.status === 201, `status ${reg.status}`);
  const token = reg.body?.data?.token;

  const created = await hubApi('POST', '/api/v1/servers', { token, body: { name: 'smoke-server' } });
  check('created server with { name } only', created.status === 201, `status ${created.status}`);
  const connectionString = created.body?.data?.connectionString ?? '';
  const serverId = created.body?.data?.server?.id ?? '';
  const secret = connectionString.split('|')[2] ?? '';
  check('hub returned a connection string', connectionString.startsWith('ezops://'));

  const beforePair = await hubApi('GET', `/api/v1/servers/${serverId}`, { token });
  check('server starts offline in the hub', beforePair.body?.data?.online === false, `online=${beforePair.body?.data?.online}`);

  // ── Dashboard side: paste the string ───────────────────────────────────────
  process.stdout.write('\n── Dashboard: paste the connection string\n');

  // A fresh temp data dir has no dashboard password, and an empty one is no
  // longer a valid login. Go through the first-run setup, which also signs in.
  const blankLogin = await dash('POST', '/api/login', { password: '' });
  check('an empty password cannot log in', blankLogin.status === 401, `status ${blankLogin.status}`);

  // First-run setup needs the one-time code the server printed; this is
  // what `ezz dashboard setup-code` issues. See core/setupCode.js.
  const setupCode = await issueSetupCode({ dataDir: cfgDir });
  const login = await dash('POST', '/api/setup', { password: 'pairing-smoke-e2e-pw', setupCode });
  check('logged into the dashboard via first-run setup', login.status === 200, `status ${login.status}`);

  const before = await dash('GET', '/api/hub/status');
  check('dashboard starts not_linked', before.body?.status === 'not_linked', `status=${before.body?.status}`);

  const badPaste = await dash('POST', '/api/hub/connect', { connectionString: 'ezops://nope' });
  check('garbage connection string -> 400', badPaste.status === 400, `status ${badPaste.status}`);

  const stillUnlinked = await dash('GET', '/api/hub/status');
  check('still not_linked after a bad paste', stillUnlinked.body?.status === 'not_linked');

  const connect = await dash('POST', '/api/hub/connect', { connectionString });
  check('valid connection string accepted', connect.status === 200, `status ${connect.status}`);

  // ── Wait for the agent to reach connected ──────────────────────────────────
  process.stdout.write('\n── Waiting for the agent to connect\n');

  let finalStatus = null;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const s = await dash('GET', '/api/hub/status');
    finalStatus = s.body;
    if (finalStatus?.status === 'connected') break;
    if (finalStatus?.status === 'rejected') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('dashboard reports "connected"', finalStatus?.status === 'connected', `status=${finalStatus?.status}`);
  check('dashboard reports the hub URL', finalStatus?.hubUrl === HUB, `${finalStatus?.hubUrl}`);
  check('dashboard reports the server id', finalStatus?.serverId === serverId);
  check('status payload contains NO secret', !!secret && !JSON.stringify(finalStatus ?? {}).includes(secret));
  check('status payload contains no ezops:// string', !JSON.stringify(finalStatus ?? {}).includes('ezops://'));

  // ── Hub side: the server is now online ─────────────────────────────────────
  await new Promise((r) => setTimeout(r, 1500));
  const afterPair = await hubApi('GET', `/api/v1/servers/${serverId}`, { token });
  check('hub now sees the server as online', afterPair.body?.data?.online === true, `online=${afterPair.body?.data?.online}`);
  check('hub read still exposes no secret', !JSON.stringify(afterPair.body).includes(secret));

  // ── Rotation makes the live agent go rejected ──────────────────────────────
  process.stdout.write('\n── Rotate the secret while the agent is connected\n');

  const regen = await hubApi('POST', `/api/v1/servers/${serverId}/regenerate-secret`, { token });
  check('regenerate returns 200', regen.status === 200, `status ${regen.status}`);

  let rotated = null;
  const deadline2 = Date.now() + 25_000;
  while (Date.now() < deadline2) {
    const s = await dash('GET', '/api/hub/status');
    rotated = s.body;
    if (rotated?.status === 'rejected') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('agent ends up "rejected" after rotation', rotated?.status === 'rejected', `status=${rotated?.status}`);
  check('rejected state explains what to do', typeof rotated?.lastError === 'string' && rotated.lastError.length > 10);

  // Re-pair with the new string recovers.
  const newCs = regen.body?.data?.connectionString ?? '';
  const reconnect = await dash('POST', '/api/hub/connect', { connectionString: newCs });
  check('re-paste of the new string accepted', reconnect.status === 200, `status ${reconnect.status}`);

  let recovered = null;
  const deadline3 = Date.now() + 25_000;
  while (Date.now() < deadline3) {
    const s = await dash('GET', '/api/hub/status');
    recovered = s.body;
    if (recovered?.status === 'connected') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('agent reconnects after re-pairing', recovered?.status === 'connected', `status=${recovered?.status}`);
  // Catalog leaf ids, not the pre-tree { reloadNginx, manageDomains, manageSSL }
  // booleans — those were migrated away, so reading them gave undefined and
  // this check passed vacuously for neither the right nor the wrong reason.
  const recoveredPerms = recovered?.permissions ?? {};
  const permIds = Object.keys(recoveredPerms);
  check('permissions survived re-pairing (catalog shape)',
    permIds.includes('nginx.reload') && permIds.includes('domains.create'),
    permIds.join(',') || 'empty');
  check('permissions survived re-pairing (still all false by default)',
    permIds.length > 0 && Object.values(recoveredPerms).every((v) => v === false));

  // ── Unlink ─────────────────────────────────────────────────────────────────
  const unlink = await dash('DELETE', '/api/hub/link');
  check('unlink returns 200', unlink.status === 200, `status ${unlink.status}`);
  const afterUnlink = await dash('GET', '/api/hub/status');
  check('dashboard back to not_linked', afterUnlink.body?.status === 'not_linked', `status=${afterUnlink.body?.status}`);

  // ── Teardown ───────────────────────────────────────────────────────────────
  process.stdout.write('\n── Stopping the stack\n');
  await stopAll();

  process.stdout.write('\n── Isolation checks\n');
  const hubDbAfter = fs.existsSync(REAL_HUB_DB) ? fs.statSync(REAL_HUB_DB).mtimeMs : null;
  const legacyAfter = fs.existsSync(REAL_LEGACY_DB) ? fs.statSync(REAL_LEGACY_DB).mtimeMs : null;

  // A developer's own hub_backend may be running against the real hub.db, and
  // its agent writes lastSeenAt every few seconds. That moves the mtime for a
  // reason unrelated to this test, so when it has moved, check whether such a
  // server is actually up rather than blaming this run. Isolation itself is
  // guaranteed by the separate DATABASE_URL this test passes.
  if (hubDbAfter === hubDbBefore) {
    check('real hub.db untouched', true);
  } else {
    let realPort = 4000;
    try {
      const envFile = fs.readFileSync(path.join(HUB_DIR, '.env'), 'utf8');
      const m = envFile.match(/^PORT\s*=\s*(\d+)/m);
      if (m) realPort = Number(m[1]);
    } catch { /* no .env — use the default */ }

    let externalHubUp = false;
    try {
      const res = await fetch(`http://localhost:${realPort}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      externalHubUp = res.status < 500;
    } catch { /* nothing listening */ }

    check('real hub.db not written by this test', externalHubUp,
      externalHubUp
        ? `another hub_backend is live on port ${realPort} and writing to it — this test used its own DATABASE_URL`
        : `mtime changed with no other hub_backend running (${hubDbBefore} -> ${hubDbAfter})`);
  }
  check('real data/easy-devops.sqlite untouched', legacyAfter === legacyBefore);
  check('no .migrated file created', !fs.existsSync(REAL_LEGACY_DB + '.migrated'));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.stdout.write('   removed temp easy-devops config dir\n');

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(60)}\nTOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  ${f.label} ${f.detail}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  process.stderr.write(`\nSmoke harness error: ${err.message}\n`);
  await stopAll();
  process.exit(1);
});
