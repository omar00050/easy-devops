/**
 * Tests for the daemon: job ownership and hand-over, the event bus, and the
 * local IPC channel.
 *
 * Run with:  npm run test:e2e -- daemon
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * The question this suite answers is the one the whole design turns on: that
 * the background jobs run in EXACTLY ONE process, and that ownership moves
 * when a daemon appears or goes away. The duplicate-notification half of that
 * guarantee is covered in notifications.test.mjs, which races real processes
 * through the claim; here the subject is the election itself.
 *
 * Everything is confined to the temporary data directory the runner provides.
 * The config is pointed at a non-existent nginx directory on purpose, so a
 * monitor tick cannot invoke the real nginx on the machine running the tests.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
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

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Waits for a condition, so a timing test does not depend on a fixed sleep. */
async function waitUntil(fn, { timeoutMs = 5_000, everyMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(everyMs);
  }
  return false;
}

/**
 * Points the config at directories that do not exist, so a monitor tick
 * cannot reach the real nginx or the real certificate store. Without this the
 * job tests would run `nginx -v` against whatever is installed on the machine.
 */
async function isolateConfig() {
  const { dbSet } = await import(srcUrl('core/db.js'));
  const nowhere = path.join(TEST_DATA_DIR, 'no-such-nginx');
  dbSet('config', {
    nginxDir: nowhere,
    sslDir: path.join(TEST_DATA_DIR, 'no-such-ssl'),
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: '',
    os: process.platform,
  });
  // Nothing to probe: a domain list would make checkDomainHealth open sockets.
  dbSet('domains', []);
  return nowhere;
}

// ─── A child process that holds the daemon lock ──────────────────────────────

const HOLDER_CHILD = `
const [lockModule, dataDir] = process.argv.slice(2);
const lock = await import(lockModule);

const got = lock.acquire({ dataDir, version: 'test-holder', mode: 'daemon' });
if (!got.ok) {
  process.stdout.write('REFUSED:' + got.reason);
  process.exit(2);
}

// Keep the heartbeat fresh, exactly as a real daemon does, so the lock reads
// as live rather than merely present.
const beat = setInterval(() => lock.heartbeat({ dataDir, mode: 'daemon' }), 1000);

process.stdout.write('HOLDING:' + process.pid + '\\n');

const release = () => { clearInterval(beat); lock.release({ dataDir }); process.exit(0); };
process.on('SIGTERM', release);
process.on('SIGINT', release);
// Windows has no real SIGTERM delivery for a killed process, so the parent also
// accepts "the pid is gone" as a release; see the stale-lock path in lock.js.
`;

function writeChild(name, body) {
  const dir = path.join(TEST_DATA_DIR, 'children');
  assertInsideTestDataDir(dir, 'write a child script');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/** Starts a process that holds the lock, and resolves once it really does. */
async function startLockHolder(dataDir) {
  const file = writeChild('lock-holder.mjs', HOLDER_CHILD);
  const child = spawn(process.execPath, [file, srcUrl('core/daemon/lock.js'), dataDir], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });

  const up = await waitUntil(() => out.includes('HOLDING:'));
  if (!up) {
    child.kill();
    throw new Error(`lock holder never started: ${out || err}`);
  }

  return {
    pid: child.pid,
    async stop() {
      child.kill();
      await once(child, 'exit').catch(() => {});
    },
  };
}

// ─── 1. The bus ───────────────────────────────────────────────────────────────

async function testBus() {
  setGroup('1. job bus');

  const bus = await import(srcUrl('core/jobs/bus.js'));

  const seen = [];
  const off = bus.subscribe('nginx:status', (p) => seen.push(p));
  bus.publish('nginx:status', { running: true });
  check('a subscriber receives its event', seen.length === 1 && seen[0].running === true);

  off();
  bus.publish('nginx:status', { running: false });
  check('unsubscribe stops delivery', seen.length === 1);

  const all = [];
  const offAll = bus.subscribeAll((event, payload) => all.push([event, payload]));
  bus.publish('domain:health', [{ name: 'a', up: true }]);
  bus.publish('notification:new', { id: 'x' });
  check('subscribeAll receives every event with its name', all.length === 2
    && all[0][0] === 'domain:health' && all[1][0] === 'notification:new');

  // A listener that throws must not stop the monitor that published.
  bus.subscribe('local:changed', () => { throw new Error('bad listener'); });
  let threw = false;
  try {
    bus.publish('local:changed', { section: 'domains' });
  } catch {
    threw = true;
  }
  check('a throwing listener does not propagate to the publisher', threw === false);

  offAll();
  bus.clearAll();
  check('clearAll removes every listener', bus.listenerCount('nginx:status') === 0);

  check('JOB_EVENTS matches the contract names', JSON.stringify(bus.JOB_EVENTS) ===
    JSON.stringify(['nginx:status', 'domain:health', 'notification:new', 'local:changed', 'service:changed', 'hub:agentState']));
  check('logs:line is deliberately NOT a job event', !bus.JOB_EVENTS.includes('logs:line'));
}

// ─── 2. Ownership: the daemon role ────────────────────────────────────────────

async function testDaemonRole() {
  setGroup('2. ownership — daemon role');

  const { startJobs } = await import(srcUrl('core/jobs/index.js'));
  const lock = await import(srcUrl('core/daemon/lock.js'));
  const dataDir = scratch('jobs-daemon');

  await isolateConfig();

  const bad = (() => {
    try {
      startJobs({ role: 'nonsense', dataDir });
      return null;
    } catch (err) {
      return err.message;
    }
  })();
  check('an unknown role is refused', typeof bad === 'string' && /role must be/.test(bad), bad ?? '');

  const jobs = startJobs({ role: 'daemon', dataDir, version: '9.9.9', hub: false, intervals: { nginx: 60_000, domains: 60_000, certs: 60_000 } });

  // The lock is taken synchronously — that is what an open dashboard watches
  // for — but the JOBS are deliberately deferred until the previous owner has
  // released them. ready() resolves once that hand-over is done.
  check('the daemon takes the lock immediately', lock.readLock(dataDir)?.pid === process.pid);
  check('the lock records the version', lock.readLock(dataDir)?.version === '9.9.9');
  await jobs.ready();
  check('the daemon takes the lock and runs the jobs', jobs.ok !== false && jobs.state().running === true);
  check('the daemon reports itself as the owner', jobs.state().role === 'daemon');

  // A second daemon in this same process would be the same pid, which the lock
  // treats as a re-acquire. The real case is another process, so that is what
  // the test uses.
  await jobs.stop();
  check('stopping releases the lock', lock.readLock(dataDir) === null);

  const holder = await startLockHolder(dataDir);
  try {
    const refused = startJobs({ role: 'daemon', dataDir, hub: false });
    check('a second daemon is refused while another holds the lock', refused.ok === false, refused.reason);
    check('the refusal names the holder', refused.lock?.pid === holder.pid);
  } finally {
    await holder.stop();
  }
}

// ─── 3. Ownership: the dashboard standby and the hand-over ───────────────────
async function testHandover() {
  setGroup('3. ownership — hand-over in both directions');

  const { startJobs } = await import(srcUrl('core/jobs/index.js'));
  const lock = await import(srcUrl('core/daemon/lock.js'));
  const dataDir = scratch('jobs-handover');

  await isolateConfig();

  const changes = [];
  const jobs = startJobs({
    role: 'dashboard',
    dataDir,
    hub: false,
    pollMs: 150,
    intervals: { nginx: 60_000, domains: 60_000, certs: 60_000 },
    onChange: (s) => changes.push({ running: s.running, reason: s.reason }),
  });

  check('a dashboard with no daemon runs the jobs itself', jobs.state().running === true, jobs.state().reason);
  check('a dashboard does NOT take the lock', lock.readLock(dataDir) === null);
  check('the first ownership change was announced', changes.length >= 1 && changes[0].running === true);

  // ── A daemon appears ──────────────────────────────────────────────────────
  const holder = await startLockHolder(dataDir);

  const stopped = await waitUntil(() => jobs.state().running === false, { timeoutMs: 4_000 });
  check('the dashboard stops within a poll of a daemon appearing', stopped, jobs.state().reason);
  check('the reason names the daemon', /daemon is running/.test(jobs.state().reason), jobs.state().reason);
  check('standing down was announced', changes.some((c) => c.running === false));

  // ── The daemon goes away ──────────────────────────────────────────────────
  await holder.stop();

  // The lock may survive the kill; it is recovered once it goes stale, which
  // is the real-world crash path. Removing it here is the clean-stop path.
  try { fs.unlinkSync(lock.lockPath(dataDir)); } catch { /* already released */ }

  const resumed = await waitUntil(() => jobs.state().running === true, { timeoutMs: 4_000 });
  check('the dashboard picks the jobs back up when the daemon goes', resumed, jobs.state().reason);
  check('both directions were announced', changes.filter((c) => c.running).length >= 2);

  await jobs.stop();
  check('stopping a dashboard runner leaves no lock behind', lock.readLock(dataDir) === null);
  check('a stopped runner reports not running', jobs.state().running === false);

  // ── A stale lock must not keep a dashboard idle for ever ──────────────────
  const staleDir = scratch('jobs-stale');
  const longAgo = Date.now() - lock.STALE_AFTER_MS - 60_000;
  fs.writeFileSync(
    lock.lockPath(staleDir),
    `${JSON.stringify({ pid: 0x7ffffffe, startedAt: longAgo, heartbeatAt: longAgo, version: null, mode: 'daemon' })}\n`,
  );

  const onStale = startJobs({
    role: 'dashboard', dataDir: staleDir, hub: false, pollMs: 150,
    intervals: { nginx: 60_000, domains: 60_000, certs: 60_000 },
  });
  check('a dashboard runs the jobs despite a stale lock file', onStale.state().running === true, onStale.state().reason);
  await onStale.stop();
}

// ─── 3b. The lock is atomic across real processes ─────────────────────────────

/**
 * A child that waits for a shared "go" file and then tries to take the same
 * lock as every other child. The wait is what makes the attempt simultaneous:
 * spawning them in a loop alone would stagger the attempts enough that the
 * race could resolve without ever contending.
 *
 * `kind` selects the module's acquisition call, so the same child races both
 * the daemon lock (acquire/readLock) and the jobs marker (claim/readOwner).
 */
const RACE_CHILD = `
const [modUrl, dataDir, readyFile, goFile, kind] = process.argv.slice(2);
const fs = await import('node:fs');
const mod = await import(modUrl);

fs.writeFileSync(readyFile, String(process.pid));

const deadline = Date.now() + 15000;
while (!fs.existsSync(goFile) && Date.now() < deadline) { /* brief spin */ }

const got = kind === 'owner'
  ? mod.claim({ dataDir, role: 'dashboard' })
  : mod.acquire({ dataDir, version: 'race', mode: 'daemon' });

// Read back what is on disk NOW. "Won" only counts when the file names this
// process: an acquisition taken away from under us is not one this process may
// act on, and saying so is what turns a double takeover into a visible failure.
const held = kind === 'owner' ? mod.readOwner(dataDir) : mod.readLock(dataDir);

const verdict = !got.ok
  ? 'LOST:' + got.reason
  : (held && held.pid === process.pid ? 'WON:' + process.pid : 'CLAIMED-BUT-NOT-HELD');

process.stdout.write(verdict + '\\n');
process.exit(0);
`;

/**
 * A pid that cannot exist. Spawning a process and letting it exit does not give
 * one: Windows reuses pids so aggressively that one of the racers below can be
 * handed the "dead" pid, which makes the planted lock read as live and leaves
 * the whole race refusing for a reason that has nothing to do with the lock.
 * 0x7ffffffe is used for the same purpose in cleanup.test.mjs.
 */
const DEAD_PID = 0x7ffffffe;

let raceSeq = 0;

/**
 * Starts `count` real processes that all try to acquire the same lock at the
 * same instant, and reports what each of them said.
 *
 * `kind` is 'lock' (daemon lock) or 'owner' (jobs marker); `dataDir` is
 * prepared by the caller — empty for a create race, or holding a planted stale
 * lock for a takeover race.
 *
 * @returns {Promise<{ allReady: boolean, racers: Array<Object>,
 *                     winners: Array<Object>, losers: Array<Object>,
 *                     unheld: Array<Object> }>}
 */
async function raceProcesses({ dataDir, modUrl, kind = 'lock', count = 6 }) {
  const gateDir = scratch(`race-gate-${++raceSeq}`);
  const goFile = path.join(gateDir, 'go');
  const childFile = writeChild('lock-race.mjs', RACE_CHILD);

  const racers = [];

  for (let i = 0; i < count; i++) {
    const readyFile = path.join(gateDir, `ready-${i}`);
    const child = spawn(
      process.execPath,
      [childFile, modUrl, dataDir, readyFile, goFile, kind],
      { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );

    const racer = { child, out: '', readyFile };
    child.stdout.on('data', (d) => { racer.out += d; });
    child.stderr.on('data', (d) => { racer.out += d; });
    // 'close', not 'exit': exit fires while the pipes may still hold the
    // child's verdict, which would make a winner look like a non-responder.
    racer.done = once(child, 'close').catch(() => {});
    racers.push(racer);
  }

  const allReady = await waitUntil(
    () => racers.every((r) => fs.existsSync(r.readyFile)),
    { timeoutMs: 15_000 },
  );

  // The starting gun: all of them open the lock within milliseconds of each
  // other, so the acquisition really is contended.
  fs.writeFileSync(goFile, 'go');

  await Promise.all(racers.map((r) => r.done));

  return {
    allReady,
    racers,
    winners: racers.filter((r) => r.out.includes('WON:')),
    losers: racers.filter((r) => r.out.includes('LOST:')),
    unheld: racers.filter((r) => r.out.includes('CLAIMED-BUT-NOT-HELD')),
  };
}

/** Kills any racer that survived (none should: each exits after reporting). */
function killRacers(racers) {
  for (const racer of racers) {
    if (isAlivePid(racer.child.pid)) racer.child.kill();
  }
}

/**
 * One race must produce exactly one winner, nobody who "won" and then found
 * the lock gone, and a file on disk naming the winner.
 */
function assertSingleWinner(race, readHeld, { label, count = 6 }) {
  check(`exactly one process acquires the ${label}`, race.winners.length === 1,
    `${race.winners.length} won, ${race.losers.length} lost`);
  check(`every other process is refused the ${label}`, race.losers.length === count - 1,
    race.losers.map((r) => r.out.trim()).join(' | ').slice(0, 200));
  check(`no process reports success without holding the ${label}`, race.unheld.length === 0,
    race.unheld.map((r) => r.out.trim()).join(' | '));

  const held = readHeld();
  check(`the ${label} on disk names the winner`,
    Boolean(held) && race.winners.length === 1 && held.pid === race.winners[0].child.pid,
    `pid on disk ${held?.pid}, winner ${race.winners[0]?.child.pid}`);
}

/**
 * Acquisition is atomic, so N processes starting at once must produce exactly
 * one winner. The old implementation checked inspect() first and then renamed
 * a temp file into place — a window in which every process saw "no lock" and
 * every process wrote one.
 *
 * The second and third races are the harder case: with a STALE lock already
 * on disk, every process is entitled to recover it, so an unlink-by-belief
 * takeover lets one process delete another's brand-new lock. Exactly one may
 * still win.
 *
 * These are real child processes, because an in-process test cannot race a
 * synchronous filesystem call. Each child owns its own pid, and none of them
 * outlives the assertion.
 */
async function testLockRace() {
  setGroup('3b. the lock is exclusive across real processes');

  const lock = await import(srcUrl('core/daemon/lock.js'));
  const owner = await import(srcUrl('core/jobs/owner.js'));

  // ── 1. An empty directory: exactly one create may succeed ────────────────
  const emptyDir = scratch('lock-race');
  const emptyRace = await raceProcesses({ dataDir: emptyDir, modUrl: srcUrl('core/daemon/lock.js') });
  check('every racer is waiting at the same moment', emptyRace.allReady, `${emptyRace.racers.length} child(ren)`);
  assertSingleWinner(emptyRace, () => lock.readLock(emptyDir), { label: 'lock' });
  killRacers(emptyRace.racers);
  fs.rmSync(lock.lockPath(emptyDir), { force: true });

  // ── 2. A planted STALE lock: still exactly one may take it over ──────────
  const staleDir = scratch('lock-race-takeover');
  const stalePid = DEAD_PID;
  const longAgo = Date.now() - lock.STALE_AFTER_MS - 60_000;
  fs.writeFileSync(
    lock.lockPath(staleDir),
    `${JSON.stringify({ pid: stalePid, startedAt: longAgo, heartbeatAt: longAgo, version: null, mode: 'daemon' })}\n`,
  );

  const takeoverRace = await raceProcesses({ dataDir: staleDir, modUrl: srcUrl('core/daemon/lock.js') });
  check('the racers started over a stale lock', takeoverRace.allReady, `${takeoverRace.racers.length} child(ren)`);
  assertSingleWinner(takeoverRace, () => lock.readLock(staleDir), { label: 'stale lock' });
  check('the recovered lock belongs to the winner, not the dead pid',
    lock.readLock(staleDir)?.pid !== stalePid, String(lock.readLock(staleDir)?.pid));
  killRacers(takeoverRace.racers);
  fs.rmSync(lock.lockPath(staleDir), { force: true });

  // ── 3. The same race for the jobs marker ─────────────────────────────────
  const ownerDir = scratch('owner-race-takeover');
  fs.writeFileSync(
    owner.ownerPath(ownerDir),
    `${JSON.stringify({ pid: stalePid, role: 'dashboard', at: longAgo, heartbeatAt: longAgo })}\n`,
  );

  const ownerRace = await raceProcesses({
    dataDir: ownerDir,
    modUrl: srcUrl('core/jobs/owner.js'),
    kind: 'owner',
  });
  check('the owner racers started over a stale marker', ownerRace.allReady, `${ownerRace.racers.length} child(ren)`);
  assertSingleWinner(ownerRace, () => owner.readOwner(ownerDir), { label: 'jobs marker' });
  killRacers(ownerRace.racers);
  fs.rmSync(owner.ownerPath(ownerDir), { force: true });

  // ── 3c. A half-written file must not block acquisition for ever ─────────
  //
  // A crash between creating the file and writing it leaves a truncated one.
  // It has no readable owner, so it is abandoned: recovered through the guard
  // rather than waited on for ever.
  const brokenDir = scratch('lock-broken');
  fs.writeFileSync(lock.lockPath(brokenDir), '{"pid":12');
  const brokenLock = lock.acquire({ dataDir: brokenDir, version: 'broken', mode: 'daemon' });
  check('a half-written lock is recovered, not waited on', brokenLock.ok === true,
    brokenLock.ok === false ? brokenLock.reason : '');
  lock.release({ dataDir: brokenDir });

  const brokenOwnerDir = scratch('owner-broken');
  fs.writeFileSync(owner.ownerPath(brokenOwnerDir), '{"pid":12');
  const brokenOwner = owner.claim({ dataDir: brokenOwnerDir, role: 'dashboard' });
  check('a half-written jobs marker is recovered too', brokenOwner.ok === true,
    brokenOwner.ok === false ? brokenOwner.reason : '');
  owner.release({ dataDir: brokenOwnerDir });

  // ── 3d. An EMPTY file just created is a create in flight ─────────────────
  //
  // `writeFileSync(..., { flag: 'wx' })` creates the path and then writes it, so
  // a brand-new lock is briefly empty. That must not be mistaken for a crash.
  const inFlightDir = scratch('lock-empty');
  fs.writeFileSync(lock.lockPath(inFlightDir), '');
  const freshEmpty = lock.acquire({ dataDir: inFlightDir, version: 'fresh', mode: 'daemon' });
  check('an empty lock just created is NOT taken over', freshEmpty.ok === false,
    freshEmpty.ok === true ? 'stolen' : freshEmpty.reason);

  const old = new Date(Date.now() - 5_000);
  fs.utimesSync(lock.lockPath(inFlightDir), old, old);
  const oldEmpty = lock.acquire({ dataDir: inFlightDir, version: 'old', mode: 'daemon' });
  check('the same empty lock with an old mtime IS recovered', oldEmpty.ok === true,
    oldEmpty.ok === false ? oldEmpty.reason : `recovered=${oldEmpty.recovered}`);
  lock.release({ dataDir: inFlightDir });

  // ── 4. Stale recovery still works, and a re-acquire stays idempotent ─────
  const recoverDir = scratch('lock-race-stale');
  fs.writeFileSync(
    lock.lockPath(recoverDir),
    `${JSON.stringify({ pid: stalePid, startedAt: longAgo, heartbeatAt: longAgo, version: null, mode: 'daemon' })}\n`,
  );

  const recovered = lock.acquire({ dataDir: recoverDir, version: 'recover', mode: 'daemon' });
  check('a stale lock is recovered', recovered.ok === true && recovered.recovered === true,
    recovered.ok === false ? recovered.reason : `recovered=${recovered.recovered}`);
  check('and the recovered lock is ours', lock.readLock(recoverDir)?.pid === process.pid);

  const again = lock.acquire({ dataDir: recoverDir, version: 'recover', mode: 'daemon' });
  check('re-acquiring as the same pid is idempotent',
    again.ok === true && again.recovered === false,
    again.ok === false ? again.reason : `recovered=${again.recovered}`);

  lock.release({ dataDir: recoverDir });
  check('releasing leaves no lock behind', lock.readLock(recoverDir) === null);
}

/** Signal-0 liveness check, local to this suite. */
function isAlivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ─── 4. IPC ───────────────────────────────────────────────────────────────────

async function testIpc() {
  setGroup('4. IPC event channel');

  const { startIpcServer, connectToDaemon } = await import(srcUrl('core/daemon/ipc.js'));
  const bus = await import(srcUrl('core/jobs/bus.js'));
  const { daemonIpcPath } = await import(srcUrl('core/platform.js'));
  const dataDir = scratch('ipc');

  bus.clearAll();

  const server = await startIpcServer({
    dataDir,
    hello: () => ({ version: '1.2.3', pid: process.pid, startedAt: 1 }),
  });
  check('the server listens on the platform path', server.path === daemonIpcPath(dataDir), server.path);

  const received = [];
  const client = connectToDaemon({
    dataDir,
    onEvent: (event, payload) => received.push([event, payload]),
  });

  const connected = await waitUntil(() => client.connected());
  check('a client connects', connected);
  check('the server counts it', await waitUntil(() => server.clients() === 1));

  const gotHello = await waitUntil(() => received.some(([e]) => e === 'daemon:hello'));
  check('the client receives the hello frame', gotHello);
  check('hello carries the daemon identity',
    received.find(([e]) => e === 'daemon:hello')?.[1]?.version === '1.2.3');

  // A job runner started by an earlier section can still have a probe in
  // flight when this one begins, and its late publish lands in `received` like
  // any other frame. Only frames after this point are this assertion's
  // business, or the test races the previous section's cleanup.
  const beforeStatus = received.length;

  // A bus event in the server's process must reach the client unchanged.
  //
  // Identified by its payload rather than by being the first frame of that
  // name: a monitor tick from the previous section can still be in flight and
  // publish its own `nginx:status` after `beforeStatus`.
  const ours = ([event, payload]) => event === 'nginx:status' && payload?.pid === 42;
  bus.publish('nginx:status', { running: true, version: 'nginx/1.2.3', pid: 42 });
  const gotStatus = await waitUntil(() =>
    received.slice(beforeStatus).some(ours));
  check('a published event reaches the client', gotStatus);
  const status = received.slice(beforeStatus).find(ours)?.[1];
  check('the payload is unchanged', status?.running === true && status?.pid === 42
    && status?.version === 'nginx/1.2.3', JSON.stringify(status ?? null));

  // Several frames in flight must not be merged or split: this is what the
  // newline framing is for, and a large payload is where it would break.
  const big = Array.from({ length: 200 }, (_, i) => ({ name: `d${i}.example.com`, up: i % 2 === 0, port: 3000 + i }));
  const beforeBurst = received.length;
  bus.publish('domain:health', big);
  bus.publish('notification:new', { id: 'n1', type: 'domain_health' });
  const gotBoth = await waitUntil(() => {
    const burst = received.slice(beforeBurst);
    return burst.some(([e]) => e === 'domain:health') && burst.some(([e]) => e === 'notification:new');
  });
  check('a large frame and the one after it both arrive whole', gotBoth);
  check('the large payload survived intact',
    received.slice(beforeBurst).find(([e]) => e === 'domain:health')?.[1]?.length === 200);

  client.close();
  await server.close();

  // ── The client's frame filter ─────────────────────────────────────────────
  //
  // An event name the contract does not know must be dropped at this boundary,
  // because the dashboard forwards whatever arrives straight to the browser.
  // The bus cannot be used to test this — it only carries JOB_EVENTS, so an
  // unknown name never reaches the wire. A raw server is the only way to put
  // one there, which is also the only way it could really happen: something
  // other than our daemon on the other end of the pipe.
  const rawDir = scratch('ipc-raw');
  const rawPath = daemonIpcPath(rawDir);
  const net = await import('node:net');

  const raw = net.createServer((socket) => {
    socket.write(`${JSON.stringify({ event: 'definitely:not:a:contract:event', payload: { x: 1 } })}\n`);
    socket.write('this line is not JSON at all\n');
    socket.write(`${JSON.stringify({ event: 'nginx:status', payload: { running: true, marker: 'raw' } })}\n`);
  });
  await new Promise((resolve, reject) => {
    raw.once('error', reject);
    raw.listen(rawPath, () => { raw.removeListener('error', reject); resolve(); });
  });

  const rawSeen = [];
  const rawClient = connectToDaemon({ dataDir: rawDir, onEvent: (e, p) => rawSeen.push([e, p]) });

  const gotGood = await waitUntil(() => rawSeen.some(([, p]) => p?.marker === 'raw'));
  check('a known event after the bad frames still arrives', gotGood);
  check('an unknown event name is not delivered',
    !rawSeen.some(([e]) => e === 'definitely:not:a:contract:event'),
    rawSeen.map(([e]) => e).join(','));
  check('a malformed line is skipped rather than fatal', rawSeen.length === 1, `${rawSeen.length} event(s)`);

  rawClient.close();
  await new Promise((resolve) => raw.close(resolve));
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(rawPath); } catch { /* already gone */ }
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────
  const reconnectDir = scratch('ipc-reconnect');
  const seen = [];
  const statuses = [];
  const retrying = connectToDaemon({
    dataDir: reconnectDir,
    onEvent: (e, p) => seen.push([e, p]),
    onStatus: (c) => statuses.push(c),
  });

  check('a client with no daemon is simply not connected', retrying.connected() === false);

  const later = await startIpcServer({ dataDir: reconnectDir, hello: () => ({ version: 'late' }) });
  const reconnected = await waitUntil(() => retrying.connected(), { timeoutMs: 8_000 });
  check('a client connects once a daemon appears', reconnected);
  check('the late hello arrives', await waitUntil(() => seen.some(([e]) => e === 'daemon:hello')));

  await later.close();
  const noticed = await waitUntil(() => retrying.connected() === false, { timeoutMs: 4_000 });
  check('a client notices the daemon going away', noticed);
  check('status changes were reported in order', statuses.includes(true) && statuses.at(-1) === false);

  retrying.close();
  bus.clearAll();
}

// ─── 5. The daemon as a whole ─────────────────────────────────────────────────

async function testDaemonLifecycle() {
  setGroup('5. startDaemon');

  const { startDaemon } = await import(srcUrl('core/daemon/run.js'));
  const lock = await import(srcUrl('core/daemon/lock.js'));
  const bus = await import(srcUrl('core/jobs/bus.js'));
  const dataDir = scratch('daemon-run');

  await isolateConfig();
  bus.clearAll();

  const lines = [];
  const daemon = await startDaemon({
    dataDir,
    hub: false,
    intervals: { nginx: 60_000, domains: 60_000, certs: 60_000 },
    log: (l) => lines.push(l),
  });

  check('the daemon starts', daemon.ok === true, daemon.ok === false ? daemon.reason : '');
  check('it holds the lock', lock.isDaemonRunning({ dataDir }) === true);
  check('it reports an event channel', typeof daemon.ipcPath === 'string' && daemon.ipcPath.length > 0);
  check('it printed the data directory', lines.some((l) => l.includes(dataDir)));
  check('it printed its pid', lines.some((l) => l.includes(String(process.pid))));
  check('its state says it owns the jobs', daemon.state().running === true);

  // A second daemon against the same directory, from another process.
  const holderDir = scratch('daemon-run-2');
  const holder = await startLockHolder(holderDir);
  const second = await startDaemon({ dataDir: holderDir, hub: false, log: () => {} });
  check('a second daemon refuses to start', second.ok === false, second.ok === false ? second.reason : '');
  await holder.stop();

  await daemon.stop();
  check('stopping releases the lock', lock.readLock(dataDir) === null);
  check('stop is idempotent', await (async () => { await daemon.stop(); return true; })());

  // The IPC socket must not be left behind on a clean stop, or the next start
  // has to decide whether an existing socket means a running daemon.
  if (process.platform !== 'win32') {
    check('the socket file is removed', fs.existsSync(daemon.ipcPath) === false);
  } else {
    check('the socket file is removed', true, 'skipped: named pipes vanish with the process');
  }

  bus.clearAll();
}

// ─── 6. Console and log output stays ASCII ────────────────────────────────────

/**
 * Why this is a test and not a style preference.
 *
 * The daemon's output lands in three places that are not a modern terminal: a
 * Windows console in the legacy OEM code page (where "…" and "—" render as
 * mojibake or "?"), a WinSW-captured log file, and the Startup-folder
 * supervisor's redirect. "Stopping…" came out as "Stopping??" there. So every
 * line the daemon prints, and every output string on the daemon's code path,
 * must stay inside ASCII.
 *
 * Checked two ways, because neither alone is enough: the runtime half proves
 * the lines an actual start/stop emits are clean, and the static half catches
 * the branches a test does not reach (an error path, a lost lock).
 */

/** Characters a legacy Windows console cannot render. */
function nonAscii(text) {
  return [...String(text)].filter((c) => c.charCodeAt(0) > 126);
}

/**
 * Source with comments removed, so a decorative divider in a header comment is
 * not mistaken for program output. The `//` rule skips `://` so a URL inside
 * a string survives.
 */
function codeOnly(source) {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

async function testAsciiOutput() {
  setGroup('6. output is ASCII-only');

  const { startDaemon } = await import(srcUrl('core/daemon/run.js'));
  const bus = await import(srcUrl('core/jobs/bus.js'));
  const dataDir = scratch('daemon-ascii');

  await isolateConfig();
  bus.clearAll();

  const lines = [];
  const daemon = await startDaemon({
    dataDir,
    hub: false,
    intervals: { nginx: 60_000, domains: 60_000, certs: 60_000 },
    log: (l) => lines.push(l),
  });

  check('the daemon started', daemon.ok === true, daemon.ok === false ? daemon.reason : '');

  // Stop inside the capture: "Stopping..." was the line that was wrong.
  await daemon.stop();
  bus.clearAll();

  check('it printed something to check', lines.length > 0, `${lines.length} line(s)`);

  const dirty = lines.filter((l) => nonAscii(l).length > 0);
  check(
    'every line the daemon printed is ASCII',
    dirty.length === 0,
    dirty.length ? `${dirty[0]} -> ${nonAscii(dirty[0]).join(' ')}` : '',
  );

  check(
    'the stop line is plain dots, not an ellipsis',
    lines.includes('Stopping...'),
    lines.filter((l) => l.startsWith('Stop')).join(' | '),
  );

  // The static half: every output string on the daemon's path, including the
  // branches this run did not take.
  const onPath = [
    'core/daemon/run.js',
    'core/daemon/ipc.js',
    'core/daemon/lock.js',
    'core/daemon/stopRequest.js',
    'core/jobs/index.js',
    'core/jobs/bus.js',
    'core/jobs/owner.js',
    'core/hub/agent.js',
    // The daemon prints the first-run setup code to the service log, so its
    // lines are daemon output too.
    'core/setupCode.js',
  ];

  const offenders = [];
  for (const rel of onPath) {
    const file = path.join(ROOT, 'src', rel);
    if (!fs.existsSync(file)) { offenders.push(`${rel}: missing`); continue; }
    codeOnly(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      const bad = nonAscii(line);
      if (bad.length) offenders.push(`${rel}:${i + 1} ${bad.join(' ')}`);
    });
  }

  check(
    'no non-ASCII character in any output string on the daemon path',
    offenders.length === 0,
    offenders.slice(0, 4).join('; '),
  );
}

// ─── 7. The browser hears about the service state ─────────────────────────────

/**
 * `service:changed` is the event an open tab needs most, because it is the one
 * the user cannot discover any other way: the background service appearing or
 * going away changes who owns the jobs, and until this event existed the tab
 * only found out on its next 15-second poll.
 *
 * The dashboard side is what is tested here — the bridge in
 * dashboard/lib/daemonBridge.js, which publishes onto this process's job bus.
 * From there dashboard/socketManager.js forwards and caches it; that half is
 * covered end-to-end in dashboard-auth.test.mjs, where a real socket connects
 * to a real server and must be told the state on connect.
 */

async function testServiceChangedEvent() {
  setGroup('7. service:changed reaches the bus');

  const bus = await import(srcUrl('core/jobs/bus.js'));
  const bridgeMod = await import(srcUrl('dashboard/lib/daemonBridge.js'));
  const lock = await import(srcUrl('core/daemon/lock.js'));
  const dataDir = scratch('service-changed');

  await isolateConfig();
  bus.clearAll();

  const seen = [];
  const unsubscribe = bus.subscribe('service:changed', (payload) => seen.push(payload));

  const bridge = bridgeMod.startDaemonBridge({ dataDir });

  // One announcement immediately, so a tab that opens before anything happens
  // still has a state to render.
  check('starting the bridge announces the current state', seen.length === 1, `${seen.length} event(s)`);
  check('it says no service is running', seen[0]?.running === false, JSON.stringify(seen[0]?.running));
  check(
    'the payload carries the native service fields',
    seen[0] && 'mechanism' in seen[0] && 'installed' in seen[0] && 'stoppedByUser' in seen[0],
    Object.keys(seen[0] ?? {}).join(','),
  );
  check(
    'and the bridge-only connected flag',
    seen[0]?.connected === false,
    JSON.stringify(seen[0]?.connected),
  );

  // Re-announcing an unchanged state must stay silent, or an ordinary restart
  // would flicker the banner once per connect attempt.
  bridge.announce();
  bridge.announce();
  check('an unchanged state is not re-announced', seen.length === 1, `${seen.length} event(s)`);

  // A daemon appears. The 15-second ownership poll must not be what notices:
  // the lock watcher has to, which is why the wait here is short.
  const holder = await startLockHolder(dataDir);
  const announced = await waitUntil(() => seen.some((s) => s.running === true), { timeoutMs: 3_000 });
  check('a starting daemon is announced at once', announced, `${seen.length} event(s)`);

  const running = seen.find((s) => s.running === true);
  check('the announcement carries the daemon pid', running?.pid === holder.pid, String(running?.pid));

  // And it goes away again. The holder is killed rather than signalled, which
  // on Windows leaves the lock file behind: release() deliberately refuses to
  // remove another process's lock, and a lock with a fresh heartbeat still
  // reads as running for the full stale window. So the file is removed here,
  // which is exactly what the holder's own release() would have done.
  await holder.stop();
  if (lock.readLock(dataDir)) fs.unlinkSync(lock.lockPath(dataDir));

  const gone = await waitUntil(
    () => seen.length > 1 && seen.at(-1).running === false,
    { timeoutMs: 3_000 },
  );
  check('a stopped daemon is announced too', gone, JSON.stringify(seen.at(-1)?.running));

  unsubscribe();
  bridgeMod.stopDaemonBridge();
  bus.clearAll();
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nDaemon: ownership, bus and IPC\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testBus();
  await testDaemonRole();
  await testHandover();
  await testLockRace();
  await testIpc();
  await testDaemonLifecycle();
  await testAsciiOutput();
  await testServiceChangedEvent();

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
