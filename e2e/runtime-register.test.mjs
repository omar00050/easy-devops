/**
 * e2e/runtime-register.test.mjs
 *
 * Item 9 of 1.4.8: the daemon's confinement without `--experimental-loader`.
 *
 * 1.4.7 started the daemon with `--experimental-loader`, and every start
 * printed "ExperimentalWarning: --experimental-loader may be removed in the
 * future" (seen on a real Windows Server). Node's replacement is
 * `--import` + `module.register()`, but it only exists from 18.19.0 / 20.6.0
 * while this package supports every Node from 18.0.0. So the command line is
 * chosen per version, and this suite proves both halves of that:
 *
 *   1. the choice itself (`daemonNodeArgs`) for every boundary version, and the
 *      command line each service mechanism writes for Node 22 and Node 18.17;
 *   2. the thing that actually matters: a child process started with
 *      `--import <register> <entry> daemon` is confined BEFORE the entry's
 *      first import resolves - an external `import`, `require` and `dlopen` are
 *      all refused, an in-package module still loads - and its stderr carries
 *      no ExperimentalWarning.
 *
 * The old form is covered too: units written by 1.4.4-1.4.7 keep that exact
 * command line until a repair rewrites them, so it must still confine the
 * daemon even though Node warns about it.
 *
 * Everything runs against a throwaway package copy under the runner's temp data
 * directory. No real service file, no real installation.
 */
import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let passed = 0;
const failures = [];

function check(name, condition, detail = null) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${name}\n      ${String(detail).split('\n').join('\n      ')}` : name);
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, name);
  assertInsideTestDataDir(dir, 'use a test directory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const runtime = await import('../src/core/service/runtime.js');
const systemd = await import('../src/core/service/systemd.js');
const winsw = await import('../src/core/service/winsw.js');
const windowsPersonal = await import('../src/core/service/windowsPersonal.js');
const { runFile } = await import('../src/core/shell.js');

const { daemonNodeArgs, supportsRegisterLoader, parseNodeVersion } = runtime;

// ─── 1. The decision, per Node version ───────────────────────────────────────

const registerUrl = pathToFileURL(path.join(REPO, 'src', 'core', 'service', 'runtime-register.mjs')).href;
const loaderUrl = pathToFileURL(path.join(REPO, 'src', 'core', 'service', 'runtime-loader.mjs')).href;

const IMPORT_ARGS = ['--import', registerUrl];
const LOADER_ARGS = [`--experimental-loader=${loaderUrl}`];

const cases = [
  ['v22.11.0', true],
  ['v22.0.0', true],
  ['v24.1.0', true],
  ['v21.7.3', true],
  ['v20.6.0', true],
  ['v20.11.1', true],
  ['v20.5.1', false],
  ['v20.0.0', false],
  ['v19.9.0', false],
  ['v19.0.0', false],
  ['v18.19.0', true],
  ['v18.20.4', true],
  ['v18.18.2', false],
  ['v18.17.1', false],
  ['v18.0.0', false],
  ['18.19.1', true],
  ['node v18.17.0', false],
];

for (const [version, expectImport] of cases) {
  const args = daemonNodeArgs({ nodeVersion: version });
  check(`daemonNodeArgs(${version}) writes the ${expectImport ? '--import' : 'loader'} form`,
    JSON.stringify(args) === JSON.stringify(expectImport ? IMPORT_ARGS : LOADER_ARGS),
    JSON.stringify(args));
  check(`supportsRegisterLoader(${version}) is ${expectImport}`,
    supportsRegisterLoader(version) === expectImport, String(supportsRegisterLoader(version)));
}

for (const unknown of [null, undefined, '', 'not-a-version', 'v20.6']) {
  check(`an unknown version (${JSON.stringify(unknown)}) falls back to the loader flag, which every Node runs`,
    JSON.stringify(daemonNodeArgs({ nodeVersion: unknown })) === JSON.stringify(LOADER_ARGS),
    JSON.stringify(daemonNodeArgs({ nodeVersion: unknown })));
}

check('parseNodeVersion reads a --version line', JSON.stringify(parseNodeVersion('v22.21.1\n')) === '[22,21,1]');
check('parseNodeVersion refuses nonsense', parseNodeVersion('lts/hydrogen') === null);

// A package root that is not this one gets URLs into that root: that is what
// makes the runtime copy confine to the copy rather than to the CLI's package.
const otherRoot = scratch('other-root');
fs.mkdirSync(path.join(otherRoot, 'src', 'core', 'service'), { recursive: true });
fs.writeFileSync(path.join(otherRoot, 'src', 'core', 'service', 'runtime-register.mjs'), '// fixture\n');
const otherArgs = daemonNodeArgs({ nodeVersion: 'v22.0.0', packageRoot: otherRoot });
check('the URLs follow the package root they are given',
  otherArgs[1] === pathToFileURL(path.join(otherRoot, 'src', 'core', 'service', 'runtime-register.mjs')).href,
  otherArgs[1]);

// ─── 2. What each service mechanism writes ───────────────────────────────────

// The builders are given a real tree, because "which flag" depends on the
// register module being there as well as on the version: on Windows this is
// the runtime copy the service actually runs from.
const tree = scratch('service-tree');
for (const file of ['src/cli/index.js', 'src/core/service/runtime-register.mjs',
  'src/core/service/runtime-loader.mjs', 'src/core/service/runtime-boundary.cjs']) {
  const target = path.join(tree, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REPO, file), target);
}
const ENTRY = path.join(tree, 'src', 'cli', 'index.js');
const NODE_EXE = path.join(tree, 'runtime', 'node.exe');
const DATA_DIR = path.join(tree, 'data');

const registerPath = path.join(tree, 'src', 'core', 'service', 'runtime-register.mjs');
const loaderPath = path.join(tree, 'src', 'core', 'service', 'runtime-loader.mjs');

/** ExecStart's value: systemd words, with unitArg()'s JSON quoting undone. */
function execStart(unit) {
  return unit.split('\n').find((line) => line.startsWith('ExecStart='))?.slice('ExecStart='.length) ?? '';
}

function unitWords(unit) {
  const value = execStart(unit);
  const words = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === ' ') { index += 1; continue; }
    if (value[index] === '"') {
      let end = index + 1;
      while (end < value.length && value[end] !== '"') end += value[end] === '\\' ? 2 : 1;
      words.push(JSON.parse(value.slice(index, end + 1)));
      index = end + 1;
      continue;
    }
    const space = value.indexOf(' ', index);
    words.push(value.slice(index, space === -1 ? value.length : space));
    index = space === -1 ? value.length : space;
  }
  return words;
}

const unit22 = systemd.buildUnit({
  nodeExe: NODE_EXE, entry: ENTRY, user: 'deploy', dataDir: DATA_DIR, nodeVersion: 'v22.11.0',
});
const unit1817 = systemd.buildUnit({
  nodeExe: NODE_EXE, entry: ENTRY, user: 'deploy', dataDir: DATA_DIR, nodeVersion: 'v18.17.0',
});

check('a Node 22 unit runs the pinned runtime, --import, the register module, the entry and daemon',
  JSON.stringify(unitWords(unit22)) === JSON.stringify([NODE_EXE, '--import',
    pathToFileURL(registerPath).href, ENTRY, 'daemon']),
  JSON.stringify(unitWords(unit22)));
check('a Node 18.17 unit keeps the loader flag, which is all that version has',
  JSON.stringify(unitWords(unit1817)) === JSON.stringify([NODE_EXE,
    `--experimental-loader=${pathToFileURL(loaderPath).href}`, ENTRY, 'daemon']),
  JSON.stringify(unitWords(unit1817)));
check('the confinement module is the package root beside the entry',
  fileURLToPath(unitWords(unit22)[2]) === registerPath, unitWords(unit22)[2]);
check('only the --import form leaves the ExperimentalWarning behind',
  !unit22.includes('--experimental-loader') && unit1817.includes('--experimental-loader='));

const xml22 = winsw.buildServiceXml({
  nodeExe: NODE_EXE, entry: ENTRY, dataDir: DATA_DIR, logDir: path.join(tree, 'logs'), nodeVersion: 'v22.11.0',
});
const xml1817 = winsw.buildServiceXml({
  nodeExe: NODE_EXE, entry: ENTRY, dataDir: DATA_DIR, logDir: path.join(tree, 'logs'), nodeVersion: 'v18.17.0',
});
const xmlArguments = (xml) => /<arguments>(.*)<\/arguments>/.exec(xml)?.[1] ?? '';
const xmlTokens = (xml) => [...xmlArguments(xml).matchAll(/"([^"]*)"/g)].map((match) => match[1]);

check('a Node 22 service XML passes --import and the register module before the entry',
  JSON.stringify(xmlTokens(xml22)) === JSON.stringify([
    '--import', pathToFileURL(registerPath).href, ENTRY,
  ]) && xmlArguments(xml22).endsWith(' daemon'), xmlArguments(xml22));
check('a Node 18.17 service XML keeps the single loader argument',
  JSON.stringify(xmlTokens(xml1817)) === JSON.stringify([
    `--experimental-loader=${pathToFileURL(loaderPath).href}`, ENTRY,
  ]), xmlArguments(xml1817));
check('the XML confines to the copy its entry lives in, not to the CLI package',
  fileURLToPath(xmlTokens(xml22)[1]) === registerPath, xmlTokens(xml22)[1]);

const personal = scratch('personal-tree');
const PERSONAL_ENTRY = path.join(personal, 'src', 'cli', 'index.js');
for (const file of ['src/cli/index.js', 'src/core/service/runtime-register.mjs', 'src/core/service/runtime-loader.mjs']) {
  const target = path.join(personal, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REPO, file), target);
}
const supervisor22 = windowsPersonal.buildSupervisor({
  nodeExe: 'C:\\nodejs\\node.exe', entry: PERSONAL_ENTRY, dataDir: path.join(personal, 'data'),
  logFile: 'L', stopFile: 'S', nodeVersion: 'v22.11.0',
});
const supervisor1817 = windowsPersonal.buildSupervisor({
  nodeExe: 'C:\\nodejs\\node.exe', entry: PERSONAL_ENTRY, dataDir: path.join(personal, 'data'),
  logFile: 'L', stopFile: 'S', nodeVersion: 'v18.17.0',
});
const commandLine = (supervisor) => supervisor.split('\n').find((line) => line.includes('"!ENTRY!" daemon')) ?? '';
const commandTokens = (supervisor) => {
  const tokens = [...commandLine(supervisor).matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  // Everything after the entry is redirection (`>>"!LOGFILE!"`), not an argument.
  const end = tokens.indexOf('!ENTRY!');
  return end === -1 ? tokens : tokens.slice(0, end + 1);
};

check('a Node 22 supervisor passes --import and the register module before the entry',
  JSON.stringify(commandTokens(supervisor22)) === JSON.stringify(['!NODEEXE!', '--import',
    pathToFileURL(path.join(personal, 'src', 'core', 'service', 'runtime-register.mjs')).href, '!ENTRY!']),
  commandLine(supervisor22));
check('a Node 18.17 supervisor keeps the loader flag',
  JSON.stringify(commandTokens(supervisor1817)) === JSON.stringify(['!NODEEXE!',
    `--experimental-loader=${pathToFileURL(path.join(personal, 'src', 'core', 'service', 'runtime-loader.mjs')).href}`,
    '!ENTRY!']), commandLine(supervisor1817));

// A builder that is not told the version must not guess one: it writes the flag
// that works everywhere, and a repair with a known version rewrites it.
const unitNoVersion = systemd.buildUnit({ nodeExe: NODE_EXE, entry: ENTRY, user: 'deploy', dataDir: DATA_DIR });
check('without a version the unit falls back to the loader flag',
  JSON.stringify(unitWords(unitNoVersion)) === JSON.stringify([
    NODE_EXE, `--experimental-loader=${pathToFileURL(loaderPath).href}`, ENTRY, 'daemon',
  ]), JSON.stringify(unitWords(unitNoVersion)));
const xmlNoVersion = winsw.buildServiceXml({ nodeExe: NODE_EXE, entry: ENTRY, dataDir: DATA_DIR, logDir: 'L' });
check('without a version the XML falls back to the loader flag',
  xmlArguments(xmlNoVersion).startsWith('"--experimental-loader='), xmlArguments(xmlNoVersion));

// A tree that does not carry the register module (a runtime copy from an
// earlier version) must not get a command line Node refuses to start: the
// loader flag confines it too, which is why 1.4.7 units keep working.
const oldTree = scratch('old-service-tree');
for (const file of ['src/cli/index.js', 'src/core/service/runtime-loader.mjs', 'src/core/service/runtime-boundary.cjs']) {
  const target = path.join(oldTree, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REPO, file), target);
}
const oldUnit = systemd.buildUnit({
  nodeExe: path.join(oldTree, 'runtime', 'node'), entry: path.join(oldTree, 'src', 'cli', 'index.js'),
  user: 'deploy', dataDir: path.join(oldTree, 'data'), nodeVersion: 'v22.11.0',
});
check('a tree without the register module gets the loader flag, not a command line that cannot start',
  JSON.stringify(unitWords(oldUnit)) === JSON.stringify([
    path.join(oldTree, 'runtime', 'node'),
    `--experimental-loader=${pathToFileURL(path.join(oldTree, 'src', 'core', 'service', 'runtime-loader.mjs')).href}`,
    path.join(oldTree, 'src', 'cli', 'index.js'), 'daemon',
  ]), JSON.stringify(unitWords(oldUnit)));

// ─── 3. The real thing: a child process, confined from its first import ─────

const packageRoot = scratch('package');
for (const file of ['package.json', 'src/cli/index.js', 'src/core/service/runtime-boundary.cjs',
  'src/core/service/runtime-loader.mjs', 'src/core/service/runtime-register.mjs']) {
  const target = path.join(packageRoot, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REPO, file), target);
}

// A module that really is inside the package: the confinement must not touch it.
const insideDir = path.join(packageRoot, 'node_modules', 'inside');
fs.mkdirSync(insideDir, { recursive: true });
fs.writeFileSync(path.join(insideDir, 'package.json'), JSON.stringify({ name: 'inside', main: 'index.js' }));
fs.writeFileSync(path.join(insideDir, 'index.js'), 'module.exports = "inside";\n');

// Modules that are outside it: a CommonJS file, an ES module and something
// shaped like a native addon.
const outside = scratch('outside');
fs.writeFileSync(path.join(outside, 'index.js'), 'module.exports = "outside";\n');
fs.writeFileSync(path.join(outside, 'esm.mjs'), 'export default "outside";\n');
const outsideNative = path.join(outside, 'payload.node');
fs.writeFileSync(outsideNative, 'not a native addon');

const outsideCjs = path.join(outside, 'index.js');
const outsideEsm = path.join(outside, 'esm.mjs');

/** The daemon entry: asserts its own confinement, then exits 0. */
fs.writeFileSync(path.join(packageRoot, 'src', 'cli', 'index.js'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import install from '../core/service/runtime-register.mjs';

const require = createRequire(import.meta.url);
const [outsideCjs, outsideEsm, outsideNative] = process.argv.slice(3);

// install() already ran when Node loaded this module with --import. A second
// call is a no-op, which is what makes src/cli/index.js safe to call it again.
assert.equal(install(), false, 'a second install must be a no-op');

// Inside the package: still loadable, or the daemon could not run at all.
assert.equal(require('inside'), 'inside');
assert.ok(require.resolve('inside').startsWith(${JSON.stringify(packageRoot)}));

// Outside: refused, with the same wording as before this change.
assert.throws(() => require(outsideCjs), /outside the daemon runtime/);
await assert.rejects(import(pathToFileURL(outsideEsm).href), /outside the daemon runtime/);
assert.throws(() => process.dlopen({ exports: {} }, outsideNative), /outside the daemon runtime/);

process.stdout.write('confined');
`);

/** An entry whose FIRST import is outside the package: the proof it is refused up front. */
fs.writeFileSync(path.join(packageRoot, 'bad-entry.mjs'), `
import 'outside-fixture';
process.stdout.write('should not run');
`);

function spawnChild(args, { cwd = packageRoot, timeout = 30_000 } = {}) {
  return runFile(process.execPath, args, {
    cwd,
    timeout,
    env: {
      EZ_TEST: '1',
      EASY_DEVOPS_DATA_DIR: TEST_DATA_DIR,
      // Nothing ambient may change the module resolution under test.
      NODE_OPTIONS: '',
      NODE_PATH: '',
    },
  });
}

const entry = path.join(packageRoot, 'src', 'cli', 'index.js');
const importArgs = daemonNodeArgs({ nodeVersion: process.version, packageRoot });
const usingImport = importArgs[0] === '--import';

const confined = await spawnChild([
  ...importArgs,
  entry,
  'daemon',
  outsideCjs,
  outsideEsm,
  outsideNative,
]);

check(`the daemon started with ${usingImport ? '--import' : 'the loader flag'} is confined (${confined.exitCode === 0 ? 'exit 0' : `exit ${confined.exitCode}`})`,
  confined.success === true, `${confined.stdout}\n${confined.stderr}`);
check('the confined entry loaded its own package module and refused all three external ones',
  /confined/.test(confined.stdout), confined.stdout);

if (usingImport) {
  check('Node 18.19/20.6+ prints no ExperimentalWarning for the --import form',
    !/ExperimentalWarning/.test(confined.stderr), confined.stderr);
  check('and nothing else is written to stderr at all',
    confined.stderr.trim() === '', confined.stderr);
} else {
  process.stdout.write(`SKIP  ${process.version} has no module.register(): the loader flag is the only form, and its ExperimentalWarning cannot be avoided\n`);
}

// The old command line, exactly as 1.4.4-1.4.7 wrote it: the loader flag with
// the loader's file URL. It must keep working until a repair rewrites it; only
// the ExperimentalWarning is left.
const legacy = await spawnChild([
  `--experimental-loader=${pathToFileURL(path.join(packageRoot, 'src', 'core', 'service', 'runtime-loader.mjs')).href}`,
  entry,
  'daemon',
  outsideCjs,
  outsideEsm,
  outsideNative,
]);
check('a unit written by 1.4.4-1.4.7 still confines the daemon',
  legacy.success === true && /confined/.test(legacy.stdout), `${legacy.stdout}\n${legacy.stderr}`);

// Same, with the space-separated flag form, which process.execArgv keeps as two
// tokens; the CLI must recognise it rather than registering a second loader.
const legacySpaced = await spawnChild([
  '--experimental-loader',
  pathToFileURL(path.join(packageRoot, 'src', 'core', 'service', 'runtime-loader.mjs')).href,
  entry,
  'daemon',
  outsideCjs,
  outsideEsm,
  outsideNative,
]);
check('the space-separated loader form is recognised too',
  legacySpaced.success === true && /confined/.test(legacySpaced.stdout), `${legacySpaced.stdout}\n${legacySpaced.stderr}`);

// An entry whose first statement is an external import: the refusal happens
// before any of the entry's own code runs, which is the property --import is
// there for. The fixture lives in the data directory's node_modules, so the
// ordinary resolver finds it - and the daemon's confinement refuses it.
const outsidePackage = path.join(TEST_DATA_DIR, 'node_modules', 'outside-fixture');
fs.mkdirSync(outsidePackage, { recursive: true });
fs.writeFileSync(path.join(outsidePackage, 'package.json'), JSON.stringify({ name: 'outside-fixture', main: 'index.js' }));
fs.writeFileSync(path.join(outsidePackage, 'index.js'), 'module.exports = 1;\n');

const refused = await spawnChild([...importArgs, path.join(packageRoot, 'bad-entry.mjs')]);
check('an entry whose first import is outside the package is refused before it runs',
  refused.success === false && /outside the daemon runtime/.test(refused.stderr) && !/should not run/.test(refused.stdout),
  `${refused.stdout}\n${refused.stderr}`);

// --import=<url> is the same flag: a unit may write either form.
if (usingImport) {
  const equalsForm = await spawnChild([`--import=${importArgs[1]}`, entry, 'daemon', outsideCjs, outsideEsm, outsideNative]);
  check('--import=<url> confines exactly like the two-argument form',
    equalsForm.success === true && /confined/.test(equalsForm.stdout), `${equalsForm.stdout}\n${equalsForm.stderr}`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

try {
  (await import('../src/core/db.js')).closeDb();
} catch { /* never opened */ }

if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`FAIL  ${failure}\n`);
  process.stdout.write(`FAIL  ${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`PASS  the daemon is confined with --import and register() where Node has it, and with the loader flag everywhere else (${passed} checks)`);
