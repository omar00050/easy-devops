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
    os: 'linux',
  },
  win32: {
    nginxDir: 'C:\\nginx',
    sslDir: 'C:\\easy-devops\\ssl',
    dashboardPort: 6443,
    dashboardPassword: '',
    dashboardPasswordHash: '',
    dashboardAuth: AUTH_MODES.PASSWORD,
    // Windows installs are typically a workstation behind a firewall, and
    // binding to loopback there would break the common "reach it from my
    // laptop" setup without warning.
    dashboardBindAddress: BIND_ALL,
    dashboardUi: UI_MODES.NEW,
    dashboardUiMigrated: true,
    acmeEmail: '',
    acmeChallengePort: 8089,
    sslChallengeMode: 'auto',
    acmeStaging: false,
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

    // An EXISTING install predates the bind setting, and was therefore
    // listening on every interface. Merging the new default would silently
    // move it to loopback on upgrade and cut off anyone reaching the
    // dashboard over the network — so the old behaviour is preserved and
    // written down explicitly, leaving the choice to the user.
    if (stored.dashboardBindAddress === undefined) {
      merged.dashboardBindAddress = BIND_ALL;
      migrated = true;
    }

    // An EXISTING install predates the auth setting too. An empty password
    // used to mean "no login", and for a loopback-bound dashboard that is a
    // legitimate choice, so it is preserved as an explicit 'none'. With a
    // bind that is reachable from the network it is not: those installs get
    // 'password' and are asked to set one, because the old behaviour there
    // was an exposed dashboard anyone could open.
    if (stored.dashboardAuth === undefined) {
      merged.dashboardAuth =
        !hasStoredPassword(stored) && isLoopbackBind(merged.dashboardBindAddress)
          ? AUTH_MODES.NONE
          : AUTH_MODES.PASSWORD;
      migrated = true;
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
    return merged;
  }

  // Fresh install: the platform defaults above apply.
  const config = { ...defaultConfig };
  saveConfig(config);
  return config;
}

export function saveConfig(config) {
  dbSet('config', config);
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
