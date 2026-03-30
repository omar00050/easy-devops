import express from 'express';
import {
  getStatus,
  reload,
  restart,
  start,
  stop,
  test,
  listConfigs,
  getConfig,
  saveConfig,
  getLogs,
  NginxNotFoundError,
  NginxConfigError,
  InvalidFilenameError,
} from '../lib/nginx-service.js';

const router = express.Router();

// ─── Error Handler Helper ─────────────────────────────────────────────────────

function handleError(err, res) {
  if (err instanceof NginxNotFoundError) {
    return res.status(503).json({ error: 'nginx not installed' });
  }
  if (err instanceof NginxConfigError) {
    return res.status(400).json({ success: false, output: err.output });
  }
  if (err instanceof InvalidFilenameError) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  if (err.code === 'ENOENT') {
    return res.status(404).json({ error: 'Config file not found' });
  }
  return res.status(500).json({ error: 'Internal server error' });
}

// ─── US1: GET /api/nginx/status ───────────────────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const status = await getStatus();
    res.json(status);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── US2: POST /api/nginx/reload ─────────────────────────────────────────────

router.post('/reload', async (req, res) => {
  try {
    const result = await reload();
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── US2: POST /api/nginx/restart ────────────────────────────────────────────

router.post('/restart', async (req, res) => {
  try {
    const result = await restart();
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── US1: POST /api/nginx/start ──────────────────────────────────────────────

router.post('/start', async (req, res) => {
  try {
    const result = await start();
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── US1: POST /api/nginx/stop ───────────────────────────────────────────────

router.post('/stop', async (req, res) => {
  try {
    const result = await stop();
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── US3: POST /api/nginx/test ───────────────────────────────────────────────

router.post('/test', async (req, res) => {
  try {
    const result = await test();
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── US4: GET /api/nginx/configs ─────────────────────────────────────────────

router.get('/configs', async (req, res) => {
  try {
    const configs = await listConfigs();
    res.json(configs);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── US4: GET /api/nginx/config/:filename ────────────────────────────────────

router.get('/config/:filename', async (req, res) => {
  try {
    const result = await getConfig(req.params.filename);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── US4: POST /api/nginx/config/:filename ───────────────────────────────────

router.post('/config/:filename', async (req, res) => {
  if (typeof req.body.content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  try {
    const result = await saveConfig(req.params.filename, req.body.content);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── US5: GET /api/nginx/logs ────────────────────────────────────────────────

router.get('/logs', async (req, res) => {
  try {
    const result = await getLogs(100);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
