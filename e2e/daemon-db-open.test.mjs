/**
 * e2e/daemon-db-open.test.mjs
 *
 * Finding B1 from the 1.4.6 upgrade: on a Linux root install the daemon could
 * not open its database, with and without the runtime loader, and the message
 * was one generic line about write access. Two things are tested here:
 *
 *   1. the real daemon entry opens the real database through the real
 *      better-sqlite3 - with the runtime loader (the systemd ExecStart shape)
 *      and without it - so neither the loader nor the boundary can be the
 *      reason a normal install fails;
 *   2. every startup failure says WHAT failed and WHAT TO DO: the underlying
 *      code and message, the step, and advice that fits that cause. The old
 *      generic write-access hint is never the whole answer.
 *
 * Failures are injected into a child process (a patched module loader, a
 * patched driver) or into a throwaway file. No real file is broken, no real
 * data directory is read, and the database is never deleted or recreated.
 */
import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO, 'src', 'cli', 'index.js');
const DB_ENTRY = pathToFileURL(path.join(REPO, 'src', 'core', 'db.js')).href;
const LOADER = pathToFileURL(path.join(REPO, 'src', 'core', 'service', 'runtime-loader.mjs')).href;
const DB_FILE = 'easy-devops.sqlite';

const require = createRequire(import.meta.url);

let passed = 0;
const failures = [];

function check(name, condition, detail = null) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${name}\n      ${String(detail).split('\n').join('\n      ')}` : name);
}

function suiteDir(name) {
  const dir = path.join(TEST_DATA_DIR, name);
  assertInsideTestDataDir(dir, 'use a test data directory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(what, predicate, { timeoutMs = 30_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function spawnNode(args, { dataDir, env = {}, cwd = REPO } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    // The same two variables the runner set, passed to every child so nothing
    // it does can resolve the real installation.
    env: { ...process.env, EZ_TEST: '1', EASY_DEVOPS_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { output.stderr += String(chunk); });
  return { child, output };
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: null });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ code: null, signal: 'timeout' });
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/**
 * Starts the real `ezz daemon` exactly as the systemd unit does, and waits for
 * its lock heartbeat. That heartbeat is the proof the database opened: the
 * daemon takes the lock only after core/db.js has loaded, and jobs/owner writes
 * its marker through the same connection.
 */
async function startDaemon({ dataDir, loader }) {
  assertInsideTestDataDir(dataDir, 'start the daemon');
  fs.mkdirSync(dataDir, { recursive: true });
  const args = [
    ...(loader ? [`--experimental-loader=${LOADER}`] : []),
    ENTRY,
    'daemon',
  ];
  const running = spawnNode(args, { dataDir });
  const { inspect, isPidAlive } = await import('../src/core/daemon/lock.js');

  try {
    const state = await waitFor('the daemon heartbeat', () => {
      if (running.child.exitCode !== null) {
        throw new Error(`the daemon exited before it started (code ${running.child.exitCode})\n${running.output.stdout}\n${running.output.stderr}`);
      }
      const lock = inspect({ dataDir });
      return lock.running && lock.lock && isPidAlive(lock.lock.pid) ? lock : null;
    });
    return { ...running, dataDir, state };
  } catch (error) {
    try { running.child.kill('SIGKILL'); } catch { /* already gone */ }
    throw error;
  }
}

/** Stops a daemon through its own stop request, the way `ezz service stop` does. */
async function stopDaemon(running) {
  fs.writeFileSync(
    path.join(running.dataDir, 'daemon.stop'),
    `${JSON.stringify({ at: new Date().toISOString(), by: process.pid, reason: 'e2e daemon-db-open' })}\n`,
  );
  return waitForExit(running.child, 30_000);
}

// ─── 1. The real daemon opens the real database ──────────────────────────────
for (const loader of [true, false]) {
  const label = loader ? 'with the runtime loader' : 'without the runtime loader';
  const dataDir = suiteDir(loader ? 'daemon-with-loader' : 'daemon-without-loader');
  let running;
  try {
    running = await startDaemon({ dataDir, loader });
    const database = path.join(dataDir, DB_FILE);
    const size = fs.existsSync(database) ? fs.statSync(database).size : 0;

    check(`${label}: the daemon reached its heartbeat`, running.state.running === true, running.state.reason);
    check(`${label}: the database file has the schema`, size > 0, `size ${size}`);
    check(
      `${label}: the daemon reported no database failure`,
      !/Failed to (?:initialize|create) (?:the )?database/.test(`${running.output.stdout}${running.output.stderr}`),
      running.output.stderr,
    );

    const stopped = await stopDaemon(running);
    check(`${label}: a stop request stopped it cleanly`, stopped.code === 0, `exit ${stopped.code} ${stopped.signal}\n${running.output.stdout}\n${running.output.stderr}`);
    check(`${label}: the daemon announced its version`, /Easy DevOps daemon v/.test(running.output.stdout), running.output.stdout);
  } catch (error) {
    check(`${label}: the daemon opened its database`, false, error.message);
    if (running) {
      try { running.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
}

// ─── 2. A load failure names the module, the code and the rebuild command ────
function writeInject(file, source) {
  fs.writeFileSync(file, source);
  return file;
}

const dlopenInject = writeInject(path.join(suiteDir('injections'), 'dlopen.cjs'), `
const Module = require('node:module');
const original = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'better-sqlite3') {
    const error = new Error('better_sqlite3.node: invalid ELF header (module built for NODE_MODULE_VERSION 108)');
    error.code = 'ERR_DLOPEN_FAILED';
    throw error;
  }
  return original.apply(this, [request, ...rest]);
};
`);

const busyInject = writeInject(path.join(suiteDir('injections'), 'busy.cjs'), `
const Module = require('node:module');
const original = Module._load;
Module._load = function (request, ...rest) {
  const exported = original.apply(this, [request, ...rest]);
  if (request !== 'better-sqlite3') return exported;
  // A real driver, opened normally; only the first schema write reports the
  // lock, which is exactly what a second connection gets from SQLite.
  return new Proxy(exported, {
    construct(target, args) {
      const instance = Reflect.construct(target, args);
      const exec = instance.exec.bind(instance);
      let tripped = false;
      instance.exec = (sql) => {
        if (!tripped && /CREATE TABLE IF NOT EXISTS/i.test(String(sql))) {
          tripped = true;
          const error = new Error('database is locked');
          error.name = 'SqliteError';
          error.code = 'SQLITE_BUSY';
          throw error;
        }
        return exec(sql);
      };
      return instance;
    },
  });
};
`);

async function runDatabaseOpen({ dataDir, inject }) {
  const args = [
    ...(inject ? ['--require', inject] : []),
    '--input-type=module',
    '-e',
    `await import(${JSON.stringify(DB_ENTRY)});`,
  ];
  const child = spawnNode(args, { dataDir });
  const exited = await waitForExit(child.child, 30_000);
  return { ...child.output, code: exited.code };
}

const oldGenericHint = /Failed to initialize database[\s\S]*Hint: Check that the current user has write access[\s\S]*$/;

{
  const dataDir = suiteDir('failure-dlopen');
  const result = await runDatabaseOpen({ dataDir, inject: dlopenInject });
  check('dlopen failure: exits non-zero', result.code === 1, `exit ${result.code}`);
  check('dlopen failure: prints the real code', /ERR_DLOPEN_FAILED/.test(result.stderr), result.stderr);
  check('dlopen failure: names the failed step', /Step\s*:\s*load better-sqlite3/.test(result.stderr), result.stderr);
  check('dlopen failure: tells the operator to rebuild', /npm rebuild better-sqlite3/.test(result.stderr), result.stderr);
  check('dlopen failure: names the package folder', result.stderr.includes(REPO), result.stderr);
  check(
    'dlopen failure: is not only the old write-access hint',
    !oldGenericHint.test(result.stderr),
    result.stderr,
  );
  check('dlopen failure: never creates the database', !fs.existsSync(path.join(dataDir, DB_FILE)));
}

{
  const dataDir = suiteDir('failure-busy');
  const result = await runDatabaseOpen({ dataDir, inject: busyInject });
  check('locked database: exits non-zero', result.code === 1, `exit ${result.code}`);
  check('locked database: prints SQLITE_BUSY', /SQLITE_BUSY/.test(result.stderr), result.stderr);
  check('locked database: says another process holds it', /Another process is holding the database/i.test(result.stderr), result.stderr);
  check(
    'locked database: says how to find the holder',
    /fuser -v |Get-Process node/.test(result.stderr),
    result.stderr,
  );
  check(
    'locked database: never advises deleting the database or its sidecars',
    !/\b(?:delete|remove)\b[^\n]*(?:database|\.sqlite)/i.test(result.stderr.replace(/Do not delete[^\n]*/gi, '')),
    result.stderr,
  );
  check('locked database: is not only the old write-access hint', !oldGenericHint.test(result.stderr), result.stderr);
}

{
  // A file that is not a database: a real SQLite error at the first read.
  const dataDir = suiteDir('failure-not-a-database');
  const database = path.join(dataDir, DB_FILE);
  fs.writeFileSync(database, Buffer.from('this is not a sqlite database'.repeat(20)));
  const before = fs.readFileSync(database);
  const result = await runDatabaseOpen({ dataDir });
  check('not a database: exits non-zero', result.code === 1, `exit ${result.code}`);
  check('not a database: prints the code', /SQLITE_NOTADB|SQLITE_CORRUPT/.test(result.stderr), result.stderr);
  check('not a database: names the first-read step', /Step\s*:\s*first read/.test(result.stderr), result.stderr);
  check('not a database: keeps the file untouched', fs.readFileSync(database).equals(before));
}

// ─── 3. The write-access hint is one case, never the whole message ───────────
{
  const { formatDatabaseStartupFailure } = await import('../src/core/db.js');
  const dataDir = suiteDir('advice-eacces');
  const eacces = Object.assign(new Error(`EACCES: permission denied, mkdir '${dataDir}'`), { code: 'EACCES' });
  const rendered = formatDatabaseStartupFailure({
    heading: `[ERROR] Failed to create database directory: ${dataDir}`,
    error: eacces,
    step: 'create the data directory',
    dataDir,
    databasePath: path.join(dataDir, DB_FILE),
  });
  check('EACCES: names the step', /Step\s*:\s*create the data directory/.test(rendered), rendered);
  check('EACCES: prints the code and message', /EACCES: permission denied/.test(rendered), rendered);
  check('EACCES: still names the write-access cause', /cannot write to/.test(rendered), rendered);
  check('EACCES: is not only the old one-line hint', rendered.split('\n').length > 6 && !oldGenericHint.test(rendered), rendered);

  const ioerror = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_WRITE' });
  const diskRendered = formatDatabaseStartupFailure({
    error: ioerror,
    step: 'first write to the database file (creating the schema table)',
    dataDir,
    databasePath: path.join(dataDir, DB_FILE),
  });
  check('I/O error: does not blame permissions', !/write access/i.test(diskRendered), diskRendered);
  check('I/O error: tells the operator to check the volume', /df -h/.test(diskRendered), diskRendered);
}

// ─── 4. `ezz daemon` start failure is diagnosed, not silent ──────────────────
{
  const dataDir = suiteDir('daemon-start-failure');
  fs.writeFileSync(path.join(dataDir, DB_FILE), Buffer.from('not a database'.repeat(40)));
  const child = spawnNode([ENTRY, 'daemon'], { dataDir });
  const exited = await waitForExit(child.child, 30_000);
  const output = `${child.output.stdout}${child.output.stderr}`;
  check('daemon start failure: exits non-zero', exited.code === 1, `exit ${exited.code}`);
  check('daemon start failure: names the step', /Step\s*:\s*first read/.test(output), output);
  check('daemon start failure: prints the SQLite code', /SQLITE_NOTADB|SQLITE_CORRUPT/.test(output), output);
  check('daemon start failure: does not claim a permission problem', !/write access/i.test(output), output);
}

// ─── 5. Preflight is read-only ───────────────────────────────────────────────
{
  const { inspectServiceStatusDatabase, formatDatabasePreflightFailure } = await import('../src/cli/serviceStatusPreflight.js');

  // (a) a real database: opened read-only, left byte-for-byte identical.
  const dataDir = suiteDir('preflight-real');
  const database = path.join(dataDir, DB_FILE);
  const Database = require('better-sqlite3');
  const seeded = new Database(database);
  seeded.exec('CREATE TABLE gooddb (key TEXT PRIMARY KEY, value TEXT)');
  seeded.prepare('INSERT INTO gooddb (key, value) VALUES (?, ?)').run('config', '{"a":1}');
  seeded.close();

  const beforeBytes = fs.readFileSync(database);
  const beforeStat = fs.statSync(database);
  const beforeListing = fs.readdirSync(dataDir).sort();

  const report = inspectServiceStatusDatabase({ dataDir });
  const rendered = formatDatabasePreflightFailure(report);

  const afterBytes = fs.readFileSync(database);
  const afterStat = fs.statSync(database);

  check('preflight: the database opens read-only', report.ok === true && report.readOnly.ok === true, rendered);
  check('preflight: reports the better-sqlite3 version and ABI', Boolean(report.package.version) && Boolean(report.package.abi), rendered);
  check('preflight: reports the sidecar list', Array.isArray(report.sidecars) && report.sidecars.length === 3, rendered);
  check('preflight: the file bytes are unchanged', beforeBytes.equals(afterBytes));
  check('preflight: the file mtime is unchanged', beforeStat.mtimeMs === afterStat.mtimeMs, `${beforeStat.mtimeMs} -> ${afterStat.mtimeMs}`);
  check('preflight: no file was created or removed', fs.readdirSync(dataDir).sort().join('|') === beforeListing.join('|'), fs.readdirSync(dataDir).join(', '));

  // (b) stale sidecars beside an empty database: named, and left alone.
  const sidecarDir = suiteDir('preflight-sidecars');
  const sidecarDb = path.join(sidecarDir, DB_FILE);
  fs.writeFileSync(sidecarDb, '');
  fs.writeFileSync(`${sidecarDb}-wal`, Buffer.alloc(64, 7));
  fs.writeFileSync(`${sidecarDb}-shm`, Buffer.alloc(32, 9));
  const sidecarBefore = ['', '-wal', '-shm'].map((suffix) => ({
    bytes: fs.readFileSync(`${sidecarDb}${suffix}`),
    mtimeMs: fs.statSync(`${sidecarDb}${suffix}`).mtimeMs,
  }));
  const sidecarReport = inspectServiceStatusDatabase({ dataDir: sidecarDir });
  const sidecarAfter = ['', '-wal', '-shm'].map((suffix) => ({
    bytes: fs.readFileSync(`${sidecarDb}${suffix}`),
    mtimeMs: fs.statSync(`${sidecarDb}${suffix}`).mtimeMs,
  }));
  const present = sidecarReport.sidecars.filter((item) => item.exists).map((item) => item.suffix);
  check('preflight: sidecars are reported', present.includes('-wal') && present.includes('-shm'), JSON.stringify(present));
  check(
    'preflight: sidecars are left untouched',
    sidecarBefore.every((item, index) => item.bytes.equals(sidecarAfter[index].bytes) && item.mtimeMs === sidecarAfter[index].mtimeMs),
  );

  // (c) a file that is not a database: the failure is reported and kept.
  const corruptDir = suiteDir('preflight-corrupt');
  const corrupt = path.join(corruptDir, DB_FILE);
  fs.writeFileSync(corrupt, Buffer.from('not a database'.repeat(50)));
  const corruptBefore = fs.readFileSync(corrupt);
  const corruptReport = inspectServiceStatusDatabase({ dataDir: corruptDir });
  const corruptRendered = formatDatabasePreflightFailure(corruptReport);
  check('preflight: a corrupt file is reported as failed', corruptReport.ok === false, corruptRendered);
  check('preflight: the corrupt file advice keeps the original', /copy it aside|Do not delete/i.test(corruptRendered), corruptRendered);
  check('preflight: the corrupt file is untouched', fs.readFileSync(corrupt).equals(corruptBefore));

  // (d) a live daemon lock is reported as a holder, from the lock alone.
  const lockDir = suiteDir('preflight-lock');
  fs.writeFileSync(path.join(lockDir, 'daemon.lock'), JSON.stringify({
    pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now(), version: 'test', mode: 'daemon',
  }));
  const lockReport = inspectServiceStatusDatabase({ dataDir: lockDir });
  check('preflight: a live daemon lock is reported', lockReport.lock.running === true && lockReport.lock.pid === process.pid, JSON.stringify(lockReport.lock));
  check(
    'preflight: the lock is not mistaken for a database failure',
    lockReport.ok === true && !/failed/i.test(formatDatabasePreflightFailure(lockReport)),
    formatDatabasePreflightFailure(lockReport),
  );

  // (e) Linux `fuser` output is rendered with what to do about it, and the
  // probe is skipped quietly where it cannot run. `fuser` itself only runs on
  // Linux, so its output is injected here and the probe call is checked for
  // "did not do anything silly" on this platform.
  const { collectDatabaseLockHolders } = await import('../src/cli/serviceStatusPreflight.js');
  const { isWindows } = await import('../src/core/platform.js');
  const injected = inspectServiceStatusDatabase({
    dataDir,
    holders: {
      fuser: {
        checked: true,
        available: true,
        output: `${database}: 1000 4321 F.... node`,
        error: null,
      },
    },
  });
  const injectedRendered = formatDatabasePreflightFailure(injected);
  check('preflight: fuser output is reported', /fuser -v: .*4321/.test(injectedRendered), injectedRendered);
  check('preflight: fuser output says what to do', /stop that process/.test(injectedRendered), injectedRendered);

  let spawned = false;
  const holders = await collectDatabaseLockHolders({
    database,
    runFileImpl: async () => { spawned = true; return { success: true, exitCode: 0, stdout: '', stderr: '' }; },
  });
  if (isWindows) {
    check('preflight: fuser is not probed on Windows', holders.checked === false && spawned === false, JSON.stringify(holders));
  } else {
    check('preflight: fuser is probed on Linux', holders.checked === true && spawned === true, JSON.stringify(holders));
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`FAIL  ${failure}\n`);
  process.stdout.write(`FAIL  ${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`PASS  daemon database opens through the loader, and every startup failure names its cause (${passed} checks)`);
