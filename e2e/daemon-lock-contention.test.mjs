/**
 * Daemon lock contention (finding A4).
 *
 * The daemon lock lives on one path that several processes create, rename,
 * read and delete at the same time. On Windows those operations are refused
 * with EPERM or EBUSY whenever another process is in the middle of one — a
 * SHARING denial, not damage. 1.4.7 threw one out of the daemon and the real
 * Windows Server died with "EPERM: operation not permitted, rename
 * '...daemon.lock...'". The same class of failure was measured at 1,898 EPERM
 * renames out of 3,009 attempts under ten-way churn, every one of which
 * succeeded on a later attempt.
 *
 * This suite answers four questions with real processes, not stubs:
 *
 *   (a) no contender ever fails with EPERM or EBUSY;
 *   (b) never two holders at once — each holder appends `acquire <token>
 *       <hrtime>` / `release <token> <hrtime>` to one O_APPEND log, and the
 *       intervals must never overlap;
 *   (c) afterwards the data directory holds no lock, guard, candidate or
 *       stale/released copy;
 *   (d) a crashed holder's lock is recovered by exactly one contender.
 *
 * Everything is confined to the runner's temporary data directory. The
 * contenders are real Node processes started through child_process, each gets
 * EZ_TEST=1 and a throwaway EASY_DEVOPS_DATA_DIR as real environment
 * variables, and every child is bounded by a timeout and its tree killed on
 * expiry.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';
import { killProcessTree } from './lib/kill-tree.mjs';

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, '..');
const CONTENDER = path.join(E2E_DIR, 'fixtures', 'daemon-lock-contender.mjs');

/** How long one child may take before its whole tree is killed. */
const CHILD_TIMEOUT_MS = 150_000;

/** The fixture's own whole-run deadline, inside CHILD_TIMEOUT_MS. */
const CHILD_DEADLINE_MS = 110_000;

const results = [];
let group = '';
function setGroup(name) {
  group = name;
  process.stdout.write(`\n-- ${name}\n`);
}
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, { timeoutMs = 30_000, everyMs = 25 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(everyMs);
  }
  return false;
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'daemon-lock', name);
  assertInsideTestDataDir(dir, `create the daemon-lock scratch directory ${name}`);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'results'), { recursive: true });
  return {
    root: dir,
    dataDir: path.join(dir, 'data'),
    resultDir: path.join(dir, 'results'),
    logFile: path.join(dir, 'events.log'),
    startFile: path.join(dir, 'start'),
  };
}

/**
 * Starts one contender. Never rejects: a failure to start or an expiry is
 * recorded and reported by the caller, so one wedged child cannot hide the
 * verdict of the others.
 */
function startContender(area, { id, cycles, crashCycle = 0, holdMs = 10, deadlineMs = CHILD_DEADLINE_MS }) {
  const state = { id, child: null, timedOut: false, code: null, signal: null, stdout: '', stderr: '' };
  const child = spawn(process.execPath, [CONTENDER], {
    cwd: ROOT,
    // The variables that must be real BEFORE Node starts: the guard, and the
    // throwaway data directory the fixture must stay inside.
    env: {
      ...process.env,
      EZ_TEST: '1',
      EASY_DEVOPS_DATA_DIR: TEST_DATA_DIR,
      EZ_LOCK_DATA_DIR: area.dataDir,
      EZ_LOCK_LOG: area.logFile,
      EZ_LOCK_RESULT_DIR: area.resultDir,
      EZ_LOCK_ID: String(id),
      EZ_LOCK_CYCLES: String(cycles),
      EZ_LOCK_START_FILE: area.startFile,
      EZ_LOCK_HOLD_MS: String(holdMs),
      EZ_LOCK_CRASH_CYCLE: String(crashCycle),
      EZ_LOCK_DEADLINE_MS: String(deadlineMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  state.child = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { state.stdout += chunk; });
  child.stderr.on('data', (chunk) => { state.stderr += chunk; });

  let timer = null;
  state.done = new Promise((resolve) => {
    child.on('error', (error) => {
      state.stderr += `\nspawn error: ${error.message}`;
      state.code = -1;
      resolve();
    });
    child.on('close', (code, signal) => {
      state.code = code;
      state.signal = signal;
      if (timer) clearTimeout(timer);
      resolve();
    });
    timer = setTimeout(async () => {
      state.timedOut = true;
      await killProcessTree(child.pid, { waitMs: 10_000 });
      resolve();
    }, CHILD_TIMEOUT_MS);
    timer.unref?.();
  });
  return state;
}

/** Waits until every contender has announced readiness, or one has died. */
async function waitForReady(contenders, area) {
  return waitUntil(() => contenders.every((entry) => (
    fs.existsSync(path.join(area.resultDir, `ready-${entry.id}`)) || entry.code !== null
  )), { timeoutMs: 30_000 });
}

function readResults(area, ids) {
  const found = new Map();
  for (const id of ids) {
    const file = path.join(area.resultDir, `result-${String(id)}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      found.set(String(id), JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // A truncated result is a missing one; the suite reports it.
    }
  }
  return found;
}

/** Distinct errors, named by code, syscall and the first lock.js frame. */
function distinctErrors(list) {
  const seen = new Map();
  for (const entry of list) {
    const frame = entry.stack?.find((line) => /lock\.js:/.test(line)) ?? entry.stack?.[0] ?? '';
    const key = `${entry.code ?? 'REFUSED'}${entry.syscall ? ` ${entry.syscall}` : ''} `
      + `${entry.message ?? entry.reason ?? String(entry)} @ ${frame}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen].map(([key, count]) => (count > 1 ? `${key} (x${count})` : key));
}

function parseEvents(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [kind, token, at] = line.split(' ');
      return { kind, token, at: Number(at) };
    })
    .filter((event) => Number.isFinite(event.at))
    .sort((a, b) => a.at - b.at);
}

/**
 * Replays the shared log as intervals. Two holders at once means an `acquire`
 * arrives while another token is still open.
 */
function auditIntervals(events) {
  const active = new Set();
  const overlaps = [];
  const unclosed = [];
  const unopened = [];
  for (const event of events) {
    if (event.kind === 'acquire') {
      if (active.size > 0) overlaps.push(`${event.token} acquired while ${[...active].join(', ')} held`);
      active.add(event.token);
    } else if (event.kind === 'release' || event.kind === 'crash') {
      if (!active.has(event.token)) unopened.push(`${event.kind} ${event.token}`);
      active.delete(event.token);
    }
    // `recovered` is informational; it closes nothing.
  }
  for (const token of active) unclosed.push(token);
  return { overlaps, unclosed, unopened };
}

/** Anything the lock machinery should have cleaned up after itself. */
function leftovers(dataDir) {
  return fs.readdirSync(dataDir).filter((name) => (
    name === 'daemon.lock'
    // The guard, a prepared candidate, an atomic temp file, and any
    // stale/released copy all carry this prefix.
    || name.startsWith('daemon.lock.')
  ));
}

const DEAD_PID = 0x7ffffffe;

/**
 * Group 1: eight contenders, thirty cycles each, one planted stale lock to
 * recover at the start and one deliberate crash mid-run. The crash means stale
 * recovery also happens while every other process is renaming and reading.
 */
async function churn() {
  setGroup('1. eight contenders, thirty cycles, one stale recovery and one crash');
  const area = scratch('churn');
  const lock = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'daemon', 'lock.js')).href);
  const { STALE_AFTER_MS } = lock;

  const longAgo = Date.now() - STALE_AFTER_MS - 60_000;
  fs.writeFileSync(lock.lockPath(area.dataDir), `${JSON.stringify({
    pid: DEAD_PID,
    startedAt: longAgo,
    heartbeatAt: longAgo,
    version: 'crashed-1.4.7',
    mode: 'daemon',
  })}\n`);

  const contenderCount = 8;
  const cyclesPerContender = 30;
  const crashCycle = 10;
  const crashId = contenderCount - 1;
  const contenders = Array.from({ length: contenderCount }, (_, index) => startContender(area, {
    id: index,
    cycles: cyclesPerContender,
    crashCycle: index === crashId ? crashCycle : 0,
  }));

  const allReady = await waitForReady(contenders, area);
  check('every contender is waiting before the start', allReady, `${contenderCount} child(ren)`);

  fs.writeFileSync(area.startFile, 'go\n');
  await Promise.all(contenders.map((entry) => entry.done));

  const killed = contenders.filter((entry) => entry.timedOut);
  check('every contender finished inside its timeout', killed.length === 0,
    killed.map((entry) => `#${entry.id}`).join(', '));

  const ids = contenders.map((entry) => entry.id);
  const collected = readResults(area, ids);
  check('every contender wrote a result', collected.size === contenderCount,
    `${collected.size}/${contenderCount}`);

  const reports = [...collected.values()];
  const fatals = reports.filter((report) => report.fatal).map((report) => report.fatal);
  const contention = reports.flatMap((report) => report.contentionFailures ?? []);
  const fatalErrors = distinctErrors(fatals);
  const contentionErrors = distinctErrors(contention);
  check('no contender crashed', fatalErrors.length === 0, fatalErrors.slice(0, 4).join('; '));
  check('no operation failed with EPERM or EBUSY', contentionErrors.length === 0,
    contentionErrors.slice(0, 4).join('; '));
  check('every contender completed the cycles it did not crash in',
    reports.every((report) => report.cyclesCompleted === (report.crashed ? crashCycle : cyclesPerContender)),
    reports.map((report) => `${report.id}:${report.cyclesCompleted}`).join(' '));

  const releaseFailures = reports.reduce((sum, report) => sum + (report.releaseFailures ?? 0), 0);
  const lostHeartbeats = reports.reduce((sum, report) => sum + (report.lostHeartbeats ?? 0), 0);
  const crashes = reports.filter((report) => report.crashed).length;
  check('a beating owner never lost its own lock', lostHeartbeats === 0, String(lostHeartbeats));
  check('release never left this process holding the lock', releaseFailures === 0, String(releaseFailures));
  check('exactly one contender crashed, on the planned cycle', crashes === 1, String(crashes));

  const recovered = reports.reduce((sum, report) => sum + (report.recovered ?? 0), 0);
  check('the planted stale lock and the crash were each recovered exactly once',
    recovered === 1 + crashes, `recovered ${recovered}, expected ${1 + crashes}`);

  const events = parseEvents(area.logFile);
  const audit = auditIntervals(events);
  check('never two holders at once', audit.overlaps.length === 0, audit.overlaps.slice(0, 3).join('; '));
  check('every hold in the log closed', audit.unclosed.length === 0,
    `${audit.unclosed.slice(0, 3).join(', ')}${audit.unclosed.length > 3 ? ' …' : ''}`);
  check('every release had its acquire', audit.unopened.length === 0, audit.unopened.slice(0, 3).join('; '));

  const acquired = events.filter((event) => event.kind === 'acquire').length;
  const expectedAcquisitions = (contenderCount - 1) * cyclesPerContender + crashCycle;
  check('the log contains every planned acquisition', acquired === expectedAcquisitions,
    `${acquired}/${expectedAcquisitions}`);

  const left = leftovers(area.dataDir);
  check('no lock, guard, candidate or stale copy is left behind', left.length === 0, left.join(', '));
  check('the lock reads as absent at the end', lock.readLock(area.dataDir) === null);
}

/**
 * Group 2: a holder exits without releasing; exactly one contender may recover
 * its lock, and it must be the lock that was there, not a replacement.
 */
async function crashedHolder() {
  setGroup('2. a crashed holder is recovered by exactly one contender');
  const area = scratch('crashed-holder');
  const lock = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'daemon', 'lock.js')).href);

  const poisoned = startContender(area, { id: 'crasher', cycles: 1, crashCycle: 1, holdMs: 0 });
  // The crasher's own gate: it is the only one waiting on this file.
  fs.writeFileSync(area.startFile, 'go\n');
  await poisoned.done;

  const crashReport = readResults(area, ['crasher']).get('crasher');
  check('the crashed holder exited without releasing', poisoned.code === 0 && crashReport?.crashed === true,
    String(poisoned.code));
  const crashedLock = lock.readLock(area.dataDir);
  check('its lock is on disk after it is gone', Boolean(crashedLock),
    crashReport?.fatal?.message ?? 'no lock file');
  check('the lock is stale: the pid is gone and the heartbeat is old',
    crashedLock !== null && lock.inspect({ dataDir: area.dataDir }).stale === true);
  const crashedToken = crashedLock?.token ?? null;
  check('the lock carries an owner token', typeof crashedToken === 'string' && crashedToken.length > 0,
    String(crashedToken));

  const contenderCount = 6;
  const contenders = Array.from({ length: contenderCount }, (_, index) => startContender(area, {
    id: index,
    cycles: 1,
    holdMs: 20,
  }));
  // The gate already exists, so these start as soon as they are ready.
  await Promise.all(contenders.map((entry) => entry.done));

  const reports = [...readResults(area, contenders.map((entry) => entry.id)).values()];
  const recoverers = reports.filter((report) => report.recovered === 1);
  check('exactly one contender recovered the crashed holder', recoverers.length === 1,
    `${recoverers.length} recoverer(s)`);
  check('it recovered the crashed lock, not one of its own',
    crashedToken !== null && recoverers[0]?.recoveredFrom?.includes(crashedToken) === true,
    `${JSON.stringify(recoverers[0]?.recoveredFrom ?? [])} vs ${crashedToken}`);
  check('and every contender still acquired and released once',
    reports.length === contenderCount
    && reports.every((report) => report.acquired === 1 && report.releaseFailures === 0),
    reports.map((report) => `${report.id}:${report.acquired}/${report.releaseFailures}`).join(' '));

  const fatals = reports.filter((report) => report.fatal).map((report) => report.fatal);
  const fatalErrors = distinctErrors(fatals);
  check('no contender crashed', fatalErrors.length === 0, fatalErrors.slice(0, 4).join('; '));

  const events = parseEvents(area.logFile);
  const audit = auditIntervals(events);
  check('never two holders at once', audit.overlaps.length === 0, audit.overlaps.slice(0, 3).join('; '));
  check('every hold in the log closed', audit.unclosed.length === 0, audit.unclosed.slice(0, 3).join(', '));

  const left = leftovers(area.dataDir);
  check('the crashed lock and its guard are both gone', left.length === 0, left.join(', '));
  check('the data directory is empty', fs.readdirSync(area.dataDir).length === 0,
    fs.readdirSync(area.dataDir).join(', '));
}

/**
 * Group 3: the recovery guard is displaced between OUR lock being installed and
 * the ownership re-check that follows.
 *
 * That window is a few synchronous statements, so no amount of process churn
 * reaches it reliably. It is injected deterministically instead: fs.renameSync
 * is wrapped for the one rename that puts the candidate in place, and the
 * wrapper swaps the guard for another token immediately afterwards. No test
 * hook lives in lock.js and its production behaviour is untouched.
 *
 * The contract (finding A4): a displaced guard means this recovery lost, so it
 * must report failure and withdraw ONLY a lock that still carries our token.
 * If the other recovery's lock is already on the path, it must survive the
 * loser untouched — removing it would leave the winner running without a lock.
 */
async function displacedGuard() {
  setGroup('3. a displaced recovery guard withdraws only our own lock');
  const lock = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'daemon', 'lock.js')).href);
  const { STALE_AFTER_MS } = lock;

  /** A lock whose owner is gone and whose heartbeat is old: recoverable. */
  function installStaleLock(area) {
    const longAgo = Date.now() - STALE_AFTER_MS - 60_000;
    fs.writeFileSync(lock.lockPath(area.dataDir), `${JSON.stringify({
      pid: DEAD_PID,
      startedAt: longAgo,
      heartbeatAt: longAgo,
      version: 'crashed',
      mode: 'daemon',
      token: 'crashed-holder',
    })}\n`);
  }

  /**
   * Runs acquire() while the guard is displaced at the replacement.
   * @param {Object} area
   * @param {string|null} otherToken When set, the other recovery also installs
   *   its own lock before the displaced-guard check runs.
   */
  function drive(area, otherToken) {
    installStaleLock(area);
    const lockFile = lock.lockPath(area.dataDir);
    const guardFile = `${lockFile}.recovery`;
    const originalRename = fs.renameSync;
    let fired = 0;

    fs.renameSync = (from, to) => {
      const result = originalRename(from, to);
      const isLockReplacement = path.resolve(String(to)) === path.resolve(lockFile)
        && path.basename(String(from)).startsWith('daemon.lock.candidate-');
      if (isLockReplacement) {
        fired += 1;
        // Another recovery retired our guard and installed its own, after our
        // rename landed. Its pid is a live one, which is the point: this lock
        // belongs to somebody who is running.
        fs.writeFileSync(guardFile, `${JSON.stringify({
          pid: process.ppid,
          at: Date.now(),
          token: 'displaced-guard',
        })}\n`);
        if (otherToken) {
          fs.writeFileSync(lockFile, `${JSON.stringify({
            pid: process.ppid,
            startedAt: Date.now(),
            heartbeatAt: Date.now(),
            version: 'other-recovery',
            mode: 'daemon',
            token: otherToken,
          })}\n`);
        }
      }
      return result;
    };

    let got;
    try {
      got = lock.acquire({ dataDir: area.dataDir, version: 'loser', mode: 'daemon' });
    } finally {
      fs.renameSync = originalRename;
    }
    return { got, fired, lockFile, guardFile };
  }

  // (a) Our lock is still on the path when the guard turns out displaced: it
  // must be withdrawn, or this process would run on a lock it no longer owns.
  const ours = scratch('guard-displaced-own');
  const first = drive(ours, null);
  check('the injected displacement fired at the lock replacement', first.fired === 1, String(first.fired));
  check('a displaced guard makes acquire fail',
    first.got.ok === false && /another process recovered the lock first/.test(first.got.reason ?? ''),
    first.got.ok === false ? first.got.reason : 'acquire reported success');
  check('our own lock was withdrawn',
    lock.readLock(ours.dataDir) === null && fs.existsSync(first.lockFile) === false);
  check('the displacing guard was left alone', fs.existsSync(first.guardFile), first.guardFile);
  fs.rmSync(first.guardFile, { force: true });

  // (b) The other recovery's lock is already installed: the loser must not
  // remove it, even though it is the path it just replaced.
  const theirs = scratch('guard-displaced-other');
  const second = drive(theirs, 'other-holder');
  check('the other holder installed its lock before the check', second.fired === 1, String(second.fired));
  check('a displaced guard still makes acquire fail', second.got.ok === false,
    second.got.ok === false ? second.got.reason : 'acquire reported success');
  const survivor = lock.readLock(theirs.dataDir);
  check("the other holder's lock is never removed", survivor?.token === 'other-holder',
    JSON.stringify(survivor));
  check('and it is still the live other holder', survivor?.pid === process.ppid, String(survivor?.pid));
  fs.rmSync(second.lockFile, { force: true });
  fs.rmSync(second.guardFile, { force: true });
}

async function main() {
  await churn();
  await crashedHolder();
  await displacedGuard();
}

await main();

const failed = results.filter((result) => !result.passed);
process.stdout.write(`\nTOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}   SKIP 0\n`);
if (failed.length) {
  process.stdout.write('\nFAILED:\n');
  for (const entry of failed) {
    process.stdout.write(`  [${entry.group}] ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}\n`);
  }
}
process.exit(failed.length ? 1 : 0);
