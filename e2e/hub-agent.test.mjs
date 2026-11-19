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

  const state = { connects: 0, evictions: 0, rejections: [], events: [], results: [], progress: [], socket: null };
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

  const { saveHubLink, clearHubLink } = await import(srcUrl('core/hubLink.js'));
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
  const { saveHubLink, clearHubLink } = await import(srcUrl('core/hubLink.js'));
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
  saveHubPermissions({ 'deploy.manage': true, 'domains.create': true, 'ssl.issue': true });
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
  await testHandoverIsExclusive();

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
