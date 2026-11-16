/**
 * The only public router.
 *
 * Everything here exists so a client can obtain a session in the first place,
 * so it cannot sit behind requireAuth. Each endpoint carries its own guard
 * instead: login is rate limited and refuses an unset password, and setup is
 * refused once a password exists.
 */
import { Router } from 'express';
import AuthController from '../controllers/authController.js';

const router = Router();
const controller = new AuthController();

router.post('/login', (req, res, next) => controller.login(req, res, next));
router.post('/setup', (req, res, next) => controller.setup(req, res, next));
router.get('/auth', (req, res, next) => controller.check(req, res, next));
router.post('/logout', (req, res, next) => controller.logout(req, res, next));

export default router;
