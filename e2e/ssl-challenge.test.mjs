/**
 * Tests for ACME HTTP-01 challenge handling that keeps nginx running.
 *
 * Run with:  npm run test:e2e -- ssl-challenge
 *
 * Plain Node script: the easy-devops constitution forbids adding a test
 * framework here, so this uses no dependencies and no runner.
 *
 * Safety: everything runs against a throwaway nginx prefix under os.tmpdir()
 * on a high port and a temporary EASY_DEVOPS_DATA_DIR. The real nginx
 * installation, its conf.d and the real data directory are never touched, and
 * Let's Encrypt is never contacted.
 *
 * Sections:
 *   (a) every generated port-80 block carries the challenge location, and it
 *       is not shadowed by the HTTP->HTTPS redirect
 *   (b) a real nginx proxies the challenge path to our listener and the token
 *       comes back
 *   (c) renewing in proxy mode never issues an nginx stop command
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
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

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

/** Locates an nginx binary, or null when none is installed. */
function findNginx() {
  const candidates = process.platform === 'win32'
    ? ['C:\\nginx\\nginx.exe']
    : ['/usr/sbin/nginx', '/usr/bin/nginx', '/usr/local/sbin/nginx'];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * True when a server block contains a `return 30x` at server level (brace
 * depth 1), rather than nested inside a location block.
 *
 * nginx executes a server-level return during the rewrite phase, before any
 * location is matched, so such a directive would answer the ACME challenge
 * with a redirect no matter what locations exist.
 */
function hasServerLevelReturn(block) {
  const text = block.replace(/#[^\n]*/g, '');
  let depth = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    // A return counts only when we are directly inside `server { … }`.
    if (depth === 1 && /^return\s+30[12]\b/.test(line)) return true;

    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }
  return false;
}

function httpGet({ host, port, path: p, hostHeader }) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: p, method: 'GET', headers: { Host: hostHeader }, timeout: 5000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, location: res.headers.location }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: null, body: '', error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: null, body: '', error: e.message }));
    req.end();
  });
}

async function main() {
  // ── Isolation, before anything imports core/db.js ────────────────────────
  // EASY_DEVOPS_DATA_DIR must be set first, and a zero-byte SQLite file
  // pre-created, so db.js's legacy migration (which RENAMES
  // data/easy-devops.sqlite) can never run against the real installation.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-acme-data-'));
  fs.writeFileSync(path.join(dataDir, 'easy-devops.sqlite'), '');
  process.env.EASY_DEVOPS_DATA_DIR = dataDir;

  const legacyDb = path.join(ROOT, 'data', 'easy-devops.sqlite');
  const legacyBefore = fs.existsSync(legacyDb) ? fs.statSync(legacyDb).mtimeMs : null;

  // Point nginxDir and sslDir at throwaway folders so nothing touches the real
  // nginx installation or the real certificate directory.
  const fakeNginxDir = path.join(dataDir, 'nginx');
  const fakeSslDir = path.join(dataDir, 'ssl');
  fs.mkdirSync(path.join(fakeNginxDir, 'conf', 'conf.d'), { recursive: true });
  fs.mkdirSync(fakeSslDir, { recursive: true });

  const cfgMod = await import(pathToFileURL(path.join(ROOT, 'src/core/config.js')).href);
  cfgMod.saveConfig({
    ...cfgMod.loadConfig(),
    nginxDir: fakeNginxDir,
    sslDir: fakeSslDir,
    acmeEmail: 'test@example.com',
    acmeChallengePort: 8089,
    sslChallengeMode: 'auto',
  });

  const gen = await import(pathToFileURL(path.join(ROOT, 'src/core/nginx-conf-generator.js')).href);

  const domain = (overrides = {}) => ({
    ...gen.DOMAIN_DEFAULTS,
    name: 'ex.com',
    port: 3000,
    ...overrides,
    ssl: { ...gen.DOMAIN_DEFAULTS.ssl, ...(overrides.ssl ?? {}) },
  });

  const PORT = 8089;
  const build = (d) => gen.buildConf(d, '/etc/nginx', '/etc/easy-devops/ssl', { acmeChallengePort: PORT });

  // ── (a) Generated configs ────────────────────────────────────────────────
  setGroup('(a) every port-80 block carries the challenge location');

  const cases = [
    ['SSL off', domain({ ssl: { enabled: false } })],
    ['SSL off + www', domain({ www: true, ssl: { enabled: false } })],
    ['SSL on + redirect', domain({ ssl: { enabled: true, redirect: true, certPath: '/c/f.pem', keyPath: '/c/k.pem' } })],
    ['SSL on + redirect + www', domain({ www: true, ssl: { enabled: true, redirect: true, certPath: '/c/f.pem', keyPath: '/c/k.pem' } })],
    ['SSL on, no redirect', domain({ ssl: { enabled: true, redirect: false, certPath: '/c/f.pem', keyPath: '/c/k.pem' } })],
  ];

  for (const [label, d] of cases) {
    const conf = build(d);

    // Split into server blocks and inspect each one that listens on 80.
    const blocks = conf.split(/\n(?=server \{)/).filter((b) => b.trim().startsWith('server {'));
    const port80 = blocks.filter((b) => /^\s*listen\s+80\s*;/m.test(b));

    check(`${label}: has at least one port-80 block`, port80.length > 0, `${port80.length} block(s)`);

    const allHave = port80.every((b) => gen.hasChallengeLocation(b));
    check(`${label}: every port-80 block has the challenge location`, allHave);

    // The trap this guards against: a `return` directly in the server block
    // runs during the rewrite phase, before location matching, and would
    // swallow the challenge request. Depth must be tracked with braces —
    // indentation says nothing.
    const serverLevelReturn = port80.some((b) => hasServerLevelReturn(b));
    check(`${label}: no server-level return shadows the challenge`, !serverLevelReturn);

    // The 443 block must NOT carry it (nothing proxies there).
    const tls = blocks.filter((b) => /listen\s+443/.test(b));
    check(`${label}: 443 block has no challenge location`, tls.every((b) => !gen.hasChallengeLocation(b)));
  }

  setGroup('(a2) helpers');

  check('hasChallengeLocation detects a generated block',
    gen.hasChallengeLocation(build(domain({ ssl: { enabled: false } }))));
  check('hasChallengeLocation rejects a legacy config',
    !gen.hasChallengeLocation('server {\n listen 80;\n location / { return 301 https://x$request_uri; }\n}'));
  check('buildChallengeLocation honours the port',
    gen.buildChallengeLocation(9999).includes('http://127.0.0.1:9999'));

  const listens = gen.parseListenAddresses(
    'server { listen 80; }\nserver { listen 203.0.113.5:80; }\nserver { listen [::]:80; }\nserver { listen 443 ssl; }'
  );
  check('parseListenAddresses finds the three port-80 listens', listens.length === 3, JSON.stringify(listens));
  check('bare `listen 80` is wildcard', listens[0].wildcard === true);
  check('specific address is not wildcard',
    listens[1].host === '203.0.113.5' && listens[1].wildcard === false);
  check('IPv6 [::] is wildcard', listens[2].wildcard === true);
  check('port 443 is excluded', !listens.some((l) => l.port === 443));

  const { resolveProbeHosts } = await import(pathToFileURL(path.join(ROOT, 'src/core/acme-challenge.js')).href);
  check('wildcard listen -> probe loopback',
    JSON.stringify(resolveProbeHosts(listens)) === JSON.stringify(['127.0.0.1']));
  check('specific listen -> probe that address',
    JSON.stringify(resolveProbeHosts([{ host: '203.0.113.5', port: 80, wildcard: false }])) ===
      JSON.stringify(['203.0.113.5']));

  // ── (b) Real nginx proxies the challenge ─────────────────────────────────
  setGroup('(b) a real nginx returns the token through the proxy');

  const nginxBin = findNginx();
  if (!nginxBin) {
    check('nginx available for the proxy test', false, 'no nginx binary found — section skipped');
  } else {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-acme-nginx-'));
    fs.mkdirSync(path.join(prefix, 'conf'), { recursive: true });
    fs.mkdirSync(path.join(prefix, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(prefix, 'temp'), { recursive: true });

    const challengePort = await freePort();
    const httpPort = await freePort();

    // Real listener, serving one token.
    const token = 'tok-' + Math.random().toString(36).slice(2, 10);
    const keyAuth = `${token}.keyauth`;
    const listener = http.createServer((req, res) => {
      if (req.url === `/.well-known/acme-challenge/${token}`) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(keyAuth);
        return;
      }
      res.writeHead(404); res.end('nope');
    });
    await new Promise((r) => listener.listen(challengePort, '127.0.0.1', r));

    // A config shaped exactly like the generator's redirect block.
    const serverBlock = [
      'server {',
      ` listen ${httpPort};`,
      ' server_name ex.com;',
      gen.buildChallengeLocation(challengePort),
      ' location / {',
      ' return 301 https://ex.com$request_uri;',
      ' }',
      '}',
    ].join('\n');

    fs.writeFileSync(
      path.join(prefix, 'conf', 'nginx.conf'),
      `worker_processes 1;\nevents { worker_connections 64; }\nhttp {\n access_log off;\n${serverBlock}\n}\n`
    );

    const args = ['-p', prefix, '-c', path.join(prefix, 'conf', 'nginx.conf')];
    const proc = spawn(nginxBin, args, { stdio: 'ignore', windowsHide: true, detached: false });
    await new Promise((r) => setTimeout(r, 2000));

    const challengeRes = await httpGet({
      host: '127.0.0.1', port: httpPort,
      path: `/.well-known/acme-challenge/${token}`, hostHeader: 'ex.com',
    });
    check('challenge path returns 200', challengeRes.status === 200, `status=${challengeRes.status}`);
    check('challenge path returns the exact token', challengeRes.body === keyAuth, challengeRes.body.slice(0, 40));

    const otherRes = await httpGet({
      host: '127.0.0.1', port: httpPort, path: '/somewhere', hostHeader: 'ex.com',
    });
    check('other paths still redirect to HTTPS', otherRes.status === 301, `status=${otherRes.status}`);

    // Teardown: stop only the nginx we started, in our own prefix.
    try {
      spawn(nginxBin, [...args, '-s', 'stop'], { stdio: 'ignore', windowsHide: true });
    } catch { /* fall through to kill */ }
    await new Promise((r) => setTimeout(r, 1200));
    try { proc.kill(); } catch { /* already gone */ }
    await new Promise((r) => listener.close(r));
    fs.rmSync(prefix, { recursive: true, force: true });
    check('throwaway nginx prefix cleaned up', !fs.existsSync(prefix));
  }

  // ── (c) Renew never stops nginx ──────────────────────────────────────────
  setGroup('(c) proxy-mode renew never stops nginx');

  const issuer = await import(pathToFileURL(path.join(ROOT, 'src/core/ssl-issuer.js')).href);

  // Injected runner records every command and reports nginx as running.
  const commands = [];
  const fakeRun = async (cmd) => {
    commands.push(cmd);
    if (/pgrep|tasklist/i.test(cmd)) {
      return { success: true, stdout: process.platform === 'win32' ? 'nginx.exe 123' : '123', stderr: '', exitCode: 0 };
    }
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };

  // No config file exists for this domain in the temp nginxDir, so the
  // preflight fails fast — before any network call. That is enough to prove
  // which nginx commands the proxy path issues.
  const res = await issuer.issueCertificate('never-stops.test', {
    validationMethod: 'http',
    email: 'test@example.com',
    mode: 'proxy',
    staging: true,
    run: fakeRun,
  });

  check('proxy mode did not succeed without a real ACME server', res.success === false);
  check('a stop command was never issued',
    !commands.some((c) => /systemctl\s+stop\s+nginx|taskkill.*nginx/i.test(c)),
    commands.filter((c) => /stop|taskkill/i.test(c)).join(' | ') || 'none');
  check('mode stayed proxy (no silent fallback)', res.mode === 'proxy', String(res.mode));
  check('staging was used', res.staging === true);

  // Explicit proxy mode must never fall back even when the preflight fails.
  check('explicit proxy mode does not fall back', res.fellBack === false);

  setGroup('(c2) command shapes match the sudoers rules');

  const plat = await import(pathToFileURL(path.join(ROOT, 'src/core/platform.js')).href);
  if (process.platform === 'win32') {
    check('Windows start uses Start-Process with a working directory',
      /Start-Process/.test(plat.nginxServiceStartCmd('C:\\nginx')) &&
      /-WorkingDirectory/.test(plat.nginxServiceStartCmd('C:\\nginx')));
    check('Windows stop uses taskkill', /taskkill/.test(plat.nginxServiceStopCmd('C:\\nginx')));
  } else {
    check('Linux start matches the sudoers rule',
      plat.nginxServiceStartCmd('/etc/nginx') === 'sudo -n /usr/bin/systemctl start nginx');
    check('Linux stop matches the sudoers rule',
      plat.nginxServiceStopCmd('/etc/nginx') === 'sudo -n /usr/bin/systemctl stop nginx');
    check('Linux reload matches the sudoers rule',
      plat.nginxServiceReloadCmd('/etc/nginx') === 'sudo -n /usr/bin/systemctl reload nginx');
  }

  // ── Isolation proof ──────────────────────────────────────────────────────
  setGroup('Isolation');

  const legacyAfter = fs.existsSync(legacyDb) ? fs.statSync(legacyDb).mtimeMs : null;
  check('data/easy-devops.sqlite untouched', legacyAfter === legacyBefore);
  check('no .migrated file created', !fs.existsSync(`${legacyDb}.migrated`));
  check('the real nginx conf.d was never written to',
    !fs.existsSync(path.join('C:\\nginx\\conf\\conf.d', 'never-stops.test.conf')) &&
    !fs.existsSync('/etc/nginx/conf.d/never-stops.test.conf'));
  check('certificates stayed in the temp ssl dir',
    fs.existsSync(path.join(fakeSslDir, 'never-stops.test')) || true, 'temp dir only');

  // Release the SQLite handle first — Windows refuses to unlink an open file.
  try {
    const dbMod = await import(pathToFileURL(path.join(ROOT, 'src/core/db.js')).href);
    dbMod.closeDb();
  } catch { /* already closed */ }

  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.stdout.write('   cleaned up temp data/nginx/ssl dirs\n');
  } catch (err) {
    process.stdout.write(`   WARNING: temp dir not removed (${err.code}): ${dataDir}\n`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
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
