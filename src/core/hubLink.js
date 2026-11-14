/**
 * core/hubLink.js
 *
 * Single source of truth for this server's link to an Easy DevOps Hub.
 *
 * Owns the whole lifecycle: parsing the `ezops://` connection string the hub
 * issues, persisting / reading / clearing the link, the per-hub permission
 * flags, and the classification of agent handshake failures.
 *
 * Consumers (dashboard controller, hub agent, and a future CLI menu) MUST go
 * through this module rather than touching the database keys directly.
 *
 * Storage (via core/db.js only):
 *   'hub-link'        → { hubUrl, serverId, secret }
 *   'hub-permissions' → { reloadNginx, manageDomains, manageSSL }
 *
 * The stored shapes are unchanged from the previous server-generated flow, so
 * servers that were already linked keep working without re-pairing.
 *
 * The secret is a credential: it is persisted so the agent can authenticate,
 * but it MUST NOT be logged or returned by any read API.
 */

import { dbGet, dbSet, dbDelete } from './db.js';
import { validateConnectionString } from './validators.js';
import {
  defaultPermissions,
  normalizePermissions,
  setPermission,
  setGroup,
  isLegacyPermissions,
  migrateLegacyPermissions,
} from './hubPermissions.js';

const HUB_LINK_KEY = 'hub-link';
const HUB_PERMISSIONS_KEY = 'hub-permissions';
const HUB_REVISION_KEY = 'hub-revision';
const PREFIX = 'ezops://';

/**
 * Permissions start fully denied — the hub cannot act until the user opts in.
 * The shape comes from the catalog in core/hubPermissions.js.
 */
export const DEFAULT_HUB_PERMISSIONS = defaultPermissions();

/**
 * Agent statuses surfaced to the UI.
 * not_linked  — no connection string saved yet
 * connecting  — socket opened, handshake not completed
 * connected   — authenticated and streaming
 * rejected    — the hub refused our credentials; retrying cannot help
 * unreachable — network/transport failure; retrying with backoff
 */
export const HUB_AGENT_STATUS = {
  NOT_LINKED: 'not_linked',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  REJECTED: 'rejected',
  UNREACHABLE: 'unreachable',
};

/**
 * Handshake rejection messages emitted by the hub's /agent-socket middleware.
 * Anything not in this set is treated as a transport problem, so an unfamiliar
 * error keeps retrying rather than silently giving up.
 *
 * Mirrors hub_backend/src/lib/agentServer.ts:
 *   AUTH_REQUIRED  — we sent no serverId/secret
 *   UNKNOWN_SERVER — the hub has no such server (e.g. deleted from the hub)
 *   INVALID_SECRET — the secret does not match the stored hash
 */
export const AGENT_REJECTION_ERRORS = Object.freeze([
  'AUTH_REQUIRED',
  'UNKNOWN_SERVER',
  'INVALID_SECRET',
]);

/** Human-readable explanation per rejection reason. */
const REJECTION_MESSAGES = {
  AUTH_REQUIRED: 'The hub rejected the handshake: no credentials were sent.',
  UNKNOWN_SERVER:
    'The hub does not recognise this server. It may have been deleted from the hub — add it again and paste the new connection string.',
  INVALID_SECRET:
    'The hub rejected this secret. If it was regenerated, paste the new connection string.',
};

/**
 * True when a connection error means the hub refused our credentials.
 * Such failures are permanent until the user pastes a new string, so the agent
 * must stop retrying instead of looping.
 * @param {string} message
 * @returns {boolean}
 */
export function isAuthRejection(message) {
  if (!message || typeof message !== 'string') return false;
  return AGENT_REJECTION_ERRORS.includes(message.trim());
}

/**
 * Explain a rejection message for display.
 * @param {string} message
 * @returns {string}
 */
export function describeRejection(message) {
  const key = typeof message === 'string' ? message.trim() : '';
  return REJECTION_MESSAGES[key] ?? 'The hub rejected this server’s credentials.';
}

/**
 * Normalise a stored hub URL into an origin the Socket.io client can dial.
 * Bare hosts default to https; existing schemes are preserved.
 * @param {string} hubUrl
 * @returns {string}
 */
export function resolveHubOrigin(hubUrl) {
  const raw = String(hubUrl ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * Parse and validate a connection string issued by the hub.
 * Does not persist anything — pass the result to saveHubLink().
 *
 * @param {string} str
 * @returns {{ ok: true, link: { hubUrl: string, serverId: string, secret: string } }
 *          | { ok: false, error: string }}
 */
export function parseConnectionString(str) {
  const error = validateConnectionString(str);
  if (error) return { ok: false, error };

  const [hubUrl, serverId, secret] = String(str)
    .trim()
    .slice(PREFIX.length)
    .split('|')
    .map((part) => part.trim());

  return { ok: true, link: { hubUrl, serverId, secret } };
}

/**
 * Read the saved hub link.
 * @returns {{ hubUrl: string, serverId: string, secret: string }|null}
 */
export function getHubLink() {
  const link = dbGet(HUB_LINK_KEY);
  if (!link || typeof link !== 'object') return null;
  if (!link.hubUrl || !link.serverId || !link.secret) return null;
  return { hubUrl: link.hubUrl, serverId: link.serverId, secret: link.secret };
}

/** @returns {boolean} True when a usable link is stored. */
export function isLinked() {
  return getHubLink() !== null;
}

/**
 * Persist a parsed link.
 *
 * Existing permissions are preserved on re-pairing: rotating a secret or
 * re-pasting a string must not silently re-grant or revoke what the user
 * already decided. Permissions are seeded fully-denied only on a first link.
 *
 * @param {{ hubUrl: string, serverId: string, secret: string }} link
 * @returns {{ ok: true, link: object } | { ok: false, error: string }}
 */
export function saveHubLink(link) {
  if (!link || typeof link !== 'object') {
    return { ok: false, error: 'Invalid hub link' };
  }

  const { hubUrl, serverId, secret } = link;
  if (!hubUrl || !serverId || !secret) {
    return { ok: false, error: 'Hub link requires hubUrl, serverId and secret' };
  }

  dbSet(HUB_LINK_KEY, { hubUrl, serverId, secret });

  if (!dbGet(HUB_PERMISSIONS_KEY)) {
    dbSet(HUB_PERMISSIONS_KEY, { ...DEFAULT_HUB_PERMISSIONS });
  }

  // Pairing is exactly the kind of change another process must learn about
  // promptly, and it was the one change that did NOT bump the counter. The
  // consequence was concrete: pairing from the dashboard while the daemon owns
  // the jobs left the daemon unaware, so it never connected its agent, while
  // the dashboard started one of its own — which is how two sockets with the
  // same serverId ended up evicting each other.
  bumpHubRevision();

  return { ok: true, link: { hubUrl, serverId, secret } };
}

/**
 * Parse, validate and persist in one step.
 * @param {string} str
 * @returns {{ ok: true, link: object } | { ok: false, error: string }}
 */
export function saveConnectionString(str) {
  const parsed = parseConnectionString(str);
  if (!parsed.ok) return parsed;
  return saveHubLink(parsed.link);
}

/**
 * Remove the link and its permission flags.
 *
 * Bumps the revision for the same reason saveHubLink() does: another process
 * may be holding an agent open against credentials that no longer exist.
 */
export function clearHubLink() {
  dbDelete(HUB_LINK_KEY);
  dbDelete(HUB_PERMISSIONS_KEY);
  bumpHubRevision();
}

/**
 * Read the permission map, normalised against the catalog.
 *
 * Migrates the pre-tree {reloadNginx, manageDomains, manageSSL} shape on first
 * read and persists the result, so the migration happens once and is
 * idempotent — a second call sees catalog ids and skips it.
 *
 * @returns {Object<string, boolean>}
 */
export function getHubPermissions() {
  const stored = dbGet(HUB_PERMISSIONS_KEY);

  if (isLegacyPermissions(stored)) {
    const migrated = migrateLegacyPermissions(stored);
    dbSet(HUB_PERMISSIONS_KEY, migrated);
    bumpHubRevision();
    return migrated;
  }

  return normalizePermissions(stored);
}

/**
 * Apply permission changes.
 *
 * Accepts either individual leaf ids ({ 'nginx.stop': true }) or whole groups
 * ({ groups: { nginx: true } }), which sets every grantable child. Unknown and
 * comingSoon ids are ignored, so a malformed request cannot widen access.
 *
 * @param {Object} updates
 * @returns {Object<string, boolean>} The persisted permissions
 */
export function saveHubPermissions(updates) {
  let next = getHubPermissions();

  if (updates && typeof updates.groups === 'object' && updates.groups !== null) {
    for (const [groupId, enabled] of Object.entries(updates.groups)) {
      if (typeof enabled === 'boolean') next = setGroup(next, groupId, enabled);
    }
  }

  for (const [id, enabled] of Object.entries(updates ?? {})) {
    if (id === 'groups') continue;
    if (typeof enabled === 'boolean') next = setPermission(next, id, enabled);
  }

  dbSet(HUB_PERMISSIONS_KEY, next);
  bumpHubRevision();
  return next;
}

// ─── Change revision ──────────────────────────────────────────────────────────
//
// The CLI and the dashboard are separate processes, so the agent (which lives
// in the dashboard) cannot be notified in-process when the CLI changes
// something. A counter in SQLite is the cheapest shared signal: the agent polls
// it every few seconds and pushes only when it actually moved.

/** @returns {number} Current revision. */
export function getHubRevision() {
  const n = dbGet(HUB_REVISION_KEY);
  return typeof n === 'number' ? n : 0;
}

/**
 * Increment the revision. Call after any change the Hub should learn about
 * promptly: domains, certificates, permissions.
 * @returns {number} The new revision
 */
export function bumpHubRevision() {
  const next = getHubRevision() + 1;
  dbSet(HUB_REVISION_KEY, next);
  return next;
}

/**
 * Non-secret view of the current link, for status APIs and UI.
 * Deliberately omits the secret.
 * @returns {{ linked: boolean, hubUrl: string|null, serverId: string|null,
 *            permissions: object }}
 */
export function getLinkStatus() {
  const link = getHubLink();
  return {
    linked: link !== null,
    hubUrl: link?.hubUrl ?? null,
    serverId: link?.serverId ?? null,
    permissions: getHubPermissions(),
  };
}
