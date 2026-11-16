/**
 * dashboard/controllers/authController.js
 *
 * Login, logout, the session check, and the first-run choice between setting
 * a password and running without one.
 *
 * Rules worth stating, because each replaces something weaker:
 *
 *   1. An EMPTY password is never a valid login. It used to be:
 *      `password === dashboardPassword` with both empty meant anyone could
 *      sign in by leaving the box blank.
 *   2. "No password" is now an explicit setting (dashboardAuth: 'none'), and
 *      only offered when the dashboard is bound to loopback AND the request
 *      asking for it came from this machine. An exposed dashboard can never
 *      reach that state.
 *   3. Passwords are stored as scrypt hashes (core/passwords.js). An existing
 *      plain-text password still works, and is migrated on the next login.
 *   4. Login is rate limited per IP.
 *   5. First-run setup requires a one-time code printed on the server
 *      (core/setupCode.js). This endpoint is public by necessity, so without
 *      it whoever reaches a freshly started dashboard first owns it. The code
 *      itself is never in a response — a client learns only whether one is
 *      required.
 */

import {
  loadConfig,
  saveConfig,
  AUTH_MODES,
  isNoAuthAllowed,
  effectiveAuthMode,
} from '../../core/config.js';
import {
  verifyPassword,
  hashPassword,
  needsMigration,
  validateNewPassword,
  MIN_PASSWORD_LENGTH,
} from '../../core/passwords.js';
import { isLoopbackAddress } from '../lib/localRequest.js';
import { recordAttempt, clearAttempts } from '../lib/loginRateLimit.js';
import * as setupCode from '../../core/setupCode.js';

/**
 * The password currently in force, whatever form it is stored in.
 * @param {Object} config
 * @returns {string} '' when no password has been set
 */
function storedSecret(config) {
  if (typeof config.dashboardPasswordHash === 'string' && config.dashboardPasswordHash) {
    return config.dashboardPasswordHash;
  }
  if (typeof config.dashboardPassword === 'string' && config.dashboardPassword) {
    return config.dashboardPassword;
  }
  return '';
}

/** True when a password is required but none has been set yet. */
function needsSetup(config) {
  return effectiveAuthMode(config) === AUTH_MODES.PASSWORD && storedSecret(config) === '';
}

/**
 * Whether this request may choose "no password".
 *
 * Both halves are required. The bind address is the security property; the
 * request's own origin is what makes "this machine only" true for the person
 * actually clicking the button, rather than for someone who tunnelled in.
 *
 * @param {import('express').Request} req
 * @param {Object} config
 * @returns {boolean}
 */
function canUseNoPassword(req, config) {
  return isNoAuthAllowed(config) && isLoopbackAddress(req.ip ?? req.socket?.remoteAddress);
}

class AuthController {
  /**
   * POST /api/login
   */
  async login(req, res) {
    const config = loadConfig();

    // Nothing to log into. Say so plainly rather than failing a password
    // check that does not apply.
    if (effectiveAuthMode(config) === AUTH_MODES.NONE) {
      return res.status(409).json({
        ok: false,
        error: 'This dashboard is configured without a password.',
        authMode: AUTH_MODES.NONE,
      });
    }

    // Counted before the password is looked at, so a wrong guess and a guess
    // against an unset password cost the attacker the same.
    const limit = recordAttempt(req);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json({
        ok: false,
        error: 'Too many login attempts. Try again later.',
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const { password } = req.body ?? {};

    // No password set: there is nothing to log in against. Refuse, and tell
    // the client to run setup rather than letting a blank password through.
    if (needsSetup(config)) {
      return res.status(401).json({
        ok: false,
        error: 'No dashboard password is set. Set one to continue.',
        needsSetup: true,
      });
    }

    if (typeof password !== 'string' || password.length === 0) {
      return res.status(401).json({ ok: false, error: 'Invalid password' });
    }

    const secret = storedSecret(config);
    const ok = await verifyPassword(password, secret);

    if (!ok) {
      return res.status(401).json({ ok: false, error: 'Invalid password' });
    }

    // Upgrade a legacy plain-text password (or a weaker hash) now that we
    // have the cleartext in hand and know it is correct.
    if (needsMigration(secret)) {
      try {
        const hashed = await hashPassword(password);
        saveConfig({
          ...loadConfig(),
          dashboardPasswordHash: hashed,
          // Clear the plain-text copy so it stops being readable at rest.
          dashboardPassword: '',
        });
      } catch (err) {
        // A failed migration must not block a valid login; the next one
        // retries.
        console.error('[auth] could not migrate the stored password:', err.message);
      }
    }

    // Prevents session fixation: a session id that an attacker planted before
    // login must not become an authenticated one.
    return req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ ok: false, error: 'Could not start a session' });
      }
      req.session.authenticated = true;
      clearAttempts(req);
      return res.json({ ok: true });
    });
  }

  /**
   * GET /api/auth
   * Public: the page needs it to decide between the login form, the first-run
   * screen, and the dashboard itself.
   */
  check(req, res) {
    const config = loadConfig();
    const mode = effectiveAuthMode(config);

    // Whether a code is needed, and when it stops being valid. NEVER the code:
    // see the "never leaves the machine" note in core/setupCode.js.
    const code = setupCode.publicState();

    res.json({
      // With no password configured there is nothing to authenticate, so the
      // page should render the dashboard rather than a login form.
      authenticated: mode === AUTH_MODES.NONE || req.session?.authenticated === true,
      needsSetup: needsSetup(config),
      authMode: mode,
      // Drives the second button on the first-run screen. False from a
      // non-loopback request or a network-bound dashboard, so the option is
      // never even shown where it would be unsafe.
      canUseNoPassword: canUseNoPassword(req, config),
      bindAddress: config.dashboardBindAddress,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      // Only meaningful while needsSetup is true; false otherwise so a client
      // cannot read anything into it after setup is done.
      setupCodeRequired: needsSetup(config) && code.required,
      setupCodeExpiresAt: needsSetup(config) ? code.expiresAt : null,
    });
  }

  /**
   * POST /api/setup
   * First run only. Body is either:
   *   { password: '…' }            set a password (mode defaults to password)
   *   { mode: 'none' }             run without one
   *
   * Refused once the dashboard is already configured, so it can never be used
   * to take over an installation — changing either setting afterwards
   * requires being signed in and goes through Settings.
   *
   * Setting a password also requires the one-time setup code printed on the
   * server. `mode: 'none'` does not: that path is already restricted to a
   * loopback bind AND a loopback request, which is a stronger constraint than
   * the code provides.
   */
  async setup(req, res) {
    const config = loadConfig();

    // "Already configured" means a password is set, or 'none' was chosen.
    const configured =
      effectiveAuthMode(config) === AUTH_MODES.NONE || storedSecret(config) !== '';
    if (configured) {
      return res.status(409).json({
        ok: false,
        error: 'This dashboard is already configured. Sign in, then change it in Settings.',
      });
    }

    const { mode, password, setupCode: submittedCode } = req.body ?? {};

    if (mode === AUTH_MODES.NONE) {
      if (!canUseNoPassword(req, config)) {
        return res.status(400).json({
          ok: false,
          error: isNoAuthAllowed(config)
            ? 'Running without a password can only be chosen from this machine.'
            : `Running without a password requires the dashboard to listen on this machine only (currently ${config.dashboardBindAddress}).`,
        });
      }

      saveConfig({ ...loadConfig(), dashboardAuth: AUTH_MODES.NONE });
      return res.json({ ok: true, authMode: AUTH_MODES.NONE });
    }

    // Counted before the password is validated, and in its own budget: a
    // guess against the code must cost the same whatever else is wrong with
    // the request, and must not consume the login budget.
    const limit = recordAttempt(req, Date.now(), 'setup');
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json({
        ok: false,
        error: 'Too many setup attempts. Try again later.',
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    if (setupCode.required()) {
      const checked = await setupCode.verify(submittedCode);
      if (!checked.ok) {
        // One message for missing, wrong and malformed, so a probe cannot tell
        // "no code was sent" from "that code was wrong". Expired and burned
        // are told apart, because the user has to be told what to do next.
        const message = checked.reason === 'expired'
          ? 'That setup code has expired. Issue a new one on the server: ezz dashboard setup-code'
          : checked.burned
            ? 'Too many incorrect setup codes. Issue a new one on the server: ezz dashboard setup-code'
            : 'That setup code is not valid.';

        if (checked.burned) {
          console.error(
            '[auth] the first-run setup code was invalidated after '
            + `${checked.failures} failed attempts. Issue a new one with: ezz dashboard setup-code`,
          );
        }

        return res.status(400).json({ ok: false, error: message });
      }
    }

    const problem = validateNewPassword(password);
    if (problem) {
      return res.status(400).json({ ok: false, error: problem });
    }

    try {
      const hashed = await hashPassword(password);
      saveConfig({
        ...loadConfig(),
        dashboardAuth: AUTH_MODES.PASSWORD,
        dashboardPasswordHash: hashed,
        dashboardPassword: '',
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'Could not save the password' });
    }

    // Setup is done, so the code has no further purpose. Removed rather than
    // left to expire: an outstanding credential nobody needs is one more thing
    // that can be read.
    setupCode.clear();

    // Sign the user straight in: they have just proven they can set it.
    return req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ ok: false, error: 'Could not start a session' });
      }
      req.session.authenticated = true;
      clearAttempts(req);
      clearAttempts(req, 'setup');
      return res.json({ ok: true, authMode: AUTH_MODES.PASSWORD });
    });
  }

  /**
   * POST /api/logout
   */
  logout(req, res) {
    if (!req.session) return res.json({ ok: true });
    req.session.destroy(() => res.json({ ok: true }));
  }
}

export default AuthController;
