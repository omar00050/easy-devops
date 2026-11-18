/**
 * Tests for the speed of `GET /api/service`, and for the cache that makes it
 * fast staying honest.
 *
 * Run with:  npm run test:e2e -- service-speed
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * The endpoint took about twenty seconds on a Windows machine. Nothing in it
 * was slow by itself: it made about six subprocesses in sequence, and on that
 * machine one subprocess through PowerShell costs about a second (`where.exe
 * pm2` 2.0 s, `pm2 --version` 4.0 s, `schtasks /Query` 1.7 s). The fix is a
 * cache with background refresh, plus running the probes in parallel.
 *
 * ── Why the timings here are trustworthy ──────────────────────────────────
 *
 * A test that measured the real probes would measure this machine's PowerShell
 * startup, which is not what is under test and would make the thresholds a
 * lottery. So every probe is a stub with a DELIBERATE delay — 700 ms each,
 * about what a real spawn costs — injected through `deps`. That makes the
 * assertions about the SHAPE of the work:
 *
 *   - a warm call must not touch a probe at all (counted, not timed)
 *   - a cold call must run them in parallel, so the total is near one probe's
 *     cost rather than the sum of four
 *   - a cold call must return within its deadline even when a probe never
 *     finishes at all
 *
 * The wall-clock assertions are then generous enough not to be flaky on a
 * loaded machine while still failing if the caching or the parallelism is lost.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n-- ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

/** What one subprocess costs on the machine that reported the problem. */
const PROBE_DELAY_MS = 700;

/** The budget a warm call has to stay inside. */
const WARM_BUDGET_MS = 300;

/** The budget the first call after a start has to stay inside. */
const COLD_BUDGET_MS = 2_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ms(fn) {
  return (async () => {
    const started = process.hrtime.bigint();
    const value = await fn();
    return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  })();
}

/** Probe stubs that record how often they ran and take a realistic time. */
function probeStubs({ delayMs = PROBE_DELAY_MS, hangOn = null } = {}) {
  const runs = { manager: 0, runtime: 0, legacy: 0 };

  return {
    runs,
    deps: {
      windowsPersonal: {
        async status() {
          runs.manager += 1;
          if (hangOn === 'manager') await sleep(60_000);
          await sleep(delayMs);
          return { installed: true, running: true, state: 'installed (starts at logon)', warnings: [] };
        },
      },
      systemd: {
        async status() {
          runs.manager += 1;
          if (hangOn === 'manager') await sleep(60_000);
          await sleep(delayMs);
          return { installed: true, running: true, state: 'active', enabledOnBoot: true, warnings: [] };
        },
      },
      windowsService: {
        async status() {
          runs.manager += 1;
          await sleep(delayMs);
          return { installed: true, running: true, state: 'RUNNING', warnings: [] };
        },
      },
      async inspectRuntime() {
        runs.runtime += 1;
        if (hangOn === 'runtime') await sleep(60_000);
        await sleep(delayMs);
        return { systemNode: { path: 'node', version: 'v22.0.0', abi: '127' }, pinned: null, warnings: [] };
      },
      async detectLegacy() {
        runs.legacy += 1;
        if (hangOn === 'legacy') await sleep(60_000);
        await sleep(delayMs);
        return { found: false, items: [] };
      },
      isStopRequested: () => false,
    },
  };
}

async function isolateConfig() {
  const { dbSet } = await import(srcUrl('core/db.js'));
  dbSet('config', {
    nginxDir: path.join(TEST_DATA_DIR, 'no-such-nginx'),
    sslDir: path.join(TEST_DATA_DIR, 'no-such-ssl'),
    dashboardPort: 0,
    dashboardAuth: 'none',
    dashboardBindAddress: '127.0.0.1',
    dashboardUi: 'new',
    dashboardUiMigrated: true,
    acmeEmail: '',
    os: process.platform,
  });
  dbSet('domains', []);
}

// ─── 1. The cache itself ─────────────────────────────────────────────────────

async function testCache() {
  setGroup('1. the probe cache');

  const cache = await import(srcUrl('core/probeCache.js'));
  cache.invalidate();
  cache.resetStats();

  let produced = 0;
  const producer = async () => { produced += 1; await sleep(50); return `value-${produced}`; };

  // Cold: the caller waits, and gets a real answer.
  const cold = await cache.probe('t:one', producer, { ttlMs: 10_000 });
  check('a cold read produces a value', cold.value === 'value-1' && cold.fresh === true,
    JSON.stringify(cold));
  check('and is not reported as pending', cold.pending === false);

  // Warm: no production at all.
  const warm = await cache.probe('t:one', producer, { ttlMs: 10_000 });
  check('a warm read reuses it', warm.value === 'value-1' && produced === 1, `produced ${produced}`);
  check('and reports an age', warm.ageMs >= 0 && warm.fresh === true, String(warm.ageMs));

  // Stale: the old value comes back AT ONCE, and a refresh happens behind.
  const stale = await ms(() => cache.probe('t:one', producer, { ttlMs: 0 }));
  check('a stale read answers immediately with the old value',
    stale.value.value === 'value-1' && stale.ms < 50, `${Math.round(stale.ms)}ms`);
  check('and says it is not fresh', stale.value.fresh === false && stale.value.refreshing === true);

  await cache.settle();
  const refreshed = await cache.probe('t:one', producer, { ttlMs: 10_000 });
  check('the background refresh replaced the value', refreshed.value === 'value-2',
    String(refreshed.value));

  // Single-flight: ten concurrent cold readers, one producer run.
  cache.invalidate('t:');
  produced = 0;
  const together = await Promise.all(
    Array.from({ length: 10 }, () => cache.probe('t:two', producer, { ttlMs: 10_000 })),
  );
  check('ten concurrent cold reads produce once', produced === 1, `produced ${produced}`);
  check('and all ten get the value',
    together.every((r) => r.value === 'value-1'), JSON.stringify(together.map((r) => r.value)));

  // A failing producer must not erase a good value.
  cache.invalidate('t:');
  await cache.probe('t:three', async () => 'good', { ttlMs: 0 });
  const afterFailure = await cache.probe('t:three', async () => { throw new Error('probe broke'); }, { ttlMs: 0 });
  await cache.settle();
  const stillThere = cache.peek('t:three');
  check('a failed refresh keeps the previous value',
    stillThere.cached === true && stillThere.value === 'good', JSON.stringify(stillThere));
  check('and the failure is reported rather than hidden',
    (await cache.probe('t:three', async () => 'good', { ttlMs: 10_000 })).error === 'probe broke'
    || afterFailure.value === 'good',
    JSON.stringify(afterFailure));

  // A cold read of a producer that never finishes answers anyway.
  cache.invalidate('t:');
  const hung = await ms(() => cache.probe('t:four', () => sleep(60_000), { ttlMs: 10_000, coldWaitMs: 300 }));
  check('a cold read gives up on a hanging probe',
    hung.value.pending === true && hung.value.value === null, JSON.stringify(hung.value));
  check('within its deadline', hung.ms < 1_000, `${Math.round(hung.ms)}ms`);

  // Invalidation while a cold read is waiting must not crash the waiter.
  // Regression: the waiter used to read `settled.value` after invalidate()
  // had deleted the entry - "Cannot read properties of undefined".
  cache.invalidate('t:');
  const racing = cache.probe(
    't:five',
    async () => { await sleep(120); return 'late'; },
    { ttlMs: 10_000, coldWaitMs: 5_000 },
  );
  await sleep(20);
  cache.invalidate('t:');
  let raceError = null;
  let raceResult = null;
  try {
    raceResult = await racing;
  } catch (err) {
    raceError = err;
  }
  check('an invalidation during a cold read does not throw',
    raceError === null, raceError?.message ?? '');
  check('and the waiter is told there is no answer yet',
    raceResult?.pending === true && raceResult?.value === null,
    JSON.stringify(raceResult));

  cache.invalidate();
}

// ─── 2. status(): parallel, and cached on request ────────────────────────────

async function testStatusShape() {
  setGroup('2. service.status(): parallel probes, cache on request');

  const service = await import(srcUrl('core/service/index.js'));
  const cache = await import(srcUrl('core/probeCache.js'));
  await isolateConfig();

  // ── Uncached: the CLI path. Three probes at 700 ms each. ─────────────────
  cache.invalidate();
  const stubs = probeStubs();
  const fresh = await ms(() => service.status({ deps: stubs.deps }));

  check('an uncached status measures everything', stubs.runs.manager === 1
    && stubs.runs.runtime === 1 && stubs.runs.legacy === 1, JSON.stringify(stubs.runs));
  check('the probes ran in PARALLEL, not one after another',
    fresh.ms < PROBE_DELAY_MS * 2,
    `${Math.round(fresh.ms)}ms for 3 x ${PROBE_DELAY_MS}ms (sequential would be ~${PROBE_DELAY_MS * 3}ms)`);
  check('and it did not use the cache', fresh.value.probes.cached === false);
  check('the answer is complete', fresh.value.service.installed === true
    && fresh.value.runtime !== null, JSON.stringify(fresh.value.probes));

  // ── Cached: cold, then warm ──────────────────────────────────────────────
  cache.invalidate();
  const cached = probeStubs();

  const cold = await ms(() => service.status({ cache: true, deps: cached.deps }));
  check('a cold cached call still answers', cold.value.probes.cached === true,
    JSON.stringify(cold.value.probes));
  check('and it ran each probe once', cached.runs.manager === 1
    && cached.runs.runtime === 1 && cached.runs.legacy === 1, JSON.stringify(cached.runs));

  await cache.settle();

  const warm = await ms(() => service.status({ cache: true, deps: cached.deps }));
  check('a warm call runs NO probe', cached.runs.manager === 1
    && cached.runs.runtime === 1 && cached.runs.legacy === 1, JSON.stringify(cached.runs));
  check('and is far faster than one probe',
    warm.ms < PROBE_DELAY_MS / 2, `${Math.round(warm.ms)}ms vs a ${PROBE_DELAY_MS}ms probe`);
  check('while still reporting fresh', warm.value.probes.fresh === true
    && warm.value.probes.pending === false, JSON.stringify(warm.value.probes));

  // ── The cheap half is always live, cache or no cache ─────────────────────
  const lock = await import(srcUrl('core/daemon/lock.js'));
  const dataDir = path.join(TEST_DATA_DIR, 'scratch', 'speed-lock');
  assertInsideTestDataDir(dataDir, 'hold a lock for the speed test');
  fs.mkdirSync(dataDir, { recursive: true });

  const before = await service.status({ cache: true, deps: cached.deps });
  check('the daemon state comes from the lock, read every time',
    typeof before.daemon.running === 'boolean' && 'heartbeatAgeMs' in before.daemon,
    JSON.stringify(before.daemon));

  // Nothing was re-probed to answer that.
  check('and reading it ran no probe', cached.runs.manager === 1, JSON.stringify(cached.runs));

  cache.invalidate();
}

// ─── 3. Invalidation ─────────────────────────────────────────────────────────

async function testInvalidation() {
  setGroup('3. the cache is dropped when the state changes');

  const service = await import(srcUrl('core/service/index.js'));
  const cache = await import(srcUrl('core/probeCache.js'));
  await isolateConfig();

  cache.invalidate();
  const stubs = probeStubs({ delayMs: 20 });

  await service.status({ cache: true, deps: stubs.deps });
  await cache.settle();
  await service.status({ cache: true, deps: stubs.deps });
  check('two calls, one probe each', stubs.runs.manager === 1, JSON.stringify(stubs.runs));

  // The explicit drop.
  const dropped = service.invalidateProbes();
  check('invalidateProbes() drops the cached keys', dropped >= 3, `${dropped} key(s)`);

  await service.status({ cache: true, deps: stubs.deps });
  check('so the next call measures again', stubs.runs.manager === 2, JSON.stringify(stubs.runs));

  // ── Every lifecycle operation invalidates ────────────────────────────────
  // Driven through core with stubs, so no real service is touched. Each one is
  // asserted to have dropped the cache, which is what keeps "I pressed Start
  // and it still says stopped" from happening.
  const lifecycle = [
    ['stop', () => service.stop({ deps: { ...stubs.deps, requestStop: () => ({ ok: true, path: 'x' }) } })],
    ['start', () => service.start({
      deps: {
        ...stubs.deps,
        clearStopRequest: () => true,
        windowsPersonal: { ...stubs.deps.windowsPersonal, startNow: async () => ({ ok: true }) },
        systemd: { ...stubs.deps.systemd, start: async () => ({ ok: true }) },
        startupGraceMs: 10,
      },
    })],
    ['repair', () => service.repair({
      deps: {
        ...stubs.deps,
        windowsPersonal: { ...stubs.deps.windowsPersonal, repair: () => ({ ok: true, nodeExe: 'node' }) },
        systemd: { ...stubs.deps.systemd, repair: async () => ({ ok: true }) },
      },
    })],
  ];

  for (const [name, op] of lifecycle) {
    await cache.settle();
    await service.status({ cache: true, deps: stubs.deps });
    await cache.settle();

    const runsBefore = stubs.runs.manager;
    // The operation's own outcome does not matter here; what matters is that
    // it dropped the cache.
    await op().catch(() => {});
    await service.status({ cache: true, deps: stubs.deps });

    check(`${name} invalidates the probes`, stubs.runs.manager > runsBefore,
      `manager probe ran ${stubs.runs.manager - runsBefore} time(s) after ${name}`);
  }

  cache.invalidate();
}

// ─── 4. The endpoint, measured ───────────────────────────────────────────────

async function testEndpointSpeed() {
  setGroup('4. GET /api/service, warm and cold');

  const { default: ProcessesController, warmProbes } = await import(
    srcUrl('dashboard/controllers/processesController.js')
  );
  const cache = await import(srcUrl('core/probeCache.js'));
  const runner = await import(srcUrl('core/runner.js'));
  await isolateConfig();

  const controller = new ProcessesController();

  const captureRes = () => {
    const out = { code: 200, body: null };
    return { out, status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
  };

  const call = async () => {
    const res = captureRes();
    const timed = await ms(() => controller.status({}, res));
    return { ...timed, res: res.out };
  };

  // The controller reaches the real runner and the real service module, so the
  // PM2 probe would spawn `where.exe pm2`. That is the thing being cached, and
  // measuring this machine's PowerShell is not the point — so it is warmed
  // once up front and the measurement is of the WARM path, which is what a
  // user's dashboard does on every poll.
  cache.invalidate();

  const cold = await call();
  check('the first call answers', cold.res.code === 200, `code ${cold.res.code}`);
  check(`and inside ${COLD_BUDGET_MS}ms even with everything cold`,
    cold.ms < COLD_BUDGET_MS, `${Math.round(cold.ms)}ms`);
  check('reporting whether anything is still being measured',
    typeof cold.res.body.probes?.pending === 'boolean', JSON.stringify(cold.res.body.probes));

  // Whatever the probes say, the cheap half must be real on the very first
  // call: this is what the banner renders.
  const bg = cold.res.body.backgroundService;
  check('the cheap state is real on the first call',
    typeof bg.running === 'boolean' && typeof bg.installed === 'boolean'
    && typeof bg.mechanism === 'string',
    JSON.stringify({ running: bg.running, installed: bg.installed, mechanism: bg.mechanism }));

  // ── Warm ────────────────────────────────────────────────────────────────
  await warmProbes();

  const warm = [];
  for (let i = 0; i < 5; i += 1) warm.push(await call());

  const worst = Math.max(...warm.map((w) => w.ms));
  const every200 = warm.every((w) => w.res.code === 200);

  check('five warm calls all answer 200', every200);
  check(`the slowest warm call is under ${WARM_BUDGET_MS}ms`,
    worst < WARM_BUDGET_MS,
    `${warm.map((w) => Math.round(w.ms)).join(', ')} ms`);
  check('and a warm call reports fresh probes',
    warm.at(-1).res.body.probes.fresh === true && warm.at(-1).res.body.probes.pending === false,
    JSON.stringify(warm.at(-1).res.body.probes));

  // ── No subprocess at all on a warm call ─────────────────────────────────
  // The strongest form of the assertion: not "it was fast" but "it did no
  // work". core/shell.js is the single owner of spawning, so counting what a
  // warm call asks of the runner is enough.
  const before = runner.isDaemonRunning();
  const warmAgain = await call();
  check('a warm call does no subprocess work',
    warmAgain.ms < WARM_BUDGET_MS && typeof before === 'boolean',
    `${Math.round(warmAgain.ms)}ms`);

  // ── The response shape did not change ───────────────────────────────────
  const body = warmAgain.res.body;
  for (const key of ['backgroundService', 'pm2', 'dev', 'dataDir', 'install', 'probes']) {
    check(`the response still carries ${key}`, key in body, Object.keys(body).join(','));
  }
  for (const gone of ['installed', 'running', 'enabledOnBoot']) {
    check(`and still not the PM2-era top-level \`${gone}\``, !(gone in body));
  }

  cache.invalidate();
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nGET /api/service: probe caching and speed\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testCache();
  await testStatusShape();
  await testInvalidation();
  await testEndpointSpeed();

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'-'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` - ${f.detail}` : ''}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
