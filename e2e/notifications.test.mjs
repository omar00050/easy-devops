/**
 * Tests for the daemon lock, the atomic notification claim and the dispatch
 * ordering (evaluate → claim → send → commit).
 *
 * Run with:  npm run test:e2e -- notifications
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * The point of this suite is the part that is impossible to check by reading
 * the code: that two processes racing for the same notification produce exactly
 * one send. Single-process assertions cannot show that, so the race sections
 * spawn REAL child processes against the same temporary data directory and
 * release them from a barrier at the same wall-clock instant.
 *
 * Writes only inside the temporary data directory the runner provides.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
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

/** A sub-directory of the test data dir, so the lock tests cannot collide. */
function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Child runner ─────────────────────────────────────────────────────────────

/**
 * Runs one child script file with the suite's environment inherited, so the
 * children share this run's temporary data directory and nothing else.
 */
async function runChild(file, args = []) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  const [code] = await once(child, 'exit');
  return { code, out: out.trim(), err: err.trim() };
}

/** Writes a child script into the test area and returns its path. */
function writeChild(name, body) {
  const dir = path.join(TEST_DATA_DIR, 'children');
  assertInsideTestDataDir(dir, 'write a child script');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/** Busy-waits to a shared instant so children really do race. */
const BARRIER_SOURCE = `
function waitForBarrier(startAt) {
  const target = Number(startAt);
  // A timer would be enough for a coarse race, but a tight spin is what makes
  // several processes enter the claim within the same millisecond.
  while (Date.now() < target) { /* spin */ }
}
`;

// ─── 1. Daemon lock ───────────────────────────────────────────────────────────

async function testLock() {
  setGroup('1. daemon lock');

  const lock = await import(srcUrl('core/daemon/lock.js'));
  const dataDir = scratch('lock-basic');

  check('no lock on a fresh dir', lock.isDaemonRunning({ dataDir }) === false);
  check('inspect explains why', lock.inspect({ dataDir }).reason === 'no lock file');

  const got = lock.acquire({ dataDir, version: '1.2.3', mode: 'daemon' });
  check('acquire succeeds', got.ok === true && got.recovered === false);
  check('lock file exists', fs.existsSync(lock.lockPath(dataDir)));
  check('lock records our pid', lock.readLock(dataDir).pid === process.pid);
  check('lock records the version', lock.readLock(dataDir).version === '1.2.3');
  check('daemon now reads as running', lock.isDaemonRunning({ dataDir }) === true);

  // Re-acquiring in the same process must be idempotent, not a deadlock.
  const again = lock.acquire({ dataDir });
  check('re-acquire by the owner is allowed', again.ok === true);

  const before = lock.readLock(dataDir).heartbeatAt;
  const beat = lock.heartbeat({ dataDir, now: before + 1000 });
  check('heartbeat returns true for the owner', beat === true);
  check('heartbeat moves the timestamp', lock.readLock(dataDir).heartbeatAt === before + 1000);
  check('heartbeat keeps the original startedAt', lock.readLock(dataDir).startedAt !== before + 1000);

  check('release removes the lock', lock.release({ dataDir }) === true);
  check('lock file is gone', fs.existsSync(lock.lockPath(dataDir)) === false);
  check('release again is false, not a throw', lock.release({ dataDir }) === false);

  // ── A live foreign lock must be refused ────────────────────────────────────
  const liveDir = scratch('lock-live');
  // pid 1 exists on Linux; on Windows use a pid that is certainly alive: ours.
  // Writing our own pid would be read as self-ownership, so the test needs a
  // genuinely foreign live pid — the parent of this process serves, and when
  // that is not available the child-process section below covers the case.
  const foreignPid = process.ppid && process.ppid !== process.pid ? process.ppid : null;
  if (foreignPid) {
    fs.writeFileSync(
      lock.lockPath(liveDir),
      `${JSON.stringify({ pid: foreignPid, startedAt: Date.now(), heartbeatAt: Date.now(), version: null, mode: 'daemon' })}\n`,
    );
    const refused = lock.acquire({ dataDir: liveDir });
    check('acquire refuses a live foreign lock', refused.ok === false, refused.reason);
    check('refusal reports the holder', refused.lock?.pid === foreignPid);
  } else {
    check('acquire refuses a live foreign lock', true, 'skipped: no distinct parent pid');
    check('refusal reports the holder', true, 'skipped');
  }

  // ── A crashed daemon's lock is recovered ───────────────────────────────────
  const staleDir = scratch('lock-stale');
  const deadPid = await findDeadPid();
  const longAgo = Date.now() - lock.STALE_AFTER_MS - 60_000;
  fs.writeFileSync(
    lock.lockPath(staleDir),
    `${JSON.stringify({ pid: deadPid, startedAt: longAgo, heartbeatAt: longAgo, version: null, mode: 'daemon' })}\n`,
  );
  check('a dead pid with an old heartbeat reads as not running', lock.isDaemonRunning({ dataDir: staleDir }) === false);
  check('inspect marks it stale', lock.inspect({ dataDir: staleDir }).stale === true);
  const recovered = lock.acquire({ dataDir: staleDir });
  check('acquire recovers a stale lock', recovered.ok === true && recovered.recovered === true);
  lock.release({ dataDir: staleDir });

  // ── Dead pid but FRESH heartbeat: must NOT be stolen yet ───────────────────
  const freshDir = scratch('lock-fresh-dead');
  fs.writeFileSync(
    lock.lockPath(freshDir),
    `${JSON.stringify({ pid: deadPid, startedAt: Date.now(), heartbeatAt: Date.now(), version: null, mode: 'daemon' })}\n`,
  );
  check(
    'a fresh heartbeat holds the lock even when the pid is gone',
    lock.isDaemonRunning({ dataDir: freshDir }) === true,
  );

  // ── A truncated lock file must not crash a reader ──────────────────────────
  const brokenDir = scratch('lock-broken');
  fs.writeFileSync(lock.lockPath(brokenDir), '{"pid":12');
  check('a half-written lock reads as absent', lock.readLock(brokenDir) === null);
  check('a half-written lock does not block acquire', lock.acquire({ dataDir: brokenDir }).ok === true);
  lock.release({ dataDir: brokenDir });

  // ── Losing the lock to another owner ───────────────────────────────────────
  const takenDir = scratch('lock-taken');
  lock.acquire({ dataDir: takenDir });
  fs.writeFileSync(
    lock.lockPath(takenDir),
    `${JSON.stringify({ pid: deadPid, startedAt: Date.now(), heartbeatAt: Date.now(), version: null, mode: 'daemon' })}\n`,
  );
  check(
    'heartbeat returns false once someone else owns the lock',
    lock.heartbeat({ dataDir: takenDir }) === false,
  );
  check('release refuses to remove a lock we no longer own', lock.release({ dataDir: takenDir }) === false);
}

/**
 * A pid that is certainly not running.
 *
 * Spawning something trivial and waiting for it to exit is the only portable
 * way to be sure: a made-up high number can collide with a real process, and
 * the whole stale-lock path then silently tests nothing.
 */
async function findDeadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'exit');
  return pid;
}

// ─── 2. Claim: single-process behaviour ───────────────────────────────────────

async function testClaimBasics() {
  setGroup('2. claim — basics');

  const { claim, claimPath, claimDir, sweepAbandoned, CLAIM_TTL_MS } =
    await import(srcUrl('core/notifications/claim.js'));
  const dataDir = scratch('claim-basic');

  const first = claim({ domain: 'a.example.com', eventType: 'domain_health', status: 'down', dataDir });
  check('first claim wins', first.ok === true && first.takeover === false);
  check('claim file created', fs.existsSync(claimPath('a.example.com', 'domain_health', 'down', dataDir)));

  const second = claim({ domain: 'a.example.com', eventType: 'domain_health', status: 'down', dataDir });
  check('a second claim by a live holder is refused', second.ok === false, second.reason);
  check('refusal names the holder', second.heldBy === process.pid);

  // A different transition is independent.
  const other = claim({ domain: 'a.example.com', eventType: 'domain_health', status: 'up', dataDir });
  check('a different status claims independently', other.ok === true);
  other.release();

  check('release removes the file', (() => {
    first.release();
    return fs.existsSync(claimPath('a.example.com', 'domain_health', 'down', dataDir)) === false;
  })());

  const third = claim({ domain: 'a.example.com', eventType: 'domain_health', status: 'down', dataDir });
  check('after release it can be claimed again', third.ok === true);
  third.commit();

  // ── Takeover rules ────────────────────────────────────────────────────────
  const deadPid = await findDeadPid();
  const file = claimPath('b.example.com', 'domain_health', 'down', dataDir);

  const writeClaim = (pid, at) => {
    fs.mkdirSync(claimDir(dataDir), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ pid, at })}\n`);
  };

  writeClaim(deadPid, Date.now());
  const tooSoon = claim({ domain: 'b.example.com', eventType: 'domain_health', status: 'down', dataDir });
  check('a dead owner inside the TTL is still not taken over', tooSoon.ok === false, tooSoon.reason);

  writeClaim(deadPid, Date.now() - CLAIM_TTL_MS - 1000);
  const taken = claim({ domain: 'b.example.com', eventType: 'domain_health', status: 'down', dataDir });
  check('a dead owner past the TTL is taken over', taken.ok === true && taken.takeover === true);
  taken.commit();

  writeClaim(process.pid, Date.now() - CLAIM_TTL_MS - 1000);
  const liveOld = claim({ domain: 'b.example.com', eventType: 'domain_health', status: 'down', dataDir });
  check('a LIVE owner past the TTL keeps the claim', liveOld.ok === false, liveOld.reason);
  fs.unlinkSync(file);

  // ── Key safety ────────────────────────────────────────────────────────────
  const nasty = claim({ domain: '../../escape', eventType: 'a/b', status: 'down', dataDir });
  check('a path-traversal domain cannot escape the claim dir', nasty.ok === true
    && path.dirname(claimPath('../../escape', 'a/b', 'down', dataDir)) === claimDir(dataDir));
  nasty.release();

  const long = 'x'.repeat(400) + '.example.com';
  const longClaim = claim({ domain: long, eventType: 'domain_health', status: 'down', dataDir });
  check('a very long domain still claims', longClaim.ok === true, longClaim.reason ?? '');
  longClaim?.release?.();

  // ── Sweep ─────────────────────────────────────────────────────────────────
  writeClaim(deadPid, Date.now() - CLAIM_TTL_MS - 1000);
  const liveFile = claimPath('c.example.com', 'domain_health', 'down', dataDir);
  fs.writeFileSync(liveFile, `${JSON.stringify({ pid: process.pid, at: Date.now() - CLAIM_TTL_MS - 1000 })}\n`);
  const swept = sweepAbandoned({ dataDir });
  check('sweep removes an abandoned claim', swept === 1, `removed ${swept}`);
  check('sweep leaves a live process alone', fs.existsSync(liveFile));
  fs.unlinkSync(liveFile);
}

// ─── 3. Claim: the real race ──────────────────────────────────────────────────

const RACE_CHILD = `
${BARRIER_SOURCE}

// The module path is passed in: a child script lives in the temporary data
// directory, not in the repo, so nothing relative to it resolves into src/.
const [claimModule, dataDir, startAt] = process.argv.slice(2);
const { claim } = await import(claimModule);

waitForBarrier(startAt);

const got = claim({ domain: 'race.example.com', eventType: 'domain_health', status: 'down', dataDir });
if (got.ok) {
  // Hold it briefly: a winner that released instantly would let a loser claim
  // next and the test could not tell a serialised run from a real race.
  await new Promise((r) => setTimeout(r, 150));
  process.stdout.write(JSON.stringify({ won: true, pid: process.pid }));
  got.commit();
} else {
  process.stdout.write(JSON.stringify({ won: false, pid: process.pid, reason: got.reason }));
}
`;

async function testClaimRace() {
  setGroup('3. claim — multi-process race');

  const dataDir = scratch('claim-race');
  const file = writeChild('race-child.mjs', RACE_CHILD);

  const N = 6;
  // Enough lead time for six Node processes to reach the barrier. If a child
  // arrives late it simply loses, which cannot turn a failure into a pass:
  // the assertion is "exactly one winner", and a late starter would find the
  // claim already held.
  const startAt = Date.now() + 1500;

  const children = await Promise.all(
    Array.from({ length: N }, () => runChild(file, [srcUrl("core/notifications/claim.js"), dataDir, String(startAt)])),
  );

  const crashed = children.filter((c) => c.code !== 0);
  check('every racing child exited cleanly', crashed.length === 0,
    crashed.map((c) => c.err.split('\n')[0]).join(' | '));

  const parsed = children.map((c) => { try { return JSON.parse(c.out); } catch { return null; } });
  check('every child reported a result', parsed.every((p) => p !== null),
    children.filter((c, i) => parsed[i] === null).map((c) => c.err.split('\n').slice(-1)[0]).join(' | '));

  const winners = parsed.filter((p) => p?.won);
  check(`exactly one of ${N} processes won the claim`, winners.length === 1, `winners: ${winners.length}`);
  check('the losers all said why', parsed.filter((p) => p && !p.won).every((p) => typeof p.reason === 'string' && p.reason.length > 0));
  check('no claim file is left behind', (() => {
    const { claimDir } = { claimDir: path.join(dataDir, 'claims') };
    const left = fs.existsSync(claimDir) ? fs.readdirSync(claimDir).filter((f) => f.endsWith('.claim')) : [];
    return left.length === 0;
  })(), '');
}

// ─── 4. Dispatch ordering: nothing is marked sent before it is sent ──────────

async function testDispatchOrdering() {
  setGroup('4. dispatch — ordering and the failure case');

  const notifier = await import(srcUrl('core/domainNotifier.js'));
  const { dispatchTransition } = await import(srcUrl('core/notifications/dispatch.js'));
  const dataDir = scratch('dispatch');

  const DOMAIN = 'order.example.com';
  const EVENT = 'domain_health';
  notifier.clearAllNotificationState();

  const buildEvent = (d) => ({ id: `e-${d.reason}`, type: EVENT, domain: DOMAIN, reason: d.reason });

  // ── evaluateTransition must be pure ───────────────────────────────────────
  const stateBefore = JSON.stringify(notifier.getNotificationState(DOMAIN, EVENT));
  notifier.evaluateTransition(DOMAIN, EVENT, 'down');
  notifier.evaluateTransition(DOMAIN, EVENT, 'down');
  check('evaluateTransition writes nothing',
    JSON.stringify(notifier.getNotificationState(DOMAIN, EVENT)) === stateBefore);

  // The retained convenience path still records immediately — which is why it
  // must never be used by anything that sends. Pinned here so a future change
  // that routes a sender through it shows up as a deliberate decision.
  notifier.clearAllNotificationState();
  notifier.shouldSendNotification(DOMAIN, EVENT, 'up');
  check('shouldSendNotification commits without sending (unsafe for senders)',
    notifier.getNotificationState(DOMAIN, EVENT).notifiedFor === 'up');
  notifier.clearAllNotificationState();

  // ── First sighting records but does not notify ────────────────────────────
  let sends = 0;
  const okSend = async () => { sends++; return { attempted: 1, delivered: 1, failed: [], ok: true }; };

  const first = await dispatchTransition({
    domain: DOMAIN, eventType: EVENT, status: 'up', buildEvent, channelIds: ['ch1'], dataDir, send: okSend,
  });
  check('a first sighting sends nothing', first.sent === false && first.reason === 'first_check');
  check('a first sighting still records the status',
    notifier.getNotificationState(DOMAIN, EVENT).notifiedFor === 'up');
  check('no channel was contacted', sends === 0);

  // ── A real transition sends and records ───────────────────────────────────
  const down = await dispatchTransition({
    domain: DOMAIN, eventType: EVENT, status: 'down', buildEvent, channelIds: ['ch1'], dataDir, send: okSend,
  });
  check('a state change sends', down.sent === true && down.decision.reason === 'state_changed');
  check('exactly one send happened', sends === 1);
  check('the state now says down', notifier.getNotificationState(DOMAIN, EVENT).notifiedFor === 'down');
  check('lastNotifiedAt is stamped only on a real send',
    typeof notifier.getNotificationState(DOMAIN, EVENT).lastNotifiedAt === 'number');
  check('the claim was committed', fs.existsSync(path.join(dataDir, 'claims')) === false
    || fs.readdirSync(path.join(dataDir, 'claims')).filter((f) => f.endsWith('.claim')).length === 0);

  // ── No change sends nothing ───────────────────────────────────────────────
  const same = await dispatchTransition({
    domain: DOMAIN, eventType: EVENT, status: 'down', buildEvent, channelIds: ['ch1'], dataDir, send: okSend,
  });
  check('an unchanged status sends nothing', same.sent === false && same.reason === 'no_change');
  check('still exactly one send', sends === 1);

  // ── THE FAILURE CASE: a failed send must be retried ───────────────────────
  let attempts = 0;
  const failingSend = async () => {
    attempts++;
    return { attempted: 2, delivered: 0, failed: [{ id: 'ch1', name: 'hook', error: 'ECONNREFUSED' }], ok: false };
  };

  const failed = await dispatchTransition({
    domain: DOMAIN, eventType: EVENT, status: 'up', buildEvent, channelIds: ['ch1'], dataDir, send: failingSend,
  });
  check('a failed send reports not sent', failed.sent === false);
  check('a failed send says it will retry', /retry/.test(failed.reason), failed.reason);
  check('a failed send does NOT record the transition',
    notifier.getNotificationState(DOMAIN, EVENT).notifiedFor === 'down');
  check('a failed send releases the claim',
    fs.readdirSync(path.join(dataDir, 'claims')).filter((f) => f.endsWith('.claim')).length === 0);

  const retry = await dispatchTransition({
    domain: DOMAIN, eventType: EVENT, status: 'up', buildEvent, channelIds: ['ch1'], dataDir, send: okSend,
  });
  check('the next poll retries the same transition', retry.sent === true && retry.decision.reason === 'recovery');
  check('the retry recorded it', notifier.getNotificationState(DOMAIN, EVENT).notifiedFor === 'up');
  check('the failing send was tried once', attempts === 1);

  // ── A throwing sender behaves like a failure, not a crash ─────────────────
  const throwingSend = async () => { throw new Error('boom'); };
  const threw = await dispatchTransition({
    domain: DOMAIN, eventType: EVENT, status: 'down', buildEvent, channelIds: ['ch1'], dataDir, send: throwingSend,
  });
  check('a throwing sender is caught', threw.sent === false && /boom/.test(threw.reason));
  check('a throwing sender does not record the transition',
    notifier.getNotificationState(DOMAIN, EVENT).notifiedFor === 'up');
  check('a throwing sender releases the claim',
    fs.readdirSync(path.join(dataDir, 'claims')).filter((f) => f.endsWith('.claim')).length === 0);

  // ── Partial delivery counts as sent ───────────────────────────────────────
  const partialSend = async () => ({
    attempted: 2, delivered: 1, failed: [{ id: 'ch2', name: 'x', error: 'timeout' }], ok: true,
  });
  const partial = await dispatchTransition({
    domain: DOMAIN, eventType: EVENT, status: 'down', buildEvent, channelIds: ['ch1', 'ch2'], dataDir, send: partialSend,
  });
  check('partial delivery is recorded as sent, not retried', partial.sent === true);

  // ── The local emit only happens for the process that sent ────────────────
  let emitted = [];
  notifier.clearAllNotificationState();
  await dispatchTransition({
    domain: DOMAIN, eventType: EVENT, status: 'up', buildEvent, channelIds: [], dataDir, send: okSend,
    emitLocal: (e) => emitted.push(e),
  });
  check('no local emit for a first sighting', emitted.length === 0);
  await dispatchTransition({
    domain: DOMAIN, eventType: EVENT, status: 'down', buildEvent, channelIds: [], dataDir, send: okSend,
    emitLocal: (e) => emitted.push(e),
  });
  check('one local emit for one transition', emitted.length === 1);

  const broken = await dispatchTransition({
    domain: DOMAIN, eventType: EVENT, status: 'up', buildEvent, channelIds: [], dataDir, send: okSend,
    emitLocal: () => { throw new Error('socket gone'); },
  });
  check('a broken local emit does not undo a successful send', broken.sent === true);
}

// ─── 5. Dispatch race: two processes, one notification ───────────────────────

const DISPATCH_CHILD = `
${BARRIER_SOURCE}

const [dispatchModule, dataDir, logFile, startAt] = process.argv.slice(2);
const { dispatchTransition } = await import(dispatchModule);
const fs = await import('fs');

// Records every send attempt, so the parent can count them across processes.
const send = async () => {
  fs.appendFileSync(logFile, process.pid + '\\n');
  return { attempted: 1, delivered: 1, failed: [], ok: true };
};

waitForBarrier(startAt);

const out = await dispatchTransition({
  domain: 'dup.example.com',
  eventType: 'domain_health',
  status: 'down',
  buildEvent: (d) => ({ id: 'x', type: 'domain_health', reason: d.reason }),
  channelIds: ['ch1'],
  dataDir,
  send,
});

process.stdout.write(JSON.stringify({ pid: process.pid, sent: out.sent, reason: out.reason }));
`;

async function testDispatchRace() {
  setGroup('5. dispatch — two processes, one notification');

  const dataDir = scratch('dispatch-race');
  const logFile = path.join(dataDir, 'sends.log');
  fs.writeFileSync(logFile, '');

  // Seed a prior state in the shared database so 'down' is a real transition
  // for every child rather than a first sighting.
  const notifier = await import(srcUrl('core/domainNotifier.js'));
  notifier.setNotificationState('dup.example.com', 'domain_health', {
    status: 'up', lastNotifiedAt: Date.now() - 60_000, notifiedFor: 'up',
  });

  const file = writeChild('dispatch-child.mjs', DISPATCH_CHILD);
  const N = 4;
  const startAt = Date.now() + 1500;

  const children = await Promise.all(
    Array.from({ length: N }, () => runChild(file, [srcUrl("core/notifications/dispatch.js"), dataDir, logFile, String(startAt)])),
  );

  const crashed = children.filter((c) => c.code !== 0);
  check('every child exited cleanly', crashed.length === 0,
    crashed.map((c) => c.err.split('\n').slice(-1)[0]).join(' | '));

  const parsed = children.map((c) => { try { return JSON.parse(c.out); } catch { return null; } });
  const senders = parsed.filter((p) => p?.sent);
  check(`exactly one of ${N} processes sent`, senders.length === 1, `senders: ${senders.length}`);

  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  check('the notification left the machine exactly once', lines.length === 1, `${lines.length} send(s)`);

  check('the state records it as notified once',
    notifier.getNotificationState('dup.example.com', 'domain_health').notifiedFor === 'down');

  check('no claim is left behind', (() => {
    const dir = path.join(dataDir, 'claims');
    return !fs.existsSync(dir) || fs.readdirSync(dir).filter((f) => f.endsWith('.claim')).length === 0;
  })());
}

// ─── 6. sendNotification reports delivery ────────────────────────────────────

async function testSendResult() {
  setGroup('6. sendNotification result');

  const { sendNotification, saveChannels } = await import(srcUrl('core/notifier.js'));

  const empty = await sendNotification({ type: 'x' }, []);
  check('no channels is ok with nothing attempted', empty.ok === true && empty.attempted === 0);

  const nullIds = await sendNotification({ type: 'x' }, null);
  check('null channel list is ok', nullIds.ok === true && nullIds.attempted === 0);

  saveChannels([{ id: 'gone', name: 'Nope', type: 'definitely-not-a-channel-type' }]);
  const broken = await sendNotification({ type: 'x', message: 'm' }, ['gone']);
  check('an unloadable channel type is attempted and fails', broken.attempted === 1 && broken.delivered === 0);
  check('an all-failed send is not ok', broken.ok === false);
  check('the failure names the channel', broken.failed[0]?.name === 'Nope');

  const missing = await sendNotification({ type: 'x' }, ['no-such-id']);
  check('a stale channel ID is not counted as a failure', missing.attempted === 0 && missing.ok === true);

  saveChannels([]);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nNotification claim / daemon lock / dispatch ordering\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testLock();
  await testClaimBasics();
  await testClaimRace();
  await testDispatchOrdering();
  await testDispatchRace();
  await testSendResult();

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label} ${f.detail ? `— ${f.detail}` : ''}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
