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
import { stopHubAgent, initHubAgent, getHubAgentStatus } from '../lib/hubAgent.js';

// POST /api/hub/connect
// Body: { connectionString: 'ezops://hubUrl|serverId|secret' }
// Saves the pasted link, then starts the agent. Nothing connects until a
// valid string has been saved.
export function connectAgent(req, res) {
  const parsed = parseConnectionString(req.body?.connectionString);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const saved = saveHubLink(parsed.link);
  if (!saved.ok) return res.status(400).json({ error: saved.error });

  // Restart the agent so it picks up the new credentials.
  stopHubAgent();
  initHubAgent();

  return res.json({ ok: true, status: hubStatusPayload() });
}

// DELETE /api/hub/link
// Unlinks from the hub: stops the agent and clears stored link + permissions.
export function unlinkHub(req, res) {
  stopHubAgent();
  clearHubLink();
  return res.json({ ok: true });
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
  return res.json({ permissions });
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
    connected: agent.connected,
    status: agent.status,
    lastError: agent.lastError,
    attempts: agent.attempts,
  };
}
