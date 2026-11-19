/**
 * e2e/run.mjs — the only sanctioned way to run the e2e suites.
 *
 *   node e2e/run.mjs              every suite
 *   node e2e/run.mjs service      one suite (name, with or without .test.mjs)
 *   node e2e/run.mjs --check      only the static-import preflight
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
 *   4. removes the directory afterwards and reports a summary.
 *
 * With EZ_TEST=1, core/platform.js getDataDir() throws rather than return the
 * real directory — so even a mistake inside a suite cannot reach real data.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { checkApiContract } from './lib/api-contract-check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = __dirname;
const ROOT = path.resolve(__dirname, '..');

const GUARD_IMPORT = './lib/guard.mjs';

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
 * Runs one suite in its own process, with its own temporary data directory.
 * @returns {Promise<{ suite: string, code: number, ms: number, cleaned: boolean }>}
 */
function runSuite(suite) {
  return new Promise((resolve) => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ez-e2e-${suite}-`));
    const dataDir = path.join(dataRoot, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    // A pre-created 0-byte file so db.js's legacy migration — which RENAMES
    // data/easy-devops.sqlite — can never run against the real installation.
    fs.writeFileSync(path.join(dataDir, 'easy-devops.sqlite'), '');

    const started = Date.now();

    process.stdout.write(`\n${'═'.repeat(70)}\n`);
    process.stdout.write(`  ${suite}\n`);
    process.stdout.write(`  data: ${dataDir}\n`);
    process.stdout.write(`${'═'.repeat(70)}\n`);

    const child = spawn(process.execPath, [path.join(E2E_DIR, `${suite}.test.mjs`)], {
      cwd: ROOT,
      // Both variables are in the environment before Node starts, which is
      // the whole point: no import can run before they are set.
      env: {
        ...process.env,
        EZ_TEST: '1',
        EASY_DEVOPS_DATA_DIR: dataDir,
      },
      stdio: 'inherit',
      windowsHide: true,
    });

    child.on('exit', (code, signal) => {
      const ms = Date.now() - started;
      const cleaned = rmWithRetry(dataRoot);
      if (!cleaned) {
        process.stderr.write(`  ! could not remove ${dataRoot}\n`);
      }

      // A suite can print "52 PASS 0 FAIL" and still be recorded as failed,
      // because the verdict is the EXIT CODE — a suite killed by a signal, or
      // one that throws after its summary, reports no failing assertion at
      // all. Saying how the child ended turns that from a mystery into a fact.
      if (code !== 0) {
        process.stderr.write(
          `  ! ${suite} ended with ${signal ? `signal ${signal}` : `exit code ${code}`}\n`,
        );
      }

      resolve({ suite, code: code ?? 1, ms, cleaned, signal: signal ?? null });
    });

    child.on('error', (err) => {
      process.stderr.write(`  ! could not start ${suite}: ${err.message}\n`);
      rmWithRetry(dataRoot);
      resolve({ suite, code: 1, ms: Date.now() - started, cleaned: true });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const names = args.filter((a) => !a.startsWith('-')).map((a) => a.replace(/\.test\.mjs$/, ''));

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

  const available = listSuites();
  const unknown = names.filter((n) => !available.includes(n));
  if (unknown.length > 0) {
    process.stderr.write(
      `\nUnknown suite(s): ${unknown.join(', ')}\n` +
      `Available: ${available.join(', ')}\n\n`
    );
    process.exit(1);
  }

  const suites = names.length > 0 ? names : available;

  // ── Run ───────────────────────────────────────────────────────────────────
  const results = [];
  for (const suite of suites) {
    results.push(await runSuite(suite));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.code !== 0);
  const dirty = results.filter((r) => !r.cleaned);

  process.stdout.write(`\n${'═'.repeat(70)}\n  SUMMARY\n${'═'.repeat(70)}\n`);
  for (const r of results) {
    const mark = r.code === 0 ? 'PASS' : 'FAIL';
    process.stdout.write(`  ${mark}  ${r.suite.padEnd(20)} ${String((r.ms / 1000).toFixed(1)).padStart(6)}s\n`);
  }
  process.stdout.write(`${'─'.repeat(70)}\n`);
  process.stdout.write(`  ${results.length} suite(s), ${results.length - failed.length} passed, ${failed.length} failed\n`);
  if (dirty.length > 0) {
    process.stdout.write(`  ! ${dirty.length} temporary directory/ies could not be removed\n`);
  }
  process.stdout.write('\n');

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`\nRunner error: ${err.stack}\n`);
  process.exit(1);
});
