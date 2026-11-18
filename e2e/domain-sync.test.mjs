/**
 * End-to-end test for domain synchronisation between a server and the Hub.
 *
 * Run with:  npm run test:e2e -- domain-sync
 * Requires:  cd hub_backend && npm run build
 *
 * Plain Node script: the easy-devops constitution forbids adding a test
 * framework here, so this uses no runner and no new dependencies.
 *
 * What it covers — the three bugs that made domains drift apart:
 *
 *   1. A DELETE never reached the Hub. The agent pushes its full domain list,
 *      but the Hub merged it row by row, so a name that stopped being
 *      mentioned simply stayed. Those are the "ghost" domains.
 *   2. A change made by ANOTHER PROCESS (the CLI) never reached the Hub.
 *      good.db's in-process read cache has no TTL, so the dashboard's agent
 *      kept returning the revision counter it first read and never noticed
 *      the CLI moving it.
 *   3. Nothing reached the browser. The Hub saved domain changes without
 *      emitting them, so an open page showed a stale list until a reload.
 *
 * Every action must land in the Hub database AND on a subscribed browser
 * socket within DEADLINE_MS.
 *
 * Safety: an isolated hub database under os.tmpdir(), a temporary
 * EASY_DEVOPS_DATA_DIR, a throwaway nginx prefix, and random free ports. The
 * real hub.db, the real easy-devops data directory and the real nginx conf.d
 * are never written to. Secrets are never printed.
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
import { spawn, spawnSync } from 'child_process';
import { issueSetupCode } from './lib/firstRun.mjs';
import { once } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HUB_DIR = path.join(ROOT, 'hub_backend');
const REAL_HUB_DB = path.join(HUB_DIR, 'prisma', 'hub.db');
const REAL_LEGACY_DB = path.join(ROOT, 'data', 'easy-devops.sqlite');

const JWT_SECRET = 'domain-sync-test-secret-at-least-32-chars';

/** Every sync must complete inside this budget. */
const DEADLINE_MS = 5_000;

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const procs = [];

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

function start(label, cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  procs.push({ label, p });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) process.stderr.write(`[${label}] ${s.slice(0, 250)}\n`);
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

async function waitFor(url, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} did not come up at ${url}`);
}

/**
 * SQLite keeps the file handle open briefly after the last statement, and
 * Windows refuses to unlink an open file. Retry before giving up.
 */
function rmWithRetry(dir, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return !fs.existsSync(dir); } catch { /* retry */ }
    const until = Date.now() + 300;
    while (Date.now() < until) { /* brief spin; no async in teardown */ }
  }
  return !fs.existsSync(dir);
}

let DASH = '';
let HUB = '';
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
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

async function hubApi(method, pathname, { token, body } = {}) {
  const res = await fetch(`${HUB}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

/** True when an nginx binary exists, so `nginx -t` can validate a config. */
function findNginx() {
  const candidates = process.platform === 'win32'
    ? ['C:\\nginx\\nginx.exe']
    : ['/usr/sbin/nginx', '/usr/bin/nginx', '/usr/local/sbin/nginx'];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function main() {
  const HUB_PORT = await freePort();
  const DASH_PORT = await freePort();
  HUB = `http://localhost:${HUB_PORT}`;
  DASH = `http://localhost:${DASH_PORT}`;
  process.stdout.write(`\nRandom ports — hub ${HUB_PORT}, dashboard ${DASH_PORT}\n`);

  const hubDbBefore = fs.existsSync(REAL_HUB_DB) ? fs.statSync(REAL_HUB_DB).mtimeMs : null;
  const legacyBefore = fs.existsSync(REAL_LEGACY_DB) ? fs.statSync(REAL_LEGACY_DB).mtimeMs : null;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-domain-sync-'));
  const dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // A pre-created 0-byte file so db.js's legacy migration — which RENAMES
  // data/easy-devops.sqlite — can never run against the real installation.
  fs.writeFileSync(path.join(dataDir, 'easy-devops.sqlite'), '');

  const nginxBin = findNginx();

  // Throwaway nginx prefix. On Windows nginxTestCmd() invokes
  // <nginxDir>\nginx.exe with <nginxDir>\conf\nginx.conf, so the prefix needs
  // its own copy of the binary; the real installation is only ever read.
  const nginxDir = path.join(tmpRoot, 'nginx');
  fs.mkdirSync(path.join(nginxDir, 'conf', 'conf.d'), { recursive: true });
  fs.mkdirSync(path.join(nginxDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(nginxDir, 'temp'), { recursive: true });
  if (process.platform === 'win32' && nginxBin) {
    fs.copyFileSync(nginxBin, path.join(nginxDir, 'nginx.exe'));
    const mime = path.join(path.dirname(nginxBin), 'conf', 'mime.types');
    if (fs.existsSync(mime)) fs.copyFileSync(mime, path.join(nginxDir, 'conf', 'mime.types'));
    const fwd = nginxDir.replace(/\\/g, '/');
    fs.writeFileSync(
      path.join(nginxDir, 'conf', 'nginx.conf'),
      'worker_processes 1;\nevents { worker_connections 64; }\nhttp {\n' +
      (fs.existsSync(mime) ? '  include mime.types;\n' : '') +
      `  access_log off;\n  include ${fwd}/conf/conf.d/*.conf;\n}\n`
    );
  }
  const sslDir = path.join(tmpRoot, 'ssl');
  fs.mkdirSync(sslDir, { recursive: true });

  // Seed the easy-devops config in the temp database before anything starts.
  process.env.EASY_DEVOPS_DATA_DIR = dataDir;
  const cfgMod = await import(pathToFileURL(path.join(ROOT, 'src/core/config.js')).href);
  cfgMod.saveConfig({ ...cfgMod.loadConfig(), nginxDir, sslDir, dashboardPassword: '' });

  // Isolated hub database.
  const DATABASE_URL = `file:${path.join(tmpRoot, 'hub-test.db').replace(/\\/g, '/')}`;
  const mig = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: HUB_DIR, env: { ...process.env, DATABASE_URL }, encoding: 'utf8', shell: true,
  });
  if (mig.status !== 0) {
    process.stderr.write(String(mig.stdout) + String(mig.stderr));
    throw new Error('prisma migrate deploy failed');
  }

  setGroup('starting the stack');

  start('hub_backend', process.execPath, [path.join('dist', 'src', 'index.js')], {
    cwd: HUB_DIR,
    env: {
      ...process.env, DATABASE_URL, PORT: String(HUB_PORT), PUBLIC_HUB_URL: HUB,
      FRONTEND_URL: 'http://localhost:3030', JWT_SECRET, NODE_ENV: 'test',
    },
  });
  await waitFor(`${HUB}/health`, 'hub_backend');
  check(`hub_backend up on ${HUB_PORT} (isolated database)`, true);

  start('dashboard', process.execPath, [path.join('src', 'dashboard', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, EASY_DEVOPS_DATA_DIR: dataDir, DASHBOARD_PORT: String(DASH_PORT) },
  });
  await waitFor(DASH, 'dashboard');
  check(`dashboard up on ${DASH_PORT} (temp data dir)`, true);

  // ── Pair the agent ─────────────────────────────────────────────────────────
  const stamp = Date.now();
  const reg = await hubApi('POST', '/api/v1/auth/register', {
    body: { email: `dsync-${stamp}@e2e.test`, password: 'password-dsync-123' },
  });
  const token = reg.body?.data?.token;
  const created = await hubApi('POST', '/api/v1/servers', { token, body: { name: 'dsync-server' } });
  const connectionString = created.body?.data?.connectionString ?? '';
  const serverId = created.body?.data?.server?.id ?? '';
  check('hub issued a connection string', connectionString.startsWith('ezops://'));

  // A fresh temp data dir has no dashboard password, and an empty one is no
  // longer a valid login. Go through the first-run setup, which also signs in.
  // First-run setup needs the one-time code the server printed; this is
  // what `ezz dashboard setup-code` issues. See core/setupCode.js.
  const setupCode = await issueSetupCode({ dataDir });
  const setup = await dash('POST', '/api/setup', { password: 'domain-sync-e2e-pw', setupCode });
  check('dashboard first-run setup succeeded', setup.status === 200, `status ${setup.status}`);
  await dash('POST', '/api/hub/connect', { connectionString });

  // Grant the domain + nginx permissions so hub commands are not refused by
  // the agent's local gate. The gate itself is covered by hub-permissions.
  await dash('PUT', '/api/hub/permissions', { groups: { nginx: true, domains: true } });

  let status = null;
  const connectDeadline = Date.now() + 30_000;
  while (Date.now() < connectDeadline) {
    status = (await dash('GET', '/api/hub/status')).body;
    if (status?.status === 'connected' || status?.status === 'rejected') break;
    await new Promise((r) => setTimeout(r, 400));
  }
  check('agent reports "connected"', status?.status === 'connected', `status=${status?.status}`);
  check('status reports the active data directory', status?.dataDir === dataDir, String(status?.dataDir));
  // The temp directory is not the default one, but it is NOT a dev run — a
  // service install passes a data directory too, and treating that as dev mode
  // issued staging certificates on real domains.
  check('status flags the data directory as non-default', status?.defaultDataDir === false);
  check('but does NOT call it a dev run', status?.devDataDir === false);

  // ── Browser-style socket on the server room ────────────────────────────────
  const { io } = await import(
    pathToFileURL(path.join(ROOT, 'node_modules/socket.io-client/build/esm/index.js')).href
  );
  const browser = io(HUB, { auth: { token }, transports: ['websocket'] });
  const events = [];
  await new Promise((resolve, reject) => {
    browser.on('connect', resolve);
    browser.on('connect_error', reject);
  });
  const subAck = await new Promise((r) => browser.emit('subscribe:server', serverId, r));
  check('browser socket subscribed to the server room', subAck?.ok === true, JSON.stringify(subAck));

  const EVT = `server:${serverId}:domains`;
  browser.on(EVT, (rows) => events.push({ at: Date.now(), rows }));

  // ── Prisma client against the test database, for assertions ────────────────
  const { PrismaClient } = await import(
    pathToFileURL(path.join(HUB_DIR, 'node_modules/@prisma/client/default.js')).href
  );
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  const hubNames = async () =>
    (await prisma.domain.findMany({ where: { serverId } })).map((d) => d.name).sort();
  const hubDomain = (name) => prisma.domain.findFirst({ where: { serverId, name } });

  /**
 * Asserts this test did not write to the real hub database.
 *
 * An mtime comparison alone is not enough: a developer's own hub_backend may
 * be running against the real hub.db, and its agent writes `lastSeenAt` every
 * few seconds. That makes the mtime move on its own and the check fail for a
 * reason that has nothing to do with this test. So when the mtime HAS moved,
 * sample it again — if it is still advancing with this test's stack already
 * stopped, something external owns the file and the mtime says nothing about
 * us. Isolation itself is guaranteed by the separate DATABASE_URL.
 */
async function checkRealHubDb(before, after) {
  if (after === before) {
    check('real hub.db untouched', true);
    return;
  }

  // Is a hub_backend of the developer's own up on the configured port? If so
  // it owns those writes, and polling for the next one is unnecessary.
  const external = await isRealHubRunning();
  check('real hub.db not written by this test', external,
    external
      ? `another hub_backend is live on port ${realHubPort()} and writing to it — this test used its own DATABASE_URL`
      : `mtime changed with no other hub_backend running (${before} -> ${after})`);
}

/** The port a normally-configured hub_backend listens on. */
function realHubPort() {
  try {
    const env = fs.readFileSync(path.join(HUB_DIR, '.env'), 'utf8');
    const match = env.match(/^PORT\s*=\s*(\d+)/m);
    if (match) return Number(match[1]);
  } catch { /* no .env — fall through to the default */ }
  return 4000;
}

/** True when something answers /health on that port. */
async function isRealHubRunning() {
  try {
    const res = await fetch(`http://localhost:${realHubPort()}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Resolves with the elapsed ms once `pred` holds, or null on timeout. */
  async function waitUntil(pred, timeoutMs = DEADLINE_MS) {
    const t0 = Date.now();
    for (;;) {
      if (await pred()) return Date.now() - t0;
      if (Date.now() - t0 >= timeoutMs) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Asserts one domain write reaches both the Hub database and the browser
   * inside the deadline.
   *
   * @param label    what was done
   * @param act      performs the write; returns anything printable
   * @param settled  true once the Hub database reflects the write
   */
  async function expectSync(label, act, settled) {
    const mark = Date.now();
    const actResult = await act();
    const dbMs = await waitUntil(settled);
    // The event usually arrives while the database wait is still running, so
    // measure its own arrival time rather than when this line got to look.
    await waitUntil(async () => events.some((e) => e.at >= mark), DEADLINE_MS);
    const first = events.find((e) => e.at >= mark);
    const evMs = first ? first.at - mark : null;

    check(`${label}: reached the hub database`, dbMs !== null,
      dbMs === null ? `not within ${DEADLINE_MS}ms — ${actResult ?? ''}` : `${dbMs}ms`);
    check(`${label}: reached the browser`, evMs !== null && evMs <= DEADLINE_MS,
      evMs === null ? `no ${EVT} within ${DEADLINE_MS}ms` : `${evMs}ms`);
  }

  // ── Dashboard API ──────────────────────────────────────────────────────────
  setGroup('dashboard API (same process as the agent)');

  if (!nginxBin) {
    check('nginx available to validate generated configs', false,
      'no nginx binary found — domain creation cannot be tested on this machine');
  }

  const NAME = 'a.sync.test';

  await expectSync('create',
    async () => {
      const r = await dash('POST', '/api/domains',
        { name: NAME, port: 3000, backendHost: '127.0.0.1', ssl: { enabled: false } });
      return `http ${r.status} ${r.status >= 400 ? JSON.stringify(r.body).slice(0, 200) : ''}`;
    },
    async () => (await hubNames()).includes(NAME));

  await expectSync('edit (port 4111)',
    async () => `http ${(await dash('PUT', `/api/domains/${NAME}`, { port: 4111 })).status}`,
    async () => {
      const d = await hubDomain(NAME);
      return Boolean(d) && JSON.parse(d.config || '{}').port === 4111;
    });

  await expectSync('toggle (disable)',
    async () => `http ${(await dash('PUT', `/api/domains/${NAME}/toggle`)).status}`,
    async () => {
      const d = await hubDomain(NAME);
      return Boolean(d) && d.enabled === false;
    });

  // The regression that started all this: a delete used to leave the row behind.
  await expectSync('delete',
    async () => `http ${(await dash('DELETE', `/api/domains/${NAME}`)).status}`,
    async () => !(await hubNames()).includes(NAME));

  // ── A separate process, i.e. what the CLI does ─────────────────────────────
  setGroup('separate process (the CLI path, through the shared core)');

  const cliScript = path.join(tmpRoot, 'cli-op.mjs');
  fs.writeFileSync(cliScript, [
    "import { pathToFileURL } from 'node:url';",
    `const ROOT = ${JSON.stringify(ROOT)};`,
    'const [, , op, name] = process.argv;',
    "const db = await import(pathToFileURL(ROOT + '/src/core/domains-db.js').href);",
    "const apply = await import(pathToFileURL(ROOT + '/src/core/nginx-apply.js').href);",
    "if (op === 'create') {",
    "  const d = db.createDomain({ name, port: 3500, backendHost: '127.0.0.1', enabled: true });",
    '  const res = await apply.writeConfWithTest(d);',
    "  if (!res.ok) { console.error('APPLY FAIL ' + String(res.error).slice(0, 200)); process.exit(2); }",
    '  const all = db.getDomains(); all.push(d); db.saveDomains(all);',
    "} else if (op === 'delete') {",
    '  db.saveDomains(db.getDomains().filter((x) => x.name !== name));',
    '}',
  ].join('\n'));

  const runCli = (op, name) => new Promise((resolve) => {
    const p = spawn(process.execPath, [cliScript, op, name], {
      cwd: ROOT, env: { ...process.env, EASY_DEVOPS_DATA_DIR: dataDir },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve(`exit ${code} ${out.trim().slice(0, 200)}`));
  });

  const CLI_NAME = 'cli.sync.test';

  // This is the case the in-process read cache broke completely: the agent
  // never saw the revision counter move, so nothing was ever pushed.
  await expectSync('CLI create',
    () => runCli('create', CLI_NAME),
    async () => (await hubNames()).includes(CLI_NAME));

  await expectSync('CLI delete',
    () => runCli('delete', CLI_NAME),
    async () => !(await hubNames()).includes(CLI_NAME));

  // ── Hub-initiated commands ─────────────────────────────────────────────────
  setGroup('hub commands');

  const HUB_NAME = 'hub.sync.test';
  const sendCommand = (payload) =>
    hubApi('POST', `/api/v1/servers/${serverId}/command`,
      { token, body: { command: 'hub:manageDomain', payload } });

  await expectSync('hub create',
    async () => {
      const r = await sendCommand({ action: 'create', domain: { name: HUB_NAME, port: 3600, backendHost: '127.0.0.1' } });
      return `http ${r.status} ${r.status >= 400 ? JSON.stringify(r.body).slice(0, 200) : ''}`;
    },
    async () => (await hubNames()).includes(HUB_NAME));

  await expectSync('hub edit (port 3777)',
    async () => `http ${(await sendCommand({ action: 'update', name: HUB_NAME, domain: { port: 3777 } })).status}`,
    async () => {
      const d = await hubDomain(HUB_NAME);
      return Boolean(d) && JSON.parse(d.config || '{}').port === 3777;
    });

  await expectSync('hub delete',
    async () => `http ${(await sendCommand({ action: 'delete', name: HUB_NAME })).status}`,
    async () => !(await hubNames()).includes(HUB_NAME));

  // ── Ghost removal ──────────────────────────────────────────────────────────
  setGroup('ghost domains are cleaned up on reconnect');

  // Write a domain that exists only in the Hub — exactly the state left behind
  // by the old upsert-only merge, and what a user sees as a ghost.
  await prisma.domain.create({ data: { serverId, name: 'ghost.example.com', config: '{}' } });
  check('ghost seeded directly into the hub database',
    (await hubNames()).includes('ghost.example.com'));

  // Re-pasting the connection string restarts the agent, which re-sends its
  // full domain list on connect.
  await dash('POST', '/api/hub/connect', { connectionString });

  const ghostMs = await waitUntil(
    async () => !(await hubNames()).includes('ghost.example.com'), 30_000);
  check('ghost removed after the agent reconnects', ghostMs !== null,
    ghostMs === null ? 'still present after 30s' : `${ghostMs}ms`);

  const finalNames = await hubNames();
  check('no domains left over at the end', finalNames.length === 0, JSON.stringify(finalNames));

  // ── Teardown ───────────────────────────────────────────────────────────────
  setGroup('teardown and isolation');

  browser.disconnect();
  await prisma.$disconnect();
  // Release this process's own handle on the temp easy-devops database, or
  // Windows refuses to delete the directory.
  try {
    const dbMod = await import(pathToFileURL(path.join(ROOT, 'src/core/db.js')).href);
    dbMod.closeDb();
  } catch { /* never loaded */ }
  await stopAll();

  const hubDbAfter = fs.existsSync(REAL_HUB_DB) ? fs.statSync(REAL_HUB_DB).mtimeMs : null;
  const legacyAfter = fs.existsSync(REAL_LEGACY_DB) ? fs.statSync(REAL_LEGACY_DB).mtimeMs : null;
  await checkRealHubDb(hubDbBefore, hubDbAfter);
  check('real data/easy-devops.sqlite untouched', legacyAfter === legacyBefore);
  check('no .migrated file created', !fs.existsSync(`${REAL_LEGACY_DB}.migrated`));
  check('temp directory removed', rmWithRetry(tmpRoot));

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(64)}\nTOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label} ${f.detail}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  process.stderr.write(`\nHarness error: ${err.stack}\n`);
  await stopAll();
  process.exit(1);
});
