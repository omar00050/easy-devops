/**
 * e2e/run.mjs — the only sanctioned way to run the e2e suites.
 *
 *   node e2e/run.mjs              every suite
 *   node e2e/run.mjs service      one suite (name, with or without .test.mjs)
 *   node e2e/run.mjs --check      only the static-import preflight
 *   node e2e/run.mjs --windows-only
 *                                 only the suites that hold Windows-only
 *                                 groups (e2e/lib/report.mjs). On a machine that
 *                                 is not Windows it says so and runs nothing.
 *   node e2e/run.mjs --self-test-timeout
 *                                 proves the timeout kills a hanging suite and
 *                                 names its step, without touching a real suite.
 *   node e2e/run.mjs --self-test-report
 *                                 proves counts stay inside one suite, the last
 *                                 TOTAL wins, and an exit-0 suite with no summary
 *                                 line is a failure. `--self-test` runs both.
 *
 * Every suite has a wall-clock limit and a no-output watchdog (below). A suite
 * that overruns is killed with its whole process tree, reported as FAIL with
 * the step it had reached, and the run carries on with the next one: one hung
 * suite must not cost the rest of the run.
 *
 * Why a runner exists
 * -------------------
 * core/db.js resolves its data directory once, at module load. ESM evaluates
 * a file's entire static import graph before the first line of that file
 * runs, so a suite CANNOT reliably set EASY_DEVOPS_DATA_DIR for itself — by
 * the time its own code executes, anything it statically imported has already
 * decided. Five incidents have come from exactly that ordering.
 *
 * The only place the variables are certainly in force before any import is
 * evaluated is the environment of a fresh process. So this runner:
 *
 *   1. refuses to run if any suite could reach src/ through a static import
 *      before e2e/lib/guard.mjs has run (see checkStaticImports);
 *   2. creates a fresh temporary data directory per suite;
 *   3. spawns each suite as a child process with EZ_TEST=1 and
 *      EASY_DEVOPS_DATA_DIR already set;
 *   4. counts what each suite printed, and reports it;
 *   5. removes the directory afterwards and reports a summary.
 *
 * Reporting
 * ---------
 * Each suite reports as `<name>: PASS|FAIL <passed>/<total>, skipped <n>`, with
 * the skip reasons (deduplicated) underneath, and the summary carries check
 * totals as well as suite totals. A group that only runs on Windows is then a
 * skip with a name rather than a number lost inside a total. e2e/lib/report.mjs
 * holds the exact shapes it counts; suites should print a group skip with
 * `skip(name, reason)` from that module.
 *
 * Counting never decides the verdict: the verdict is still the child's exit
 * code, because a suite can print a full summary and then die.
 *
 * Timeouts
 * --------
 * A suite that never returns used to hang the whole run (native-service left a
 * supervisor restarting forever and sat there for 19 minutes). Two limits now
 * apply to each suite, and both FAIL it rather than hang:
 *
 *   - wall clock: 10 minutes by default, `EZ_SUITE_TIMEOUT_MS` overrides that
 *     and SUITE_TIMEOUT_MS below for a named suite;
 *   - no output: 3 minutes by default (`EZ_SUITE_IDLE_MS`), measured from the
 *     last byte the suite printed. Some suites are silent for a long time while
 *     they wait for a child; that is what the override is for.
 *
 * On either, the suite's process TREE is killed (e2e/lib/kill-tree.mjs) and the
 * summary says which step it had reached.
 *
 * Why the suite's stdout is a FILE, not a pipe
 * --------------------------------------------
 * Every suite ends with `process.stdout.write(<TOTAL line>)` and
 * `process.exit()`. On Windows a pipe write is queued and handed to the OS
 * asynchronously, and process.exit() discards what is still queued: ssl-preflight
 * lost its last five groups and its TOTAL line that way, exited 0, and was
 * reported as a pass. A file is written synchronously on Windows, so nothing can
 * be discarded at exit, and the runner tails that file instead of a pipe: live
 * output as before, nothing lost. It also covers the grandchild processes a
 * suite spawns, which inherit the same handle.
 *
 * A suite that nevertheless exits 0 without its summary line is a FAILURE, not
 * a pass — see "complete" in e2e/lib/report.mjs.
 *
 * With EZ_TEST=1, core/platform.js getDataDir() throws rather than return the
 * real directory — so even a mistake inside a suite cannot reach real data.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { fileURLToPath, pathToFileURL } from 'url';
import { checkApiContract } from './lib/api-contract-check.mjs';
import {
  ON_WINDOWS,
  createSuiteCounter,
  describeReasons,
  hostLabel,
  isWindowsOnlySuite,
  timeoutLine,
  timeoutReason,
  truncatedLine,
} from './lib/report.mjs';
import { killProcessTree, waitProcessGone } from './lib/kill-tree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = __dirname;
const ROOT = path.resolve(__dirname, '..');

const GUARD_IMPORT = './lib/guard.mjs';

// ─── Timeouts ────────────────────────────────────────────────────────────────

/** Ten minutes covers every suite measured here except the ones listed below. */
const DEFAULT_SUITE_TIMEOUT_MS = 10 * 60_000;

/**
 * Per-suite wall-clock limits, for suites whose measured time deserves its own
 * number rather than the blanket 10 minutes. `EZ_SUITE_TIMEOUT_MS` overrides
 * everything, deliberately: an operator who set it wants it to apply.
 *
 * Measured on Windows (win32, Node 22), 1.4.8, one suite per invocation. A full
 * run could not be completed on this machine (another lane's suite hung it), so
 * every number below is a real measurement, not an estimate.
 */
const SUITE_TIMEOUT_MS = {
  // 104 s measured — the slowest suite on this machine, because it runs real
  // git and drives whole deployments. Five minutes is about three times that,
  // and tighter than the default on purpose: a deploy regression should surface
  // within minutes rather than after ten.
  deploy: 5 * 60_000,

  // 48 s measured now, but this is the suite that hung a 1.4.8 run for 19
  // minutes: a supervisor it starts could restart forever. Ten minutes leaves a
  // slow machine room and still ends such a regression inside the same run.
  'native-service': 10 * 60_000,
};

/** Three minutes with no output is a stall, not a slow check. */
const DEFAULT_IDLE_MS = 3 * 60_000;

/** @param {string} value @returns {number|undefined} */
function positiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

/** @param {string} suite @returns {number} */
function suiteTimeoutMs(suite) {
  return positiveInt(process.env.EZ_SUITE_TIMEOUT_MS)
    ?? SUITE_TIMEOUT_MS[suite]
    ?? DEFAULT_SUITE_TIMEOUT_MS;
}

/** @returns {number} */
function suiteIdleMs() {
  return positiveInt(process.env.EZ_SUITE_IDLE_MS) ?? DEFAULT_IDLE_MS;
}

/**
 * Suite order: cheap and self-contained first, so a basic breakage is
 * reported in seconds rather than after the slow full-stack suites.
 */
const PREFERRED_ORDER = [
  'ssl-path',
  'hub-permissions',
  'hublink',
  'ssl-challenge',
  'service',
  'dashboard-auth',
  'pairing-smoke',
  'domain-sync',
];

function listSuites() {
  const found = fs.readdirSync(E2E_DIR)
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => f.replace(/\.test\.mjs$/, ''));

  const known = PREFERRED_ORDER.filter((n) => found.includes(n));
  // Anything new runs last rather than being silently skipped.
  const rest = found.filter((n) => !PREFERRED_ORDER.includes(n)).sort();
  return [...known, ...rest];
}

/**
 * Preflight: no suite may be able to reach src/ before the guard has run.
 *
 * Two rules, both about static imports only — a dynamic `await import()`
 * happens after the module body, by which point the guard has executed:
 *
 *   1. the FIRST static import must be e2e/lib/guard.mjs;
 *   2. no static import may resolve into src/.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkStaticImports() {
  const problems = [];

  for (const suite of listSuites()) {
    const file = path.join(E2E_DIR, `${suite}.test.mjs`);
    const source = fs.readFileSync(file, 'utf8');

    // Static import specifiers, in source order. `import(` is deliberately not
    // matched: a dynamic import is fine.
    const specifiers = [...source.matchAll(/^\s*import\s[^\n]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm)]
      .map((m) => m[1] ?? m[2]);

    if (specifiers.length === 0) {
      problems.push(`${suite}: has no static imports, so it cannot import the guard first`);
      continue;
    }

    if (specifiers[0] !== GUARD_IMPORT) {
      problems.push(
        `${suite}: first static import is '${specifiers[0]}', must be '${GUARD_IMPORT}'\n` +
        '      ESM evaluates imports in order, so the guard has to come first to run first.'
      );
    }

    for (const spec of specifiers) {
      // Relative specifiers that climb out of e2e/ and into the app.
      if (/^\.{1,2}\//.test(spec) && !spec.startsWith('./lib/')) {
        const resolved = path.resolve(E2E_DIR, spec);
        if (resolved.startsWith(path.join(ROOT, 'src'))) {
          problems.push(
            `${suite}: statically imports '${spec}', which reaches src/ before the guard can help\n` +
            '      Load core modules with a dynamic await import() inside the suite instead.'
          );
        }
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Removes a directory, retrying while Windows releases SQLite handles. */
function rmWithRetry(dir, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* retry */ }
    if (!fs.existsSync(dir)) return true;
    const until = Date.now() + 400;
    while (Date.now() < until) { /* brief spin */ }
  }
  return !fs.existsSync(dir);
}

/**
 * Runs one suite in its own process, with its own temporary data directory,
 * under a wall-clock limit and a no-output watchdog.
 *
 * @param {string} suite
 * @param {{
 *   file?: string,            // a different entry file (the timeout self-test)
 *   timeoutMs?: number,       // wall-clock limit, overriding the map and env
 *   idleMs?: number,          // no-output limit, overriding env
 *   env?: Record<string,string>, // extra variables for the child
 * }} [options]
 * @returns {Promise<{
 *   suite: string, code: number, ms: number, cleaned: boolean, pid: number|null,
 *   timeout: { kind: 'wall'|'idle', afterMs: number, step: string|null }|null,
 *   counts: { passed: number, failed: number, skipped: number, checks: number,
 *             coarse: boolean, unknown: boolean, step: string|null,
 *             reasons: Array<{ reason: string, count: number }> },
 * }>}
 */
function runSuite(suite, { file = null, timeoutMs = null, idleMs = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ez-e2e-${suite}-`));
    const dataDir = path.join(dataRoot, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    // A pre-created 0-byte file so db.js's legacy migration — which RENAMES
    // data/easy-devops.sqlite — can never run against the real installation.
    fs.writeFileSync(path.join(dataDir, 'easy-devops.sqlite'), '');

    const started = Date.now();
    const counter = createSuiteCounter();
    const wallMs = timeoutMs ?? suiteTimeoutMs(suite);
    const idleLimitMs = idleMs ?? suiteIdleMs();

    process.stdout.write(`\n${'═'.repeat(70)}\n`);
    process.stdout.write(`  ${suite}\n`);
    process.stdout.write(`  data: ${dataDir}\n`);
    process.stdout.write(`${'═'.repeat(70)}\n`);

    // The suite writes into a file, not a pipe: see "Why the suite's stdout is a
    // FILE" at the top. The child gets its own handle; the parent keeps only the
    // path, and reads it as it grows.
    const outputPath = path.join(dataRoot, 'output.log');
    const outputFd = fs.openSync(outputPath, 'w');

    const child = spawn(process.execPath, [file ?? path.join(E2E_DIR, `${suite}.test.mjs`)], {
      cwd: ROOT,
      // Both variables are in the environment before Node starts, which is
      // the whole point: no import can run before they are set.
      env: {
        ...process.env,
        EZ_TEST: '1',
        EASY_DEVOPS_DATA_DIR: dataDir,
        ...env,
      },
      // stdin and stderr stay inherited. stdout goes to the file opened above.
      stdio: ['inherit', outputFd, 'inherit'],
      windowsHide: true,
    });
    // The child holds its own descriptor now; ours would only keep the file
    // locked on Windows.
    try { fs.closeSync(outputFd); } catch { /* the child owns it */ }

    let finished = false;
    let wallTimer = null;
    let idleTimer = null;
    let pollTimer = null;
    let readerFd = null;
    let readPos = 0;
    /** Reassembled across chunks; declared here because `finish` flushes it. */
    let pending = '';
    /** Completes a multi-byte character split across two reads. */
    const decoder = new StringDecoder('utf8');
    /** Set when the runner had to end the suite; its presence makes it a FAIL. */
    let timeoutInfo = null;

    /**
     * Forwards everything new in the output file, and counts it. Called on a
     * timer while the suite runs, and in a loop before the verdict.
     */
    const pump = () => {
      if (readerFd === null) {
        try { readerFd = fs.openSync(outputPath, 'r'); } catch { return; }
      }
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        let bytes = 0;
        try {
          bytes = fs.readSync(readerFd, buffer, 0, buffer.length, readPos);
        } catch {
          return;
        }
        if (bytes <= 0) return;
        readPos += bytes;

        const chunk = decoder.write(buffer.subarray(0, bytes));
        if (chunk) {
          process.stdout.write(chunk);
          armIdle();
          // Lines are reassembled across reads: the file is read in blocks, and
          // a suite's line can straddle a block. Carriage returns count as
          // terminators too, because progress lines redraw with them.
          const parts = `${pending}${chunk}`.split(/\r\n|\n|\r/);
          pending = parts.pop() ?? '';
          for (const line of parts) counter.add(line);
        }
      }
    };

    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(wallTimer);
      clearTimeout(idleTimer);
      clearInterval(pollTimer);
      if (pending) counter.add(pending);
      if (readerFd !== null) {
        try { fs.closeSync(readerFd); } catch { /* already closed */ }
        readerFd = null;
      }

      const ms = Date.now() - started;

      // A suite can print "52 PASS 0 FAIL" and still be recorded as failed,
      // because the verdict is the EXIT CODE — a suite killed by a signal, or
      // one that throws after its summary, reports no failing assertion at
      // all. Saying how the child ended turns that from a mystery into a fact.
      // A suite the runner killed is a failure whatever it managed to print.
      const counts = counter.summary();
      let exitCode = timeoutInfo ? ((code ?? 0) || 1) : (code ?? 1);

      // Exit 0 with no summary line is not a pass: either the output was cut
      // off (ssl-preflight lost its last five groups and its TOTAL this way) or
      // the suite returned before it finished. The one-verdict suites are the
      // exception, and they are recognised by the verdict line they do print.
      const truncated = !timeoutInfo && exitCode === 0 && !counts.complete && !counts.verdictOnly;
      if (truncated) exitCode = 1;

      if (timeoutInfo) {
        process.stderr.write(`  ! ${timeoutLine(suite, timeoutInfo.kind, timeoutInfo.afterMs, timeoutInfo.step)}\n`);
      } else if (truncated) {
        process.stderr.write(`  ! ${truncatedLine(suite)}\n`);
      } else if (exitCode !== 0) {
        process.stderr.write(
          `  ! ${suite} ended with ${signal ? `signal ${signal}` : `exit code ${exitCode}`}\n`,
        );
      }

      const cleaned = rmWithRetry(dataRoot);
      if (!cleaned) {
        process.stderr.write(`  ! could not remove ${dataRoot}\n`);
      }

      resolve({
        suite,
        code: exitCode,
        ms,
        cleaned,
        signal: signal ?? null,
        pid: child.pid ?? null,
        timeout: timeoutInfo,
        truncated,
        counts,
      });
    };

    /**
     * Ends the suite because it overran a limit. The step is captured now: the
     * problem is where it was stuck, not where the kill finished.
     */
    const expired = (kind) => {
      if (finished || timeoutInfo) return;
      const step = counter.summary().step;
      timeoutInfo = { kind, afterMs: kind === 'idle' ? idleLimitMs : wallMs, step };

      process.stderr.write(
        `\n  ! ${suite} ${kind === 'idle'
          ? `printed nothing for ${Math.round(idleLimitMs / 1000)} s`
          : `ran past ${Math.round(wallMs / 1000)} s`} — killing its process tree\n`,
      );

      // The tree, not just the child: a suite that hangs usually leaves a
      // child of its own restarting (native-service's supervisor did).
      killProcessTree(child.pid)
        .then(({ killed, survivors }) => {
          if (!killed || survivors.length > 0) {
            process.stderr.write(
              `  ! ${suite}: process(es) survived the kill: ${survivors.join(', ') || child.pid}\n`,
            );
          }
          // 'close' normally arrives once the tree is gone; this is the backstop
          // for a process that cannot be killed at all.
          finish(1, 'EZ_TIMEOUT');
        })
        .catch((error) => {
          process.stderr.write(`  ! ${suite}: could not kill its process tree: ${error?.message ?? error}\n`);
          finish(1, 'EZ_TIMEOUT');
        });
    };

    wallTimer = setTimeout(() => expired('wall'), wallMs);
    const armIdle = () => {
      if (finished) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => expired('idle'), idleLimitMs);
    };
    armIdle();

    pollTimer = setInterval(pump, 100);

    child.on('close', async (code, signal) => {
      // 'close', not 'exit': it arrives once the child is gone and its stdio is
      // released. Then read the file to its end, waiting for the size to stop
      // growing, so a write the OS flushed late is not lost.
      clearInterval(pollTimer);
      let lastSize = -1;
      for (let attempt = 0; attempt < 10; attempt++) {
        let size = 0;
        try { size = fs.statSync(outputPath).size; } catch { /* not created */ }
        pump();
        if (size === lastSize && size === readPos) break;
        lastSize = size;
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      pump();
      if (pending) counter.add(pending);
      pending = '';
      const tail = decoder.end();
      if (tail) process.stdout.write(tail);
      finish(code, signal);
    });

    child.on('error', (err) => {
      process.stderr.write(`  ! could not start ${suite}: ${err.message}\n`);
      finish(1, null);
    });
  });
}

/**
 * Proves the timeout path works, without needing a real suite that hangs.
 *
 * The fixture (e2e/lib/self-test-hang.mjs, not a suite, so a normal run never
 * sees it) prints one step and spawns one child, then waits forever. It is run
 * twice through the real `runSuite`, once for each limit, and each case asserts:
 *
 *   - the right limit fired (`wall` or `idle`), at the step it printed;
 *   - the FAIL line is exactly the one the summary would print, naming the
 *     suite and the step;
 *   - the exit code is non-zero, so the run fails;
 *   - both the suite and the child it spawned are gone.
 *
 * @returns {Promise<boolean>} True when every assertion held
 */
async function selfTestTimeout() {
  const name = 'self-test-timeout';
  const pidFile = path.join(os.tmpdir(), `ez-e2e-selftest-child-${process.pid}.pid`);
  const fixture = path.join(E2E_DIR, 'lib', 'self-test-hang.mjs');

  process.stdout.write('\nSELF-TEST: a suite that prints a step and then hangs\n');

  /**
   * @param {{ timeoutMs: number, idleMs: number, expected: string }} scenario
   * @returns {Promise<string[]>} Problems; empty means it held
   */
  const runCase = async ({ timeoutMs, idleMs, expected }) => {
    await waitProcessGone(Number(
      fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : NaN,
    ), 1000);
    try { fs.rmSync(pidFile, { force: true }); } catch { /* already gone */ }

    const result = await runSuite(name, {
      file: fixture,
      timeoutMs,
      idleMs,
      env: { EZ_SELF_TEST_PID_FILE: pidFile },
    });

    const problems = [];
    const line = result.timeout
      ? timeoutLine(result.suite, result.timeout.kind, result.timeout.afterMs, result.timeout.step)
      : '(no timeout recorded)';
    process.stdout.write(`  FAIL line: ${line}\n`);

    if (!result.timeout) {
      problems.push('the hang was not reported as a timeout');
    } else if (result.timeout.step !== '1. self-test step') {
      problems.push(`step was '${String(result.timeout.step)}', expected '1. self-test step'`);
    }

    if (line !== expected) problems.push(`expected the line: ${expected}`);
    if (result.code === 0) problems.push('the timed-out suite did not fail the run');

    const grandchild = Number(
      fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : NaN,
    );
    if (!Number.isFinite(grandchild) || grandchild <= 0) {
      problems.push('the fixture did not record the pid of the child it spawned');
    } else if (!(await waitProcessGone(grandchild, 5000))) {
      problems.push(`the suite's child process ${grandchild} is still running`);
    }

    if (result.pid && !(await waitProcessGone(result.pid, 5000))) {
      problems.push(`the suite process ${result.pid} is still running`);
    }

    if (result.ms > 30_000) {
      problems.push(`the limit took ${Math.round(result.ms / 1000)} s to act`);
    }

    return problems;
  };

  try {
    const wall = await runCase({
      timeoutMs: 3000,
      // The fixture prints its step immediately: the wall limit must be the
      // one that fires.
      idleMs: 60_000,
      expected: 'self-test-timeout: FAIL (timed out after 3 s at step: 1. self-test step)',
    });
    const idle = await runCase({
      timeoutMs: 60_000,
      idleMs: 2000,
      expected: 'self-test-timeout: FAIL (no output for 2 s after step: 1. self-test step)',
    });

    const problems = [...wall, ...idle];
    if (problems.length === 0) {
      process.stdout.write(
        'SELF-TEST: PASS — both limits killed the suite and its child, and each FAIL line names the step\n',
      );
      return true;
    }

    process.stdout.write('SELF-TEST: FAIL\n');
    for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
    return false;
  } finally {
    try { fs.rmSync(pidFile, { force: true }); } catch { /* already gone */ }
  }
}

/**
 * Proves the counting rules without needing real suites: counts stay inside the
 * suite that printed them, the last TOTAL line wins, and an exit-0 suite with no
 * summary line is a FAILURE.
 *
 * The fixture (e2e/lib/self-test-report.mjs, not a suite) prints one shape per
 * `EZ_SELF_TEST_CASE` and exits the way a suite does, `process.exit()` after its
 * last write.
 *
 * @returns {Promise<boolean>} True when every assertion held
 */
async function selfTestReport() {
  const fixture = path.join(E2E_DIR, 'lib', 'self-test-report.mjs');

  /** @param {string} caseName @param {string} suiteName */
  const runCase = (suiteName, caseName) => runSuite(suiteName, {
    file: fixture,
    env: { EZ_SELF_TEST_CASE: caseName },
  });

  process.stdout.write('\nSELF-TEST: per-suite counts, last TOTAL wins, no-summary is a failure\n');

  const problems = [];
  const expectCounts = (label, result, passed, checks) => {
    const c = result.counts;
    if (c.passed !== passed || c.checks !== checks) {
      problems.push(`${label}: counted ${c.passed}/${c.checks}, expected ${passed}/${checks}`);
    }
    if (result.code !== 0) problems.push(`${label}: exited ${result.code}, expected 0`);
  };

  // Two suites in sequence, through the real runner path: each count must come
  // only from its own child's output.
  const first = await runCase('self-test-report-a', 'a');
  const second = await runCase('self-test-report-b', 'b');
  expectCounts('self-test-report-a', first, 5, 5);
  expectCounts('self-test-report-b', second, 3, 3);
  if (!first.counts.complete) problems.push('self-test-report-a: no summary line was recognised');
  if (!second.counts.complete) problems.push('self-test-report-b: no summary line was recognised');

  // Two TOTAL lines in one suite: the last one wins.
  const twice = await runCase('self-test-report-twototals', 'twototals');
  expectCounts('self-test-report-twototals', twice, 2, 2);

  // Exit 0 with no TOTAL and no one-verdict line: a failure, named as one.
  const silent = await runCase('self-test-report-nosummary', 'nosummary');
  const line = truncatedLine('self-test-report-nosummary');
  process.stdout.write(`  no-summary line: ${line}\n`);
  if (silent.code === 0) problems.push('a suite that exited 0 without a summary line passed');
  if (!silent.truncated) problems.push('the no-summary suite was not marked truncated');
  if (line !== 'self-test-report-nosummary: FAIL (exited 0 but printed no summary line; output may have been cut off)') {
    problems.push(`the no-summary line reads: ${line}`);
  }

  // `TOTAL n   PASS n   FAIL 0   SKIP n` — SKIP after FAIL, as leftover-data
  // prints it. It is a finished suite, and its own skip count wins.
  const skipAfter = await runCase('self-test-report-skipafter', 'skipafter');
  if (!skipAfter.counts.complete) problems.push('self-test-report-skipafter: a SKIP-after-FAIL summary was not recognised');
  if (skipAfter.counts.skipped !== 1) {
    problems.push(`self-test-report-skipafter: skipped ${skipAfter.counts.skipped}, expected 1 from the TOTAL line`);
  }
  if (skipAfter.counts.checks !== 4) {
    problems.push(`self-test-report-skipafter: counted ${skipAfter.counts.checks} checks, expected the TOTAL's 4`);
  }
  if (skipAfter.truncated) problems.push('self-test-report-skipafter: reported as cut off');
  if (skipAfter.code !== 0) problems.push(`self-test-report-skipafter: exited ${skipAfter.code}, expected 0`);

  // One verdict at column 0, single space, between `[hubAgent] ...` log lines,
  // as nginx-domain-security prints it.
  const verdict = await runCase('self-test-report-verdict', 'verdict');
  if (verdict.truncated) problems.push('self-test-report-verdict: a one-verdict suite was reported as cut off');
  if (!verdict.counts.verdictOnly) problems.push('self-test-report-verdict: the verdict line was not recognised');
  if (verdict.code !== 0) problems.push(`self-test-report-verdict: exited ${verdict.code}, expected 0`);

  if (problems.length === 0) {
    process.stdout.write('SELF-TEST: PASS — counts stay per suite, the last TOTAL wins, no summary is a failure\n');
    return true;
  }

  process.stdout.write('SELF-TEST: FAIL\n');
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const windowsOnly = args.includes('--windows-only');
  let names = args.filter((a) => !a.startsWith('-')).map((a) => a.replace(/\.test\.mjs$/, ''));

  // ── The self-tests ────────────────────────────────────────────────────────
  //
  // They run before the preflight and touch no suite, so they still work while
  // src/ is mid-change in another lane — which is exactly when a runner's
  // verdicts need to be trustworthy.
  if (args.includes('--self-test-timeout')) {
    process.exit((await selfTestTimeout()) ? 0 : 1);
  }
  if (args.includes('--self-test-report')) {
    process.exit((await selfTestReport()) ? 0 : 1);
  }
  if (args.includes('--self-test')) {
    const timeout = await selfTestTimeout();
    const report = await selfTestReport();
    process.exit(timeout && report ? 0 : 1);
  }

  const available = listSuites();

  const unknown = names.filter((n) => !available.includes(n));
  if (unknown.length > 0) {
    process.stderr.write(
      `\nUnknown suite(s): ${unknown.join(', ')}\n` +
      `Available: ${available.join(', ')}\n\n`
    );
    process.exit(1);
  }

  // ── Windows-only mode ─────────────────────────────────────────────────────
  //
  // Some suites hold groups that can only run on Windows (the ACL transaction,
  // the WinSW XML, the runtime copy). Off Windows those groups are skips, and a
  // release needs them run for real — so this mode names them instead of
  // leaving a skip count in a summary nobody reads.
  //
  // Group-level selection would need a switch inside every suite, which this
  // runner does not have; running the whole suite is the equivalent, and on
  // Windows it is what actually exercises the groups.
  const windowsSuites = available.filter((suite) => isWindowsOnlySuite(
    suite,
    fs.readFileSync(path.join(E2E_DIR, `${suite}.test.mjs`), 'utf8'),
  ));

  if (windowsOnly && !ON_WINDOWS) {
    process.stdout.write('\nWindows-only groups: ');
    process.stdout.write(`skipped: this machine is not Windows (${hostLabel()})\n\n`);
    process.stdout.write(
      `  ${windowsSuites.length} suite(s) hold groups that only run on Windows:\n` +
      `    ${windowsSuites.join(', ')}\n\n` +
      '  Every one of them must run on a real Windows machine before a release.\n' +
      '  Run this there, in an elevated PowerShell:\n\n' +
      '    node e2e/run.mjs --windows-only\n\n',
    );
    process.exit(0);
  }

  if (windowsOnly) {
    const outside = names.filter((n) => !windowsSuites.includes(n));
    if (outside.length > 0) {
      process.stderr.write(
        `\n${outside.join(', ')} ${outside.length === 1 ? 'has' : 'have'} no Windows-only group.\n` +
        `--windows-only covers: ${windowsSuites.join(', ')}\n\n` +
        'Run the whole set with: node e2e/run.mjs --windows-only\n\n'
      );
      process.exit(1);
    }
    names = names.length > 0 ? names : windowsSuites;
  }

  // ── Preflight ─────────────────────────────────────────────────────────────
  const check = checkStaticImports();
  process.stdout.write('\nStatic-import check: ');
  if (!check.ok) {
    process.stdout.write(`FAIL (${check.problems.length} problem(s))\n\n`);
    for (const p of check.problems) process.stdout.write(`  - ${p}\n`);
    process.stdout.write(
      '\nA suite must import e2e/lib/guard.mjs first and reach src/ only through\n' +
      'a dynamic import, so the guard runs before anything can resolve the data\n' +
      'directory.\n\n'
    );
    process.exit(1);
  }
  process.stdout.write('OK — every suite loads the guard first and reaches src/ dynamically\n');

  // ── Preflight: the API contract matches the code ──────────────────────────
  //
  // API-CONTRACT.md is authoritative, so it is held to the routes the
  // dashboard actually registers. A route added without documenting it fails
  // the run here rather than drifting quietly.
  //
  // This needs an EZ_TEST data directory, because reading the routers pulls in
  // controllers and therefore core/db.js. The runner allocates one for the
  // check itself, separate from the per-suite directories.
  const contractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-e2e-contract-'));
  const contractData = path.join(contractRoot, 'data');
  fs.mkdirSync(contractData, { recursive: true });
  fs.writeFileSync(path.join(contractData, 'easy-devops.sqlite'), '');

  const previousTest = process.env.EZ_TEST;
  const previousDir = process.env.EASY_DEVOPS_DATA_DIR;
  process.env.EZ_TEST = '1';
  process.env.EASY_DEVOPS_DATA_DIR = contractData;

  let contract;
  try {
    contract = await checkApiContract();
  } finally {
    if (previousTest === undefined) delete process.env.EZ_TEST;
    else process.env.EZ_TEST = previousTest;
    if (previousDir === undefined) delete process.env.EASY_DEVOPS_DATA_DIR;
    else process.env.EASY_DEVOPS_DATA_DIR = previousDir;

    // Release the SQLite handle the import opened, or Windows will not let the
    // directory be removed.
    try {
      const dbMod = await import(pathToFileURL(path.join(ROOT, 'src/core/db.js')).href);
      dbMod.closeDb();
    } catch { /* never loaded */ }
    rmWithRetry(contractRoot);
  }

  process.stdout.write('API contract check : ');
  if (!contract.ok) {
    process.stdout.write(`FAIL (${contract.problems.length} problem(s))\n\n`);
    for (const p of contract.problems) process.stdout.write(`  - ${p}\n`);
    process.stdout.write(
      '\nAPI-CONTRACT.md is authoritative: any change to an endpoint updates\n' +
      'that file in the same change. Fix the document, or the route.\n\n'
    );
    process.exit(1);
  }
  process.stdout.write(`OK — ${contract.counts.code} registered route(s), all documented\n`);

  if (checkOnly) process.exit(0);

  const suites = names.length > 0 ? names : available;
  const fullRun = names.length === 0;

  // ── Run ───────────────────────────────────────────────────────────────────
  const results = [];
  for (const suite of suites) {
    results.push(await runSuite(suite));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.code !== 0);
  const timedOut = results.filter((r) => r.timeout);
  const dirty = results.filter((r) => !r.cleaned);

  process.stdout.write(`\n${'═'.repeat(70)}\n  SUMMARY\n${'═'.repeat(70)}\n`);

  for (const r of results) {
    const c = r.counts;

    if (r.timeout) {
      // The one line the self-test asserts, and the one an operator needs:
      // the suite, the limit, and the step it had reached.
      process.stdout.write(
        `  ${timeoutLine(r.suite, r.timeout.kind, r.timeout.afterMs, r.timeout.step)}`
        + `  (${(r.ms / 1000).toFixed(1)}s)\n`,
      );
      continue;
    }

    if (r.truncated) {
      process.stdout.write(`  ${truncatedLine(r.suite)}  (${(r.ms / 1000).toFixed(1)}s)\n`);
      continue;
    }

    const mark = r.code === 0 ? 'PASS' : 'FAIL';

    let line = `  ${r.suite}: ${mark} `;
    if (c.unknown) {
      // The suite prints nothing this runner can count (assert-alone style, or
      // a crash before its summary). Say that rather than invent a number.
      line += 'no check counts printed';
    } else {
      line += `${c.passed}/${c.checks}, skipped ${c.skipped}`;
      if (c.coarse) line += ' (one verdict for the file, not per-check counts)';
    }
    line += `  (${(r.ms / 1000).toFixed(1)}s)`;
    process.stdout.write(`${line}\n`);

    if (c.skipped > 0) {
      // Deduplicated and capped: the reason is what makes a Windows group
      // visible, and thirty lines of the same reason are not.
      process.stdout.write(`      skipped: ${describeReasons(c.reasons)}\n`);
    }
  }

  // A timed-out or truncated suite's counts stop where it did: they are not a
  // total of anything, so they are kept out of the run's check totals.
  const counted = results.filter((r) => !r.timeout && !r.truncated);
  const totals = counted.reduce((acc, r) => ({
    passed: acc.passed + r.counts.passed,
    failed: acc.failed + r.counts.failed,
    skipped: acc.skipped + r.counts.skipped,
    checks: acc.checks + r.counts.checks,
    unknown: acc.unknown + (r.counts.unknown ? 1 : 0),
  }), { passed: 0, failed: 0, skipped: 0, checks: 0, unknown: 0 });

  process.stdout.write(`${'─'.repeat(70)}\n`);

  const label = windowsOnly ? 'WINDOWS-ONLY RUN' : fullRun ? 'FULL NPM TEST' : 'E2E RUN (subset)';
  process.stdout.write(
    `  ${label}: ${results.length} suite(s), ${results.length - failed.length} passed, ` +
    `${failed.length} failed; checks ${totals.passed}/${totals.checks}, skipped ${totals.skipped}\n`,
  );
  if (totals.unknown > 0) {
    process.stdout.write(
      `  ${totals.unknown} suite(s) printed no per-check counts; their checks are not in that total\n`,
    );
  }

  // Timed out is its own list: those suites did not finish, so a pass/fail
  // count would say less than the step they died on.
  if (timedOut.length === 0) {
    process.stdout.write('  TIMED OUT: none\n');
  } else {
    process.stdout.write(
      `  TIMED OUT: ${timedOut.map((r) => (
        `${r.suite} (${timeoutReason(r.timeout.kind, r.timeout.afterMs, r.timeout.step)})`
      )).join(', ')}\n`,
    );
  }

  // Every suite with a skip, named — a suite that skipped everything is still
  // PASS, and still has to appear here.
  const withSkips = counted.filter((r) => r.counts.skipped > 0);
  if (withSkips.length === 0) {
    process.stdout.write('  SUITES WITH SKIPS: none\n');
  } else {
    process.stdout.write(
      `  SUITES WITH SKIPS: ${withSkips.map((r) => `${r.suite} (${r.counts.skipped})`).join(', ')}\n`,
    );
  }

  if (dirty.length > 0) {
    process.stdout.write(`  ! ${dirty.length} temporary directory/ies could not be removed\n`);
  }

  // Whether the Windows-only groups actually ran, said plainly either way.
  if (windowsOnly) {
    process.stdout.write(
      `\n  Windows-only groups ran on: ${hostLabel()} ` +
      `(${results.length} suite(s): ${results.map((r) => r.suite).join(', ')})\n`,
    );
  } else if (fullRun && !ON_WINDOWS) {
    process.stdout.write(
      `\n  Windows-only groups: ${windowsSuites.length} suite(s) hold groups that only run on ` +
      `Windows (${windowsSuites.join(', ')}).\n` +
      '  They were skipped on this machine. Every one of them must run on a real\n' +
      '  Windows machine before a release:\n\n' +
      '    node e2e/run.mjs --windows-only\n',
    );
  }

  process.stdout.write('\n');

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`\nRunner error: ${err.stack}\n`);
  process.exit(1);
});
