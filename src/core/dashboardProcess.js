/**
 * core/dashboardProcess.js
 *
 * Starting, stopping and locating the detached dashboard process.
 *
 * Lifted out of cli/menus/dashboard.js so the CLI and the update worker share
 * one implementation. The worker runs after the dashboard it is replacing has
 * been killed and must start the NEW code back up on the same port — a second
 * copy of this logic would be exactly the kind of drift that took the update
 * menu down.
 *
 * The dashboard is a plain detached `node src/dashboard/server.js`; the
 * background service runs the daemon, not this. Its pid and port live in the
 * SQLite settings table so any later process can find it.
 */

import { createServer } from 'net';
import { spawn } from 'child_process';
import { openSync, closeSync, writeSync } from 'fs';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { dbGet, dbSet } from './db.js';
import { getDataDir, isWindows, readProcessCommandLine } from './platform.js';
import { run } from './shell.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Principle IV: logs live in the user's data directory, never inside the
// package — a package-relative path is wiped by `npm update`. Follows
// EASY_DEVOPS_DATA_DIR in dev mode like the database and sessions do.
export const DASHBOARD_LOG_PATH = path.join(getDataDir(), 'logs', 'dashboard.log');
/**
 * The entry script of the dashboard, exactly as startDashboard() spawns it.
 *
 * Exported and used by stopDashboard(): "our" dashboard is identified by this
 * path in its command line, so an unrelated process that inherited a recorded
 * pid is never signalled.
 */
export const DASHBOARD_ENTRY_SCRIPT = path.resolve(__dirname, '..', 'dashboard', 'server.js');

// ─── Port helpers ─────────────────────────────────────────────────────────────

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

export async function findFreePort(startPort) {
  let port = startPort;
  while (!(await isPortFree(port))) {
    port++;
    if (port > 65535) throw new Error('No free port found');
  }
  return port;
}

// ─── HTTP ping — the reliable way to know Express is actually up ─────────────

function httpPing(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/`, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

/** Polls every 500 ms until Express answers or the deadline passes. */
export async function waitForServer(port, maxWaitMs = 8000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await httpPing(port, 1000)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function getDashboardStatus() {
  const { dashboardPort } = loadConfig();
  const storedPid = dbGet('dashboard-pid');
  const storedPort = dbGet('dashboard-port') ?? dashboardPort;
  const pidAlive = isPidAlive(storedPid);
  const responding = pidAlive && await httpPing(storedPort, 1000);

  if (storedPid && !responding) {
    dbSet('dashboard-pid', null);
    dbSet('dashboard-port', null);
  }

  return {
    running: responding,
    port: storedPort,
    configPort: dashboardPort,
    pid: responding ? storedPid : null,
  };
}

// ─── Start / stop ─────────────────────────────────────────────────────────────

/**
 * Starts the dashboard detached, logging to <dataDir>/logs/dashboard.log.
 *
 * `env` is merged over the current process's environment; the update worker
 * passes EASY_DEVOPS_DATA_DIR so the new dashboard runs on the same data as
 * the one it replaces.
 *
 * @param {number} port
 * @param {Object} [opts]
 * @param {Object} [opts.env]
 * @returns {Promise<{ success: boolean, pid: number, port: number, logPath: string }>}
 */
export async function startDashboard(port, { env = {} } = {}) {
  await fs.mkdir(path.dirname(DASHBOARD_LOG_PATH), { recursive: true });

  // openSync gives a real fd immediately — required by spawn's stdio option
  const logFd = openSync(DASHBOARD_LOG_PATH, 'a');
  writeSync(logFd, `\n--- dashboard start ${new Date().toISOString()} port=${port} ---\n`);

  const child = spawn(process.execPath, [DASHBOARD_ENTRY_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: { ...process.env, ...env, DASHBOARD_PORT: String(port) },
  });
  child.unref();
  // Parent closes its copy of the fd; the child keeps its own inherited copy
  closeSync(logFd);

  dbSet('dashboard-pid', child.pid);
  dbSet('dashboard-port', port);

  const up = await waitForServer(port, 8000);
  return { success: up, pid: child.pid, port, logPath: DASHBOARD_LOG_PATH };
}

/**
 * Splits a command line into argv, honouring double quotes.
 *
 * Enough for what the platform reports for one of our own dashboards — a
 * quoted executable path, a script path, maybe an interpreter option — without
 * pretending to be a general Windows command-line parser.
 *
 * @param {string} commandLine
 * @returns {string[]}
 */
function splitCommandLine(commandLine) {
  const args = [];
  let current = '';
  let quoted = false;
  let started = false;

  for (const ch of commandLine) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }

    if (!quoted && /\s/.test(ch)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += ch;
    started = true;
  }

  if (started) args.push(current);
  return args;
}

/** A path in comparable form: forward slashes, and case-folded on Windows. */
function normalizePath(value) {
  const forward = String(value).replace(/\\/g, '/');
  return isWindows ? forward.toLowerCase() : forward;
}

/**
 * True when a process command line IS `node <dashboard entry script>`.
 *
 * Parsed, not substring-matched: a pid can be reused by an editor with
 * server.js open, a grep, or a test runner that merely mentions the path, and
 * killing one of those would be killing a stranger's process. The executable
 * must be node, and the first non-option argument after it must be exactly the
 * entry script — `node other.js <script>` is not our dashboard either.
 *
 * Exported so the stop path can be tested against those shapes directly.
 *
 * @param {string|null} commandLine
 * @returns {boolean}
 */
export function isDashboardCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || commandLine.trim() === '') return false;

  const argv = splitCommandLine(commandLine);
  if (argv.length < 2) return false;

  const exe = path.basename(argv[0]).toLowerCase();
  if (exe !== 'node' && exe !== 'node.exe') return false;

  const entry = normalizePath(DASHBOARD_ENTRY_SCRIPT);

  for (const arg of argv.slice(1)) {
    // Interpreter options come before the script; the script is the first
    // argument that is not one.
    if (arg.startsWith('-')) continue;
    return normalizePath(arg) === entry;
  }

  return false;
}

/**
 * Stops the dashboard recorded at `pid`, but only if that pid still belongs to
 * it.
 *
 * A pid read back from the settings table is not proof of anything: the
 * dashboard may have exited and the OS handed the same number to an unrelated
 * process. Killing that would be killing a stranger's work, so the recorded
 * value is verified against the process's command line first. Anything we
 * cannot verify — no pid, a pid that is gone, a command line we may not read,
 * a line that is not `node <entry script>` — is NOT killed; the stale record
 * is cleared and the caller is told why.
 *
 * @param {number} pid
 * @param {Object} [deps]
 * @param {(pid: number) => Promise<string|null>} [deps.readCommandLine]
 *        Injectable for tests; defaults to platform.readProcessCommandLine()
 * @returns {Promise<{ success: boolean, reason?: string }>}
 */
export async function stopDashboard(pid, deps = {}) {
  const readCommandLine = deps.readCommandLine ?? readProcessCommandLine;

  if (!Number.isInteger(pid) || pid <= 0) {
    return { success: false, reason: 'no valid dashboard pid was recorded' };
  }

  let commandLine = null;
  try {
    commandLine = await readCommandLine(pid);
  } catch {
    commandLine = null;
  }

  if (!isDashboardCommandLine(commandLine)) {
    // Clear the record either way: whatever was stored is not a dashboard we
    // may stop, so keeping it would make every later action repeat this check.
    dbSet('dashboard-pid', null);
    dbSet('dashboard-port', null);
    return {
      success: false,
      reason: `pid ${pid} no longer belongs to the Easy DevOps dashboard; the stale record was cleared`,
    };
  }

  try {
    if (isWindows) {
      await run(`taskkill /PID ${pid} /F`);
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* already gone */ }
  dbSet('dashboard-pid', null);
  dbSet('dashboard-port', null);
  return { success: true };
}
