import express from 'express';
import { loadConfig, saveConfig } from '../../core/config.js';

const router = express.Router();

// ─── GET /api/settings ─────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  try {
    const config = loadConfig();
    // Never return the password (write-only field)
    const { dashboardPort, nginxDir, certbotDir } = config;
    res.json({
      dashboardPort,
      nginxDir,
      certbotDir,
      platform: process.platform === 'win32' ? 'win32' : 'linux',
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/settings ────────────────────────────────────────────────────

router.post('/settings', (req, res) => {
  try {
    const { dashboardPort, dashboardPassword, nginxDir, certbotDir } = req.body;

    // Validate port if provided
    if (dashboardPort !== undefined) {
      const port = parseInt(dashboardPort, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: 'Invalid port number' });
      }
    }

    // Validate password if provided
    if (dashboardPassword !== undefined && typeof dashboardPassword !== 'string') {
      return res.status(400).json({ error: 'Password must be a string' });
    }

    // Validate directories if provided
    if (nginxDir !== undefined && (typeof nginxDir !== 'string' || nginxDir.trim() === '')) {
      return res.status(400).json({ error: 'Nginx directory must be a non-empty string' });
    }

    if (certbotDir !== undefined && (typeof certbotDir !== 'string' || certbotDir.trim() === '')) {
      return res.status(400).json({ error: 'Certbot directory must be a non-empty string' });
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
    if (certbotDir !== undefined) {
      updates.certbotDir = certbotDir.trim();
    }

    const newConfig = { ...currentConfig, ...updates };
    saveConfig(newConfig);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
