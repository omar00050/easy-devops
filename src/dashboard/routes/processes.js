import express from 'express';
import ProcessesController from '../controllers/processesController.js';
import { requireAuth } from '../lib/requireAuth.js';

/**
 * Builds the router. `controller` is injectable so a test can prove the route
 * table and the auth gate without letting anything reach the real PM2; the
 * default export below is the one the server mounts.
 *
 * @param {ProcessesController} [controller]
 */
export function createProcessesRouter(controller = new ProcessesController()) {
  const router = express.Router();

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

  // Installing PM2, offered when the first app is created on a machine that
  // does not have it. It is not a process action and names no app, so it is
  // registered before `/processes/:name/:action`: no parameterised pattern may
  // ever be able to capture an install request.
  router.post('/pm2/install', (req, res) => controller.installPm2(req, res));

  router.get('/processes', (req, res) => controller.list(req, res));
  router.get('/processes/:name/logs', (req, res) => controller.logs(req, res));
  router.post('/processes/:name/:action', (req, res) => controller.action(req, res));

  return router;
}

export default createProcessesRouter();
