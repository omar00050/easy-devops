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
 * stdout and stderr contain at most SHELL_CAPTURE_TAIL_BYTES each. They are
 * the newest bytes, so a noisy command cannot grow the caller's memory without
 * bound. `onData`, when supplied, still receives every chunk.
 *
 * CommandOptions (accepted by run() and runLive()):
 * { timeout?: number, cwd?: string }
 * Defaults: timeout = 30 000 ms, cwd = process.cwd()
 *
 * run() additionally accepts `env` (merged over process.env) and `onData`
 * (called with each chunk of output as it arrives).
 */

import { spawn } from 'child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// ─── internal helpers ─────────────────────────────────────────────────────────

/**
 * Maximum bytes retained for each captured stream. Callers receive only the
 * newest bytes, while `onData` still sees every chunk as it arrives.
 */
export const SHELL_CAPTURE_TAIL_BYTES = 64 * 1024;

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHFJ]/g, '');
}

function asBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return Buffer.from(String(chunk), 'utf8');
}

/**
 * Drops an incomplete leading UTF-8 sequence from a bounded tail.
 *
 * The ring keeps an exact byte suffix. That suffix can begin after the first
 * byte of a multibyte character, in which case Node would turn each orphaned
 * continuation byte into U+FFFD. The character is already incomplete, so the
 * safe representation is to begin with the next complete character.
 */
function validUtf8Tail(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return start === 0 ? buffer : buffer.subarray(start);
}

/** Keeps the newest bytes in a fixed circular buffer. */
function createBoundedTail(limit = SHELL_CAPTURE_TAIL_BYTES) {
  const ring = Buffer.allocUnsafe(limit);
  let start = 0;
  let bytes = 0;

  return {
    append(chunk) {
      const incoming = asBuffer(chunk);
      if (incoming.length === 0) return;

      if (incoming.length >= limit) {
        incoming.copy(ring, 0, incoming.length - limit);
        start = 0;
        bytes = limit;
        return;
      }

      const overflow = Math.max(0, bytes + incoming.length - limit);
      if (overflow > 0) {
        start = (start + overflow) % limit;
        bytes -= overflow;
      }

      const writeAt = (start + bytes) % limit;
      const first = Math.min(incoming.length, limit - writeAt);
      incoming.copy(ring, writeAt, 0, first);
      if (first < incoming.length) incoming.copy(ring, 0, first);
      bytes += incoming.length;
    },

    toString() {
      if (bytes === 0) return '';
      if (start + bytes <= limit) {
        return validUtf8Tail(ring.subarray(start, start + bytes)).toString('utf8');
      }

      const ordered = Buffer.allocUnsafe(bytes);
      const first = limit - start;
      ring.copy(ordered, 0, start, limit);
      ring.copy(ordered, first, 0, bytes - first);
      return validUtf8Tail(ordered).toString('utf8');
    },
  };
}

function capturedText(tail) {
  return stripAnsi(tail.toString()).trim();
}

/**
 * Decode one byte stream incrementally.
 *
 * A UTF-8 character may be split across pipe chunks. Decoding each Buffer on
 * its own replaces both halves before redaction can see the secret. The
 * StringDecoder preserves the partial character until the next chunk, and
 * finish() flushes it before the captured tail is returned.
 */
function createTextCapture(limit, onText) {
  const decoder = new StringDecoder('utf8');
  const tail = createBoundedTail(limit);

  const appendText = (text) => {
    if (!text) return;
    tail.append(Buffer.from(text, 'utf8'));
    if (!onText) return;
    try { onText(text); } catch { /* a listener cannot change the command result */ }
  };

  return {
    append(chunk) {
      appendText(decoder.write(asBuffer(chunk)));
    },
    finish() {
      appendText(decoder.end());
      return capturedText(tail);
    },
  };
}

const COMMON_COMMAND_ENV = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ',
  'TMPDIR', 'TEMP', 'TMP', 'TERM',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO',
]);

const WINDOWS_COMMAND_ENV = Object.freeze([
  'Path', 'PATHEXT', 'ComSpec', 'SystemRoot', 'SystemDrive', 'WINDIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
]);

/**
 * Environment for a repository-authored install/build/hook command.
 *
 * The daemon environment can contain credentials belonging to unrelated
 * services. A project command receives only OS essentials, proxy/TLS settings
 * and the app's explicitly configured `env`. This is a replacement
 * environment, not a merge over `process.env`.
 */
export function commandEnvironment(overrides = {}, source = process.env) {
  const names = [...COMMON_COMMAND_ENV, ...(process.platform === 'win32' ? WINDOWS_COMMAND_ENV : [])];
  const wanted = new Set(names.map((name) => process.platform === 'win32' ? name.toLowerCase() : name));
  const result = {};

  for (const [name, value] of Object.entries(source ?? {})) {
    if (value === undefined) continue;
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    if (wanted.has(key) || (process.platform !== 'win32' && name.startsWith('LC_'))) {
      result[name] = String(value);
    }
  }

  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === undefined || value === null) continue;
    result[name] = String(value);
  }
  result.GIT_TERMINAL_PROMPT ??= '0';
  return result;
}

/** Credentials embedded in proxy URLs are echoed by `env`; redact them too. */
export function commandEnvironmentSecrets(env = {}) {
  const values = [];
  for (const [name, value] of Object.entries(env)) {
    if (!/(?:https?|all)_proxy$/i.test(name)) continue;
    const text = String(value ?? '');
    try {
      const url = new URL(text);
      if (url.username) values.push(url.username);
      if (url.password) values.push(url.password);
    } catch { /* a non-URL proxy value is not treated as a secret */ }
  }
  return values;
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
    return {
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      flag: '-Command',
    };
  }
  return { shell: 'bash', flag: '-c' };
}

/** Execute a native executable with literal arguments and no command interpreter. */
export function runFile(file, args, options = {}) {
  const { timeout = 30000, cwd = process.cwd(), env = null, onData = null, replaceEnv = false } = options;
  return capture((spawnOptions) => spawn(file, args, { ...spawnOptions, shell: false }), {
    cmd: file, timeout, cwd, env, onData, replaceEnv,
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
  const { timeout = 30000, cwd = process.cwd(), env = null, onData = null, replaceEnv = false } = options;
  const { shell, flag } = getShell();

  return capture(
    (spawnOptions) => spawn(shell, [flag, cmd], spawnOptions),
    { cmd, timeout, cwd, env, onData, replaceEnv },
  );
}

/**
 * Shared body of run() and runCommandLine(): spawn, collect output, enforce
 * the timeout, and always resolve with a CommandResult.
 *
 * @param {(spawnOptions: Object) => import('child_process').ChildProcess} spawnChild
 * @param {{ cmd: string, timeout: number, cwd: string, env: Object|null, onData: Function|null }} opts
 */
function capture(spawnChild, { cmd, timeout, cwd, env, onData, replaceEnv = false }) {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);

    let child;
    try {
      child = spawnChild({
        cwd,
        signal: ac.signal,
        encoding: 'utf8',
        windowsHide: true,
        ...(env ? { env: replaceEnv ? { ...env } : { ...process.env, ...env } } : {}),
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({
        success: false,
        stdout: '',
        stderr: err.message,
        exitCode: null,
        command: cmd,
      });
      return;
    }

    const stdoutCapture = createTextCapture(
      SHELL_CAPTURE_TAIL_BYTES,
      onData ? (text) => onData(stripAnsi(text), 'stdout') : null,
    );
    const stderrCapture = createTextCapture(
      SHELL_CAPTURE_TAIL_BYTES,
      onData ? (text) => onData(stripAnsi(text), 'stderr') : null,
    );

    child.stdout.on('data', (chunk) => {
      stdoutCapture.append(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrCapture.append(chunk);
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        success: exitCode === 0,
        stdout: stdoutCapture.finish(),
        stderr: stderrCapture.finish(),
        exitCode,
        command: cmd,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        resolve({
          success: false,
          stdout: stdoutCapture.finish(),
          stderr: `Timeout after ${timeout}ms`,
          exitCode: null,
          command: cmd,
        });
      } else {
        resolve({
          success: false,
          stdout: stdoutCapture.finish(),
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
  const {
    timeout = 900000,
    cwd = process.cwd(),
    env = null,
    onData = null,
    replaceEnv = false,
  } = options;
  return capture(
    (spawnOptions) => spawn(cmd, [], { ...spawnOptions, shell: true }),
    { cmd, timeout, cwd, env, onData, replaceEnv },
  );
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

    let child;
    try {
      child = spawn(shell, [flag, cmd], {
        cwd,
        signal: ac.signal,
        stdio: [stdin, 'inherit', 'inherit'],
        windowsHide: true,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name !== 'AbortError') process.stderr.write(err.message);
      resolve(null);
      return;
    }

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
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        stdio: 'inherit',
        windowsHide: true,
      });
    } catch {
      resolve({ success: false, exitCode: null });
      return;
    }

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
 * Captured stdout and stderr each contain only the newest bounded byte tail.
 *
 * @param {string} cmd - The executable to spawn (e.g. 'sudo').
 * @param {string[]} argsArray - Arguments passed directly to the executable.
 * @param {string} [stdinData=''] - String to pipe to the process stdin.
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, exitCode: number|null, command: string }>}
 */
export function runWithStdin(cmd, argsArray, stdinData = '') {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argsArray, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        success: false,
        stdout: '',
        stderr: err.message,
        exitCode: null,
        command: cmd,
      });
      return;
    }

    const stdoutCapture = createTextCapture(SHELL_CAPTURE_TAIL_BYTES);
    const stderrCapture = createTextCapture(SHELL_CAPTURE_TAIL_BYTES);

    child.stdout.on('data', (chunk) => stdoutCapture.append(chunk));
    child.stderr.on('data', (chunk) => stderrCapture.append(chunk));

    child.stdin.write(stdinData);
    child.stdin.end();

    child.on('close', (exitCode) => {
      resolve({
        success: exitCode === 0,
        stdout: stdoutCapture.finish(),
        stderr: stderrCapture.finish(),
        exitCode,
        command: cmd,
      });
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        stdout: stdoutCapture.finish(),
        stderr: err.message,
        exitCode: null,
        command: cmd,
      });
    });
  });
}
