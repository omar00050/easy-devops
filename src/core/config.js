import os from 'os';
import { dbGet, dbSet } from './db.js';

const platform = os.platform();

/** Accept connections from anywhere. What every install did before v1.3. */
export const BIND_ALL = '0.0.0.0';
/** Accept connections from this machine only. */
export const BIND_LOOPBACK = '127.0.0.1';
/** IPv6 loopback, accepted wherever BIND_LOOPBACK is. */
export const BIND_LOOPBACK_V6 = '::1';

/**
 * How the dashboard authenticates.
 *
 *   password — a password is required (the default)
 *   none     — no login at all, allowed ONLY on a loopback-bound dashboard
 *
 * "none" is a deliberate, narrow option for a single-user machine where the
 * dashboard is not reachable from the network. It is not a way to run an
 * exposed dashboard without a password: see isNoAuthAllowed().
 */
export const AUTH_MODES = Object.freeze({
  PASSWORD: 'password',
  NONE: 'none',
});

/**
 * Which dashboard UI the server serves at `/`.
 *
 *   new     — the built React app in dist/ui. THE default.
 *   classic — the EJS + Vue page in src/dashboard/views. A temporary fallback,
 *             for an operator who hits a regression in the new UI and needs a
 *             working dashboard immediately.
 *
 * `--classic-ui` overrides this for one run; the setting is what a background
 * service reads. A missing dist/ui build falls back to classic with the build
 * command printed, so the dashboard always starts. See dashboard/server.js.
 */
export const UI_MODES = Object.freeze({
  CLASSIC: 'classic',
  NEW: 'new',
});

/**
 * True when a bind address only accepts connections from this machine.
 * @param {string} addr
 * @returns {boolean}
 */
export function isLoopbackBind(addr) {
  return addr === BIND_LOOPBACK || addr === BIND_LOOPBACK_V6;
}

/**
 * True when "no password" is permissible for this configuration.
 *
 * The single rule that makes the option safe: with no login, the only thing
 * standing between the dashboard and the network is the listener itself, so
 * the listener must not be on the network.
 *
 * @param {{ dashboardBindAddress?: string }} config
 * @returns {boolean}
 */
export function isNoAuthAllowed(config) {
  return isLoopbackBind(config?.dashboardBindAddress);
}

const DEFAULTS = {
  linux: {
    nginxDir: '/etc/nginx',
    sslDir: '/etc/easy-devops/ssl',
    dashboardPort: 6443,
    dashboardPassword: '',
    dashboardPasswordHash: '',
    dashboardAuth: AUTH_MODES.PASSWORD,
    // A Linux box is usually a server with a public address, and the
    // dashboard can now run 24/7, so a new install listens on loopback only
    // until the user decides otherwise.
    dashboardBindAddress: BIND_LOOPBACK,
    dashboardUi: UI_MODES.NEW,
    dashboardUiMigrated: true,
    acmeEmail: '',
    acmeChallengePort: 8089,
    sslChallengeMode: 'auto',
    acmeStaging: false,
    // Renew HTTP-01 certificates in the background once they are this close
    // to expiry. See core/cert-renewal.js.
    sslAutoRenew: true,
    sslAutoRenewDays: 7,
    // The deploy hook: a small listener GitHub Actions can call to trigger a
    // deployment. Off until the user turns it on. See core/deploy/hookServer.js.
    deployHook: { enabled: false, port: 6445, bind: BIND_LOOPBACK, domain: null },
    // Folder NEW deployed apps are created in. null = <data dir>/ez_deploys.
    deployDir: null,
    os: 'linux',
  },
  win32: {
    nginxDir: 'C:\\nginx',
    sslDir: 'C:\\easy-devops\\ssl',
    dashboardPort: 6443,
    dashboardPassword: '',
    dashboardPasswordHash: '',
    dashboardAuth: AUTH_MODES.PASSWORD,
    // The dashboard itself is HTTP. A Windows install therefore listens on
    // loopback and reaches other machines only through a local HTTPS reverse
    // proxy or authenticated tunnel.
    dashboardBindAddress: BIND_LOOPBACK,
    dashboardUi: UI_MODES.NEW,
    dashboardUiMigrated: true,
    acmeEmail: '',
    acmeChallengePort: 8089,
    sslChallengeMode: 'auto',
    acmeStaging: false,
    sslAutoRenew: true,
    sslAutoRenewDays: 7,
    // The deploy hook: a small listener GitHub Actions can call to trigger a
    // deployment. Off until the user turns it on. See core/deploy/hookServer.js.
    deployHook: { enabled: false, port: 6445, bind: BIND_LOOPBACK, domain: null },
    // Folder NEW deployed apps are created in. null = <data dir>/ez_deploys.
    deployDir: null,
    os: 'win32',
  },
};

const defaultConfig = DEFAULTS[platform] ?? DEFAULTS.linux;

/** True when either form of a password is stored. */
function hasStoredPassword(config) {
  return Boolean(config?.dashboardPasswordHash || config?.dashboardPassword);
}

export function loadConfig() {
  const stored = dbGet('config');

  if (stored) {
    const merged = { ...defaultConfig, ...stored };
    let migrated = false;
    const storedBindWasMissing = stored.dashboardBindAddress === undefined;
    const storedBindWasPublic = storedBindWasMissing || !isLoopbackBind(stored.dashboardBindAddress);
    let authMigration = null;

    // Earlier releases allowed the plain-HTTP dashboard on every interface.
    // That sent session cookies and API traffic in cleartext. Keep the setting
    // field for API/backup compatibility, but fail closed to loopback. Remote
    // use is supported through a local HTTPS reverse proxy or secure tunnel.
    if (!isLoopbackBind(merged.dashboardBindAddress)) {
      merged.dashboardBindAddress = BIND_LOOPBACK;
      migrated = true;
    }

    // An existing install predates the auth setting too. The absence of a bind
    // meant the old public default, so normalising it to loopback must not turn
    // an empty password into a safe-looking passwordless installation. Only an
    // install explicitly bound to loopback may keep the legacy no-login choice.
    if (stored.dashboardAuth === undefined) {
      merged.dashboardAuth =
        !hasStoredPassword(stored) && !storedBindWasPublic
          ? AUTH_MODES.NONE
          : AUTH_MODES.PASSWORD;
      migrated = true;
      authMigration = storedBindWasPublic ? 'legacy-public-bind-requires-password' : null;
    } else if (stored.dashboardAuth === AUTH_MODES.NONE && storedBindWasPublic) {
      // A stored hand-edited/restored mismatch is the other route by which an
      // old public dashboard could become loopback plus no-password after an
      // upgrade. Normalising the address is necessary, and requiring a
      // password prevents that normalisation from weakening authentication.
      merged.dashboardAuth = AUTH_MODES.PASSWORD;
      migrated = true;
      authMigration = 'public-bind-requires-password';
    }

    // The React dashboard became the default. An existing install has
    // `classic` written down — not because anyone chose it, but because it was
    // the default and `--new-ui` was the only way to see the other one. So a
    // stored `classic` is moved to `new` exactly ONCE, recorded by
    // `dashboardUiMigrated`, and a later deliberate `classic` is then left
    // alone for ever. Without the marker, every load would undo the choice of
    // an operator who really does want the old page.
    if (merged.dashboardUi === UI_MODES.CLASSIC && !merged.dashboardUiMigrated) {
      merged.dashboardUi = UI_MODES.NEW;
      merged.dashboardUiMigrated = true;
      migrated = true;
    } else if (!merged.dashboardUiMigrated) {
      merged.dashboardUiMigrated = true;
      migrated = true;
    }

    if (migrated) saveConfig(merged);
    if (authMigration) {
      Object.defineProperty(merged, 'dashboardAuthMigration', {
        value: authMigration,
        enumerable: false,
        configurable: true,
      });
    }
    return merged;
  }

  // Fresh install: the platform defaults above apply.
  const config = { ...defaultConfig };
  saveConfig(config);
  return config;
}

export function saveConfig(config) {
  dbSet('config', {
    ...config,
    dashboardBindAddress: isLoopbackBind(config?.dashboardBindAddress)
      ? config.dashboardBindAddress
      : BIND_LOOPBACK,
  });
}

/**
 * The auth mode actually in force, which is not always the stored one.
 *
 * 'none' is only honoured while the dashboard is bound to loopback. If the
 * two ever disagree — a hand-edited database, a restored backup — the safe
 * reading wins and a password is required. The API refuses to create that
 * combination, so this is a backstop rather than a normal path.
 *
 * @param {Object} config
 * @returns {'password'|'none'}
 */
export function effectiveAuthMode(config) {
  if (config?.dashboardAuth !== AUTH_MODES.NONE) return AUTH_MODES.PASSWORD;
  return isNoAuthAllowed(config) ? AUTH_MODES.NONE : AUTH_MODES.PASSWORD;
}
