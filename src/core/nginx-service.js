import fs from 'fs/promises';
import path from 'path';
import { run } from './shell.js';
import { loadConfig } from './config.js';
import { ensureNginxInclude, getConfDDir } from './nginx-conf-generator.js';
import {
  isWindows,
  getNginxExe,
  nginxTestCmd,
  combineOutput,
  isNginxTestOk,
  nginxLogPath,
  powerShellLiteral,
} from './platform.js';
import { completeLogLines, readBoundedTailSync } from './service/logTail.js';

// ─── Error Types ──────────────────────────────────────────────────────────────

export class NginxNotFoundError extends Error { }

export class NginxConfigError extends Error {
  constructor(output) {
    super(output);
    this.output = output;
  }
}

export class InvalidFilenameError extends Error { }

/** Each stream capture and nginx log read has a hard, exported byte budget. */
export const NGINX_LOG_TAIL_MAX_BYTES = 1024 * 1024;
export const NGINX_LOG_TAIL_CHUNK_BYTES = 64 * 1024;
export const NGINX_LOG_MAX_LINES = 5000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clampLogLines(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(NGINX_LOG_MAX_LINES, Math.trunc(parsed)));
}

function tailHasEnoughLines(text, requested, startsMidFile) {
  const parts = text.split('\n');

  // The first entry can be the tail of a line that began before the bounded
  // read. Exclude it so every count represents a complete line.
  if (startsMidFile && parts.length > 0) parts.shift();
  return parts.filter(Boolean).length >= requested;
}

function readErrorTail(file, lines) {
  try {
    return completeLogLines(readBoundedTailSync(file), lines).join('\n');
  } catch {
    return '';
  }
}

async function readBoundedLogTail(handle, size, requested) {
  const truncated = size > NGINX_LOG_TAIL_MAX_BYTES;
  const contentBudget = truncated
    ? NGINX_LOG_TAIL_MAX_BYTES - 1
    : NGINX_LOG_TAIL_MAX_BYTES;
  const floor = Math.max(0, size - contentBudget);
  let end = size;
  let bytes = 0;
  const chunks = [];

  while (end > floor) {
    const start = Math.max(floor, end - NGINX_LOG_TAIL_CHUNK_BYTES);
    const buffer = Buffer.allocUnsafe(end - start);
    let offset = 0;

    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        start + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    if (offset === 0) break;
    chunks.unshift(buffer.subarray(0, offset));
    bytes += offset;
    end = start;

    const text = Buffer.concat(chunks, bytes).toString('utf8');
    if (end === 0 || tailHasEnoughLines(text, requested, end > 0)) break;
  }

  const text = Buffer.concat(chunks, bytes).toString('utf8');
  const parts = text.split('\n');

  if (end > 0) {
    // The byte immediately before the bounded window tells us whether the
    // first entry is a complete line or the tail of an older one.
    const boundary = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(boundary, 0, 1, end - 1);
    if (bytesRead !== 1 || boundary[0] !== 0x0a) parts.shift();
  }

  return parts.filter(Boolean).slice(-requested);
}

function getNginxDir() {
  const { nginxDir } = loadConfig();
  return nginxDir;
}

export function validateFilename(filename) {
  if (
    filename.includes('..') ||
    filename.startsWith('/') ||
    /^[A-Za-z]:[/\\]/.test(filename)
  ) {
    throw new InvalidFilenameError('Invalid filename');
  }
  const nginxDir = getNginxDir();
  const confDir = getConfDDir(nginxDir);
  const resolved = path.resolve(path.join(confDir, filename));
  if (!resolved.startsWith(path.resolve(confDir))) {
    throw new InvalidFilenameError('Invalid filename');
  }
}

const SUDO_PERMISSION_MSG = 'Linux permissions not configured. Open Settings → Setup Linux Permissions.';

function isSudoPermissionError(result) {
  const output = (result.stderr || result.stdout || '');
  return (
    output.includes('password is required') ||
    output.includes('a terminal is required') ||
    output.includes('sudo:')
  );
}

async function findNginxPath() {
  const result = await run('which nginx');
  if (result.success && result.stdout.trim()) {
    return result.stdout.trim().split('\n')[0].trim();
  }
  throw new Error('nginx binary not found');
}

/** Checks if nginx is installed and throws NginxNotFoundError if not. */
async function assertNginxInstalled(nginxExe) {
  const versionResult = await run(`${nginxExe} -v`);
  if (!versionResult.success && !versionResult.stderr.includes('nginx/')) {
    throw new NginxNotFoundError('nginx binary not found');
  }
}

// ─── US1: Status ──────────────────────────────────────────────────────────────

export async function getStatus() {
  const nginxDir = getNginxDir();
  const nginxExe = getNginxExe(nginxDir);
  const versionResult = await run(`${nginxExe} -v`);

  if (!versionResult.success && !versionResult.stderr.includes('nginx/')) {
    throw new NginxNotFoundError('nginx binary not found');
  }

  const versionMatch = versionResult.stderr.match(/nginx\/[\d.]+/);
  const version = versionMatch ? versionMatch[0] : null;

  let running = false;
  let pid = null;

  if (isWindows) {
    const result = await run('tasklist /FI "IMAGENAME eq nginx.exe" /NH');
    const output = combineOutput(result);
    running = output.toLowerCase().includes('nginx.exe');
    if (running) {
      const match = output.match(/nginx\.exe\s+(\d+)/i);
      pid = match ? parseInt(match[1], 10) : null;
    }
  } else {
    const result = await run('pgrep -x nginx');
    running = result.success && result.stdout.trim().length > 0;
    if (running) {
      const firstLine = result.stdout.trim().split('\n')[0];
      pid = firstLine ? parseInt(firstLine, 10) : null;
    }
  }

  return { running, version, pid };
}

// ─── US2: Control ─────────────────────────────────────────────────────────────

export async function reload() {
  const nginxDir = getNginxDir();
  const nginxExe = getNginxExe(nginxDir);
  await assertNginxInstalled(nginxExe);

  const result = isWindows
    ? await run(`${nginxExe} -s reload`, { cwd: nginxDir, timeout: 15000 })
    : await run('sudo -n /usr/bin/systemctl reload nginx');
  if (!result.success && !isWindows && isSudoPermissionError(result)) {
    return { success: false, output: SUDO_PERMISSION_MSG };
  }
  return { success: result.success, output: combineOutput(result) || '' };
}

export async function restart() {
  const nginxDir = getNginxDir();
  const nginxExe = getNginxExe(nginxDir);
  await assertNginxInstalled(nginxExe);

  if (isWindows) {
    const stopResult = await run('taskkill /f /IM nginx.exe');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const startResult = await run(nginxExe, { cwd: nginxDir, timeout: 15000 });
    const output = [combineOutput(stopResult), combineOutput(startResult)]
      .filter(Boolean)
      .join('\n')
      .trim();
    return { success: startResult.success, output };
  }

  const result = await run('sudo -n /usr/bin/systemctl restart nginx');
  if (!result.success && isSudoPermissionError(result)) {
    return { success: false, output: SUDO_PERMISSION_MSG };
  }
  return { success: result.success, output: combineOutput(result) || '' };
}

export async function start() {
  const nginxDir = getNginxDir();
  const nginxExe = getNginxExe(nginxDir);
  await assertNginxInstalled(nginxExe);

  // Ensure required directories exist on Windows
  if (isWindows) {
    await fs.mkdir(path.join(nginxDir, 'logs'), { recursive: true });
    await fs.mkdir(path.join(nginxDir, 'temp'), { recursive: true });
  }

  // Test config before starting
  await ensureNginxInclude(nginxDir);
  const nginxPath = isWindows ? null : await findNginxPath();
  const testResult = isWindows
    ? await run(nginxTestCmd(nginxDir), { cwd: nginxDir })
    : await run(`${nginxPath} -t`);
  if (!isNginxTestOk(testResult)) {
    return {
      success: false,
      output: !isWindows && isSudoPermissionError(testResult) ? SUDO_PERMISSION_MSG : combineOutput(testResult),
    };
  }

  // Start nginx
  if (isWindows) {
    const confPath = path.join(nginxDir, 'conf', 'nginx.conf');
    const startCmd = `Start-Process -FilePath ${powerShellLiteral(path.join(nginxDir, 'nginx.exe'))} -ArgumentList @('-c', ${powerShellLiteral(confPath)}) -WorkingDirectory ${powerShellLiteral(nginxDir)} -WindowStyle Hidden`;
    await run(startCmd, { cwd: nginxDir, timeout: 10000 });
  } else {
    const result = await run('sudo -n /usr/bin/systemctl start nginx');
    if (!result.success) {
      return { success: false, output: isSudoPermissionError(result) ? SUDO_PERMISSION_MSG : combineOutput(result) || '' };
    }
  }

  // Wait briefly then verify nginx is running
  await new Promise(r => setTimeout(r, 1500));

  let running = false;
  if (isWindows) {
    const check = await run('tasklist /FI "IMAGENAME eq nginx.exe" /NH');
    running = check.success && check.stdout.toLowerCase().includes('nginx.exe');
  } else {
    const check = await run('systemctl is-active nginx');
    running = check.stdout.trim() === 'active';
  }

  if (running) {
    return { success: true, output: 'nginx started successfully' };
  }

  // Didn't start — surface error log
  const logPath = nginxLogPath(nginxDir, 'error');
  const logTail = readErrorTail(logPath, 20);

  return {
    success: false,
    output: 'nginx did not start\n\n' + (logTail || '(no error log)'),
  };
}

export async function stop() {
  const nginxDir = getNginxDir();
  const nginxExe = getNginxExe(nginxDir);
  await assertNginxInstalled(nginxExe);

  const result = isWindows
    ? await run('taskkill /f /IM nginx.exe')
    : await run('sudo -n /usr/bin/systemctl stop nginx');

  if (!result.success && !isWindows && isSudoPermissionError(result)) {
    return { success: false, output: SUDO_PERMISSION_MSG };
  }
  return { success: result.success, output: combineOutput(result) || 'nginx stopped' };
}

// ─── US3: Test Config ─────────────────────────────────────────────────────────

export async function test() {
  const nginxDir = getNginxDir();
  const nginxExe = getNginxExe(nginxDir);
  await assertNginxInstalled(nginxExe);

  await ensureNginxInclude(nginxDir);
  const nginxPath = isWindows ? null : await findNginxPath();
  const result = isWindows
    ? await run(nginxTestCmd(nginxDir), { cwd: nginxDir })
    : await run(`${nginxPath} -t`);
  if (!result.success && !isWindows && isSudoPermissionError(result)) {
    return { success: false, output: SUDO_PERMISSION_MSG };
  }
  const output = combineOutput(result);
  return { success: isNginxTestOk(result), output };
}

// ─── US4: Config File Management ──────────────────────────────────────────────

export async function listConfigs() {
  const nginxDir = getNginxDir();
  const confDir = getConfDDir(nginxDir);
  let entries;
  try {
    entries = await fs.readdir(confDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter(f => f.endsWith('.conf'));
}

export async function getConfig(filename) {
  validateFilename(filename);
  const nginxDir = getNginxDir();
  const confPath = path.join(getConfDDir(nginxDir), filename);
  const content = await fs.readFile(confPath, 'utf8');
  return { content };
}

export async function saveConfig(filename, content) {
  validateFilename(filename);
  const nginxDir = getNginxDir();
  const confPath = path.join(getConfDDir(nginxDir), filename);
  const backupPath = confPath + '.bak';

  // Backup only if the file already exists (it may be a new file)
  let hasBackup = false;
  try {
    await fs.copyFile(confPath, backupPath);
    hasBackup = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fs.mkdir(path.dirname(confPath), { recursive: true });
  await fs.writeFile(confPath, content, 'utf8');

  const nginxExe = getNginxExe(nginxDir);
  await ensureNginxInclude(nginxDir);
  const nginxPath = isWindows ? null : await findNginxPath();
  const testCmd = isWindows ? nginxTestCmd(nginxDir) : `${nginxPath} -t`;
  const result = await run(testCmd, { cwd: nginxDir });
  if (!isNginxTestOk(result)) {
    if (hasBackup) {
      await fs.copyFile(backupPath, confPath);
    } else {
      try { await fs.unlink(confPath); } catch { /* ignore */ }
    }
    const output = !isWindows && isSudoPermissionError(result) ? SUDO_PERMISSION_MSG : combineOutput(result);
    throw new NginxConfigError(output);
  }

  return { success: true, output: combineOutput(result) };
}

// ─── US5: Logs ────────────────────────────────────────────────────────────────

/**
 * Reads the tail of an nginx log.
 *
 * `which` is additive: the previous signature took only a line count and
 * always read the error log, so every existing caller keeps working. The
 * access log was unreachable before, which is what the UI needed.
 *
 * The line count is clamped internally. File I/O walks backwards from EOF in
 * fixed chunks and stops at a line or byte budget, so this never loads a large
 * log into memory.
 *
 * @param {number} [lines]
 * @param {'error'|'access'} [which]
 * @returns {Promise<{ lines: string[] }>}
 */
export async function getLogs(lines = 100, which = 'error') {
  const requested = clampLogLines(lines);
  const nginxDir = getNginxDir();
  const logPath = nginxLogPath(nginxDir, which === 'access' ? 'access' : 'error');

  let handle;
  try {
    handle = await fs.open(logPath, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: [] };
    throw err;
  }

  try {
    const stats = await handle.stat();
    if (stats.size === 0) return { lines: [] };
    return { lines: await readBoundedLogTail(handle, stats.size, requested) };
  } finally {
    await handle.close().catch(() => {});
  }
}
