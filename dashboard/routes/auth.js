import { Router } from 'express';
import { loadConfig } from '../../core/config.js';

const router = Router();

router.post('/login', (req, res) => {
  const { password } = req.body;
  const { dashboardPassword } = loadConfig();
  if (password === dashboardPassword) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Invalid password' });
  }
});

router.get('/auth', (req, res) => {
  if (req.session.authenticated === true) {
    res.json({ authenticated: true });
  } else {
    res.json({ authenticated: false });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

export default router;
