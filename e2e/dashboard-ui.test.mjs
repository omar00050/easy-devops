/**
 * End-to-end tests for choosing which dashboard UI the server serves.
 *
 * Run with:  npm run test:e2e -- dashboard-ui
 *
 * What this exists to prevent coming back:
 *
 *   The default was inverted: the built React UI in dist/ui is now served by
 *   default, with the classic EJS page kept only as a temporary fallback
 *   behind `--classic-ui` or the `dashboardUi: "classic"` setting. Nothing
 *   here proves on its own that the default actually flipped, that the flag
 *   or the setting can still reach the classic page, that a deep link still
 *   resolves to the React index.html, that a missing build falls back to
 *   classic instead of leaving the dashboard unreachable, that the old
 *   `--new-ui` flag is a harmless no-op, or that neither UI quietly relaxed
 *   any API protection. Serving static files from the same Express app is
 *   exactly the kind of change that can widen an attack surface by accident,
 *   so every registered /api route is checked again here.
 *
 *   Two later regressions are pinned too: a UI installed under a path with a
 *   dot segment (a global Bun install lives in ~/.bun) used to 404 because
 *   send() treats every dot-prefixed path segment as a dotfile, and a build
 *   that vanished after startup used to surface Express's stack trace in the
 *   browser instead of falling back to the classic page.
 *
 * Safety: free ports and temporary EASY_DEVOPS_DATA_DIRs, one per scenario.
 * The React build is a fixture in the temp directory, pointed at with
 * EASY_DEVOPS_UI_DIST, so the suite does not depend on (or touch) dist/ui.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs. See e2e/lib/guard.mjs and e2e/run.mjs.
import './lib/guard.mjs';

import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { issueSetupCode } from './lib/firstRun.mjs';
import { once } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';
// Allowed static import: e2e/lib/ reaches src/ only through dynamic imports,
// which is what readRegisteredRoutes() does when it is called.
import { readRegisteredRoutes } from './lib/api-contract-check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli', 'index.js');

/** Throwaway, for a throwaway install in a temp directory. */
const PASSWORD = 'ui-flag-test-password';

/** A string that can only come from the fixture build, never from EJS. */
const NEW_UI_MARKER = 'EZ_NEW_UI_FIXTURE';
/** Stable markers of the classic EJS page. */
const CLASSIC_MARKERS = ['v-cloak', '/js/app.js'];

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-ui-'));
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

/**
 * Starts a process and keeps its output, so a warning printed at startup can
 * be asserted rather than assumed.
 */
function start(label, args, env) {
  const entry = { label, p: null, out: '' };
  const p = spawn(process.execPath, args, {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  entry.p = p;
  procs.push(entry);
  const collect = (d) => { entry.out += String(d); };
  p.stdout.on('data', collect);
  p.stderr.on('data', collect);
  return entry;
}

function outputOf(label) {
  return procs.filter((e) => e.label === label).map((e) => e.out).join('\n');
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
  throw new Error(`${label} did not come up at ${url}\n${outputOf(label).slice(-800)}`);
}

/**
 * One HTTP call. The cookie is explicit so a test can stay anonymous even
 * after another check has signed in.
 */
async function req(method, pathname, { body, cookie, noHeader, headers } = {}) {
  const res = await fetch(`${DASH}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(noHeader ? {} : { 'X-EZ-Request': '1' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    text,
    body: json,
    contentType: res.headers.get('content-type') ?? '',
    cacheControl: res.headers.get('cache-control') ?? '',
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

/**
 * A request with full control over headers, including Host. fetch() silently
 * drops a Host override, so node:http does it. Copied in spirit from the
 * dashboard-auth suite: the Host rule cannot be tested through fetch().
 */
function rawReq(method, pathname, { targetPort, host, origin, cookie, header = true } = {}) {
  return new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/json' };
    if (host !== undefined) headers.Host = host;
    if (origin !== undefined) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    if (header) headers['X-EZ-Request'] = '1';

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
    request.end();
  });
}

/** A fresh data directory for one scenario, plus an empty legacy DB file. */
function freshDataDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  // A pre-created 0-byte file so db.js's legacy migration — which RENAMES
  // data/easy-devops.sqlite — can never run against the real installation.
  fs.writeFileSync(path.join(dir, 'easy-devops.sqlite'), '');
  return dir;
}

/** The env a dashboard child needs: isolated data, chosen port, chosen build. */
function serverEnv(dataDir, port, { uiDist, classicUi } = {}) {
  return {
    ...process.env,
    EASY_DEVOPS_DATA_DIR: dataDir,
    DASHBOARD_PORT: String(port),
    ...(uiDist ? { EASY_DEVOPS_UI_DIST: uiDist } : {}),
    ...(classicUi ? { EASY_DEVOPS_CLASSIC_UI: '1' } : {}),
  };
}

function looksClassic(r) {
  return r.status === 200 && CLASSIC_MARKERS.every((m) => r.text.includes(m)) &&
    !r.text.includes(NEW_UI_MARKER);
}

function looksNew(r) {
  return r.status === 200 && r.text.includes(NEW_UI_MARKER) && r.text.includes('/assets/fixture.js');
}

async function main() {
  // ── Fixtures ──────────────────────────────────────────────────────────────
  const fixtureDist = path.join(tmpRoot, 'dist-fixture');
  fs.mkdirSync(path.join(fixtureDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(fixtureDist, 'assets', 'fixture.js'), 'window.__ezFixture = true;\n');
  fs.writeFileSync(path.join(fixtureDist, 'index.html'), [
    '<!doctype html>',
    '<html><head><title>Easy DevOps</title>',
    '<script type="module" src="/assets/fixture.js"></script></head>',
    `<body><div id="root">${NEW_UI_MARKER}</div></body></html>`,
  ].join('\n'));
  const missingDist = path.join(tmpRoot, 'dist-missing');

  process.stdout.write(`\ntemp ${tmpRoot}\nfixture ${fixtureDist}\n`);

  // ── (1) The built React UI is the default ────────────────────────────────
  setGroup('(1) the new UI is the default');

  const dir2 = freshDataDir('default');
  const port2 = await freePort();
  DASH = `http://localhost:${port2}`;

  // --dev is included so the default is proven to combine with it. The
  // runner's EASY_DEVOPS_DATA_DIR is already set, so --dev cannot redirect it.
  start('default', [CLI, '--dev', '--dash'],
    serverEnv(dir2, port2, { uiDist: fixtureDist }));
  await waitFor(DASH, 'default');

  const newRoot = await req('GET', '/');
  check('GET / serves the built UI, with no flag and no setting', looksNew(newRoot),
    `status ${newRoot.status}`);
  check('the new page is not the classic one', !newRoot.text.includes('/js/app.js'));
  check('index.html is served with no-cache', /no-cache/.test(newRoot.cacheControl),
    newRoot.cacheControl);

  const asset = await req('GET', '/assets/fixture.js');
  check('static assets from the build are public (no session)',
    asset.status === 200 && asset.text.includes('__ezFixture'), `status ${asset.status}`);
  check('hashed assets are cached as immutable', /immutable/.test(asset.cacheControl),
    asset.cacheControl);

  check('startup says which UI is served, with no reason suffix',
    outputOf('default').includes(`Dashboard UI: new (${fixtureDist})`),
    outputOf('default').trim().slice(-160));

  // ── (2) --classic-ui serves the fallback even when the build exists ──────
  setGroup('(2) --classic-ui serves the classic page even with dashboardUi: new');

  const dir1 = freshDataDir('classic-flag');
  const port1 = await freePort();
  DASH = `http://localhost:${port1}`;

  start('classic-flag', [CLI, '--dash', '--classic-ui'],
    serverEnv(dir1, port1, { uiDist: fixtureDist, classicUi: true }));
  await waitFor(DASH, 'classic-flag');

  const classicRoot = await req('GET', '/');
  check('GET / serves the classic EJS page', looksClassic(classicRoot),
    `status ${classicRoot.status}`);
  check('the classic page is not the fixture build', !classicRoot.text.includes(NEW_UI_MARKER));

  const classicDeep = await req('GET', '/domains/example.com');
  check('an unknown path still renders the classic page', looksClassic(classicDeep),
    `status ${classicDeep.status}`);

  check('startup says which UI is served',
    /Dashboard UI: classic \(EJS\)/.test(outputOf('classic-flag')),
    outputOf('classic-flag').trim().slice(-120));
  check('startup explains the flag asked for it',
    outputOf('classic-flag').includes('Serving the classic dashboard (requested by --classic-ui).'),
    outputOf('classic-flag').trim().slice(-280));
  check('startup calls it a temporary fallback',
    outputOf('classic-flag').includes(
      'It is a temporary fallback and will be removed in a future release.'
    ));

  await stopAll();

  // Restore the default server for the deep-link and API sections below.
  DASH = `http://localhost:${port2}`;
  start('default', [CLI, '--dash'], serverEnv(dir2, port2, { uiDist: fixtureDist }));
  await waitFor(DASH, 'default');

  // ── (3) SPA fallback ─────────────────────────────────────────────────────
  setGroup('(3) a deep link falls back to index.html');

  const deepLink = await req('GET', '/domains/example.com?tab=ssl');
  check('a deep link returns index.html, not a 404', deepLink.status === 200,
    `status ${deepLink.status}`);
  check('the deep link body is the app shell', deepLink.text.includes(NEW_UI_MARKER));
  check('it is served as HTML', deepLink.contentType.includes('text/html'),
    deepLink.contentType);
  check('the fallback is not cached', /no-cache/.test(deepLink.cacheControl),
    deepLink.cacheControl);

  // ── (4) API and security are unchanged under the new UI ──────────────────
  setGroup('(4) the API is protected exactly as before with the new UI on');

  const authCheck = await req('GET', '/api/auth');
  check('the public session check still answers JSON, not the app shell',
    authCheck.status === 200 && authCheck.body?.authenticated === false &&
    authCheck.contentType.includes('application/json'),
    `status ${authCheck.status}, ${authCheck.contentType}`);

  const anonApi = await req('GET', '/api/domains');
  check('an API route without a session is still 401', anonApi.status === 401,
    `status ${anonApi.status}`);
  check('the 401 is JSON, not index.html',
    anonApi.contentType.includes('application/json'), anonApi.contentType);

  const noHeader = await req('POST', '/api/settings', { noHeader: true, body: {} });
  check('a write without X-EZ-Request is still 403',
    noHeader.status === 403 && noHeader.body?.reason === 'missing_request_header',
    `status ${noHeader.status}, ${noHeader.body?.reason}`);

  // Sign in and set the bind to loopback so the Host rule is the strict one
  // regardless of the platform default.
  // First-run setup needs the one-time code the server printed (see
  // core/setupCode.js). Issued here against this scenario's own data
  // directory, which is what `ezz dashboard setup-code` does.
  const setupCode = await issueSetupCode({ dataDir: dir2 });
  const setup = await req('POST', '/api/setup', { body: { password: PASSWORD, setupCode } });
  check('setup works through the new UI', setup.status === 200 &&
    Boolean(setup.cookie), `status ${setup.status}`);
  const session = setup.cookie;

  const toLoopback = await req('POST', '/api/settings', {
    cookie: session, body: { dashboardBindAddress: '127.0.0.1' },
  });
  check('the bind can be set to loopback', toLoopback.status === 200,
    `status ${toLoopback.status}`);

  const badHost = await rawReq('GET', '/api/domains', {
    targetPort: port2, cookie: session, host: 'evil.example.com:' + port2,
  });
  check('a rebinding Host is still refused under the new UI',
    badHost.status === 403 && badHost.body?.reason === 'host_not_local',
    `status ${badHost.status}, ${badHost.body?.reason}`);

  // Every route the server actually registers, not a hand-kept list. The four
  // public auth endpoints are skipped; everything else must refuse an
  // anonymous caller.
  const PUBLIC_ROUTES = new Set([
    'GET /api/auth',
    'POST /api/login',
    'POST /api/setup',
    'POST /api/logout',
  ]);

  const registered = await readRegisteredRoutes();
  const protectedRoutes = registered.filter((r) => !PUBLIC_ROUTES.has(r));

  check('the route list was read from the real routers', registered.length > 20,
    `${registered.length} route(s)`);
  check('all four documented public routes exist',
    [...PUBLIC_ROUTES].every((r) => registered.includes(r)),
    [...PUBLIC_ROUTES].filter((r) => !registered.includes(r)).join(', ') || 'all present');

  let leaked = 0;
  for (const route of protectedRoutes) {
    const [method, template] = route.split(' ');
    const pathname = template.replace(/:[^/]+/g, 'example');
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const r = await req(method, pathname, hasBody ? { body: {} } : {});
    const ok = r.status === 401;
    if (!ok) leaked++;
    check(`${route} refuses an anonymous caller`, ok, ok ? '' : `got ${r.status}`);
  }
  check('no registered API route leaked without a session', leaked === 0,
    `${leaked} of ${protectedRoutes.length} leaked`);

  await stopAll();

  // ── (5) The setting, for a background service each boot ──────────────────
  setGroup('(5) dashboardUi: classic is honoured without a flag, until restart');

  const dir3 = freshDataDir('setting');
  const port3 = await freePort();
  DASH = `http://localhost:${port3}`;

  start('setting-new', [CLI, '--dash'], serverEnv(dir3, port3, { uiDist: fixtureDist }));
  await waitFor(DASH, 'setting-new');

  const beforeSetting = await req('GET', '/');
  check('the setting starts at new (no flag, no stored setting yet)', looksNew(beforeSetting),
    `status ${beforeSetting.status}`);

  const setupCode3 = await issueSetupCode({ dataDir: dir3 });
  const setup3 = await req('POST', '/api/setup', { body: { password: PASSWORD, setupCode: setupCode3 } });
  check('signed in for the settings change', setup3.status === 200, `status ${setup3.status}`);

  const currentSettings = await req('GET', '/api/settings', { cookie: setup3.cookie });
  check('settings expose the UI choice',
    currentSettings.body?.dashboardUi === 'new', String(currentSettings.body?.dashboardUi));

  const invalidUi = await req('POST', '/api/settings', {
    cookie: setup3.cookie, body: { dashboardUi: 'fancy' },
  });
  check('an unknown UI name is refused', invalidUi.status === 400, `status ${invalidUi.status}`);

  const toClassic = await req('POST', '/api/settings', {
    cookie: setup3.cookie, body: { dashboardUi: 'classic' },
  });
  check('dashboardUi can be set to classic', toClassic.status === 200, `status ${toClassic.status}`);
  check('the response reports the stored choice', toClassic.body?.dashboardUi === 'classic',
    String(toClassic.body?.dashboardUi));
  check('it asks for a restart, because the UI is chosen at startup',
    toClassic.body?.needsRestart === true, String(toClassic.body?.needsRestart));

  const afterSetting = await req('GET', '/api/settings', { cookie: setup3.cookie });
  check('the setting persists', afterSetting.body?.dashboardUi === 'classic',
    String(afterSetting.body?.dashboardUi));

  const stillNew = await req('GET', '/');
  check('the running server keeps serving new until restarted', looksNew(stillNew),
    `status ${stillNew.status}`);

  await stopAll();

  const port4 = await freePort();
  DASH = `http://localhost:${port4}`;
  // Setting the DB value through the settings API (above) kept the
  // `dashboardUiMigrated` marker, so this restart reads the deliberate
  // `classic` choice rather than having loadConfig() migrate it back to
  // `new`. See core/config.js.
  start('setting-classic', [CLI, '--dash'], serverEnv(dir3, port4, { uiDist: fixtureDist }));
  await waitFor(DASH, 'setting-classic');

  const afterRestart = await req('GET', '/');
  check('after a restart the setting selects the classic UI', looksClassic(afterRestart),
    `status ${afterRestart.status}`);
  check('startup names the fallback, with the setting as the reason',
    outputOf('setting-classic').includes(
      'Serving the classic dashboard (requested by the dashboardUi setting).'
    ),
    outputOf('setting-classic').trim().slice(-280));
  check('startup says which UI is served',
    /Dashboard UI: classic \(EJS\)/.test(outputOf('setting-classic')));

  await stopAll();

  // ── (6) A missing build falls back, loudly and safely ────────────────────
  setGroup('(6) a missing build prints how to build it and falls back');

  const dir4 = freshDataDir('missing');
  const port5 = await freePort();
  DASH = `http://localhost:${port5}`;

  // No flag and no setting: the default is `new`, so this proves the
  // fallback triggers on a missing build alone, not just on a request for it.
  start('missing', [CLI, '--dash'], serverEnv(dir4, port5, { uiDist: missingDist }));
  await waitFor(DASH, 'missing');

  const fallback = await req('GET', '/');
  check('the dashboard still serves the classic UI', looksClassic(fallback),
    `status ${fallback.status}`);

  const missingOut = outputOf('missing');
  check('the warning says the UI is not built',
    missingOut.includes('The dashboard UI is not built:'), missingOut.trim().slice(-280));
  check('the warning prints the path it expected',
    missingOut.includes(path.join(missingDist, 'index.html')),
    missingOut.trim().slice(-280));
  check('the warning says how to build the UI', missingOut.includes('Build it with: npm run build:ui'));
  check('the warning says it is falling back for this run',
    missingOut.includes('Serving the classic dashboard for this run.'));
  check('startup says which UI is served',
    /Dashboard UI: classic \(EJS\)/.test(missingOut));

  const fallbackAuth = await req('GET', '/api/auth');
  check('the API works after the fallback', fallbackAuth.status === 200,
    `status ${fallbackAuth.status}`);

  await stopAll();

  // ── (7) --new-ui is a harmless, accepted no-op ───────────────────────────
  setGroup('(7) --new-ui is still accepted and changes nothing');

  const dir5 = freshDataDir('new-ui-flag');
  const port6 = await freePort();
  DASH = `http://localhost:${port6}`;

  start('new-ui-flag', [CLI, '--dash', '--new-ui'],
    serverEnv(dir5, port6, { uiDist: fixtureDist }));
  await waitFor(DASH, 'new-ui-flag');

  const noopRoot = await req('GET', '/');
  check('the React UI is still served with --new-ui', looksNew(noopRoot),
    `status ${noopRoot.status}`);

  const noopOut = outputOf('new-ui-flag');
  check('the flag prints the "no longer needed" note',
    noopOut.includes('Note: --new-ui is the default now; the flag is no longer needed.'),
    noopOut.trim().slice(-280));
  check('--new-ui does not trigger the classic fallback message',
    !noopOut.includes('Serving the classic dashboard'));

  await stopAll();

  // ── (8) A dot segment in the install path ────────────────────────────────
  // Mirrors `bun add -g`: the package lands in ~/.bun/install/global/... and
  // send() used to classify `.bun` as a dotfile and answer 404 for every
  // request the SPA fallback handled.
  setGroup('(8) a dot segment in the install path still serves the UI');

  const dotDist = path.join(
    tmpRoot, '.bun', 'install', 'global', 'node_modules', 'easy-devops', 'dist', 'ui'
  );
  fs.mkdirSync(path.join(dotDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dotDist, 'assets', 'fixture.js'), 'window.__ezFixture = true;\n');
  fs.writeFileSync(path.join(dotDist, 'index.html'), [
    '<!doctype html>',
    '<html><head><title>Easy DevOps</title>',
    '<script type="module" src="/assets/fixture.js"></script></head>',
    `<body><div id="root">${NEW_UI_MARKER}</div></body></html>`,
  ].join('\n'));

  const dir6 = freshDataDir('dot-path');
  const port7 = await freePort();
  DASH = `http://localhost:${port7}`;

  start('dot-path', [CLI, '--dash'], serverEnv(dir6, port7, { uiDist: dotDist }));
  await waitFor(DASH, 'dot-path');

  const dotRoot = await req('GET', '/');
  check('GET / serves the build installed under a .bun-style path', looksNew(dotRoot),
    `status ${dotRoot.status}`);
  check('the dot path does not surface a NotFoundError', !dotRoot.text.includes('NotFoundError'));

  const dotDeep = await req('GET', '/domains/example.com');
  check('a deep link from the dot path still returns index.html',
    dotDeep.status === 200 && dotDeep.text.includes(NEW_UI_MARKER), `status ${dotDeep.status}`);

  const dotAsset = await req('GET', '/assets/fixture.js');
  check('assets still load from the dot path',
    dotAsset.status === 200 && dotAsset.text.includes('__ezFixture'), `status ${dotAsset.status}`);

  await stopAll();

  // ── (9) The build disappears after startup ───────────────────────────────
  setGroup('(9) a vanished build falls back to classic, without a stack trace');

  const brokenDist = path.join(tmpRoot, 'dist-breaks');
  fs.cpSync(fixtureDist, brokenDist, { recursive: true });

  const dir7 = freshDataDir('runtime-missing');
  const port8 = await freePort();
  DASH = `http://localhost:${port8}`;

  start('runtime-missing', [CLI, '--dash'], serverEnv(dir7, port8, { uiDist: brokenDist }));
  await waitFor(DASH, 'runtime-missing');

  const beforeBreak = await req('GET', '/');
  check('the build serves before it disappears', looksNew(beforeBreak), `status ${beforeBreak.status}`);

  // A rebuilt or half-updated install can lose index.html while the server is
  // running; the next request is what used to print the stack.
  fs.rmSync(path.join(brokenDist, 'index.html'));

  const broken = await req('GET', '/');
  check('the request falls back to the classic page instead of a 404', looksClassic(broken),
    `status ${broken.status}`);
  check('the browser never sees the Express stack trace',
    !broken.text.includes('NotFoundError') && !broken.text.includes('at SendStream'));

  const brokenDeep = await req('GET', '/settings');
  check('a deep link falls back to the classic page too', looksClassic(brokenDeep),
    `status ${brokenDeep.status}`);

  // stderr is piped; give the child's write a moment to arrive.
  await new Promise((r) => setTimeout(r, 250));
  const brokenOut = outputOf('runtime-missing');
  check('one notice names the file that could not be served',
    brokenOut.includes('The dashboard UI could not be served:') &&
    brokenOut.includes(path.join(brokenDist, 'index.html')), brokenOut.trim().slice(-280));
  check('the notice is printed once, not per request',
    brokenOut.split('The dashboard UI could not be served:').length - 1 === 1);
  check('the notice says what is served instead',
    brokenOut.includes('Serving the classic dashboard until it can.'));

  await stopAll();

  // ── Teardown ─────────────────────────────────────────────────────────────
  setGroup('teardown');

  // readRegisteredRoutes() imported the routers into this process, which opens
  // the runner's SQLite database. Close it before the runner removes the
  // directory, or Windows will refuse.
  try {
    const dbMod = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'db.js')).href);
    dbMod.closeDb();
  } catch { /* never loaded */ }

  check('temporary directory removed', rmWithRetry(tmpRoot), tmpRoot);

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
