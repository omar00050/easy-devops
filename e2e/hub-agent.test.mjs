/**
 * Tests that one process opens exactly ONE agent socket to the Hub.
 *
 * Run with:  npm run test:e2e -- hub-agent
 *
 * ── The bug this exists for ────────────────────────────────────────────────
 *
 * A paired server flapped "Connected to hub" / "Disconnected: io server
 * disconnect" every few seconds, for ever. The cause was on the agent's side:
 * `initHubAgent()` assigned a new socket over the old one without disconnecting
 * it, so a second call left TWO live sockets. The Hub keeps one socket per
 * serverId and evicts the older when a new one arrives (agentServer.ts), so the
 * evicted client re-dialled, evicted the other, and the two took turns
 * indefinitely.
 *
 * The second call came from a path outside the ownership election: pairing
 * from the dashboard started an agent there even while the daemon owned the
 * jobs.
 *
 * ── How this is tested ─────────────────────────────────────────────────────
 *
 * Against a REAL socket.io server on a random port, standing in for
 * /agent-socket with the one behaviour that matters — the duplicate eviction —
 * and counting connections. No database, nothing persistent, and the real Hub
 * is never contacted.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { promises as dnsPromises } from 'node:dns';
import { createRequire } from 'module';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { once } from 'events';
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

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const require = createRequire(import.meta.url);

function createGate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function createAckWaiter() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Writes a real, parseable certificate with `daysLeft` remaining. */
function writeTestCert(sslDir, domain, daysLeft) {
  const forge = require('node-forge');
  const dir = path.join(sslDir, domain);
  assertInsideTestDataDir(dir, `write a test certificate for ${domain}`);
  fs.mkdirSync(dir, { recursive: true });

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const expiry = new Date(Date.now() + daysLeft * 86_400_000 + 43_200_000);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(expiry.getTime() - 90 * 86_400_000);
  cert.validity.notAfter = expiry;
  const subject = [{ name: 'commonName', value: domain }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: domain }] }]);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  fs.writeFileSync(path.join(dir, 'fullchain.pem'), forge.pki.certificateToPem(cert));
  fs.writeFileSync(path.join(dir, 'privkey.pem'), privateKey);
  return dir;
}

async function waitUntil(fn, { timeoutMs = 8_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(everyMs);
  }
  return false;
}

const SERVER_ID = 'test-server-id';
const SECRET = 'test-secret';

/**
 * A stand-in for hub_backend's /agent-socket.
 *
 * Mirrors the real server's duplicate handling exactly: one socket per
 * serverId, the previous one disconnected when a new one arrives. That is the
 * behaviour that turns "two sockets" into "an endless flap", so it has to be
 * present for this test to mean anything.
 */
async function startTestHub() {
  const { Server } = await import(pathToFileURL(path.join(ROOT, 'node_modules/socket.io/dist/index.js')).href);

  const http = createServer();
  const io = new Server(http);
  const ns = io.of('/agent-socket');

  const state = {
    connects: 0,
    evictions: 0,
    rejections: [],
    events: [],
    results: [],
    progress: [],
    domainConfigs: [],
    deployApps: [],
    serverInfo: [],
    socket: null,
  };
  const agentSockets = new Map();

  ns.use((socket, next) => {
    const { serverId, secret } = socket.handshake.auth ?? {};
    if (serverId !== SERVER_ID || secret !== SECRET) {
      state.rejections.push(serverId ?? '(none)');
      return next(new Error('INVALID_SECRET'));
    }
    socket.serverId = serverId;
    next();
  });

  ns.on('connection', (socket) => {
    state.connects++;
    state.socket = socket;

    const previous = agentSockets.get(socket.serverId);
    if (previous && previous !== socket) {
      state.evictions++;
      previous.disconnect(true);
    }
    agentSockets.set(socket.serverId, socket);

    socket.onAny((event) => state.events.push(event));

    // The acknowledgement a dispatched command produces. Kept whole so a test
    // can assert on what the agent actually reported.
    socket.on('command:result', (payload) => state.results.push(payload));
    socket.on('command:progress', (payload) => state.progress.push(payload));
    socket.on('domain:configs', (payload) => state.domainConfigs.push(payload));
    socket.on('deploy:apps', (payload) => state.deployApps.push(payload));
    socket.on('server:info', (payload) => state.serverInfo.push(payload));

    socket.on('disconnect', () => {
      if (agentSockets.get(socket.serverId) === socket) agentSockets.delete(socket.serverId);
    });
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

function writeChild(name, body) {
  const dir = path.join(TEST_DATA_DIR, 'children');
  assertInsideTestDataDir(dir, 'write a child script');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── 1. initHubAgent() is idempotent ────────────────────────────────────────

async function testIdempotentInit() {
  setGroup('1. initHubAgent() leaves exactly one socket');

  const hub = await startTestHub();
  const agent = await import(srcUrl('core/hub/agent.js'));
  const { saveHubLink, clearHubLink } = await import(srcUrl('core/hubLink.js'));
  const bus = await import(srcUrl('core/jobs/bus.js'));

  // The dashboard in another process learns the agent's state from this event.
  // Without it, its status endpoint reports "Connecting…" for ever.
  const seen = [];
  const off = bus.subscribe('hub:agentState', (payload) => seen.push(payload));

  try {
    saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

    agent.initHubAgent();
    check('the agent connects', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);
    check('every transition is published on the job bus',
      seen.some((s) => s.status === 'connecting') && seen.some((s) => s.status === 'connected'),
      seen.map((s) => s.status).join(' → '));
    check('exactly one connection so far', hub.state.connects === 1, `${hub.state.connects}`);

    // The call that used to produce a second live socket.
    agent.initHubAgent();
    await waitUntil(() => hub.state.connects === 2);
    await sleep(500);

    check('a second init still leaves ONE live socket', hub.live() === 1, `live: ${hub.live()}`);
    check('the hub never had to evict a duplicate', hub.state.evictions === 0,
      `${hub.state.evictions} eviction(s)`);
    check('the agent reports connected', agent.getHubAgentStatus().connected === true);

    // A third, to be sure it is not a one-off.
    agent.initHubAgent();
    await sleep(800);
    check('a third init still leaves ONE live socket', hub.live() === 1, `live: ${hub.live()}`);
    check('still no evictions', hub.state.evictions === 0, `${hub.state.evictions}`);

    agent.stopHubAgent();
    check('stopping leaves none', await waitUntil(() => hub.live() === 0), `live: ${hub.live()}`);
  } finally {
    off();
    agent.stopHubAgent();
    clearHubLink();
    await hub.close();
  }
}

// ─── 2. One daemon opens exactly one agent socket ───────────────────────────

async function testOneDaemonOneSocket() {
  setGroup('2. one daemon opens exactly one agent socket');

  const hub = await startTestHub();
  const dataDir = scratch('daemon-agent');

  const { saveHubLink, clearHubLink } = await import(srcUrl('core/hubLink.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));
  const { startDaemon } = await import(srcUrl('core/daemon/run.js'));
  const bus = await import(srcUrl('core/jobs/bus.js'));

  // Point the config at directories that do not exist, so a monitor tick
  // cannot reach the real nginx on the machine running the tests.
  dbSet('config', {
    nginxDir: path.join(dataDir, 'no-nginx'),
    sslDir: path.join(dataDir, 'no-ssl'),
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: '',
    os: process.platform,
  });
  dbSet('domains', []);
  saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

  let daemon = null;
  try {
    daemon = await startDaemon({
      dataDir,
      intervals: { nginx: 60_000, domains: 60_000, certs: 60_000 },
      log: () => {},
    });
    check('the daemon started', daemon.ok === true, daemon.ok === false ? daemon.reason : '');

    check('its agent connects', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);

    // Long enough for a flap to show itself: the observed symptom was a
    // reconnect every few seconds.
    await sleep(6_000);

    check('exactly ONE connection after 6s', hub.state.connects === 1, `${hub.state.connects} connect(s)`);
    check('no evictions — the flap would show up here', hub.state.evictions === 0,
      `${hub.state.evictions} eviction(s)`);
    check('still exactly one live socket', hub.live() === 1, `live: ${hub.live()}`);
    check('the agent pushed its server info', hub.state.events.includes('server:info'));
  } finally {
    if (daemon?.ok) await daemon.stop();
    clearHubLink();
    bus.clearAll();
    await hub.close();
  }
}

// ─── 3. A pairing change reaches the job owner ──────────────────────────────

async function testPairingReachesOwner() {
  setGroup('3. a pairing change reaches whoever owns the jobs');

  const { saveHubLink, clearHubLink, getHubRevision } = await import(srcUrl('core/hubLink.js'));

  // The counter is how any other process learns about a pairing change. It was
  // the one change that did not bump it, so a daemon never found out and the
  // dashboard started a competing agent instead.
  const before = getHubRevision();
  saveHubLink({ hubUrl: 'http://127.0.0.1:1', serverId: 'x', secret: 'y' });
  const afterSave = getHubRevision();
  check('saving a pairing bumps the revision', afterSave > before, `${before} → ${afterSave}`);

  clearHubLink();
  const afterClear = getHubRevision();
  check('clearing a pairing bumps it too', afterClear > afterSave, `${afterSave} → ${afterClear}`);
}

// ─── 4. The dashboard defers to a running daemon ────────────────────────────

async function testDashboardDefers() {
  setGroup('4. pairing from the dashboard defers to a running daemon');

  const lock = await import(srcUrl('core/daemon/lock.js'));
  const { connectAgent } = await import(srcUrl('dashboard/controllers/hubController.js'));
  const { clearHubLink } = await import(srcUrl('core/hubLink.js'));
  const agent = await import(srcUrl('core/hub/agent.js'));

  const hub = await startTestHub();

  // A daemon holding the lock, in this process, so the controller sees one.
  lock.acquire({ mode: 'daemon', version: 'test' });

  const replies = [];
  const res = {
    status() { return this; },
    json(payload) { replies.push(payload); return this; },
  };

  try {
    connectAgent(
      { body: { connectionString: `ezops://${hub.url}|${SERVER_ID}|${SECRET}` } },
      res,
    );

    check('the request succeeds', replies[0]?.ok === true, JSON.stringify(replies[0]?.error ?? ''));
    check('it reports the daemon as the agent owner', replies[0]?.agentOwner === 'daemon',
      String(replies[0]?.agentOwner));
    check('and explains that the service will pick it up',
      /background service/i.test(replies[0]?.detail ?? ''));

    // The decisive assertion: no socket was opened by this (dashboard) path.
    await sleep(1_500);
    check('NO agent socket was opened by the dashboard', hub.state.connects === 0,
      `${hub.state.connects} connect(s)`);
    check('the hub saw nothing at all', hub.live() === 0);
  } finally {
    agent.stopHubAgent();
    clearHubLink();
    lock.release({});
    await hub.close();
  }
}

// ─── 5. With no daemon, the dashboard does hold the agent ───────────────────

async function testDashboardHoldsWhenAlone() {
  setGroup('5. with no daemon, the dashboard holds the agent itself');

  const lock = await import(srcUrl('core/daemon/lock.js'));
  const { connectAgent } = await import(srcUrl('dashboard/controllers/hubController.js'));
  const { clearHubLink } = await import(srcUrl('core/hubLink.js'));
  const agent = await import(srcUrl('core/hub/agent.js'));

  const hub = await startTestHub();

  // No lock held: this dashboard is the job owner.
  lock.release({});

  const replies = [];
  const res = { status() { return this; }, json(p) { replies.push(p); return this; } };

  try {
    connectAgent({ body: { connectionString: `ezops://${hub.url}|${SERVER_ID}|${SECRET}` } }, res);

    check('it reports the dashboard as the agent owner', replies[0]?.agentOwner === 'dashboard',
      String(replies[0]?.agentOwner));
    check('an agent socket is opened', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);
    check('exactly one', hub.state.connects === 1, `${hub.state.connects}`);

    // Re-pairing must not stack sockets either.
    connectAgent({ body: { connectionString: `ezops://${hub.url}|${SERVER_ID}|${SECRET}` } }, res);
    await sleep(1_200);
    check('re-pairing still leaves one live socket', hub.live() === 1, `live: ${hub.live()}`);
    check('and the hub never evicted anything', hub.state.evictions === 0, `${hub.state.evictions}`);
  } finally {
    agent.stopHubAgent();
    clearHubLink();
    await hub.close();
  }
}

// ─── 5b. reconcile only acts on a real pairing change ───────────────────────

async function testReconcileIsQuiet() {
  setGroup('5b. reconcile acts on a pairing change, not on every revision');

  const agent = await import(srcUrl('core/hub/agent.js'));
  const { saveHubLink, clearHubLink, bumpHubRevision } = await import(srcUrl('core/hubLink.js'));
  const hub = await startTestHub();

  try {
    clearHubLink();
    check('nothing to do when unlinked and stopped',
      agent.reconcileHubAgent().action === 'none');

    saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });
    check('a pairing with no agent starts one',
      agent.reconcileHubAgent().action === 'started');
    check('the agent connects', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);

    const connectsAfterStart = hub.state.connects;

    // The revision counter moves on every domain, certificate and permission
    // change. Those must NOT touch the socket — an earlier version redialled
    // whenever the agent was not currently connected, which on a busy server
    // meant constant churn and Hub updates arriving seconds late.
    for (let i = 0; i < 5; i++) {
      bumpHubRevision();
      const r = agent.reconcileHubAgent();
      check(`revision bump ${i + 1} leaves the socket alone`, r.action === 'none', r.reason);
    }

    check('no extra connections were made',
      hub.state.connects === connectsAfterStart, `${hub.state.connects} vs ${connectsAfterStart}`);
    check('and the hub never evicted anything', hub.state.evictions === 0, `${hub.state.evictions}`);
    check('still exactly one live socket', hub.live() === 1, `live: ${hub.live()}`);

    // A REAL change does act: a rotated secret is the realistic case.
    saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });
    check('re-saving the identical pairing is still a no-op',
      agent.reconcileHubAgent().action === 'none');

    saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: `${SECRET}-rotated` });
    check('a rotated secret restarts the agent',
      agent.reconcileHubAgent().action === 'restarted');

    clearHubLink();
    check('removing the pairing stops the agent',
      agent.reconcileHubAgent().action === 'stopped');
    check('the socket is gone', await waitUntil(() => hub.live() === 0), `live: ${hub.live()}`);
  } finally {
    agent.stopHubAgent();
    clearHubLink();
    await hub.close();
  }
}

// ─── 6. hub:saveConfig — the reload gate ────────────────────────────────────

async function testSaveConfigReloadGate() {
  setGroup('6. hub:saveConfig decides about reloading');

  const agent = await import(srcUrl('core/hub/agent.js'));
  const grant = (ids) => Object.fromEntries(ids.map((id) => [id, true]));

  const edit = grant(['nginx.config.edit']);
  const editAndReload = grant(['nginx.config.edit', 'nginx.reload']);

  // Saving and reloading are separate capabilities. A server that allows
  // editing a config but not reloading nginx has said something specific, and
  // a `reload: true` from the Hub must not override it.
  const noAsk = agent.resolveSaveConfigReload({ filename: 'a.conf', content: '' }, editAndReload);
  check('no reload happens unless it is asked for', noAsk.requested === false && noAsk.allowed === false);

  const both = agent.resolveSaveConfigReload({ reload: true }, editAndReload);
  check('reload: true with nginx.reload granted → reload', both.requested && both.allowed === true);
  check('and no reason is needed', both.reason === null);

  const editOnly = agent.resolveSaveConfigReload({ reload: true }, edit);
  check('reload: true WITHOUT nginx.reload → no reload', editOnly.requested === true && editOnly.allowed === false);
  check('and the reason names the missing permission',
    /nginx\.reload/.test(editOnly.reason ?? ''), editOnly.reason);

  // Only a real boolean asks for a reload: this affects live traffic, so a
  // loose coercion must never be enough.
  for (const loose of ['true', 1, 'yes', {}, []]) {
    const r = agent.resolveSaveConfigReload({ reload: loose }, editAndReload);
    check(`reload: ${JSON.stringify(loose)} is not a reload request`, r.requested === false);
  }

  const off = agent.resolveSaveConfigReload({ reload: false }, editAndReload);
  check('reload: false is not a request', off.requested === false);

  // With nothing granted at all the answer is still "no reload", not a throw.
  const nothing = agent.resolveSaveConfigReload({ reload: true }, {});
  check('no permissions at all → no reload, with a reason',
    nothing.requested === true && nothing.allowed === false && typeof nothing.reason === 'string');
}

// ─── 7. hub:saveConfig over a real socket ───────────────────────────────────

async function testSaveConfigDispatch() {
  setGroup('7. hub:saveConfig reaches the agent and is permission-checked');

  const hub = await startTestHub();
  const dataDir = scratch('saveconfig');

  const agent = await import(srcUrl('core/hub/agent.js'));
  const { saveHubLink, clearHubLink, saveHubPermissions } = await import(srcUrl('core/hubLink.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));

  // An nginx directory that does not exist: the save will fail at `nginx -t`,
  // which is fine — what is being tested is whether the command reaches the
  // handler and how the permission gate answers, not nginx itself.
  dbSet('config', {
    nginxDir: path.join(dataDir, 'no-nginx'),
    sslDir: path.join(dataDir, 'no-ssl'),
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: '',
    os: process.platform,
  });
  dbSet('domains', []);
  saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

  /** Dispatches a command the way the Hub does and waits for its result. */
  const dispatch = async (payload) => {
    const before = hub.state.results.length;
    const requestId = `req-${Math.random().toString(16).slice(2)}`;
    hub.state.socket.emit('hub:saveConfig', { ...payload, requestId });
    await waitUntil(() => hub.state.results.length > before, { timeoutMs: 15_000 });
    return hub.state.results.find((r) => r.requestId === requestId) ?? null;
  };

  try {
    // ── Without nginx.config.edit: refused before anything is written ──────
    saveHubPermissions({ 'nginx.config.edit': false, 'nginx.reload': false });
    agent.initHubAgent();
    check('the agent connects', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);

    const refused = await dispatch({ filename: 'from-hub.conf', content: 'server { listen 8081; }' });
    check('a save without nginx.config.edit is refused', refused?.ok === false, JSON.stringify(refused));
    check('the refusal names the permission',
      /nginx\.config\.edit/.test(refused?.error ?? ''), refused?.error);
    check('and nothing was written', !fs.existsSync(path.join(dataDir, 'no-nginx')),
      'the nginx directory was never created');

    // ── With nginx.config.edit: it gets past the gate and attempts the save ─
    saveHubPermissions({ 'nginx.config.edit': true, 'nginx.reload': false });

    const attempted = await dispatch({ filename: 'from-hub.conf', content: 'server { listen 8081; }' });
    check('a save WITH nginx.config.edit is not refused on permissions',
      !/nginx\.config\.edit/.test(attempted?.error ?? ''), attempted?.error ?? 'no error');
    check('it reached the handler and reported an outcome', attempted !== null);
    // nginx is absent here, so the save itself fails — which is the handler
    // running, not the gate refusing.
    check('the failure comes from nginx, not from the permission gate',
      attempted?.ok === false && !/disabled on this server/.test(attempted?.error ?? ''),
      attempted?.error);

    check('the command was seen by the hub as a result, with its requestId',
      hub.state.results.every((r) => typeof r.requestId === 'string'));
  } finally {
    agent.stopHubAgent();
    clearHubLink();
    await hub.close();
  }
}

// ─── 8. The hand-over is immediate and exclusive ────────────────────────────

/**
 * A real daemon in its own process.
 *
 * It has to be a separate process: the jobs marker is keyed on pid, so a
 * "daemon" started inside this one would see the marker as its own and the
 * hand-over would never be exercised.
 */
const DAEMON_CHILD = `
const [runModule, dataDir] = process.argv.slice(2);
const { startDaemon } = await import(runModule);

const started = await startDaemon({
  dataDir,
  intervals: { nginx: 600000, domains: 600000, certs: 600000 },
  log: (line) => process.stdout.write('[daemon] ' + line + '\\n'),
});

if (!started.ok) {
  process.stdout.write('REFUSED:' + started.reason + '\\n');
  process.exit(2);
}

process.stdout.write('READY\\n');

const quit = async () => { await started.stop(); process.exit(0); };
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
`;

async function testHandoverIsExclusive() {
  setGroup('8. a daemon starting while a dashboard runs the jobs');

  const hub = await startTestHub();
  const dataDir = scratch('handover');

  const {
    saveHubLink,
    clearHubLink,
    saveHubPermissions,
  } = await import(srcUrl('core/hubLink.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));
  const { startJobs } = await import(srcUrl('core/jobs/index.js'));
  const owner = await import(srcUrl('core/jobs/owner.js'));
  const bus = await import(srcUrl('core/jobs/bus.js'));

  dbSet('config', {
    nginxDir: path.join(dataDir, 'no-nginx'),
    sslDir: path.join(dataDir, 'no-ssl'),
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: '',
    os: process.platform,
  });
  dbSet('domains', []);
  saveHubPermissions({ 'nginx.config.view': true });
  saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

  let dashboard = null;
  let child = null;
  let bridge = null;

  try {
    // ── A dashboard with no daemon runs the jobs, and holds the agent ───────
    dashboard = startJobs({
      role: 'dashboard',
      dataDir,
      pollMs: 60_000, // deliberately long: the watcher must do the work
      intervals: { nginx: 600_000, domains: 600_000, certs: 600_000 },
    });

    check('the dashboard runs the jobs', dashboard.state().running === true, dashboard.state().reason);
    check('and holds the jobs marker', owner.inspect({ dataDir }).mine === true);
    check('its agent connects', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);
    check('one connection so far', hub.state.connects === 1, `${hub.state.connects}`);

    // ── Now a real daemon starts ───────────────────────────────────────────
    const file = writeChild('daemon-child.mjs', DAEMON_CHILD);
    child = spawn(process.execPath, [file, srcUrl('core/daemon/run.js'), dataDir], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });

    const ready = await waitUntil(() => out.includes('READY'), { timeoutMs: 25_000 });
    check('the daemon started', ready, (out + err).slice(-300));

    // The dashboard must have let go WITHOUT waiting for its 60s poll: the
    // lock watcher is what makes that immediate.
    check('the dashboard stopped running the jobs',
      await waitUntil(() => dashboard.state().running === false, { timeoutMs: 5_000 }),
      dashboard.state().reason);
    check('and released the jobs marker to the daemon',
      await waitUntil(() => {
        const o = owner.inspect({ dataDir });
        return o.held && !o.mine;
      }, { timeoutMs: 5_000 }));

    // The assertion this whole mechanism exists for.
    await sleep(2_000);
    check('the hub NEVER had to evict an agent', hub.state.evictions === 0,
      `${hub.state.evictions} eviction(s)`);
    check('exactly one agent socket is live', hub.live() === 1, `live: ${hub.live()}`);
    check('exactly two connections in total — the dashboard, then the daemon',
      hub.state.connects === 2, `${hub.state.connects}`);

    // The dashboard's status endpoint reads the daemon's view through its IPC
    // bridge. This is the path that used to be missing, leaving the settings
    // page on "Connecting…" even though the daemon's agent was connected.
    const bridgeModule = await import(srcUrl('dashboard/lib/daemonBridge.js'));
    bridge = bridgeModule.startDaemonBridge({ dataDir });
    check('the dashboard reads the daemon-reported hub state',
      await waitUntil(() => bridgeModule.daemonHubState()?.status === 'connected', { timeoutMs: 10_000 }),
      JSON.stringify(bridgeModule.daemonHubState()));
    bridge.stop();
    bridge = null;

    // And the daemon waited rather than racing: its own log says so when the
    // wait was measurable.
    check('the daemon reported the hand-over, not a forced start',
      !/starting anyway after waiting/.test(out), out.match(/starting anyway[^\n]*/)?.[0] ?? 'no forced start');

    // ── The daemon goes away again ─────────────────────────────────────────
    //
    // Stopped through the real mechanism rather than killed. A killed process
    // leaves its lock file behind — recovery is then the stale-lock path on the
    // next ownership poll, which is correct but deliberately slow, and this
    // test sets that poll to 60s precisely to prove the WATCHER is doing the
    // work. A clean stop releases the lock, which is what the watcher sees.
    const { requestStop } = await import(srcUrl('core/daemon/stopRequest.js'));
    requestStop({ dataDir, reason: 'hand-over test' });

    const exited = await waitUntil(() => child.exitCode !== null, { timeoutMs: 20_000 });
    check('the daemon exited cleanly when asked to stop', exited && child.exitCode === 0,
      `exit ${child.exitCode}`);
    child = null;

    check('the dashboard takes the jobs back without waiting for its poll',
      await waitUntil(() => dashboard.state().running === true, { timeoutMs: 8_000 }),
      dashboard.state().reason);
    check('and the agent is connected again',
      await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);
    check('still no evictions after the round trip', hub.state.evictions === 0,
      `${hub.state.evictions}`);
  } finally {
    bridge?.stop();
    if (child) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    if (dashboard) await dashboard.stop();
    try {
      const { clearStopRequest } = await import(srcUrl('core/daemon/stopRequest.js'));
      clearStopRequest({ dataDir });
    } catch { /* nothing to clear */ }
    clearHubLink();
    bus.clearAll();
    await hub.close();
  }
}

// ─── 9. Quick commands are acknowledged ─────────────────────────────────────

/**
 * The Hub answers a quick command's HTTP request from the socket.io
 * acknowledgement. The agent must therefore do BOTH: call the ack (so a
 * current Hub can answer its caller) and still emit `command:result` (so an
 * older Hub, and any open browser, keeps working).
 *
 * The command used here is `hub:manageSSL { action: 'suggest' }`: read-only, no
 * permission needed, and against an empty temp ssl directory it completes
 * without touching nginx or the real certificate store.
 */
async function testCommandAcknowledgement() {
  setGroup('9. quick commands: ack + command:result + a timing log');

  const hub = await startTestHub();
  const dataDir = scratch('command-ack');

  const agent = await import(srcUrl('core/hub/agent.js'));
  const {
    saveHubLink,
    clearHubLink,
    saveHubPermissions,
  } = await import(srcUrl('core/hubLink.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));

  dbSet('config', {
    nginxDir: path.join(dataDir, 'no-nginx'),
    sslDir: path.join(dataDir, 'no-ssl'),
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: '',
    os: process.platform,
  });
  dbSet('domains', []);
  saveHubPermissions({ 'nginx.config.view': true });
  saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

  // Capture, and still print, everything the agent logs while the command runs.
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    originalLog.apply(console, args);
  };

  const REQUEST_ID = 'req-ack-1';
  // A value that appears only in the arguments, never in a log line.
  const CANARY = 'timing-canary-9f3c1.example.com';

  try {
    agent.initHubAgent();
    check('the agent connects', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);

    let acked = null;
    if (hub.state.socket) {
      acked = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 12_000);
        hub.state.socket.emit(
          'hub:manageSSL',
          { action: 'suggest', domain: CANARY, requestId: REQUEST_ID },
          (ack) => { clearTimeout(timer); resolve(ack); },
        );
      });
    }

    check('the agent called the acknowledgement', acked !== null);
    check('the ack carries the requestId', acked?.requestId === REQUEST_ID, String(acked?.requestId));
    check('the ack reports success', acked?.ok === true, acked?.error ?? '');
    check('the ack carries the handler data',
      Boolean(acked?.data) && typeof acked.data.found === 'boolean', JSON.stringify(acked?.data));

    // Compatibility: the event is what an older Hub and every browser consume.
    const sawEvent = await waitUntil(
      () => hub.state.results.some((r) => r.requestId === REQUEST_ID),
      5_000,
    );
    const event = hub.state.results.find((r) => r.requestId === REQUEST_ID);
    check('command:result is still emitted', sawEvent);
    check('the event agrees with the ack',
      event?.ok === acked?.ok && Boolean(event?.data) === Boolean(acked?.data),
      JSON.stringify(event));

    const timing = logs.find((l) => l.startsWith('[hubAgent] hub:manageSSL '));
    check('a timing line is logged for the command', Boolean(timing), timing ?? 'no timing line');
    check('it names the command, its duration and the outcome',
      /^\[hubAgent\] hub:manageSSL \d+ms (ok|error)$/.test(timing ?? ''), timing ?? '');
    check('the timing line contains no argument value',
      !(timing ?? '').includes(CANARY) && !(timing ?? '').includes(REQUEST_ID), timing ?? '');
  } finally {
    console.log = originalLog;
    agent.stopHubAgent();
    clearHubLink();
    await hub.close();
  }
}

// ─── 10. Progress frames belong to the command that asked for them ──────────

/**
 * The Hub correlates a `command:progress` frame by its requestId. This drives
 * a real linkDomain command through the agent socket and checks that every
 * frame carries that id, and that a command without one emits nothing.
 *
 * The nginx directory is made unusable on purpose (a file where a directory
 * would have to be), so the domain write fails at once. The test therefore
 * exercises the whole requestId → onProgress → socket path without running
 * nginx, reloading a service or requesting a real certificate.
 */
async function testCommandProgress() {
  setGroup('10. linkDomain emits command:progress for its own requestId only');

  const hub = await startTestHub();
  const dataDir = scratch('command-progress');

  const agent = await import(srcUrl('core/hub/agent.js'));
  const { saveHubLink, clearHubLink, saveHubPermissions } = await import(srcUrl('core/hubLink.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));
  const apps = await import(srcUrl('core/deploy/apps.js'));

  const blocker = path.join(dataDir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory', 'utf8');

  dbSet('config', {
    nginxDir: path.join(blocker, 'nginx'),
    sslDir: path.join(dataDir, 'no-ssl'),
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: 'ops@example.com',
    os: process.platform,
  });
  dbSet('domains', []);
  apps.createApp({
    id: 'progress-app',
    repoUrl: 'https://github.com/me/progress-app.git',
    settings: { port: 4321 },
  });
  saveHubPermissions({
    'deploy.manage': true,
    'domains.create': true,
    'domains.edit': true,
    'nginx.reload': true,
    'ssl.issue': true,
  });
  saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

  const REQUEST_ID = 'req-progress-1';

  try {
    agent.initHubAgent();
    check('the agent connects', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);

    hub.state.socket.emit('hub:manageDeploy', {
      action: 'linkDomain',
      id: 'progress-app',
      domain: 'progress.example.com',
      ssl: { mode: 'issue' },
      requestId: REQUEST_ID,
    });

    const answered = await waitUntil(
      () => hub.state.results.some((r) => r.requestId === REQUEST_ID),
      { timeoutMs: 15_000 },
    );
    check('the command is answered with its requestId', answered,
      `${hub.state.results.length} result(s)`);

    check('it emitted progress frames', hub.state.progress.length > 0,
      `${hub.state.progress.length} frame(s)`);
    check('every frame carries that requestId',
      hub.state.progress.every((p) => p.requestId === REQUEST_ID),
      hub.state.progress.map((p) => String(p.requestId)).join(', '));
    check('every frame has a step, a valid status and an ISO timestamp',
      hub.state.progress.every((p) =>
        typeof p.step === 'string' && p.step.length > 0
        && ['running', 'ok', 'failed', 'skipped'].includes(p.status)
        && typeof p.at === 'string' && !Number.isNaN(Date.parse(p.at))));
    check('the domain step is one of the frames',
      hub.state.progress.some((p) => p.step === 'domain'));

    const before = hub.state.progress.length;
    hub.state.socket.emit('hub:manageDeploy', {
      action: 'linkDomain',
      id: 'progress-app',
      domain: 'progress-no-id.example.com',
      ssl: { mode: 'none' },
    });
    await sleep(1_500);

    check('a command without a requestId emits no progress frame',
      hub.state.progress.length === before,
      `${hub.state.progress.length - before} extra frame(s)`);
  } finally {
    agent.stopHubAgent();
    clearHubLink();
    await hub.close();
  }
}

// ─── 11. Hub SSL renew emits stages, and only for its requestId ─────────────

/**
 * A `hub:manageSSL { action: "renew" }` goes through cert-operations →
 * renewCertificate → issueCertificate. DNS is stubbed to NXDOMAIN so the
 * preflight fails before any ACME request, which is enough to prove the
 * `requestId → createCommandProgress → onProgress → command:progress` path
 * without touching DNS, Let's Encrypt or nginx.
 */
async function testSslCommandProgress() {
  setGroup('11. manageSSL renew emits command:progress for its requestId only');

  const hub = await startTestHub();
  const dataDir = scratch('ssl-command-progress');

  const agent = await import(srcUrl('core/hub/agent.js'));
  const { saveHubLink, clearHubLink, saveHubPermissions } = await import(srcUrl('core/hubLink.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));

  dbSet('config', {
    nginxDir: path.join(dataDir, 'nginx'),
    sslDir: path.join(dataDir, 'ssl'),
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: 'ops@example.com',
    sslChallengeMode: 'standalone',
    os: process.platform,
  });
  dbSet('domains', []);
  saveHubPermissions({ 'ssl.renew': true });
  saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

  const REQUEST_ID = 'req-ssl-progress-1';
  const original = {
    resolve4: dnsPromises.resolve4,
    resolve6: dnsPromises.resolve6,
    resolveAny: dnsPromises.resolveAny,
  };
  const nxdomain = async () => {
    const err = new Error('queryA ENOTFOUND progress-ssl.example.com');
    err.code = 'ENOTFOUND';
    throw err;
  };

  try {
    dnsPromises.resolve4 = nxdomain;
    dnsPromises.resolve6 = nxdomain;
    dnsPromises.resolveAny = nxdomain;

    agent.initHubAgent();
    check('the agent connects', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);

    hub.state.socket.emit('hub:manageSSL', {
      action: 'renew',
      domain: 'progress-ssl.example.com',
      requestId: REQUEST_ID,
    });

    const answered = await waitUntil(
      () => hub.state.results.some((r) => r.requestId === REQUEST_ID),
      { timeoutMs: 15_000 },
    );
    check('the SSL renew is answered with its requestId', answered,
      `${hub.state.results.length} result(s)`);

    check('it emitted progress frames', hub.state.progress.length > 0,
      `${hub.state.progress.length} frame(s)`);
    check('every frame carries that requestId',
      hub.state.progress.every((p) => p.requestId === REQUEST_ID),
      hub.state.progress.map((p) => String(p.requestId)).join(', '));
    check('every SSL frame names its domain',
      hub.state.progress.every((p) => p.domain === 'progress-ssl.example.com'),
      hub.state.progress.map((p) => String(p.domain)).join(', '));
    check('the stage names are SSL stages',
      hub.state.progress.every((p) => typeof p.step === 'string'
        && ['preflight', 'account and order', 'challenge ready',
          'waiting for validation', 'certificate received', 'files written',
          'nginx config test', 'nginx reload', 'https verified'].includes(p.step)),
      hub.state.progress.map((p) => p.step).join(', '));
    check('preflight is reported as running and then failed',
      hub.state.progress.some((p) => p.step === 'preflight' && p.status === 'running')
      && hub.state.progress.some((p) => p.step === 'preflight' && p.status === 'failed'));
    check('every frame has a valid status and an ISO timestamp',
      hub.state.progress.every((p) =>
        ['running', 'ok', 'failed', 'skipped'].includes(p.status)
        && typeof p.at === 'string' && !Number.isNaN(Date.parse(p.at))));

    const wire = JSON.stringify(hub.state.progress);
    check('no private key, key path or certificate body is in a frame',
      !wire.includes('PRIVATE KEY')
      && !wire.includes('privkey.pem')
      && !wire.includes('fullchain.pem')
      && !wire.includes('MIIE'));

    const before = hub.state.progress.length;
    hub.state.socket.emit('hub:manageSSL', {
      action: 'renew',
      domain: 'progress-ssl-no-id.example.com',
    });
    await sleep(1_200);

    check('a command without a requestId emits no progress frame',
      hub.state.progress.length === before,
      `${hub.state.progress.length - before} extra frame(s)`);
  } finally {
    dnsPromises.resolve4 = original.resolve4;
    dnsPromises.resolve6 = original.resolve6;
    dnsPromises.resolveAny = original.resolveAny;
    agent.stopHubAgent();
    clearHubLink();
    await hub.close();
  }
}

// ─── 12. renewAll progress is per domain ────────────────────────────────────

async function testRenewAllProgressDomains() {
  setGroup('12. renewAll progress names each domain');

  const hub = await startTestHub();
  const dataDir = scratch('ssl-renewall-progress');
  const sslDir = path.join(dataDir, 'ssl');
  fs.mkdirSync(sslDir, { recursive: true });
  writeTestCert(sslDir, 'renew-a.example.com', 5);
  writeTestCert(sslDir, 'renew-b.example.com', 5);

  const agent = await import(srcUrl('core/hub/agent.js'));
  const { saveHubLink, clearHubLink, saveHubPermissions } = await import(srcUrl('core/hubLink.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));

  dbSet('config', {
    nginxDir: path.join(dataDir, 'nginx'),
    sslDir,
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: 'ops@example.com',
    sslChallengeMode: 'standalone',
    os: process.platform,
  });
  dbSet('domains', []);
  saveHubPermissions({ 'ssl.renewAll': true });
  saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

  const REQUEST_ID = 'req-renewall-progress-1';
  const original = {
    resolve4: dnsPromises.resolve4,
    resolve6: dnsPromises.resolve6,
    resolveAny: dnsPromises.resolveAny,
  };
  const nxdomain = async () => {
    const err = new Error('queryA ENOTFOUND renew.example.com');
    err.code = 'ENOTFOUND';
    throw err;
  };

  try {
    dnsPromises.resolve4 = nxdomain;
    dnsPromises.resolve6 = nxdomain;
    dnsPromises.resolveAny = nxdomain;

    agent.initHubAgent();
    check('the agent connects', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);

    hub.state.socket.emit('hub:manageSSL', {
      action: 'renewAll',
      requestId: REQUEST_ID,
    });

    const answered = await waitUntil(
      () => hub.state.results.some((r) => r.requestId === REQUEST_ID),
      { timeoutMs: 20_000 },
    );
    check('the renewAll command is answered', answered, `${hub.state.results.length} result(s)`);

    const frames = hub.state.progress;
    const names = [...new Set(frames.map((frame) => frame.domain))].sort();
    check('frames are emitted for both domains',
      frames.length > 0 && names.includes('renew-a.example.com') && names.includes('renew-b.example.com'),
      names.join(', '));
    check('every renewAll frame names its domain and requestId',
      frames.every((frame) => typeof frame.domain === 'string' && frame.domain
        && frame.requestId === REQUEST_ID));
    check('each domain reports its own preflight failure',
      ['renew-a.example.com', 'renew-b.example.com'].every((name) =>
        frames.some((frame) => frame.domain === name && frame.step === 'preflight' && frame.status === 'failed')));
  } finally {
    dnsPromises.resolve4 = original.resolve4;
    dnsPromises.resolve6 = original.resolve6;
    dnsPromises.resolveAny = original.resolveAny;
    agent.stopHubAgent();
    clearHubLink();
    await hub.close();
  }
}

// ─── 13. domain:configs carries the certificate state ───────────────────────

async function testDomainCertStatus() {
  setGroup('13. domain:configs carries certStatus and certLabel');

  const hub = await startTestHub();
  const dataDir = scratch('domain-cert-status');
  const sslDir = path.join(dataDir, 'ssl');
  fs.mkdirSync(sslDir, { recursive: true });
  writeTestCert(sslDir, 'valid.example.com', 60);

  const agent = await import(srcUrl('core/hub/agent.js'));
  const { saveHubLink, clearHubLink } = await import(srcUrl('core/hubLink.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));

  dbSet('config', {
    nginxDir: path.join(dataDir, 'nginx'),
    sslDir,
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: 'ops@example.com',
    os: process.platform,
  });
  dbSet('domains', [
    { name: 'valid.example.com', port: 3000, enabled: true },
    { name: 'missing.example.com', port: 3001, enabled: true },
  ]);
  saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

  try {
    agent.initHubAgent();
    check('the agent connects', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);
    const pushed = await waitUntil(() => hub.state.domainConfigs.length > 0);
    check('the agent pushes domain:configs', pushed);

    const domains = hub.state.domainConfigs.at(-1) ?? [];
    const of = (name) => domains.find((domain) => domain.name === name);
    check('a domain with a readable certificate reports its status',
      of('valid.example.com')?.certStatus === 'valid');
    check('a domain with no certificate reports not_issued and its label',
      of('missing.example.com')?.certStatus === 'not_issued'
      && of('missing.example.com')?.certLabel === 'Not issued yet');
    check('the domain payload carries no certificate path or contents',
      !JSON.stringify(domains).includes('privkey.pem')
      && !JSON.stringify(domains).includes('fullchain.pem')
      && !JSON.stringify(domains).includes('PRIVATE KEY'));
  } finally {
    agent.stopHubAgent();
    clearHubLink();
    await hub.close();
  }
}

// ─── 13b. Certificate-aware domain deletion and lifecycle races ─────────────

async function testDomainCertificateDeletionSafety() {
  setGroup('13b. domain deletion retains shared certificates and obeys the lifecycle lock');

  const cfg = await import(srcUrl('core/config.js'));
  const domains = await import(srcUrl('core/domains-db.js'));
  const managed = await import(srcUrl('core/ssl/managed-artifacts.js'));
  const locks = await import(srcUrl('core/ssl/artifact-lock.js'));
  const { dbGet, dbSet } = await import(srcUrl('core/db.js'));
  const { handleHubDomainCommand } = domains;
  const { default: DomainsController } = await import(
    srcUrl('dashboard/controllers/domainsController.js')
  );

  const originalConfig = cfg.loadConfig();
  const originalDomains = dbGet('domains');
  const root = path.join(path.dirname(TEST_DATA_DIR), 'domain-delete-lifecycle');
  const sslDir = path.join(root, 'ssl');
  const nginxDir = path.join(root, 'nginx');
  fs.mkdirSync(sslDir, { recursive: true });
  fs.mkdirSync(nginxDir, { recursive: true });
  if (process.platform !== 'win32') fs.chmodSync(sslDir, 0o700);
  cfg.saveConfig({ ...originalConfig, sslDir, nginxDir });

  const response = () => {
    const out = { code: 200, body: null };
    return {
      out,
      res: {
        status(code) { out.code = code; return this; },
        json(body) { out.body = body; return this; },
      },
    };
  };
  const runFn = async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 });

  try {
    const sharedName = 'shared-cert.example';
    const consumerName = 'consumer-cert.example';
    writeTestCert(sslDir, sharedName, 45);
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(sslDir, sharedName), 0o700);
    }
    await managed.recordManagedArtifacts({
      dataDir: TEST_DATA_DIR,
      sslDir,
      files: [
        `${sharedName}/fullchain.pem`,
        `${sharedName}/privkey.pem`,
      ],
      directories: [sharedName],
    });
    const sharedCert = path.join(sslDir, sharedName, 'fullchain.pem');
    const sharedKey = path.join(sslDir, sharedName, 'privkey.pem');
    const shared = domains.createDomain({
      name: sharedName,
      port: 3000,
      ssl: { enabled: true, certPath: sharedCert, keyPath: sharedKey },
    });
    const consumer = domains.createDomain({
      name: consumerName,
      port: 3001,
      ssl: { enabled: true, certPath: sharedCert, keyPath: sharedKey },
    });
    domains.saveDomains([shared, consumer]);

    const sharedResult = await handleHubDomainCommand(
      { action: 'delete', name: sharedName, deleteCert: true },
      { runFn },
    );
    check('the Hub deletes the domain but retains a certificate used elsewhere',
      sharedResult.ok === true
        && sharedResult.certDeleted === false
        && sharedResult.certRetained === true
        && sharedResult.certReason === 'cert_in_use'
        && sharedResult.usedBy.includes(consumerName)
        && fs.existsSync(sharedCert) && fs.existsSync(sharedKey),
      JSON.stringify(sharedResult));
    check('retained-certificate references are filenames, never filesystem paths',
      sharedResult.references.every((entry) =>
        typeof entry.file === 'string'
          && !entry.file.includes('/')
          && !entry.file.includes('\\')),
      JSON.stringify(sharedResult.references));

    const dashboardName = 'dashboard-delete.example';
    writeTestCert(sslDir, dashboardName, 45);
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(sslDir, dashboardName), 0o700);
    }
    await managed.recordManagedArtifacts({
      dataDir: TEST_DATA_DIR,
      sslDir,
      files: [
        `${dashboardName}/fullchain.pem`,
        `${dashboardName}/privkey.pem`,
      ],
      directories: [dashboardName],
    });
    const dashboardCert = path.join(sslDir, dashboardName, 'fullchain.pem');
    const dashboardKey = path.join(sslDir, dashboardName, 'privkey.pem');
    const dashboardDomain = domains.createDomain({
      name: dashboardName,
      port: 3002,
      ssl: {
        enabled: true,
        certPath: dashboardCert,
        keyPath: dashboardKey,
      },
    });
    domains.saveDomains([consumer, dashboardDomain]);
    const dashboard = response();
    await new DomainsController().delete(
      { params: { name: dashboardName }, query: { deleteCert: 'true' } },
      dashboard.res,
      (error) => { dashboard.out.body = { error: error.message }; dashboard.out.code = 500; },
    );
    check('the dashboard deleteCert=true route removes only manifest-owned files',
      dashboard.out.code === 200
        && dashboard.out.body?.certDeleted === true
        && !fs.existsSync(dashboardCert)
        && !fs.existsSync(dashboardKey),
      JSON.stringify(dashboard.out));

    const unmanagedName = 'unmanaged-delete.example';
    writeTestCert(sslDir, unmanagedName, 45);
    const unmanagedDomain = domains.createDomain({
      name: unmanagedName,
      port: 3003,
      ssl: {
        enabled: true,
        certPath: path.join(sslDir, unmanagedName, 'fullchain.pem'),
        keyPath: path.join(sslDir, unmanagedName, 'privkey.pem'),
      },
    });
    domains.saveDomains([consumer, unmanagedDomain]);
    const unmanagedResult = await handleHubDomainCommand(
      { action: 'delete', name: unmanagedName, deleteCert: true },
      { runFn },
    );
    check('deleteCert=true retains an unmanaged certificate',
      unmanagedResult.ok === true
        && unmanagedResult.certRetained === true
        && unmanagedResult.certReason === 'cert_not_managed'
        && fs.existsSync(path.join(sslDir, unmanagedName, 'privkey.pem')),
      JSON.stringify(unmanagedResult));

    const createName = 'locked-create.example';
    const heldForCreate = await locks.acquireArtifactLock({
      dataDir: TEST_DATA_DIR,
      key: locks.SSL_ARTIFACT_LIFECYCLE_LOCK,
      timeoutMs: 2_000,
    });
    let createSettled = false;
    const missingCert = path.join(sslDir, createName, 'missing.pem');
    const lockedCreate = new DomainsController().create(
      {
        body: {
          name: createName,
          port: 3004,
          ssl: { enabled: true, certPath: missingCert, keyPath: `${missingCert}.key` },
        },
      },
      response().res,
      () => {},
    ).finally(() => { createSettled = true; });
    await sleep(100);
    const createWaited = createSettled === false;
    heldForCreate.release();
    await lockedCreate;
    check('dashboard create rechecks certificate state under the lifecycle lock',
      createWaited && !domains.findDomain(createName),
      `waited=${createWaited}`);

    const updateName = 'locked-update.example';
    const updateDomain = domains.createDomain({ name: updateName, port: 3005 });
    domains.saveDomains([consumer, updateDomain]);
    const heldForUpdate = await locks.acquireArtifactLock({
      dataDir: TEST_DATA_DIR,
      key: locks.SSL_ARTIFACT_LIFECYCLE_LOCK,
      timeoutMs: 2_000,
    });
    let updateSettled = false;
    const lockedUpdate = new DomainsController().update(
      {
        params: { name: updateName },
        body: {
          ssl: {
            enabled: true,
            certPath: path.join(sslDir, updateName, 'missing.pem'),
            keyPath: path.join(sslDir, updateName, 'missing.key'),
          },
        },
      },
      response().res,
      () => {},
    ).finally(() => { updateSettled = true; });
    await sleep(100);
    const updateWaited = updateSettled === false;
    heldForUpdate.release();
    await lockedUpdate;
    check('dashboard update rechecks certificate state under the lifecycle lock',
      updateWaited && domains.findDomain(updateName)?.ssl?.enabled !== true,
      `waited=${updateWaited}`);

    const hubCreateName = 'hub-locked-create.example';
    const heldForHubCreate = await locks.acquireArtifactLock({
      dataDir: TEST_DATA_DIR,
      key: locks.SSL_ARTIFACT_LIFECYCLE_LOCK,
      timeoutMs: 2_000,
    });
    let hubCreateSettled = false;
    const lockedHubCreate = handleHubDomainCommand(
      {
        action: 'create',
        domain: {
          name: hubCreateName,
          port: 3006,
          ssl: {
            enabled: true,
            certPath: path.join(sslDir, hubCreateName, 'missing.pem'),
            keyPath: path.join(sslDir, hubCreateName, 'missing.key'),
          },
        },
      },
      { runFn },
    ).finally(() => { hubCreateSettled = true; });
    await sleep(100);
    const hubCreateWaited = hubCreateSettled === false;
    heldForHubCreate.release();
    const hubCreateResult = await lockedHubCreate;
    check('Hub create rechecks certificate state under the lifecycle lock',
      hubCreateWaited
        && hubCreateResult.ok === false
        && hubCreateResult.code === 'cert_missing'
        && !domains.findDomain(hubCreateName),
      JSON.stringify({ waited: hubCreateWaited, result: hubCreateResult }));

    const hubUpdateName = 'hub-locked-update.example';
    domains.saveDomains([
      consumer,
      domains.createDomain({ name: hubUpdateName, port: 3007 }),
    ]);
    const heldForHubUpdate = await locks.acquireArtifactLock({
      dataDir: TEST_DATA_DIR,
      key: locks.SSL_ARTIFACT_LIFECYCLE_LOCK,
      timeoutMs: 2_000,
    });
    let hubUpdateSettled = false;
    const lockedHubUpdate = handleHubDomainCommand(
      {
        action: 'update',
        name: hubUpdateName,
        domain: {
          ssl: {
            enabled: true,
            certPath: path.join(sslDir, hubUpdateName, 'missing.pem'),
            keyPath: path.join(sslDir, hubUpdateName, 'missing.key'),
          },
        },
      },
      { runFn },
    ).finally(() => { hubUpdateSettled = true; });
    await sleep(100);
    const hubUpdateWaited = hubUpdateSettled === false;
    heldForHubUpdate.release();
    const hubUpdateResult = await lockedHubUpdate;
    check('Hub update rechecks certificate state under the lifecycle lock',
      hubUpdateWaited
        && hubUpdateResult.ok === false
        && hubUpdateResult.code === 'cert_missing'
        && domains.findDomain(hubUpdateName)?.ssl?.enabled !== true,
      JSON.stringify({ waited: hubUpdateWaited, result: hubUpdateResult }));
  } finally {
    cfg.saveConfig(originalConfig);
    dbSet('domains', Array.isArray(originalDomains) ? originalDomains : []);
  }
}

// ─── 14. Hub telemetry is permission-projected ─────────────────────────────

async function testHubTelemetryProjection() {
  setGroup('14. Hub telemetry projects domains and deployment diagnostics by grant');

  const hub = await startTestHub();
  const dataDir = scratch('hub-telemetry-projection');
  const sslDir = path.join(dataDir, 'ssl');
  fs.mkdirSync(sslDir, { recursive: true });

  const agent = await import(srcUrl('core/hub/agent.js'));
  const {
    saveHubLink,
    clearHubLink,
    saveHubPermissions,
    getHubPermissions,
  } = await import(srcUrl('core/hubLink.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));
  const apps = await import(srcUrl('core/deploy/apps.js'));
  const store = await import(srcUrl('core/deploy/store.js'));
  const status = await import(srcUrl('core/deploy/status.js'));

  const APP_ID = 'telemetry-app';
  const RUN_ID = '20261124-120000-abcdef';
  const RUN_SENTINEL = 'HUB_TELEMETRY_SENTINEL_7b21c';
  const CONFIG_SENTINEL = `${RUN_SENTINEL}_CONFIG`;
  const CERT_PATH = path.join(sslDir, 'private.example.com', 'fullchain.pem');
  const KEY_PATH = path.join(sslDir, 'private.example.com', 'privkey.pem');
  const CONFIG_FILE = path.join(dataDir, 'nginx', 'sites', 'private.example.com.conf');

  dbSet('config', {
    nginxDir: path.join(dataDir, 'nginx'),
    sslDir,
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: 'ops@example.com',
    os: process.platform,
  });
  dbSet('domains', [{
    name: 'private.example.com',
    port: 4321,
    backendHost: '127.0.0.1',
    upstreamType: 'http',
    www: true,
    wildcard: false,
    behindCloudflare: false,
    enabled: true,
    ssl: {
      enabled: true,
      certPath: CERT_PATH,
      keyPath: KEY_PATH,
      redirect: true,
      hsts: true,
      hstsMaxAge: 31536000,
    },
    performance: {
      maxBodySize: '20m',
      readTimeout: 45,
      connectTimeout: 8,
      proxyBuffers: true,
      gzip: true,
      gzipTypes: 'text/plain application/json',
    },
    security: {
      rateLimit: true,
      rateLimitRate: 12,
      rateLimitBurst: 24,
      securityHeaders: true,
      custom404: false,
      custom50x: false,
    },
    advanced: {
      accessLog: true,
      customLocations: `location /internal { return 200 "${CONFIG_SENTINEL}"; }`,
    },
    notifications: {
      domain_health: { enabled: true, channelIds: ['channel-1'] },
      cert_expiry: { enabled: false, channelIds: [] },
      nginx_down: { enabled: true, channelIds: ['channel-2'] },
    },
    configFile: CONFIG_FILE,
  }]);

  const created = apps.createApp({
    id: APP_ID,
    repoUrl: 'https://github.com/me/telemetry-app.git',
    branch: 'main',
    env: {},
    settings: { port: 4321 },
  });
  if (!created.ok) throw new Error(`could not register ${APP_ID}: ${created.errors.join('; ')}`);

  const run = {
    id: RUN_ID,
    appId: APP_ID,
    trigger: 'manual',
    actor: 'local-user@example.com',
    ref: 'main',
    sha: 'a'.repeat(40),
    releaseId: RUN_ID,
    status: 'failed',
    step: 'health',
    stage: 'health',
    skippedStages: ['install'],
    startedAt: 1_800_000_000_000,
    finishedAt: 1_800_000_060_000,
    error: `command failed: ${RUN_SENTINEL}`,
    warnings: [`doctor: ${RUN_SENTINEL}_WARN`],
    reason: `crash output: ${RUN_SENTINEL}_REASON`,
    logTail: [`stderr: ${RUN_SENTINEL}_TAIL`],
    rolledBackTo: null,
    rollbackSucceeded: true,
    logSecurity: 'redacted-v1',
    debugOutput: `unknown future output: ${RUN_SENTINEL}_UNKNOWN`,
  };
  store.writeRun(run);
  fs.writeFileSync(store.logFile(APP_ID, RUN_ID), `build output: ${RUN_SENTINEL}_LOG\n`, 'utf8');

  // A privileged projection can already be in flight when revocation arrives.
  // Hold both asynchronous data-loading paths, revoke while they wait, then
  // prove their eventual payload was projected with the post-revocation state.
  saveHubPermissions({ 'nginx.config.view': true, 'deploy.logs': true });
  let certLoadStarted;
  const certLoading = new Promise((resolve) => { certLoadStarted = resolve; });
  let releaseCertLoad;
  const certGate = new Promise((resolve) => { releaseCertLoad = resolve; });
  const pendingDomains = agent.domainsWithCertState([{
    name: 'deferred.example.com',
    enabled: true,
    ssl: { enabled: true, certPath: CERT_PATH, keyPath: KEY_PATH },
    advanced: { customLocations: CONFIG_SENTINEL },
    configFile: CONFIG_FILE,
  }], {
    listCertificates: async () => [],
    certificateStatus: async () => {
      certLoadStarted();
      await certGate;
      return { state: 'not_issued' };
    },
    permissions: getHubPermissions,
  });
  await certLoading;
  saveHubPermissions({ 'nginx.config.view': false });
  releaseCertLoad();
  const deferredDomains = await pendingDomains;
  check('a domain payload that finishes after revocation is reprojected with the current grant',
    !JSON.stringify(deferredDomains).includes(CERT_PATH)
      && !JSON.stringify(deferredDomains).includes(KEY_PATH)
      && !JSON.stringify(deferredDomains).includes(CONFIG_SENTINEL)
      && !JSON.stringify(deferredDomains).includes(CONFIG_FILE)
      && deferredDomains[0]?.certStatus === 'not_issued');

  const telemetry = await import(srcUrl('core/hub/telemetry.js'));
  const legacyCredentialDomain = telemetry.projectDomainForHub({
    name: 'legacy-credential.example.com',
    backendHost: 'https://operator:LEGACY_BACKEND_SECRET@backend.example',
    port: 443,
    enabled: true,
  });
  check('legacy credential-bearing backend hosts are redacted at the Hub boundary',
    legacyCredentialDomain?.backendHost === null
      && !JSON.stringify(legacyCredentialDomain).includes('LEGACY_BACKEND_SECRET')
      && !JSON.stringify(legacyCredentialDomain).includes('operator:'),
    JSON.stringify(legacyCredentialDomain));
  let deployLoadStarted;
  const deployLoading = new Promise((resolve) => { deployLoadStarted = resolve; });
  let releaseDeployLoad;
  const deployGate = new Promise((resolve) => { releaseDeployLoad = resolve; });
  const pendingDeploy = telemetry.describeDeployAppsForHub(async () => {
    deployLoadStarted();
    await deployGate;
    return [{ id: APP_ID, lastRun: run }];
  }, getHubPermissions);
  await deployLoading;
  saveHubPermissions({ 'deploy.logs': false });
  releaseDeployLoad();
  const deferredDeploy = await pendingDeploy;
  check('deployment diagnostics that finish after revocation are reprojected with the current grant',
    deferredDeploy[0]?.lastRun?.status === 'failed'
      && deferredDeploy[0]?.lastRun?.error === null
      && deferredDeploy[0]?.lastRun?.reason === null
      && deferredDeploy[0]?.lastRun?.warnings?.length === 0
      && deferredDeploy[0]?.lastRun?.logTail?.length === 0
      && !JSON.stringify(deferredDeploy).includes(RUN_SENTINEL));

  const dispatch = async (event, payload, timeoutMs = 15_000) => {
    const before = hub.state.results.length;
    const requestId = `req-${Math.random().toString(16).slice(2)}`;
    hub.state.socket.emit(event, { ...payload, requestId });
    await waitUntil(() => hub.state.results.length > before, { timeoutMs });
    return hub.state.results.find((result) => result.requestId === requestId) ?? null;
  };

  saveHubPermissions({
    'nginx.config.edit': true,
    'deploy.ci': true,
  });
  saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

  try {
    agent.initHubAgent();
    check('the telemetry agent connects', await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);
    check('it pushes the first projected snapshots',
      await waitUntil(() => hub.state.domainConfigs.length > 0
        && hub.state.deployApps.length > 0
        && hub.state.serverInfo.length > 0));

    const safeDomains = hub.state.domainConfigs.at(-1) ?? [];
    const safeDomain = safeDomains.find((domain) => domain.name === 'private.example.com');
    const safeDomainJson = JSON.stringify(safeDomains);
    check('routine domain telemetry keeps monitoring and editable fields',
      safeDomain?.enabled === true
      && safeDomain?.port === 4321
      && safeDomain?.www === true
      && safeDomain?.ssl?.enabled === true
      && safeDomain?.performance?.maxBodySize === '20m'
      && safeDomain?.security?.rateLimit === true
      && safeDomain?.advanced?.accessLog === true
      && safeDomain?.notifications?.domain_health?.channelIds?.[0] === 'channel-1',
      JSON.stringify(safeDomain));
    check('nginx.config.edit alone does not expose local paths or the raw nginx fragment',
      !safeDomainJson.includes(CERT_PATH)
      && !safeDomainJson.includes(KEY_PATH)
      && !safeDomainJson.includes(CONFIG_FILE)
      && !safeDomainJson.includes(CONFIG_SENTINEL)
      && !Object.prototype.hasOwnProperty.call(safeDomain?.ssl ?? {}, 'certPath')
      && !Object.prototype.hasOwnProperty.call(safeDomain?.ssl ?? {}, 'keyPath')
      && !Object.prototype.hasOwnProperty.call(safeDomain ?? {}, 'configFile')
      && !Object.prototype.hasOwnProperty.call(safeDomain?.advanced ?? {}, 'customLocations'));
    check('server:info clears the SSL directory without nginx.config.view',
      hub.state.serverInfo.at(-1)?.sslDir === '',
      JSON.stringify(hub.state.serverInfo.at(-1)));

    const noLogsList = await dispatch('hub:manageDeploy', { action: 'list' });
    const noLogsDetail = await dispatch('hub:manageDeploy', { action: 'detail', id: APP_ID });
    const noLogsRun = await dispatch('hub:manageDeploy', { action: 'run', id: APP_ID, runId: RUN_ID });
    const listRun = noLogsList?.data?.apps?.find((app) => app.id === APP_ID)?.lastRun;
    const detailRun = noLogsDetail?.data?.runs?.find((entry) => entry.id === RUN_ID);
    check('Hub list and detail keep operational run status without sentinel output',
      noLogsList?.ok === true
      && noLogsDetail?.ok === true
      && listRun?.id === RUN_ID
      && listRun?.status === 'failed'
      && listRun?.step === 'health'
      && listRun?.stage === 'health'
      && detailRun?.rollbackSucceeded === true
      && listRun?.error === null
      && listRun?.reason === null
      && Array.isArray(listRun?.warnings) && listRun.warnings.length === 0
      && Array.isArray(listRun?.logTail) && listRun.logTail.length === 0,
      JSON.stringify(noLogsList?.data ?? noLogsList));
    check('Hub list, detail and the explicit log action reveal no sentinel without deploy.logs',
      !JSON.stringify(noLogsList).includes(RUN_SENTINEL)
      && !JSON.stringify(noLogsDetail).includes(RUN_SENTINEL)
      && noLogsRun?.ok === false
      && /deploy\.logs/.test(noLogsRun?.error ?? ''),
      JSON.stringify(noLogsRun));
    check('the local dashboard keeps the full run diagnostics',
      status.describeApp(apps.getApp(APP_ID), new Map()).lastRun?.error === run.error
      && status.describeApp(apps.getApp(APP_ID), new Map()).lastRun?.logTail?.[0] === run.logTail[0]);

    const { token } = apps.rotateHookToken(APP_ID);
    const noLogsHook = await dispatch('hub:deployHook', {
      action: 'status',
      appId: APP_ID,
      token,
      runId: RUN_ID,
    });
    check('Hub CI status is projected too',
      noLogsHook?.ok === true
      && noLogsHook?.data?.found === true
      && noLogsHook?.data?.run?.runId === RUN_ID
      && noLogsHook?.data?.run?.status === 'failed'
      && noLogsHook?.data?.run?.error === null
      && noLogsHook?.data?.run?.reason === null
      && Array.isArray(noLogsHook?.data?.run?.warnings)
      && noLogsHook.data.run.warnings.length === 0
      && Array.isArray(noLogsHook?.data?.run?.logTail)
      && noLogsHook.data.run.logTail.length === 0
      && !JSON.stringify(noLogsHook).includes(RUN_SENTINEL),
      JSON.stringify(noLogsHook));

    const deployAppsBefore = hub.state.deployApps.length;
    const domainConfigsBefore = hub.state.domainConfigs.length;
    const serverInfoBefore = hub.state.serverInfo.length;
    saveHubPermissions({
      'nginx.config.view': true,
      'deploy.logs': true,
    });
    check('a permission revision immediately refreshes domain, deploy and server telemetry',
      await waitUntil(() => hub.state.deployApps.length > deployAppsBefore
        && hub.state.domainConfigs.length > domainConfigsBefore
        && hub.state.serverInfo.length > serverInfoBefore, { timeoutMs: 8_000 }));

    const privilegedDomain = (hub.state.domainConfigs.at(-1) ?? [])
      .find((domain) => domain.name === 'private.example.com');
    check('nginx.config.view adds paths and the raw advanced fragment',
      privilegedDomain?.ssl?.certPath === CERT_PATH
      && privilegedDomain?.ssl?.keyPath === KEY_PATH
      && privilegedDomain?.configFile === CONFIG_FILE
      && privilegedDomain?.advanced?.customLocations?.includes(CONFIG_SENTINEL));
    check('nginx.config.view exposes the configured SSL directory',
      hub.state.serverInfo.at(-1)?.sslDir === sslDir,
      JSON.stringify(hub.state.serverInfo.at(-1)));

    const withLogsList = await dispatch('hub:manageDeploy', { action: 'list' });
    const withLogsDetail = await dispatch('hub:manageDeploy', { action: 'detail', id: APP_ID });
    const withLogsRun = await dispatch('hub:manageDeploy', { action: 'run', id: APP_ID, runId: RUN_ID });
    const withLogsHook = await dispatch('hub:deployHook', {
      action: 'status',
      appId: APP_ID,
      token,
      runId: RUN_ID,
    });
    const deployedRun = hub.state.deployApps.at(-1)?.find((app) => app.id === APP_ID)?.lastRun;
    check('deploy.logs exposes diagnostics on deploy:apps, list, detail and CI status',
      deployedRun?.error === run.error
      && deployedRun?.reason === run.reason
      && deployedRun?.warnings?.[0] === run.warnings[0]
      && deployedRun?.logTail?.[0] === run.logTail[0]
      && withLogsList?.data?.apps?.find((app) => app.id === APP_ID)?.lastRun?.error === run.error
      && withLogsDetail?.data?.runs?.find((entry) => entry.id === RUN_ID)?.reason === run.reason
      && withLogsHook?.data?.run?.warnings?.[0] === run.warnings[0]);
    check('an explicit run includes only projected fields and the bounded redacted log',
      withLogsRun?.ok === true
      && withLogsRun?.data?.error === run.error
      && withLogsRun?.data?.log?.includes(`${RUN_SENTINEL}_LOG`)
      && withLogsRun?.data?.logTruncated === false
      && !Object.prototype.hasOwnProperty.call(withLogsRun?.data ?? {}, 'debugOutput')
      && !Object.prototype.hasOwnProperty.call(withLogsRun?.data ?? {}, 'actor'));

    const beforeRevoke = hub.state.deployApps.length;
    const beforeRevokeDomains = hub.state.domainConfigs.length;
    const beforeRevokeServerInfo = hub.state.serverInfo.length;
    saveHubPermissions({ 'nginx.config.view': false, 'deploy.logs': false });
    check('revoking grants immediately refreshes deploy, domain and server telemetry',
      await waitUntil(() => hub.state.deployApps.length > beforeRevoke
        && hub.state.domainConfigs.length > beforeRevokeDomains
        && hub.state.serverInfo.length > beforeRevokeServerInfo, { timeoutMs: 8_000 }));
    const revokedRun = hub.state.deployApps.at(-1)
      ?.find((app) => app.id === APP_ID)?.lastRun;
    const postRevocationDeployEvents = hub.state.deployApps.slice(beforeRevoke);
    const revokedDomain = (hub.state.domainConfigs.at(-1) ?? [])
      .find((domain) => domain.name === 'private.example.com');
    check('revocation clears the SSL directory and protected domain values already received',
      hub.state.serverInfo.at(-1)?.sslDir === ''
      && !Object.prototype.hasOwnProperty.call(revokedDomain?.ssl ?? {}, 'certPath')
      && !Object.prototype.hasOwnProperty.call(revokedDomain?.ssl ?? {}, 'keyPath')
      && !Object.prototype.hasOwnProperty.call(revokedDomain ?? {}, 'configFile')
      && !Object.prototype.hasOwnProperty.call(revokedDomain?.advanced ?? {}, 'customLocations'));
    check('the refreshed payload removes diagnostics that were already granted',
      revokedRun?.status === 'failed'
      && revokedRun?.error === null
      && revokedRun?.reason === null
      && revokedRun?.warnings?.length === 0
      && revokedRun?.logTail?.length === 0
      && !JSON.stringify(hub.state.deployApps.at(-1)).includes(RUN_SENTINEL));
    check('every deploy telemetry event after revocation, including an in-flight refresh, is redacted',
      postRevocationDeployEvents.length > 0
        && postRevocationDeployEvents.every((apps) => !JSON.stringify(apps).includes(RUN_SENTINEL)),
      `${postRevocationDeployEvents.length} post-revocation event(s)`);
  } finally {
    agent.stopHubAgent();
    saveHubPermissions({ 'nginx.config.view': false, 'deploy.logs': false });
    clearHubLink();
    await hub.close();
  }
}

// ─── 15. Delayed Hub work rechecks the current grants ───────────────────────

async function testDelayedHubPermissionRevocation() {
  setGroup('15. delayed Hub work is withheld when permission is revoked');

  const hub = await startTestHub();
  const dataDir = scratch('hub-delayed-revocation');

  const agent = await import(srcUrl('core/hub/agent.js'));
  const {
    saveHubLink,
    clearHubLink,
    saveHubPermissions,
  } = await import(srcUrl('core/hubLink.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));

  dbSet('config', {
    nginxDir: path.join(dataDir, 'nginx'),
    sslDir: path.join(dataDir, 'ssl'),
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: '',
    os: process.platform,
  });
  dbSet('domains', []);
  saveHubPermissions({ 'nginx.logs.view': true, 'nginx.config.view': true });
  saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });

  const eventCount = (name) => hub.state.events.filter((entry) => entry === name).length;

  try {
    agent.initHubAgent();
    check('the delayed-command agent connects',
      await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);

    const logsRead = createGate();
    const logsReadStarted = createGate();
    const logsAck = createAckWaiter();
    const logsBefore = eventCount('nginx:logs');
    const logsPending = agent.handleGetLogs(
      { lines: 25, requestId: 'delayed-logs' },
      logsAck.resolve,
      {
        read: async () => {
          logsReadStarted.release();
          await logsRead.promise;
          return { lines: ['DELAYED_NGINX_LOG_SENTINEL'] };
        },
      },
    );
    await logsReadStarted.promise;
    saveHubPermissions({ 'nginx.logs.view': false, 'nginx.config.view': true });
    logsRead.release();
    const logsResult = await logsAck.promise;
    await logsPending;
    check('a delayed nginx log read returns no success or payload after revocation',
      logsResult?.ok === false
        && /permission was revoked/i.test(logsResult?.error ?? '')
        && logsResult?.data === null,
      JSON.stringify(logsResult));
    check('a delayed nginx log read emits no nginx:logs side channel',
      eventCount('nginx:logs') === logsBefore,
      `${eventCount('nginx:logs') - logsBefore} extra event(s)`);

    const configsRead = createGate();
    const configsReadStarted = createGate();
    const configsAck = createAckWaiter();
    const configsBefore = eventCount('nginx:configs');
    const configsPending = agent.handleGetConfigs(
      { requestId: 'delayed-configs' },
      configsAck.resolve,
      {
        list: async () => ['delayed.conf'],
        read: async () => {
          configsReadStarted.release();
          await configsRead.promise;
          return { content: 'DELAYED_NGINX_CONFIG_SENTINEL' };
        },
      },
    );
    await configsReadStarted.promise;
    saveHubPermissions({ 'nginx.config.view': false });
    configsRead.release();
    const configsResult = await configsAck.promise;
    await configsPending;
    check('a delayed nginx config read returns no success or payload after revocation',
      configsResult?.ok === false
        && /permission was revoked/i.test(configsResult?.error ?? '')
        && configsResult?.data === null,
      JSON.stringify(configsResult));
    check('a delayed nginx config read emits no nginx:configs side channel',
      eventCount('nginx:configs') === configsBefore,
      `${eventCount('nginx:configs') - configsBefore} extra event(s)`);

    const DEPLOY_SENTINEL = 'DELAYED_DEPLOY_DIAGNOSTIC_SENTINEL';
    const deployRead = createGate();
    const deployReadStarted = createGate();
    const deployAck = createAckWaiter();
    saveHubPermissions({ 'deploy.logs': true });
    const deployPending = agent.handleManageDeploy(
      { action: 'list', requestId: 'delayed-deploy' },
      deployAck.resolve,
      {
        handleHubDeployCommand: async () => {
          deployReadStarted.release();
          await deployRead.promise;
          return {
            apps: [{
              id: 'delayed-app',
              lastRun: { status: 'failed', error: DEPLOY_SENTINEL },
            }],
          };
        },
      },
    );
    await deployReadStarted.promise;
    saveHubPermissions({ 'deploy.logs': false });
    deployRead.release();
    const deployResult = await deployAck.promise;
    await deployPending;
    check('a delayed deployment list withholds diagnostics after deploy.logs is revoked',
      deployResult?.ok === false
        && /permission was revoked/i.test(deployResult?.error ?? '')
        && !JSON.stringify(deployResult).includes(DEPLOY_SENTINEL),
      JSON.stringify(deployResult));

    // The real revision-refresh function first emits a redacted cached
    // snapshot, then waits for a slower PM2-backed deployment refresh. Drive
    // that production function directly so removing its cached-redaction call
    // cannot be hidden by testing the helper in isolation.
    saveHubPermissions({ 'deploy.logs': true });
    const emitted = [];
    const target = {
      connected: true,
      emit(event, payload) { emitted.push({ event, payload }); },
    };
    await agent.pushDeployApps({
      target,
      describe: async (_loadApps, permissionsForHub) => {
        permissionsForHub();
        return [{
          id: 'cached-app',
          lastRun: {
            status: 'failed',
            error: DEPLOY_SENTINEL,
            reason: DEPLOY_SENTINEL,
            warnings: [DEPLOY_SENTINEL],
            logTail: [DEPLOY_SENTINEL],
          },
        }];
      },
    });

    const slowRefresh = createGate();
    const slowRefreshStarted = createGate();
    const beforeRedaction = emitted.length;
    const pendingRefresh = agent.refreshRevisionOnce({
      target,
      revision: 1_900_000_000 + Math.floor(Math.random() * 1_000_000),
      permissionSnapshot: {},
      pushServerInfoFn: async () => {},
      pushDomainConfigsFn: async () => {},
      pushDomainHealthFn: async () => {},
      pushCertExpiryFn: async () => {},
      pushServiceStateFn: async () => {},
      pushDeployAppsFn: async () => {
        slowRefreshStarted.release();
        await slowRefresh.promise;
      },
    });
    await slowRefreshStarted.promise;
    const cachedEvents = emitted
      .slice(beforeRedaction)
      .filter((entry) => entry.event === 'deploy:apps');
    const fastPayload = cachedEvents.at(-1)?.payload;
    check('cached deployment diagnostics are redacted before the slow refresh finishes',
      cachedEvents.length === 1
        && !JSON.stringify(fastPayload).includes(DEPLOY_SENTINEL),
      JSON.stringify(fastPayload));
    slowRefresh.release();
    await pendingRefresh;
    check('the slower deployment refresh follows the immediate redaction',
      emitted.slice(beforeRedaction).filter((entry) => entry.event === 'deploy:apps').length === 1,
      `${emitted.slice(beforeRedaction).filter((entry) => entry.event === 'deploy:apps').length} post-revocation deployment event(s)`);

    const stagedGates = [createGate(), createGate(), createGate()];
    const revisionStarted = [createGate(), createGate(), createGate()];
    let revisionCount = 0;
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const requestRevision = agent.createSerializedRevisionRunner(async () => {
      const index = revisionCount++;
      activeRefreshes++;
      maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
      revisionStarted[index]?.release();
      await stagedGates[index].promise;
      activeRefreshes--;
    });

    const firstRevision = requestRevision();
    await revisionStarted[0].promise;
    const collapsedRevision = requestRevision();
    requestRevision();
    stagedGates[0].release();
    await revisionStarted[1].promise;
    const laterRevision = requestRevision();
    stagedGates[1].release();
    await revisionStarted[2].promise;
    check('revision refreshes never overlap',
      maxActiveRefreshes === 1 && revisionCount === 3,
      `max active=${maxActiveRefreshes}, runs=${revisionCount}`);
    stagedGates[2].release();
    await Promise.all([firstRevision, collapsedRevision, laterRevision]);
    check('a later permission revision is processed after the current refresh',
      revisionCount === 3 && activeRefreshes === 0,
      `runs=${revisionCount}, active=${activeRefreshes}`);

    let currentRevision = 2_000_000_000 + Math.floor(Math.random() * 1_000_000);
    const revisionGates = [createGate(), createGate()];
    const revisionRuns = [createGate(), createGate()];
    const seenRevisions = [];
    const productionRunner = agent.createHubRevisionRefreshRunner({
      readRevision: () => currentRevision,
      isConnected: () => true,
      refresh: async ({ revision }) => {
        const index = seenRevisions.length;
        seenRevisions.push(revision);
        revisionRuns[index]?.release();
        await revisionGates[index].promise;
      },
    });
    const firstProductionPass = productionRunner();
    await revisionRuns[0].promise;
    currentRevision += 1;
    const queuedProductionPass = productionRunner();
    revisionGates[0].release();
    await revisionRuns[1].promise;
    check('a queued production revision refresh rereads the newer counter',
      seenRevisions.length === 2 && seenRevisions[1] === currentRevision,
      seenRevisions.join(', '));
    revisionGates[1].release();
    await Promise.all([firstProductionPass, queuedProductionPass]);
  } finally {
    agent.stopHubAgent();
    saveHubPermissions({ 'nginx.config.view': false, 'deploy.logs': false });
    clearHubLink();
    await hub.close();
  }
}

// ─── 16. Revocation is rechecked at the side-effect and event boundaries ───

async function testRevocationAtMutationBoundaries() {
  setGroup('16. revocation race tests cover every Hub side effect');

  const agent = await import(srcUrl('core/hub/agent.js'));
  const {
    clearHubLink,
    saveHubPermissions,
    getHubPermissions,
  } = await import(srcUrl('core/hubLink.js'));

  try {
    // Saving config and affecting live traffic are separate permissions. A
    // revoke that lands while saveConfig is awaiting must stop the reload.
    saveHubPermissions({ 'nginx.config.edit': true, 'nginx.reload': true });
    let reloadCalls = 0;
    const saveAck = createAckWaiter();
    await agent.handleSaveConfig(
      { filename: 'safe.conf', content: 'server { listen 8080; }', reload: true, requestId: 'save-race' },
      saveAck.resolve,
      {
        permissions: getHubPermissions,
        save: async () => {
          saveHubPermissions({ 'nginx.config.edit': true, 'nginx.reload': false });
          return { success: true, output: 'configuration test successful' };
        },
        reload: async () => {
          reloadCalls++;
          return { success: true, output: 'reloaded' };
        },
      },
    );
    const saveResult = await saveAck.promise;
    check('nginx.reload is rechecked after the saved file passes its test',
      saveResult?.ok === true && reloadCalls === 0
        && saveResult?.data?.reloaded === false,
      JSON.stringify({ reloadCalls, saveResult }));

    const coldImportCase = async ({
      permission,
      start,
      revoke = () => saveHubPermissions({ [permission]: false }),
    }) => {
      saveHubPermissions({ [permission]: true });
      const importGate = createGate();
      const importStarted = createGate();
      const ack = createAckWaiter();
      let mutations = 0;
      const pending = start({
        ack: ack.resolve,
        loadCommand: async () => {
          importStarted.release();
          await importGate.promise;
          return {
            handleHubDomainCommand: async () => { mutations++; return { ok: true, action: 'create' }; },
            handleHubSslCommand: async () => { mutations++; return { ok: true, action: 'renew' }; },
            handleHubDeployCommand: async () => { mutations++; return { ok: true, action: 'create' }; },
            handleHubDeployHook: async () => { mutations++; return { ok: true }; },
          };
        },
      });
      await importStarted.promise;
      revoke();
      importGate.release();
      const result = await ack.promise;
      await pending;
      return { result, mutations };
    };

    const domain = await coldImportCase({
      permission: 'domains.create',
      start: ({ ack, loadCommand }) => agent.handleManageDomain(
        { action: 'create', name: 'race.example.com', requestId: 'domain-race' },
        ack,
        { loadCommand },
      ),
    });
    check('a domain mutation is rechecked after a cold command import',
      domain.result?.ok === false && /revoked/i.test(domain.result?.error ?? '')
        && domain.mutations === 0,
      JSON.stringify(domain));

    const ssl = await coldImportCase({
      permission: 'ssl.renew',
      start: ({ ack, loadCommand }) => agent.handleManageSSL(
        { action: 'renew', domain: 'race.example.com', requestId: 'ssl-race' },
        ack,
        { loadCommand },
      ),
    });
    check('an SSL mutation is rechecked after a cold command import',
      ssl.result?.ok === false && /revoked/i.test(ssl.result?.error ?? '')
        && ssl.mutations === 0,
      JSON.stringify(ssl));

    const deploy = await coldImportCase({
      permission: 'deploy.manage',
      start: ({ ack, loadCommand }) => agent.handleManageDeploy(
        { action: 'create', requestId: 'deploy-race' },
        ack,
        {
          loadHubDeployCommand: loadCommand,
        },
      ),
    });
    check('a deployment mutation is rechecked after a cold command import',
      deploy.result?.ok === false && /revoked/i.test(deploy.result?.error ?? '')
        && deploy.mutations === 0,
      JSON.stringify(deploy));

    const hook = await coldImportCase({
      permission: 'deploy.ci',
      start: ({ ack, loadCommand }) => agent.handleDeployHook(
        { appId: 'race-app', requestId: 'hook-race' },
        ack,
        { loadHubDeployHook: loadCommand },
      ),
    });
    check('a CI mutation is rechecked after a cold command import',
      hook.result?.ok === false && /revoked/i.test(hook.result?.error ?? '')
        && hook.mutations === 0,
      JSON.stringify(hook));

    // PM2 discovery is slow and the list can take seconds. Revocation after
    // detection or listing must win over the mutation.
    saveHubPermissions({ 'process.stop': true });
    const detectGate = createGate();
    const detectStarted = createGate();
    const stopAck = createAckWaiter();
    let processMutations = 0;
    const processPending = agent.handleManageProcess(
      { action: 'stop', name: 'race-app', requestId: 'process-race' },
      stopAck.resolve,
      {
        runner: {
          async detect() {
            detectStarted.release();
            await detectGate.promise;
            return { installed: true, path: 'pm2' };
          },
          async list() {
            return { ok: true, apps: [{ name: 'race-app', user: null, managed: false }] };
          },
          currentUser: () => 'operator',
          async stop() { processMutations++; return { ok: true, output: 'stopped' }; },
          async restart() { processMutations++; return { ok: true, output: 'restarted' }; },
        },
      },
    );
    await detectStarted.promise;
    saveHubPermissions({ 'process.stop': false });
    detectGate.release();
    const stopResult = await stopAck.promise;
    await processPending;
    check('a PM2 stop is rechecked immediately before the mutation',
      stopResult?.ok === false && /revoked/i.test(stopResult?.error ?? '')
        && processMutations === 0,
      JSON.stringify({ stopResult, processMutations }));

    // A progress event deferred by the rate limit must not flush after the
    // capability that authorized it has gone away.
    let progressAllowed = true;
    const progressEvents = [];
    const progress = agent.createCommandProgress('progress-race', {
      isAllowed: () => progressAllowed,
      isConnected: () => true,
      emit: (payload) => progressEvents.push(payload),
    });
    for (let index = 0; index < 6; index++) {
      progress(`step-${index}`, 'running', `PROGRESS_SENTINEL_${index}`);
    }
    progressAllowed = false;
    await sleep(1_100);
    check('queued command progress is rechecked when the throttle timer fires',
      progressEvents.length === 5
        && !progressEvents.some((event) => /PROGRESS_SENTINEL_5/.test(event.detail ?? '')),
      JSON.stringify(progressEvents));

    // Revoking and then re-granting the same permission must not make queued
    // progress from the old authorization eligible to flush. The revision is
    // the durable evidence that the authority changed in between.
    let progressRevision = 7;
    const revisionEvents = [];
    const revisionProgress = agent.createCommandProgress('progress-revision-race', {
      isAllowed: () => true,
      isConnected: () => true,
      getRevision: () => progressRevision,
      emit: (payload) => revisionEvents.push(payload),
    });
    for (let index = 0; index < 6; index++) {
      revisionProgress(`revision-${index}`, 'running', `REVISION_SENTINEL_${index}`);
    }
    progressRevision = 8;
    await sleep(1_100);
    check('queued progress is discarded when the permission revision changes',
      revisionEvents.length === 5
        && !revisionEvents.some((event) => /REVISION_SENTINEL_5/.test(event.detail ?? '')),
      JSON.stringify(revisionEvents));
  } finally {
    saveHubPermissions({
      'nginx.config.edit': false,
      'nginx.reload': false,
      'domains.create': false,
      'ssl.renew': false,
      'deploy.manage': false,
      'deploy.ci': false,
      'process.stop': false,
    });
    clearHubLink();
    agent.stopHubAgent();
  }
}

// ─── 17. A command remains bound to the connection that sent it ─────────────

async function testCommandDeliveryIsConnectionBound() {
  setGroup('17. re-pairing cannot redirect an in-flight command');

  const firstHub = await startTestHub();
  const secondHub = await startTestHub();
  const agent = await import(srcUrl('core/hub/agent.js'));
  const { saveHubLink, clearHubLink, saveHubPermissions } = await import(srcUrl('core/hubLink.js'));
  const started = createGate();
  const release = createGate();
  const REQUEST_ID = 'request-bound-to-old-hub';

  const handler = (payload, ack, { target }) => agent.runCommand(
    'hub:manageDeploy',
    payload,
    async (_body, stillAllowed, context) => {
      const progress = agent.createCommandProgress(payload.requestId, {
        target: context.target,
        isAllowed: () => true,
      });
      progress('before-repair', 'running', 'OLD_HUB_PROGRESS');
      started.release();
      await release.promise;
      progress('after-repair', 'ok', 'OLD_HUB_LATE_PROGRESS');
      stillAllowed();
      return { sentinel: 'OLD_HUB_RESULT' };
    },
    ack,
    { target },
  );

  try {
    saveHubPermissions({ 'deploy.manage': true });
    saveHubLink({ hubUrl: firstHub.url, serverId: SERVER_ID, secret: SECRET });
    agent.initHubAgent({ commandHandlers: { 'hub:manageDeploy': handler } });
    check('the first Hub receives the agent',
      await waitUntil(() => firstHub.live() === 1), `live: ${firstHub.live()}`);

    firstHub.state.socket.emit('hub:manageDeploy', {
      action: 'create',
      requestId: REQUEST_ID,
    });
    await started.promise;

    saveHubLink({ hubUrl: secondHub.url, serverId: SERVER_ID, secret: SECRET });
    agent.initHubAgent({ commandHandlers: { 'hub:manageDeploy': handler } });
    check('re-pairing connects the second Hub',
      await waitUntil(() => secondHub.live() === 1), `live: ${secondHub.live()}`);

    release.release();
    await sleep(1_250);
    check('the old result is not emitted to the newly paired Hub',
      !secondHub.state.results.some((result) => result.requestId === REQUEST_ID),
      JSON.stringify(secondHub.state.results));
    check('late progress is not emitted to the newly paired Hub',
      !secondHub.state.progress.some((result) => result.requestId === REQUEST_ID),
      JSON.stringify(secondHub.state.progress));
  } finally {
    saveHubPermissions({ 'deploy.manage': false });
    clearHubLink();
    agent.stopHubAgent();
    await Promise.all([firstHub.close(), secondHub.close()]);
  }
}

// ─── 18. Progress invalidation through the real command transport ───────────

async function testDeferredProgressRevisionOverSocket() {
  setGroup('18. a deploy command cannot flush progress across revoke/regrant');

  const hub = await startTestHub();
  const agent = await import(srcUrl('core/hub/agent.js'));
  const { saveHubLink, clearHubLink, saveHubPermissions } = await import(srcUrl('core/hubLink.js'));
  const REQUEST_ID = 'request-progress-revision';

  const handler = (payload, ack, { target }) => agent.runCommand(
    'hub:manageDeploy',
    payload,
    async (_body, stillAllowed, context) => {
      const progress = agent.createCommandProgress(payload.requestId, {
        target: context.target,
        isAllowed: () => true,
      });
      for (let index = 0; index < 6; index += 1) {
        progress(`revision-step-${index}`, 'running', `REVISION_SOCKET_SENTINEL_${index}`);
      }
      saveHubPermissions({ 'deploy.manage': false });
      saveHubPermissions({ 'deploy.manage': true });
      await sleep(1_150);
      stillAllowed();
      return { completed: true };
    },
    ack,
    { target },
  );

  try {
    saveHubPermissions({ 'deploy.manage': true });
    saveHubLink({ hubUrl: hub.url, serverId: SERVER_ID, secret: SECRET });
    agent.initHubAgent({ commandHandlers: { 'hub:manageDeploy': handler } });
    check('the agent connects for the progress revision test',
      await waitUntil(() => hub.live() === 1), `live: ${hub.live()}`);

    hub.state.socket.emit('hub:manageDeploy', {
      action: 'create',
      requestId: REQUEST_ID,
    });
    check('the command completes after the temporary revoke',
      await waitUntil(() => hub.state.results.some((result) => result.requestId === REQUEST_ID)),
      JSON.stringify(hub.state.results));

    const events = hub.state.progress.filter((event) => event.requestId === REQUEST_ID);
    check('only the five events authorized before the revision change arrive',
      events.length === 5, JSON.stringify(events));
    check('the queued sixth event is discarded after revoke and re-grant',
      !events.some((event) => /REVISION_SOCKET_SENTINEL_5/.test(event.detail ?? '')),
      JSON.stringify(events));
  } finally {
    saveHubPermissions({ 'deploy.manage': false });
    clearHubLink();
    agent.stopHubAgent();
    await hub.close();
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nHub agent: exactly one socket per process\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testIdempotentInit();
  await testOneDaemonOneSocket();
  await testPairingReachesOwner();
  await testDashboardDefers();
  await testDashboardHoldsWhenAlone();
  await testReconcileIsQuiet();
  await testSaveConfigReloadGate();
  await testSaveConfigDispatch();
  await testCommandAcknowledgement();
  await testCommandProgress();
  await testSslCommandProgress();
  await testRenewAllProgressDomains();
  await testDomainCertStatus();
  await testDomainCertificateDeletionSafety();
  await testHubTelemetryProjection();
  await testDelayedHubPermissionRevocation();
  await testRevocationAtMutationBoundaries();
  await testHandoverIsExclusive();
  await testCommandDeliveryIsConnectionBound();
  await testDeferredProgressRevisionOverSocket();

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` — ${f.detail}` : ''}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
