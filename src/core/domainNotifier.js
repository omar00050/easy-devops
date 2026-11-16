/**
 * Per-domain notification config storage.
 * SQLite key: 'domain_notification_config'
 *
 * Config shape per domain:
 * { nginx_down: { enabled: bool, channelIds: [uuid, ...] }, ... }
 *
 * channelIds are UUIDs referencing entries in the notification_channels key.
 * Empty channelIds means dashboard-only (no external dispatch).
 *
 * Also tracks notification state to prevent spam and support recovery notifications.
 * SQLite key: 'notification_state'
 */

import { dbGet, dbSet } from './db.js';

const DB_KEY = 'domain_notification_config';
const STATE_DB_KEY = 'notification_state';
const KNOWN_EVENT_TYPES = ['nginx_down', 'cert_expiry', 'domain_health'];

/**
 * Default notification config returned for unconfigured domains.
 * All events enabled, no external channels (dashboard-only) — opt-in model.
 */
export const DOMAIN_NOTIF_DEFAULTS = {
  nginx_down: { enabled: true, channelIds: [] },
  cert_expiry: { enabled: true, channelIds: [] },
  domain_health: { enabled: true, channelIds: [] },
};

/**
 * Validates a domain notification config object.
 * @param {object} config
 * @throws {Error} with descriptive message on invalid input
 */
function validateDomainNotifConfig(config) {
  if (typeof config !== 'object' || config === null) {
    throw new Error('Config must be a non-null object');
  }

  for (const key of Object.keys(config)) {
    if (!KNOWN_EVENT_TYPES.includes(key)) {
      throw new Error(`Invalid event type: '${key}'. Known types: ${KNOWN_EVENT_TYPES.join(', ')}`);
    }

    const entry = config[key];
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Entry for '${key}' must be an object`);
    }

    if (typeof entry.enabled !== 'boolean') {
      throw new Error(`Entry for '${key}' must have boolean 'enabled' field`);
    }

    if (!Array.isArray(entry.channelIds)) {
      throw new Error(`Entry for '${key}' must have array 'channelIds' field`);
    }

    for (const id of entry.channelIds) {
      if (typeof id !== 'string') {
        throw new Error(`channelIds in '${key}' must contain only strings`);
      }
    }
  }
}

/**
 * Returns the stored notification config for a domain, falling back to defaults.
 * @param {string} domain
 * @returns {object}
 */
export function getDomainNotifConfig(domain) {
  let map;
  try {
    map = dbGet(DB_KEY);
  } catch {
    return { ...DOMAIN_NOTIF_DEFAULTS };
  }

  if (!map || typeof map !== 'object') {
    return { ...DOMAIN_NOTIF_DEFAULTS };
  }

  return map[domain] ? { ...map[domain] } : { ...DOMAIN_NOTIF_DEFAULTS };
}

/**
 * Saves notification config for a domain.
 * @param {string} domain
 * @param {object} config
 * @throws {Error} if config is invalid
 */
export function saveDomainNotifConfig(domain, config) {
  validateDomainNotifConfig(config);

  let map = dbGet(DB_KEY);
  if (!map || typeof map !== 'object') {
    map = {};
  }

  map[domain] = config;
  dbSet(DB_KEY, map);
}

/**
 * Returns the channel IDs that should receive a given event for a domain.
 * Returns [] when the event is disabled or has no channels assigned.
 * @param {string|null} domain
 * @param {string} eventType
 * @returns {string[]}
 */
export function getEffectiveChannelIds(domain, eventType) {
  if (!KNOWN_EVENT_TYPES.includes(eventType)) {
    return [];
  }

  const config = getDomainNotifConfig(domain);
  const entry = config[eventType];

  if (!entry || !entry.enabled) {
    return [];
  }

  return Array.isArray(entry.channelIds) ? [...entry.channelIds] : [];
}

/**
 * Returns the union of channel IDs configured for a given event type across all domains.
 * Useful for global events (nginx_down) where no specific domain context exists.
 * @param {string} eventType
 * @returns {string[]}
 */
export function getAllDomainChannelIds(eventType) {
  if (!KNOWN_EVENT_TYPES.includes(eventType)) return [];

  let map;
  try {
    map = dbGet(DB_KEY);
  } catch {
    return [];
  }

  if (!map || typeof map !== 'object') return [];

  const ids = new Set();
  for (const domainConfig of Object.values(map)) {
    if (!domainConfig || typeof domainConfig !== 'object') continue;
    const entry = domainConfig[eventType];
    if (entry?.enabled && Array.isArray(entry.channelIds)) {
      for (const id of entry.channelIds) ids.add(id);
    }
  }

  return [...ids];
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION STATE TRACKING (deduplication + recovery)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * State key format: "{domain}:{eventType}" or "global:{eventType}" (for nginx_down)
 * State value: { status: 'up'|'down'|'unknown', lastNotifiedAt: timestamp, notifiedFor: 'up'|'down'|null }
 */

/**
 * Get the notification state map from database.
 * @returns {object}
 */
function getNotificationStateMap() {
  try {
    const map = dbGet(STATE_DB_KEY);
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

/**
 * Save the notification state map to database.
 * @param {object} map
 */
function saveNotificationStateMap(map) {
  dbSet(STATE_DB_KEY, map);
}

/**
 * Get notification state for a specific domain/event combination.
 * @param {string|null} domain - null for global events like nginx_down
 * @param {string} eventType
 * @returns {{ status: string, lastNotifiedAt: number|null, notifiedFor: string|null }}
 */
export function getNotificationState(domain, eventType) {
  const key = domain ? `${domain}:${eventType}` : `global:${eventType}`;
  const map = getNotificationStateMap();
  return map[key] || { status: 'unknown', lastNotifiedAt: null, notifiedFor: null };
}

/**
 * Set notification state for a specific domain/event combination.
 * @param {string|null} domain - null for global events
 * @param {string} eventType
 * @param {object} state - { status, lastNotifiedAt, notifiedFor }
 */
export function setNotificationState(domain, eventType, state) {
  const key = domain ? `${domain}:${eventType}` : `global:${eventType}`;
  const map = getNotificationStateMap();
  map[key] = {
    status: state.status || 'unknown',
    lastNotifiedAt: state.lastNotifiedAt || null,
    notifiedFor: state.notifiedFor || null,
  };
  saveNotificationStateMap(map);
}

/**
 * Result of checking if a notification should be sent.
 * @typedef {Object} NotificationDecision
 * @property {boolean} shouldNotify - Whether to send a notification
 * @property {string|null} reason - Why (e.g., 'state_changed', 'recovery', 'no_change')
 * @property {string} currentStatus - The new status ('up' or 'down')
 * @property {string|null} previousNotifiedFor - What we previously notified about
 * @property {Object|null} nextState - The state to record once the send succeeds
 */

/**
 * Decides whether a transition is worth notifying about.
 *
 * PURE: this records nothing. It used to write "notified" to the database
 * before the notification was sent, which made a failed send invisible — the
 * state already claimed it had gone out, so it was never retried.
 *
 * The caller now does: evaluate -> claim -> send -> commit, and releases the
 * claim if the send fails. See core/notifications/claim.js and
 * core/notifications/dispatch.js.
 *
 * nextState is what commitNotification() should persist. It is returned even
 * when shouldNotify is false, because the first sighting of a domain still has
 * to be recorded — it just must not produce a notification.
 *
 * @param {string|null} domain - null for global events
 * @param {string} eventType
 * @param {string} currentStatus - 'up' or 'down'
 * @returns {NotificationDecision}
 */
export function evaluateTransition(domain, eventType, currentStatus) {
  const previousState = getNotificationState(domain, eventType);
  const previousNotifiedFor = previousState.notifiedFor;

  const status = currentStatus === 'up' || currentStatus === 'down' ? currentStatus : 'unknown';

  // First time seeing this domain/event: record it, never notify. Otherwise
  // every restart would announce everything as newly down.
  if (previousNotifiedFor === null || previousState.status === 'unknown') {
    return {
      shouldNotify: false,
      reason: 'first_check',
      currentStatus: status,
      previousNotifiedFor: null,
      nextState: { status, lastNotifiedAt: null, notifiedFor: status },
    };
  }

  if (previousNotifiedFor === status) {
    return {
      shouldNotify: false,
      reason: 'no_change',
      currentStatus: status,
      previousNotifiedFor,
      nextState: null,
    };
  }

  if (status === 'down' && previousNotifiedFor !== 'down') {
    return {
      shouldNotify: true,
      reason: 'state_changed',
      currentStatus: 'down',
      previousNotifiedFor,
      nextState: { status: 'down', lastNotifiedAt: null, notifiedFor: 'down' },
    };
  }

  if (status === 'up' && previousNotifiedFor === 'down') {
    return {
      shouldNotify: true,
      reason: 'recovery',
      currentStatus: 'up',
      previousNotifiedFor: 'down',
      nextState: { status: 'up', lastNotifiedAt: null, notifiedFor: 'up' },
    };
  }

  // status is 'unknown', or an up->up with a stale notifiedFor. Record the
  // status so the next real transition is judged against the truth, but say
  // nothing: there is no event here a user would want to hear about.
  return {
    shouldNotify: false,
    reason: 'edge_case',
    currentStatus: status,
    previousNotifiedFor,
    nextState: { status, lastNotifiedAt: null, notifiedFor: status },
  };
}

/**
 * Records a decision as sent.
 *
 * Call this ONLY after the notification actually went out. The timestamp is
 * stamped here rather than in evaluateTransition(), so lastNotifiedAt always
 * means "when it was really delivered".
 *
 * @param {string|null} domain
 * @param {string} eventType
 * @param {NotificationDecision} decision
 * @param {number} [sentAt]
 */
export function commitNotification(domain, eventType, decision, sentAt = Date.now()) {
  if (!decision?.nextState) return;

  setNotificationState(domain, eventType, {
    ...decision.nextState,
    lastNotifiedAt: decision.shouldNotify ? sentAt : decision.nextState.lastNotifiedAt,
  });
}

/**
 * Evaluate and record in one step, with no send in between.
 *
 * Retained for callers that only track state and never notify. It is NOT the
 * path the monitors use: anything that sends must evaluate, claim, send and
 * then commit, so a failed send is retried.
 *
 * @param {string|null} domain
 * @param {string} eventType
 * @param {string} currentStatus
 * @returns {NotificationDecision}
 */
export function shouldSendNotification(domain, eventType, currentStatus) {
  const decision = evaluateTransition(domain, eventType, currentStatus);
  commitNotification(domain, eventType, decision);
  return decision;
}

/**
 * Clear notification state for a domain (useful for testing or manual reset).
 * @param {string|null} domain - null to clear global state, or specific domain
 * @param {string} eventType
 */
export function clearNotificationState(domain, eventType) {
  const key = domain ? `${domain}:${eventType}` : `global:${eventType}`;
  const map = getNotificationStateMap();
  delete map[key];
  saveNotificationStateMap(map);
}

/**
 * Clear all notification state (useful for testing).
 */
export function clearAllNotificationState() {
  dbSet(STATE_DB_KEY, {});
}

export { KNOWN_EVENT_TYPES };
