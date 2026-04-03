import express from 'express';
import { loadConfig, saveConfig } from '../../core/config.js';
import { validatePort, validateEmail } from '../../core/validators.js';

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

export default router;
