/**
 * Tests for the one-time first-run setup code.
 *
 * Run with:  npm run test:e2e -- setup-code
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * Three things are under test, and the third is the one that would be easiest
 * to break later without noticing:
 *
 *   1. The code is REQUIRED to set a first password, and not required for the
 *      loopback-only "no password" choice.
 *   2. Guessing is bounded: per-IP rate limiting, a global cap that burns the
 *      code, and a 24-hour expiry. A wrong code is not distinguishable from a
 *      missing one.
 *   3. The code NEVER leaves the machine. Not in an API response, not in a
 *      Socket.io payload, not in anything the Hub agent sends, and not in the
 *      settings backup a user can download. Checked both dynamically (every
 *      payload this suite can produce is searched for the cleartext) and
 *      statically (only a named set of files may even mention it).
 *
 * Everything runs against the temporary data directory the runner provides.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n-- ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

/** A minimal Express `res` that records what was answered. */
function captureRes() {
  const out = { code: 200, body: null, headers: {} };
  return {
    out,
    status(code) { out.code = code; return this; },
    json(body) { out.body = body; return this; },
    setHeader(name, value) { out.headers[name] = value; return this; },
  };
}

/** A request from a given address, with an optional body. */
function req(body = {}, ip = '127.0.0.1') {
  return {
    body,
    ip,
    socket: { remoteAddress: ip },
    session: {
      authenticated: false,
      // The controller regenerates the session on success; the callback form
      // is what it expects.
      regenerate(cb) { cb(null); },
      destroy(cb) { cb(null); },
    },
  };
}

/** Puts the config back to "first run, password mode, loopback". */
async function resetToFirstRun() {
  const { dbSet } = await import(srcUrl('core/db.js'));
  dbSet('config', {
    dashboardPort: 0,
    dashboardAuth: 'password',
    dashboardBindAddress: '127.0.0.1',
    dashboardPasswordHash: '',
    dashboardPassword: '',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    nginxDir: path.join(TEST_DATA_DIR, 'no-such-nginx'),
    sslDir: path.join(TEST_DATA_DIR, 'no-such-ssl'),
    acmeEmail: '',
    os: process.platform,
  });
  dbSet('domains', []);
  dbSet('setup-code', null);
}

// ─── 1. Issuing and shape ────────────────────────────────────────────────────

async function testIssue() {
  setGroup('1. issuing a code');

  const setupCode = await import(srcUrl('core/setupCode.js'));
  const { dbGet } = await import(srcUrl('core/db.js'));
  await resetToFirstRun();

  const issued = await setupCode.issue();

  check('a code is issued', /^\d{6}$/.test(issued.code), issued.code);
  check('it expires in 24 hours',
    Math.abs(issued.expiresAt - Date.now() - setupCode.CODE_TTL_MS) < 5_000);

  // The stored form is the security property: a readable code in the database
  // is readable by everything that can read the database.
  const stored = dbGet('setup-code');
  check('only a hash is stored', typeof stored.hash === 'string' && stored.hash.startsWith('scrypt$'));
  check('the cleartext is nowhere in the stored record',
    !JSON.stringify(stored).includes(issued.code),
    JSON.stringify(stored).slice(0, 80));

  check('it is displayed with a space', setupCode.format(issued.code) === `${issued.code.slice(0, 3)} ${issued.code.slice(3)}`,
    setupCode.format(issued.code));
  check('and accepted either way',
    setupCode.normalize(setupCode.format(issued.code)) === issued.code);

  // The two places it may appear, and only those.
  const lines = setupCode.describe({ code: issued.code, expiresAt: issued.expiresAt }).join('\n');
  check('the printable block contains the code', lines.includes(setupCode.format(issued.code)));
  check('and is ASCII-only, for a legacy Windows console and a WinSW log',
    [...lines].every((c) => c.charCodeAt(0) <= 126),
    [...lines].filter((c) => c.charCodeAt(0) > 126).join(' '));

  // A second process that finds a valid code cannot re-print it: nothing
  // stores the cleartext. That is a property, not a shortcoming.
  const { loadConfig } = await import(srcUrl('core/config.js'));
  const again = await setupCode.ensureCode({ config: loadConfig() });
  check('a second process reports the code as outstanding, without it',
    again.pending === true && again.code === null && again.state === 'outstanding',
    JSON.stringify(again));

  return issued;
}

// ─── 2. Setup requires it ────────────────────────────────────────────────────

async function testSetupRequiresCode() {
  setGroup('2. setting a password requires the code');

  const { default: AuthController } = await import(srcUrl('dashboard/controllers/authController.js'));
  const setupCode = await import(srcUrl('core/setupCode.js'));
  const { resetAll } = await import(srcUrl('dashboard/lib/loginRateLimit.js'));
  const { loadConfig } = await import(srcUrl('core/config.js'));

  await resetToFirstRun();
  resetAll();
  const issued = await setupCode.issue();
  const controller = new AuthController();

  // GET /api/auth says a code is needed, without saying which.
  const authRes = captureRes();
  controller.check(req(), authRes);
  check('GET /api/auth reports setupCodeRequired', authRes.out.body.setupCodeRequired === true);
  check('and when it expires', typeof authRes.out.body.setupCodeExpiresAt === 'number');
  check('but never the code itself',
    !JSON.stringify(authRes.out.body).includes(issued.code),
    JSON.stringify(authRes.out.body));

  // No code at all.
  const missing = captureRes();
  await controller.setup(req({ password: 'correct-horse' }), missing);
  check('setup without a code is refused', missing.out.code === 400, String(missing.out.code));
  check('and no password was stored', loadConfig().dashboardPasswordHash === '');

  // A wrong code, and the message must not reveal which failure it was.
  const wrong = captureRes();
  await controller.setup(req({ password: 'correct-horse', setupCode: '000000' }), wrong);
  check('a wrong code is refused', wrong.out.code === 400, String(wrong.out.code));
  check('with the same message as a missing one',
    wrong.out.body.error === missing.out.body.error,
    `${missing.out.body.error} / ${wrong.out.body.error}`);

  // Too short, which is a different kind of wrong and must still not leak.
  const short = captureRes();
  await controller.setup(req({ password: 'correct-horse', setupCode: '12' }), short);
  check('a malformed code is refused', short.out.code === 400);

  // The real code, with the space, as a user would copy it off the screen.
  const right = captureRes();
  await controller.setup(req({ password: 'correct-horse', setupCode: setupCode.format(issued.code) }), right);
  check('the right code is accepted, spaces and all',
    right.out.code === 200 && right.out.body.ok === true,
    `${right.out.code} ${JSON.stringify(right.out.body)}`);
  check('the password is now set', loadConfig().dashboardPasswordHash.startsWith('scrypt$'));

  // Used once, gone.
  check('the code is cleared once a password exists', setupCode.required() === false);

  const after = captureRes();
  controller.check(req(), after);
  check('and GET /api/auth stops asking for one',
    after.out.body.setupCodeRequired === false && after.out.body.setupCodeExpiresAt === null,
    JSON.stringify({ r: after.out.body.setupCodeRequired, e: after.out.body.setupCodeExpiresAt }));

  // A used code must not work against the NEXT outstanding one. (With no code
  // outstanding at all, setup is deliberately open rather than impossible -
  // see required() in core/setupCode.js; in practice startup always issues
  // one, which is the state tested here.)
  await resetToFirstRun();
  resetAll();
  await setupCode.issue();

  const replay = captureRes();
  await controller.setup(req({ password: 'another-one', setupCode: issued.code }), replay);
  check('the previous code does not work against a newly issued one',
    replay.out.code === 400,
    `${replay.out.code} ${JSON.stringify(replay.out.body)}`);
  check('and the password is still unset', loadConfig().dashboardPasswordHash === '');
}

// ─── 3. No password needs no code ────────────────────────────────────────────

async function testNoPasswordPath() {
  setGroup('3. the no-password choice needs no code');

  const { default: AuthController } = await import(srcUrl('dashboard/controllers/authController.js'));
  const setupCode = await import(srcUrl('core/setupCode.js'));
  const { resetAll } = await import(srcUrl('dashboard/lib/loginRateLimit.js'));
  const { loadConfig } = await import(srcUrl('core/config.js'));

  await resetToFirstRun();
  resetAll();
  await setupCode.issue();
  const controller = new AuthController();

  const res = captureRes();
  await controller.setup(req({ mode: 'none' }), res);

  check('mode: none from loopback is accepted with no code',
    res.out.code === 200 && res.out.body.authMode === 'none',
    `${res.out.code} ${JSON.stringify(res.out.body)}`);
  check('because it already requires a loopback bind AND a loopback request',
    loadConfig().dashboardAuth === 'none');
  // Setup is finished either way, so the code must not stay outstanding for an
  // installation that will never ask for it.
  check('and the outstanding setup code is cleared',
    setupCode.required() === false && setupCode.publicState().state === 'none',
    JSON.stringify(setupCode.publicState()));

  // Still refused from elsewhere, code or no code.
  await resetToFirstRun();
  resetAll();
  await setupCode.issue();

  const remote = captureRes();
  await controller.setup(req({ mode: 'none' }, '203.0.113.9'), remote);
  check('and a remote request still cannot choose it', remote.out.code === 400, String(remote.out.code));
}

// ─── 4. Guessing is bounded ──────────────────────────────────────────────────

async function testLimits() {
  setGroup('4. guessing is bounded');

  const setupCode = await import(srcUrl('core/setupCode.js'));
  const { default: AuthController } = await import(srcUrl('dashboard/controllers/authController.js'));
  const { resetAll, LOGIN_RATE_LIMIT } = await import(srcUrl('dashboard/lib/loginRateLimit.js'));
  const { dbGet, dbSet } = await import(srcUrl('core/db.js'));

  // ── The global cap ────────────────────────────────────────────────────────
  await resetToFirstRun();
  resetAll();
  await setupCode.issue();

  let burnedAt = null;
  for (let attempt = 1; attempt <= setupCode.MAX_GLOBAL_FAILURES + 1; attempt += 1) {
    const result = await setupCode.verify('000000');
    if (result.burned && burnedAt === null) burnedAt = attempt;
  }

  check(`the code is burned after ${setupCode.MAX_GLOBAL_FAILURES} failures`,
    burnedAt === setupCode.MAX_GLOBAL_FAILURES,
    `burned at attempt ${burnedAt}`);

  // Burned means burned: even the right code no longer works, which is the
  // point — the only way back is the machine's own terminal.
  const record = dbGet('setup-code');
  check('a burned code stays burned', record.burned === true);
  check('and setup still requires a code rather than becoming open',
    setupCode.required() === true);

  const stillRequired = await setupCode.verify('000000');
  check('every further attempt reports burned, not invalid',
    stillRequired.reason === 'burned', stillRequired.reason);

  // Re-issuing from the terminal is the recovery path.
  const fresh = await setupCode.issue();
  const accepted = await setupCode.verify(fresh.code);
  check('issuing a new one from the terminal recovers it', accepted.ok === true, accepted.reason);

  // ── Expiry ────────────────────────────────────────────────────────────────
  const old = dbGet('setup-code');
  dbSet('setup-code', { ...old, issuedAt: Date.now() - setupCode.CODE_TTL_MS - 1, expiresAt: Date.now() - 1 });

  const expired = await setupCode.verify(fresh.code);
  check('an expired code is refused even when correct',
    expired.ok === false && expired.reason === 'expired', expired.reason);

  const state = setupCode.publicState();
  check('and the public state reports no expiry rather than a past one',
    state.required === true && state.expiresAt === null,
    JSON.stringify(state));

  // ensureCode re-issues an expired one, so a pending setup stays completable.
  const { loadConfig } = await import(srcUrl('core/config.js'));
  const reissued = await setupCode.ensureCode({ config: loadConfig() });
  check('a pending setup with an expired code gets a new one',
    reissued.pending === true && /^\d{6}$/.test(reissued.code ?? ''),
    reissued.state);

  // ── Per-IP rate limiting, in its own budget ───────────────────────────────
  await resetToFirstRun();
  resetAll();
  await setupCode.issue();
  const controller = new AuthController();

  let limitedAt = null;
  for (let attempt = 1; attempt <= LOGIN_RATE_LIMIT.MAX_ATTEMPTS + 2; attempt += 1) {
    const res = captureRes();
    await controller.setup(req({ password: 'correct-horse', setupCode: '000000' }, '198.51.100.7'), res);
    if (res.out.code === 429 && limitedAt === null) limitedAt = attempt;
  }

  check('setup attempts are rate limited per IP',
    limitedAt === LOGIN_RATE_LIMIT.MAX_ATTEMPTS + 1,
    `429 first seen at attempt ${limitedAt}`);

  // The separate budget: that IP is out of setup attempts but can still log in.
  const loginRes = captureRes();
  await controller.login(req({ password: 'whatever' }, '198.51.100.7'), loginRes);
  check('and the login budget is untouched by them',
    loginRes.out.code !== 429, String(loginRes.out.code));
}

// ─── 5. It never leaves the machine ──────────────────────────────────────────

/**
 * The property the user asked for, tested two ways.
 *
 * Dynamically: issue a code, then produce every payload this suite can reach
 * that a remote party could see, and search each one for the cleartext.
 *
 * Statically: only a named set of files may mention the code at all. That is
 * what catches a future change — a new telemetry field, a new socket event, a
 * Hub command that returns "diagnostics" — which a payload search cannot,
 * because it can only search the payloads that exist today.
 */
async function testNeverLeaves() {
  setGroup('5. the code never leaves the machine');

  const setupCode = await import(srcUrl('core/setupCode.js'));
  const { default: AuthController } = await import(srcUrl('dashboard/controllers/authController.js'));
  const { default: ProcessesController } = await import(srcUrl('dashboard/controllers/processesController.js'));
  const { default: SettingsController } = await import(srcUrl('dashboard/controllers/settingsController.js'));
  const { resetAll } = await import(srcUrl('dashboard/lib/loginRateLimit.js'));
  const { backgroundServiceState } = await import(srcUrl('core/service/index.js'));
  const { daemonStatus } = await import(srcUrl('dashboard/lib/daemonBridge.js'));

  await resetToFirstRun();
  resetAll();
  const issued = await setupCode.issue();
  const code = issued.code;
  const spaced = setupCode.format(issued.code);

  /** Searches a payload for the code in either form. */
  const leaks = (value) => {
    const text = JSON.stringify(value ?? null);
    return text.includes(code) || text.includes(spaced);
  };

  // Every response a client can obtain that might plausibly carry state.
  const payloads = {};

  const authRes = captureRes();
  new AuthController().check(req(), authRes);
  payloads['GET /api/auth'] = authRes.out.body;

  const serviceRes = captureRes();
  await new ProcessesController().status({}, serviceRes);
  payloads['GET /api/service'] = serviceRes.out.body;

  const settings = new SettingsController();
  const settingsRes = captureRes();
  settings.get(req(), settingsRes);
  payloads['GET /api/settings'] = settingsRes.out.body;

  // The downloadable backup is the subtle one: it is a file a user may send to
  // someone else, and it already strips the password hash.
  const backupRes = captureRes();
  settings.backup(req(), backupRes);
  payloads['GET /api/settings/backup'] = backupRes.out.body;

  // What the socket event and the Hub telemetry are built from.
  payloads['service:changed payload'] = daemonStatus();
  payloads['backgroundServiceState()'] = backgroundServiceState();

  for (const [name, payload] of Object.entries(payloads)) {
    check(`${name} does not carry the code`, !leaks(payload),
      leaks(payload) ? JSON.stringify(payload).slice(0, 160) : '');
  }

  // The Hub agent's own state push, built the same way it is sent.
  const agent = await import(srcUrl('core/hub/agent.js'));
  check('the Hub agent exposes no setup-code state',
    !leaks(agent.getHubAgentStatus?.() ?? null));

  // ── The static half ──────────────────────────────────────────────────────
  //
  // Searching today's payloads cannot catch tomorrow's. What CAN be checked is
  // the capability: there are exactly two ways to obtain the code - import
  // core/setupCode.js, or read its database key directly - so only a named set
  // of files may do either. A new telemetry field, socket event or Hub command
  // that reached for it would land here as a failure.
  //
  // Deliberately not a search for the words: `cli/index.js` names the command
  // in its help text and loginRateLimit.js names the module in a comment.
  // Neither can transmit anything, and failing on prose would train the next
  // person to add files to the allow-list to make the test quiet.
  const ALLOWED = new Set([
    'core/setupCode.js',                              // defines it
    'dashboard/controllers/authController.js',         // verifies it, never returns it
    'dashboard/server.js',                             // prints it to the local terminal
    'core/daemon/run.js',                              // prints it to the local service log
    'cli/menus/dashboard.js',                          // `ezz dashboard setup-code`
  ]);

  const canReach = (text) => (
    /from\s+['"][^'"]*setupCode\.js['"]/.test(text)
    || /import\(['"][^'"]*setupCode\.js['"]\)/.test(text)
    || /dbGet\(\s*['"]setup-code['"]/.test(text)
  );

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // The React UI is a separate package with its own tree, and it only ever
      // sees `setupCodeRequired` - the flag, never the code.
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || full.includes(path.join('dashboard', 'ui'))) continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;

      const rel = path.relative(path.join(ROOT, 'src'), full).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;

      if (canReach(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
    }
  };
  walk(path.join(ROOT, 'src'));

  check('nothing outside the terminal and the service log can even reach the code',
    offenders.length === 0,
    offenders.join(', '));

  // And the allow-list is honest: each named file really does reach for it, so
  // the list cannot rot into permitting files that stopped needing permission.
  const stale = [...ALLOWED].filter((rel) => {
    const full = path.join(ROOT, 'src', rel);
    if (!fs.existsSync(full)) return true;
    const text = fs.readFileSync(full, 'utf8');
    return rel !== 'core/setupCode.js' && !canReach(text);
  });
  check('and every file on the allow-list still needs to be there',
    stale.length === 0, stale.join(', '));
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nFirst-run setup code\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testIssue();
  await testSetupRequiresCode();
  await testNoPasswordPath();
  await testLimits();
  await testNeverLeaves();

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
