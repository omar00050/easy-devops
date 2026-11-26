/**
 * core/shell.js
 *
 * Cross-platform shell command executor for Easy DevOps.
 *
 * All modules must use this utility instead of calling child_process APIs directly.
 *
 * Exported functions:
 * - getShell() — Returns OS-resolved shell descriptor { shell, flag }
 * - run(cmd, options) — Executes a command and captures output; command failures never throw
 * - runLive(cmd, options) — Executes a command, streaming output to the terminal; never throws
 * - runInteractive(cmd, options) — Executes a command with full stdio inheritance, for commands that prompt; never throws
 * - runWithStdin(cmd, argsArray, stdinData, options) — Spawns a process with stdin piping; command failures never throw
 * - runCommandLine(cmd, options) — Runs a command line a USER wrote, in the platform's default shell; command failures never throw
 *
 * An unknown `output` mode, an invalid `maxBytes`, or `output: 'stream'`
 * without `onData` throws a TypeError before anything is spawned.
 *
 * CommandResult shape (returned by run()):
 * { success: boolean, stdout: string, stderr: string, exitCode: number|null,
 *   command: string, truncated: { stdout: number, stderr: number }, error?: string }
 *
 * `truncated.stdout` / `truncated.stderr` are the bytes DROPPED from each
 * stream, so a caller can never mistake a cut capture for a complete one. In
 * `tail` mode that is what the ring evicted; in `full` mode it is 0 unless the
 * byte cap was hit; in `stream` mode it is always 0 because nothing is kept.
 *
 * Output modes (`options.output`), exported as SHELL_OUTPUT_MODES:
 *   'tail'   (default) — stdout and stderr each keep only the newest
 *                        SHELL_CAPTURE_TAIL_BYTES bytes. A noisy command
 *                        cannot grow the caller's memory without bound.
 *                        `onData`, when supplied, still receives every chunk.
 *   'full'   — stdout and stderr each keep everything up to `maxBytes`
 *                        (default SHELL_CAPTURE_FULL_MAX_BYTES, 8 MiB). Over
 *                        the cap the child is KILLED and the result is
 *                        { success: false, exitCode: null, error: 'output
 *                        exceeded <N> bytes' } — never a silent cut.
 *   'stream' — nothing is buffered; stdout and stderr stay ''. Every chunk
 *                        reaches `onData`, which is required (a missing
 *                        callback is a programming error and throws).
 *
 * CommandOptions (accepted by run(), runFile(), runCommandLine() and
 * runWithStdin()'s options argument):
 * { timeout?: number, cwd?: string, output?: 'tail'|'full'|'stream',
 *   maxBytes?: number, onData?: Function }
 * Defaults: timeout = 30 000 ms, cwd = process.cwd(), output = 'tail'
 *
 * run() additionally accepts `env` (merged over process.env).
 */

import { spawn } from 'child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// ─── internal helpers ─────────────────────────────────────────────────────────

/**
 * Maximum bytes retained for each captured stream in `tail` mode. Callers
 * receive only the newest bytes, while `onData` still sees every chunk as it
 * arrives. What was dropped is reported in `result.truncated`.
 */
export const SHELL_CAPTURE_TAIL_BYTES = 64 * 1024;

/**
 * Default per-stream byte cap for `output: 'full'`. Generous enough for a
 * PM2 process list or a remote branch list, small enough that a runaway
 * command cannot exhaust memory. A per-call `maxBytes` overrides it.
 */
export const SHELL_CAPTURE_FULL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The accepted values of `options.output`. Frozen so a typo is a clear
 * programming error, not a silently ignored option.
 */
export const SHELL_OUTPUT_MODES = Object.freeze(['tail', 'full', 'stream']);

/**
 * Validates the output options and returns the normalised mode and byte cap.
 *
 * @param {{ output?: string, maxBytes?: number, onData?: Function|null }} options
 * @returns {{ mode: 'tail'|'full'|'stream', maxBytes: number }}
 * @throws {TypeError} An unknown mode, an invalid cap, or `stream` without
 *   `onData` — each would otherwise silently lose output.
 */
function resolveOutputOptions({ output = 'tail', maxBytes, onData = null } = {}) {
  const mode = output ?? 'tail';
  if (!SHELL_OUTPUT_MODES.includes(mode)) {
    throw new TypeError(
      `Unknown shell output mode ${JSON.stringify(mode)}. Use one of: ${SHELL_OUTPUT_MODES.join(', ')}.`,
    );
  }
  if (mode === 'stream' && typeof onData !== 'function') {
    throw new TypeError(
      "output: 'stream' requires an onData callback: stream mode keeps no captured output, so onData is the only way to receive it.",
    );
  }

  let cap = SHELL_CAPTURE_FULL_MAX_BYTES;
  if (maxBytes !== undefined && maxBytes !== null) {
    cap = Number(maxBytes);
    if (!Number.isFinite(cap) || cap <= 0) {
      throw new TypeError(`maxBytes must be a positive number of bytes; got ${String(maxBytes)}.`);
    }
  }

  return { mode, maxBytes: Math.floor(cap) };
}

/** Empty truncation report for results that never captured anything. */
function noTruncation() {
  return { stdout: 0, stderr: 0 };
}

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

/** Keeps the newest bytes in a fixed circular buffer and counts what it drops. */
function createBoundedTail(limit = SHELL_CAPTURE_TAIL_BYTES) {
  const ring = Buffer.allocUnsafe(limit);
  let start = 0;
  let bytes = 0;
  let dropped = 0;

  return {
    append(chunk) {
      const incoming = asBuffer(chunk);
      if (incoming.length === 0) return;

      if (incoming.length >= limit) {
        // Everything already buffered is older than this chunk's own tail.
        dropped += bytes + (incoming.length - limit);
        incoming.copy(ring, 0, incoming.length - limit);
        start = 0;
        bytes = limit;
        return;
      }

      const overflow = Math.max(0, bytes + incoming.length - limit);
      if (overflow > 0) {
        dropped += overflow;
        start = (start + overflow) % limit;
        bytes -= overflow;
      }

      const writeAt = (start + bytes) % limit;
      const first = Math.min(incoming.length, limit - writeAt);
      incoming.copy(ring, writeAt, 0, first);
      if (first < incoming.length) incoming.copy(ring, 0, first);
      bytes += incoming.length;
    },

    /** Bytes evicted so far — the exact size of the gap the caller cannot see. */
    get dropped() {
      return dropped;
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
 * Decode one byte stream incrementally and keep what the mode asks for.
 *
 * A UTF-8 character may be split across pipe chunks. Decoding each Buffer on
 * its own replaces both halves before redaction can see the secret. The
 * StringDecoder preserves the partial character until the next chunk, and
 * finish() flushes it before the captured text is returned.
 *
 * Modes:
 *   - tail: a fixed ring of the newest bytes, counting what it evicts;
 *   - full: every byte up to `limit` per stream, then `onOverflow` (the caller
 *     kills the child) — the extra bytes are counted, never silently cut;
 *   - stream: nothing buffered; `onText` receives every decoded chunk.
 *
 * @param {{ mode?: 'tail'|'full'|'stream', limit?: number,
 *   onText?: Function|null, onOverflow?: Function|null }} options
 */
function createTextCapture({ mode = 'tail', limit = SHELL_CAPTURE_TAIL_BYTES, onText = null, onOverflow = null } = {}) {
  const decoder = new StringDecoder('utf8');
  const tail = mode === 'tail' ? createBoundedTail(limit) : null;
  const chunks = mode === 'full' ? [] : null;
  let size = 0;
  let dropped = 0;
  let overflowed = false;
  let finished = null;

  const consumeText = (text) => {
    if (!text) return;

    if (onText) {
      try { onText(text); } catch { /* a listener cannot change the command result */ }
    }
    if (mode === 'stream') return;

    const bytes = Buffer.from(text, 'utf8');

    if (mode === 'tail') {
      tail.append(bytes);
      dropped = tail.dropped;
      return;
    }

    // full mode: keep what fits, count the rest, and let the caller abort.
    if (overflowed) {
      dropped += bytes.length;
      return;
    }

    const room = limit - size;
    if (bytes.length <= room) {
      chunks.push(bytes);
      size += bytes.length;
      return;
    }

    if (room > 0) {
      chunks.push(bytes.subarray(0, room));
      size += room;
    }
    dropped += bytes.length - Math.max(0, room);
    overflowed = true;
    if (onOverflow) {
      try { onOverflow(dropped); } catch { /* the capture still resolves */ }
    }
  };

  return {
    append(chunk) {
      consumeText(decoder.write(asBuffer(chunk)));
    },
    /** The captured text for this mode. Stream mode captures nothing. */
    finish() {
      if (finished === null) {
        consumeText(decoder.end());
        if (mode === 'tail') finished = capturedText(tail);
        else if (mode === 'full') finished = stripAnsi(Buffer.concat(chunks).toString('utf8')).trim();
        else finished = '';
      }
      return finished;
    },
    /** Bytes dropped so far, valid after finish(). */
    get dropped() {
      return dropped;
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

/**
 * Execute a native executable with literal arguments and no command
 * interpreter.
 *
 * Accepts the same `output`/`maxBytes`/`onData` options as run():
 * `'tail'` (default) keeps the newest 64 KiB of each stream, `'full'` keeps
 * everything up to `maxBytes` and kills the child over the cap, and
 * `'stream'` keeps nothing but requires `onData`. Every result carries
 * `truncated: { stdout, stderr }`, the bytes dropped from each stream.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ timeout?: number, cwd?: string, env?: Object|null,
 *   onData?: Function|null, replaceEnv?: boolean, stdin?: string|null,
 *   output?: 'tail'|'full'|'stream', maxBytes?: number }} [options]
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string,
 *   exitCode: number|null, command: string,
 *   truncated: { stdout: number, stderr: number }, error?: string }>}
 */
export function runFile(file, args, options = {}) {
  const {
    timeout = 30000,
    cwd = process.cwd(),
    env = null,
    onData = null,
    replaceEnv = false,
    stdin = null,
    output = 'tail',
    maxBytes,
  } = options;
  return capture((spawnOptions) => spawn(file, args, { ...spawnOptions, shell: false }), {
    cmd: file, timeout, cwd, env, onData, replaceEnv, stdin, output, maxBytes,
  });
}

// ─── run ──────────────────────────────────────────────────────────────────────

/**
 * Executes a shell command and captures its stdout and stderr.
 *
 * Command failures never throw. ANSI escape codes are stripped from all
 * captured output. When the timeout expires the child process is killed and
 * exitCode is null.
 *
 * @param {string} cmd - The command string to execute.
 * @param {{ timeout?: number, cwd?: string, output?: 'tail'|'full'|'stream', maxBytes?: number }} [options]
 * @param {number} [options.timeout=30000] - Milliseconds before the process is killed.
 * @param {string} [options.cwd=process.cwd()] - Working directory for the child process.
 * @param {Object} [options.env] - Extra environment variables, merged over process.env.
 * @param {(chunk: string, stream: 'stdout'|'stderr') => void} [options.onData] - Receives output as it arrives.
 * @param {'tail'|'full'|'stream'} [options.output='tail'] - What to keep: the
 *   newest 64 KiB of each stream, everything up to `maxBytes` (the child is
 *   killed over the cap), or nothing at all (requires `onData`).
 * @param {number} [options.maxBytes] - Per-stream cap for `output: 'full'`
 *   (default 8 MiB).
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, exitCode: number|null, command: string, truncated: { stdout: number, stderr: number }, error?: string }>}
 */
export function run(cmd, options = {}) {
  const {
    timeout = 30000,
    cwd = process.cwd(),
    env = null,
    onData = null,
    replaceEnv = false,
    output = 'tail',
    maxBytes,
  } = options;
  const { shell, flag } = getShell();

  return capture(
    (spawnOptions) => spawn(shell, [flag, cmd], spawnOptions),
    { cmd, timeout, cwd, env, onData, replaceEnv, output, maxBytes },
  );
}

/**
 * Shared body of run(), runFile() and runCommandLine(): spawn, collect output,
 * enforce the timeout and the `full` byte cap, and always resolve with a
 * CommandResult.
 *
 * `output: 'stream'` without `onData`, an unknown mode or an invalid cap throws
 * a TypeError synchronously — before anything is spawned — because each of
 * those would silently lose output.
 *
 * @param {(spawnOptions: Object) => import('child_process').ChildProcess} spawnChild
 * @param {{ cmd: string, timeout: number, cwd: string, env: Object|null,
 *   onData: Function|null, replaceEnv?: boolean, stdin?: string|null,
 *   output?: 'tail'|'full'|'stream', maxBytes?: number }} opts
 */
function capture(spawnChild, opts) {
  const {
    cmd,
    timeout,
    cwd,
    env,
    onData,
    replaceEnv = false,
    stdin = null,
    output = 'tail',
    maxBytes,
  } = opts;
  const { mode, maxBytes: capBytes } = resolveOutputOptions({ output, maxBytes, onData });

  return new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);

    let child;
    let capError = null;
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnChild({
        cwd,
        signal: ac.signal,
        encoding: 'utf8',
        windowsHide: true,
        ...(stdin ? { stdio: [stdin, 'pipe', 'pipe'] } : {}),
        ...(env ? { env: replaceEnv ? { ...env } : { ...process.env, ...env } } : {}),
      });
    } catch (err) {
      settle({
        success: false,
        stdout: '',
        stderr: err.message,
        exitCode: null,
        command: cmd,
        truncated: noTruncation(),
      });
      return;
    }

    const overflow = () => {
      if (capError) return;
      capError = `output exceeded ${capBytes} bytes`;
      // Full mode must never return a quietly cut capture: stop the producer.
      try { child?.kill('SIGKILL'); } catch { /* it may have exited already */ }
    };

    const stdoutCapture = createTextCapture({
      mode,
      limit: mode === 'full' ? capBytes : SHELL_CAPTURE_TAIL_BYTES,
      onText: onData ? (text) => onData(stripAnsi(text), 'stdout') : null,
      onOverflow: overflow,
    });
    const stderrCapture = createTextCapture({
      mode,
      limit: mode === 'full' ? capBytes : SHELL_CAPTURE_TAIL_BYTES,
      onText: onData ? (text) => onData(stripAnsi(text), 'stderr') : null,
      onOverflow: overflow,
    });

    /** Finish both captures once, whatever path settles the promise. */
    const snapshot = () => {
      const stdout = stdoutCapture.finish();
      const stderr = stderrCapture.finish();
      return {
        stdout,
        stderr,
        truncated: { stdout: stdoutCapture.dropped, stderr: stderrCapture.dropped },
      };
    };

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdoutCapture.append(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      stderrCapture.append(chunk);
    });

    child.on('close', (exitCode) => {
      const captured = snapshot();
      if (capError) {
        settle({
          success: false,
          stdout: captured.stdout,
          stderr: captured.stderr,
          exitCode: null,
          command: cmd,
          truncated: captured.truncated,
          error: capError,
        });
        return;
      }
      settle({
        success: exitCode === 0,
        stdout: captured.stdout,
        stderr: captured.stderr,
        exitCode,
        command: cmd,
        truncated: captured.truncated,
      });
    });

    child.on('error', (err) => {
      const captured = snapshot();
      if (capError) {
        settle({
          success: false,
          stdout: captured.stdout,
          stderr: captured.stderr,
          exitCode: null,
          command: cmd,
          truncated: captured.truncated,
          error: capError,
        });
        return;
      }
      settle({
        success: false,
        stdout: captured.stdout,
        stderr: err.name === 'AbortError' ? `Timeout after ${timeout}ms` : err.message,
        exitCode: null,
        command: cmd,
        truncated: captured.truncated,
      });
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
 * Command failures never throw. Same CommandResult and same `output` modes as run():
 * `'tail'` (default) keeps the newest 64 KiB of each stream, `'full'` keeps
 * everything up to `maxBytes` and kills the shell over the cap, and `'stream'`
 * keeps nothing but requires `onData`. Every result carries
 * `truncated: { stdout, stderr }`. On a timeout the shell is killed;
 * a grandchild it started may outlive it, which is why the default is long
 * rather than tight.
 *
 * @param {string} cmd - The command line, exactly as written.
 * @param {Object} [options]
 * @param {number} [options.timeout=900000] - Milliseconds before the shell is killed (15 minutes).
 * @param {string} [options.cwd=process.cwd()]
 * @param {Object} [options.env] - Extra environment variables, merged over process.env.
 * @param {(chunk: string, stream: 'stdout'|'stderr') => void} [options.onData]
 * @param {'tail'|'full'|'stream'} [options.output='tail'] - What to keep.
 * @param {number} [options.maxBytes] - Per-stream cap for `output: 'full'` (default 8 MiB).
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, exitCode: number|null, command: string, truncated: { stdout: number, stderr: number }, error?: string }>}
 */
export function runCommandLine(cmd, options = {}) {
  const {
    timeout = 900000,
    cwd = process.cwd(),
    env = null,
    onData = null,
    replaceEnv = false,
    output = 'tail',
    maxBytes,
  } = options;
  return capture(
    (spawnOptions) => spawn(cmd, [], { ...spawnOptions, shell: true }),
    { cmd, timeout, cwd, env, onData, replaceEnv, output, maxBytes },
  );
}

// ─── runLive ──────────────────────────────────────────────────────────────────

/**
 * Executes a shell command, streaming stdout and stderr directly to the terminal.
 *
 * Never throws. Returns the process exit code, or null if the process was killed
 * (e.g. timeout) or an error occurred.
 *
 * This streams straight to the terminal and captures nothing, so the `output`
 * modes and `truncated` report do not apply; use run() when a caller needs the
 * text.
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
 * Never throws for command failures. The returned Promise always resolves with
 * a CommandResult. Captured stdout and stderr follow the same `output` modes
 * as run():
 *   - `'tail'` (default): each keeps only the newest bounded byte tail;
 *   - `'full'`: everything up to `maxBytes` (default 8 MiB) per stream; over
 *     the cap the child is killed and the result carries
 *     `success: false, exitCode: null, error: 'output exceeded <N> bytes'`;
 *   - `'stream'`: nothing is captured (stdout/stderr stay ''), every chunk
 *     goes to `onData`, which is required.
 * Every result carries `truncated: { stdout, stderr }` — the bytes dropped.
 *
 * @param {string} cmd - The executable to spawn (e.g. 'sudo').
 * @param {string[]} argsArray - Arguments passed directly to the executable.
 * @param {string} [stdinData=''] - String to pipe to the process stdin.
 * @param {{ output?: 'tail'|'full'|'stream', maxBytes?: number,
 *   onData?: ((chunk: string, stream: 'stdout'|'stderr') => void)|null }} [options]
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, exitCode: number|null, command: string, truncated: { stdout: number, stderr: number }, error?: string }>}
 */
export function runWithStdin(cmd, argsArray, stdinData = '', options = {}) {
  const { output = 'tail', maxBytes, onData = null } = options;
  const { mode, maxBytes: capBytes } = resolveOutputOptions({ output, maxBytes, onData });

  return new Promise((resolve) => {
    let child;
    let capError = null;
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      child = spawn(cmd, argsArray, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      settle({
        success: false,
        stdout: '',
        stderr: err.message,
        exitCode: null,
        command: cmd,
        truncated: noTruncation(),
      });
      return;
    }

    const overflow = () => {
      if (capError) return;
      capError = `output exceeded ${capBytes} bytes`;
      try { child?.kill('SIGKILL'); } catch { /* it may have exited already */ }
    };

    const stdoutCapture = createTextCapture({
      mode,
      limit: mode === 'full' ? capBytes : SHELL_CAPTURE_TAIL_BYTES,
      onText: onData ? (text) => onData(stripAnsi(text), 'stdout') : null,
      onOverflow: overflow,
    });
    const stderrCapture = createTextCapture({
      mode,
      limit: mode === 'full' ? capBytes : SHELL_CAPTURE_TAIL_BYTES,
      onText: onData ? (text) => onData(stripAnsi(text), 'stderr') : null,
      onOverflow: overflow,
    });

    const snapshot = () => ({
      stdout: stdoutCapture.finish(),
      stderr: stderrCapture.finish(),
      truncated: { stdout: stdoutCapture.dropped, stderr: stderrCapture.dropped },
    });

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdoutCapture.append(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      stderrCapture.append(chunk);
    });

    child.stdin.on('error', () => { /* the child may exit before reading stdin */ });
    child.stdin.write(stdinData);
    child.stdin.end();

    child.on('close', (exitCode) => {
      const captured = snapshot();
      if (capError) {
        settle({
          success: false,
          stdout: captured.stdout,
          stderr: captured.stderr,
          exitCode: null,
          command: cmd,
          truncated: captured.truncated,
          error: capError,
        });
        return;
      }
      settle({
        success: exitCode === 0,
        stdout: captured.stdout,
        stderr: captured.stderr,
        exitCode,
        command: cmd,
        truncated: captured.truncated,
      });
    });

    child.on('error', (err) => {
      const captured = snapshot();
      settle({
        success: false,
        stdout: captured.stdout,
        stderr: capError ?? err.message,
        exitCode: null,
        command: cmd,
        truncated: captured.truncated,
        ...(capError ? { error: capError } : {}),
      });
    });
  });
}
