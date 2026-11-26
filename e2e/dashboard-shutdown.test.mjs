/**
 * e2e/dashboard-shutdown.test.mjs
 *
 * Ctrl+C on the dashboard, with a browser connected.
 *
 * Run with:  npm run test:e2e -- dashboard-shutdown
 *
 * What this exists to prevent coming back:
 *
 *   On a Windows Server, Ctrl+C printed
 *
 *     Shutdown timed out — exiting anyway.
 *
 *   and killed the process five seconds later. server.js awaited
 *   `httpServer.close()` FIRST, and Node's `server.close()` does not close an
 *   upgraded socket — which is exactly what an open dashboard tab holds. The
 *   call that disconnects those clients (`io.close()`, via stopSocket()) came
 *   afterwards, so it was never reached, and the CLI's force-exit timer was
 *   what ended the process.
 *
 *   The same await also hangs on a request whose body never arrives; that is
 *   covered here too.
 *
 * Safety: the dashboard runs as a child process with its own temporary data
 * directory, an ephemeral loopback port and passwordless auth (loopback only,
 * which is what makes "no password" possible). The real installation is never
 * opened. The child is always killed on expiry, and this suite never sends a
 * signal to anything it did not start.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
import './lib/guard.mjs';

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killProcessTree } from './lib/kill-tree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** The dashboard must be gone this long after SIGINT, or the bug is back. */
const CLEAN_EXIT_LIMIT_MS = 3000;

/** A hard cap for one scenario, so a stuck child cannot stall the suite. */
const SCENARIO_CAP_MS = 30_000;

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-shutdown-'));
let scenarioCounter = 0;

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

/**
 * Writes the child launcher used by every scenario.
 *
 * It sets passwordless auth (allowed because the dashboard is loopback-only
 * and this is a direct loopback request), starts the REAL runDashboard() — so
 * the real SIGINT handler and the real force-exit timer are under test — and
 * prints READY once those handlers are installed. Then it emits SIGINT for
 * every "stop" line the parent writes, which is what a Ctrl+C does.
 *
 * A signal cannot be delivered to a child on Windows (kill() terminates it),
 * so emitting the event the handler listens for is the only faithful way to
 * exercise that path there.
 */
function writeLauncher() {
  const scriptUrl = pathToFileURL(path.join(ROOT, 'src/dashboard/server.js')).href;
  const configUrl = pathToFileURL(path.join(ROOT, 'src/core/config.js')).href;
  const dashUrl = pathToFileURL(path.join(ROOT, 'src/cli/dash.js')).href;
  const file = path.join(tmpRoot, `launch-${++scenarioCounter}.mjs`);

  fs.writeFileSync(file, [
    `const { loadConfig, saveConfig } = await import(${JSON.stringify(configUrl)});`,
    "saveConfig({ ...loadConfig(), dashboardAuth: 'none' });",
    `await import(${JSON.stringify(scriptUrl)});`,
    `const { runDashboard } = await import(${JSON.stringify(dashUrl)});`,
    'await runDashboard();',
    "process.stdin.resume();",
    "process.stdin.setEncoding('utf8');",
    // One SIGINT per "stop", so two lines are two Ctrl+C presses.
    "process.stdin.on('data', (chunk) => {",
    "  const presses = String(chunk).split(/\\r?\\n/).filter((line) => line.trim() === 'stop').length;",
    "  for (let index = 0; index < presses; index += 1) process.emit('SIGINT');",
    '});',
    "process.stdout.write('READY\\n');",
    '',
  ].join('\n'));

  return file;
}

function startChild({ dataDir, port, script }) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, EASY_DEVOPS_DATA_DIR: dataDir, DASHBOARD_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
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
    if (/(^|\n)READY\r?\n/.test(child.output)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the dashboard exited before it was ready (code ${child.exitCode}):\n${child.output.slice(-1200)}`);
    }
    await sleep(100);
  }
  throw new Error(`the dashboard did not become ready:\n${child.output.slice(-1200)}`);
}

/** Resolves when the child exits, or reports that it outlived the cap. */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
}

/**
 * Connects a real socket.io client and waits until it is on the WebSocket
 * transport — the upgraded socket that used to make shutdown hang.
 */
async function connectSocket(port) {
  const { io } = await import('socket.io-client');
  const socket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    extraHeaders: { 'X-EZ-Request': '1' },
    reconnection: false,
    timeout: 5000,
    forceNew: true,
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('socket.io did not connect within 6 s')); }, 6000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });

  return socket;
}

/** A keep-alive HTTP connection the agent leaves idle after one request. */
async function openKeepAlive(port) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/auth', agent }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    request.on('error', reject);
  });
  return agent;
}

/**
 * A connection that sent its headers and part of its body, then stopped.
 *
 * `server.close()` waits for this one too: it is an active connection, not an
 * idle one, so only closeAllConnections() can drop it.
 */
function openStalledRequest(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(
        'POST /api/auth HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${port}\r\n`
        + 'X-EZ-Request: 1\r\n'
        + 'Content-Type: application/json\r\n'
        + 'Content-Length: 100\r\n'
        + '\r\n'
        + '{"',
      );
      resolve(socket);
    });
  });
}

/**
 * Runs one shutdown scenario in a fresh dashboard.
 *
 * @param {string} name
 * @param {(port: number) => Promise<{ describe: string, close: () => void }>} connect
 * @param {(port: number) => Promise<void>} [sendSignal]
 */
async function scenario(name, connect) {
  setGroup(name);

  const dataDir = path.join(tmpRoot, `data-${++scenarioCounter}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const script = writeLauncher();
  const child = startChild({ dataDir, port, script });
  let cleanup = () => {};

  try {
    await waitForReady(child);
    check('the dashboard started and printed its URL',
      child.output.includes(`http://localhost:${port}`), `port ${port}`);

    const connected = await connect(port);
    cleanup = connected.close;
    check(connected.describe, true);
    check('the dashboard is still running before the signal', child.exitCode === null);

    const startedAt = Date.now();
    child.stdin.write('stop\n');

    const exit = await waitForExit(child, SCENARIO_CAP_MS);
    const elapsed = Date.now() - startedAt;

    if (exit.timedOut) {
      await killProcessTree(child.pid);
      check('the process exits after SIGINT', false, `still alive after ${SCENARIO_CAP_MS} ms`);
    } else {
      check('the process exits after SIGINT', true, `code ${exit.code} in ${elapsed} ms`);
      check('and it exits cleanly, without the 5 s force exit',
        exit.code === 0 && !child.output.includes('Shutdown timed out'),
        `code ${exit.code}`);
      check(`it closes within ${CLEAN_EXIT_LIMIT_MS} ms`,
        elapsed < CLEAN_EXIT_LIMIT_MS, `${elapsed} ms`);
      check('the graceful path ran to the end and said so',
        child.output.includes('Dashboard stopped.'));
      check('no teardown step had to be abandoned',
        !child.output.includes('[shutdown]'),
        (child.output.match(/\[shutdown\][^\n]*/g) ?? []).join(' | '));
    }
  } finally {
    cleanup();
    if (child.exitCode === null) {
      await killProcessTree(child.pid);
    }
  }
}

async function main() {
  await scenario('(1) a browser socket and an idle keep-alive connection', async (port) => {
    const socket = await connectSocket(port);
    const agent = await openKeepAlive(port);

    const transport = socket.io?.engine?.transport?.name;
    check('the socket.io client is on the WebSocket transport (an upgraded socket)',
      transport === 'websocket', String(transport));

    return {
      describe: 'a real socket.io client and a keep-alive HTTP connection are attached',
      close() {
        socket.close();
        agent.destroy();
      },
    };
  });

  await scenario('(2) a request that sent its headers and then stalled', async (port) => {
    const socket = await connectSocket(port);
    const stalled = await openStalledRequest(port);

    return {
      describe: 'an upgraded socket and a half-sent request are both open',
      close() {
        socket.close();
        stalled.destroy();
      },
    };
  });

  setGroup('(3) two Ctrl+C presses');
  {
    const dataDir = path.join(tmpRoot, `data-${++scenarioCounter}`);
    fs.mkdirSync(dataDir, { recursive: true });
    const port = await freePort();
    const script = writeLauncher();
    const child = startChild({ dataDir, port, script });

    try {
      await waitForReady(child);
      const socket = await connectSocket(port);

      const startedAt = Date.now();
      // One write, so both lines arrive in the same stdin chunk: the second
      // SIGINT is guaranteed to land while the first shutdown is in progress.
      child.stdin.write('stop\nstop\n');

      const exit = await waitForExit(child, SCENARIO_CAP_MS);
      const elapsed = Date.now() - startedAt;

      socket.close();

      if (exit.timedOut) {
        await killProcessTree(child.pid);
        check('a second Ctrl+C does not stall the shutdown', false,
          `still alive after ${SCENARIO_CAP_MS} ms`);
      } else {
        check('a second Ctrl+C does not stall the shutdown', true, `${elapsed} ms`);
        check('it is answered instead of starting a second teardown',
          (child.output.match(/Still shutting down/g) ?? []).length === 1,
          `${(child.output.match(/Still shutting down/g) ?? []).length} line(s)`);
        check('the teardown still completes exactly once',
          exit.code === 0
            && (child.output.match(/Dashboard stopped\./g) ?? []).length === 1
            && !child.output.includes('Shutdown timed out'),
          `code ${exit.code}`);
      }
    } finally {
      if (child.exitCode === null) await killProcessTree(child.pid);
    }
  }

  setGroup('(4) the force exit is only the last resort');
  {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'cli', 'dash.js'), 'utf8');
    check('the CLI still has a 5 s force exit as a safety net',
      /const FORCE_EXIT_MS = 5000;/.test(source) && source.includes('Shutdown timed out'));
    const serverSource = fs.readFileSync(path.join(ROOT, 'src', 'dashboard', 'server.js'), 'utf8');
    check('the server time-boxes its teardown steps rather than one unbounded await',
      /function timeBox\(/.test(serverSource) && /closeIdleConnections\?\.\(\)/.test(serverSource)
        && /closeAllConnections\?\.\(\)/.test(serverSource));
  }

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

function rmWithRetry(dir, attempts = 12) {
  for (let index = 0; index < attempts; index += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* retry */ }
    if (!fs.existsSync(dir)) return true;
    const until = Date.now() + 400;
    while (Date.now() < until) { /* brief spin; teardown is synchronous */ }
  }
  return !fs.existsSync(dir);
}

main().catch(async (err) => {
  process.stderr.write(`\nHarness error: ${err.stack}\n`);
  process.exit(1);
});
