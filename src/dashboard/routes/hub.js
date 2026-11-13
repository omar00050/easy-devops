// src/dashboard/routes/hub.js
import { Router } from 'express';
import {
  connectAgent,
  unlinkHub,
  hubStatus,
  updatePermissions,
} from '../controllers/hubController.js';
import { requireAuth } from '../lib/requireAuth.js';

const router = Router();

// The shared gate — see lib/requireAuth.js.
router.use(requireAuth);

// The hub generates connection strings; this server only consumes them.
router.post('/connect', connectAgent);
router.delete('/link', unlinkHub);
router.get('/status', hubStatus);
router.put('/permissions', updatePermissions);

export default router;
