import fs from 'fs/promises';
import path from 'path';
import { run } from '../../core/shell.js';
import { loadConfig } from '../../core/config.js';
import { ensureNginxInclude } from '../../core/nginx-conf-generator.js';

// ─── Error Types ──────────────────────────────────────────────────────────────

export class NginxNotFoundError extends Error { }

export class NginxConfigError extends Error {
  constructor(output) {
    super(output);
    this.output = output;
  }
}

export class InvalidFilenameError extends Error { }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getNginxDir() {
  const { nginxDir } = loadConfig();
  return nginxDir;
}

function getConfDDir(nginxDir) {
  return process.platform === 'win32'
    ? path.join(nginxDir, 'conf', 'conf.d')
    : path.join(nginxDir, 'conf.d');
}

/**
 * Returns the PS-safe invocation string for the nginx binary.
 * On Windows: checks PATH first, then falls back to configured nginxDir.
 * On Linux:   always returns 'nginx'.
 */
function getNginxExe() {
  const nginxDir = getNginxDir();
  if (process.platform === 'win32') {
    const exe = path.join(nginxDir, 'nginx.exe');
    return `& "${exe}"`;
  }
  return 'nginx';
}

function combineOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
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

// ─── US1: Status ──────────────────────────────────────────────────────────────

export async function getStatus() {
  const nginxExe = getNginxExe();
  const versionResult = await run(`${nginxExe} -v`);

  if (!versionResult.success && !versionResult.stderr.includes('nginx/')) {
    throw new NginxNotFoundError('nginx binary not found');
  }

  const versionMatch = versionResult.stderr.match(/nginx\/[\d.]+/);
  const version = versionMatch ? versionMatch[0] : null;

  let running = false;
  let pid = null;

  if (process.platform === 'win32') {
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
  const nginxExe = getNginxExe();
  const nginxDir = getNginxDir();
  const versionResult = await run(`${nginxExe} -v`);
  if (!versionResult.success && !versionResult.stderr.includes('nginx/')) {
    throw new NginxNotFoundError('nginx binary not found');
  }

  const result = process.platform === 'win32'
    ? await run(`${nginxExe} -s reload`, { cwd: nginxDir, timeout: 15000 })
    : await run('nginx -s reload');
  return { success: result.success, output: combineOutput(result) };
}

// TODO: We need Fix this
export async function restart() {
  const nginxExe = getNginxExe();
  const nginxDir = getNginxDir();
  const versionResult = await run(`${nginxExe} -v`);
  if (!versionResult.success && !versionResult.stderr.includes('nginx/')) {
    throw new NginxNotFoundError('nginx binary not found');
  }

  const stopResult = process.platform === 'win32'
    ? await run('taskkill /f /IM nginx.exe')
    : await run('nginx -s stop');

  await new Promise(resolve => setTimeout(resolve, 2000));

  const startResult = await run(nginxExe, { cwd: nginxDir, timeout: 15000 });
  console.log("startResult ", startResult);
  const output = [combineOutput(stopResult), combineOutput(startResult)]
    .filter(Boolean)
    .join('\n')
    .trim();
  return { success: startResult.success, output };
}

export async function start() {
  const nginxExe = getNginxExe();
  const nginxDir = getNginxDir();
  const versionResult = await run(`${nginxExe} -v`);
  if (!versionResult.success && !versionResult.stderr.includes('nginx/')) {
    throw new NginxNotFoundError('nginx binary not found');
  }

  // Ensure required directories exist on Windows
  if (process.platform === 'win32') {
    await fs.mkdir(path.join(nginxDir, 'logs'), { recursive: true });
    await fs.mkdir(path.join(nginxDir, 'temp'), { recursive: true });
  }

  // Test config before starting with explicit config path on Windows
  await ensureNginxInclude(nginxDir);
  const testCmd = process.platform === 'win32'
    ? `${nginxExe} -c "${path.join(nginxDir, 'conf', 'nginx.conf')}" -t`
    : `${nginxExe} -t`;
  const testResult = await run(testCmd, { cwd: nginxDir });
  if (!testResult.success) {
    return { success: false, output: combineOutput(testResult) };
  }

  // Start nginx with explicit config path on Windows
  if (process.platform === 'win32') {
    const confPath = path.join(nginxDir, 'conf', 'nginx.conf');
    const startCmd = `Start-Process -FilePath "${path.join(nginxDir, 'nginx.exe')}" -ArgumentList '-c','"${confPath}"' -WorkingDirectory "${nginxDir}" -WindowStyle Hidden`;
    await run(startCmd, { cwd: nginxDir, timeout: 10000 });
  } else {
    const result = await run('nginx', { cwd: nginxDir, timeout: 15000 });
    if (!result.success) {
      return { success: false, output: combineOutput(result) };
    }
  }

  // Wait briefly then verify nginx is running
  await new Promise(r => setTimeout(r, 1500));

  let running = false;
  if (process.platform === 'win32') {
    const check = await run('tasklist /FI "IMAGENAME eq nginx.exe" /NH');
    running = check.success && check.stdout.toLowerCase().includes('nginx.exe');
  } else {
    const check = await run('pgrep -x nginx');
    running = check.exitCode === 0;
  }

  if (running) {
    return { success: true, output: 'nginx started successfully' };
  }

  // Didn't start - try to get error log
  const logPath = process.platform === 'win32'
    ? path.join(nginxDir, 'logs', 'error.log')
    : '/var/log/nginx/error.log';
  const logCmd = process.platform === 'win32'
    ? `Get-Content -Tail 20 "${logPath}" -ErrorAction SilentlyContinue`
    : `tail -n 20 "${logPath}" 2>/dev/null`;
  const logResult = await run(logCmd);

  return {
    success: false,
    output: 'nginx did not start\n\n' + (logResult.success ? logResult.stdout : '(no error log)'),
  };
}

export async function stop() {
  const nginxExe = getNginxExe();
  const versionResult = await run(`${nginxExe} -v`);
  if (!versionResult.success && !versionResult.stderr.includes('nginx/')) {
    throw new NginxNotFoundError('nginx binary not found');
  }

  const result = process.platform === 'win32'
    ? await run('taskkill /f /IM nginx.exe')
    : await run('nginx -s stop');

  return { success: result.success, output: combineOutput(result) || 'nginx stopped' };
}

// ─── US3: Test Config ─────────────────────────────────────────────────────────

export async function test() {
  const nginxExe = getNginxExe();
  const nginxDir = getNginxDir();
  const versionResult = await run(`${nginxExe} -v`);
  if (!versionResult.success && !versionResult.stderr.includes('nginx/')) {
    throw new NginxNotFoundError('nginx binary not found');
  }

  await ensureNginxInclude(nginxDir);
  // Use explicit -c flag on Windows to avoid path issues
  const testCmd = process.platform === 'win32'
    ? `${nginxExe} -c "${path.join(nginxDir, 'conf', 'nginx.conf')}" -t`
    : `${nginxExe} -t`;
  const result = await run(testCmd, { cwd: nginxDir });
  return { success: result.success, output: combineOutput(result) };
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

  const nginxExe = getNginxExe();
  await ensureNginxInclude(nginxDir);
  const result = await run(`${nginxExe} -t`, { cwd: nginxDir });
  if (!result.success) {
    if (hasBackup) {
      await fs.copyFile(backupPath, confPath);
    } else {
      try { await fs.unlink(confPath); } catch { /* ignore */ }
    }
    throw new NginxConfigError(combineOutput(result));
  }

  return { success: true, output: combineOutput(result) };
}

// ─── US5: Logs ────────────────────────────────────────────────────────────────

export async function getLogs(lines = 100) {
  const nginxDir = getNginxDir();
  const logPath = path.join(nginxDir, 'logs', 'error.log');
  let content;
  try {
    content = await fs.readFile(logPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: [] };
    throw err;
  }
  const allLines = content.split('\n').filter(Boolean);
  return { lines: allLines.slice(-lines) };
}
