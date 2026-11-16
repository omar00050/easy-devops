import express from 'express';
import DomainsController from '../controllers/domainsController.js';
import { requireAuth } from '../lib/requireAuth.js';

const router = express.Router();
const controller = new DomainsController();

/**
 * Every route below requires a dashboard session. See lib/requireAuth.js —
 * this is the single gate, and removing it exposes these endpoints to anyone
 * who can reach the dashboard port.
 */
router.use(requireAuth);


router.get('/', (req, res, next) => controller.list(req, res, next));
router.post('/', (req, res, next) => controller.create(req, res, next));
router.put('/:name', (req, res, next) => controller.update(req, res, next));
router.delete('/:name', (req, res, next) => controller.delete(req, res, next));
router.put('/:name/toggle', (req, res, next) => controller.toggle(req, res, next));
router.post('/:name/reload', (req, res, next) => controller.reload(req, res, next));
router.get('/:name/notifications', (req, res, next) => controller.getNotifications(req, res, next));
router.put('/:name/notifications', (req, res, next) => controller.updateNotifications(req, res, next));

export default router;
