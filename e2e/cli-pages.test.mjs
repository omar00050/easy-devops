/**
 * e2e/cli-pages.test.mjs
 *
 * Run with:  npm run test:e2e -- cli-pages
 *
 * The CLI draws each menu as a page: a breadcrumb header, a screen cleared only
 * where that is safe, and a pause that holds a result until Enter. This suite
 * checks the parts that can be checked without a terminal:
 *
 *   - page() prints "Easy DevOps > SSL > Issue";
 *   - non-TTY output contains no clear escape sequence;
 *   - CI=1 never clears (the decision is a pure function, so a simulated TTY
 *     can be used);
 *   - pause() returns immediately when stdout is not a TTY;
 *   - a non-interactive subcommand prints no clear escape code either.
 *
 * Every child process gets EZ_TEST=1 and a temporary EASY_DEVOPS_DATA_DIR in
 * its environment, set before Node starts — never as an argument.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
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

/** Clear sequences this CLI may write. Any of them in a pipe is a bug. */
const CLEAR_CODES = /\x1b\[(?:2J|3J|H)/;

/** A scratch data directory, inside the one the runner allocated. */
function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  // Zero-byte file: a valid empty SQLite database, and db.js's legacy
  // migration becomes a no-op.
  const db = path.join(dir, 'easy-devops.sqlite');
  if (!fs.existsSync(db)) fs.writeFileSync(db, '');
  return dir;
}

/**
 * Runs `node -e <script>` with the test environment set before Node starts.
 * The environment is built rather than inherited so FORCE_COLOR and CI from
 * whatever ran the suite cannot change what is being asserted.
 */
function runNode(script, { dataDir, extraEnv = {}, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, EZ_TEST: '1', EASY_DEVOPS_DATA_DIR: dataDir };
    delete env.CI;
    delete env.FORCE_COLOR;
    Object.assign(env, extraEnv);

    const started = Date.now();
    const child = spawn(process.execPath, ['-e', script], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        signal,
        stdout,
        stderr,
        out: stdout + stderr,
        timedOut,
        ms: Date.now() - started,
      });
    });
  });
}

/** Runs the real CLI entry point, as a user would. */
function runCli(args, { dataDir, extraEnv = {}, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, EZ_TEST: '1', EASY_DEVOPS_DATA_DIR: dataDir };
    delete env.CI;
    delete env.FORCE_COLOR;
    Object.assign(env, extraEnv);

    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'src/cli/index.js'), ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        signal,
        stdout,
        stderr,
        out: stdout + stderr,
        timedOut,
        ms: Date.now() - started,
      });
    });
  });
}

async function testHelperDecisions() {
  setGroup('1. the helper decides for itself');
  const pageModule = await import(srcUrl('cli/ui/page.js'));

  check('shouldClearScreen is exported', typeof pageModule.shouldClearScreen === 'function');
  check('a TTY clears',
    pageModule.shouldClearScreen({ isTTY: true, env: {} }) === true);
  check('a pipe never clears',
    pageModule.shouldClearScreen({ isTTY: false, env: {} }) === false);
  check('CI=1 never clears, even in a TTY',
    pageModule.shouldClearScreen({ isTTY: true, env: { CI: '1' } }) === false);
  check('CI=true never clears',
    pageModule.shouldClearScreen({ isTTY: true, env: { CI: 'true' } }) === false);
  check('CI=0 does not count as CI',
    pageModule.shouldClearScreen({ isTTY: true, env: { CI: '0' } }) === true);
  check('an EZ_TEST run with no TTY never clears',
    pageModule.shouldClearScreen({ isTTY: false, env: { EZ_TEST: '1' } }) === false);

  check('the submenu label is the same everywhere', pageModule.BACK === '← Back');
  check('the main-menu label is the same everywhere', pageModule.EXIT === '✖ Exit');
}

async function testBreadcrumbAndNoClearInAPipe() {
  setGroup('2. the breadcrumb header, and no clear in a pipe');

  const dataDir = scratch('header');
  const pageUrl = srcUrl('cli/ui/page.js');

  const printed = await runNode(
    `import(${JSON.stringify(pageUrl)}).then((m) => m.page(['SSL', 'Issue']))`,
    { dataDir },
  );

  check('page() exits 0', printed.code === 0, `exit ${printed.code}`);
  check('it prints the full breadcrumb',
    printed.out.includes('Easy DevOps > SSL > Issue'),
    printed.out.trim().split('\n')[0]);
  check('a piped screen is not cleared', !CLEAR_CODES.test(printed.out));

  const nested = await runNode(
    `import(${JSON.stringify(pageUrl)}).then((m) => m.page(['SSL', 'Renew', 'All']))`,
    { dataDir },
  );
  check('a deeper path keeps every part',
    nested.out.includes('Easy DevOps > SSL > Renew > All'));

  const main = await runNode(
    `import(${JSON.stringify(pageUrl)}).then((m) => m.page(['Main Menu']))`,
    { dataDir },
  );
  check('the main menu has a breadcrumb too',
    main.out.includes('Easy DevOps > Main Menu'));
}

async function testCiNeverClears() {
  setGroup('3. CI=1 never clears');

  const dataDir = scratch('ci');
  const pageUrl = srcUrl('cli/ui/page.js');

  const result = await runNode(
    `import(${JSON.stringify(pageUrl)}).then((m) => m.page(['SSL', 'Issue']))`,
    { dataDir, extraEnv: { CI: '1' } },
  );

  check('CI=1 exits 0', result.code === 0, `exit ${result.code}`);
  check('CI=1 still prints the header', result.out.includes('Easy DevOps > SSL > Issue'));
  check('CI=1 writes no clear escape', !CLEAR_CODES.test(result.out));
}

async function testPauseIsImmediateWithoutATty() {
  setGroup('4. pause() does not wait without a TTY');

  const dataDir = scratch('pause');
  const pageUrl = srcUrl('cli/ui/page.js');

  const result = await runNode(
    `import(${JSON.stringify(pageUrl)}).then((m) => m.pause())`,
    { dataDir, timeoutMs: 15_000 },
  );

  check('it exits on its own (nothing to press)', !result.timedOut && result.code === 0,
    result.timedOut ? 'the process had to be killed' : `exit ${result.code} in ${result.ms}ms`);
  check('it finished promptly', result.ms < 8_000, `${result.ms}ms`);
  check('it prints no prompt', !/Press Enter/.test(result.out));

  // The same, with CI set: a captured run must not wait either.
  const inCi = await runNode(
    `import(${JSON.stringify(pageUrl)}).then((m) => m.pause('Press Enter to continue'))`,
    { dataDir, extraEnv: { CI: '1' }, timeoutMs: 15_000 },
  );
  check('CI=1 does not pause either', !inCi.timedOut && inCi.code === 0);
}

async function testNonInteractiveSubcommand() {
  setGroup('5. a non-interactive subcommand clears nothing');

  const dataDir = scratch('hub-status');

  const status = await runCli(['hub', 'status'], { dataDir });

  check('hub status exits 0', status.code === 0, `exit ${status.code}`);
  check('it still prints its report', /Hub pairing/.test(status.out));
  check('it writes no clear escape', !CLEAR_CODES.test(status.out));
  check('it does not wait for Enter', !status.timedOut, status.timedOut ? 'killed' : `${status.ms}ms`);
  check('it prints no pause prompt', !/Press Enter/.test(status.out));
}

async function testEveryMenuImports() {
  setGroup('6. every menu module loads');

  const menu = await import(srcUrl('cli/menu.js'));
  check('the interactive app exports run()', typeof menu.run === 'function');

  const menus = await import(srcUrl('cli/menus/hub.js'));
  check('the Hub menu is importable and has a command', typeof menus.hubCommand === 'function');
  check('the Hub menu is also the module default, as cli/menu.js expects',
    typeof menus.default === 'function');
}

async function main() {
  process.stdout.write('\nCLI pages\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testHelperDecisions();
  await testBreadcrumbAndNoClearInAPipe();
  await testCiNeverClears();
  await testPauseIsImmediateWithoutATty();
  await testNonInteractiveSubcommand();
  await testEveryMenuImports();

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) {
      process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` — ${f.detail}` : ''}\n`);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
