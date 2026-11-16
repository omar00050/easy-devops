import express from 'express';
import DeploymentsController from '../controllers/deploymentsController.js';
import { requireAuth } from '../lib/requireAuth.js';

const router = express.Router();
const controller = new DeploymentsController();

/**
 * These routes fetch code from a repository and run its build and start
 * commands on this machine. They are behind the shared session gate like
 * everything else, and that is not optional: without it, anything that can
 * reach the dashboard port could run commands here.
 *
 * The deploy hook that CI calls is NOT one of these routes. It is a separate,
 * opt-in listener with its own per-app token (core/deploy/hookServer.js), so
 * that nothing on the dashboard has to be public for a GitHub Action to work.
 */
router.use(requireAuth);

// The hook settings come first so "hook" is never read as an app id.
// (apps.js also refuses to create an app with that name.)
router.get('/hook', (req, res, next) => controller.hook(req, res, next));
router.put('/hook', (req, res, next) => controller.updateHook(req, res, next));

router.get('/', (req, res, next) => controller.list(req, res, next));
router.post('/', (req, res, next) => controller.create(req, res, next));

router.get('/:id', (req, res, next) => controller.get(req, res, next));
router.put('/:id', (req, res, next) => controller.update(req, res, next));
router.delete('/:id', (req, res, next) => controller.remove(req, res, next));

router.put('/:id/domain', (req, res, next) => controller.linkDomain(req, res, next));
router.delete('/:id/domain', (req, res, next) => controller.unlinkDomain(req, res, next));
router.post('/:id/move', (req, res, next) => controller.move(req, res, next));

router.post('/:id/deploy', (req, res, next) => controller.deploy(req, res, next));
router.post('/:id/rollback', (req, res, next) => controller.rollback(req, res, next));
router.get('/:id/runs/:runId', (req, res, next) => controller.run(req, res, next));

router.post('/:id/hook-token', (req, res, next) => controller.hookToken(req, res, next));
router.delete('/:id/hook-token', (req, res, next) => controller.revokeHookToken(req, res, next));
router.post('/:id/deploy-key', (req, res, next) => controller.deployKey(req, res, next));
router.get('/:id/github', (req, res, next) => controller.github(req, res, next));
router.post('/:id/github/apply', (req, res, next) => controller.githubApply(req, res, next));

export default router;
