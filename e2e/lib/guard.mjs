/**
 * e2e/lib/guard.mjs
 *
 * Imported FIRST by every e2e suite, so running one directly fails loudly
 * instead of quietly operating on the real installation.
 *
 * Why the position matters: ESM evaluates the whole static import graph before
 * the first line of the importing module runs. A check written as code at the
 * top of a suite therefore executes AFTER everything that suite statically
 * imports — too late if one of those imports reaches core/db.js, which decides
 * its data directory at load time. A module body, by contrast, runs in import
 * order, so being the first import makes this the first thing that happens.
 *
 * The real refusal is in core/platform.js getDataDir(), which throws under
 * EZ_TEST=1 rather than return the real directory. This module exists to turn
 * that into a clear message about HOW to run the tests, before a suite gets
 * far enough to produce a confusing failure.
 *
 * e2e/run.mjs sets both variables before Node starts, which is the only way to
 * be certain they are in place before any import is evaluated.
 */

import path from 'node:path';
import os from 'node:os';

const TEST_MODE_ENV = 'EZ_TEST';
const DATA_DIR_ENV = 'EASY_DEVOPS_DATA_DIR';

function die(lines) {
  process.stderr.write(`\n${'─'.repeat(70)}\n${lines.join('\n')}\n${'─'.repeat(70)}\n\n`);
  process.exit(1);
}

const isWindows = process.platform === 'win32';

// Every directory a real installation could be using. On Windows that is two:
// the per-user one, and the machine-wide ProgramData one used once the service
// is installed in Server mode. Both are refused regardless of which one this
// machine would currently resolve to — a guard that only covered the active
// one would leave the other exposed on exactly the machines where it matters.
const realDataDirs = isWindows
  ? [
    path.join(process.env.APPDATA || os.homedir(), 'easy-devops'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'easy-devops'),
  ]
  : [path.join(os.homedir(), '.config', 'easy-devops')];

const suite = path.basename(process.argv[1] ?? 'the suite').replace(/\.test\.mjs$/, '');

if (process.env[TEST_MODE_ENV] !== '1') {
  die([
    'Refusing to run this e2e suite directly.',
    '',
    `${TEST_MODE_ENV} is not set, so nothing stops a module from resolving the real`,
    'data directory and reading or writing your actual installation.',
    '',
    'Run it through the runner instead — it creates a fresh temporary data',
    'directory per suite and sets the environment before Node starts:',
    '',
    '  npm run test:e2e',
    `  npm run test:e2e -- ${suite}`,
  ]);
}

const dataDir = process.env[DATA_DIR_ENV]?.trim();

if (!dataDir) {
  die([
    `${TEST_MODE_ENV}=1 is set but ${DATA_DIR_ENV} is not.`,
    '',
    'A test run must be given an explicit, throwaway data directory.',
    '',
    '  npm run test:e2e',
    `  npm run test:e2e -- ${suite}`,
  ]);
}

// Mirrors the containment checks in core/platform.js, so the message arrives
// here — with instructions — rather than as a bare throw from deep inside an
// import chain. Keep the two in step.
const norm = (p) => (isWindows ? path.resolve(p).toLowerCase() : path.resolve(p));
const given = norm(dataDir);

// A directory under the system temp folder is throwaway by construction and
// accepted as-is. Several suites redirect APPDATA/HOME into their temp
// directory, which makes the "real" path land inside — or equal to — the given
// one; comparing them there would reject the safest pattern in the suite.
const underSystemTemp = given === norm(os.tmpdir()) || given.startsWith(norm(os.tmpdir()) + path.sep);

const overlapping = underSystemTemp ? null : realDataDirs.find((candidate) => {
  const real = norm(candidate);
  return given === real
    || given.startsWith(real + path.sep)
    || real.startsWith(given + path.sep);
});

if (overlapping) {
  die([
    `${DATA_DIR_ENV} overlaps a real data directory.`,
    '',
    `  given   : ${dataDir}`,
    `  real dir: ${overlapping}`,
    '',
    'Use the runner, which allocates a directory under the system temp folder.',
  ]);
}

/** The temporary data directory this suite must confine itself to. */
export const TEST_DATA_DIR = path.resolve(dataDir);

/**
 * Aborts unless `dir` is inside the directory this run was given.
 *
 * For suites that create their own sub-directories: it keeps a later refactor
 * from quietly pointing one at the real installation.
 *
 * @param {string} dir
 * @param {string} what Described in the error, e.g. 'write a config'
 */
export function assertInsideTestDataDir(dir, what = 'use this directory') {
  const candidate = norm(dir);
  const root = norm(path.dirname(TEST_DATA_DIR));
  if (candidate === root || candidate.startsWith(root + path.sep)) return;

  die([
    `Refusing to ${what}: ${dir}`,
    '',
    `It is outside this run's temporary area (${root}).`,
  ]);
}
