import express from 'express';
import ProcessesController from '../controllers/processesController.js';
import { requireAuth } from '../lib/requireAuth.js';

const router = express.Router();
const controller = new ProcessesController();

/**
 * These routes can start and stop processes, so they are behind the shared
 * session gate. Do not remove it: without it, anything that can reach the
 * dashboard port could control PM2.
 */
router.use(requireAuth);

// Service status and lifecycle come first so they are not shadowed by /:name.
//
// All of them sit behind requireAuth above, exactly like every other route:
// starting and stopping the background service is as privileged as anything
// else the dashboard can do.
router.get('/service', (req, res) => controller.status(req, res));
router.post('/service/start', (req, res) => controller.start(req, res));
router.post('/service/stop', (req, res) => controller.stop(req, res));
router.post('/service/restart', (req, res) => controller.restart(req, res));

router.get('/processes', (req, res) => controller.list(req, res));
router.get('/processes/:name/logs', (req, res) => controller.logs(req, res));
router.post('/processes/:name/:action', (req, res) => controller.action(req, res));

export default router;
