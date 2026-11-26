/**
 * e2e/acl-large-tree.test.mjs
 *
 * The suite that would have caught 1.4.7's Windows Server failure.
 *
 * Run with: node e2e/run.mjs acl-large-tree
 *
 * What 1.4.7 did (confirmed cause C1/C2 in the 1.4.8 contract)
 * ------------------------------------------------------------
 * `core/shell.js` keeps only the NEWEST 64 KiB of stdout
 * (SHELL_CAPTURE_TAIL_BYTES). `verifyServiceCodeRoot` ran
 * `icacls <root>\* /T /C` over the whole runtime - 4 to 7 MB on a real server -
 * and parsed that tail. `icacls` lists a folder's OWN matches before descending,
 * so with `node.exe` at the top of `runtime\` its entry was near the front and
 * long gone from the tail: "node.exe is missing from the read-back". The install
 * then stopped with "The service files could not be protected".
 *
 * Why 1.4.7's tests did not catch it (C9)
 * --------------------------------------
 * The fake icacls in e2e/service-upgrade-matrix.test.mjs was an in-process
 * `runFile` stub, so shell.js's capture tail never applied, and it sorted every
 * path globally, so `node.exe` came LAST. The fixture runtime held five files.
 *
 * What this suite does instead
 * ---------------------------
 * e2e/lib/fake-icacls.mjs is a real executable over a real tree, driven through
 * the REAL core/shell.js `runFile`, so the capture tail applies exactly as on a
 * server. The tree is a runtime of 11,000+ files with `app\node_modules\...`
 * deep paths and `node.exe` at the top. Group (a) reproduces the truncation and
 * asserts the fake prints node.exe when the stream is read in full - which is
 * the proof that the fake is realistic and the bug is the tail.
 *
 * The remaining groups hold the new interface to the fix: verify and protect a
 * healthy tree, one /T pass in the normal case, the reset path when children do
 * not inherit, the setowner fallback when a reset is denied, the restore on a
 * failed verification, SYSTEM/Administrators never losing full control at any
 * intermediate step, and the 30-second target.
 *
 * Everything is below this run's temporary data directory. No real ACL, no real
 * icacls, no service and no sc.exe: the only process started is this suite's
 * own node running e2e/lib/fake-icacls.mjs.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (relative) => pathToFileURL(path.join(ROOT, 'src', relative)).href;
const FAKE_ICACLS = path.join(__dirname, 'lib', 'fake-icacls.mjs');
const IS_WINDOWS = process.platform === 'win32';

/** The evidence's runtime is ~10,700 files; this tree is deliberately larger. */
const LARGE_PACKAGES = 102;
const FILES_PER_PACKAGE = 108;

/** The 30-second target the owner set for protecting an 11,000-file runtime. */
const PROTECT_BUDGET_MS = 30_000;

const OPERATOR = Object.freeze({
  sid: 'S-1-5-21-1111111111-2222222222-3333333333-1001',
  name: 'EXAMPLE\\operator',
});

const TRUSTEES = Object.freeze({
  SYSTEM: 'NT AUTHORITY\\SYSTEM',
  ADMINISTRATORS: 'BUILTIN\\Administrators',
  USERS: 'BUILTIN\\Users',
  SERVICE: 'NT SERVICE\\EasyDevOps',
  EVERYONE: 'Everyone',
});

// ─── results ─────────────────────────────────────────────────────────────────

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

function skip(label, reason) {
  results.push({ group, label, passed: true, skipped: true, detail: reason });
  process.stdout.write(`   SKIP  ${label}  (${reason})\n`);
}

function note(text) {
  process.stdout.write(`   ..    ${text}\n`);
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'acl-large-tree', name);
  assertInsideTestDataDir(dir, `create ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── the fake icacls, as a real child process ────────────────────────────────

const keyOf = (value) => {
  const resolved = path.resolve(String(value));
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
};

function ace(trustee, level, flags = []) {
  return { trustee, level, flags: [...flags] };
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

/**
 * A fresh state document for one fixture.
 *
 * `machineRoot` is the folder every tree inherits from, standing in for
 * C:\ProgramData: without it a file whose own folder has no explicit ACE would
 * have an empty DACL, which is the broken state, not the healthy one.
 */
function stateDocument({ machineRoot, paths = {}, watch = [], rules = {} }) {
  return {
    version: 1,
    operator: { ...OPERATOR },
    serviceAccount: TRUSTEES.SERVICE,
    defaults: { folderOwner: TRUSTEES.ADMINISTRATORS, fileOwner: OPERATOR.sid },
    paths: {
      [keyOf(machineRoot)]: {
        owner: TRUSTEES.ADMINISTRATORS,
        inherit: false,
        explicit: [
          ace(TRUSTEES.SYSTEM, 'F', ['OI', 'CI']),
          ace(TRUSTEES.ADMINISTRATORS, 'F', ['OI', 'CI']),
          ace(TRUSTEES.USERS, 'RX', ['OI', 'CI']),
        ],
      },
      ...paths,
    },
    watch,
    rules,
    calls: [],
    unknownVerbs: [],
    stats: {},
  };
}

/** The ACEs a healthy protected code root carries: SYSTEM/Admins F, users+service RX. */
function healthyRoot(owner = TRUSTEES.ADMINISTRATORS) {
  return {
    owner,
    inherit: false,
    explicit: [
      ace(TRUSTEES.SYSTEM, 'F', ['OI', 'CI']),
      ace(TRUSTEES.ADMINISTRATORS, 'F', ['OI', 'CI']),
      ace(TRUSTEES.USERS, 'RX', ['OI', 'CI']),
      ace(TRUSTEES.SERVICE, 'RX', ['OI', 'CI']),
    ],
  };
}

/** Clears the recorded calls so a group can count what IT caused. */
function resetCalls(statePath) {
  const state = readState(statePath);
  state.calls = [];
  state.stats = {};
  writeState(statePath, state);
}

/** `runFile` as core/service/* sees it: icacls.exe becomes the fake executable. */
function icaclsRunFile(statePath, shell) {
  const called = [];
  const runFile = async (file, args, options = {}) => {
    const exe = path.win32.basename(String(file)).toLowerCase();
    called.push({ file: exe, args: [...(args ?? [])] });
    if (exe === 'icacls.exe') {
      return shell.runFile(process.execPath, [FAKE_ICACLS, ...(args ?? [])], {
        ...options,
        env: { ...(options.env ?? {}), EZ_FAKE_ICACLS_STATE: statePath },
      });
    }
    // The reparse-point preflight in acl.js; protectCodeRoot does not need it,
    // and answering it keeps an unexpected call visible in `called`.
    if (exe === 'powershell.exe') {
      return { success: true, stdout: '', stderr: '', exitCode: 0, command: String(file) };
    }
    return {
      success: false,
      stdout: '',
      stderr: `unexpected executable: ${file} ${(args ?? []).join(' ')}`,
      exitCode: 1,
      command: String(file),
    };
  };
  runFile.called = called;
  return runFile;
}

// ─── the tree ────────────────────────────────────────────────────────────────

const RUNTIME_TOP_FILES = ['node.exe', 'package.json'];
const REQUIRED = Object.freeze({
  node: ['node.exe'],
  packageJson: ['app', 'package.json'],
  cliEntry: ['app', 'src', 'cli', 'index.js'],
});

/**
 * A real runtime tree: node.exe at the top, then app\src, then
 * app\node_modules\<pkg>\{lib,lib\esm,lib\umd,test,test\fixtures}.
 *
 * Written with plain synchronous calls: it is a fixture, and the suite measures
 * only the code under test.
 */
function buildRuntimeTree(runtimeRoot, packages) {
  let files = 0;
  let dirs = 0;

  const mkdir = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    dirs += 1;
  };
  const write = (relative, contents = '') => {
    const full = path.join(runtimeRoot, ...relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
    files += 1;
    return full;
  };

  mkdir(runtimeRoot);
  for (const name of RUNTIME_TOP_FILES) write([name], `runtime fixture: ${name}\n`);
  write(REQUIRED.packageJson, `${JSON.stringify({ name: 'easy-devops', version: '1.4.7' })}\n`);
  write(REQUIRED.cliEntry, '// the service runs this entrypoint\n');
  write(['app', 'src', 'core', 'service', 'acl.js'], '// fixture\n');
  write(['app', 'src', 'core', 'service', 'operator.js'], '// fixture\n');
  mkdir(path.join(runtimeRoot, 'app', 'node_modules'));

  for (let p = 0; p < packages; p += 1) {
    const pkg = `pkg${String(p).padStart(3, '0')}`;
    const base = ['app', 'node_modules', pkg];
    mkdir(path.join(runtimeRoot, ...base));
    write([...base, 'package.json'], `${JSON.stringify({ name: pkg, version: '1.0.0' })}\n`);
    write([...base, 'index.js'], 'module.exports = {};\n');
    const buckets = [
      { dir: ['lib'], count: 20 },
      { dir: ['lib', 'esm'], count: 20 },
      { dir: ['lib', 'umd'], count: 20 },
      { dir: ['test'], count: 20 },
      { dir: ['test', 'fixtures'], count: 26 },
    ];
    for (const bucket of buckets) {
      mkdir(path.join(runtimeRoot, ...base, ...bucket.dir));
      for (let i = 0; i < bucket.count; i += 1) {
        const name = `file${String(i).padStart(3, '0')}.js`;
        write([...base, ...bucket.dir, name], '// fixture\n');
      }
    }
  }

  return { files, dirs, runtimeRoot };
}

/** Routes under the runtime that must exist for the required-file checks. */
function requiredPaths(runtimeRoot) {
  return {
    node: path.join(runtimeRoot, ...REQUIRED.node),
    packageJson: path.join(runtimeRoot, ...REQUIRED.packageJson),
    cliEntry: path.join(runtimeRoot, ...REQUIRED.cliEntry),
  };
}

// ─── reading the fake's record ───────────────────────────────────────────────

const callsWithT = (state) => state.calls.filter((call) => call.hasT);
const callsWithVerb = (state, verb) => state.calls.filter((call) => call.verb === verb);
const describeCalls = (state) => state.calls
  .map((call) => `${call.verb ?? 'listing'}${call.hasT ? '/T' : ''}`)
  .join(' ');

/** The folder's own DACL record as the fake holds it. */
function folderRecord(state, folder) {
  const record = state.paths[keyOf(folder)];
  if (!record) return { owner: null, inherit: true, explicit: [] };
  return {
    owner: record.owner ?? null,
    inherit: record.inherit !== false,
    explicit: (record.explicit ?? []).map((entry) => `${entry.trustee}:${[...(entry.flags ?? [])].sort().join('')}(${entry.level})`).sort(),
  };
}

// ─── module loading ──────────────────────────────────────────────────────────

async function loadModules() {
  const shell = await import(srcUrl('core/shell.js'));
  const operator = await import(srcUrl('core/service/operator.js'));
  return { shell, operator };
}

// ─── (a) the reproduction ────────────────────────────────────────────────────

async function testReproduction({ shell, tree }) {
  setGroup('(a) reproduction: a 11,000-file /T listing loses node.exe in the captured tail');

  const statePath = path.join(tree.root, 'state.json');
  writeState(statePath, stateDocument({
    machineRoot: tree.root,
    paths: { [keyOf(tree.runtimeRoot)]: healthyRoot() },
    watch: [tree.runtimeRoot],
  }));

  let streamedBytes = 0;
  let streamedChunks = 0;
  let sawNodeExe = false;
  let nodeExeAt = -1;
  let firstPackageAt = -1;
  let window = '';

  const target = path.join(tree.runtimeRoot, '*');
  const result = await shell.runFile(process.execPath, [FAKE_ICACLS, target, '/T', '/C'], {
    env: { EZ_FAKE_ICACLS_STATE: statePath },
    timeout: 300_000,
    onData: (text) => {
      // Keep a rolling window so a line split across chunks still counts, and
      // remember where each of the two entries first appeared: the ORDER is the
      // half of the bug a size assertion alone cannot show.
      const combined = window + text;
      const at = streamedBytes;
      streamedBytes += Buffer.byteLength(text, 'utf8');
      streamedChunks += 1;
      if (!sawNodeExe && /[\\/]node\.exe\s+(?:NT AUTHORITY|BUILTIN|NT SERVICE)/i.test(combined)) {
        sawNodeExe = true;
        nodeExeAt = at;
      }
      if (firstPackageAt < 0 && /node_modules[\\/]pkg000[\\/]/i.test(combined)) firstPackageAt = at;
      window = combined.slice(-400);
    },
  });

  const state = readState(statePath);
  const fullBytes = state.stats.lastListingBytes ?? 0;
  note(`the fake printed ${fullBytes} bytes in real icacls order (${tree.fileCount} files under runtime)`);

  check('the fake icacls exited 0 for `runtime\\* /T /C`', result.success,
    result.stderr ? result.stderr.slice(0, 120) : `exitCode ${result.exitCode}`);

  check('its full output is far beyond shell.js\'s 64 KiB capture buffer',
    fullBytes > 4 * 1024 * 1024,
    `${(fullBytes / (1024 * 1024)).toFixed(2)} MiB vs 64 KiB`);

  check('the full stream really contains runtime\\node.exe (the fake is realistic)',
    sawNodeExe,
    `${streamedBytes} bytes seen in ${streamedChunks} chunk(s)`);

  check('the CAPTURED stdout does not contain runtime\\node.exe: the 1.4.7 bug, reproduced',
    !/[\\/]runtime[\\/]node\.exe/i.test(result.stdout),
    `${Buffer.byteLength(result.stdout, 'utf8')} bytes captured of ${fullBytes}`);

  check('the captured tail is exactly shell.js\'s 64 KiB bound',
    Buffer.byteLength(result.stdout, 'utf8') <= 64 * 1024,
    `${Buffer.byteLength(result.stdout, 'utf8')} bytes`);

  // The same facts, read from the fake's own record: the listing was one call
  // and it produced every byte of it.
  const listingCall = state.calls.find((call) => call.verb === null && call.hasT);
  check('the fake printed node.exe before the first app subtree entry, as real icacls does',
    nodeExeAt >= 0 && firstPackageAt > nodeExeAt,
    `node.exe at byte ${nodeExeAt}, first pkg entry at ${firstPackageAt}`
      + (listingCall ? `, ${listingCall.bytes} bytes total` : ', no listing call recorded'));

  return { statePath, fullBytes };
}

// ─── (b) verify a healthy tree ───────────────────────────────────────────────

async function testVerifyHealthy({ operator, shell, tree }) {
  setGroup('(b) verifyServiceCodeRoot on a healthy 11,000-file tree');

  const statePath = path.join(tree.root, 'state.json');
  resetCalls(statePath);
  const runFile = icaclsRunFile(statePath, shell);

  const result = await operator.verifyServiceCodeRoot({
    dir: tree.runtimeRoot,
    serviceAccount: true,
    runFile,
    log: () => {},
  });

  const state = readState(statePath);
  const required = requiredPaths(tree.runtimeRoot);

  check('the healthy tree passes', result.ok === true, result.reason ?? '');
  check('it scanned every file under the root',
    typeof result.count === 'number' && result.count >= tree.fileCount,
    `count ${result.count}, ${tree.fileCount} files`);
  check('it read runtime\\node.exe on its own, not out of a /T listing',
    state.calls.some((call) => !call.hasT
      && call.args.some((argument) => keyOf(argument).endsWith('node.exe'))),
    describeCalls(state));
  const windowsJoined = [required.packageJson, required.cliEntry].filter((file) => !fs.existsSync(file));
  if (windowsJoined.length > 0 && !IS_WINDOWS) {
    skip('it read every required code file on its own',
      'REQUIRED_CODE_FILES composes app\\package.json with path.win32, so those files only resolve on Windows');
  } else {
    check('it read every required code file on its own',
      [required.packageJson, required.cliEntry].every((file) => state.calls.some((call) => !call.hasT
        && call.args.some((argument) => keyOf(argument) === keyOf(file)))),
      'node.exe, app\\package.json, app\\src\\cli\\index.js');
  }
  check('it never parsed a /T listing for the required files',
    state.calls.filter((call) => call.hasT).length <= 1,
    `${callsWithT(state).length} /T call(s): ${describeCalls(state)}`);
}

// ─── (c) and (h): protect a healthy tree, and how long it takes ──────────────

async function testProtectHealthy({ operator, shell, tree }) {
  setGroup('(c) protectCodeRoot on a healthy tree: one /T pass, no reset');

  const statePath = path.join(tree.root, 'state.json');
  resetCalls(statePath);
  const runFile = icaclsRunFile(statePath, shell);

  const startedAt = Date.now();
  const result = await operator.protectCodeRoot(tree.runtimeRoot, {
    runFile,
    log: () => {},
    mode: 'install',
  });
  const elapsedMs = Date.now() - startedAt;
  tree.protectElapsedMs = elapsedMs;

  const state = readState(statePath);
  const recursive = callsWithT(state);

  check('it succeeds on a tree that is already healthy', result.ok === true, result.reason ?? '');
  check('it made exactly one /T pass (1.4.7 made three, install six)',
    recursive.length === 1,
    `${recursive.length} /T call(s): ${describeCalls(state)}`);
  check('it did not reset any children', callsWithVerb(state, '/reset').length === 0
    && result.resetChildren !== true,
    describeCalls(state));
  check('it reported no restoration, because nothing failed',
    result.restored !== true && (result.next === null || result.next === undefined),
    String(result.restored));
  note(`protectCodeRoot took ${(elapsedMs / 1000).toFixed(2)} s on ${tree.fileCount} files`);

  return { elapsedMs, statePath, result };
}

// ─── the small tree the reset paths run on ───────────────────────────────────

function smallTree(name, { withEveryoneAce, emptyDaclOwner }) {
  const root = scratch(name);
  const runtimeRoot = path.join(root, 'runtime');
  const built = buildRuntimeTree(runtimeRoot, 1);
  const statePath = path.join(root, 'state.json');

  const state = stateDocument({
    machineRoot: root,
    paths: { [keyOf(runtimeRoot)]: healthyRoot() },
    watch: [runtimeRoot],
  });

  const targets = [];
  if (withEveryoneAce) {
    const file = path.join(runtimeRoot, 'app', 'node_modules', 'pkg000', 'lib', 'file003.js');
    targets.push(file);
    state.paths[keyOf(file)] = {
      owner: OPERATOR.sid,
      inherit: true,
      explicit: [ace(TRUSTEES.EVERYONE, 'F', [])],
    };
  }
  if (emptyDaclOwner) {
    const file = path.join(runtimeRoot, 'app', 'node_modules', 'pkg000', 'lib', 'esm', 'file005.js');
    targets.push(file);
    state.paths[keyOf(file)] = { owner: emptyDaclOwner, inherit: false, explicit: [] };
  }

  writeState(statePath, state);
  return { root, runtimeRoot, statePath, fileCount: built.files, targets };
}

// ─── (d) children with explicit ACEs and an empty DACL ───────────────────────

async function testResetPath({ operator, shell }) {
  setGroup('(d) children with explicit ACEs and one empty DACL: save, reset, verified');

  const tree = smallTree('reset-path', {
    withEveryoneAce: true,
    emptyDaclOwner: TRUSTEES.ADMINISTRATORS,
  });
  const runFile = icaclsRunFile(tree.statePath, shell);

  const result = await operator.protectCodeRoot(tree.runtimeRoot, {
    runFile,
    log: () => {},
    mode: 'repair',
  });
  const state = readState(tree.statePath);
  const treeSaves = callsWithVerb(state, '/save').filter((call) => call.hasT);
  const resets = callsWithVerb(state, '/reset');

  check('it succeeds when children do not inherit', result.ok === true, result.reason ?? '');
  check('it saved the tree once, with /T, before changing it',
    treeSaves.length === 1 && state.calls.indexOf(treeSaves[0]) < state.calls.indexOf(resets[0] ?? {}),
    `${treeSaves.length} /save /T call(s): ${describeCalls(state)}`);
  check('it reset the children once, with /T', resets.length === 1 && resets[0].hasT,
    `${resets.length} /reset call(s): ${describeCalls(state)}`);

  const everyoneAce = Object.values(state.paths).some((record) => (record.explicit ?? [])
    .some((entry) => String(entry.trustee).toUpperCase() === TRUSTEES.EVERYONE.toUpperCase()
      && entry.level === 'F'));
  check('the explicit Everyone:F ACE is gone afterwards', everyoneAce === false);

  const emptyFile = resetChildrenTarget(state, tree);
  check('the file with the empty DACL inherits again',
    emptyFile !== null && emptyFile.inherit !== false && (emptyFile.explicit ?? []).length === 0,
    JSON.stringify(emptyFile ?? null));

  const verified = await operator.verifyServiceCodeRoot({
    dir: tree.runtimeRoot,
    serviceAccount: true,
    runFile,
    log: () => {},
  });
  check('the result verifies afterwards', verified.ok === true, verified.reason ?? '');

  return { statePath: tree.statePath };
}

/** The state record of the empty-DACL file whose DACL the reset must restore. */
function resetChildrenTarget(state, tree) {
  const file = path.join(tree.runtimeRoot, 'app', 'node_modules', 'pkg000', 'lib', 'esm', 'file005.js');
  return state.paths[keyOf(file)] ?? null;
}

// ─── (e) a denied reset falls back to setowner ───────────────────────────────

async function testSetownerFallback({ operator, shell }) {
  setGroup('(e) reset denied: setowner first, then the reset succeeds');

  const tree = smallTree('setowner-fallback', {
    withEveryoneAce: false,
    emptyDaclOwner: OPERATOR.sid,
  });
  const runFile = icaclsRunFile(tree.statePath, shell);

  const result = await operator.protectCodeRoot(tree.runtimeRoot, {
    runFile,
    log: () => {},
    mode: 'recover',
  });
  const state = readState(tree.statePath);
  const order = state.calls.map((call) => call.verb ?? 'listing');

  const setownerIndex = order.indexOf('/setowner');
  const lastReset = order.lastIndexOf('/reset');

  check('it succeeds when a reset is refused for an empty, user-owned DACL',
    result.ok === true, result.reason ?? '');
  check('it took ownership and then reset again',
    setownerIndex !== -1 && lastReset > setownerIndex,
    order.join(' -> '));
  check('no /setowner ran before it was needed (no blanket ownership change)',
    state.calls.filter((call) => call.verb === '/setowner' && call.hasT).length <= 1,
    describeCalls(state));

  return { statePath: tree.statePath };
}

// ─── (f) a failed verification restores the saved ACL ────────────────────────

async function testRestoreOnFailure({ operator, shell }) {
  setGroup('(f) verification failure restores the saved ACL and says so');

  const tree = smallTree('restore-on-failure', {
    withEveryoneAce: false,
    emptyDaclOwner: TRUSTEES.ADMINISTRATORS,
  });
  // The read-back loses the service ACE on node.exe: the verification that
  // 1.4.7 got wrong must notice and the protect must put the ACL back.
  const nodePath = path.join(tree.runtimeRoot, 'node.exe');
  const state = readState(tree.statePath);
  state.rules = { hideAces: [{ path: nodePath, trustee: TRUSTEES.SERVICE }] };
  writeState(tree.statePath, state);

  const before = folderRecord(readState(tree.statePath), tree.runtimeRoot);
  const runFile = icaclsRunFile(tree.statePath, shell);

  const result = await operator.protectCodeRoot(tree.runtimeRoot, {
    runFile,
    log: () => {},
    mode: 'post-update',
  });

  const afterState = readState(tree.statePath);
  const after = folderRecord(afterState, tree.runtimeRoot);

  check('it reports the failure rather than a false success', result.ok === false,
    String(result.ok));
  check('it says the previous permissions were restored',
    result.restored === true && /restor/i.test(String(result.reason ?? '')),
    String(result.reason ?? '').slice(0, 160));
  check('it prints the next step', typeof result.next === 'string' && result.next.length > 0,
    String(result.next ?? ''));

  check('the folder ACL in the state is the one that was saved',
    JSON.stringify(before) === JSON.stringify(after),
    `before ${JSON.stringify(before).slice(0, 120)} / after ${JSON.stringify(after).slice(0, 120)}`);

  const save = callsWithVerb(afterState, '/save')
    .find((call) => (call.savedWatch ?? []).some((entry) => keyOf(entry.path) === keyOf(tree.runtimeRoot)));
  const savedFolder = save
    ? (() => {
      const record = (save.savedWatch ?? []).find((entry) => keyOf(entry.path) === keyOf(tree.runtimeRoot));
      return {
        owner: record.owner ?? null,
        inherit: record.inherit !== false,
        explicit: (record.explicit ?? [])
          .map((entry) => `${entry.trustee}:${[...(entry.flags ?? [])].sort().join('')}(${entry.level})`)
          .sort(),
      };
    })()
    : null;
  check('that saved ACL is identical to what the state holds now',
    savedFolder !== null && JSON.stringify(savedFolder) === JSON.stringify(after),
    savedFolder ? 'compared with the ACL the code saved' : 'the code saved no copy of the folder ACL');

  return { statePath: tree.statePath };
}

// ─── (g) SYSTEM and Administrators keep full control throughout ──────────────

function testIntermediateAcls(runs) {
  setGroup('(g) SYSTEM and Administrators keep full control at every recorded step');

  const failures = [];
  let snapshots = 0;

  for (const run of runs) {
    const state = readState(run.statePath);
    for (const call of state.calls) {
      for (const watched of call.snapshot ?? []) {
        snapshots += 1;
        const aces = watched.aces ?? [];
        const hasFull = (trustee) => aces.some((text) => new RegExp(`^${trustee.replace(/\\/g, '\\\\')}:.*\\(F\\)$`, 'i').test(text));
        if (!hasFull(TRUSTEES.SYSTEM)) {
          failures.push(`seq ${call.seq} (${call.verb ?? 'listing'}${call.hasT ? '/T' : ''}): no SYSTEM full control`);
        }
        if (!hasFull(TRUSTEES.ADMINISTRATORS)) {
          failures.push(`seq ${call.seq} (${call.verb ?? 'listing'}${call.hasT ? '/T' : ''}): no Administrators full control`);
        }
      }
    }
  }

  check('every recorded intermediate state kept SYSTEM:F and Administrators:F on the folder',
    failures.length === 0,
    failures.length ? failures.slice(0, 3).join('; ') : `${snapshots} snapshot(s)`);
  check('the runs actually recorded intermediate states', snapshots >= runs.length * 3,
    `${snapshots} snapshot(s) across ${runs.length} run(s)`);

  // The fake no-ops a verb it does not model and records it. If the code under
  // test used one, the groups above would be asserting on an incomplete model.
  const unknown = new Set();
  for (const run of runs) {
    for (const verb of readState(run.statePath).unknownVerbs ?? []) unknown.add(verb);
  }
  check('the code used only icacls verbs the fake models', unknown.size === 0,
    [...unknown].join(', '));
}

// ─── (h) timing ──────────────────────────────────────────────────────────────

function testTiming(protectResult, fileCount) {
  setGroup('(h) the 30-second target on an 11,000-file runtime');

  const elapsed = protectResult?.elapsedMs ?? null;
  note(`measured: ${elapsed === null ? 'not run' : `${(elapsed / 1000).toFixed(2)} s`} for ${fileCount} files`);
  check(`protectCodeRoot finishes in under ${PROTECT_BUDGET_MS / 1000} s`,
    typeof elapsed === 'number' && elapsed < PROTECT_BUDGET_MS,
    `${elapsed} ms`);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nWindows ACL read-back at real scale (1.4.7 regression)\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);
  if (!IS_WINDOWS) {
    note('this machine is not Windows: the shims are injected, so the suite still runs;');
    note('the ACL paths themselves are only proven on a real Windows machine before release.');
  }

  const modules = await loadModules();
  const hasProtect = typeof modules.operator.protectCodeRoot === 'function';
  const hasVerify = typeof modules.operator.verifyServiceCodeRoot === 'function';

  // The 11,000-file tree. Built once: (a), (b) and (c) all read it.
  const largeRoot = scratch('large');
  const runtimeRoot = path.join(largeRoot, 'runtime');
  const built = buildRuntimeTree(runtimeRoot, LARGE_PACKAGES);
  const tree = {
    root: largeRoot,
    runtimeRoot,
    fileCount: built.files,
    dirs: built.dirs,
    protectElapsedMs: null,
  };
  note(`built ${tree.fileCount} files in ${tree.dirs} directories under ${runtimeRoot}`);
  if (typeof modules.operator.REQUIRED_CODE_FILES !== 'object') {
    note('operator.js does not export REQUIRED_CODE_FILES yet (lane A contract)');
  }

  const runs = [];
  try {
    const reproduction = await testReproduction({ shell: modules.shell, tree });
    tree.reportBytes = reproduction.fullBytes;
  } catch (error) {
    check('(a) the reproduction ran', false, error.message);
  }

  if (!hasProtect || !hasVerify) {
    check('operator.js exports protectCodeRoot and verifyServiceCodeRoot (1.4.8 contract)',
      false, `${hasProtect ? '' : 'protectCodeRoot missing '}${hasVerify ? '' : 'verifyServiceCodeRoot missing'}`.trim());
    for (const name of ['(b) verifyServiceCodeRoot', '(c) protectCodeRoot', '(d) reset path',
      '(e) setowner fallback', '(f) restore on failure', '(g) intermediate ACLs', '(h) timing']) {
      skip(`${name}: blocked`, 'the 1.4.8 operator.js interface is not on disk yet');
    }
  } else {
    check('operator.js exports protectCodeRoot and verifyServiceCodeRoot (1.4.8 contract)', true);

    try {
      await testVerifyHealthy({ operator: modules.operator, shell: modules.shell, tree });
    } catch (error) {
      check('(b) verifyServiceCodeRoot ran', false, error.message);
    }

    let protect = null;
    try {
      protect = await testProtectHealthy({ operator: modules.operator, shell: modules.shell, tree });
      runs.push({ statePath: protect.statePath });
    } catch (error) {
      check('(c) protectCodeRoot ran on the healthy tree', false, error.message);
    }

    try {
      runs.push(await testResetPath({ operator: modules.operator, shell: modules.shell }));
    } catch (error) {
      check('(d) the reset path ran', false, error.message);
    }

    try {
      runs.push(await testSetownerFallback({ operator: modules.operator, shell: modules.shell }));
    } catch (error) {
      check('(e) the setowner fallback ran', false, error.message);
    }

    try {
      runs.push(await testRestoreOnFailure({ operator: modules.operator, shell: modules.shell }));
    } catch (error) {
      check('(f) the restore path ran', false, error.message);
    }

    try {
      testIntermediateAcls(runs);
    } catch (error) {
      check('(g) the snapshots were read', false, error.message);
    }

    testTiming(protect, tree.fileCount);
  }

  const failed = results.filter((result) => !result.passed);
  const skipped = results.filter((result) => result.skipped);
  process.stdout.write(`\n${'-'.repeat(68)}\n`);
  if (tree.reportBytes) {
    process.stdout.write(`the fake's /T output for ${tree.fileCount} files: ${tree.reportBytes} bytes\n`);
  }
  process.stdout.write(
    `TOTAL ${results.length}   PASS ${results.length - failed.length - skipped.length}`
    + `   SKIP ${skipped.length}   FAIL ${failed.length}\n`,
  );
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failed) {
      process.stdout.write(`  [${failure.group}] ${failure.label}`
        + `${failure.detail ? ` - ${failure.detail}` : ''}\n`);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
