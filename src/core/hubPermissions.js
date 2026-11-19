/**
 * core/hubPermissions.js
 *
 * The catalog of things a paired Hub may ask this server to do.
 *
 * This file is the single source of truth. The dashboard renders the tree from
 * it, the agent re-checks every incoming command against it, and the Hub only
 * ever receives a copy. Nothing here is advisory: the local check in
 * hubAgent.js is the real security gate, so a Hub that sends a command for a
 * permission that is off gets nothing done.
 *
 * Monitoring is deliberately NOT in this catalog. Metrics, nginx status, the
 * domain list, domain health and certificate expiry are always reported — a
 * paired server is a monitored server, and gating read-only telemetry would
 * make the Hub useless without protecting anything.
 *
 * Storage: a flat object of { 'group.child': boolean } under the
 * 'hub-permissions' key. Group ids are never stored; a group is derived from
 * its children so the two can never disagree.
 */

/**
 * @typedef {Object} PermissionLeaf
 * @property {string} id            Stored id, 'group.child'
 * @property {string} label         Short UI label
 * @property {string} description   One line explaining the effect
 * @property {boolean} [comingSoon] Shown in the tree but cannot be enabled
 */

/**
 * @typedef {Object} PermissionGroup
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {PermissionLeaf[]} children
 */

/** @type {PermissionGroup[]} */
export const PERMISSION_TREE = Object.freeze([
  {
    id: 'nginx',
    label: 'Nginx',
    description: 'Control the nginx service and its configuration files.',
    children: [
      { id: 'nginx.start', label: 'Start', description: 'Start nginx when it is stopped.' },
      { id: 'nginx.stop', label: 'Stop', description: 'Stop nginx. Your sites go offline until it is started again.' },
      { id: 'nginx.restart', label: 'Restart', description: 'Full restart. Briefly drops connections.' },
      { id: 'nginx.reload', label: 'Reload', description: 'Graceful reload. Picks up config changes without dropping connections.' },
      { id: 'nginx.test', label: 'Test config', description: 'Run nginx -t. Read-only, changes nothing.' },
      { id: 'nginx.config.view', label: 'View configs', description: 'Read the generated nginx config files.' },
      { id: 'nginx.config.edit', label: 'Edit configs', description: 'Edit a config file. Always tested before it is kept, and rolled back if nginx rejects it.' },
      { id: 'nginx.logs.view', label: 'View logs', description: 'Read recent nginx access and error log lines.' },
    ],
  },
  {
    id: 'domains',
    label: 'Domains',
    description: 'Manage reverse proxy domains and their nginx configs.',
    children: [
      { id: 'domains.create', label: 'Create', description: 'Add a new domain and generate its nginx config.' },
      { id: 'domains.edit', label: 'Edit', description: 'Change an existing domain and regenerate its config.' },
      { id: 'domains.toggle', label: 'Enable / disable', description: 'Take a domain in or out of service without deleting it.' },
      { id: 'domains.delete', label: 'Delete', description: 'Remove a domain and its nginx config.' },
    ],
  },
  {
    id: 'ssl',
    label: 'SSL certificates',
    description: 'Issue, renew and remove Let’s Encrypt certificates.',
    children: [
      { id: 'ssl.renew', label: 'Renew one', description: 'Renew a single certificate. nginx keeps running.' },
      { id: 'ssl.renewAll', label: 'Renew all expiring', description: 'Renew every certificate expiring within 30 days.' },
      { id: 'ssl.issue', label: 'Issue new', description: 'Request a new certificate over HTTP-01. nginx keeps running.' },
      { id: 'ssl.delete', label: 'Delete', description: 'Delete certificate files. Refused while an enabled domain still uses them.' },
      {
        id: 'ssl.issueDns',
        label: 'Issue wildcard (DNS-01)',
        description: 'Wildcard certificates need a DNS TXT record you add by hand, so they cannot be driven from the Hub yet.',
        comingSoon: true,
      },
    ],
  },
  {
    id: 'deploy',
    label: 'Deployments',
    description: 'Deploy the apps on this server from the Hub. Fetching code and running its commands happens here, with this server’s own settings.',
    children: [
      { id: 'deploy.run', label: 'Deploy', description: 'Start a deployment of an existing app from its configured repository.' },
      { id: 'deploy.rollback', label: 'Roll back', description: 'Switch an app back to an earlier release that is still on this server.' },
      { id: 'deploy.logs', label: 'View deployment logs', description: 'Read the output of a deployment. Build output can contain whatever the build prints.' },
      { id: 'deploy.manage', label: 'Create, edit and delete apps', description: 'Add an app from a repository, change its settings, issue its deploy token, or remove it. This decides which code runs here.' },
      { id: 'deploy.env', label: 'Read and edit environment variables', description: 'See and change an app’s environment values. They pass through the Hub while being edited and are not stored there.' },
      { id: 'deploy.ci', label: 'Deploy from CI through the Hub', description: 'Let a GitHub Action trigger a deployment by calling the Hub with the app’s own deploy token, so this server needs no inbound port.' },
    ],
  },
  {
    id: 'process',
    label: 'Processes',
    description: 'Control the PM2 processes on this server. Easy DevOps itself runs as a background service, not a PM2 app, so it cannot be controlled from here.',
    children: [
      {
        id: 'process.start',
        label: 'Start',
        description: 'Start a stopped PM2 process from the Hub.',
      },
      {
        id: 'process.stop',
        label: 'Stop',
        description: 'Stop a running PM2 process from the Hub.',
      },
      {
        id: 'process.restart',
        label: 'Restart',
        description: 'Restart a PM2 process from the Hub.',
      },
    ],
  },
  {
    id: 'system',
    label: 'System',
    description: 'Server-level operations beyond nginx.',
    children: [
      {
        id: 'system.nodeVersions',
        label: 'Manage Node.js versions',
        description: 'Install and switch Node.js versions through nvm.',
        comingSoon: true,
      },
      {
        id: 'system.restartServer',
        label: 'Reboot the server',
        description: 'Reboot the whole machine.',
        comingSoon: true,
      },
    ],
  },
]);

/** Every leaf id, including the ones marked comingSoon. */
export const ALL_PERMISSION_IDS = Object.freeze(
  PERMISSION_TREE.flatMap((g) => g.children.map((c) => c.id))
);

/** Leaf ids that can actually be enabled today. */
export const GRANTABLE_PERMISSION_IDS = Object.freeze(
  PERMISSION_TREE.flatMap((g) => g.children.filter((c) => !c.comingSoon).map((c) => c.id))
);

/** Leaf ids that exist in the tree but cannot be enabled yet. */
export const COMING_SOON_PERMISSION_IDS = Object.freeze(
  PERMISSION_TREE.flatMap((g) => g.children.filter((c) => c.comingSoon).map((c) => c.id))
);

/** @returns {boolean} True when `id` is a real leaf in the catalog. */
export function isKnownPermission(id) {
  return ALL_PERMISSION_IDS.includes(id);
}

/** @returns {boolean} True when `id` exists but is not grantable yet. */
export function isComingSoon(id) {
  return COMING_SOON_PERMISSION_IDS.includes(id);
}

/** A fully-denied permission map — the state every new link starts in. */
export function defaultPermissions() {
  const out = {};
  for (const id of ALL_PERMISSION_IDS) out[id] = false;
  return out;
}

/**
 * Normalises any stored shape into a complete, valid permission map.
 *
 * Unknown keys are dropped and comingSoon permissions are forced off, so a
 * stale or hand-edited record can never grant something the catalog does not
 * offer.
 *
 * @param {Object} stored
 * @returns {Object<string, boolean>}
 */
export function normalizePermissions(stored) {
  const out = defaultPermissions();
  if (!stored || typeof stored !== 'object') return out;

  for (const id of ALL_PERMISSION_IDS) {
    if (isComingSoon(id)) continue;           // never grantable
    if (stored[id] === true) out[id] = true;
  }
  return out;
}

/**
 * Derives a group's checkbox state from its children.
 * @param {string} groupId
 * @param {Object<string, boolean>} permissions
 * @returns {'on'|'off'|'partial'}
 */
export function groupState(groupId, permissions) {
  const group = PERMISSION_TREE.find((g) => g.id === groupId);
  if (!group) return 'off';

  // comingSoon children can never be on, so they would make a fully-granted
  // group look partial forever. They are excluded from the calculation.
  const relevant = group.children.filter((c) => !c.comingSoon);
  if (relevant.length === 0) return 'off';

  const on = relevant.filter((c) => permissions?.[c.id] === true).length;
  if (on === 0) return 'off';
  if (on === relevant.length) return 'on';
  return 'partial';
}

/**
 * Returns a copy with every grantable child of a group set on or off.
 * @param {Object<string, boolean>} permissions
 * @param {string} groupId
 * @param {boolean} enabled
 * @returns {Object<string, boolean>}
 */
export function setGroup(permissions, groupId, enabled) {
  const next = normalizePermissions(permissions);
  const group = PERMISSION_TREE.find((g) => g.id === groupId);
  if (!group) return next;

  for (const child of group.children) {
    if (child.comingSoon) continue;
    next[child.id] = Boolean(enabled);
  }
  return next;
}

/**
 * Returns a copy with one leaf set, ignoring unknown and comingSoon ids.
 * @param {Object<string, boolean>} permissions
 * @param {string} id
 * @param {boolean} enabled
 * @returns {Object<string, boolean>}
 */
export function setPermission(permissions, id, enabled) {
  const next = normalizePermissions(permissions);
  if (!isKnownPermission(id) || isComingSoon(id)) return next;
  next[id] = Boolean(enabled);
  return next;
}

// ─── Legacy migration ─────────────────────────────────────────────────────────

/**
 * The three booleans used before the tree existed.
 * Kept only so an existing link can be migrated.
 */
const LEGACY_KEYS = ['reloadNginx', 'manageDomains', 'manageSSL'];

/**
 * Permissions that were never gated before the tree existed. Existing links
 * already had these abilities in practice, so withholding them on upgrade
 * would be a silent downgrade of what the operator had working.
 */
const PREVIOUSLY_UNGATED = ['nginx.config.view', 'nginx.logs.view'];

/** @returns {boolean} True when `stored` is the pre-tree shape. */
export function isLegacyPermissions(stored) {
  if (!stored || typeof stored !== 'object') return false;
  // Already migrated if any catalog id is present.
  if (ALL_PERMISSION_IDS.some((id) => id in stored)) return false;
  return LEGACY_KEYS.some((k) => k in stored);
}

/**
 * Converts the three legacy booleans into the tree, preserving exactly what
 * the Hub could already do.
 *
 *   reloadNginx   -> nginx.start / stop / restart / reload / test
 *                    (hub:nginxAction accepted all of these under one flag)
 *   manageDomains -> every domains.*
 *   manageSSL     -> ssl.renew and ssl.renewAll only
 *                    (issue and delete are new, so they stay off)
 *
 * Plus the two previously ungated read permissions.
 *
 * @param {Object} stored
 * @returns {Object<string, boolean>}
 */
export function migrateLegacyPermissions(stored) {
  const next = defaultPermissions();
  if (!stored || typeof stored !== 'object') return next;

  if (stored.reloadNginx === true) {
    for (const id of ['nginx.start', 'nginx.stop', 'nginx.restart', 'nginx.reload', 'nginx.test']) {
      next[id] = true;
    }
  }
  if (stored.manageDomains === true) {
    for (const child of PERMISSION_TREE.find((g) => g.id === 'domains').children) {
      next[child.id] = true;
    }
  }
  if (stored.manageSSL === true) {
    next['ssl.renew'] = true;
    next['ssl.renewAll'] = true;
  }

  for (const id of PREVIOUSLY_UNGATED) next[id] = true;

  return next;
}

// ─── Command → permission mapping ─────────────────────────────────────────────

/** Own-key lookup: `map['constructor']` would otherwise hit the prototype. */
function fromMap(map, action) {
  return typeof action === 'string' && Object.prototype.hasOwnProperty.call(map, action)
    ? map[action]
    : undefined;
}

/** The SSL mode a deploy/link payload asks for, including the legacy boolean. */
function requestedSslMode(payload) {
  const ssl = payload?.ssl;
  if (ssl === true) return 'issue';
  if (ssl && typeof ssl === 'object' && !Array.isArray(ssl)) return ssl.mode ?? 'none';
  return 'none';
}

/**
 * Resolves the permission(s) a hub command payload requires.
 *
 * Usually one id. `hub:manageDeploy { action: 'linkDomain' }` needs a list:
 * every id in it must be granted, and a refusal names the first missing one.
 *
 * Returns null when the command needs no permission (read-only telemetry).
 * Returns undefined for an unknown command, so the agent can refuse it rather
 * than treat it as free.
 *
 * @param {string} command
 * @param {Object} [payload]
 * @returns {string|string[]|null|undefined}
 */
export function permissionForCommand(command, payload = {}) {
  switch (command) {
    case 'hub:reloadNginx':
      return 'nginx.reload';

    case 'hub:nginxAction': {
      const map = {
        start: 'nginx.start',
        stop: 'nginx.stop',
        restart: 'nginx.restart',
        reload: 'nginx.reload',
        test: 'nginx.test',
      };
      return fromMap(map, payload?.action);
    }

    case 'hub:manageDomain': {
      const map = {
        create: 'domains.create',
        update: 'domains.edit',
        toggle: 'domains.toggle',
        delete: 'domains.delete',
        reload: 'nginx.reload',
      };
      return fromMap(map, payload?.action);
    }

    case 'hub:manageSSL': {
      const map = {
        renew: 'ssl.renew',
        renewAll: 'ssl.renewAll',
        issue: 'ssl.issue',
        // Read-only lookup: it changes nothing, and a paired server is a
        // monitored server.
        suggest: null,
        delete: 'ssl.delete',
      };
      return fromMap(map, payload?.action);
    }

    case 'hub:manageProcess': {
      const map = {
        // PM2 "start" on an existing app is a restart, exactly as in the
        // dashboard's own processes controller.
        start: 'process.start',
        stop: 'process.stop',
        restart: 'process.restart',
      };
      return fromMap(map, payload?.action);
    }

    case 'hub:manageDeploy': {
      const action = payload?.action;

      // Linking writes a domain config, so managing an app is not enough:
      // domains.create is required too, and issuing a certificate is its own
      // permission. All of them must be granted.
      if (action === 'linkDomain') {
        const needed = ['deploy.manage', 'domains.create'];
        if (requestedSslMode(payload) === 'issue') needed.push('ssl.issue');
        return needed;
      }

      const map = {
        // Listing the apps and their status is monitoring, like the process
        // list: a paired server is a monitored server. No secrets are in it.
        list: null,
        detail: null,
        github: null,
        deploy: 'deploy.run',
        rollback: 'deploy.rollback',
        run: 'deploy.logs',
        create: 'deploy.manage',
        update: 'deploy.manage',
        delete: 'deploy.manage',
        deleteRelease: 'deploy.manage',
        issueToken: 'deploy.manage',
        regenerateKey: 'deploy.manage',
        testKey: 'deploy.manage',
        addKeyToGithub: 'deploy.manage',
        unlinkDomain: 'deploy.manage',
        move: 'deploy.manage',
        getEnv: 'deploy.env',
        setEnv: 'deploy.env',
      };
      return fromMap(map, action);
    }

    // Not dispatchable by a Hub user: only the Hub's CI endpoint sends it, and
    // the app's own deploy token is verified here, on the server.
    case 'hub:deployHook':
      return 'deploy.ci';

    case 'hub:getConfigs':
      return 'nginx.config.view';

    case 'hub:saveConfig':
      return 'nginx.config.edit';

    case 'hub:getLogs':
      return 'nginx.logs.view';

    default:
      return undefined;
  }
}

/**
 * Decides whether a command may run on this server.
 * @param {string} command
 * @param {Object} payload
 * @param {Object<string, boolean>} permissions
 * @returns {{ allowed: boolean, permission: string|string[]|null, reason: string|null }}
 */
export function checkCommandAllowed(command, payload, permissions) {
  const required = permissionForCommand(command, payload);

  if (required === undefined) {
    return { allowed: false, permission: null, reason: `Unknown command or action: ${command}` };
  }
  if (required === null) {
    return { allowed: true, permission: null, reason: null };
  }

  const needed = Array.isArray(required) ? required : [required];
  const grantedMap = normalizePermissions(permissions);

  for (const permission of needed) {
    if (isComingSoon(permission)) {
      return { allowed: false, permission, reason: `'${permission}' is not available yet.` };
    }
    if (grantedMap[permission] !== true) {
      return {
        allowed: false,
        permission,
        reason: `Permission '${permission}' is disabled on this server.`,
      };
    }
  }

  return {
    allowed: true,
    permission: required,
    reason: null,
  };
}
