// src/dashboard/routes/hub.js
import { Router } from 'express';
import {
  connectAgent,
  unlinkHub,
  hubStatus,
  updatePermissions,
} from '../controllers/hubController.js';

const router = Router();

// Auth middleware — reuse the same pattern as other routes in this project
function requireAuth(req, res, next) {
  if (req.session.authenticated === true) {
    return next();
  } else {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

router.use(requireAuth);

// The hub generates connection strings; this server only consumes them.
router.post('/connect', connectAgent);
router.delete('/link', unlinkHub);
router.get('/status', hubStatus);
router.put('/permissions', updatePermissions);

export default router;
