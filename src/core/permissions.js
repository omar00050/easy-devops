import { runInteractive, run } from './shell.js';
import os from 'os';

async function findNginxPath() {
  const result = await run('which nginx');
  if (result.success && result.stdout.trim()) {
    return result.stdout.trim().split('\n')[0].trim();
  }
  throw new Error('nginx not found. Is nginx installed?');
}

export async function checkPermissionsConfigured() {
  const result = await run('sudo -n /usr/bin/systemctl status nginx 2>/dev/null');
  return result.success || !result.stderr?.includes('password');
}

export async function setupLinuxPermissions() {
  if (process.platform === 'win32') return { success: false, reason: 'Windows not supported' };

  const user = os.userInfo().username;

  let nginxPath;
  try {
    nginxPath = await findNginxPath();
  } catch (err) {
    return { success: false, reason: err.message };
  }

  // Step 1: authenticate sudo
  const auth = await runInteractive('sudo -v');
  if (!auth.success) return { success: false, reason: 'sudo authentication failed' };

  // Step 2: create required directories and set ownership
  const dirs = ['/etc/easy-devops', '/var/log/easy-devops'];
  for (const dir of dirs) {
    const mkResult = await runInteractive(`sudo mkdir -p ${dir}`);
    if (mkResult.success) {
      await runInteractive(`sudo chown ${user}:${user} ${dir}`);
    }
  }

  // Step 3: fix nginx conf.d ownership
  await runInteractive(`sudo chown -R ${user}:${user} /etc/nginx/conf.d 2>/dev/null || true`);

  // Step 4: write sudoers file
  const SUDO_RULES = [
    '/usr/bin/systemctl start nginx',
    '/usr/bin/systemctl stop nginx',
    '/usr/bin/systemctl reload nginx',
    '/usr/bin/systemctl restart nginx',
    '/usr/bin/systemctl',
    `${nginxPath}`,
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

  const sudoersContent = `${user} ALL=(ALL) NOPASSWD: ${SUDO_RULES}`;
  const result = await runInteractive(
    `echo '${sudoersContent}' | sudo tee /etc/sudoers.d/easy-devops > /dev/null && sudo chmod 440 /etc/sudoers.d/easy-devops`
  );

  return { success: result.success };
}
