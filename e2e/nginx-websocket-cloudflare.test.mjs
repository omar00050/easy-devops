/**
 * e2e/nginx-websocket-cloudflare.test.mjs
 *
 * Generated-config-text tests for two additions to the nginx generator:
 *
 *   1. every proxied domain is WebSocket-ready, with ONE shared
 *      `map $http_upgrade $ezz_connection_upgrade` and a `/socket.io/` location;
 *   2. the per-domain `behindCloudflare` option emits Cloudflare's published
 *      ranges as `set_real_ip_from` and `real_ip_header CF-Connecting-IP`.
 *
 * Nothing here runs nginx or touches a real config: assertions are against
 * pure builder functions, plus one temp directory for the map file. The
 * Windows path branch runs in a CHILD process, because `isWindows` is captured
 * at module load and ESM cannot re-evaluate a transitive import.
 *
 * Run with:  npm run test:e2e -- nginx-websocket-cloudflare
 */

// MUST be the first import: see e2e/run.mjs and e2e/lib/guard.mjs.
import './lib/guard.mjs';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SELF = fileURLToPath(import.meta.url);
const MARKER = '@@RESULTS@@';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeDomain(gen, overrides = {}) {
  return {
    ...gen.DOMAIN_DEFAULTS,
    name: 'test.example.com',
    port: 3000,
    ...overrides,
    ssl: { ...gen.DOMAIN_DEFAULTS.ssl, ...(overrides.ssl ?? {}) },
  };
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function locationBlock(conf, header) {
  const lines = conf.split('\n');
  const start = lines.findIndex((line) => line.includes(header));
  if (start === -1) return '';
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    out.push(lines[i]);
    if (lines[i].trim() === '}') break;
  }
  return out.join('\n');
}

// ─── Child: Windows / Linux path handling ─────────────────────────────────────

async function runChild(platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  const gen = await import(pathToFileURL(path.join(ROOT, 'src/core/nginx-conf-generator.js')).href);
  const plat = await import(pathToFileURL(path.join(ROOT, 'src/core/platform.js')).href);

  const out = [];
  const check = (label, passed, detail = '') => out.push({ label, passed, detail });

  check('harness', plat.isWindows === (platform === 'win32'),
    `isWindows=${plat.isWindows} for platform=${platform}`);

  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const nginxDir = platform === 'win32' ? String.raw`C:\nginx` : '/etc/nginx';
  const expectedConfD = platform === 'win32'
    ? String.raw`C:\nginx\conf\conf.d`
    : '/etc/nginx/conf.d';
  const expectedMap = join(expectedConfD, gen.WEBSOCKET_MAP_FILENAME);

  const confD = gen.getConfDDir(nginxDir);
  const mapPath = gen.websocketMapPath(nginxDir);

  check('conf.d path is platform-specific', confD === expectedConfD, confD);
  check('map file lives in conf.d', mapPath === expectedMap, mapPath);
  check('map file name is the shared one',
    path.basename(mapPath) === gen.WEBSOCKET_MAP_FILENAME, path.basename(mapPath));
  check('map file path uses the platform separator',
    platform === 'win32' ? !mapPath.includes('/') : !mapPath.includes('\\'), mapPath);
  check('map content has no absolute path (include is by glob)',
    !gen.buildWebsocketMapConf().includes('conf.d'), '(none)');

  process.stdout.write(MARKER + JSON.stringify(out));
  process.exit(0);
}

async function runPlatformChild(platform, scratch) {
  const child = spawn(process.execPath, [SELF], {
    cwd: ROOT,
    env: {
      ...process.env,
      EZ_FAKE_PLATFORM: platform,
      EZ_TEST: '1',
      EASY_DEVOPS_DATA_DIR: scratch,
      APPDATA: scratch,
      HOME: scratch,
      USERPROFILE: scratch,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const [code] = await once(child, 'exit');

  const at = stdout.indexOf(MARKER);
  if (at === -1) {
    throw new Error(`child for ${platform} produced no results (exit ${code})\n${stdout}\n${stderr}`);
  }
  return JSON.parse(stdout.slice(at + MARKER.length));
}

// ─── Parent: generated text ───────────────────────────────────────────────────

async function main() {
  const gen = await import(pathToFileURL(path.join(ROOT, 'src/core/nginx-conf-generator.js')).href);
  const cf = await import(pathToFileURL(path.join(ROOT, 'src/core/cloudflare-ips.js')).href);
  const { validateBehindCloudflare } = await import(
    pathToFileURL(path.join(ROOT, 'src/core/validators.js')).href
  );

  const all = [];
  let group = '';
  const setGroup = (g) => { group = g; };
  const check = (label, passed, detail = '') => all.push({ group, label, passed, detail });

  // ── The shared map ─────────────────────────────────────────────────────────
  setGroup('Map: defined once for many domains');

  const mapConf = gen.buildWebsocketMapConf();
  const domainA = gen.buildConf(makeDomain(gen, { name: 'a.example.com' }),
    '/etc/nginx', '/etc/easy-devops/ssl');
  const domainB = gen.buildConf(makeDomain(gen, { name: 'b.example.com', port: 4000 }),
    '/etc/nginx', '/etc/easy-devops/ssl');

  const combined = [mapConf, domainA, domainB].join('\n');
  check('map directive is present exactly once',
    countOccurrences(combined, 'map $http_upgrade $ezz_connection_upgrade') === 1,
    String(countOccurrences(combined, 'map $http_upgrade $ezz_connection_upgrade')));
  check('map has default upgrade', /default\s+upgrade;/.test(mapConf));
  check("plain requests are not forced to close or upgrade",
    /''\s+'';/.test(mapConf), mapConf.split('\n').find((l) => l.includes("''")) || '(missing)');
  check('no domain config defines the map itself',
    countOccurrences(domainA, 'map $http_upgrade') === 0 &&
      countOccurrences(domainB, 'map $http_upgrade') === 0);

  const tmpNginx = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-map-'));
  try {
    const written = await gen.ensureWebsocketMap(tmpNginx);
    const first = fs.readFileSync(written, 'utf8');
    const secondPath = await gen.ensureWebsocketMap(tmpNginx);
    const files = fs.readdirSync(path.dirname(written)).filter((f) => f.endsWith('.conf'));
    check('ensureWebsocketMap writes the map file in conf.d',
      written === gen.websocketMapPath(tmpNginx) && fs.existsSync(written), written);
    check('writing it again is idempotent (one file, one map)',
      secondPath === written && files.length === 1 &&
        countOccurrences(first, 'map $http_upgrade') === 1,
      files.join(','));
  } finally {
    fs.rmSync(tmpNginx, { recursive: true, force: true });
  }

  // ── WebSocket proxying on a plain domain ───────────────────────────────────
  setGroup('Proxy: WebSocket-ready without forcing an upgrade');

  check('proxy_http_version 1.1 is emitted',
    countOccurrences(domainA, 'proxy_http_version 1.1;') >= 1);
  check('Upgrade sends $http_upgrade',
    countOccurrences(domainA, 'proxy_set_header Upgrade $http_upgrade;') >= 1);
  check('Connection uses $ezz_connection_upgrade',
    countOccurrences(domainA, 'proxy_set_header Connection $ezz_connection_upgrade;') >= 1);
  check('the old forced Connection "upgrade" is gone',
    !domainA.includes('Connection "upgrade"'));
  for (const [header, value] of [
    ['Host', '$host'],
    ['X-Real-IP', '$remote_addr'],
    ['X-Forwarded-For', '$proxy_add_x_forwarded_for'],
    ['X-Forwarded-Proto', '$scheme'],
  ]) {
    check(`existing header ${header} is unchanged`,
      domainA.includes(`proxy_set_header ${header} ${value};`));
  }

  // ── Socket.IO location ─────────────────────────────────────────────────────
  setGroup('Socket.IO: unbuffered with long timeouts');

  const socket = locationBlock(domainA, 'location ^~ /socket.io/ {');
  check('Socket.IO location exists', socket !== '');
  check('Socket.IO disables proxy buffering', socket.includes('proxy_buffering off;'));
  check('Socket.IO read timeout is 3600s', socket.includes('proxy_read_timeout 3600s;'));
  check('Socket.IO send timeout is 3600s', socket.includes('proxy_send_timeout 3600s;'));
  check('Socket.IO keeps the WebSocket headers',
    socket.includes('proxy_http_version 1.1;') &&
      socket.includes('proxy_set_header Connection $ezz_connection_upgrade;'));
  const plain = locationBlock(domainA, 'location / {');
  check('ordinary HTTP keeps the configured read timeout',
    plain.includes('proxy_read_timeout 60s;'), plain.split('\n').find((l) => l.includes('read_timeout')) || '');

  // ── behindCloudflare off ───────────────────────────────────────────────────
  setGroup('Cloudflare: off by default');

  const off = gen.buildConf(makeDomain(gen, { behindCloudflare: false }),
    '/etc/nginx', '/etc/easy-devops/ssl');
  check('behindCloudflare=false emits no set_real_ip_from',
    !off.includes('set_real_ip_from'));
  check('behindCloudflare=false emits no real_ip_header',
    !off.includes('real_ip_header'));

  const legacyV2 = gen.migrateDomain({
    name: 'old.example.com',
    port: 3000,
    ssl: { enabled: false },
  });
  check('a stored v2 domain without the field still migrates',
    legacyV2.behindCloudflare === false, String(legacyV2.behindCloudflare));
  const legacyV1 = gen.migrateDomain({ name: 'v1.example.com', port: 3000 });
  check('a legacy v1 domain without the field still migrates',
    legacyV1.behindCloudflare === false, String(legacyV1.behindCloudflare));
  check('an old domain object generates no Cloudflare directives',
    !gen.buildConf(legacyV2, '/etc/nginx', '/etc/easy-devops/ssl').includes('set_real_ip_from'));

  // ── behindCloudflare on ────────────────────────────────────────────────────
  setGroup('Cloudflare: every published range');

  const on = gen.buildConf(makeDomain(gen, { behindCloudflare: true }),
    '/etc/nginx', '/etc/easy-devops/ssl');
  check('real_ip_header is CF-Connecting-IP',
    on.includes('real_ip_header CF-Connecting-IP;'));
  check('generated config says the app trusts one proxy',
    on.includes('TRUST_PROXY=1'));

  const missing = [...cf.CLOUDFLARE_IPV4, ...cf.CLOUDFLARE_IPV6]
    .filter((range) => !on.includes(`set_real_ip_from ${range};`));
  check('every IPv4 and IPv6 range is present', missing.length === 0, missing.join(','));
  check('one set_real_ip_from line per range, no duplicates',
    countOccurrences(on, 'set_real_ip_from ') === cf.CLOUDFLARE_RANGES.length,
    `${countOccurrences(on, 'set_real_ip_from ')} lines / ${cf.CLOUDFLARE_RANGES.length} ranges`);
  check('IPv4 and IPv6 lists are both non-empty',
    cf.CLOUDFLARE_IPV4.length > 0 && cf.CLOUDFLARE_IPV6.length > 0);
  check('the shipped lists have a refresh date',
    /^\d{4}-\d{2}-\d{2}$/.test(cf.LAST_REFRESHED), cf.LAST_REFRESHED);
  check('source URLs are Cloudflare official',
    cf.SOURCE_URLS.ipv4 === 'https://www.cloudflare.com/ips-v4' &&
      cf.SOURCE_URLS.ipv6 === 'https://www.cloudflare.com/ips-v6');

  // ── Validation ─────────────────────────────────────────────────────────────
  setGroup('Validation');

  check('validateBehindCloudflare accepts true', validateBehindCloudflare(true) === null);
  check('validateBehindCloudflare accepts false', validateBehindCloudflare(false) === null);
  check('validateBehindCloudflare accepts an absent field',
    validateBehindCloudflare(undefined) === null);
  for (const bad of ['true', 1, 0, {}, []]) {
    check(`validateBehindCloudflare rejects ${JSON.stringify(bad)}`,
      typeof validateBehindCloudflare(bad) === 'string');
  }

  setGroup('Cloudflare: every shipped entry is a CIDR');

  const v4 = cf.validateCidrList(cf.CLOUDFLARE_IPV4, 4);
  const v6 = cf.validateCidrList(cf.CLOUDFLARE_IPV6, 6);
  check('all IPv4 entries parse as CIDRs', v4.ok, v4.invalid.join(','));
  check('all IPv6 entries parse as CIDRs', v6.ok, v6.invalid.join(','));
  check('all combined entries parse as CIDRs',
    cf.CLOUDFLARE_RANGES.every((entry) => cf.isValidCidr(entry)));
  let asserted = true;
  try { cf.assertShippedRanges(); } catch { asserted = false; }
  check('assertShippedRanges accepts the shipped file', asserted);
  for (const bad of ['1.2.3.4/33', '1.2.3.4', 'nope', '2001:db8::/129', '', 42]) {
    check(`isValidCidr rejects ${JSON.stringify(bad)}`, !cf.isValidCidr(bad));
  }

  // ── Platform paths (child process) ─────────────────────────────────────────
  setGroup('Paths: Windows and Linux');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-cf-child-'));
  try {
    // getConfDDir() uses explicit win32/posix joins, so both platform branches
    // are meaningful even on a host whose path module default differs.
    for (const platform of ['win32', 'linux']) {
      const results = await runPlatformChild(platform, scratch);
      for (const r of results) all.push({ group: `${group} (${platform})`, ...r });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  let current = '';
  for (const r of all) {
    if (r.group && r.group !== current) {
      current = r.group;
      process.stdout.write(`\n── ${current}\n`);
    }
    process.stdout.write(
      `   ${r.passed ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? `  (${r.detail})` : ''}\n`
    );
  }

  const failed = all.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${all.length}   PASS ${all.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label} ${f.detail}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

if (process.env.EZ_FAKE_PLATFORM) {
  runChild(process.env.EZ_FAKE_PLATFORM).catch((err) => {
    process.stderr.write(String(err.stack || err) + '\n');
    process.exit(1);
  });
} else {
  main().catch((err) => {
    process.stderr.write(String(err.stack || err) + '\n');
    process.exit(1);
  });
}
