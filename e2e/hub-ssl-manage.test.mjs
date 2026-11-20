/**
 * Tests for certificate and domain management from the Hub: deleting a
 * certificate safely, the refusals the Hub's SSL/domain commands must produce,
 * and the two places that perform the deletion (the agent and the dashboard).
 *
 * Run with:  npm run test:e2e -- hub-ssl-manage
 *
 * ── What this exists to prevent coming back ────────────────────────────────
 *
 *   - a delete that is steered by a caller-supplied name. The directory is
 *     resolved from listAllCerts(), so `..`, `a/../../b` and absolute paths are
 *     simply "not found" and nothing outside sslDir is ever removed.
 *   - a delete that breaks a live site. A certificate an enabled SSL domain
 *     points at, or that ANY nginx config line references (including a
 *     `.conf.disabled` copy), must be refused — with the domain names and the
 *     file/line references so the operator can act.
 *   - a refusal that reaches the Hub as `data: null`. The agent must forward the
 *     handler's structured result so the Hub can say WHICH domains still use it.
 *   - an issue from the Hub that reaches ACME before the name, the wildcard
 *     rule or the missing acmeEmail is checked.
 *   - a domain saved while its certificate files are missing.
 *
 * ── Isolation ──────────────────────────────────────────────────────────────
 *
 * A throwaway EASY_DEVOPS_DATA_DIR (allocated by e2e/run.mjs), scratch ssl and
 * nginx directories inside it, fake certificate FILES only (never a real
 * certificate), a fake Hub socket.io server on a random port, and a dashboard
 * on a random port. No ACME, no real nginx, no PM2. Issue is exercised only up
 * to the refusals that happen before any network call; nothing is issued.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { createServer } from 'http';
import { fileURLToPath, pathToFileURL } from 'url';
import { issueSetupCode } from './lib/firstRun.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REAL_LEGACY_DB = path.join(ROOT, 'data', 'easy-devops.sqlite');

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;
const forward = (p) => String(p).replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Throwaway, for the throwaway install this suite starts. */
const PASSWORD = 'ssl-manage-e2e-password';
const SERVER_ID = 'test-server-id';
const SECRET = 'test-secret';

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

async function waitUntil(fn, { timeoutMs = 8_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(everyMs);
  }
  return false;
}

// ─── Scratch layout ─────────────────────────────────────────────────────────

const scratchRoot = path.join(TEST_DATA_DIR, 'scratch');
const sslDir = path.join(scratchRoot, 'ssl');
const nginxDir = path.join(scratchRoot, 'nginx');

// Fake certificate FILES only. No real certificate is created or needed:
// deletion only asks whether the directory is referenced, and
// listAllCerts({ includeUnusable: true }) reports an unreadable PEM rather than
// hiding it, so a directory with files is enough.
const FAKE_CERT = '-----BEGIN CERTIFICATE-----\nnot-a-real-certificate\n-----END CERTIFICATE-----\n';
const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n';

function makeCert(name) {
  const dir = path.join(sslDir, name);
  assertInsideTestDataDir(dir, `write a fake certificate for ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fullchain.pem'), FAKE_CERT);
  fs.writeFileSync(path.join(dir, 'privkey.pem'), FAKE_KEY);
  return dir;
}

function certPath(name) { return forward(path.join(sslDir, name, 'fullchain.pem')); }
function keyPath(name) { return forward(path.join(sslDir, name, 'privkey.pem')); }

// ─── Dashboard helpers ──────────────────────────────────────────────────────

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
    await Promise.race([once(p, 'exit'), sleep(4_000)]);
  }
  procs.length = 0;
}

async function waitFor(url, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up */ }
    await sleep(250);
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

// ─── Fake Hub socket, the way e2e/hub-agent.test.mjs stands one up ──────────

/**
 * A stand-in for hub_backend's /agent-socket: authenticates the pairing and
 * records every `command:result` the agent emits. The real Hub is never
 * contacted.
 */
async function startTestHub() {
  const { Server } = await import(
    pathToFileURL(path.join(ROOT, 'node_modules/socket.io/dist/index.js')).href
  );

  const http = createServer();
  const io = new Server(http);
  const ns = io.of('/agent-socket');
  const state = { connects: 0, results: [], socket: null };

  ns.use((socket, next) => {
    const { serverId, secret } = socket.handshake.auth ?? {};
    if (serverId !== SERVER_ID || secret !== SECRET) return next(new Error('INVALID_SECRET'));
    next();
  });

  ns.on('connection', (socket) => {
    state.connects++;
    state.socket = socket;
    socket.on('command:result', (payload) => state.results.push(payload));
  });

  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    live: () => ns.sockets.size,
    async close() {
      for (const socket of ns.sockets.values()) socket.disconnect(true);
      io.close();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const legacyBefore = fs.existsSync(REAL_LEGACY_DB) ? fs.statSync(REAL_LEGACY_DB).mtimeMs : null;

  fs.mkdirSync(sslDir, { recursive: true });
  fs.mkdirSync(nginxDir, { recursive: true });

  // Sentinels OUTSIDE sslDir, one in its parent and one in nginxDir. A delete
  // that followed a caller-supplied path would remove one of them.
  const parentSentinel = path.join(scratchRoot, 'outside-ssl-sentinel.txt');
  fs.writeFileSync(parentSentinel, 'must survive\n');
  const nginxSentinel = path.join(nginxDir, 'nginx-sentinel.txt');
  fs.writeFileSync(nginxSentinel, 'must survive\n');

  // A directory outside sslDir for the "absolute path" case.
  const outsideDir = path.join(scratchRoot, 'outside-dir');
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, 'keep.txt');
  fs.writeFileSync(outsideFile, 'must survive\n');

  // ── Config and stored domains, before any core module reads them ──────────
  assertInsideTestDataDir(TEST_DATA_DIR, 'seed the config');
  const cfg = await import(srcUrl('core/config.js'));
  cfg.saveConfig({
    ...cfg.loadConfig(),
    nginxDir,
    sslDir,
    dashboardPassword: '',
    dashboardBindAddress: '127.0.0.1',
    acmeEmail: '',
    os: process.platform,
  });

  makeCert('used.example.com');
  makeCert('ref.example.com');
  makeCert('disabled.example.com');

  // A disabled domain's `.conf.disabled` copy referencing a certificate. This
  // is the "config line only" case: no enabled domain uses it.
  const refConf = path.join(nginxDir, 'ref.example.com.conf.disabled');
  fs.writeFileSync(
    refConf,
    [
      'server {',
      '    listen 443 ssl;',
      `    ssl_certificate     ${certPath('ref.example.com')};`,
      `    ssl_certificate_key ${keyPath('ref.example.com')};`,
      '}',
      '',
    ].join('\n'),
  );

  assertInsideTestDataDir(TEST_DATA_DIR, 'seed the domains');
  const domainsDb = await import(srcUrl('core/domains-db.js'));
  domainsDb.saveDomains([
    domainsDb.createDomain({
      name: 'used.example.com', port: 3000, enabled: true,
      ssl: { enabled: true, certPath: certPath('used.example.com'), keyPath: keyPath('used.example.com') },
    }),
    // SSL is ON but the domain is disabled: on its own this must not protect
    // the certificate, because nothing serves it.
    domainsDb.createDomain({
      name: 'disabled.example.com', port: 3001, enabled: false,
      ssl: { enabled: true, certPath: certPath('disabled.example.com'), keyPath: keyPath('disabled.example.com') },
    }),
    domainsDb.createDomain({ name: 'nofile.example.com', port: 3002, enabled: true }),
  ]);

  // ── (1) deleteCertificate: traversal and "in use" ─────────────────────────
  setGroup('(1) deleteCertificate: traversal is not found, in use is refused');
  const usage = await import(srcUrl('core/cert-usage.js'));

  check('the missing-files hint is a real sentence',
    typeof usage.CERT_MISSING_HINT === 'string' && usage.CERT_MISSING_HINT.length > 20);

  for (const name of ['..', '../x', 'a/../../b', path.join(sslDir, 'used.example.com')]) {
    const outcome = await usage.deleteCertificate(name);
    check(`the name ${JSON.stringify(name)} is not found`,
      outcome.ok === false && outcome.code === 'cert_not_found',
      JSON.stringify({ ok: outcome.ok, code: outcome.code }));
    check(`  ...and it reports no directory for ${JSON.stringify(name)}`, outcome.directory === undefined);
  }

  check('the sentinel in sslDir\'s parent survived',
    fs.existsSync(parentSentinel) && fs.readFileSync(parentSentinel, 'utf8') === 'must survive\n');
  check('the sentinel in nginxDir survived',
    fs.existsSync(nginxSentinel) && fs.readFileSync(nginxSentinel, 'utf8') === 'must survive\n');
  check('the directory outside sslDir survived', fs.existsSync(outsideFile));
  check('the certificate a traversal named is still there',
    fs.existsSync(path.join(sslDir, 'used.example.com', 'fullchain.pem')));

  const byDomain = await usage.domainsUsingCert('used.example.com');
  check('an enabled SSL domain counts as a user', byDomain.includes('used.example.com'),
    JSON.stringify(byDomain));
  check('a disabled SSL domain does NOT count as a user',
    !(await usage.domainsUsingCert('disabled.example.com')).includes('disabled.example.com'));

  const inUse = await usage.deleteCertificate('used.example.com');
  check('an enabled SSL domain makes its certificate in use',
    inUse.ok === false && inUse.code === 'cert_in_use', JSON.stringify(inUse.code));
  check('the refusal names the domain and its directory',
    Array.isArray(inUse.usedBy) && inUse.usedBy.includes('used.example.com')
      && inUse.directory === path.join(sslDir, 'used.example.com'),
    JSON.stringify({ usedBy: inUse.usedBy, directory: inUse.directory }));
  check('and the certificate is still on disk',
    fs.existsSync(path.join(sslDir, 'used.example.com', 'fullchain.pem')));

  const rawRefs = await usage.findCertReferences('ref.example.com');
  check('a config line alone is found as a reference',
    rawRefs.length === 2 && rawRefs.some((r) => r.line === 3),
    rawRefs.map((r) => `${path.basename(r.file)}:${r.line}`).join(', '));

  const byConfig = await usage.deleteCertificate('ref.example.com');
  check('a config line alone is enough to refuse a delete',
    byConfig.ok === false && byConfig.code === 'cert_in_use', JSON.stringify(byConfig.code));
  check('no domain uses it, so usedBy is empty',
    Array.isArray(byConfig.usedBy) && byConfig.usedBy.length === 0, JSON.stringify(byConfig.usedBy));
  check('the reference carries the file and line',
    byConfig.references.some((r) => path.basename(r.file) === 'ref.example.com.conf.disabled' && r.line === 4),
    JSON.stringify(byConfig.references.map((r) => ({ f: path.basename(r.file), l: r.line }))));

  const disabled = await usage.deleteCertificate('disabled.example.com');
  check('a disabled domain with no config reference does not protect the certificate',
    disabled.ok === true && disabled.domain === 'disabled.example.com', JSON.stringify(disabled));
  check('  ...and the directory is gone',
    !fs.existsSync(path.join(sslDir, 'disabled.example.com')));

  makeCert('free.example.com');
  const unused = await usage.deleteCertificate('free.example.com');
  check('an unused certificate is deleted',
    unused.ok === true && unused.domain === 'free.example.com', JSON.stringify(unused));
  check('the deleted directory is gone',
    !fs.existsSync(path.join(sslDir, 'free.example.com')));
  check('the result reports the directory it removed',
    unused.directory === path.join(sslDir, 'free.example.com'), unused.directory);

  // ── (2) handleHubSslCommand: delete ──────────────────────────────────────
  setGroup('(2) handleHubSslCommand delete: structured refusals, no paths');
  const ops = await import(srcUrl('core/cert-operations.js'));

  const hubInUse = await ops.handleHubSslCommand({ action: 'delete', domain: 'used.example.com' });
  check('the Hub delete refuses an in-use certificate',
    hubInUse.ok === false && hubInUse.code === 'cert_in_use', JSON.stringify(hubInUse.code));
  check('the refusal names the domains that still use it',
    Array.isArray(hubInUse.usedBy) && hubInUse.usedBy.includes('used.example.com'),
    JSON.stringify(hubInUse.usedBy));
  check('the error says so in a sentence',
    typeof hubInUse.error === 'string'
      && hubInUse.error.startsWith('Certificate for used.example.com is still used by'),
    hubInUse.error);

  const hubRef = await ops.handleHubSslCommand({ action: 'delete', domain: 'ref.example.com' });
  check('a config-only refusal reaches the Hub too',
    hubRef.ok === false && hubRef.code === 'cert_in_use', JSON.stringify(hubRef.code));
  check('references carry a basename and a line, nothing else',
    Array.isArray(hubRef.references) && hubRef.references.length > 0
      && hubRef.references.every((r) => Object.keys(r).sort().join(',') === 'file,line'),
    JSON.stringify(hubRef.references));
  check('no reference leaks a full path or config text',
    hubRef.references.every((r) => !r.file.includes('/') && !r.file.includes('\\'))
      && hubRef.references.some((r) => r.file === 'ref.example.com.conf.disabled' && r.line === 4)
      && !JSON.stringify(hubRef).includes(forward(sslDir))
      && !JSON.stringify(hubRef).includes(forward(nginxDir))
      && !JSON.stringify(hubRef).includes('ssl_certificate'),
    JSON.stringify(hubRef.references));
  check('the reference file is still there and still in use',
    fs.existsSync(refConf) && fs.existsSync(path.join(sslDir, 'ref.example.com', 'fullchain.pem')));

  const hubMissing = await ops.handleHubSslCommand({ action: 'delete', domain: 'ghost.example.com' });
  check('an unknown certificate is cert_not_found',
    hubMissing.ok === false && hubMissing.code === 'cert_not_found', JSON.stringify(hubMissing.code));

  const hubNoName = await ops.handleHubSslCommand({ action: 'delete' });
  check('a delete without a domain is refused',
    hubNoName.ok === false && /domain is required/.test(hubNoName.error ?? ''), hubNoName.error);

  makeCert('hub-free.example.com');
  const hubDeleted = await ops.handleHubSslCommand({ action: 'delete', domain: 'hub-free.example.com' });
  check('an unused certificate is deleted through the Hub action',
    hubDeleted.ok === true && hubDeleted.deleted === true && hubDeleted.domain === 'hub-free.example.com',
    JSON.stringify(hubDeleted));
  check('  ...and its directory is gone',
    !fs.existsSync(path.join(sslDir, 'hub-free.example.com')));

  // ── (3) handleHubSslCommand: issue refusals (never reaches ACME) ──────────
  setGroup('(3) handleHubSslCommand issue: refused before any network call');
  const sslBefore = fs.readdirSync(sslDir).sort();

  const badDot = await ops.handleHubSslCommand({ action: 'issue', domain: '../x.com' });
  check('"../x.com" is refused as an invalid domain name',
    badDot.ok === false && String(badDot.error).startsWith('Invalid domain name:'), badDot.error);

  const tooShort = await ops.handleHubSslCommand({ action: 'issue', domain: 'a' });
  check('"a" is refused as an invalid domain name',
    tooShort.ok === false && String(tooShort.error).startsWith('Invalid domain name:'), tooShort.error);

  const wildcard = await ops.handleHubSslCommand({ action: 'issue', domain: '*.wild.example.com' });
  check('a wildcard is refused with the DNS-01 reason',
    wildcard.ok === false && /Wildcard|DNS-01/.test(wildcard.error ?? '')
      && !/Invalid domain name/.test(wildcard.error ?? ''), wildcard.error);

  const wildcardFlag = await ops.handleHubSslCommand({
    action: 'issue', domain: 'flag.example.com', wildcard: true,
  });
  check('a payload wildcard flag is refused the same way',
    wildcardFlag.ok === false && /Wildcard|DNS-01/.test(wildcardFlag.error ?? ''), wildcardFlag.error);

  const noEmail = await ops.handleHubSslCommand({ action: 'issue', domain: 'new.example.com' });
  check('a valid name with no acmeEmail is refused before issuance',
    noEmail.ok === false && /acmeEmail/.test(noEmail.error ?? ''), noEmail.error);

  check('no refusal created a certificate directory',
    fs.readdirSync(sslDir).sort().join(',') === sslBefore.join(','),
    fs.readdirSync(sslDir).sort().join(', '));

  // ── (4) handleHubDomainCommand: input checks and cert files ──────────────
  setGroup('(4) handleHubDomainCommand: validation and cert_missing');

  const nginxBefore = fs.readdirSync(nginxDir).sort();
  const evilCreate = await domainsDb.handleHubDomainCommand({
    action: 'create',
    domain: { name: '../../evil', port: 3200 },
  });
  check('a traversal name is refused on create',
    evilCreate.ok === false && /domain name/i.test(evilCreate.error ?? ''), evilCreate.error);
  check('  ...before any certificate check', evilCreate.code !== 'cert_missing',
    JSON.stringify(evilCreate.code ?? null));
  check('and nothing was written in nginxDir',
    fs.readdirSync(nginxDir).sort().join(',') === nginxBefore.join(','),
    fs.readdirSync(nginxDir).sort().join(', '));
  check('the evil domain was not stored', !domainsDb.findDomain('../../evil'));

  const missingCreate = await domainsDb.handleHubDomainCommand({
    action: 'create',
    domain: { name: 'nocert.example.com', port: 3201, ssl: { enabled: true } },
  });
  check('ssl.enabled with missing files is refused with cert_missing',
    missingCreate.ok === false && missingCreate.code === 'cert_missing',
    JSON.stringify(missingCreate.code ?? null));
  check('the refusal reports the paths it checked, under the scratch sslDir',
    forward(missingCreate.certPath) === certPath('nocert.example.com')
      && forward(missingCreate.keyPath) === keyPath('nocert.example.com'),
    JSON.stringify({ certPath: missingCreate.certPath, keyPath: missingCreate.keyPath }));
  check('and it carries the hint for the Hub to show',
    typeof missingCreate.hint === 'string' && missingCreate.hint.length > 20
      && missingCreate.error === missingCreate.hint, missingCreate.hint);
  check('the domain was not stored', !domainsDb.findDomain('nocert.example.com'));

  makeCert('ready.example.com');
  const readyCreate = await domainsDb.handleHubDomainCommand({
    action: 'create',
    domain: { name: 'ready.example.com', port: 3202, ssl: { enabled: true } },
  });
  // nginx is deliberately absent here, so the write/test step fails. What
  // matters is that the certificate check let it through.
  check('with the files present create gets past the cert_missing check',
    readyCreate.code !== 'cert_missing', JSON.stringify(readyCreate.code ?? null));

  const payloadConfig = path.join(nginxDir, 'payload-config.conf');
  const payloadConfigText = 'server { listen 8099; }\n';
  fs.writeFileSync(payloadConfig, payloadConfigText);

  const beforeMissingUpdate = domainsDb.findDomain('nofile.example.com');
  const missingUpdate = await domainsDb.handleHubDomainCommand({
    action: 'update',
    name: 'nofile.example.com',
    domain: {
      configFile: payloadConfig,
      enabled: false,
      createdAt: '1999-01-01T00:00:00.000Z',
      ssl: { enabled: true },
    },
  });
  check('update refuses ssl.enabled with missing files, with paths',
    missingUpdate.ok === false && missingUpdate.code === 'cert_missing'
      && forward(missingUpdate.certPath) === certPath('nofile.example.com'),
    JSON.stringify({ code: missingUpdate.code ?? null, certPath: missingUpdate.certPath }));
  const afterMissingUpdate = domainsDb.findDomain('nofile.example.com');
  check('the refused update stored nothing from the payload',
    afterMissingUpdate.enabled === beforeMissingUpdate.enabled
      && afterMissingUpdate.configFile === beforeMissingUpdate.configFile
      && afterMissingUpdate.createdAt === beforeMissingUpdate.createdAt,
    JSON.stringify({
      enabled: afterMissingUpdate.enabled,
      configFile: afterMissingUpdate.configFile,
      createdAt: afterMissingUpdate.createdAt,
    }));
  check('the payload configFile was left untouched',
    fs.existsSync(payloadConfig) && fs.readFileSync(payloadConfig, 'utf8') === payloadConfigText);

  // This update passes the certificate check (the files exist) and only fails
  // at the nginx step, which is absent in this suite. The payload's configFile,
  // enabled and createdAt must never be taken from the Hub either way.
  const beforeUsed = domainsDb.findDomain('used.example.com');
  const usedUpdate = await domainsDb.handleHubDomainCommand({
    action: 'update',
    name: 'used.example.com',
    domain: {
      configFile: payloadConfig,
      enabled: false,
      createdAt: '1999-01-01T00:00:00.000Z',
      port: 3300,
      ssl: { enabled: true, certPath: certPath('used.example.com'), keyPath: keyPath('used.example.com') },
    },
  });
  check('a valid update gets past the certificate check',
    usedUpdate.code !== 'cert_missing', JSON.stringify(usedUpdate.code ?? null));
  const afterUsed = domainsDb.findDomain('used.example.com');
  check('the payload configFile is not used as the target',
    fs.readFileSync(payloadConfig, 'utf8') === payloadConfigText);
  check('the stored domain keeps its own configFile/enabled/createdAt',
    afterUsed.configFile === beforeUsed.configFile
      && afterUsed.enabled === beforeUsed.enabled
      && afterUsed.createdAt === beforeUsed.createdAt,
    JSON.stringify({
      configFile: afterUsed.configFile,
      enabled: afterUsed.enabled,
      createdAt: afterUsed.createdAt,
    }));

  // ── (5) The agent refuses over the socket, and forwards the reason ────────
  setGroup('(5) hub:manageSSL delete over the fake Hub socket');

  const hub = await startTestHub();
  const agent = await import(srcUrl('core/hub/agent.js'));
  const { saveHubLink, clearHubLink, saveHubPermissions } = await import(srcUrl('core/hubLink.js'));
  saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

  /** Emits a command and waits for BOTH the ack and command:result. */
  const dispatch = async (payload) => {
    const before = hub.state.results.length;
    const requestId = `req-${Math.random().toString(16).slice(2)}`;
    let acked = null;
    if (hub.state.socket) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 15_000);
        hub.state.socket.emit('hub:manageSSL', { ...payload, requestId }, (ack) => {
          acked = ack;
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await waitUntil(() => hub.state.results.length > before, { timeoutMs: 15_000 });
    return {
      acked,
      event: hub.state.results.find((r) => r.requestId === requestId) ?? null,
      requestId,
    };
  };

  try {
    saveHubPermissions({ 'ssl.delete': true });
    agent.initHubAgent();
    check('the agent connects to the fake Hub', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);

    const refused = await dispatch({ action: 'delete', domain: 'used.example.com' });
    check('a refusal is emitted as command:result with ok:false',
      refused.event?.ok === false, JSON.stringify(refused.event));
    check('the command:result carries the handler\'s result as data',
      refused.event?.data?.code === 'cert_in_use'
        && Array.isArray(refused.event?.data?.usedBy)
        && refused.event.data.usedBy.includes('used.example.com'),
      JSON.stringify(refused.event?.data));
    check('the error is the handler\'s sentence, not "undefined"',
      typeof refused.event?.error === 'string'
        && refused.event.error.includes('still used by used.example.com'),
      refused.event?.error);
    check('the acknowledgement agrees, with the same data',
      refused.acked?.ok === false && refused.acked?.data?.code === 'cert_in_use',
      JSON.stringify(refused.acked));
    check('the certificate was not deleted by the refused command',
      fs.existsSync(path.join(sslDir, 'used.example.com', 'fullchain.pem')));

    saveHubPermissions({ 'ssl.delete': false });
    const ungated = await dispatch({ action: 'delete', domain: 'used.example.com' });
    check('without ssl.delete the command is refused',
      ungated.event?.ok === false && /ssl\.delete/.test(ungated.event?.error ?? ''),
      ungated.event?.error);
    check('a permission refusal carries data: null, not a handler result',
      ungated.event?.data === null, JSON.stringify(ungated.event?.data));
    check('the ack for the permission refusal is equally empty',
      ungated.acked?.ok === false && ungated.acked?.data === null,
      JSON.stringify(ungated.acked));
  } finally {
    agent.stopHubAgent();
    clearHubLink();
    await hub.close();
  }

  // ── (6) DELETE /api/ssl/:domain on the real dashboard ────────────────────
  setGroup('(6) dashboard DELETE /api/ssl/:domain');

  makeCert('dash-free.example.com');

  // The dashboard is a separate process opening the same SQLite file, so this
  // process must let go of it first.
  const coreDb = await import(srcUrl('core/db.js'));
  coreDb.closeDb();

  const port = await freePort();
  DASH = `http://127.0.0.1:${port}`;
  start('dashboard', [path.join('src', 'dashboard', 'server.js')], {
    ...process.env, EASY_DEVOPS_DATA_DIR: TEST_DATA_DIR, DASHBOARD_PORT: String(port),
  });
  await waitFor(`${DASH}/api/health`, 'dashboard');

  const setupCode = await issueSetupCode({ dataDir: TEST_DATA_DIR });
  const setup = await req('POST', '/api/setup', { body: { password: PASSWORD, setupCode } });
  check('first-run setup signs in', setup.status === 200 && Boolean(setup.cookie),
    `status ${setup.status}`);
  const cookie = setup.cookie;

  const missing = await req('DELETE', '/api/ssl/ghost.example.com', { cookie });
  check('an unknown certificate answers 404', missing.status === 404,
    `status ${missing.status}`);

  const conflict = await req('DELETE', '/api/ssl/used.example.com', { cookie });
  check('an in-use certificate answers 409 cert_in_use',
    conflict.status === 409 && conflict.body?.error === 'cert_in_use',
    `status ${conflict.status} ${JSON.stringify(conflict.body?.error)}`);
  check('the 409 names the domains that still use it',
    Array.isArray(conflict.body?.usedBy) && conflict.body.usedBy.includes('used.example.com'),
    JSON.stringify(conflict.body?.usedBy));
  check('the 409 carries the nginx references',
    Array.isArray(conflict.body?.references), JSON.stringify(conflict.body?.references));
  check('the in-use certificate is still on disk',
    fs.existsSync(path.join(sslDir, 'used.example.com', 'fullchain.pem')));

  const deleted = await req('DELETE', '/api/ssl/dash-free.example.com', { cookie });
  check('an unused certificate answers 200 and names it',
    deleted.status === 200 && deleted.body?.deleted === 'dash-free.example.com',
    `status ${deleted.status} ${JSON.stringify(deleted.body?.deleted)}`);
  check('the dashboard removed the directory',
    !fs.existsSync(path.join(sslDir, 'dash-free.example.com')));

  await stopAll();

  // ── (7) Isolation ────────────────────────────────────────────────────────
  setGroup('(7) isolation');
  const legacyAfter = fs.existsSync(REAL_LEGACY_DB) ? fs.statSync(REAL_LEGACY_DB).mtimeMs : null;
  check('data/easy-devops.sqlite untouched', legacyAfter === legacyBefore);
  check('no .migrated file created', !fs.existsSync(`${REAL_LEGACY_DB}.migrated`));
  check('the sentinel in sslDir\'s parent is still intact',
    fs.existsSync(parentSentinel) && fs.existsSync(outsideFile));
  check('the protected certificate is still on disk at the end',
    fs.existsSync(path.join(sslDir, 'used.example.com', 'privkey.pem')));
  check('no child process is left running', procs.length === 0);

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` — ${f.detail}` : ''}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  process.stderr.write(`\nHarness error: ${err.stack}\n`);
  await stopAll();
  process.exit(1);
});
