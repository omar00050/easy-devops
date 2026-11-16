import express from 'express';
import SettingsController from '../controllers/settingsController.js';
import { requireAuth } from '../lib/requireAuth.js';

const router = express.Router();
const controller = new SettingsController();

/**
 * Every route below requires a dashboard session. See lib/requireAuth.js —
 * this is the single gate, and removing it exposes these endpoints to anyone
 * who can reach the dashboard port.
 */
router.use(requireAuth);


router.get('/settings', (req, res, next) => controller.get(req, res, next));
router.post('/settings', (req, res, next) => controller.update(req, res, next));
router.get('/settings/permissions', (req, res, next) => controller.getPermissions(req, res, next));
router.post('/settings/permissions/setup', (req, res, next) => controller.setupPermissions(req, res, next));
router.get('/settings/backup', (req, res, next) => controller.backup(req, res, next));
router.post('/settings/restore', (req, res, next) => controller.restore(req, res, next));

// Notification channel CRUD
router.get('/settings/channels', (req, res, next) => controller.getChannels(req, res, next));
router.post('/settings/channels', (req, res, next) => controller.createChannel(req, res, next));
router.put('/settings/channels/:id', (req, res, next) => controller.updateChannel(req, res, next));
router.delete('/settings/channels/:id', (req, res, next) => controller.deleteChannel(req, res, next));
router.post('/settings/channels/:id/test', (req, res, next) => controller.testChannel(req, res, next));

export default router;
