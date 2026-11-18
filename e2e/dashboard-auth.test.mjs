/**
 * End-to-end tests for dashboard authentication.
 *
 * Run with:  npm run test:e2e -- dashboard-auth
 *
 * Plain Node script: the easy-devops constitution forbids adding a test
 * framework here, so this uses no runner and no new dependencies.
 *
 * What this exists to prevent coming back:
 *
 *   /api/domains, /api/ssl, /api/nginx and /api/settings had NO session check.
 *   Anything that could reach the dashboard port could read every domain,
 *   rewrite nginx configs and change settings. The dashboard now runs 24/7 as
 *   a background service, so that was not "exposed while a terminal is open",
 *   it was exposed on every boot.
 *
 *   An empty password was also a valid login: `password === dashboardPassword`
 *   with both empty let anyone in by submitting a blank form.
 *
 * Safety: a random free port and a temporary EASY_DEVOPS_DATA_DIR. The real
 * data directory, the real nginx and the real hub database are never touched.
 * Passwords used here are throwaway values for a throwaway install.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
import './lib/guard.mjs';

import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { issueSetupCode, waitForSetupCode } from './lib/firstRun.mjs';
import { once } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REAL_LEGACY_DB = path.join(ROOT, 'data', 'easy-devops.sqlite');

/** Throwaway, for a throwaway install in a temp directory. */
const PASSWORD = 'correct-horse-battery';

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

// ─── Isolation, established before any core module can be imported ──────────
//
// core/db.js resolves its data directory ONCE, at module load, from
// EASY_DEVOPS_DATA_DIR. Importing core/config.js before setting that variable
// makes it read — and write — the real installation. This file learned that
// the hard way, so the directory is created and the variable is set here, at
// module scope, above every dynamic import below.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-auth-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
// A pre-created 0-byte file so db.js's legacy migration — which RENAMES
// data/easy-devops.sqlite — can never run against the real installation.
fs.writeFileSync(path.join(dataDir, 'easy-devops.sqlite'), '');

process.env.EASY_DEVOPS_DATA_DIR = dataDir;

/**
 * Aborts unless the data directory in force is the temporary one.
 *
 * Called before every import of a core module and before any config read or
 * write. A test must never be able to touch the real installation, and the
 * check belongs on the thing that decides which database is opened.
 */
function assertTempDataDir(what) {
  const current = process.env.EASY_DEVOPS_DATA_DIR;
  const inside = typeof current === 'string' &&
    path.resolve(current).startsWith(path.resolve(tmpRoot));

  if (!inside) {
    process.stderr.write(
      '\nABORT: refusing to ' + what + ' — the data directory is not the temporary one.\n' +
      '  EASY_DEVOPS_DATA_DIR: ' + (current ?? '(unset)') + '\n' +
      '  expected inside     : ' + tmpRoot + '\n'
    );
    process.exit(1);
  }
}

const procs = [];
let DASH = '';

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

function start(label, args, env, cwd = ROOT) {
  const p = spawn(process.execPath, args, {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  procs.push({ label, p });
  // Accumulated, not discarded: the first-run setup code is printed here, and
  // this is one of the two places it is allowed to appear.
  p.output = '';
  p.stdout.on('data', (d) => { p.output += d; });
  p.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) process.stderr.write(`[${label}] ${s.slice(0, 200)}\n`);
  });
  return p;
}

async function stopAll() {
  for (const { p } of procs) {
    if (p.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        p.kill('SIGTERM');
      }
    } catch { /* already gone */ }
    await Promise.race([once(p, 'exit'), new Promise((r) => setTimeout(r, 4000))]);
  }
  procs.length = 0;
}

async function waitFor(url, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not come up at ${url}`);
}

/**
 * One HTTP call. `cookie` is passed explicitly rather than kept globally, so a
 * test can deliberately make an UNAUTHENTICATED request even after another
 * test has signed in — which is the whole point of this suite.
 */
async function req(method, pathname, { body, cookie, noHeader, headers } = {}) {
  const res = await fetch(`${DASH}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // Sent by default because a real dashboard client always sends it;
      // `noHeader` omits it so the guard itself can be tested.
      ...(noHeader ? {} : { 'X-EZ-Request': '1' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return {
    status: res.status,
    body: json,
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

/**
 * A request with full control over the headers, including Host.
 *
 * fetch() cannot do this: Host is a forbidden header name, and undici
 * silently drops an override — which made the Host assertions pass for the
 * wrong reason until this was noticed. node:http sends what it is given.
 *
 * @param {string} method
 * @param {string} pathname
 * @param {Object} opts
 * @param {number} opts.targetPort  The port to connect to
 * @param {string} [opts.host]      Host header to send verbatim
 * @param {string} [opts.origin]
 * @param {string} [opts.cookie]
 * @param {boolean} [opts.header=true] Send X-EZ-Request
 * @param {Object} [opts.body]
 */
function rawReq(method, pathname, {
  targetPort, host, origin, cookie, header = true, body,
} = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };
    if (host !== undefined) headers.Host = host;
    if (origin !== undefined) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    if (header) headers['X-EZ-Request'] = '1';
    if (payload !== null) headers['Content-Length'] = Buffer.byteLength(payload);

    const request = http.request(
      { host: '127.0.0.1', port: targetPort, path: pathname, method, headers, timeout: 10_000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );

    request.on('timeout', () => { request.destroy(); resolve({ status: null, body: null }); });
    request.on('error', (err) => resolve({ status: null, body: null, error: err.message }));
    if (payload !== null) request.write(payload);
    request.end();
  });
}

/** Every API endpoint that must refuse an anonymous caller. */
const PROTECTED = [
  ['GET', '/api/domains'],
  ['POST', '/api/domains'],
  ['PUT', '/api/domains/example.com'],
  ['DELETE', '/api/domains/example.com'],
  ['PUT', '/api/domains/example.com/toggle'],
  ['POST', '/api/domains/example.com/reload'],
  ['GET', '/api/ssl'],
  ['POST', '/api/ssl/create'],
  ['POST', '/api/ssl/renew/example.com'],
  ['POST', '/api/ssl/renew-all'],
  ['GET', '/api/nginx/status'],
  ['POST', '/api/nginx/reload'],
  ['GET', '/api/nginx/configs'],
  ['GET', '/api/nginx/logs'],
  ['GET', '/api/settings'],
  ['POST', '/api/settings'],
  ['GET', '/api/settings/permissions'],
  ['GET', '/api/settings/backup'],
  ['POST', '/api/settings/restore'],
  ['GET', '/api/settings/channels'],
  ['POST', '/api/settings/channels'],
  ['GET', '/api/hub/status'],
  ['POST', '/api/hub/connect'],
  ['DELETE', '/api/hub/link'],
  ['PUT', '/api/hub/permissions'],
  ['GET', '/api/processes'],
  ['POST', '/api/processes/x/restart'],
  ['GET', '/api/service'],
  ['POST', '/api/service/restart'],
];

async function main() {
  const port = await freePort();
  DASH = `http://localhost:${port}`;

  const legacyBefore = fs.existsSync(REAL_LEGACY_DB) ? fs.statSync(REAL_LEGACY_DB).mtimeMs : null;

  const env = { ...process.env, EASY_DEVOPS_DATA_DIR: dataDir, DASHBOARD_PORT: String(port) };

  process.stdout.write(`\nport ${port}\ndata ${dataDir}\n`);

  const server = start('dashboard', [path.join('src', 'dashboard', 'server.js')], env);
  await waitFor(DASH, 'dashboard');

  // ── (1) First run ─────────────────────────────────────────────────────────
  setGroup('(1) first run, with no password set');

  check('the test is isolated to a temporary data directory',
    process.env.EASY_DEVOPS_DATA_DIR === dataDir, process.env.EASY_DEVOPS_DATA_DIR ?? '(unset)');

  // The minimum length has one home: MIN_PASSWORD_LENGTH in core/passwords.js.
  // The test reads it from there and checks that the API agrees, so changing
  // the constant cannot leave the endpoint — or this test — behind.
  assertTempDataDir('import core/passwords.js');
  const { MIN_PASSWORD_LENGTH } = await import(
    pathToFileURL(path.join(ROOT, 'src/core/passwords.js')).href
  );

  const fresh = await req('GET', '/api/auth');
  check('the session check is public', fresh.status === 200, `status ${fresh.status}`);
  check('it reports not authenticated', fresh.body?.authenticated === false);
  check('it reports that setup is needed', fresh.body?.needsSetup === true);
  check('it publishes the minimum length from the constant',
    fresh.body?.minPasswordLength === MIN_PASSWORD_LENGTH,
    `api ${fresh.body?.minPasswordLength} vs constant ${MIN_PASSWORD_LENGTH}`);
  // Pinned separately, so a change to the constant is a deliberate decision
  // rather than something a passing suite hides.
  check('the documented minimum is 6', MIN_PASSWORD_LENGTH === 6,
    String(MIN_PASSWORD_LENGTH));

  // The original hole: an empty password matched an empty stored password.
  const blank = await req('POST', '/api/login', { body: { password: '' } });
  check('an EMPTY password is refused', blank.status === 401, `status ${blank.status}`);
  check('the refusal points at setup', blank.body?.needsSetup === true);

  const missing = await req('POST', '/api/login', { body: {} });
  check('a missing password field is refused', missing.status === 401, `status ${missing.status}`);

  const anyPass = await req('POST', '/api/login', { body: { password: 'anything' } });
  check('any password is refused while none is set', anyPass.status === 401);

  // Even in this state nothing may be reachable.
  const beforeSetup = await req('GET', '/api/domains');
  check('the API is closed before setup too', beforeSetup.status === 401,
    `status ${beforeSetup.status}`);

  // ── (2) Setup ─────────────────────────────────────────────────────────────
  setGroup('(2) setting the first password');

  // One character under the minimum, built from the constant so the boundary
  // moves with it.
  // First-run setup now needs the one-time code the server printed. Read it
  // the way a user does - off the server's own output - and assert that it
  // really is printed there, because that is what makes the code obtainable at
  // all. The code is then re-issued through core/setupCode.js so the rest of
  // this section does not depend on a log flushing in time.
  const printedCode = await waitForSetupCode(() => server.output ?? '', { timeoutMs: 15_000 });
  check('the server printed a first-run setup code', /^\d{6}$/.test(printedCode ?? ''),
    printedCode ?? (server.output ?? '').slice(-200));

  const authBefore = await req('GET', '/api/auth');
  check('and GET /api/auth says one is required',
    authBefore.body?.setupCodeRequired === true, JSON.stringify(authBefore.body));
  check('without putting the code in the response',
    !JSON.stringify(authBefore.body ?? {}).includes(printedCode ?? 'none'),
    JSON.stringify(authBefore.body));

  const setupCode = await issueSetupCode({ dataDir });

  const noCode = await req('POST', '/api/setup', { body: { password: PASSWORD } });
  check('setup without the code is refused', noCode.status === 400, `status ${noCode.status}`);

  const justTooShort = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
  const tooShort = await req('POST', '/api/setup', { body: { password: justTooShort, setupCode } });
  check(`a password of ${justTooShort.length} characters is rejected`,
    tooShort.status === 400, `status ${tooShort.status}`);
  check('the error states the minimum',
    new RegExp(`${MIN_PASSWORD_LENGTH} characters`).test(tooShort.body?.error ?? ''),
    tooShort.body?.error ?? '');

  const emptySetup = await req('POST', '/api/setup', { body: { password: '', setupCode } });
  check('an empty password cannot be set', emptySetup.status === 400);

  // Exactly the minimum is acceptable: the boundary is inclusive.
  const atMinimum = 'a'.repeat(MIN_PASSWORD_LENGTH);
  check(`validateNewPassword accepts exactly ${MIN_PASSWORD_LENGTH} characters`,
    (await import(pathToFileURL(path.join(ROOT, 'src/core/passwords.js')).href))
      .validateNewPassword(atMinimum) === null);
  check(`validateNewPassword rejects ${MIN_PASSWORD_LENGTH - 1}`,
    typeof (await import(pathToFileURL(path.join(ROOT, 'src/core/passwords.js')).href))
      .validateNewPassword(justTooShort) === 'string');

  const setup = await req('POST', '/api/setup', { body: { password: PASSWORD, setupCode } });
  check('a valid password is accepted', setup.status === 200, `status ${setup.status}`);
  check('setup signs the user in', Boolean(setup.cookie), String(setup.cookie));
  const sessionCookie = setup.cookie;

  const afterSetup = await req('GET', '/api/auth', { cookie: sessionCookie });
  check('the session is authenticated', afterSetup.body?.authenticated === true);
  check('setup is no longer needed', afterSetup.body?.needsSetup === false);

  const secondSetup = await req('POST', '/api/setup', { body: { password: 'another-password', setupCode } });
  check('setup cannot be run again to take the install over',
    secondSetup.status === 409, `status ${secondSetup.status}`);

  // ── (3) Every router refuses an anonymous caller ─────────────────────────
  setGroup('(3) every API router returns 401 without a session');

  let anonFailures = 0;
  for (const [method, pathname] of PROTECTED) {
    // fetch() refuses a body on GET/HEAD.
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const r = await req(method, pathname, hasBody ? { body: {} } : {});
    const ok = r.status === 401;
    if (!ok) anonFailures++;
    check(`${method} ${pathname}`, ok, ok ? '' : `got ${r.status}`);
  }
  check('no protected endpoint answered without a session', anonFailures === 0,
    `${anonFailures} leaked`);

  // ── (4) The same endpoints work WITH a session ───────────────────────────
  setGroup('(4) the same endpoints work with a session');

  const withSession = await req('GET', '/api/domains', { cookie: sessionCookie });
  check('GET /api/domains succeeds when signed in', withSession.status === 200,
    `status ${withSession.status}`);

  const settings = await req('GET', '/api/settings', { cookie: sessionCookie });
  check('GET /api/settings succeeds when signed in', settings.status === 200);
  check('settings never return the password',
    !('dashboardPassword' in (settings.body ?? {})));
  check('settings never return the password hash',
    !('dashboardPasswordHash' in (settings.body ?? {})));
  check('settings report the bind address',
    typeof settings.body?.dashboardBindAddress === 'string',
    String(settings.body?.dashboardBindAddress));

  const hubStatus = await req('GET', '/api/hub/status', { cookie: sessionCookie });
  check('the hub router still works when signed in', hubStatus.status === 200);

  const backup = await req('GET', '/api/settings/backup', { cookie: sessionCookie });
  check('a backup never contains the password',
    !JSON.stringify(backup.body ?? {}).includes('dashboardPassword'),
    'checked both the plain field and the hash');

  // ── (5) Login ─────────────────────────────────────────────────────────────
  setGroup('(5) login against the stored password');

  const wrong = await req('POST', '/api/login', { body: { password: 'not-it' } });
  check('a wrong password is refused', wrong.status === 401);

  const right = await req('POST', '/api/login', { body: { password: PASSWORD } });
  check('the right password is accepted', right.status === 200, `status ${right.status}`);
  check('login issues a session cookie', Boolean(right.cookie));

  // Session fixation: the cookie must change when the session is created.
  check('the session id is regenerated on login', right.cookie !== sessionCookie,
    'a pre-login session id must not become an authenticated one');

  const loggedIn = await req('GET', '/api/domains', { cookie: right.cookie });
  check('the new session works', loggedIn.status === 200);

  // ── (6) Logout ────────────────────────────────────────────────────────────
  setGroup('(6) logout ends the session');

  await req('POST', '/api/logout', { cookie: right.cookie });
  const afterLogout = await req('GET', '/api/domains', { cookie: right.cookie });
  check('the API refuses the session after logout', afterLogout.status === 401,
    `status ${afterLogout.status}`);

  // ── (7) Socket.io ─────────────────────────────────────────────────────────
  setGroup('(7) Socket.io requires a session too');

  // Reused by the later cross-site sections too.
  const { io } = await import(
    pathToFileURL(path.join(ROOT, 'node_modules/socket.io-client/build/esm/index.js')).href
  );

  const anonSocket = io(DASH, { transports: ['websocket'], reconnection: false });
  const anonOutcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 10_000);
    anonSocket.on('connect', () => { clearTimeout(timer); resolve('connected'); });
    anonSocket.on('connect_error', () => { clearTimeout(timer); resolve('refused'); });
  });
  anonSocket.disconnect();
  check('an anonymous socket is refused', anonOutcome === 'refused', anonOutcome);

  const authed = await req('POST', '/api/login', { body: { password: PASSWORD } });
  const authSocket = io(DASH, {
    transports: ['websocket'],
    reconnection: false,
    // X-EZ-Request is required on the handshake as well — see section 12.
    extraHeaders: { Cookie: authed.cookie, 'X-EZ-Request': '1' },
  });

  // Replay-on-connect, for the state-like events. A tab that opens between
  // two polls would otherwise render nothing, and `service:changed` matters
  // most of the three: the background service is already running or not when
  // the tab opens, and nothing else will say so until it next changes.
  const replayed = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5_000);
    authSocket.on('service:changed', (payload) => { clearTimeout(timer); resolve(payload); });
  });

  const authOutcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 10_000);
    authSocket.on('connect', () => { clearTimeout(timer); resolve('connected'); });
    authSocket.on('connect_error', (e) => { clearTimeout(timer); resolve(`refused: ${e.message}`); });
  });
  check('a socket with a session connects', authOutcome === 'connected', authOutcome);

  const state = await replayed;
  authSocket.disconnect();
  check('it is told the background service state on connect', state !== null, state ? '' : 'nothing arrived within 5s');
  check(
    'and that state is the contract shape',
    Boolean(state) && typeof state.running === 'boolean' && 'mechanism' in state && 'connected' in state,
    state ? Object.keys(state).join(',') : '',
  );

  // ── (8) Rate limiting ─────────────────────────────────────────────────────
  setGroup('(8) login is rate limited');

  // 10 per 15 minutes per IP. The successful logins above already consumed
  // some of this window, so drive it until it trips rather than assuming a
  // fixed count.
  let limited = null;
  for (let i = 0; i < 20 && limited === null; i++) {
    const r = await req('POST', '/api/login', { body: { password: 'wrong-guess' } });
    if (r.status === 429) limited = { attempt: i + 1, body: r.body };
  }
  check('repeated attempts are eventually refused with 429', limited !== null,
    limited ? `after ${limited.attempt} more attempt(s)` : 'never limited in 20 tries');
  check('the 429 says when to retry',
    typeof limited?.body?.retryAfterSeconds === 'number' && limited.body.retryAfterSeconds > 0,
    String(limited?.body?.retryAfterSeconds));

  // The limiter must not become an authentication bypass.
  const rightWhileLimited = await req('POST', '/api/login', { body: { password: PASSWORD } });
  check('a correct password is still refused while limited',
    rightWhileLimited.status === 429, `status ${rightWhileLimited.status}`);
  const stillClosed = await req('GET', '/api/domains');
  check('the API is still closed while limited', stillClosed.status === 401);

  // ── (9) Hashing at rest ───────────────────────────────────────────────────
  setGroup('(9) the password is stored hashed');

  await stopAll();

  assertTempDataDir('import core/config.js');
  const cfgMod = await import(
    pathToFileURL(path.join(ROOT, 'src/core/config.js')).href + `?auth=${Date.now()}`
  );
  const stored = cfgMod.loadConfig();

  check('no plain-text password is stored',
    !stored.dashboardPassword, JSON.stringify(stored.dashboardPassword));
  check('a scrypt hash is stored',
    typeof stored.dashboardPasswordHash === 'string' &&
    stored.dashboardPasswordHash.startsWith('scrypt$'),
    String(stored.dashboardPasswordHash).slice(0, 24));
  check('the hash does not contain the password',
    !stored.dashboardPasswordHash.includes(PASSWORD));
  check('the hash carries its cost parameters',
    stored.dashboardPasswordHash.split('$').length === 6,
    `${stored.dashboardPasswordHash.split('$').length} fields`);

  assertTempDataDir('import core/passwords.js');
  const pw = await import(pathToFileURL(path.join(ROOT, 'src/core/passwords.js')).href);
  check('the stored hash verifies the password',
    (await pw.verifyPassword(PASSWORD, stored.dashboardPasswordHash)) === true);
  check('it rejects a wrong password',
    (await pw.verifyPassword('wrong', stored.dashboardPasswordHash)) === false);
  check('two hashes of the same password differ (random salt)',
    (await pw.hashPassword(PASSWORD)) !== (await pw.hashPassword(PASSWORD)));
  check('a malformed stored hash fails closed, not loudly',
    (await pw.verifyPassword(PASSWORD, 'scrypt$not$a$real$hash$here')) === false);

  // ── (10) Migrating a legacy plain-text password ──────────────────────────
  setGroup('(10) a legacy plain-text password migrates on login');

  const legacyPassword = 'legacy-plain-text-pw';
  assertTempDataDir('write a legacy password');
  cfgMod.saveConfig({
    ...stored,
    dashboardPassword: legacyPassword,
    dashboardPasswordHash: '',
  });

  const port2 = await freePort();
  DASH = `http://localhost:${port2}`;
  start('dashboard2', [path.join('src', 'dashboard', 'server.js')], {
    ...process.env, EASY_DEVOPS_DATA_DIR: dataDir, DASHBOARD_PORT: String(port2),
  });
  await waitFor(DASH, 'dashboard2');

  const legacyAuth = await req('GET', '/api/auth');
  check('a legacy password counts as set', legacyAuth.body?.needsSetup === false);

  const legacyWrong = await req('POST', '/api/login', { body: { password: 'nope' } });
  check('a wrong password is still refused', legacyWrong.status === 401);

  const legacyLogin = await req('POST', '/api/login', { body: { password: legacyPassword } });
  check('the legacy plain-text password still works', legacyLogin.status === 200,
    `status ${legacyLogin.status}`);

  await stopAll();

  assertTempDataDir('re-read the config');
  const after = (await import(
    pathToFileURL(path.join(ROOT, 'src/core/config.js')).href + `?auth2=${Date.now()}`
  )).loadConfig();

  check('the plain-text copy is cleared after migration',
    !after.dashboardPassword, JSON.stringify(after.dashboardPassword));
  check('a hash replaced it',
    typeof after.dashboardPasswordHash === 'string' &&
    after.dashboardPasswordHash.startsWith('scrypt$'));
  check('the migrated hash verifies the same password',
    (await pw.verifyPassword(legacyPassword, after.dashboardPasswordHash)) === true);

  // ── (11) Bind address ─────────────────────────────────────────────────────
  setGroup('(11) bind address');

  check('a fresh install records a bind address',
    typeof after.dashboardBindAddress === 'string' && after.dashboardBindAddress.length > 0,
    after.dashboardBindAddress);
  check('a fresh install on Linux binds to loopback only',
    process.platform === 'win32' || after.dashboardBindAddress === '127.0.0.1',
    `${process.platform}: ${after.dashboardBindAddress}`);

  // An EXISTING install predates the setting and was listening everywhere.
  // Upgrading must not silently move it to loopback.
  const upgradeDir = path.join(tmpRoot, 'upgrade');
  fs.mkdirSync(upgradeDir, { recursive: true });
  fs.writeFileSync(path.join(upgradeDir, 'easy-devops.sqlite'), '');

  const upgradeProbe = path.join(tmpRoot, 'upgrade-probe.mjs');
  fs.writeFileSync(upgradeProbe, [
    "import { pathToFileURL } from 'node:url';",
    `const ROOT = ${JSON.stringify(ROOT)};`,
    "const db = await import(pathToFileURL(ROOT + '/src/core/db.js').href);",
    "// A config written by an older version: no bind address field at all.",
    "db.dbSet('config', { dashboardPort: 6443, nginxDir: '/etc/nginx', sslDir: '/x' });",
    "const cfg = await import(pathToFileURL(ROOT + '/src/core/config.js').href);",
    "process.stdout.write('__BIND__' + cfg.loadConfig().dashboardBindAddress);",
  ].join('\n'));

  const probeOut = await new Promise((resolve) => {
    const p = spawn(process.execPath, [upgradeProbe], {
      cwd: ROOT,
      env: { ...process.env, EASY_DEVOPS_DATA_DIR: upgradeDir },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', () => resolve(out));
  });

  const bindAfterUpgrade = probeOut.includes('__BIND__')
    ? probeOut.slice(probeOut.indexOf('__BIND__') + 8).trim()
    : null;
  check('an existing install keeps listening on all interfaces after upgrade',
    bindAfterUpgrade === '0.0.0.0', String(bindAfterUpgrade));


  // ── (12) Host / Origin / X-EZ-Request, in BOTH auth modes ────────────────
  setGroup('(12) requests from other websites are refused');

  // Sections 9 and 10 stopped their dashboards, so these sections get their
  // own: a fresh data directory, bound to loopback, with a known password.
  const xsiteDir = path.join(tmpRoot, 'data-xsite');
  fs.mkdirSync(xsiteDir, { recursive: true });
  fs.writeFileSync(path.join(xsiteDir, 'easy-devops.sqlite'), '');

  const port3 = await freePort();
  DASH = 'http://localhost:' + port3;
  start('dashboard3', [path.join('src', 'dashboard', 'server.js')], {
    ...process.env,
    EZ_TEST: '1',
    EASY_DEVOPS_DATA_DIR: xsiteDir,
    DASHBOARD_PORT: String(port3),
    // Bound to loopback regardless of the platform default, because the Host
    // rules below depend on which bind is in force.
    DASHBOARD_BIND_ADDRESS: '127.0.0.1',
  });
  await waitFor(DASH, 'dashboard3');

  // A separate data directory, so a separate outstanding setup code.
  const xsiteCode = await issueSetupCode({ dataDir: xsiteDir });
  const xsiteSetup = await req('POST', '/api/setup', {
    body: { password: PASSWORD, setupCode: xsiteCode },
  });
  check('a password was set for the cross-site tests', xsiteSetup.status === 200,
    'status ' + xsiteSetup.status);

  // The guard reads the bind address from the CONFIG, not from the listener,
  // so a loopback-only rule needs the config to say loopback. A fresh config
  // on Windows defaults to 0.0.0.0, where the rule is same-origin instead.
  const xsiteLoopback = await req('POST', '/api/settings', {
    cookie: xsiteSetup.cookie, body: { dashboardBindAddress: '127.0.0.1' },
  });
  check('the dashboard is configured for loopback only', xsiteLoopback.status === 200,
    'status ' + xsiteLoopback.status);

  // A session cookie protects nothing from a page the user has open in
  // another tab. These checks are what make that attacker fail, and they
  // apply whether or not a password is configured.

  const signedIn = await req('POST', '/api/login', { body: { password: PASSWORD } });
  const sess = signedIn.cookie;
  check('signed in for the cross-site tests', signedIn.status === 200, 'status ' + signedIn.status);

  // A state-changing request without the custom header: the shape a
  // cross-site form POST has, since a form cannot set one.
  const noHeaderPost = await req('POST', '/api/settings', {
    cookie: sess, noHeader: true, body: { acmeEmail: 'x@example.com' },
  });
  check('a state-changing request without X-EZ-Request is refused',
    noHeaderPost.status === 403, 'status ' + noHeaderPost.status);
  check('the refusal is 403, not 401 (a login cannot fix it)',
    noHeaderPost.status === 403 && noHeaderPost.body?.reason === 'missing_request_header',
    String(noHeaderPost.body?.reason));

  for (const method of ['PUT', 'DELETE']) {
    const r = await req(method, '/api/domains/example.com', { cookie: sess, noHeader: true, body: {} });
    check(method + ' without the header is refused', r.status === 403, 'status ' + r.status);
  }

  // GET is not state-changing, so the header is not demanded there — the
  // page itself must still load.
  const getNoHeader = await req('GET', '/api/domains', { cookie: sess, noHeader: true });
  check('a GET without the header still works', getNoHeader.status === 200,
    'status ' + getNoHeader.status);

  // With the header, the same write is accepted.
  const withHeader = await req('POST', '/api/settings', {
    cookie: sess, body: { acmeEmail: 'ok@example.com' },
  });
  check('the same request with the header succeeds', withHeader.status === 200,
    'status ' + withHeader.status);

  // A hostile Origin, which is what a cross-site fetch sends.
  const badOrigin = await req('POST', '/api/settings', {
    cookie: sess,
    headers: { Origin: 'http://evil.example.com' },
    body: { acmeEmail: 'ok@example.com' },
  });
  check('a cross-site Origin is refused', badOrigin.status === 403, 'status ' + badOrigin.status);

  // A hostile Host, which is what DNS rebinding produces. Sent through
  // rawReq because fetch() refuses to set Host.
  const badHost = await rawReq('GET', '/api/domains', {
    targetPort: port3, cookie: sess, host: 'evil.example.com:' + port3,
  });
  check('a non-loopback Host is refused on a loopback-bound dashboard',
    badHost.status === 403, 'status ' + badHost.status);

  // The right hostname on the wrong port is still someone else talking.
  const badPort = await rawReq('GET', '/api/domains', {
    targetPort: port3, cookie: sess, host: 'localhost:1',
  });
  check('a Host with the wrong port is refused', badPort.status === 403,
    'status ' + badPort.status);

  // Loopback aliases must all be accepted, or the dashboard becomes
  // unreachable depending on how the user typed the URL.
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const r = await rawReq('GET', '/api/domains', {
      targetPort: port3, cookie: sess, host: host + ':' + port3,
    });
    check('Host ' + host + ' is accepted', r.status === 200, 'status ' + r.status);
  }

  // Proof that rawReq really does send Host, so the two refusals above are
  // meaningful rather than passing for some unrelated reason.
  const forgedHostSeen = await rawReq('GET', '/api/domains', {
    targetPort: port3, cookie: sess, host: 'evil.example.com:' + port3,
  });
  check('the refusal names the Host rule',
    forgedHostSeen.body?.reason === 'host_not_local', String(forgedHostSeen.body?.reason));

  // The socket handshake is held to the same rule.
  const noHeaderSocket = io(DASH, {
    transports: ['websocket'], reconnection: false,
    extraHeaders: { Cookie: sess },
  });
  const noHeaderOutcome = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 10000);
    noHeaderSocket.on('connect', () => { clearTimeout(t); resolve('connected'); });
    noHeaderSocket.on('connect_error', () => { clearTimeout(t); resolve('refused'); });
  });
  noHeaderSocket.disconnect();
  check('a socket handshake without the header is refused',
    noHeaderOutcome === 'refused', noHeaderOutcome);

  const okSocket = io(DASH, {
    transports: ['websocket'], reconnection: false,
    extraHeaders: { Cookie: sess, 'X-EZ-Request': '1' },
  });
  const okOutcome = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 10000);
    okSocket.on('connect', () => { clearTimeout(t); resolve('connected'); });
    okSocket.on('connect_error', (e) => { clearTimeout(t); resolve('refused: ' + e.message); });
  });
  okSocket.disconnect();
  check('a socket handshake with the header connects', okOutcome === 'connected', okOutcome);

  // ── (13) Switching to "no password" ─────────────────────────────────────
  setGroup('(13) dashboardAuth: none requires a loopback bind');

  // This dashboard is bound to loopback in the test environment only when
  // the platform default says so, so set it explicitly first.
  const toLoopback = await req('POST', '/api/settings', {
    cookie: sess, body: { dashboardBindAddress: '127.0.0.1' },
  });
  check('bind can be set to loopback', toLoopback.status === 200, 'status ' + toLoopback.status);

  const settingsNow = await req('GET', '/api/settings', { cookie: sess });
  check('settings report the auth mode', settingsNow.body?.dashboardAuth === 'password',
    String(settingsNow.body?.dashboardAuth));
  check('settings say no-password is available on loopback',
    settingsNow.body?.canUseNoPassword === true, String(settingsNow.body?.canUseNoPassword));

  const toNone = await req('POST', '/api/settings', {
    cookie: sess, body: { dashboardAuth: 'none' },
  });
  check('switching to none is allowed on a loopback bind', toNone.status === 200,
    'status ' + toNone.status);
  check('the response reports the new mode', toNone.body?.dashboardAuth === 'none',
    String(toNone.body?.dashboardAuth));

  // ── (14) With no password, the API is open but still guarded ────────────
  setGroup('(14) with auth none, no session is needed');

  const anonNow = await req('GET', '/api/domains');
  check('a request with no session succeeds', anonNow.status === 200,
    'status ' + anonNow.status);

  const authState = await req('GET', '/api/auth');
  check('the auth check reports authenticated', authState.body?.authenticated === true);
  check('it reports the none mode', authState.body?.authMode === 'none',
    String(authState.body?.authMode));
  check('it no longer asks for setup', authState.body?.needsSetup === false);

  const loginNow = await req('POST', '/api/login', { body: { password: PASSWORD } });
  check('login reports that there is nothing to log into', loginNow.status === 409,
    'status ' + loginNow.status);

  // The cross-site protections must NOT be relaxed just because there is no
  // password — this is the mode where they are the only defence left.
  const anonNoHeader = await req('POST', '/api/settings', {
    noHeader: true, body: { acmeEmail: 'x@example.com' },
  });
  check('a write without the header is still refused with auth none',
    anonNoHeader.status === 403, 'status ' + anonNoHeader.status);

  const anonBadOrigin = await req('POST', '/api/settings', {
    headers: { Origin: 'http://evil.example.com' }, body: { acmeEmail: 'x@example.com' },
  });
  check('a cross-site Origin is still refused with auth none',
    anonBadOrigin.status === 403, 'status ' + anonBadOrigin.status);

  const anonBadHost = await rawReq('GET', '/api/domains', {
    targetPort: port3, host: 'evil.example.com:' + port3,
  });
  check('a rebinding Host is still refused with auth none',
    anonBadHost.status === 403, 'status ' + anonBadHost.status);

  const anonSocketNoHeader = io(DASH, { transports: ['websocket'], reconnection: false });
  const anonSocketOutcome = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 10000);
    anonSocketNoHeader.on('connect', () => { clearTimeout(t); resolve('connected'); });
    anonSocketNoHeader.on('connect_error', () => { clearTimeout(t); resolve('refused'); });
  });
  anonSocketNoHeader.disconnect();
  check('a socket without the header is still refused with auth none',
    anonSocketOutcome === 'refused', anonSocketOutcome);

  const anonSocketOk = io(DASH, {
    transports: ['websocket'], reconnection: false,
    extraHeaders: { 'X-EZ-Request': '1' },
  });
  const anonSocketOkOutcome = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 10000);
    anonSocketOk.on('connect', () => { clearTimeout(t); resolve('connected'); });
    anonSocketOk.on('connect_error', (e) => { clearTimeout(t); resolve('refused: ' + e.message); });
  });
  anonSocketOk.disconnect();
  check('a socket with the header connects without a session',
    anonSocketOkOutcome === 'connected', anonSocketOkOutcome);

  // ── (15) The bind address is locked while there is no password ──────────
  setGroup('(15) the bind address cannot be opened up while auth is none');

  const openUp = await req('POST', '/api/settings', {
    body: { dashboardBindAddress: '0.0.0.0' },
  });
  check('changing the bind away from loopback is refused', openUp.status === 400,
    'status ' + openUp.status);
  check('the reason names the interlock',
    openUp.body?.reason === 'bind_requires_password', String(openUp.body?.reason));
  check('the error tells the user to set a password first',
    /set a password first/i.test(openUp.body?.error ?? ''), openUp.body?.error ?? '');

  // Both in one request must not slip through by checking each against the
  // OLD value.
  const bothAtOnce = await req('POST', '/api/settings', {
    body: { dashboardAuth: 'none', dashboardBindAddress: '0.0.0.0' },
  });
  check('setting none and a public bind together is refused',
    bothAtOnce.status === 400, 'status ' + bothAtOnce.status);

  const stillLoopback = await req('GET', '/api/settings');
  check('the bind address did not change', stillLoopback.body?.dashboardBindAddress === '127.0.0.1',
    String(stillLoopback.body?.dashboardBindAddress));

  // Setting a password and opening the bind together IS allowed.
  const withPassword = await req('POST', '/api/settings', {
    body: { dashboardAuth: 'password', dashboardPassword: PASSWORD, dashboardBindAddress: '0.0.0.0' },
  });
  check('setting a password and opening the bind together is allowed',
    withPassword.status === 200, 'status ' + withPassword.status);

  // ── (16) With a public bind, none is refused ────────────────────────────
  setGroup('(16) none is refused while the bind is public');

  const relogin = await req('POST', '/api/login', { body: { password: PASSWORD } });
  check('a password is required again', relogin.status === 200, 'status ' + relogin.status);
  const sess2 = relogin.cookie;

  const noneOnPublic = await req('POST', '/api/settings', {
    cookie: sess2, body: { dashboardAuth: 'none' },
  });
  check('switching to none on a public bind is refused', noneOnPublic.status === 400,
    'status ' + noneOnPublic.status);
  check('the reason names the loopback requirement',
    noneOnPublic.body?.reason === 'no_auth_requires_loopback', String(noneOnPublic.body?.reason));

  const publicSettings = await req('GET', '/api/settings', { cookie: sess2 });
  check('settings say no-password is unavailable on a public bind',
    publicSettings.body?.canUseNoPassword === false,
    String(publicSettings.body?.canUseNoPassword));

  // With a non-loopback bind the Host rule relaxes to same-origin, so remote
  // access keeps working — but cross-site requests still do not.
  const remoteHost = await rawReq('GET', '/api/domains', {
    targetPort: port3, cookie: sess2, host: '192.168.1.50:' + port3,
  });
  check('a LAN Host is accepted once the bind is public', remoteHost.status === 200,
    'status ' + remoteHost.status);

  const remoteCrossSite = await rawReq('POST', '/api/settings', {
    targetPort: port3,
    cookie: sess2,
    host: '192.168.1.50:' + port3,
    origin: 'http://evil.example.com:' + port3,
    body: { acmeEmail: 'ok@example.com' },
  });
  check('a cross-site Origin is still refused on a public bind',
    remoteCrossSite.status === 403, 'status ' + remoteCrossSite.status);

  // Same-origin from that LAN address must keep working, or binding to all
  // interfaces would be pointless.
  const remoteSameOrigin = await rawReq('POST', '/api/settings', {
    targetPort: port3,
    cookie: sess2,
    host: '192.168.1.50:' + port3,
    origin: 'http://192.168.1.50:' + port3,
    body: { acmeEmail: 'ok@example.com' },
  });
  check('same-origin from a LAN address is accepted', remoteSameOrigin.status === 200,
    'status ' + remoteSameOrigin.status);


  // ── (17) Upgrading an existing install ──────────────────────────────────
  setGroup('(17) existing installs keep working, safely');

  // An empty password used to MEAN "no login". On a loopback-bound install
  // that is a legitimate choice and is preserved as an explicit none. With a
  // bind reachable from the network it is not, and those installs must set a
  // password instead.
  async function probeUpgrade(label, storedConfig) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "upg-"));
    fs.writeFileSync(path.join(dir, "easy-devops.sqlite"), "");

    const script = path.join(tmpRoot, "upgrade-" + label + ".mjs");
    fs.writeFileSync(script, [
      "import { pathToFileURL } from 'node:url';",
      "const ROOT = " + JSON.stringify(ROOT) + ";",
      "const db = await import(pathToFileURL(ROOT + '/src/core/db.js').href);",
      "db.dbSet('config', " + JSON.stringify(storedConfig) + ");",
      "const cfg = await import(pathToFileURL(ROOT + '/src/core/config.js').href);",
      "const c = cfg.loadConfig();",
      "process.stdout.write('__R__' + JSON.stringify({ auth: c.dashboardAuth, bind: c.dashboardBindAddress, effective: cfg.effectiveAuthMode(c) }));",
    ].join('\n'));

    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [script], {
        cwd: ROOT,
        env: { ...process.env, EZ_TEST: "1", EASY_DEVOPS_DATA_DIR: dir },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      let text = "";
      p.stdout.on("data", (d) => { text += d; });
      p.stderr.on("data", (d) => { text += d; });
      p.on("exit", () => resolve(text));
    });

    const marker = out.indexOf("__R__");
    if (marker === -1) throw new Error("upgrade probe produced no result: " + out.slice(0, 300));
    return JSON.parse(out.slice(marker + 5));
  }

  // Empty password, already bound to loopback -> keeps working as none.
  const upgLoopback = await probeUpgrade("loopback", {
    dashboardPort: 6443, dashboardPassword: "", dashboardBindAddress: "127.0.0.1",
  });
  check('empty password + loopback bind becomes an explicit none',
    upgLoopback.auth === 'none', JSON.stringify(upgLoopback));
  check('and none is actually in force there',
    upgLoopback.effective === 'none', upgLoopback.effective);

  // Empty password, no bind recorded -> the bind migrates to 0.0.0.0, so a
  // password is required.
  const upgLegacy = await probeUpgrade("legacy", {
    dashboardPort: 6443, dashboardPassword: "",
  });
  check('empty password + no recorded bind requires a password',
    upgLegacy.auth === 'password', JSON.stringify(upgLegacy));
  check('because that install was listening on every interface',
    upgLegacy.bind === '0.0.0.0', upgLegacy.bind);

  // Empty password, explicitly bound to all interfaces -> password.
  const upgPublic = await probeUpgrade("public", {
    dashboardPort: 6443, dashboardPassword: "", dashboardBindAddress: "0.0.0.0",
  });
  check('empty password + public bind requires a password',
    upgPublic.auth === 'password', JSON.stringify(upgPublic));

  // A password already set -> password mode, whatever the bind.
  const upgWithPw = await probeUpgrade("withpw", {
    dashboardPort: 6443, dashboardPassword: "legacy-pw", dashboardBindAddress: "127.0.0.1",
  });
  check('an existing password keeps password mode', upgWithPw.auth === 'password',
    JSON.stringify(upgWithPw));

  // Defence in depth: a hand-edited or restored config claiming none with a
  // public bind must not be honoured.
  const upgInconsistent = await probeUpgrade("inconsistent", {
    dashboardPort: 6443, dashboardAuth: "none", dashboardBindAddress: "0.0.0.0",
  });
  check('a stored none with a public bind is not honoured',
    upgInconsistent.effective === 'password', upgInconsistent.effective);

  return finish(legacyBefore);
}

async function finish(legacyBefore) {
  setGroup('teardown and isolation');

  await stopAll();

  const legacyAfter = fs.existsSync(REAL_LEGACY_DB) ? fs.statSync(REAL_LEGACY_DB).mtimeMs : null;
  check('real data/easy-devops.sqlite untouched', legacyAfter === legacyBefore);
  check('no .migrated file created', !fs.existsSync(`${REAL_LEGACY_DB}.migrated`));

  try {
    const dbMod = await import(pathToFileURL(path.join(ROOT, 'src/core/db.js')).href);
    dbMod.closeDb();
  } catch { /* never loaded */ }

  check('temp directory removed', rmWithRetry(tmpRoot), tmpRoot);

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(64)}\nTOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label} ${f.detail}\n`);
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

main().catch(async (err) => {
  process.stderr.write(`\nHarness error: ${err.stack}\n`);
  await stopAll();
  process.exit(1);
});
