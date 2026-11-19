/**
 * Tests for the certificate suggestion: "this domain has no SSL, but a
 * certificate that can serve it already exists — offer the paths".
 *
 * Run with:  npm run test:e2e -- ssl-suggest
 *
 * Plain Node script: the easy-devops constitution forbids adding a test
 * framework, so this uses no runner and no new dependencies.
 *
 * What this exists to prevent coming back:
 *
 *   - a wrong suggestion. Writing the wrong certificate onto a live site
 *     breaks it, so matching is held to exact folder name → SAN → wildcard
 *     covering exactly one label (`*.example.com` does NOT cover
 *     `a.b.example.com`), and an unreadable certificate is never offered.
 *   - a suggestion that writes itself in. The resolver is read-only; the
 *     dashboard endpoint and the hub action must not change a domain.
 *
 * Safety: a random free port, a temporary EASY_DEVOPS_DATA_DIR with a
 * pre-created zero-byte SQLite file, a temporary nginx prefix and a temporary
 * certificate directory. The real installation is never opened.
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
import { once } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';
import { issueSetupCode } from './lib/firstRun.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REAL_LEGACY_DB = path.join(ROOT, 'data', 'easy-devops.sqlite');

/** Throwaway, for a throwaway install in a temp directory. */
const PASSWORD = 'suggest-e2e-password';

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

// ─── Isolation, established before any core module can be imported ──────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-suggest-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
// A pre-created 0-byte file so db.js's legacy migration — which RENAMES
// data/easy-devops.sqlite — can never run against the real installation.
fs.writeFileSync(path.join(dataDir, 'easy-devops.sqlite'), '');
process.env.EASY_DEVOPS_DATA_DIR = dataDir;

const sslDir = path.join(tmpRoot, 'ssl');
const nginxDir = path.join(tmpRoot, 'nginx');

function assertTempDataDir(what) {
  const current = process.env.EASY_DEVOPS_DATA_DIR;
  const inside =
    typeof current === 'string' && path.resolve(current).startsWith(path.resolve(tmpRoot));
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

function start(label, args, env) {
  const p = spawn(process.execPath, args, {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  procs.push({ label, p });
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

async function req(method, pathname, { body, cookie } = {}) {
  const res = await fetch(`${DASH}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-EZ-Request': '1',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, body: json, cookie: setCookie ? setCookie.split(';')[0] : null };
}

/** A certificate folder the way issuance leaves it: PEM plus optional meta. */
function makeCert(name, { meta, pem = 'dummy' } = {}) {
  const dir = path.join(sslDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (pem !== null) fs.writeFileSync(path.join(dir, 'fullchain.pem'), pem);
  if (meta) fs.writeFileSync(path.join(dir, 'ez-cert.json'), JSON.stringify(meta));
}

function forward(p) {
  return String(p).replace(/\\/g, '/');
}

async function main() {
  const legacyBefore = fs.existsSync(REAL_LEGACY_DB) ? fs.statSync(REAL_LEGACY_DB).mtimeMs : null;

  // ── (1) The resolver ──────────────────────────────────────────────────────
  setGroup('(1) resolver: matching and ranking');

  fs.mkdirSync(sslDir, { recursive: true });

  makeCert('new.devxor.team');                                      // exact
  makeCert('devxor.team', { meta: { altNames: ['devxor.team', 'api.devxor.team'] } }); // SAN
  makeCert('wild', { meta: { altNames: ['*.example.org'] } });      // wildcard
  makeCert('broken', { pem: null });                                // unreadable

  assertTempDataDir('import core/cert-suggest.js');
  const suggest = await import(
    pathToFileURL(path.join(ROOT, 'src/core/cert-suggest.js')).href
  );

  const exact = await suggest.findCertificateForDomain('new.devxor.team', { sslDir });
  check('an exact folder match is found', exact.found === true && exact.match === 'exact',
    JSON.stringify({ found: exact.found, match: exact.match }));
  check('the exact match names its certificate folder',
    exact.certificate?.domain === 'new.devxor.team', exact.certificate?.domain);
  check('the certificate paths point into the configured sslDir',
    exact.certificate?.certPath === forward(path.join(sslDir, 'new.devxor.team', 'fullchain.pem')) &&
    exact.certificate?.keyPath === forward(path.join(sslDir, 'new.devxor.team', 'privkey.pem')),
    exact.certificate?.certPath);
  check('the paths use forward slashes',
    !String(exact.certificate?.certPath).includes('\\') &&
    !String(exact.certificate?.keyPath).includes('\\'));
  check('expiry and status are reported',
    exact.certificate?.daysLeft > 0 && exact.certificate?.status === 'valid',
    `daysLeft=${exact.certificate?.daysLeft} status=${exact.certificate?.status}`);

  const messy = await suggest.findCertificateForDomain('  New.DevXor.Team. ', { sslDir });
  check('matching ignores case, spaces and a trailing dot',
    messy.found === true && messy.match === 'exact', `${messy.match}`);

  const starInput = await suggest.findCertificateForDomain('*.new.devxor.team', { sslDir });
  check('a leading *., which the UI adds itself, is ignored',
    starInput.found === true && starInput.match === 'exact', `${starInput.match}`);

  const san = await suggest.findCertificateForDomain('api.devxor.team', { sslDir });
  check('a name listed in the certificate (SAN) is found',
    san.found === true && san.match === 'san', `${san.match}`);
  check('the SAN match names the certificate that holds it',
    san.certificate?.domain === 'devxor.team', san.certificate?.domain);
  check('the SAN names are reported for display',
    Array.isArray(san.certificate?.names) && san.certificate.names.length === 2,
    san.certificate?.names?.join(', '));

  const wild = await suggest.findCertificateForDomain('app.example.org', { sslDir });
  check('a wildcard covering one label is found',
    wild.found === true && wild.match === 'wildcard', `${wild.match}`);
  check('the wildcard match names the certificate that holds it',
    wild.certificate?.domain === 'wild', wild.certificate?.domain);

  const deep = await suggest.findCertificateForDomain('a.b.example.org', { sslDir });
  check('a wildcard does NOT cover two labels', deep.found === false, JSON.stringify(deep));

  const broken = await suggest.findCertificateForDomain('broken', { sslDir });
  check('a certificate that cannot be read is never offered', broken.found === false);

  const unknown = await suggest.findCertificateForDomain('nothing.example.net', { sslDir });
  check('an unknown domain is not found', unknown.found === false);

  const empty = await suggest.findCertificateForDomain('', { sslDir });
  check('an empty name is not found', empty.found === false);

  check('wildcardCovers accepts one label', suggest.wildcardCovers('*.a.com', 'x.a.com') === true);
  check('wildcardCovers rejects the bare domain', suggest.wildcardCovers('*.a.com', 'a.com') === false);
  check('wildcardCovers rejects two labels', suggest.wildcardCovers('*.a.com', 'x.b.a.com') === false);

  // ── (2) Remembered config and stored domains ──────────────────────────────
  setGroup('(2) the dashboard reads the saved configuration');

  assertTempDataDir('import core/config.js');
  const cfg = await import(pathToFileURL(path.join(ROOT, 'src/core/config.js')).href);
  cfg.saveConfig({ ...cfg.loadConfig(), nginxDir, sslDir, dashboardPassword: '' });

  const domainsDb = await import(pathToFileURL(path.join(ROOT, 'src/core/domains-db.js')).href);
  domainsDb.saveDomains([
    domainsDb.createDomain({ name: 'new.devxor.team', port: 3000 }),
    domainsDb.createDomain({ name: 'blog.example.net', port: 3001 }),
  ]);

  // Release the handle before the dashboard opens the same file.
  const coreDb = await import(pathToFileURL(path.join(ROOT, 'src/core/db.js')).href);
  coreDb.closeDb();

  const port = await freePort();
  DASH = `http://localhost:${port}`;
  process.stdout.write(`\nport ${port}\ndata ${dataDir}\n`);

  const server = start('dashboard', [path.join('src', 'dashboard', 'server.js')], {
    ...process.env, EASY_DEVOPS_DATA_DIR: dataDir, DASHBOARD_PORT: String(port),
  });
  await waitFor(DASH, 'dashboard');

  const setupCode = await issueSetupCode({ dataDir });
  const setup = await req('POST', '/api/setup', { body: { password: PASSWORD, setupCode } });
  check('first-run setup signs in', setup.status === 200 && Boolean(setup.cookie),
    `status ${setup.status}`);
  const cookie = setup.cookie;

  // ── (3) The API endpoint ──────────────────────────────────────────────────
  setGroup('(3) GET /api/domains/:name/ssl-suggestion');

  const anon = await req('GET', '/api/domains/new.devxor.team/ssl-suggestion');
  check('an anonymous caller is refused', anon.status === 401, `status ${anon.status}`);

  const apiExact = await req('GET', '/api/domains/new.devxor.team/ssl-suggestion', { cookie });
  check('the endpoint answers 200 with the match', apiExact.status === 200 &&
    apiExact.body?.found === true && apiExact.body?.match === 'exact',
    `status ${apiExact.status} ${JSON.stringify(apiExact.body?.match)}`);
  check('the paths come from the saved sslDir',
    apiExact.body?.certificate?.certPath ===
      forward(path.join(sslDir, 'new.devxor.team', 'fullchain.pem')),
    apiExact.body?.certificate?.certPath);

  const apiNone = await req('GET', '/api/domains/blog.example.net/ssl-suggestion', { cookie });
  check('a domain without a certificate answers found:false', apiNone.status === 200 &&
    apiNone.body?.found === false, `status ${apiNone.status}`);

  // The deployments link dialog asks before the domain exists, so an unknown
  // name is a normal "not found" answer rather than 404.
  const apiUnknown = await req('GET', '/api/domains/nope.example.net/ssl-suggestion', { cookie });
  check('an unknown domain answers found:false, not 404',
    apiUnknown.status === 200 && apiUnknown.body?.found === false,
    `status ${apiUnknown.status}`);

  const stored = await req('GET', '/api/domains', { cookie });
  const storedDomain = (stored.body ?? []).find((d) => d.name === 'new.devxor.team');
  check('looking up a suggestion changes nothing on the domain',
    storedDomain?.ssl?.enabled === false &&
    storedDomain?.ssl?.certPath === '' && storedDomain?.ssl?.keyPath === '',
    JSON.stringify(storedDomain?.ssl));

  // ── (4) The hub action ────────────────────────────────────────────────────
  setGroup('(4) hub:manageSSL { action: suggest }');

  await stopAll();
  coreDb.initDb();

  assertTempDataDir('import core/cert-operations.js');
  const ops = await import(pathToFileURL(path.join(ROOT, 'src/core/cert-operations.js')).href);

  const hubExact = await ops.handleHubSslCommand({ action: 'suggest', domain: 'new.devxor.team' });
  check('the hub action reports the same certificate', hubExact.ok === true &&
    hubExact.found === true && hubExact.match === 'exact',
    JSON.stringify({ ok: hubExact.ok, found: hubExact.found, match: hubExact.match }));
  check('the hub action uses the saved sslDir',
    hubExact.certificate?.certPath ===
      forward(path.join(sslDir, 'new.devxor.team', 'fullchain.pem')),
    hubExact.certificate?.certPath);
  check('it is a read-only answer, not an operation',
    hubExact.certificate?.domain === 'new.devxor.team' && hubExact.error === undefined);

  const hubNone = await ops.handleHubSslCommand({ action: 'suggest', domain: 'blog.example.net' });
  check('no certificate still answers ok', hubNone.ok === true && hubNone.found === false);

  const hubMissing = await ops.handleHubSslCommand({ action: 'suggest' });
  check('a missing domain is refused with a reason',
    hubMissing.ok === false && String(hubMissing.error).includes('domain'),
    hubMissing.error);

  // ── Isolation ─────────────────────────────────────────────────────────────
  setGroup('Isolation');
  const legacyAfter = fs.existsSync(REAL_LEGACY_DB) ? fs.statSync(REAL_LEGACY_DB).mtimeMs : null;
  check('data/easy-devops.sqlite untouched', legacyAfter === legacyBefore);
  check('no .migrated file created', !fs.existsSync(`${REAL_LEGACY_DB}.migrated`));

  coreDb.closeDb();
  check('temporary directory removed', rmWithRetry(tmpRoot), tmpRoot);

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
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
  rmWithRetry(tmpRoot);
  process.exit(1);
});
