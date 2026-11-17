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
import { daemonStatus, daemonHubState } from '../lib/daemonBridge.js';

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
 *
 * The agent lives in whichever process owns the background jobs. When a daemon
 * is running, this process's own agent is not started at all, so asking it
 * would report "connecting" for ever — it has no socket and never will. The
 * answer therefore comes from the daemon (through the bridge), and `agentOwner`
 * says which side reported it.
 */
function hubStatusPayload() {
  const link = getLinkStatus();
  const daemon = inspect();
  const agentOwner = daemon.running ? 'daemon' : 'dashboard';
  const agent = agentOwner === 'daemon' ? daemonAgentStatus(link.linked) : getHubAgentStatus();

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
    // 'daemon' means the background service owns the Hub connection; the state
    // above describes ITS agent, not this process's (which is not running).
    agentOwner,
    // False while the daemon is running but its event channel has not told us
    // its state yet. The UI must say "waiting" rather than invent a status.
    agentReported: agent.reported,
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

/**
 * The daemon's agent state, or an honest placeholder when it has not reported.
 *
 * `reported: false` is the important part: the daemon is running but its IPC
 * channel is not up (or the hello frame has not arrived), so the real state is
 * unknown. Claiming `connected` would be wrong and claiming `connecting` with
 * no explanation looked like a stuck refresh — the UI renders the placeholder
 * as "waiting for the background service".
 */
function daemonAgentStatus(dbLinked) {
  const reported = daemonHubState();

  if (!reported) {
    return {
      linked: dbLinked,
      connected: false,
      status: dbLinked ? 'connecting' : 'not_linked',
      lastError: null,
      attempts: 0,
      reported: false,
    };
  }

  const channelUp = daemonStatus().connected;

  // A stale snapshot is only trusted while the channel that carried it is up.
  // Once it drops, the bridge already clears its copy; this is the belt-and-
  // braces case of a frame arriving mid-disconnect. A daemon that has not yet
  // reconciled a link made a moment ago reports not_linked — the link is in
  // the shared database, so that is a "starting up", not an "unlinked".
  const linked = reported.linked || dbLinked;
  let status = channelUp ? reported.status : 'connecting';
  if (linked && status === 'not_linked') status = 'connecting';

  return {
    linked,
    connected: Boolean(reported.connected) && channelUp,
    status,
    lastError: channelUp ? reported.lastError : null,
    attempts: reported.attempts ?? 0,
    reported: channelUp,
  };
}
