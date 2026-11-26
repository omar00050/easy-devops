/**
 * Regression coverage for EZ-16's process-output and nginx-log memory bounds.
 *
 * The sparse nginx fixture is much larger than the reader's budget. File I/O
 * is intercepted for the configured nginx log path, so this suite can verify
 * the bounds without reading a huge payload or touching a real nginx install.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (relative) => pathToFileURL(path.join(ROOT, 'src', relative)).href;

const results = [];
let group = '';

function setGroup(name) {
  group = name;
  process.stdout.write(`\n-- ${group}\n`);
}

function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(
    `   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`,
  );
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(50);
  }
  return null;
}

function shellQuote(value) {
  const text = String(value);
  if (process.platform === 'win32') return `'${text.replaceAll("'", "''")}'`;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function nodeThroughConfiguredShell(source) {
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  const evaluator = `eval(Buffer.from('${encoded}','base64').toString())`;
  const executable = shellQuote(process.execPath);
  return process.platform === 'win32'
    ? `& ${executable} -e ${shellQuote(evaluator)}`
    : `${executable} -e ${shellQuote(evaluator)}`;
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function withInterceptedLog(expectedPath, fixturePath, callback) {
  const originalOpen = fsp.open;
  const originalReadFile = fsp.readFile;
  const target = normalizedPath(expectedPath);
  const stats = { opens: 0, readFileCalls: 0, bytesRead: 0, maxReadRequest: 0 };

  fsp.open = async (file, flags, mode) => {
    if (normalizedPath(file) !== target) return originalOpen(file, flags, mode);

    stats.opens += 1;
    const handle = await originalOpen(fixturePath, flags, mode);
    const originalRead = handle.read.bind(handle);
    handle.read = async (...args) => {
      const requested = typeof args[0] === 'object'
        ? Number(args[0]?.length ?? 0)
        : Number(args[2] ?? 0);
      stats.maxReadRequest = Math.max(stats.maxReadRequest, requested);
      const read = await originalRead(...args);
      stats.bytesRead += read.bytesRead;
      return read;
    };
    return handle;
  };

  fsp.readFile = async (file, ...args) => {
    if (normalizedPath(file) === target) {
      stats.readFileCalls += 1;
      throw new Error('getLogs attempted a whole-file read');
    }
    return originalReadFile(file, ...args);
  };

  try {
    return await callback(stats);
  } finally {
    fsp.open = originalOpen;
    fsp.readFile = originalReadFile;
  }
}

async function testShellBounds() {
  setGroup('shell capture keeps bounded byte tails and streams every chunk');
  const shell = await import(srcUrl('core/shell.js'));
  const limit = shell.SHELL_CAPTURE_TAIL_BYTES;

  check('the shell capture budget is explicitly bounded', limit === 64 * 1024, String(limit));

  const floodSource = `
    const limit = ${limit};
    const fill = Buffer.alloc(limit, 111);
    function flood(stream, label) {
      stream.write(Buffer.from('OLD-' + label + '-START'));
      stream.write(fill);
      stream.write(Buffer.from('MIDDLE-' + label));
      stream.write(fill);
      stream.write(Buffer.from('NEW-' + label + '-END'));
    }
    flood(process.stdout, 'OUT');
    flood(process.stderr, 'ERR');
  `;

  const streamed = await shell.run(nodeThroughConfiguredShell(floodSource));
  check('run succeeds with newline-free large output', streamed.success && streamed.exitCode === 0);
  check('run bounds stdout to the configured byte tail',
    Buffer.byteLength(streamed.stdout, 'utf8') <= limit,
    `${Buffer.byteLength(streamed.stdout, 'utf8')} <= ${limit}`);
  check('run bounds stderr to the configured byte tail',
    Buffer.byteLength(streamed.stderr, 'utf8') <= limit,
    `${Buffer.byteLength(streamed.stderr, 'utf8')} <= ${limit}`);
  check('run retains the newest stdout and drops the old prefix',
    streamed.stdout.includes('NEW-OUT-END') && !streamed.stdout.includes('OLD-OUT-START'));
  check('run retains the newest stderr and drops the old prefix',
    streamed.stderr.includes('NEW-ERR-END') && !streamed.stderr.includes('OLD-ERR-START'));

  // The tail is explicit now: the result says how much it could not keep.
  // (The exact byte count is asserted over a direct spawn in
  // e2e/shell-output.test.mjs; a configured shell may translate line endings.)
  check('run reports that the tail dropped stdout bytes',
    streamed.truncated?.stdout > 0, String(streamed.truncated?.stdout));
  check('run reports that the tail dropped stderr bytes',
    streamed.truncated?.stderr > 0, String(streamed.truncated?.stderr));

  const boundarySource = `
    const limit = ${limit};
    const prefix = Buffer.alloc(limit - 1, 65);
    process.stdout.write(prefix);
    process.stdout.write(Buffer.from('éNEWEST-MULTIBYTE-END', 'utf8'));
    const fourBytePrefix = Buffer.alloc(limit - 2, 66);
    process.stderr.write(fourBytePrefix);
    process.stderr.write(Buffer.from('🛡NEWEST-EMOJI-END', 'utf8'));
  `;
  const boundary = await shell.run(nodeThroughConfiguredShell(boundarySource));
  check('a byte-tail boundary never fabricates a replacement character',
    boundary.success && !boundary.stdout.includes('\uFFFD') && !boundary.stderr.includes('\uFFFD'),
    `${JSON.stringify(boundary.stdout.slice(0, 24))} / ${JSON.stringify(boundary.stderr.slice(0, 24))}`);
  check('the bounded multibyte tail keeps only complete newest text',
    boundary.stdout.endsWith('NEWEST-MULTIBYTE-END')
      && boundary.stderr.endsWith('NEWEST-EMOJI-END')
      && Buffer.byteLength(boundary.stdout, 'utf8') <= limit
      && Buffer.byteLength(boundary.stderr, 'utf8') <= limit);

  const stdinResult = await shell.runWithStdin(process.execPath, ['-e', floodSource]);
  check('runWithStdin succeeds with newline-free large output',
    stdinResult.success && stdinResult.exitCode === 0);
  check('runWithStdin bounds stdout to the configured byte tail',
    Buffer.byteLength(stdinResult.stdout, 'utf8') <= limit,
    `${Buffer.byteLength(stdinResult.stdout, 'utf8')} <= ${limit}`);
  check('runWithStdin bounds stderr to the configured byte tail',
    Buffer.byteLength(stdinResult.stderr, 'utf8') <= limit,
    `${Buffer.byteLength(stdinResult.stderr, 'utf8')} <= ${limit}`);
  check('runWithStdin retains the newest stdout and drops the old prefix',
    stdinResult.stdout.includes('NEW-OUT-END') && !stdinResult.stdout.includes('OLD-OUT-START'));
  check('runWithStdin retains the newest stderr and drops the old prefix',
    stdinResult.stderr.includes('NEW-ERR-END') && !stdinResult.stderr.includes('OLD-ERR-START'));
  check('runWithStdin reports the bytes its tail dropped',
    stdinResult.truncated?.stdout > 0 && stdinResult.truncated?.stderr > 0,
    `${stdinResult.truncated?.stdout}/${stdinResult.truncated?.stderr}`);

  const onDataSource = `
    (async () => {
      for (const chunk of ['chunk-0|', 'chunk-1|', 'chunk-2|']) {
        process.stdout.write(chunk);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })().catch((err) => {
      process.stderr.write(err.stack || String(err));
      process.exitCode = 1;
    });
  `;
  let observed = '';
  let callbackCount = 0;
  const observedResult = await shell.run(nodeThroughConfiguredShell(onDataSource), {
    onData(chunk, stream) {
      if (stream === 'stdout') {
        callbackCount += 1;
        observed += chunk;
      }
    },
  });
  check('run still calls onData for every emitted stdout chunk',
    observedResult.success && callbackCount >= 3 && observed === 'chunk-0|chunk-1|chunk-2|',
    `${callbackCount} callback(s)`);
}

async function testNginxTail() {
  setGroup('nginx getLogs reads only a bounded backwards tail');

  const nginx = await import(srcUrl('core/nginx-service.js'));
  const { loadConfig } = await import(srcUrl('core/config.js'));
  const { nginxLogPath } = await import(srcUrl('core/platform.js'));
  const dir = scratch('nginx-log-bounds');
  const expectedLog = nginxLogPath(loadConfig().nginxDir, 'error');

  const largePath = path.join(dir, 'large-error.log');
  assertInsideTestDataDir(largePath, 'create the sparse nginx log');
  const largeSize = 64 * 1024 * 1024;
  const newest = Array.from({ length: 12 }, (_, index) => `newest-${index}`);
  const tailText = `\n${newest.join('\n')}\n`;
  const tail = Buffer.from(tailText, 'utf8');
  const fd = fs.openSync(largePath, 'w+');
  try {
    fs.ftruncateSync(fd, largeSize);
    fs.writeSync(fd, Buffer.from('ANCIENT-CONTENT\n'), 0, 16, 0);
    fs.writeSync(fd, tail, 0, tail.length, largeSize - tail.length);
  } finally {
    fs.closeSync(fd);
  }

  const sparseResult = await withInterceptedLog(expectedLog, largePath, async (stats) => {
    const result = await nginx.getLogs(4);
    return { result, stats };
  });

  check('the sparse fixture is larger than the entire read budget',
    largeSize > nginx.NGINX_LOG_TAIL_MAX_BYTES,
    `${largeSize} bytes`);
  check('getLogs returns the newest lines in source order',
    JSON.stringify(sparseResult.result.lines) === JSON.stringify(newest.slice(-4)),
    sparseResult.result.lines.join(' | '));
  check('getLogs preserves the existing response shape',
    JSON.stringify(Object.keys(sparseResult.result)) === JSON.stringify(['lines']));
  check('getLogs does not call fs.readFile',
    sparseResult.stats.readFileCalls === 0,
    `${sparseResult.stats.readFileCalls} call(s)`);
  check('getLogs reads no more than its fixed byte budget',
    sparseResult.stats.bytesRead <= nginx.NGINX_LOG_TAIL_MAX_BYTES,
    `${sparseResult.stats.bytesRead} <= ${nginx.NGINX_LOG_TAIL_MAX_BYTES}`);
  check('getLogs reads backwards in fixed-size chunks',
    sparseResult.stats.maxReadRequest <= nginx.NGINX_LOG_TAIL_CHUNK_BYTES,
    `${sparseResult.stats.maxReadRequest} <= ${nginx.NGINX_LOG_TAIL_CHUNK_BYTES}`);

  const cappedPath = path.join(dir, 'newline-free-error.log');
  assertInsideTestDataDir(cappedPath, 'create the capped nginx log');
  const finalFragment = Buffer.from('NEWEST-NEWLINE-FREE-FRAGMENT', 'utf8');
  const cappedFd = fs.openSync(cappedPath, 'w+');
  try {
    fs.ftruncateSync(cappedFd, largeSize);
    fs.writeSync(
      cappedFd,
      finalFragment,
      0,
      finalFragment.length,
      largeSize - finalFragment.length,
    );
  } finally {
    fs.closeSync(cappedFd);
  }

  const capped = await withInterceptedLog(expectedLog, cappedPath, async (stats) => {
    const result = await nginx.getLogs(nginx.NGINX_LOG_MAX_LINES);
    return { result, stats };
  });
  check('a newline-free oversized log reaches, but never exceeds, the byte ceiling',
    capped.stats.bytesRead === nginx.NGINX_LOG_TAIL_MAX_BYTES,
    `${capped.stats.bytesRead} = ${nginx.NGINX_LOG_TAIL_MAX_BYTES}`);
  check('the capped read still uses fixed-size chunks and no whole-file load',
    capped.stats.maxReadRequest <= nginx.NGINX_LOG_TAIL_CHUNK_BYTES
    && capped.stats.readFileCalls === 0);
  check('an incomplete line beyond the ceiling is not returned as a fabricated line',
    capped.result.lines.length === 0);

  const linesPath = path.join(dir, 'line-semantics.log');
  const many = Array.from({ length: nginx.NGINX_LOG_MAX_LINES + 7 }, (_, index) => `line-${index}`);
  assertInsideTestDataDir(linesPath, 'create the nginx line fixture');
  fs.writeFileSync(linesPath, `\n${many.join('\n')}\n\n`, 'utf8');

  const semantics = await withInterceptedLog(expectedLog, linesPath, async () => {
    const clamped = await nginx.getLogs(Number.MAX_SAFE_INTEGER);
    const zero = await nginx.getLogs(0);
    return { clamped, zero };
  });

  check('the line count is clamped to the core maximum',
    semantics.clamped.lines.length === nginx.NGINX_LOG_MAX_LINES,
    `${semantics.clamped.lines.length} lines`);
  check('the newest line is retained after clamping',
    semantics.clamped.lines.at(-1) === many.at(-1),
    semantics.clamped.lines.at(-1) ?? '(missing)');
  check('empty lines are filtered and a trailing newline adds no empty entry',
    semantics.clamped.lines.every((line) => line.length > 0));
  check('zero and other low counts clamp to one line',
    semantics.zero.lines.length === 1 && semantics.zero.lines[0] === many.at(-1));
}

function trackingFs(stats) {
  return {
    ...fs,
    openSync(file, flags, mode) {
      stats.opens += 1;
      return fs.openSync(file, flags, mode);
    },
    readSync(fd, buffer, offset, length, position) {
      stats.reads += 1;
      stats.maxReadRequest = Math.max(stats.maxReadRequest, length);
      const read = fs.readSync(fd, buffer, offset, length, position);
      stats.bytesRead += read;
      return read;
    },
  };
}

async function testWindowsServiceLogs() {
  setGroup('Windows service logs use a bounded, newline-aware tail');

  const windows = await import(srcUrl('core/service/windowsService.js'));
  const personal = await import(srcUrl('core/service/windowsPersonal.js'));
  const logTail = await import(srcUrl('core/service/logTail.js'));
  const dir = scratch('windows-service-log-bounds');

  const large = path.join(dir, 'wrapper.log');
  assertInsideTestDataDir(large, 'create the Windows service log');
  const body = [
    'ANCIENT-LINE-MUST-NOT-BE-READ',
    'x'.repeat(2 * 1024 * 1024),
    'recent-1',
    'recent-2',
    'recent-3',
    'NEWEST-WINDOWS-LINE',
    '',
  ].join('\n');
  fs.writeFileSync(large, body, 'utf8');

  const stats = { opens: 0, reads: 0, bytesRead: 0, maxReadRequest: 0 };
  const result = windows.readLogs({
    file: large,
    lines: 3,
    fsApi: trackingFs(stats),
  });
  check('Windows service readLogs preserves its response shape',
    result.ok === true && result.file === large && typeof result.output === 'string');
  check('Windows service readLogs reads no more than 1 MiB',
    stats.bytesRead <= logTail.SERVICE_LOG_TAIL_MAX_BYTES,
    `${stats.bytesRead} <= ${logTail.SERVICE_LOG_TAIL_MAX_BYTES}`);
  check('Windows service readLogs uses fixed-size requests',
    stats.maxReadRequest <= logTail.SERVICE_LOG_TAIL_CHUNK_BYTES,
    `${stats.maxReadRequest} <= ${logTail.SERVICE_LOG_TAIL_CHUNK_BYTES}`);
  check('Windows service readLogs returns the newest complete lines',
    result.output.endsWith('recent-2\nrecent-3\nNEWEST-WINDOWS-LINE')
      && !result.output.includes('ANCIENT-LINE-MUST-NOT-BE-READ'),
    result.output.slice(-120));

  const personalStats = { opens: 0, reads: 0, bytesRead: 0, maxReadRequest: 0 };
  const personalResult = personal.readLogs({
    file: large,
    lines: 2,
    fsApi: trackingFs(personalStats),
  });
  check('Personal supervisor logs use the same byte and request ceilings',
    personalResult.ok === true
      && personalStats.bytesRead <= logTail.SERVICE_LOG_TAIL_MAX_BYTES
      && personalStats.maxReadRequest <= logTail.SERVICE_LOG_TAIL_CHUNK_BYTES
      && personalResult.output.endsWith('recent-3\nNEWEST-WINDOWS-LINE'),
    JSON.stringify(personalStats));

  const partial = path.join(dir, 'partial-first-line.log');
  const prefix = Buffer.alloc(logTail.SERVICE_LOG_TAIL_MAX_BYTES, 'a'.charCodeAt(0));
  const suffix = Buffer.from(
    `\n${'b'.repeat(200)}\nCOMPLETE-ONE\nKEEP-NEWEST\n`,
    'utf8',
  );
  fs.writeFileSync(partial, Buffer.concat([prefix, suffix]));
  const tail = logTail.readBoundedTailSync(partial);
  const lines = logTail.completeLogLines(tail, 10);
  check('a tail that starts mid-line discards only that partial line',
    tail.startsMidFile === true
      && !lines.some((line) => /^a+$/.test(line))
      && lines.includes('COMPLETE-ONE')
      && lines.at(-1) === 'KEEP-NEWEST',
    JSON.stringify(lines.slice(0, 3)));

  const restartStats = { opens: 0, reads: 0, bytesRead: 0, maxReadRequest: 0 };
  windows.countRecentRestarts({ file: large, fsApi: trackingFs(restartStats) });
  check('restart-loop inspection obeys the same log bounds',
    restartStats.bytesRead <= logTail.SERVICE_LOG_TAIL_MAX_BYTES
      && restartStats.maxReadRequest <= logTail.SERVICE_LOG_TAIL_CHUNK_BYTES,
    JSON.stringify(restartStats));
}

async function testDeployLoggerFragmentBound() {
  setGroup('newline-free deployment output keeps a bounded fragment buffer');

  const engine = await import(srcUrl('core/deploy/engine.js'));
  const store = await import(srcUrl('core/deploy/store.js'));
  const apps = await import(srcUrl('core/deploy/apps.js'));

  const created = apps.createApp({
    id: 'log-fragment-bound',
    repoUrl: 'https://github.com/example/log-fragment.git',
    branch: 'main',
    authType: 'none',
  });
  if (!created.ok) throw new Error(created.errors.join(', '));

  const runId = '20261124-170000-abcdef';
  store.ensureAppDirs(created.app.id, TEST_DATA_DIR);
  const logger = engine.makeLogger(created.app.id, runId, []);
  const payload = 'z'.repeat(engine.MAX_LOG_FRAGMENT_CHARS * 2 + 137);
  const appended = [];
  const appendFileSync = fs.appendFileSync;
  fs.appendFileSync = function trackedAppend(file, data, ...args) {
    appended.push(String(data));
    return appendFileSync.call(this, file, data, ...args);
  };
  try {
    logger.output(payload);
    logger.flush();
  } finally {
    fs.appendFileSync = appendFileSync;
  }

  const file = store.logFile(created.app.id, runId, TEST_DATA_DIR);
  const persisted = fs.readFileSync(file, 'utf8');
  const longestFragmentWrite = Math.max(
    0,
    ...appended
      .filter((chunk) => chunk.includes('z'))
      .map((chunk) => chunk.replace(/^ {10}/, '').replace(/\n$/, '').length),
  );
  check("the logger's bounded fragment limit is explicit",
    engine.MAX_LOG_FRAGMENT_CHARS === 16 * 1024,
    String(engine.MAX_LOG_FRAGMENT_CHARS));
  check('a newline-free producer is written in bounded fragments',
    longestFragmentWrite <= engine.MAX_LOG_FRAGMENT_CHARS,
    `${longestFragmentWrite} <= ${engine.MAX_LOG_FRAGMENT_CHARS}`);
  check('bounded fragmentation does not silently discard payload',
    persisted.replace(/[ \r\n]/g, '').length === payload.length,
    `${persisted.replace(/[ \r\n]/g, '').length} / ${payload.length}`);
}

async function testHubProgressBounds() {
  setGroup('Hub deploy progress respects read, chunk and line budgets');

  const progress = await import(srcUrl('core/hub/deployProgress.js'));
  const store = await import(srcUrl('core/deploy/store.js'));
  const apps = await import(srcUrl('core/deploy/apps.js'));

  const created = apps.createApp({
    id: 'hub-progress-bound',
    repoUrl: 'https://github.com/example/hub-progress.git',
    branch: 'main',
    authType: 'none',
  });
  if (!created.ok) throw new Error(created.errors.join(', '));

  const runId = '20261124-170001-bcdef0';
  const log = store.logFile(created.app.id, runId, TEST_DATA_DIR);
  store.ensureAppDirs(created.app.id, TEST_DATA_DIR);
  fs.writeFileSync(
    log,
    `${'A'.repeat(512 * 1024)}\nHUB-KEEP-1\nHUB-KEEP-2\nNEWEST-HUB-LINE\n`,
    'utf8',
  );
  const run = {
    id: runId,
    appId: created.app.id,
    status: 'running',
    step: 'build',
    stage: 'build',
    skippedStages: [],
    logSecurity: 'redacted-v1',
  };
  const lock = store.acquireLock(created.app.id, { runId, dataDir: TEST_DATA_DIR });
  if (!lock.ok) throw new Error(lock.reason);

  const stats = { reads: 0, bytesRead: 0, maxReadRequest: 0 };
  const originalReadSync = fs.readSync;
  fs.readSync = (fd, buffer, offset, length, position) => {
    stats.reads += 1;
    stats.maxReadRequest = Math.max(stats.maxReadRequest, length);
    const read = originalReadSync(fd, buffer, offset, length, position);
    stats.bytesRead += read;
    return read;
  };

  const events = [];
  const observer = progress.createDeployProgress({
    dataDir: TEST_DATA_DIR,
    emit: (event, payload) => events.push({ event, payload }),
    onAppsChanged: () => {},
    detectMs: 50,
    pollMs: 50,
    emitMs: 0,
    deps: {
      listApps: () => [created.app],
      lockHolder: () => ({ runId }),
      listRuns: () => [run],
      readRun: () => run,
      logFile: () => log,
      getPermissions: () => ({ 'deploy.logs': true }),
    },
  });

  try {
    observer.start();
    const event = await waitFor(() => events.find((entry) => entry.payload.runId === runId));
    check('Hub progress emits the active run', event?.event === 'deploy:progress');
    check('one Hub progress poll reads no more than 128 KiB',
      stats.bytesRead <= progress.MAX_PROGRESS_READ_BYTES,
      `${stats.bytesRead} <= ${progress.MAX_PROGRESS_READ_BYTES}`);
    check('Hub progress uses fixed-size chunks',
      stats.maxReadRequest <= progress.MAX_PROGRESS_CHUNK_BYTES,
      `${stats.maxReadRequest} <= ${progress.MAX_PROGRESS_CHUNK_BYTES}`);
    check('the partial jump boundary is discarded while recent lines survive',
      event?.payload?.lines.includes('HUB-KEEP-1')
        && event.payload.lines.includes('NEWEST-HUB-LINE')
        && !event.payload.lines.some((line) => /^A+$/.test(line)),
      JSON.stringify(event?.payload?.lines ?? []));
    check('each emitted line respects the 2,000-character payload cap',
      (event?.payload?.lines ?? []).every((line) => line.length <= progress.MAX_LINE_CHARS));
  } finally {
    observer.stop();
    fs.readSync = originalReadSync;
    lock.release();
  }
}

async function main() {
  await testShellBounds();
  await testNginxTail();
  await testWindowsServiceLogs();
  await testDeployLoggerFragmentBound();
  await testHubProgressBounds();

  const failed = results.filter((result) => !result.passed);
  process.stdout.write(`\n${'-'.repeat(64)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const result of failed) {
      process.stdout.write(`  [${result.group}] ${result.label}${result.detail ? ` (${result.detail})` : ''}\n`);
    }
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`\nSuite error: ${err.stack || err}\n`);
  process.exit(1);
});
