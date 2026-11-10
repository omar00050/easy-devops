// src/dashboard/lib/hubAgent.js
// Persistent outbound Socket.io agent that connects Easy DevOps to the Hub SaaS.
// Activated automatically on dashboard startup when hub-link exists in SQLite.

import { io } from 'socket.io-client';
import os from 'os';
import { dbGet } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { run } from '../../core/shell.js';
import { getStatus, start as nginxStart, stop as nginxStop, restart as nginxRestart, test as nginxTest, listConfigs, getConfig, getLogs } from './nginx-service.js';
import { listAllCerts } from './cert-reader.js';
import { loadChannels } from '../../core/notifier.js';
import {
  getHubLink,
  getHubPermissions,
  resolveHubOrigin,
  isAuthRejection,
  describeRejection,
  HUB_AGENT_STATUS,
} from '../../core/hubLink.js';

// Network retries back off from 1s up to this cap.
const RECONNECT_DELAY_MIN = 1_000;
const RECONNECT_DELAY_MAX = 60_000;

let socket = null;
let intervals = [];

// ─── Connection status ─────────────────────────────────────────────────────────
// Mirrors the five states in core/hubLink.js. `lastError` is a human-readable
// explanation; it never contains the shared secret.
let agentState = {
  status: HUB_AGENT_STATUS.NOT_LINKED,
  lastError: null,
  attempts: 0,
};

function setState(status, lastError = null) {
  agentState = { ...agentState, status, lastError };
}

// ─── CPU usage helper ──────────────────────────────────────────────────────────

function getCpuPercent() {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    for (const type of Object.keys(cpu.times)) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  return Math.round((1 - totalIdle / totalTick) * 100);
}

// ─── Disk usage helper (cross-platform) ───────────────────────────────────────

async function getDiskPercent() {
  try {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows
      ? `(Get-PSDrive C | Select-Object -ExpandProperty Used) / ((Get-PSDrive C | Select-Object -ExpandProperty Used) + (Get-PSDrive C | Select-Object -ExpandProperty Free)) * 100`
      : `df / | awk 'NR==2 {print $5}' | tr -d '%'`;
    const result = await run(cmd, { timeout: 5000 });
    return Math.round(parseFloat(result.stdout) || 0);
  } catch {
    return 0;
  }
}

// ─── Event pushers ─────────────────────────────────────────────────────────────

async function pushNginxStatus() {
  if (!socket?.connected) return;
  try {
    const status = await getStatus();
    socket.emit('nginx:status', { running: status.running, version: status.version ?? null });
  } catch { /* non-fatal */ }
}

async function pushResources() {
  if (!socket?.connected) return;
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const disk = await getDiskPercent();
    socket.emit('server:resources', {
      cpu: getCpuPercent(),
      ram: Math.round((1 - freeMem / totalMem) * 100),
      disk,
    });
  } catch { /* non-fatal */ }
}

async function pushDomainHealth() {
  if (!socket?.connected) return;
  try {
    const domains = dbGet('domains') || [];
    socket.emit('domain:health', domains.map(d => ({ name: d.name, up: d.enabled ?? true })));
  } catch { /* non-fatal */ }
}

async function pushDomainConfigs() {
  if (!socket?.connected) return;
  try {
    const domains = dbGet('domains') || [];
    socket.emit('domain:configs', domains);
  } catch { /* non-fatal */ }
}

async function pushChannelsList() {
  if (!socket?.connected) return;
  try {
    const channels = loadChannels();
    socket.emit('channels:list', channels.map(ch => ({ id: ch.id, name: ch.name, type: ch.type })));
  } catch { /* non-fatal */ }
}

async function pushCertExpiry() {
  if (!socket?.connected) return;
  try {
    const certs = await listAllCerts();
    socket.emit('cert:expiry', certs.map(c => ({
      domain: c.domain,
      expiresAt: c.expiry ?? null,
      daysLeft: c.daysLeft ?? null,
    })));
  } catch { /* non-fatal */ }
}

// ─── Command handlers ──────────────────────────────────────────────────────────

function getPermissions() {
  return getHubPermissions();
}

async function handleReloadNginx() {
  if (!getPermissions().reloadNginx) return;
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'nginx -s reload' : 'sudo -n systemctl reload nginx';
  await run(cmd, { timeout: 15000 });
}

async function handleNginxAction(payload) {
  if (!getPermissions().reloadNginx) return;
  const { action } = payload ?? {};
  try {
    if (action === 'start') await nginxStart();
    else if (action === 'stop') await nginxStop();
    else if (action === 'restart') await nginxRestart();
    else if (action === 'test') await nginxTest();
    else { console.warn('[hubAgent] unknown nginx action:', action); return; }
    console.log('[hubAgent] nginx action:', action, 'OK');
  } catch (err) {
    console.error('[hubAgent] nginx action failed:', action, err.message);
  }
  pushNginxStatus();
}

async function handleGetConfigs() {
  if (!socket?.connected) return;
  try {
    const files = await listConfigs();
    const configs = [];
    for (const f of files) {
      try {
        const result = await getConfig(f);
        configs.push({ name: f, content: result.content });
      } catch { configs.push({ name: f, content: '' }); }
    }
    socket.emit('nginx:configs', configs);
  } catch (err) {
    console.error('[hubAgent] getConfigs error:', err.message);
  }
}

async function handleGetLogs(payload) {
  if (!socket?.connected) return;
  try {
    const result = await getLogs(payload?.lines ?? 200);
    socket.emit('nginx:logs', result);
  } catch (err) {
    console.error('[hubAgent] getLogs error:', err.message);
  }
}

async function handleManageDomain(payload) {
  if (!getPermissions().manageDomains) return;
  const { handleHubDomainCommand } = await import('./domains-db.js');
  await handleHubDomainCommand(payload);
  // Re-sync configs to hub immediately after any domain mutation
  pushDomainHealth();
  pushDomainConfigs();
}

async function handleManageSSL(payload) {
  if (!getPermissions().manageSSL) return;
  const { handleHubSslCommand } = await import('./cert-operations.js');
  await handleHubSslCommand(payload);
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

function startHeartbeats() {
  stopHeartbeats(); // clear any existing intervals first
  intervals.push(setInterval(pushNginxStatus, 5_000));
  intervals.push(setInterval(pushResources, 30_000));
  intervals.push(setInterval(pushDomainHealth, 60_000));
  intervals.push(setInterval(pushDomainConfigs, 5 * 60_000));
  intervals.push(setInterval(pushChannelsList, 5 * 60_000));
  intervals.push(setInterval(pushCertExpiry, 12 * 60 * 60 * 1000));
  // Push immediately on connect
  pushNginxStatus();
  pushResources();
  pushDomainHealth();
  pushDomainConfigs();
  pushChannelsList();
  pushCertExpiry();
}

function stopHeartbeats() {
  for (const id of intervals) clearInterval(id);
  intervals = [];
}

export function initHubAgent() {
  const link = getHubLink();
  if (!link) {
    setState(HUB_AGENT_STATUS.NOT_LINKED);
    agentState.attempts = 0;
    return;
  }

  const { hubUrl, serverId, secret } = link;
  const url = resolveHubOrigin(hubUrl);

  agentState = { status: HUB_AGENT_STATUS.CONNECTING, lastError: null, attempts: 0 };

  // Bind handlers to this specific instance. Re-pairing replaces `socket`, and
  // a late event from a discarded instance must not mutate the new one's state.
  const self = io(`${url}/agent-socket`, {
    auth: { serverId, secret },
    reconnection: true,
    reconnectionDelay: RECONNECT_DELAY_MIN,
    reconnectionDelayMax: RECONNECT_DELAY_MAX,
    transports: ['websocket'],
  });
  socket = self;

  const isCurrent = () => socket === self;

  self.on('connect', () => {
    if (!isCurrent()) return;
    console.log('[hubAgent] Connected to hub');
    agentState = { status: HUB_AGENT_STATUS.CONNECTED, lastError: null, attempts: 0 };
    // Push server metadata so the hub can tailor the domain form (SSL paths, etc.)
    const { sslDir } = loadConfig();
    self.emit('server:info', { platform: process.platform, sslDir: sslDir ?? '' });
    startHeartbeats();
  });

  self.on('disconnect', (reason) => {
    if (!isCurrent()) return;
    console.log('[hubAgent] Disconnected:', reason);
    stopHeartbeats();
    // A server-side disconnect after a secret rotation lands here; the next
    // handshake attempt is what tells us whether we were rejected.
    if (agentState.status === HUB_AGENT_STATUS.CONNECTED) {
      setState(HUB_AGENT_STATUS.CONNECTING, null);
    }
  });

  self.on('connect_error', (err) => {
    const message = err?.message ?? 'unknown error';

    if (isAuthRejection(message)) {
      // Permanent until the user pastes a new string — retrying cannot help,
      // so stop the manager's backoff instead of looping forever.
      console.error('[hubAgent] Hub rejected the handshake:', message);
      try {
        self.io.reconnection(false);
        self.disconnect();
      } catch { /* already torn down */ }

      if (!isCurrent()) return;
      setState(HUB_AGENT_STATUS.REJECTED, describeRejection(message));
      stopHeartbeats();
      return;
    }

    if (!isCurrent()) return;

    // Transport/network failure — socket.io keeps retrying with backoff.
    agentState = {
      status: HUB_AGENT_STATUS.UNREACHABLE,
      lastError: `Cannot reach the hub (${message}). Retrying…`,
      attempts: agentState.attempts + 1,
    };
    console.error('[hubAgent] Connection error:', message);
  });

  self.on('hub:reloadNginx', handleReloadNginx);
  self.on('hub:manageDomain', handleManageDomain);
  self.on('hub:manageSSL', handleManageSSL);
  self.on('hub:nginxAction', handleNginxAction);
  self.on('hub:getConfigs', handleGetConfigs);
  self.on('hub:getLogs', handleGetLogs);
}

export function stopHubAgent() {
  stopHeartbeats();
  if (socket) {
    try {
      socket.io.reconnection(false);
    } catch { /* manager already gone */ }
    socket.disconnect();
    socket = null;
  }
  setState(HUB_AGENT_STATUS.NOT_LINKED);
  agentState.attempts = 0;
}

/**
 * Current agent state for the status API.
 * `connected` is kept as a derived boolean for existing consumers.
 * Never includes the shared secret.
 */
export function getHubAgentStatus() {
  const linked = getHubLink() !== null;
  const connected = socket?.connected ?? false;

  let status = agentState.status;

  if (!linked) {
    // The link may have been cleared out of band; never report a stale state.
    status = HUB_AGENT_STATUS.NOT_LINKED;
  } else if (connected) {
    status = HUB_AGENT_STATUS.CONNECTED;
  } else if (status === HUB_AGENT_STATUS.NOT_LINKED) {
    // Linked, but this process has not started the agent yet (initHubAgent
    // runs at dashboard startup). Report it as on its way, not unlinked.
    status = HUB_AGENT_STATUS.CONNECTING;
  }

  return {
    linked,
    connected,
    status,
    lastError: linked ? agentState.lastError : null,
    attempts: linked ? agentState.attempts : 0,
  };
}
