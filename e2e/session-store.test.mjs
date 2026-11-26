/**
 * e2e/session-store.test.mjs
 *
 * The dashboard's session store, and the shared write helper it is built on.
 *
 * Run with:  npm run test:e2e -- session-store
 *
 * What this exists to prevent coming back:
 *
 *   On a Windows Server the dashboard crashed-logged
 *
 *     EPERM: operation not permitted, rename
 *     'C:\ProgramData\easy-devops\sessions\otb-....json.1705416166'
 *     -> '...\otb-....json' (errno -4048)
 *
 *   session-file-store 1.5.0 has no retry around that rename, and its `retries`
 *   option only covers reads, so a momentarily open file became a 500 with a
 *   stack trace — once per response, because every response touches the session
 *   file. The store now publishes through core/atomicState.js, which retries a
 *   sharing denial, and a write that finally fails is reported once and never
 *   turned into a request error.
 *
 * Safety: everything happens in this process's own temporary directory, under
 * the throwaway EASY_DEVOPS_DATA_DIR the runner set. The injected failure is a
 * patched `fs.renameSync` in this process, restored before the suite moves on;
 * no real file is made unwritable, and nothing outside the temp area is
 * touched.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
import './lib/guard.mjs';

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killProcessTree } from './lib/kill-tree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

/** The temporary area this suite confines itself to. */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-sessions-'));
let dirCounter = 0;

/** A fresh folder per group, so groups cannot see each other's sessions. */
function newStoreDir(label) {
  const dir = path.join(tmpRoot, `${label}-${++dirCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ─── Promisified store calls ─────────────────────────────────────────────────

const setSession = (store, id, session) => new Promise((resolve) => {
  store.set(id, session, (err, value) => resolve({ err, value }));
});
const getSession = (store, id) => new Promise((resolve) => {
  store.get(id, (err, value) => resolve({ err, value }));
});
const touchSession = (store, id, session) => new Promise((resolve) => {
  store.touch(id, session, (err, value) => resolve({ err, value }));
});

// ─── Console capture, for the one-line-per-streak rule ───────────────────────

/**
 * Collects the lines console.warn/console.log receive while `fn` runs.
 *
 * Both are patched rather than mocked away: the point is to count the real
 * lines the store's reporting writes. The originals are restored whatever
 * happens, and the patched functions never write to the console themselves, so
 * a suite run stays readable.
 */
async function captureConsole(fn) {
  const lines = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    const value = await fn();
    return { lines, value };
  } finally {
    console.warn = realWarn;
    console.log = realLog;
  }
}

/** The lines that came from atomicState's reporting, and nothing else. */
const stateLines = (lines, contains) => lines.filter(
  (line) => line.startsWith('[state]') && (contains ? line.includes(contains) : true),
);

// ─── Failure injection ───────────────────────────────────────────────────────

/**
 * Makes `fs.renameSync` fail with a Windows sharing code for renames into
 * `dir`, until `restore()` is called.
 *
 * This is the exact call core/atomicState.js makes — it imports the same `fs`
 * object this suite does — so it exercises the production retry rather than a
 * copy of it. Every other rename passes through untouched.
 *
 * @param {string} dir
 * @param {{ code?: string, times?: number }} [options] `times: Infinity` = always
 * @returns {{ restore: () => void, calls: () => number }}
 */
function injectRenameFailure(dir, { code = 'EPERM', times = Infinity } = {}) {
  const real = fs.renameSync;
  let calls = 0;

  fs.renameSync = function patchedRenameSync(from, to, ...rest) {
    if (String(to ?? '').startsWith(dir)) {
      calls += 1;
      if (calls <= times) {
        const err = new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`);
        err.code = code;
        err.errno = -4048;
        err.syscall = 'rename';
        throw err;
      }
    }
    return real.call(fs, from, to, ...rest);
  };

  return {
    restore() { fs.renameSync = real; },
    calls: () => calls,
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

function httpRequest(port, method, pathname, { cookie, headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        ...(payload === null ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        const setCookie = res.headers['set-cookie']?.[0] ?? null;
        resolve({
          status: res.statusCode,
          json,
          text,
          cookie: setCookie ? setCookie.split(';')[0] : null,
        });
      });
    });
    request.on('timeout', () => { request.destroy(); resolve({ status: null, json: null, text: '' }); });
    request.on('error', (err) => resolve({ status: null, json: null, text: '', error: err.message }));
    if (payload !== null) request.write(payload);
    request.end();
  });
}

/** The session id inside a `connect.sid=s%3A<sid>.<sig>` cookie. */
function sessionIdFromCookie(cookie) {
  const raw = String(cookie ?? '').replace(/^connect\.sid=/, '');
  const match = /^s:([^.]+)\./.exec(decodeURIComponent(raw));
  return match ? match[1] : null;
}

// ─── (1) The shared helper ───────────────────────────────────────────────────

async function sharedHelperGroup(atomic) {
  setGroup('(1) the shared retry helper atomicState exports');

  for (const name of [
    'retrySharing',
    'retrySharingAsync',
    'renameWithRetry',
    'renameWithRetryAsync',
    'copyFileWithRetry',
  ]) {
    check(`atomicState exports ${name}()`, typeof atomic[name] === 'function');
  }

  let attempts = 0;
  const value = atomic.retrySharing(() => {
    attempts += 1;
    if (attempts <= 2) {
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    }
    return 'ok';
  });
  check('retrySharing rides out two EPERM denials', value === 'ok' && attempts === 3,
    `attempts ${attempts}`);

  attempts = 0;
  let thrown = null;
  const startedAt = Date.now();
  try {
    atomic.retrySharing(() => {
      attempts += 1;
      const err = new Error('EBUSY: resource busy or locked');
      err.code = 'EBUSY';
      throw err;
    });
  } catch (err) { thrown = err; }
  const waited = Date.now() - startedAt;
  check('retrySharing gives up after five waits (six attempts)',
    thrown?.code === 'EBUSY' && attempts === 6, `attempts ${attempts}`);
  check('the whole schedule is still 5..80 ms (about 155 ms)', waited >= 140 && waited < 1200,
    `${waited} ms`);

  attempts = 0;
  thrown = null;
  try {
    atomic.retrySharing(() => {
      attempts += 1;
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    });
  } catch (err) { thrown = err; }
  check('retrySharing does not retry any other code',
    thrown?.code === 'ENOENT' && attempts === 1, `attempts ${attempts}`);

  attempts = 0;
  const asyncValue = await atomic.retrySharingAsync(async () => {
    attempts += 1;
    if (attempts <= 2) {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    }
    return 'async-ok';
  });
  check('retrySharingAsync rides out EACCES', asyncValue === 'async-ok' && attempts === 3,
    `attempts ${attempts}`);

  attempts = 0;
  thrown = null;
  try {
    await atomic.retrySharingAsync(async () => {
      attempts += 1;
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    });
  } catch (err) { thrown = err; }
  check('retrySharingAsync gives up on a persistent EPERM',
    thrown?.code === 'EPERM' && attempts === 6, `attempts ${attempts}`);

  attempts = 0;
  thrown = null;
  try {
    await atomic.retrySharingAsync(() => {
      attempts += 1;
      const err = new Error('ENOSPC: no space left');
      err.code = 'ENOSPC';
      throw err;
    });
  } catch (err) { thrown = err; }
  check('retrySharingAsync does not retry any other code',
    thrown?.code === 'ENOSPC' && attempts === 1, `attempts ${attempts}`);

  // The three file helpers, on real files.
  const renameDir = newStoreDir('helper');
  const from = path.join(renameDir, 'from.json');
  const to = path.join(renameDir, 'to.json');
  fs.writeFileSync(from, '{"a":1}');
  let injection = injectRenameFailure(renameDir, { times: 2 });
  try {
    atomic.renameWithRetry(from, to);
  } finally {
    injection.restore();
  }
  check('renameWithRetry retries the denial and moves the file',
    fs.existsSync(to) && !fs.existsSync(from) && injection.calls() === 3,
    `rename calls ${injection.calls()}`);

  const asyncFrom = path.join(renameDir, 'async-from.json');
  const asyncTo = path.join(renameDir, 'async-to.json');
  fs.writeFileSync(asyncFrom, '{"b":2}');
  await atomic.renameWithRetryAsync(asyncFrom, asyncTo);
  check('renameWithRetryAsync moves the file', fs.existsSync(asyncTo) && !fs.existsSync(asyncFrom));

  const copySource = path.join(renameDir, 'copy-source.json');
  const copyTarget = path.join(renameDir, 'copy-target.json');
  fs.writeFileSync(copySource, '{"c":3}');
  atomic.copyFileWithRetry(copySource, copyTarget, fs.constants.COPYFILE_EXCL);
  check('copyFileWithRetry copies the bytes (and honours the mode argument)',
    fs.readFileSync(copyTarget, 'utf8') === '{"c":3}');

  thrown = null;
  try {
    atomic.copyFileWithRetry(path.join(renameDir, 'missing.json'), path.join(renameDir, 'nope.json'));
  } catch (err) { thrown = err; }
  check('copyFileWithRetry throws ENOENT immediately', thrown?.code === 'ENOENT');
}

// ─── (2) Format compatibility ────────────────────────────────────────────────

async function compatibilityGroup(SessionFileStore) {
  setGroup('(2) sessions written before this store existed keep loading');

  const expressSession = (await import('express-session')).default;
  const require = createRequire(import.meta.url);
  const StockFileStore = require('session-file-store')(expressSession);

  const dir = newStoreDir('compat');
  const ours = new SessionFileStore({ path: dir, retries: 1, logFn() {} });
  const stock = new StockFileStore({ path: dir, retries: 1, logFn() {} });

  check('both stores use the same folder and file extension',
    ours.options.path === stock.options.path && ours.options.fileExtension === '.json',
    ours.options.path);

  const stockWrite = await setSession(stock, 'stock-one', {
    cookie: { originalMaxAge: null }, authenticated: true, note: 'written by stock',
  });
  check('stock session-file-store writes a session', !stockWrite.err);

  const loadedByOurs = await getSession(ours, 'stock-one');
  check('this store loads a stock session file unchanged',
    loadedByOurs.err === null
      && loadedByOurs.value?.authenticated === true
      && loadedByOurs.value?.note === 'written by stock'
      && typeof loadedByOurs.value?.__lastAccess === 'number',
    JSON.stringify(loadedByOurs.value));

  const ourWrite = await setSession(ours, 'ours-one', {
    cookie: { originalMaxAge: null }, authenticated: true, note: 'written by ours',
  });
  check('this store writes a session', !ourWrite.err);

  const loadedByStock = await getSession(stock, 'ours-one');
  check('stock session-file-store loads this store\'s file unchanged',
    loadedByStock.err === null
      && loadedByStock.value?.authenticated === true
      && loadedByStock.value?.note === 'written by ours',
    JSON.stringify(loadedByStock.value));

  const raw = readJson(path.join(dir, 'ours-one.json'));
  check('the document is still JSON with __lastAccess at the top level',
    raw.authenticated === true && typeof raw.__lastAccess === 'number' && 'cookie' in raw,
    Object.keys(raw).join(','));

  check('the folder holds only <sid>.json files, no leftover temp files',
    fs.readdirSync(dir).every((name) => /^[\w-]+\.json$/.test(name)),
    fs.readdirSync(dir).join(','));

  fs.writeFileSync(path.join(dir, 'old-one.json'), JSON.stringify({
    cookie: { originalMaxAge: null }, authenticated: true, __lastAccess: Date.now() - 3_700_000,
  }));
  const expired = await getSession(ours, 'old-one');
  check('the inherited expiry still refuses an old session with no error',
    expired.err === null && expired.value === null,
    `err ${expired.err?.code ?? 'none'}`);
}

// ─── (3) Touch skipping and expiry ───────────────────────────────────────────

async function touchGroup(SessionFileStore) {
  setGroup('(3) a touch that skips the rewrite cannot expire a live session');

  const dir = newStoreDir('touch');
  // A one-second ttl: the skip window is a tenth of it (100 ms), which is what
  // keeps a continuously used session alive.
  const store = new SessionFileStore({ path: dir, retries: 1, logFn() {}, ttl: 1 });
  const file = path.join(dir, 'sess.json');

  await setSession(store, 'sess', { cookie: { originalMaxAge: null }, authenticated: true });
  const firstAccess = readJson(file).__lastAccess;

  await sleep(30);
  const skipped = await touchSession(store, 'sess', {
    cookie: { originalMaxAge: null }, authenticated: true,
  });
  check('a touch on a young file leaves the file alone',
    skipped.err === null && readJson(file).__lastAccess === firstAccess,
    `__lastAccess ${readJson(file).__lastAccess} vs ${firstAccess}`);

  const alwaysWriteDir = newStoreDir('touch-always');
  const alwaysWrite = new SessionFileStore({
    path: alwaysWriteDir, retries: 1, logFn() {}, ttl: 1, touchMinIntervalMs: 0,
  });
  const alwaysFile = path.join(alwaysWriteDir, 'sess.json');
  await setSession(alwaysWrite, 'sess', { cookie: { originalMaxAge: null }, authenticated: true });
  const beforeNoSkip = readJson(alwaysFile).__lastAccess;
  await sleep(15);
  await touchSession(alwaysWrite, 'sess', { cookie: { originalMaxAge: null }, authenticated: true });
  check('touchMinIntervalMs: 0 writes on every touch',
    readJson(alwaysFile).__lastAccess > beforeNoSkip);

  // Used continuously for 900 ms under a 1 s ttl: must still be there.
  let rewrites = 0;
  let lastAccess = readJson(file).__lastAccess;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 900) {
    await touchSession(store, 'sess', { cookie: { originalMaxAge: null }, authenticated: true });
    const current = readJson(file).__lastAccess;
    if (current !== lastAccess) {
      rewrites += 1;
      lastAccess = current;
    }
    await sleep(40);
  }

  const alive = await getSession(store, 'sess');
  check('a session in use for 900 ms is not expired by the skipped writes',
    alive.err === null && alive.value?.authenticated === true,
    `err ${alive.err?.code ?? 'none'} value ${alive.value === null ? 'null' : 'present'}`);
  check('and the file was refreshed rather than left to age', rewrites >= 2,
    `${rewrites} rewrite(s)`);

  await sleep(1150);
  const gone = await getSession(store, 'sess');
  check('once left alone past the ttl it expires, exactly as before',
    gone.err === null && gone.value === null);
}

// ─── (4) Injected rename failure ─────────────────────────────────────────────

async function injectedFailureGroup(SessionFileStore) {
  setGroup('(4) a failing session write never throws, spams or loses the session');

  const dir = newStoreDir('inject');
  const store = new SessionFileStore({ path: dir, retries: 1, logFn() {} });
  const file = path.join(dir, 'keep.json');
  const session = (note) => ({ cookie: { originalMaxAge: null }, authenticated: true, note });

  const baseline = await setSession(store, 'keep', session('before'));
  check('the baseline write succeeds',
    baseline.err === null && readJson(file).note === 'before');

  // N < 5: one write meets three denials and still lands inside the retry.
  let injection = injectRenameFailure(dir, { times: 3 });
  let captured;
  try {
    captured = await captureConsole(() => setSession(store, 'keep', session('after-retry')));
  } finally {
    injection.restore();
  }
  check('a write that meets three denials still lands (N < 5)',
    captured.value.err === null
      && readJson(file).note === 'after-retry'
      && injection.calls() === 4,
    `rename calls ${injection.calls()}`);
  check('a ridden-out denial is not reported as a failure',
    stateLines(captured.lines).length === 0, `${stateLines(captured.lines).length} line(s)`);

  // N >= 5: every write fails. Twenty failed writes are ONE streak, one line.
  const beforeStreak = fs.readFileSync(file, 'utf8');
  injection = injectRenameFailure(dir);
  let streak;
  try {
    streak = await captureConsole(async () => {
      const outcomes = [];
      for (let index = 0; index < 20; index += 1) {
        outcomes.push(await setSession(store, 'keep', session(`during-${index}`)));
      }
      return outcomes;
    });
  } finally {
    injection.restore();
  }

  const noErrors = streak.value.every((outcome) => outcome.err === null);
  check('twenty failed writes throw nothing and report no error to the caller', noErrors);
  check('each callback still hands the session back (it stays usable in memory)',
    streak.value.every((outcome) => outcome.value?.authenticated === true));
  check('a streak of 20 failures is one log line, not twenty',
    stateLines(streak.lines, 'could not write').length === 1,
    `${stateLines(streak.lines, 'could not write').length} line(s)`);
  check('the file from before the streak is untouched and still readable',
    fs.readFileSync(file, 'utf8') === beforeStreak && readJson(file).note === 'after-retry');

  const survived = await getSession(store, 'keep');
  check('the session still loads from that file',
    survived.err === null && survived.value?.note === 'after-retry');

  // The first success afterwards says so, once.
  const recovery = await captureConsole(() => setSession(store, 'keep', session('recovered')));
  check('the next success writes the file again', readJson(file).note === 'recovered');
  check('and recovery is reported exactly once',
    stateLines(recovery.lines, 'writable again').length === 1,
    `${stateLines(recovery.lines, 'writable again').length} line(s)`);

  // A failed write must make the NEXT touch write, however young the file is.
  injection = injectRenameFailure(dir);
  let failedWrite;
  try {
    failedWrite = await captureConsole(() => setSession(store, 'keep', session('lost')));
  } finally {
    injection.restore();
  }
  const accessBeforeTouch = readJson(file).__lastAccess;
  await sleep(15);
  // Captured too: the successful retry is the moment recovery is reported.
  const retriedCapture = await captureConsole(() => touchSession(store, 'keep', {
    cookie: { originalMaxAge: null }, authenticated: true,
  }));
  const retried = retriedCapture.value;
  check('the next touch retries the write instead of skipping a young file',
    retried.err === null && readJson(file).__lastAccess > accessBeforeTouch,
    `__lastAccess ${readJson(file).__lastAccess} vs ${accessBeforeTouch}`);
  check('the failed write itself was reported once',
    stateLines(failedWrite.lines, 'could not write').length === 1);
}

// ─── (5) Through real express-session ────────────────────────────────────────

async function expressSessionGroup(SessionFileStore) {
  setGroup('(5) through real express-session, a failed save is never a 500');

  const express = (await import('express')).default;
  const expressSession = (await import('express-session')).default;

  const dir = newStoreDir('express');
  const store = new SessionFileStore({ path: dir, retries: 1, logFn() {} });

  const app = express();
  app.use(express.json());
  app.use(expressSession({
    secret: 'e2e-session-store-not-a-real-secret',
    resave: false,
    saveUninitialized: false,
    store,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }));
  app.get('/login', (req, res) => {
    req.session.authenticated = true;
    res.json({ ok: true });
  });
  app.get('/status', (req, res) => {
    res.json({ authenticated: req.session.authenticated === true });
  });
  app.get('/mutate', (req, res) => {
    req.session.counter = (req.session.counter ?? 0) + 1;
    res.json({ ok: true, counter: req.session.counter });
  });
  // A distinct body, so a 500 from Express's own handler shows up as an error
  // message rather than a successful-looking payload.
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: 'handler', message: err.message });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const login = await httpRequest(port, 'GET', '/login');
    check('login saves a session and sets the cookie',
      login.status === 200 && Boolean(login.cookie), `status ${login.status}`);

    const sid = sessionIdFromCookie(login.cookie);
    check('the live session file is <sid>.json in the store folder',
      Boolean(sid) && fs.existsSync(path.join(dir, `${sid}.json`)),
      String(sid));

    if (sid) {
      const raw = readJson(path.join(dir, `${sid}.json`));
      check('the file the middleware produced has the stock shape',
        raw.authenticated === true && typeof raw.__lastAccess === 'number',
        Object.keys(raw).join(','));
    }

    const status = await httpRequest(port, 'GET', '/status', { cookie: login.cookie });
    check('a second request loads the session from disk',
      status.status === 200 && status.json?.authenticated === true, `status ${status.status}`);

    // A save that cannot reach the disk: the request must still be answered.
    let injection = injectRenameFailure(dir);
    let captured;
    try {
      captured = await captureConsole(() => httpRequest(port, 'GET', '/mutate', { cookie: login.cookie }));
    } finally {
      injection.restore();
    }
    check('a save that cannot be written answers 200, not 500',
      captured.value.status === 200 && captured.value.json?.ok === true,
      `status ${captured.value.status} ${captured.value.text.slice(0, 80)}`);
    check('and it is logged once for that streak',
      stateLines(captured.lines, 'could not write').length === 1,
      `${stateLines(captured.lines, 'could not write').length} line(s)`);

    const afterFailureCapture = await captureConsole(
      () => httpRequest(port, 'GET', '/status', { cookie: login.cookie }),
    );
    const afterFailure = afterFailureCapture.value;
    check('the session is still valid on the next request',
      afterFailure.status === 200 && afterFailure.json?.authenticated === true,
      `status ${afterFailure.status}`);

    // A touch that cannot reach the disk: same promise.
    injection = injectRenameFailure(dir);
    let touchCaptured;
    try {
      touchCaptured = await captureConsole(() => httpRequest(port, 'GET', '/status', { cookie: login.cookie }));
    } finally {
      injection.restore();
    }
    check('a touch that cannot be written answers 200 too',
      touchCaptured.value.status === 200 && touchCaptured.value.json?.authenticated === true,
      `status ${touchCaptured.value.status}`);

    // And once the disk accepts writes again, the same session still works.
    const recoveredCapture = await captureConsole(
      () => httpRequest(port, 'GET', '/mutate', { cookie: login.cookie }),
    );
    const recovered = recoveredCapture.value;
    check('the next request writes normally again',
      recovered.status === 200 && recovered.json?.ok === true, `status ${recovered.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ─── (6) Through the real dashboard app ──────────────────────────────────────

/** Starts the dashboard in a child, with a throwaway password set up first. */
function startDashboard({ dataDir, port, script }) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, EASY_DEVOPS_DATA_DIR: dataDir, DASHBOARD_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  return child;
}

async function waitForReady(child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /READY (\d+)/.exec(child.output);
    if (match) return Number(match[1]);
    if (child.exitCode !== null) {
      throw new Error(`the dashboard exited before it was ready (code ${child.exitCode}):\n${child.output.slice(-800)}`);
    }
    await sleep(100);
  }
  throw new Error(`the dashboard did not become ready:\n${child.output.slice(-800)}`);
}

async function dashboardAppGroup() {
  setGroup('(6) through the real dashboard app, sessions are stock-readable files');

  const dataDir = path.join(tmpRoot, 'dashboard-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();

  // The launcher sets up a password, then starts the real server. It lives in
  // the temp folder, not in the repository.
  const script = path.join(tmpRoot, 'launch-dashboard.mjs');
  // Built with pathToFileURL so Windows drive letters survive unchanged.
  const configUrl = pathToFileURL(path.join(ROOT, 'src/core/config.js')).href;
  const passwordsUrl = pathToFileURL(path.join(ROOT, 'src/core/passwords.js')).href;
  const serverUrl = pathToFileURL(path.join(ROOT, 'src/dashboard/server.js')).href;
  const password = 'e2e-session-store-password';
  fs.writeFileSync(script, [
    `const { loadConfig, saveConfig } = await import(${JSON.stringify(configUrl)});`,
    `const { hashPassword } = await import(${JSON.stringify(passwordsUrl)});`,
    `saveConfig({ ...loadConfig(), dashboardAuth: 'password', dashboardPassword: '', dashboardPasswordHash: await hashPassword(${JSON.stringify(password)}) });`,
    `const { whenListening } = await import(${JSON.stringify(serverUrl)});`,
    'const bound = await whenListening;',
    "process.stdout.write('READY ' + bound + '\\n');",
    '',
  ].join('\n'));

  const child = startDashboard({ dataDir, port, script });
  try {
    const bound = await waitForReady(child);
    const base = bound;
    const header = { 'X-EZ-Request': '1' };

    const login = await httpRequest(base, 'POST', '/api/login', {
      headers: header,
      body: { password },
    });
    check('the dashboard accepts a login and creates a session',
      login.status === 200 && login.json?.ok === true && Boolean(login.cookie),
      `status ${login.status} ${login.text.slice(0, 80)}`);

    const sid = sessionIdFromCookie(login.cookie);
    const sessionsDir = path.join(dataDir, 'sessions');
    const files = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
    check('it writes the session as <sid>.json in <data>/sessions',
      Boolean(sid) && files.includes(`${sid}.json`), files.join(','));

    if (sid && files.includes(`${sid}.json`)) {
      const raw = readJson(path.join(sessionsDir, `${sid}.json`));
      check('the file has the stock format and an __lastAccess stamp',
        raw.authenticated === true && typeof raw.__lastAccess === 'number',
        Object.keys(raw).join(','));
    }

    const authenticated = await httpRequest(base, 'GET', '/api/auth', {
      cookie: login.cookie,
      headers: header,
    });
    check('an authenticated request loads the same session from disk',
      authenticated.status === 200 && authenticated.json?.authenticated === true,
      `status ${authenticated.status}`);

    // Loaded by the stock store, in this process: proof that an upgrade can
    // still read what this version writes.
    if (sid) {
      const expressSession = (await import('express-session')).default;
      const require = createRequire(import.meta.url);
      const StockFileStore = require('session-file-store')(expressSession);
      const stock = new StockFileStore({ path: sessionsDir, retries: 1, logFn() {} });
      const loaded = await getSession(stock, sid);
      check('stock session-file-store reads the dashboard\'s own session file',
        loaded.err === null && loaded.value?.authenticated === true,
        `err ${loaded.err?.code ?? 'none'}`);
    }
  } finally {
    await killProcessTree(child.pid);
  }
}

// ─── Harness ────────────────────────────────────────────────────────────────

function rmWithRetry(dir, attempts = 12) {
  for (let index = 0; index < attempts; index += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* retry */ }
    if (!fs.existsSync(dir)) return true;
    const until = Date.now() + 400;
    while (Date.now() < until) { /* brief spin; teardown is synchronous */ }
  }
  return !fs.existsSync(dir);
}

async function main() {
  const atomic = await import(srcUrl('core/atomicState.js'));
  const { SessionFileStore } = await import(srcUrl('dashboard/lib/sessionStore.js'));

  await sharedHelperGroup(atomic);
  await compatibilityGroup(SessionFileStore);
  await touchGroup(SessionFileStore);
  await injectedFailureGroup(SessionFileStore);
  await expressSessionGroup(SessionFileStore);
  await dashboardAppGroup();

  setGroup('teardown');
  check('the temporary directory is removed', rmWithRetry(tmpRoot), tmpRoot);

  const failed = results.filter((result) => !result.passed);
  process.stdout.write(`\n${'─'.repeat(64)}\nTOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failed) {
      process.stdout.write(`  [${failure.group}] ${failure.label} ${failure.detail}\n`);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`\nHarness error: ${err.stack}\n`);
  process.exit(1);
});
