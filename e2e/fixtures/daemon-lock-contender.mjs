/**
 * e2e/fixtures/daemon-lock-contender.mjs
 *
 * One real process competing for the daemon lock, for
 * e2e/daemon-lock-contention.test.mjs.
 *
 * Why a fixture and not a child script written by the suite
 * ---------------------------------------------------------
 * The contention has to be REAL: several independent Node processes creating,
 * renaming, deleting and reading one lock path at the same time, which is the
 * situation that produced 1,898 EPERM renames out of 3,009 attempts on this
 * project's Windows machine. A stubbed `fs` would reproduce none of it.
 *
 * The rival processes are cheaper and more precise than threads — and Windows
 * shares file handles between processes exactly the way the daemon's real
 * rivals do.
 *
 * What it does
 * ------------
 * Acquires the daemon lock through the module's public API only (`acquire`,
 * `heartbeat`, `release`), holds it briefly, beats, appends one line to a
 * shared O_APPEND log per hold/release, and releases. Every contender repeats
 * that for `EZ_LOCK_CYCLES` cycles on one data directory.
 *
 * A cycle may be a deliberate CRASH: the contender exits without releasing, so
 * a stale lock is left for the others to recover. To keep that test fast the
 * holder acquires with a heartbeat already older than STALE_AFTER_MS — the
 * same record a daemon that died thirty seconds ago leaves behind. It is still
 * a genuine acquire through `acquire()`, and it is still the only process
 * holding the lock while it runs.
 *
 * The shared log is how the suite proves mutual exclusion: `acquire <token>
 * <hrtime>` / `release <token> <hrtime>` (and `crash <token> <hrtime>` for the
 * simulated crash), appended with O_APPEND so two writers cannot overwrite one
 * another. `process.hrtime.bigint()` is monotonic system-wide on both
 * platforms, so the intervals can be compared across processes.
 *
 * Environment (all real variables, set before this process starts)
 * ----------------------------------------------------------------
 *   EZ_TEST=1                      the usual guard; refusal here is deliberate
 *   EASY_DEVOPS_DATA_DIR           the runner's throwaway data directory
 *   EZ_LOCK_DATA_DIR               the directory under test (inside the above)
 *   EZ_LOCK_LOG                    shared append-only event log
 *   EZ_LOCK_RESULT_DIR             where `ready-<id>` and `result-<id>.json` go
 *   EZ_LOCK_ID                     contender id
 *   EZ_LOCK_CYCLES                 how many acquire/hold/release cycles
 *   EZ_LOCK_START_FILE             the gate; work begins when it exists
 *   EZ_LOCK_HOLD_MS                optional hold time (default 10)
 *   EZ_LOCK_CRASH_CYCLE            optional 1-based cycle that exits without a
 *                                  release (0 / absent: never)
 *   EZ_LOCK_DEADLINE_MS            optional whole-run deadline (default 90000)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ─── The test guard, checked before anything under src/ is loaded ────────────

if (process.env.EZ_TEST !== '1') {
  process.stderr.write('Refusing to run the daemon-lock contender outside EZ_TEST=1.\n');
  process.exit(64);
}

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`${name} is not set; the daemon-lock contender needs its test environment`);
  }
  return String(value).trim();
}

const dataDir = path.resolve(required('EZ_LOCK_DATA_DIR'));
const logFile = path.resolve(required('EZ_LOCK_LOG'));
const resultDir = path.resolve(required('EZ_LOCK_RESULT_DIR'));
const id = required('EZ_LOCK_ID');
const startFile = path.resolve(required('EZ_LOCK_START_FILE'));
const cycles = Number(required('EZ_LOCK_CYCLES'));
const holdMs = Number(process.env.EZ_LOCK_HOLD_MS ?? 10);
const crashCycle = Number(process.env.EZ_LOCK_CRASH_CYCLE ?? 0);
const deadlineMs = Number(process.env.EZ_LOCK_DEADLINE_MS ?? 120_000);

// Both directories must be inside the runner's throwaway data directory. This
// is the same containment idea as e2e/lib/guard.mjs, repeated here because a
// fixture may not import the guard (it is not a suite) and is spawned with an
// explicit environment.
const runnerData = path.resolve(required('EASY_DEVOPS_DATA_DIR'));
const normalise = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
function assertInside(dir, what) {
  const candidate = normalise(dir);
  const root = normalise(runnerData);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(`${what} (${dir}) is outside the runner's data directory (${runnerData})`);
  }
}
assertInside(dataDir, 'EZ_LOCK_DATA_DIR');
assertInside(resultDir, 'EZ_LOCK_RESULT_DIR');
assertInside(logFile, 'EZ_LOCK_LOG');

const resultFile = path.join(resultDir, `result-${id}.json`);
const readyFile = path.join(resultDir, `ready-${id}`);
const token = (cycle) => `${id}-${cycle}-${process.pid}`;
const hr = () => Number(process.hrtime.bigint());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One O_APPEND write: the kernel places it at the end, whoever else writes. */
function append(line) {
  fs.appendFileSync(logFile, `${line}\n`, 'utf8');
}

/** Every distinct error, with the code, syscall and the first stack frames. */
function describeError(error) {
  const code = error?.code ?? 'UNKNOWN';
  const syscall = error?.syscall ?? null;
  const detail = error?.message ?? String(error);
  const stack = String(error?.stack ?? '')
    .split('\n')
    .slice(1, 4)
    .map((line) => line.trim());
  return { code, syscall, message: detail, stack };
}

const result = {
  id,
  pid: process.pid,
  startedAt: Date.now(),
  finishedAt: null,
  cyclesRequested: cycles,
  cyclesCompleted: 0,
  acquired: 0,
  recovered: 0,
  recoveredFrom: [],
  crashed: false,
  releaseFailures: 0,
  lostHeartbeats: 0,
  refusals: 0,
  contentionFailures: [],
  fatal: null,
};

function finish(code) {
  result.finishedAt = Date.now();
  try {
    fs.writeFileSync(resultFile, `${JSON.stringify(result)}\n`, 'utf8');
  } catch {
    // The ready/result channel failing is the suite's timeout, not a crash.
  }
  process.exit(code);
}

let lock = null;

async function main() {
  const moduleUrl = pathToFileURL(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/core/daemon/lock.js'),
  ).href;
  lock = await import(moduleUrl);
  const { STALE_AFTER_MS } = lock;

  const perCycleMs = Math.min(15_000, Math.max(10_000, Math.ceil(deadlineMs / Math.max(1, cycles))));
  const globalDeadline = Date.now() + deadlineMs;

  // Announce readiness, then wait for every contender. Waiting on a file keeps
  // the start simultaneous without a parent-process pipe (which would be a
  // fifth thing contending for handles).
  fs.writeFileSync(readyFile, 'ready\n');
  while (!fs.existsSync(startFile)) {
    if (Date.now() > globalDeadline) {
      result.fatal = { code: 'NO_GATE', syscall: null, message: 'the start file never appeared', stack: [] };
      return finish(1);
    }
    await sleep(5);
  }

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    if (Date.now() > globalDeadline) {
      result.fatal = {
        code: 'DEADLINE',
        syscall: null,
        message: `ran out of time at cycle ${cycle} of ${cycles}`,
        stack: [],
      };
      return finish(1);
    }

    const thisToken = token(cycle);
    const isCrashCycle = crashCycle > 0 && cycle === crashCycle;
    // A crash cycle asks for a record that is already stale, so a crashed
    // holder is recoverable at once instead of after the stale window.
    const beatAt = isCrashCycle ? Date.now() - STALE_AFTER_MS - 5_000 : Date.now();

    let got = null;
    let lastSeen = null;
    const until = Date.now() + perCycleMs;
    let refusal = null;

    while (Date.now() < until) {
      try {
        lastSeen = lock.readLock(dataDir);
      } catch {
        lastSeen = null;
      }
      let attempt;
      try {
        attempt = lock.acquire({
          dataDir,
          version: 'contender',
          mode: 'daemon',
          now: isCrashCycle ? beatAt : Date.now(),
        });
      } catch (error) {
        // An acquire that throws is exactly the crash 1.4.7 produced. Record
        // it and stop this contender; the suite reports code/syscall/line.
        result.fatal = describeError(error);
        return finish(1);
      }
      if (attempt.ok) {
        got = attempt;
        break;
      }
      refusal = attempt.reason ?? 'refused';
      if (/\bEPERM\b|\bEBUSY\b/.test(refusal)) {
        result.contentionFailures.push({ phase: 'acquire', reason: refusal });
      }
      // A randomized backoff, not a fixed one: eight contenders that all wake
      // in lockstep let the process that just released re-take the lock before
      // any of them runs, which starves them and measures nothing.
      await sleep(3 + Math.floor(Math.random() * 12));
    }

    if (!got) {
      result.fatal = {
        code: 'TIMEOUT',
        syscall: null,
        message: `no acquire within ${perCycleMs} ms at cycle ${cycle}; last refusal: ${refusal ?? 'none'}`,
        stack: [],
      };
      return finish(1);
    }

    result.acquired += 1;
    result.cyclesCompleted = cycle;
    append(`acquire ${thisToken} ${hr()}`);

    if (got.recovered === true) {
      result.recovered += 1;
      result.recoveredFrom.push(lastSeen?.token ?? null);
      append(`recovered ${thisToken} ${hr()}`);
    }

    if (isCrashCycle) {
      // Exit without release: a crashed holder. The lock stays on disk, already
      // stale, and another contender must recover it — exactly once.
      result.crashed = true;
      append(`crash ${thisToken} ${hr()}`);
      return finish(0);
    }

    await sleep(holdMs);
    // A beating owner must always still own its lock. `heartbeat` must never
    // throw; false here means "I no longer own it", which while holding is a
    // lost lock, not a normal state.
    let stillMine;
    try {
      stillMine = lock.heartbeat({ dataDir, mode: 'daemon', now: Date.now() });
    } catch (error) {
      result.fatal = describeError(error);
      return finish(1);
    }
    if (stillMine !== true) result.lostHeartbeats += 1;

    append(`release ${thisToken} ${hr()}`);
    let released;
    try {
      released = lock.release({ dataDir });
    } catch (error) {
      // release() is documented to return false, never to throw; a throw is a
      // finding of its own.
      result.fatal = describeError(error);
      return finish(1);
    }
    if (released !== true) result.releaseFailures += 1;
    // Yield after a release, so the next round is not won by whoever released
    // most recently. Without it the lock never changes hands under load.
    await sleep(1 + Math.floor(Math.random() * 8));
  }

  return finish(0);
}

main().catch((error) => {
  result.fatal = describeError(error);
  finish(1);
});
