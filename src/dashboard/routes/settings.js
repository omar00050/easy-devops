import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { loadConfig, saveConfig } from '../../core/config.js';
import { validatePort, validateEmail } from '../../core/validators.js';
import { run } from '../../core/shell.js';
import { checkPermissionsConfigured } from '../../core/permissions.js';

// Run a bash command with sudo -S (password read from stdin — no terminal needed)
function runSudoS(bashCmd, password) {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-S', 'bash', '-c', bashCmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.stdin.write(password + '\n');
    child.stdin.end();
    child.on('close', code => resolve({ success: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on('error', err => resolve({ success: false, stdout: '', stderr: err.message }));
  });
}

const router = express.Router();

// ─── GET /api/settings ─────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  try {
    const config = loadConfig();
    // Never return the password (write-only field)
    const { dashboardPort, nginxDir, sslDir, acmeEmail } = config;
    res.json({
      dashboardPort,
      nginxDir,
      sslDir,
      acmeEmail,
      platform: process.platform === 'win32' ? 'win32' : 'linux',
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/settings ────────────────────────────────────────────────────

router.post('/settings', (req, res) => {
  try {
    const { dashboardPort, dashboardPassword, nginxDir, sslDir, acmeEmail } = req.body;

    // Validate port if provided
    if (dashboardPort !== undefined) {
      const portError = validatePort(parseInt(dashboardPort, 10));
      if (portError) return res.status(400).json({ error: portError });
    }

    // Validate password if provided
    if (dashboardPassword !== undefined && typeof dashboardPassword !== 'string') {
      return res.status(400).json({ error: 'Password must be a string' });
    }

    // Validate directories if provided
    if (nginxDir !== undefined && (typeof nginxDir !== 'string' || nginxDir.trim() === '')) {
      return res.status(400).json({ error: 'Nginx directory must be a non-empty string' });
    }
    if (sslDir !== undefined && (typeof sslDir !== 'string' || sslDir.trim() === '')) {
      return res.status(400).json({ error: 'SSL directory must be a non-empty string' });
    }

    // Validate email if provided
    if (acmeEmail !== undefined) {
      const emailError = validateEmail(acmeEmail);
      if (emailError) return res.status(400).json({ error: emailError });
    }

    // Load current config and merge updates
    const currentConfig = loadConfig();
    const updates = {};

    if (dashboardPort !== undefined) {
      updates.dashboardPort = parseInt(dashboardPort, 10);
    }
    if (dashboardPassword !== undefined) {
      updates.dashboardPassword = dashboardPassword;
    }
    if (nginxDir !== undefined) {
      updates.nginxDir = nginxDir.trim();
    }
    if (sslDir !== undefined) {
      updates.sslDir = sslDir.trim();
    }
    if (acmeEmail !== undefined) {
      updates.acmeEmail = acmeEmail.trim();
    }

    const newConfig = { ...currentConfig, ...updates };
    saveConfig(newConfig);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/settings/permissions ────────────────────────────────────────────

router.get('/settings/permissions', async (req, res) => {
  if (process.platform === 'win32') return res.json({ configured: true });
  try {
    const configured = await checkPermissionsConfigured();
    res.json({ configured });
  } catch {
    res.json({ configured: false });
  }
});

// ─── POST /api/settings/permissions/setup ─────────────────────────────────────

router.post('/settings/permissions/setup', async (req, res) => {
  if (process.platform === 'win32') {
    return res.status(400).json({ error: 'Not applicable on Windows' });
  }

  const { password } = req.body ?? {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password is required' });
  }

  // Resolve nginx binary path
  const whichResult = await run('which nginx');
  if (!whichResult.success || !whichResult.stdout.trim()) {
    return res.status(500).json({ error: 'nginx not found. Is nginx installed?' });
  }
  const nginxPath = whichResult.stdout.trim().split('\n')[0].trim();
  const user = os.userInfo().username;

  // Build sudoers rules with the detected nginx path
  const sudoRules = [
    '/usr/bin/systemctl start nginx',
    '/usr/bin/systemctl stop nginx',
    '/usr/bin/systemctl reload nginx',
    '/usr/bin/systemctl restart nginx',
    '/usr/bin/systemctl',
    nginxPath,
    `${nginxPath} -t`,
    `${nginxPath} -s reload`,
    `${nginxPath} -s stop`,
    `${nginxPath} -s quit`,
    '/usr/bin/certbot',
    '/usr/bin/mkdir',
    '/usr/bin/cp',
    '/usr/bin/chmod',
    '/usr/bin/chown',
    '/usr/bin/tee',
  ].join(', ');

  const sudoersContent = `${user} ALL=(ALL) NOPASSWD: ${sudoRules}\n`;

  // Write content to a temp file (no sudo needed for /tmp)
  const tmpFile = path.join('/tmp', `easy-devops-sudoers-${Date.now()}`);
  try {
    await fs.writeFile(tmpFile, sudoersContent, { mode: 0o600 });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to write temp file', output: err.message });
  }

  // Run all setup steps in a single sudo -S invocation
  const setupCmd = [
    `mkdir -p /etc/easy-devops /var/log/easy-devops`,
    `chown ${user}:${user} /etc/easy-devops /var/log/easy-devops`,
    `chown -R ${user}:${user} /etc/nginx/conf.d 2>/dev/null || true`,
    `cp '${tmpFile}' /etc/sudoers.d/easy-devops`,
    `chmod 440 /etc/sudoers.d/easy-devops`,
  ].join(' && ');

  const result = await runSudoS(setupCmd, password);
  await fs.unlink(tmpFile).catch(() => {});

  if (!result.success) {
    const output = result.stderr || result.stdout;
    const wrongPassword = output.includes('incorrect password') || output.includes('Sorry, try again') || output.includes('3 incorrect');
    return res.status(wrongPassword ? 401 : 500).json({
      error: wrongPassword ? 'Incorrect password' : 'Setup failed',
      output,
    });
  }

  res.json({ success: true });
});

export default router;
