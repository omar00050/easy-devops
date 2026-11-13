/**
 * dashboard/lib/requireAuth.js
 *
 * The dashboard's single authentication gate, for HTTP and for Socket.io.
 *
 * Every API router mounts `requireAuth`, and every Socket.io connection goes
 * through `socketRequireAuth`. The only public endpoints are the ones needed
 * to get a session in the first place: the session check, login, logout and
 * the first-run setup.
 *
 * This matters more than it used to. The dashboard can now run 24/7 as a
 * background service, so an unprotected endpoint is not "exposed while I have
 * a terminal open" — it is exposed permanently, on every boot.
 *
 * Socket.io is covered because it is not a lesser surface: the dashboard's
 * socket streams nginx status, domain health and live log tails, and those
 * are exactly the things the HTTP routes are being protected for.
 *
 * ── dashboardAuth: 'none' ──────────────────────────────────────────────────
 *
 * A single-user machine may legitimately run without a password. That is an
 * explicit setting, not an empty password, and it is honoured ONLY while the
 * dashboard is bound to loopback — effectiveAuthMode() in core/config.js
 * decides, and falls back to requiring a password if the two ever disagree.
 *
 * Skipping the password does NOT skip lib/localRequest.js. Those checks defend
 * against other websites in the same browser, which a password never did, and
 * they are the reason "no password on loopback" is a defensible option rather
 * than an open door.
 */

import { loadConfig, AUTH_MODES, effectiveAuthMode } from '../../core/config.js';

/** Whether a password is required right now. */
function passwordRequired() {
  try {
    return effectiveAuthMode(loadConfig()) !== AUTH_MODES.NONE;
  } catch {
    // An unreadable config must not become an open dashboard.
    return true;
  }
}

/**
 * Express middleware: refuses anything without a logged-in session.
 *
 * Returns 401 with a JSON body, matching what the already-protected routers
 * returned, so the frontend has one shape to handle.
 *
 * The public endpoints are not listed here. routes/auth.js is simply not
 * mounted behind this middleware, which keeps the rule "everything except
 * that one router" visible at the mount points rather than hidden in a path
 * allowlist that could drift.
 */
export function requireAuth(req, res, next) {
  if (!passwordRequired()) return next();
  if (req.session?.authenticated === true) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Socket.io middleware: refuses a connection without a logged-in session.
 *
 * The session is attached to `socket.request` by running the express-session
 * middleware on the engine — see initSocket() in socketManager.js. Without
 * that, `socket.request.session` is undefined and every connection is
 * correctly refused rather than silently allowed.
 *
 * @param {import('socket.io').Socket} socket
 * @param {(err?: Error) => void} next
 */
export function socketRequireAuth(socket, next) {
  if (!passwordRequired()) return next();
  if (socket.request?.session?.authenticated === true) return next();

  const err = new Error('UNAUTHORIZED');
  // socket.io passes `data` through to the client's connect_error handler.
  err.data = { reason: 'unauthorized' };
  return next(err);
}
