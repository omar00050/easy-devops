/**
 * e2e/acl-stream.test.mjs
 *
 * The line-level parser behind the 1.4.8 ACL read-back (lane A).
 *
 * Run with: node e2e/run.mjs acl-stream
 *
 * Why this suite exists
 * ---------------------
 * 1.4.7 read a whole runtime back with `icacls <root>\* /T /C` and parsed the
 * CAPTURED output. `core/shell.js` keeps only the newest 64 KiB of stdout and
 * `icacls` prints a folder's own matches first, so `runtime\node.exe` was gone
 * by the time the code looked: "node.exe is missing from the read-back". The
 * fix streams the output line by line instead, so a chunk boundary in the
 * middle of a path, a CRLF split across two chunks, or a listing far larger
 * than any buffer can no longer lose an entry.
 *
 * This suite tests that parser in isolation, against `onData` chunks exactly as
 * `core/shell.js` delivers them. The end-to-end ACL transaction (with a real
 * fake icacls process, an 11,000-file tree and the restore paths) is
 * e2e/acl-large-tree.test.mjs.
 *
 * Nothing real is touched: no icacls, no ACL, no service. Every `runFile` is an
 * in-process function that answers with the bytes this suite chooses.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (relative) => pathToFileURL(path.join(ROOT, 'src', relative)).href;

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

const SYSTEM = 'NT AUTHORITY\\SYSTEM';
const ADMINS = 'BUILTIN\\Administrators';
const USERS = 'BUILTIN\\Users';
const SERVICE = 'NT SERVICE\\EasyDevOps';

/**
 * A `runFile` that answers one icacls call with pre-chosen chunks, delivered
 * through `onData` the way core/shell.js does, and returns a small captured
 * tail (never the whole listing: that is the point).
 */
function chunkedRunFile(chunks, { success = true, stderr = '', stdoutTail = '' } = {}) {
  const calls = [];
  const runFile = async (file, args, options = {}) => {
    calls.push({
      file,
      args: [...(args ?? [])],
      timeout: options.timeout,
      output: options.output,
    });
    if (!success) return { success: false, stdout: stdoutTail, stderr, exitCode: 1 };
    for (const chunk of chunks) {
      if (typeof options.onData === 'function') options.onData(chunk, 'stdout');
    }
    if (stderr && typeof options.onData === 'function') options.onData(stderr, 'stderr');
    return { success: true, stdout: stdoutTail, stderr, exitCode: 0 };
  };
  runFile.calls = calls;
  return runFile;
}

/** One entry as real icacls prints it: path + first ACE, the rest indented. */
function entry(target, aces, { blankLine = true } = {}) {
  if (aces.length === 0) return `${target}\r\n${blankLine ? '\r\n' : ''}`;
  const indent = ' '.repeat(target.length + 1);
  const lines = [`${target} ${aces[0]}`];
  for (const ace of aces.slice(1)) lines.push(`${indent}${ace}`);
  return `${lines.join('\r\n')}\r\n${blankLine ? '\r\n' : ''}`;
}

const healthyAces = (inherited = true) => [
  `${SYSTEM}:${inherited ? '(I)' : ''}(OI)(CI)(F)`,
  `${ADMINS}:${inherited ? '(I)' : ''}(OI)(CI)(F)`,
  `${USERS}:${inherited ? '(I)' : ''}(OI)(CI)(RX)`,
  `${SERVICE}:${inherited ? '(I)' : ''}(OI)(CI)(RX)`,
];

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'acl-stream', name);
  assertInsideTestDataDir(dir, `create ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── (a) the listing parser keeps the rules it always had ────────────────────

async function testListingParser(acl) {
  setGroup('(a) parseIcaclsListing: path lines, indented ACEs, empty DACLs');

  const sample = [
    `C:\\data\\runtime\\node.exe ${SYSTEM}:(I)(F)`,
    `                     ${ADMINS}:(I)(F)`,
    `                     ${SERVICE}:(I)(RX)`,
    '',
    `C:\\data\\runtime\\empty.dll`,
    '',
    `C:\\data\\runtime\\app ${SYSTEM}:(OI)(CI)(F)`,
    `                 Everyone:(OI)(CI)(F)`,
    '',
    'Successfully processed 3 files; Failed processing 0 files',
    '',
  ].join('\r\n');

  const entries = acl.parseIcaclsListing(sample);
  check('three entries are read from one listing', entries.length === 3, String(entries.length));
  check('the first entry keeps all three ACEs', entries[0]?.aces.length === 3,
    JSON.stringify(entries[0]?.aces ?? null));
  check('an indented ACE stays with the path above it',
    entries[0]?.aces[2]?.trustee === SERVICE,
    entries[0]?.aces[2]?.trustee ?? '');
  check('a path with no ACE is an EMPTY DACL entry, kept and marked by no aces',
    entries[1]?.path?.endsWith('empty.dll') === true && entries[1]?.aces.length === 0,
    JSON.stringify(entries[1] ?? null));
  check('the ACE on a path line is not merged into the previous entry',
    entries[2]?.aces.length === 2 && entries[2]?.aces[1]?.trustee === 'Everyone',
    JSON.stringify(entries[2]?.aces ?? null));
  check('the summary line never becomes an entry',
    entries.every((parsed) => !/Successfully processed/i.test(parsed.path)),
    entries.map((parsed) => parsed.path).join(' | '));

  // A per-file error must not become an entry either: it is not a path.
  const withError = acl.parseIcaclsListing([
    'C:\\data\\runtime\\node.exe: Access is denied.',
    'Successfully processed 0 files; Failed processing 1 files',
  ].join('\r\n'));
  check('a per-file "Access is denied" line is not read as a path',
    withError.every((parsed) => !/Access is denied/i.test(parsed.path)),
    withError.map((parsed) => parsed.path).join(' | '));
}

// ─── (b) chunk boundaries ────────────────────────────────────────────────────

async function testChunkBoundaries(acl) {
  setGroup('(b) streamIcaclsTree: a chunk boundary in the middle of a line');

  const listing = entry('C:\\data\\runtime\\node.exe', healthyAces())
    + entry('C:\\data\\runtime\\app\\package.json', healthyAces())
    + 'Successfully processed 2 files; Failed processing 0 files\r\n';

  // Split inside a path, inside an ACE, and between \r and \n.
  const cuts = [
    listing.slice(0, 12),
    listing.slice(12, 15),
    listing.slice(15, 60),
    listing.slice(60, 61),
    listing.slice(61, 400),
    listing.slice(400, 900),
    listing.slice(900),
  ];
  const runFile = chunkedRunFile(cuts);
  const seen = [];
  const result = await acl.streamIcaclsTree('C:\\data\\runtime', {
    runFile,
    onEntry: (parsed) => seen.push(parsed),
  });

  check('every entry is delivered despite seven cut points', seen.length === 2, String(seen.length));
  check('the entry split mid-path still carries the whole path',
    seen[0]?.path === 'C:\\data\\runtime\\node.exe', seen[0]?.path ?? '');
  check('its ACEs are intact', seen[0]?.aces.length === 4, String(seen[0]?.aces.length));
  check('the second entry survives a CRLF split across chunks',
    seen[1]?.path === 'C:\\data\\runtime\\app\\package.json', seen[1]?.path ?? '');
  check('the scan reports the number of entries it saw', result.count === 2, String(result.count));
  check('and it succeeds', result.ok === true, result.error ?? '');
  check('it runs exactly one icacls process: <root>\\* /T /C /Q',
    runFile.calls.length === 1
      && JSON.stringify(runFile.calls[0].args) === JSON.stringify(['C:\\data\\runtime\\*', '/T', '/C', '/Q']),
    JSON.stringify(runFile.calls.map((call) => call.args)));
  check('it asks shell.js for streamed output, keeping no captured copy',
    runFile.calls[0].output === 'stream',
    String(runFile.calls[0].output));
  check('the timeout it is given is finite',
    Number.isFinite(runFile.calls[0].timeout) && runFile.calls[0].timeout > 0,
    String(runFile.calls[0].timeout));
}

// ─── (c) no size cap, and an empty DACL in the middle ────────────────────────

async function testLargeAndEmpty(acl) {
  setGroup('(c) a listing far larger than any buffer, with an empty DACL inside');

  const many = [];
  const EMPTY_AT = 9_000;
  for (let i = 0; i < 12_000; i += 1) {
    const target = `C:\\data\\runtime\\app\\node_modules\\pkg${i}\\lib\\file${i}.js`;
    many.push(entry(target, i === EMPTY_AT ? [] : healthyAces()));
  }
  many.push('Successfully processed 12000 files; Failed processing 0 files\r\n');

  // Delivered as chunks of 1000 characters, like a pipe would.
  const joined = many.join('');
  const chunks = [];
  for (let at = 0; at < joined.length; at += 1000) chunks.push(joined.slice(at, at + 1000));

  const runFile = chunkedRunFile(chunks);
  let empty = null;
  let count = 0;
  const result = await acl.streamIcaclsTree('C:\\data\\runtime', {
    runFile,
    onEntry: (parsed) => {
      count += 1;
      if (parsed.aces.length === 0) empty = parsed.path;
    },
  });

  check('all 12,000 entries are seen, whatever their size', result.count === 12_000 && count === 12_000,
    `${result.count}/${count}`);
  check('the empty DACL in the middle is delivered as an entry with no ACEs',
    empty === 'C:\\data\\runtime\\app\\node_modules\\pkg9000\\lib\\file9000.js', String(empty));
  check('the scan still succeeds structurally', result.ok === true, result.error ?? '');
}

// ─── (d) the summary and the failing lines ───────────────────────────────────

async function testFailures(acl) {
  setGroup('(d) "Failed processing N files" is a failure, with at most five lines');

  const lines = [];
  for (let i = 0; i < 9; i += 1) {
    lines.push(`C:\\data\\runtime\\bad${i}.dll\r\nAccess is denied.\r\n\r\n`);
  }
  lines.push(`C:\\data\\runtime\\good.exe ${healthyAces()[0]}\r\n\r\n`);
  lines.push('Successfully processed 1 files; Failed processing 9 files\r\n');

  const runFile = chunkedRunFile([lines.join('')]);
  const result = await acl.streamIcaclsTree('C:\\data\\runtime', { runFile });

  check('a non-zero failed count is not a pass', result.ok === false, String(result.ok));
  check('the error says how many files failed and keeps the first five lines',
    /9 files could not be processed/i.test(result.error ?? '')
      && result.failed.length === 5
      && result.failed.every((line) => /Access is denied/i.test(line)),
    `${result.error ?? ''} :: ${result.failed.join(' | ')}`);

  // A non-zero exit code is a failure even with a clean summary.
  const refused = chunkedRunFile([], { success: false, stderr: 'Access is denied.\r\n' });
  const failed = await acl.streamIcaclsTree('C:\\data\\runtime', { runFile: refused });
  check('a refused icacls call is a failure with its message',
    failed.ok === false && /access is denied/i.test(failed.error ?? ''),
    failed.error ?? '');

  // A stub that returns bytes but never calls onData is a failed read, not a
  // listing to parse: with `output: 'stream'` there is no captured copy to fall
  // back to, and a listing that never arrived must never read as "all fine".
  const silentStub = async (file, args, options = {}) => ({
    success: true,
    stdout: entry('C:\\data\\runtime\\node.exe', healthyAces()),
    stderr: '',
  });
  const silent = await acl.streamIcaclsTree('C:\\data\\runtime', { runFile: silentStub });
  check('a runFile that streams nothing is a failure, never a parse of its stdout',
    silent.ok === false && /no output/i.test(silent.error ?? '') && silent.count === 0,
    `${silent.ok} ${silent.error ?? ''} count ${silent.count}`);

  // The one real case where nothing is streamed: a code root with no children
  // yet, protected before its first copy. There is nothing to verify there.
  const emptyRoot = scratch('empty-code-root');
  const emptySilent = async () => ({ success: true, stdout: '', stderr: '' });
  const emptyScan = await acl.streamIcaclsTree(emptyRoot, { runFile: emptySilent });
  check('an empty code root prints nothing and is still a pass with zero entries',
    emptyScan.ok === true && emptyScan.count === 0,
    `${emptyScan.ok} ${emptyScan.error ?? ''}`);
}

// ─── (e) readPathAccess: one path, one icacls ───────────────────────────────

async function testReadPathAccess(acl) {
  setGroup('(e) readPathAccess reads ONE path for a status answer');

  const folder = String.raw`C:\ProgramData\easy-devops`;
  const calls = [];
  const runFile = async (file, args) => {
    calls.push({ file, args: [...(args ?? [])] });
    return {
      success: true,
      stdout: [
        `${folder} ${SYSTEM}:(OI)(CI)(F)`,
        `          ${ADMINS}:(OI)(CI)(F)`,
        `          ${SERVICE}:(OI)(CI)(M)`,
        '',
      ].join('\r\n'),
      stderr: '',
    };
  };

  const access = await acl.readPathAccess(folder, { runFile, trustees: [SERVICE] });
  check('it runs exactly one icacls call, without /T',
    calls.length === 1 && calls[0].args.length === 1 && calls[0].args[0] === folder,
    JSON.stringify(calls.map((call) => call.args)));
  check('it reports the path as existing and readable', access.exists === true
    && access.ok === true && access.readable === true, JSON.stringify(access.aces));
  check('Modify is reported, because the service ACE is M', access.modify === true, String(access.modify));
  check('full control is not reported for the service', access.full === false, String(access.full));
  check('every ACE is returned for the caller to inspect', access.aces.length === 3, String(access.aces.length));

  const missingRun = async () => ({
    success: false,
    stdout: 'The system cannot find the file specified.\r\n',
    stderr: '',
  });
  const missing = await acl.readPathAccess('C:\\no-such-directory', { runFile: missingRun });
  check('a missing path is exists:false and not an error',
    missing.exists === false && missing.ok === true && missing.readable === null,
    JSON.stringify(missing));

  const emptyRun = async () => ({
    success: true,
    stdout: `${folder}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`,
    stderr: '',
  });
  const empty = await acl.readPathAccess(folder, { runFile: emptyRun, trustees: [SERVICE] });
  check('an empty DACL is readable:false, not a silent pass',
    empty.exists === true && empty.ok === true && empty.readable === false,
    JSON.stringify(empty));
}

// ─── (f) removeCodeTree: a denied recursive check is recovered, in order ─────

/**
 * Runs one group with ProgramData redirected under this suite's temp folder, so
 * `isServiceCodeRoot` matches a real directory this test created. Restored
 * afterwards whatever happens.
 */
async function withTempProgramData(run) {
  const previous = process.env.ProgramData;
  // The guard's own data folder is under os.tmpdir(), which programDataDir()
  // accepts under EZ_TEST.
  process.env.ProgramData = TEST_DATA_DIR;
  try {
    return await run(path.win32.join(TEST_DATA_DIR, 'easy-devops'));
  } finally {
    if (previous === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = previous;
  }
}

async function testRemoveCodeTreeOrder(operator) {
  setGroup('(f) removeCodeTree recovers a tree whose recursive check is denied, in order');

  const blocker = await withTempProgramData(async (dataDir) => {
    const root = path.join(dataDir, 'runtime.prev');
    fs.mkdirSync(path.join(root, 'app', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'index.js'), '// empty-DACL tree\n');

    const order = [];
    let recursiveChecks = 0;
    const runFile = async (file, args, options = {}) => {
      const exe = path.win32.basename(String(file)).toLowerCase();
      if (exe === 'powershell.exe') {
        const recursive = options.env?.EZ_ACL_TREE === '1';
        order.push(recursive ? 'check-recursive' : 'check-root');
        if (recursive) {
          recursiveChecks += 1;
          if (recursiveChecks === 1) {
            return { success: false, stdout: '', stderr: 'Access is denied.\r\n' };
          }
        }
        return { success: true, stdout: '', stderr: '' };
      }
      if (exe === 'icacls.exe') {
        if (args.includes('/setowner')) order.push(args[0].endsWith('*') ? 'setowner-children' : 'setowner-root');
        else if (args.includes('/reset')) order.push(args[0].endsWith('*') ? 'reset-children' : 'reset-root');
        return { success: true, stdout: 'Successfully processed 1 files', stderr: '' };
      }
      return { success: false, stdout: '', stderr: `unexpected ${exe}` };
    };

    const result = await operator.removeCodeTree({ dir: root, runFile, log: () => {} });
    return { result, order, root, recursiveChecks };
  });

  const { result, order, root } = blocker;
  check('the tree is removed after the denied recursive check', result.ok === true, result.reason ?? '');
  check('the recursive check is refused first, then the root is checked on its own',
    order.slice(0, 2).join(',') === 'check-recursive,check-root',
    order.join(' -> '));
  check('ownership and a reset run for the children and the folder itself',
    order.includes('setowner-children') && order.includes('setowner-root')
      && order.includes('reset-children') && order.includes('reset-root'),
    order.join(' -> '));
  check('the whole tree is checked again AFTER the reset, before anything is deleted',
    order.lastIndexOf('check-recursive') > order.indexOf('reset-root')
      && order.lastIndexOf('check-recursive') < order.length,
    order.join(' -> '));
  check('and the folder is really gone', fs.existsSync(root) === false, String(root));
}

// ─── (g) addServiceReadToCodeRoot: one additive folder grant ────────────────

function accessListing(target, { service = true } = {}) {
  const aces = [
    `${SYSTEM}:(I)(OI)(CI)(F)`,
    `${ADMINS}:(I)(OI)(CI)(F)`,
    `${USERS}:(I)(OI)(CI)(RX)`,
  ];
  if (service) aces.push(`${SERVICE}:(I)(OI)(CI)(RX)`);
  const indent = ' '.repeat(target.length + 1);
  return `${[`${target} ${aces[0]}`, ...aces.slice(1).map((ace) => indent + ace)].join('\r\n')}\r\n`;
}

async function testAddServiceRead(operator) {
  setGroup('(g) addServiceReadToCodeRoot adds one inherited grant and never scans the tree');

  await withTempProgramData(async (dataDir) => {
    const root = path.join(dataDir, 'bin');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'EasyDevOps.exe'), 'wrapper');
    fs.writeFileSync(path.join(root, 'EasyDevOps.xml'), '<service/>');

    const calls = [];
    const makeRunFile = (visible) => async (file, args) => {
      const exe = path.win32.basename(String(file)).toLowerCase();
      calls.push({ exe, args: [...args] });
      if (exe === 'icacls.exe' && args.includes('/save')) return { success: true, stdout: '', stderr: '' };
      if (exe === 'icacls.exe' && args.includes('/restore')) return { success: true, stdout: '', stderr: '' };
      if (exe === 'icacls.exe' && args.includes('/grant')) {
        visible.service = true;
        return { success: true, stdout: '', stderr: '' };
      }
      if (exe === 'icacls.exe' && args.length === 1) {
        const isFolder = args[0].toLowerCase() === root.toLowerCase();
        return { success: true, stdout: accessListing(args[0], { service: isFolder ? visible.service : true }), stderr: '' };
      }
      return { success: false, stdout: '', stderr: `unexpected ${exe} ${args.join(' ')}` };
    };

    const visible = { service: false };
    const granted = await operator.addServiceReadToCodeRoot({
      dir: root, runFile: makeRunFile(visible), log: () => {},
    });
    const grantCalls = calls.filter((call) => call.args.includes('/grant'));
    check('the grant succeeds once the service account is read back', granted.ok === true, granted.reason ?? '');
    check('it writes ONE additive grant on the folder, with the service ACE only',
      grantCalls.length === 1
        && JSON.stringify(grantCalls[0].args)
          === JSON.stringify([root, '/grant', `${SERVICE}:(OI)(CI)RX`, '/L', '/Q']),
      JSON.stringify(grantCalls.map((call) => call.args)));
    check('no recursive pass and no /grant:r that could remove SYSTEM or Administrators',
      calls.every((call) => !call.args.includes('/T') && !call.args.includes('/grant:r')),
      JSON.stringify(calls.map((call) => call.args)));

    // Failure after the grant: the folder save is restored, the ACE is never
    // simply removed, and the install wording names the next step.
    const calls2 = [];
    const hidden = { service: false };
    const failing = async (file, args) => {
      const exe = path.win32.basename(String(file)).toLowerCase();
      calls2.push({ exe, args: [...args] });
      if (exe !== 'icacls.exe') return { success: false, stdout: '', stderr: 'unexpected' };
      if (args.includes('/save')) return { success: true, stdout: '', stderr: '' };
      if (args.includes('/restore')) return { success: true, stdout: '', stderr: '' };
      if (args.includes('/grant')) return { success: true, stdout: '', stderr: '' };
      if (args.length === 1) {
        const isFolder = args[0].toLowerCase() === root.toLowerCase();
        // The service ACE never appears: the read-back must fail.
        return { success: true, stdout: accessListing(args[0], { service: isFolder ? false : true }), stderr: '' };
      }
      return { success: false, stdout: '', stderr: 'unexpected' };
    };
    const failed = await operator.addServiceReadToCodeRoot({
      dir: root, runFile: failing, log: () => {},
    });
    check('a failed read-back is reported, with the restore named',
      failed.ok === false && failed.restored === true
        && /restored/i.test(failed.reason ?? '') && /ezz service recover/.test(failed.next ?? ''),
      `${failed.ok} ${failed.restored} ${failed.reason ?? ''}`);
    check('the folder save is restored, never a /remove:g of the service ACE',
      calls2.some((call) => call.args.includes('/restore'))
        && !calls2.some((call) => call.args.includes('/remove:g')),
      JSON.stringify(calls2.map((call) => call.args)));
    void hidden;
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nStreamed icacls read-back (1.4.8 lane A)\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  const acl = await import(srcUrl('core/service/acl.js'));
  const operator = await import(srcUrl('core/service/operator.js'));
  const hasStream = typeof acl.streamIcaclsTree === 'function';
  const hasRead = typeof acl.readPathAccess === 'function';
  check('acl.js exports streamIcaclsTree and readPathAccess (1.4.8 contract)',
    hasStream && hasRead,
    `${hasStream ? '' : 'streamIcaclsTree missing '}${hasRead ? '' : 'readPathAccess missing'}`.trim());
  check('operator.js exports removeCodeTree and addServiceReadToCodeRoot',
    typeof operator.removeCodeTree === 'function'
      && typeof operator.addServiceReadToCodeRoot === 'function',
    `${typeof operator.removeCodeTree} ${typeof operator.addServiceReadToCodeRoot}`);

  if (hasStream && hasRead) {
    await testListingParser(acl);
    await testChunkBoundaries(acl);
    await testLargeAndEmpty(acl);
    await testFailures(acl);
    await testReadPathAccess(acl);
    await testRemoveCodeTreeOrder(operator);
    await testAddServiceRead(operator);
  }

  const failed = results.filter((result) => !result.passed);
  const skipped = results.filter((result) => result.skipped);
  process.stdout.write(`\n${'-'.repeat(68)}\n`);
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
