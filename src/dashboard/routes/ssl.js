import express from 'express';
import SslController from '../controllers/sslController.js';
import { requireAuth } from '../lib/requireAuth.js';

const router = express.Router();
const controller = new SslController();

/**
 * Every route below requires a dashboard session. See lib/requireAuth.js —
 * this is the single gate, and removing it exposes these endpoints to anyone
 * who can reach the dashboard port.
 */
router.use(requireAuth);


router.post('/create', (req, res, next) => controller.create(req, res, next));
router.post('/create-confirm', (req, res, next) => controller.createConfirm(req, res, next));
router.post('/create-cancel', (req, res, next) => controller.createCancel(req, res, next));
router.get('/', (req, res, next) => controller.list(req, res, next));
router.post('/renew/:domain', (req, res, next) => controller.renew(req, res, next));
router.post('/renew-all', (req, res, next) => controller.renewAll(req, res, next));
router.delete('/:domain', (req, res, next) => controller.remove(req, res, next));

export default router;
