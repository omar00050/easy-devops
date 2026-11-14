// src/dashboard/controllers/hubController.js
//
// Thin HTTP layer over core/hubLink.js. All link parsing, persistence and
// permission logic lives in core so a future CLI menu can reuse it — this
// controller only translates between HTTP and that module.
//
// The hub issues connection strings; this server never generates them.

import {
  parseConnectionString,
  saveHubLink,
  clearHubLink,
  saveHubPermissions,
  getLinkStatus,
} from '../../core/hubLink.js';
import { PERMISSION_TREE, COMING_SOON_PERMISSION_IDS } from '../../core/hubPermissions.js';
import { getDataDir, isDevDataDir, isDefaultDataDir } from '../../core/platform.js';
import { inspect } from '../../core/daemon/lock.js';
import { stopHubAgent, initHubAgent, getHubAgentStatus, pushPermissions } from '../../core/hub/agent.js';

// POST /api/hub/connect
// Body: { connectionString: 'ezops://hubUrl|serverId|secret' }
// Saves the pasted link, then starts the agent. Nothing connects until a
// valid string has been saved.
export function connectAgent(req, res) {
  const parsed = parseConnectionString(req.body?.connectionString);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const saved = saveHubLink(parsed.link);
  if (!saved.ok) return res.status(400).json({ error: saved.error });

  // The agent belongs to whichever process owns the background jobs. Starting
  // one HERE while a daemon is running produced two sockets with the same
  // serverId, and the hub keeps only one per server — so they evicted each
  // other every few seconds, for ever.
  //
  // saveHubLink() bumps the revision counter, which the daemon's watcher picks
  // up within a few seconds and reconciles its own agent against. So the
  // correct action in that case is to do nothing more.
  const daemon = inspect();

  if (daemon.running) {
    return res.json({
      ok: true,
      status: hubStatusPayload(),
      agentOwner: 'daemon',
      detail: `The background service (pid ${daemon.lock?.pid}) owns the Hub connection `
        + 'and will pick up the new pairing within a few seconds.',
    });
  }

  // No daemon: this dashboard is the job owner, so it holds the agent.
  // initHubAgent() is idempotent, but stopping first keeps the intent explicit.
  stopHubAgent();
  initHubAgent();

  return res.json({ ok: true, status: hubStatusPayload(), agentOwner: 'dashboard' });
}

// DELETE /api/hub/link
// Unlinks from the hub: stops the agent and clears stored link + permissions.
export function unlinkHub(req, res) {
  // Stopping a local agent is always safe: if the daemon owns it, there is no
  // socket here to stop. clearHubLink() bumps the revision, which is how the
  // daemon learns to drop its own.
  stopHubAgent();
  clearHubLink();

  const daemon = inspect();
  return res.json({
    ok: true,
    ...(daemon.running
      ? {
        agentOwner: 'daemon',
        detail: 'The background service will drop its Hub connection within a few seconds.',
      }
      : {}),
  });
}

// GET /api/hub/status
// Returns the link state plus the agent's live connection status.
export function hubStatus(req, res) {
  return res.json(hubStatusPayload());
}

// PUT /api/hub/permissions
// Body: { reloadNginx?: boolean, manageDomains?: boolean, manageSSL?: boolean }
export function updatePermissions(req, res) {
  const permissions = saveHubPermissions(req.body ?? {});

  // Push the new state to the Hub immediately so its UI greys out actions
  // without waiting for a poll. Non-fatal: the agent may not be connected.
  try {
    pushPermissions();
  } catch { /* not linked, or socket down */ }

  return res.json({ permissions, tree: PERMISSION_TREE, comingSoon: COMING_SOON_PERMISSION_IDS });
}

/**
 * Builds the status response. Deliberately omits the secret — it is only ever
 * shown once by the hub, and is never echoed back by this API.
 */
function hubStatusPayload() {
  const link = getLinkStatus();
  const agent = getHubAgentStatus();

  return {
    linked: link.linked,
    hubUrl: link.hubUrl,
    serverId: link.serverId,
    permissions: link.permissions,
    // The catalog travels with the status so the UI never hard-codes it.
    tree: PERMISSION_TREE,
    comingSoon: COMING_SOON_PERMISSION_IDS,
    connected: agent.connected,
    status: agent.status,
    lastError: agent.lastError,
    attempts: agent.attempts,
    // Which database this dashboard — and therefore this agent — is actually
    // using. A non-default directory means a CLI and a dashboard can be editing
    // two separate domain lists with no visible sign of it, so the path is
    // shown to make that obvious instead of looking like a sync bug.
    //
    // The two flags answer different questions, and conflating them was a bug:
    //   defaultDataDir — is this the ordinary location? A service install
    //                    passes EASY_DEVOPS_DATA_DIR and is still ordinary.
    //   devDataDir     — is this a DEVELOPMENT run (staging certificates,
    //                    `-dev` names)? Only `--dev`/EZ_DEV or `.dev-data`.
    dataDir: getDataDir(),
    defaultDataDir: isDefaultDataDir(getDataDir()),
    devDataDir: isDevDataDir(),
  };
}
