import express from 'express';
import UpdateController from '../controllers/updateController.js';
import { requireAuth } from '../lib/requireAuth.js';

const router = express.Router();
const controller = new UpdateController();

/**
 * Updating the dashboard's own code is a local operator action, so it sits
 * behind the same session gate as the rest of the dashboard.
 */
router.use(requireAuth);

router.get('/update', (req, res, next) => controller.check(req, res, next));
router.get('/update/status', (req, res, next) => controller.getStatus(req, res, next));
router.post('/update', (req, res, next) => controller.start(req, res, next));

export default router;
