/**
 * core/shell.js
 *
 * Cross-platform shell command executor for Easy DevOps.
 *
 * All modules must use this utility instead of calling child_process APIs directly.
 *
 * Exported functions:
 * - getShell() — Returns OS-resolved shell descriptor { shell, flag }
 * - run(cmd, options) — Executes a command and captures output; never throws
 * - runLive(cmd, options) — Executes a command, streaming output to the terminal; never throws
 * - runInteractive(cmd, options) — Executes a command with full stdio inheritance, for commands that prompt; never throws
 * - runWithStdin(cmd, argsArray, stdinData) — Spawns a process with stdin piping; never throws
 *
 * CommandResult shape (returned by run()):
 * { success: boolean, stdout: string, stderr: string, exitCode: number|null, command: string }
 *
 * CommandOptions (accepted by run() and runLive()):
 * { timeout?: number, cwd?: string }
 * Defaults: timeout = 30 000 ms, cwd = process.cwd()
 */

import { spawn } from 'child_process';

// ─── internal helpers ─────────────────────────────────────────────────────────

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHFJ]/g, '');
}

// ─── getShell ─────────────────────────────────────────────────────────────────

/**
 * Returns the OS-appropriate shell descriptor.
 *
 * On Windows (win32) returns PowerShell; on all other platforms returns bash.
 *
 * @returns {{ shell: string, flag: string }}
 */
export function getShell() {
  if (process.platform === 'win32') {
    return { shell: 'powershell', flag: '-Command' };
  }
  return { shell: 'bash', flag: '-c' };
}

// ─── run ──────────────────────────────────────────────────────────────────────

/**
 * Executes a shell command and captures its stdout and stderr.
 *
 * Never throws. ANSI escape codes are stripped from all captured output.
 * When the timeout expires the child process is killed and exitCode is null.
 *
 * @param {string} cmd - The command string to execute.
 * @param {{ timeout?: number, cwd?: string }} [options]
 * @param {number} [options.timeout=30000] - Milliseconds before the process is killed.
 * @param {string} [options.cwd=process.cwd()] - Working directory for the child process.
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, exitCode: number|null, command: string }>}
 */
export function run(cmd, options = {}) {
  const { timeout = 30000, cwd = process.cwd() } = options;
  const { shell, flag } = getShell();

  return new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);

    const child = spawn(shell, [flag, cmd], { cwd, signal: ac.signal, encoding: 'utf8', windowsHide: true });

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', (chunk) => { stdoutBuf += chunk; });
    child.stderr.on('data', (chunk) => { stderrBuf += chunk; });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        success: exitCode === 0,
        stdout: stripAnsi(stdoutBuf).trim(),
        stderr: stripAnsi(stderrBuf).trim(),
        exitCode,
        command: cmd,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        resolve({
          success: false,
          stdout: '',
          stderr: `Timeout after ${timeout}ms`,
          exitCode: null,
          command: cmd,
        });
      } else {
        resolve({
          success: false,
          stdout: '',
          stderr: err.message,
          exitCode: null,
          command: cmd,
        });
      }
    });
  });
}

// ─── runLive ──────────────────────────────────────────────────────────────────

/**
 * Executes a shell command, streaming stdout and stderr directly to the terminal.
 *
 * Never throws. Returns the process exit code, or null if the process was killed
 * (e.g. timeout) or an error occurred.
 *
 * @param {string} cmd - The command string to execute.
 * @param {{ timeout?: number, cwd?: string }} [options]
 * @param {number} [options.timeout=30000] - Milliseconds before the process is killed.
 * @param {string} [options.cwd=process.cwd()] - Working directory for the child process.
 * @returns {Promise<number|null>}
 */
export function runLive(cmd, options = {}) {
  const { timeout = 30000, cwd = process.cwd(), stdin = 'ignore' } = options;
  const { shell, flag } = getShell();

  return new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);

    const child = spawn(shell, [flag, cmd], {
      cwd,
      signal: ac.signal,
      stdio: [stdin, 'inherit', 'inherit'],
      windowsHide: true,
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.name !== 'AbortError') {
        process.stderr.write(err.message);
      }
      resolve(null);
    });
  });
}

// ─── runInteractive ───────────────────────────────────────────────────────────

/**
 * Executes a shell command with full stdio inheritance (stdin/stdout/stderr all
 * pass through to the terminal), for commands that must prompt the user
 * themselves — `sudo -v` on Linux, and `schtasks /RP *` on Windows, where
 * Windows collects the account password so that Easy DevOps never handles it.
 *
 * The implementation is platform-agnostic; the caller is responsible for
 * checking that a real terminal exists (`process.stdin.isTTY`), since there is
 * nothing to prompt on in a dashboard request or a PM2-managed process.
 *
 * Never throws.
 *
 * @param {string} cmd - The command string to execute.
 * @param {{ cwd?: string }} [options]
 * @param {string} [options.cwd=process.cwd()] - Working directory for the child process.
 * @returns {Promise<{ success: boolean, exitCode: number|null }>}
 */
export function runInteractive(cmd, options = {}) {
  const { cwd = process.cwd() } = options;
  const { shell, flag } = getShell();

  return new Promise((resolve) => {
    const child = spawn(shell, [flag, cmd], {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
    });

    child.on('close', (exitCode) => {
      resolve({ success: exitCode === 0, exitCode });
    });

    child.on('error', (err) => {
      resolve({ success: false, exitCode: null });
    });
  });
}

// ─── runWithStdin ─────────────────────────────────────────────────────────────

/**
 * Spawns a process directly (no shell wrapper) and pipes data to its stdin.
 * Intended for commands like `sudo -S` that read input from stdin.
 *
 * Never throws. The returned Promise always resolves with a CommandResult.
 *
 * @param {string} cmd - The executable to spawn (e.g. 'sudo').
 * @param {string[]} argsArray - Arguments passed directly to the executable.
 * @param {string} [stdinData=''] - String to pipe to the process stdin.
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, exitCode: number|null, command: string }>}
 */
export function runWithStdin(cmd, argsArray, stdinData = '') {
  return new Promise((resolve) => {
    const child = spawn(cmd, argsArray, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', (chunk) => { stdoutBuf += chunk; });
    child.stderr.on('data', (chunk) => { stderrBuf += chunk; });

    child.stdin.write(stdinData);
    child.stdin.end();

    child.on('close', (exitCode) => {
      resolve({
        success: exitCode === 0,
        stdout: stripAnsi(stdoutBuf).trim(),
        stderr: stripAnsi(stderrBuf).trim(),
        exitCode,
        command: cmd,
      });
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        stdout: '',
        stderr: err.message,
        exitCode: null,
        command: cmd,
      });
    });
  });
}
