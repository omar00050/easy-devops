import fs from 'fs/promises';
import path from 'path';
import { run } from '../../core/shell.js';
import { loadConfig } from '../../core/config.js';
import { ensureNginxInclude, getConfDDir } from '../../core/nginx-conf-generator.js';
import { isWindows, getNginxExe, nginxTestCmd, combineOutput, isNginxTestOk } from '../../core/platform.js';

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
    const startCmd = `Start-Process -FilePath "${path.join(nginxDir, 'nginx.exe')}" -ArgumentList '-c','"${confPath}"' -WorkingDirectory "${nginxDir}" -WindowStyle Hidden`;
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
  const logPath = isWindows
    ? path.join(nginxDir, 'logs', 'error.log')
    : '/var/log/nginx/error.log';
  const logCmd = isWindows
    ? `Get-Content -Tail 20 "${logPath}" -ErrorAction SilentlyContinue`
    : `tail -n 20 "${logPath}" 2>/dev/null`;
  const logResult = await run(logCmd);

  return {
    success: false,
    output: 'nginx did not start\n\n' + (logResult.success ? logResult.stdout : '(no error log)'),
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
