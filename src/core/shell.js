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
 * - runCommandLine(cmd, options) — Runs a command line a USER wrote, in the platform's default shell; never throws
 *
 * CommandResult shape (returned by run()):
 * { success: boolean, stdout: string, stderr: string, exitCode: number|null, command: string }
 *
 * CommandOptions (accepted by run() and runLive()):
 * { timeout?: number, cwd?: string }
 * Defaults: timeout = 30 000 ms, cwd = process.cwd()
 *
 * run() additionally accepts `env` (merged over process.env) and `onData`
 * (called with each chunk of output as it arrives).
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

/** Execute a native executable with literal arguments and no command interpreter. */
export function runFile(file, args, options = {}) {
  const { timeout = 30000, cwd = process.cwd(), env = null, onData = null } = options;
  return capture((spawnOptions) => spawn(file, args, { ...spawnOptions, shell: false }), {
    cmd: file, timeout, cwd, env, onData,
  });
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
 * @param {Object} [options.env] - Extra environment variables, merged over process.env.
 * @param {(chunk: string, stream: 'stdout'|'stderr') => void} [options.onData] - Receives output as it arrives.
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, exitCode: number|null, command: string }>}
 */
export function run(cmd, options = {}) {
  const { timeout = 30000, cwd = process.cwd(), env = null, onData = null } = options;
  const { shell, flag } = getShell();

  return capture((spawnOptions) => spawn(shell, [flag, cmd], spawnOptions), { cmd, timeout, cwd, env, onData });
}

/**
 * Shared body of run() and runCommandLine(): spawn, collect output, enforce
 * the timeout, and always resolve with a CommandResult.
 *
 * @param {(spawnOptions: Object) => import('child_process').ChildProcess} spawnChild
 * @param {{ cmd: string, timeout: number, cwd: string, env: Object|null, onData: Function|null }} opts
 */
function capture(spawnChild, { cmd, timeout, cwd, env, onData }) {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);

    const child = spawnChild({
      cwd,
      signal: ac.signal,
      encoding: 'utf8',
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    // A listener that throws must not lose the command's result.
    const tell = (chunk, stream) => {
      if (!onData) return;
      try { onData(stripAnsi(String(chunk)), stream); } catch { /* ignore */ }
    };

    child.stdout.on('data', (chunk) => { stdoutBuf += chunk; tell(chunk, 'stdout'); });
    child.stderr.on('data', (chunk) => { stderrBuf += chunk; tell(chunk, 'stderr'); });

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

// ─── runCommandLine ───────────────────────────────────────────────────────────

/**
 * Runs a command line that a USER wrote — an `install`, `build` or hook command
 * from a project's ez.json — in the platform's default shell.
 *
 * This is not run(): run() uses PowerShell on Windows, where `a && b` is a
 * syntax error before PowerShell 7, and almost every build command anyone
 * writes contains `&&`. `shell: true` gives `/bin/sh -c` on Linux and
 * `cmd.exe /d /s /c` on Windows, which is the shell npm scripts themselves run
 * in — so a command that works in `package.json` works here unchanged.
 *
 * Never throws. Same CommandResult as run(). On a timeout the shell is killed;
 * a grandchild it started may outlive it, which is why the default is long
 * rather than tight.
 *
 * @param {string} cmd - The command line, exactly as written.
 * @param {Object} [options]
 * @param {number} [options.timeout=900000] - Milliseconds before the shell is killed (15 minutes).
 * @param {string} [options.cwd=process.cwd()]
 * @param {Object} [options.env] - Extra environment variables, merged over process.env.
 * @param {(chunk: string, stream: 'stdout'|'stderr') => void} [options.onData]
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, exitCode: number|null, command: string }>}
 */
export function runCommandLine(cmd, options = {}) {
  const { timeout = 900000, cwd = process.cwd(), env = null, onData = null } = options;
  return capture((spawnOptions) => spawn(cmd, [], { ...spawnOptions, shell: true }), { cmd, timeout, cwd, env, onData });
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
  const { shell, flag } = getShell();
  return runInteractiveFile(shell, [flag, cmd], options);
}

export function runInteractiveFile(file, args, { cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
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
