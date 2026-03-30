import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { openSync, closeSync, writeSync } from 'fs';
import fs from 'fs/promises';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { loadConfig } from '../../core/config.js';
import { dbGet, dbSet } from '../../core/db.js';
import { run } from '../../core/shell.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const isWindows  = process.platform === 'win32';
const LOG_PATH   = path.resolve(__dirname, '../../data/dashboard.log');
const SERVER_PATH = path.resolve(__dirname, '../../dashboard/server.js');

// ─── Port helpers ─────────────────────────────────────────────────────────────

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(startPort) {
  let port = startPort;
  while (!(await isPortFree(port))) {
    port++;
    if (port > 65535) throw new Error('No free port found');
  }
  return port;
}

// ─── HTTP ping — most reliable way to know Express is actually up ─────────────

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

// Poll every 500 ms for up to `maxWaitMs`
async function waitForServer(port, maxWaitMs = 8000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await httpPing(port, 1000)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ─── PID check ────────────────────────────────────────────────────────────────

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ─── Status ───────────────────────────────────────────────────────────────────

export async function getDashboardStatus() {
  const { dashboardPort } = loadConfig();
  const storedPid  = dbGet('dashboard-pid');
  const storedPort = dbGet('dashboard-port') ?? dashboardPort;
  const pidAlive   = isPidAlive(storedPid);
  const responding = pidAlive && await httpPing(storedPort, 1000);

  if (storedPid && !pidAlive) {
    dbSet('dashboard-pid',  null);
    dbSet('dashboard-port', null);
  }

  return {
    running:    responding,
    port:       storedPort,
    configPort: dashboardPort,
    pid:        responding ? storedPid : null,
  };
}

// ─── Start ────────────────────────────────────────────────────────────────────

export async function startDashboard(port) {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });

  // openSync gives a real fd immediately — required by spawn's stdio option
  const logFd = openSync(LOG_PATH, 'a');
  writeSync(logFd, `\n--- dashboard start ${new Date().toISOString()} port=${port} ---\n`);

  const child = spawn(process.execPath, [SERVER_PATH], {
    detached:    true,
    stdio:       ['ignore', logFd, logFd],
    windowsHide: true,
    env:         { ...process.env, DASHBOARD_PORT: String(port) },
  });
  child.unref();
  // Parent closes its copy of the fd; the child keeps its own inherited copy
  closeSync(logFd);

  dbSet('dashboard-pid',  child.pid);
  dbSet('dashboard-port', port);

  // Wait up to 8 s for Express to respond (polls every 500 ms)
  const up = await waitForServer(port, 8000);
  return { success: up, pid: child.pid, port, logPath: LOG_PATH };
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

export async function stopDashboard(pid) {
  if (!pid) return { success: false };
  try {
    if (isWindows) {
      await run(`taskkill /PID ${pid} /F`);
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* already gone */ }
  dbSet('dashboard-pid',  null);
  dbSet('dashboard-port', null);
  return { success: true };
}

// ─── Browser ──────────────────────────────────────────────────────────────────

function openBrowser(url) {
  const cmd = isWindows ? `Start-Process "${url}"` : `xdg-open "${url}"`;
  run(cmd).catch(() => {});
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

export default async function dashboardMenu() {
  while (true) {
    const spinner = ora('Checking dashboard status...').start();
    const status = await getDashboardStatus();
    spinner.stop();

    const url = `http://localhost:${status.port}`;

    console.log(chalk.bold('\n  Dashboard'));
    console.log(chalk.gray('  ' + '─'.repeat(40)));

    if (status.running) {
      console.log(`  ${chalk.green('✅ Running')}  |  ${chalk.cyan(url)}  |  PID ${status.pid}`);
    } else {
      console.log(`  ${chalk.red('❌ Stopped')}  |  port ${status.configPort}`);
    }
    console.log();

    const choices = status.running
      ? ['Open in browser', 'Stop dashboard', new inquirer.Separator(), '← Back']
      : ['Start dashboard', new inquirer.Separator(), '← Back'];

    let choice;
    try {
      ({ choice } = await inquirer.prompt([{
        type:    'list',
        name:    'choice',
        message: 'Select an option:',
        choices,
      }]));
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      throw err;
    }

    switch (choice) {
      case 'Start dashboard': {
        const portToUse = await findFreePort(status.configPort);

        if (portToUse !== status.configPort) {
          console.log(chalk.yellow(`\n  Port ${status.configPort} is in use — using port ${portToUse} instead.`));
        }

        const sp = ora(`Starting dashboard on port ${portToUse}...`).start();
        const result = await startDashboard(portToUse);

        if (result.success) {
          sp.succeed(`Dashboard started  ->  http://localhost:${portToUse}  (PID ${result.pid})`);
        } else {
          sp.fail(`Dashboard did not start — check log: ${result.logPath}`);
        }
        break;
      }

      case 'Stop dashboard': {
        const sp = ora('Stopping dashboard...').start();
        await stopDashboard(status.pid);
        sp.succeed('Dashboard stopped');
        break;
      }

      case 'Open in browser':
        openBrowser(url);
        console.log(chalk.gray(`\n  Opening ${url} ...\n`));
        break;

      case '← Back':
        return;
    }

    if (choice !== '← Back') {
      try {
        await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        throw err;
      }
    }
  }
}
