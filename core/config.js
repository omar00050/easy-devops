import os from 'os';
import { dbGet, dbSet } from './db.js';

const platform = os.platform();

const DEFAULTS = {
  linux: {
    nginxDir: '/etc/nginx',
    certbotDir: '/etc/letsencrypt',
    dashboardPort: 6443,
    dashboardPassword: '',
    os: 'linux',
  },
  win32: {
    nginxDir: 'C:\\nginx',
    certbotDir: 'C:\\certbot',
    dashboardPort: 6443,
    dashboardPassword: '',
    os: 'win32',
  },
};

const defaultConfig = DEFAULTS[platform] ?? DEFAULTS.linux;

export function loadConfig() {
  const stored = dbGet('config');
  if (stored) {
    return { ...defaultConfig, ...stored };
  }
  const config = { ...defaultConfig };
  saveConfig(config);
  return config;
}

export function saveConfig(config) {
  dbSet('config', config);
}
