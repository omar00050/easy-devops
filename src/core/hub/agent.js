// src/core/hub/agent.js
// Persistent outbound Socket.io agent that connects Easy DevOps to the Hub SaaS.
//
// Lives in core because it is background work, not dashboard work: the daemon
// runs it when a daemon is running, and an open dashboard runs it only while
// no daemon is (see core/jobs/index.js). It was in src/dashboard/lib/ when the
// dashboard was the only long-running process.
//
// Activated when hub-link exists in SQLite.

import { io } from 'socket.io-client';
import { createHash } from 'crypto';
import os from 'os';
import { dbGet } from '../db.js';
import { loadConfig } from '../config.js';
import { run } from '../shell.js';
import { getStatus, start as nginxStart, stop as nginxStop, restart as nginxRestart, test as nginxTest, reload as nginxReload, listConfigs, getConfig, saveConfig, getLogs } from '../nginx-service.js';
import { publish } from '../jobs/bus.js';
import { getLastDomainHealth, probeDomains, DOMAIN_HEALTH_POLL_MS } from '../jobs/monitors.js';
import { isWindows, platformName, isDevDataDir } from '../platform.js';
import { listAllCerts, getCertExpiry } from '../cert-reader.js';
import { backgroundServiceState } from '../service/index.js';
import * as runner from '../runner.js';
import { loadChannels } from '../notifier.js';
import {
  getHubLink,
  getHubPermissions,
  getHubRevision,
  resolveHubOrigin,
  isAuthRejection,
  describeRejection,
  HUB_AGENT_STATUS,
} from '../hubLink.js';
import {
  PERMISSION_TREE,
  COMING_SOON_PERMISSION_IDS,
  checkCommandAllowed,
} from '../hubPermissions.js';
import { startDeployProgress, stopDeployProgress } from './deployProgress.js';
import {
  describeDeployAppsForHub,
  projectDomainForHub,
  projectRunForHub,
  projectServerInfoForHub,
} from './telemetry.js';

/** How often the agent checks the shared revision counter. */
const REVISION_POLL_MS = 3_000;

// Network retries back off from 1s up to this cap.
const RECONNECT_DELAY_MIN = 1_000;
const RECONNECT_DELAY_MAX = 60_000;

let socket = null;
let intervals = [];

// socket.io-client does NOT auto-reconnect after a server-initiated
// disconnect ("io server disconnect"), which is exactly what the hub does when
// the shared secret is rotated. We re-dial manually on our own backoff so the
// agent learns whether its credentials are still valid instead of sitting idle.
let rejoinTimer = null;
let rejoinDelay = 0;

// ─── Connection status ─────────────────────────────────────────────────────────
// Mirrors the five states in core/hubLink.js. `lastError` is a human-readable
// explanation; it never contains the shared secret.
let agentState = {
  status: HUB_AGENT_STATUS.NOT_LINKED,
  lastError: null,
  attempts: 0,
};

function setState(status, lastError = null, attempts = agentState.attempts) {
  agentState = { ...agentState, status, lastError, attempts };
  publishAgentState();
}

/**
 * Puts the agent's state on the job bus, so a dashboard in another process can
 * report it.
 *
 * The agent runs in the process that owns the jobs, which is often the daemon.
 * The dashboard's status endpoint used to read its own (empty) agent state and
 * sat on "Connecting…" for ever. Publishing on every transition means the
 * daemon's IPC channel carries the answer, and the dashboard's view follows.
 */
function publishAgentState() {
  try {
    publish('hub:agentState', getHubAgentStatus());
  } catch { /* a status listener must never break the connection */ }
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

async function pushServerInfo({ target = socket } = {}) {
  if (!target?.connected) return;
  try {
    const { sslDir } = loadConfig();
    target.emit('server:info', projectServerInfoForHub(
      { platform: platformName, sslDir: sslDir ?? '' },
      getPermissions(),
    ));
  } catch { /* non-fatal */ }
}

async function pushNginxStatus({ target = socket } = {}) {
  if (!target?.connected) return;
  try {
    const status = await getStatus();
    if (!target.connected) return;
    target.emit('nginx:status', { running: status.running, version: status.version ?? null });
  } catch { /* non-fatal */ }
}

async function pushResources({ target = socket } = {}) {
  if (!target?.connected) return;
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const disk = await getDiskPercent();
    if (!target.connected) return;
    target.emit('server:resources', {
      cpu: getCpuPercent(),
      ram: Math.round((1 - freeMem / totalMem) * 100),
      disk,
    });
  } catch { /* non-fatal */ }
}

async function pushDomainHealth({ target = socket } = {}) {
  if (!target?.connected) return;
  try {
    const domains = dbGet('domains') || [];

    // Real probe results, not the enabled flag. The monitors sweep every
    // minute in this same process; reuse that sweep while it is fresh, and
    // probe directly only when there is none yet (first push after a start).
    const last = getLastDomainHealth();
    const fresh = last && Date.now() - last.at < 3 * DOMAIN_HEALTH_POLL_MS;
    const results = fresh ? last.results : await probeDomains(domains.filter(d => d.enabled !== false));
    const upByName = new Map(results.map(r => [r.name, r.up]));

    // `enabled` travels separately so the Hub never has to infer it from
    // health. A disabled domain has no health to report: `up: null`.
    if (!target.connected) return;
    target.emit('domain:health', domains.map(d => {
      const enabled = d.enabled !== false;
      return { name: d.name, enabled, up: enabled ? (upByName.get(d.name) ?? null) : null };
    }));
  } catch { /* non-fatal */ }
}

/**
 * Adds the certificate state the dashboard already knows to each domain.
 *
 * This scan adds only the status and its label, never a path or certificate
 * body. Configured paths already on the domain follow projectDomainForHub(),
 * which exposes them only with nginx.config.view. A configured domain whose
 * certificate directory does not exist yet reports `not_issued`, which is what
 * the Hub needs to say "Not issued yet" instead of showing an error.
 */
export async function domainsWithCertState(
  domains,
  {
    listCertificates = listAllCerts,
    certificateStatus = getCertExpiry,
    permissions = getPermissions,
  } = {},
) {
  if (!Array.isArray(domains)) return [];

  const certByName = new Map();
  try {
    for (const cert of await listCertificates({ includeUnusable: true })) {
      certByName.set(cert.domain, cert);
    }
  } catch { /* an unreadable certificate directory is not fatal */ }

  const entries = [];
  for (const domain of domains) {
    if (!domain || typeof domain !== 'object' || Array.isArray(domain)) continue;
    const known = certByName.get(domain.name);
    let certStatus = known?.status ?? null;
    let certLabel = known?.label ?? null;

    if (!known && domain.name) {
      try {
        const info = await certificateStatus(domain.name);
        if (info.state === 'not_issued') {
          certStatus = 'not_issued';
          certLabel = 'Not issued yet';
        } else if (info.state === 'unreadable') {
          certStatus = 'unreadable';
        }
      } catch { /* no certificate information for this name */ }
    }

    entries.push({ domain, certStatus, certLabel });
  }

  // Every await is complete. Snapshot once, project and return without another
  // yield, so a revocation observed by this process cannot be followed by a
  // privileged payload built from the earlier grant.
  const current = permissions();
  const out = [];
  for (const { domain, certStatus, certLabel } of entries) {
    const next = projectDomainForHub(domain, current);
    if (!next) continue;
    if (certStatus) next.certStatus = certStatus;
    if (certLabel) next.certLabel = certLabel;
    out.push(next);
  }
  return out;
}

async function pushDomainConfigs({ target = socket } = {}) {
  if (!target?.connected) return;
  try {
    const domains = dbGet('domains') || [];
    const projected = await domainsWithCertState(domains);
    if (target.connected) target.emit('domain:configs', projected);
  } catch { /* non-fatal */ }
}

async function pushChannelsList({ target = socket } = {}) {
  if (!target?.connected) return;
  try {
    const channels = loadChannels();
    target.emit('channels:list', channels.map(ch => ({ id: ch.id, name: ch.name, type: ch.type })));
  } catch { /* non-fatal */ }
}

/**
 * Reports whether the dashboard is running as a background service.
 *
 * This is what lets the Hub say "offline means really down": if the dashboard
 * runs under PM2 with start-on-boot arranged, an agent that stops reporting is
 * a genuine outage rather than someone having closed a terminal.
 *
 * Deliberately cheap and side-effect free: the state is a lock read and a few
 * existsSync calls, and the PM2 probe never starts a PM2 daemon — so a server
 * that does not use PM2 is not given one just because it is paired with a Hub.
 */
async function pushServiceState({ target = socket } = {}) {
  if (!target?.connected) return;
  try {
    // The NATIVE service, not the PM2 app. This used to report a PM2
    // installation, which made "offline means really down" a much weaker
    // signal than the Hub believed: the agent lived inside the dashboard, so
    // there was nothing left to report when the dashboard closed.
    const s = backgroundServiceState();
    const pm2 = await runner.detect({ probeVersion: false });

    if (!target.connected) return;
    target.emit('service:state', {
      installed: s.installed,
      running: s.running,
      status: s.detail,
      mechanism: s.mechanism,
      mode: s.mode,
      startsAt: s.startsAt,
      stoppedByUser: s.stoppedByUser,
      jobsRunningHere: s.jobsRunningHere,
      enabledOnBoot: s.installed,
      dev: isDevDataDir(),
      // The user's OWN PM2 installation, which is a different thing and the
      // only reason these two fields still exist.
      pm2Installed: pm2.installed,
      pm2Version: pm2.version,
      uptimeMs: s.startedAt ? Date.now() - s.startedAt : null,
    });
  } catch { /* non-fatal */ }
}

/**
 * Reports the PM2 process list, as read-only telemetry.
 *
 * Monitoring is never gated in this project's permission catalog — a paired
 * server is a monitored server. Acting on a process is a separate matter and
 * needs process.start / process.stop / process.restart (hub:manageProcess).
 *
 * Skipped entirely when the PM2 daemon is not running, so that reporting never
 * starts one.
 */
async function pushProcesses({ target = socket } = {}) {
  if (!target?.connected) return;
  try {
    if (!runner.isDaemonRunning()) {
      target.emit('processes:list', { daemonRunning: false, apps: [] });
      return;
    }
    const pm2 = await runner.detect({ probeVersion: false });
    if (!pm2.installed) {
      target.emit('processes:list', { daemonRunning: false, apps: [] });
      return;
    }
    const listed = await runner.list({ pm2Path: pm2.path ?? 'pm2' });
    if (!target.connected) return;
    target.emit('processes:list', {
      daemonRunning: true,
      apps: listed.ok ? listed.apps : [],
    });
  } catch { /* non-fatal */ }
}

async function pushCertExpiry({ target = socket } = {}) {
  if (!target?.connected) return;
  try {
    const certs = await listAllCerts({ includeUnusable: true });
    if (!target.connected) return;
    target.emit('cert:expiry', certs.map(c => ({
      domain: c.domain,
      expiresAt: c.expiry ?? null,
      daysLeft: c.daysLeft ?? null,
      status: c.status ?? null,
      label: c.label ?? null,
    })));
  } catch { /* non-fatal */ }
}

// ─── Command handlers ──────────────────────────────────────────────────────────
//
// Every command goes through runCommand(), which performs the local permission
// check against core/hubPermissions.js and always replies with command:result.
// The local check is the real security gate: the Hub's own copy of the
// permissions is only a UI hint and is never trusted here.

function getPermissions() {
  return getHubPermissions();
}

// ─── Live command progress ────────────────────────────────────────────────────
//
// A long Hub command (a certificate request, a deployment) used to be silent
// between its dispatch and its one `command:result`, so the browser could only
// show "busy". `command:progress` fills that gap. It is deliberately small:
// a step name, a status and an optional one-line detail — never file contents,
// paths or anything a secret could hide in.
//
// At most five events leave per requestId per second. Beyond that the LAST
// event of each step is kept and sent when the window reopens, so a step's
// running → ok/failed pair cannot be lost to the throttle.

const PROGRESS_WINDOW_MS = 1_000;
const PROGRESS_MAX_PER_WINDOW = 5;
const PROGRESS_DETAIL_MAX = 300;
const PROGRESS_STATUSES = new Set(['running', 'ok', 'failed', 'skipped']);

/**
 * Builds the `onProgress(step, status, detail, domain?)` handed to a command
 * handler.
 *
 * Bound to one requestId. It is a no-op when there is no requestId (nothing to
 * correlate the event with) or when the socket is down, and it never throws:
 * progress is a convenience, and a broken listener must not fail the command
 * that is doing the real work.
 *
 * `domain` is optional and names which domain an SSL stage belongs to; it is
 * what lets renewAll show per-domain progress. Other commands omit it.
 *
 * @param {string|null} requestId
 * @returns {(step: string, status: 'running'|'ok'|'failed'|'skipped', detail?: string, domain?: string) => void}
 */
export function createCommandProgress(
  requestId,
  {
    target = socket,
    isAllowed = () => true,
    isConnected = () => Boolean(target?.connected),
    getRevision = getHubRevision,
    emit: deliver = (payload) => {
      if (target?.connected) target.emit('command:progress', payload);
    },
  } = {},
) {
  if (!requestId) return () => {};

  let windowStartedAt = 0;
  let sentInWindow = 0;
  let timer = null;
  // step -> newest event held back by the throttle
  const deferred = new Map();
  const startedAtRevision = (() => {
    try {
      return getRevision();
    } catch {
      // The caller may still perform the command, but an event whose authority
      // cannot be tied to a revision must not be emitted.
      return Symbol('revision-unavailable');
    }
  })();

  const stillAuthorized = () => {
    try {
      return isAllowed() && getRevision() === startedAtRevision;
    } catch {
      return false;
    }
  };

  const emit = (payload) => {
    try {
      if (stillAuthorized()) deliver(payload);
    } catch { /* a progress event must never break the command */ }
  };

  const flush = () => {
    timer = null;
    try {
      if (!deferred.size || !stillAuthorized()) {
        deferred.clear();
        return;
      }
      const now = Date.now();
      if (now - windowStartedAt >= PROGRESS_WINDOW_MS) {
        windowStartedAt = now;
        sentInWindow = 0;
      }
      for (const [step, payload] of [...deferred]) {
        if (sentInWindow >= PROGRESS_MAX_PER_WINDOW) break;
        deferred.delete(step);
        sentInWindow += 1;
        emit(payload);
      }
      if (deferred.size) {
        timer = setTimeout(flush, Math.max(10, windowStartedAt + PROGRESS_WINDOW_MS - Date.now()));
      }
    } catch { /* never throw from a timer */ }
  };

  return function onProgress(step, status, detail, domain) {
    try {
      if (!isConnected()) return;
      if (!stillAuthorized()) return;
      if (!PROGRESS_STATUSES.has(status)) return;

      const now = Date.now();
      if (now - windowStartedAt >= PROGRESS_WINDOW_MS) {
        windowStartedAt = now;
        sentInWindow = 0;
      }

      const payload = { requestId, step: String(step), status, at: new Date().toISOString() };
      if (typeof detail === 'string' && detail) {
        payload.detail = detail.length > PROGRESS_DETAIL_MAX
          ? detail.slice(0, PROGRESS_DETAIL_MAX)
          : detail;
      }
      if (typeof domain === 'string' && domain.trim()) {
        payload.domain = domain.trim();
      }

      if (sentInWindow < PROGRESS_MAX_PER_WINDOW) {
        sentInWindow += 1;
        emit(payload);
        return;
      }

      // Over the limit: remember only the newest event for this step.
      // renewAll sends the same step for several domains, so the key includes
      // the domain; otherwise one domain's stage would replace another's.
      deferred.set(`${payload.step}\u0000${payload.domain ?? ''}`, payload);
      if (!timer) {
        timer = setTimeout(flush, Math.max(10, windowStartedAt + PROGRESS_WINDOW_MS - now));
      }
    } catch { /* never throw */ }
  };
}

/**
 * An Error carrying a handler's own { ok: false, ... } result as `data`, so a
 * refusal reaches the Hub with its details (the failed stage, the domains that
 * still use a certificate) instead of only a message. Handlers build that
 * result from fields meant for the Hub; nothing secret goes in it.
 *
 * @param {Object} result
 * @param {string} fallback
 */
function refusalError(result, fallback) {
  const message = typeof result?.error === 'string'
    ? result.error
    : (result?.error?.cause || fallback);
  const err = new Error(message);
  err.data = result;
  return err;
}

/** Emits the acknowledgement the Hub and its browser clients wait for. */
function sendResult(requestId, ok, { error = null, data = null } = {}, ack = null, target = socket) {
  if (!requestId) return;
  const payload = { requestId, ok, error, data };

  // A current Hub emits the command WITH a socket.io acknowledgement and
  // answers its HTTP request from it; an older one only relays
  // `command:result`, so both are sent. The ack goes first: the Hub relays a
  // `command:result` it did not consume to the browser, and answering the ack
  // before that lets the HTTP response and the live event tell the same story.
  if (typeof ack === 'function') {
    try { ack(payload); } catch { /* a stale ack must never break the handler */ }
  }

  if (target?.connected) target.emit('command:result', payload);
}

/**
 * Logs how long one command took, with its outcome and nothing else.
 *
 * The first run of a command after a Hub restart can be slow (cold imports,
 * certificate scans, a first PM2 read). Without this line that shows up only as
 * a browser timing out, with no way to tell which command was responsible.
 *
 * NEVER log the payload: it can carry environment values, config contents and
 * deploy tokens. The command name, duration and ok/error are enough.
 *
 * @param {string} command
 * @param {number} startedAt Date.now() when handling began
 * @param {boolean} ok
 */
function logCommandTiming(command, startedAt, ok) {
  console.log(`[hubAgent] ${command} ${Math.max(0, Date.now() - startedAt)}ms ${ok ? 'ok' : 'error'}`);
}

function commandVerdict(command, payload) {
  return checkCommandAllowed(command, payload, getPermissions());
}

function assertCommandStillAllowed(command, payload) {
  const verdict = commandVerdict(command, payload);
  if (!verdict.allowed) {
    const error = new Error(`Permission was revoked while the command was running: ${verdict.reason}`);
    error.code = 'HUB_PERMISSION_REVOKED';
    throw error;
  }
}

function guardSideEffect(command, payload, fn) {
  return (...args) => {
    if (!commandVerdict(command, payload).allowed) return;
    return fn(...args);
  };
}

/**
 * Runs one hub command: permission check, execution, acknowledgement.
 *
 * @param {string} command
 * @param {Object} payload  May carry a requestId added by the Hub
 * @param {(payload: Object) => Promise<Object|void>} fn
 * @param {Function|null} [ack] socket.io acknowledgement, when the Hub waits
 * @param {{target?: Object}} [options] the exact connection that dispatched it
 */
export async function runCommand(command, payload, fn, ack = null, { target = socket } = {}) {
  const commandPayload = payload ?? {};
  const requestId = commandPayload.requestId ?? null;
  const startedAt = Date.now();

  const verdict = commandVerdict(command, commandPayload);
  if (!verdict.allowed) {
    console.warn('[hubAgent] refused', command, '-', verdict.reason);
    logCommandTiming(command, startedAt, false);
    sendResult(requestId, false, { error: verdict.reason }, ack, target);
    return;
  }

  try {
    const stillAllowed = () => assertCommandStillAllowed(command, commandPayload);
    const data = await fn(commandPayload, stillAllowed, { target });
    // Recheck after the final await and immediately before the acknowledgement.
    stillAllowed();
    logCommandTiming(command, startedAt, true);
    sendResult(requestId, true, { data: data ?? null }, ack, target);
  } catch (err) {
    const current = commandVerdict(command, commandPayload);
    const message = current.allowed
      ? err.message
      : 'Permission was revoked while the command was running, so its result was withheld.';
    console.error('[hubAgent]', command, 'failed:', message);
    logCommandTiming(command, startedAt, false);
    // A handler may attach a structured refusal (refusalError above) so the
    // Hub can show it as well as the message.
    sendResult(requestId, false, {
      error: message,
      data: current.allowed ? (err.data ?? null) : null,
    }, ack, target);
  }
}

async function handleReloadNginx(payload, ack, { target = socket } = {}) {
  return runCommand('hub:reloadNginx', payload, async (_body, stillAllowed) => {
    // Reuse the dashboard's reload path instead of rebuilding the command
    // here: it resolves the nginx.exe path on Windows and uses `sudo -n`.
    const r = await nginxReload();
    stillAllowed();
    pushNginxStatus({ target });
    notifyLocalDashboard('nginx');
    if (!r?.success) throw new Error(r?.output || 'nginx reload failed');
    return { output: r.output ?? '' };
  }, ack, { target });
}

async function handleNginxAction(payload, ack, { target = socket } = {}) {
  return runCommand('hub:nginxAction', payload, async ({ action }, stillAllowed) => {
    const actions = {
      start: nginxStart, stop: nginxStop, restart: nginxRestart, test: nginxTest,
    };
    const fn = actions[action];
    if (!fn) throw new Error(`Unknown nginx action: ${action}`);

    const r = await fn();
    stillAllowed();
    pushNginxStatus({ target });
    notifyLocalDashboard('nginx');
    if (r && r.success === false) throw new Error(r.output || `nginx ${action} failed`);
    return { action, output: r?.output ?? '' };
  }, ack, { target });
}

export async function handleGetConfigs(
  payload,
  ack,
  { list = listConfigs, read = getConfig, target = socket } = {},
) {
  return runCommand('hub:getConfigs', payload, async (_body, stillAllowed) => {
    const files = await list();
    const configs = [];
    for (const f of files) {
      try {
        const result = await read(f);
        configs.push({ name: f, content: result.content });
      } catch { configs.push({ name: f, content: '' }); }
    }
    stillAllowed();
    if (target?.connected) target.emit('nginx:configs', configs);
    return { count: configs.length };
  }, ack, { target });
}

/**
 * Decides whether a `hub:saveConfig` should also reload nginx.
 *
 * Saving and reloading are two different capabilities, and a server may grant
 * one without the other: `nginx.config.edit` lets the Hub change a file that
 * `nginx -t` accepts, while `nginx.reload` lets it affect live traffic. An
 * operator who allows editing but not reloading has said something specific,
 * so a `reload: true` from the Hub must not quietly override it.
 *
 * The save therefore always stands on its own, and a refused reload is
 * reported rather than treated as a failure — the file is written and valid
 * either way.
 *
 * Exported so the decision can be tested without nginx: it is a pure function
 * of the payload and the stored permission map.
 *
 * @param {Object} payload The command payload
 * @param {Object} permissions The granted permission map
 * @returns {{ requested: boolean, allowed: boolean, reason: string|null }}
 */
export function resolveSaveConfigReload(payload, permissions) {
  // Only an explicit `true` asks for a reload. Anything else — absent, false,
  // "true", 1 — is not a request, because a reload affects live traffic and
  // should never happen through a loose coercion.
  const requested = payload?.reload === true;
  if (!requested) return { requested: false, allowed: false, reason: null };

  const verdict = checkCommandAllowed('hub:reloadNginx', {}, permissions);
  return {
    requested: true,
    allowed: verdict.allowed,
    reason: verdict.allowed ? null : verdict.reason,
  };
}

export async function handleSaveConfig(
  payload,
  ack,
  {
    save = saveConfig,
    reload = nginxReload,
    permissions = getPermissions,
    target = socket,
  } = {},
) {
  return runCommand('hub:saveConfig', payload, async (body, stillAllowed) => {
    const { filename, content } = body;
    if (typeof filename !== 'string' || !filename.trim()) throw new Error('filename is required');
    if (typeof content !== 'string') throw new Error('content must be a string');

    // Decided BEFORE the write, so the answer cannot depend on anything the
    // save itself changes.
    const wanted = resolveSaveConfigReload(body, permissions());

    // saveConfig() validates the filename, keeps the write inside the nginx
    // config directory, tests with isNginxTestOk() and restores the previous
    // bytes when nginx rejects the result.
    const r = await save(filename, content);
    if (!r?.success) throw new Error(r?.output || 'nginx rejected the config');

    const result = {
      filename,
      output: r.output ?? '',
      reloadRequested: wanted.requested,
      reloaded: false,
      reloadDetail: wanted.reason,
    };

    // The save can take long enough for nginx.reload to be revoked. Saving and
    // affecting live traffic are separate capabilities, so ask again at the
    // instant the second side effect is about to happen.
    const reloadStillAllowed = wanted.requested
      && wanted.allowed
      && checkCommandAllowed('hub:reloadNginx', body, permissions()).allowed;
    if (reloadStillAllowed) {
      // The config has already passed `nginx -t`, so this is the only step
      // left. A reload that fails does NOT undo the save: the file on disk is
      // valid, and rolling it back would discard a good edit over a transient
      // reload problem. It is reported instead.
      const reloaded = await reload();
      result.reloaded = Boolean(reloaded?.success);
      result.reloadDetail = result.reloaded
        ? (reloaded.output ?? '').trim() || 'nginx reloaded'
        : `the config was saved and is valid, but the reload failed: ${(reloaded?.output ?? '').trim() || 'no output'}`;
    } else if (!wanted.requested) {
      result.reloadDetail = 'no reload was requested; the new config takes effect on the next reload';
    }

    stillAllowed();
    pushNginxStatus({ target });
    pushDomainConfigs({ target });
    notifyLocalDashboard('nginx');
    return result;
  }, ack, { target });
}

export async function handleGetLogs(payload, ack, { read = getLogs, target = socket } = {}) {
  return runCommand('hub:getLogs', payload, async ({ lines }, stillAllowed) => {
    const result = await read(lines ?? 200);
    stillAllowed();
    if (target?.connected) target.emit('nginx:logs', result);
    return { lines: result?.lines?.length ?? 0 };
  }, ack, { target });
}

export async function handleManageDomain(
  payload,
  ack,
  { loadCommand = () => import('../domains-db.js'), target = socket } = {},
) {
  return runCommand('hub:manageDomain', payload, async (p, stillAllowed) => {
    const { handleHubDomainCommand } = await loadCommand();
    stillAllowed();
    const result = await handleHubDomainCommand(p, { recheck: stillAllowed });
    if (result && result.ok === false) throw refusalError(result, 'domain command failed');

    // Re-sync to the hub and refresh any open local dashboard tab.
    stillAllowed();
    pushDomainHealth({ target });
    pushDomainConfigs({ target });
    notifyLocalDashboard('domains');
    return result ?? null;
  }, ack, { target });
}

export async function handleManageSSL(
  payload,
  ack,
  { loadCommand = () => import('../cert-operations.js'), target = socket } = {},
) {
  return runCommand('hub:manageSSL', payload, async (p, stillAllowed) => {
    const { handleHubSslCommand } = await loadCommand();
    stillAllowed();
    const result = await handleHubSslCommand(p, {
      recheck: stillAllowed,
      onProgress: guardSideEffect(
        'hub:manageSSL',
        p,
        createCommandProgress(p?.requestId, {
          target,
          isAllowed: () => commandVerdict('hub:manageSSL', p).allowed,
        }),
      ),
    });
    if (result && result.ok === false) throw refusalError(result, 'ssl command failed');

    stillAllowed();
    pushCertExpiry({ target });
    pushDomainConfigs({ target });
    notifyLocalDashboard('ssl');
    return result ?? null;
  }, ack, { target });
}

/**
 * Reports the deployed apps and where each one stands.
 *
 * Monitoring, like the process list: a paired server is a monitored server.
 * publicApp() is what makes that safe — environment variable NAMES, never
 * values, and no credentials of any kind.
 */
let lastProjectedDeployApps = [];
let lastDeployLogsGranted = null;

/**
 * Re-projects the last emitted deployment list when log access is revoked.
 *
 * Loading a fresh PM2 snapshot can take seconds on Windows. Waiting for it
 * would leave diagnostics already accepted by the Hub visible after the local
 * grant was revoked. The cached list contains only an earlier explicit
 * projection, and projectRunForHub() removes every diagnostic field here before
 * the synchronous emit.
 */
export function emitCachedDeployAppsAfterRevocation(
  permissions,
  { target = socket, remember = true } = {},
) {
  if (!target?.connected || permissions?.['deploy.logs'] === true) return false;
  if (lastDeployLogsGranted !== true || lastProjectedDeployApps.length === 0) {
    if (remember) lastDeployLogsGranted = false;
    return false;
  }

  const redacted = lastProjectedDeployApps.map((app) => ({
    ...app,
    lastRun: app?.lastRun ? projectRunForHub(app.lastRun, permissions) : null,
  }));
  target.emit('deploy:apps', redacted);
  if (remember) {
    lastProjectedDeployApps = redacted;
    lastDeployLogsGranted = false;
  }
  return true;
}

export async function pushDeployApps({
  describe = describeDeployAppsForHub,
  target = socket,
  remember = true,
} = {}) {
  if (!target?.connected) return;
  try {
    let logsGranted = false;
    const apps = await describe(async () => {
      const { describeApps } = await import('../deploy/status.js');
      const { publicApp } = await import('../deploy/apps.js');
      return describeApps({
        view: publicApp,
        runView: (run) => run,
      });
    }, () => {
      const permissions = getPermissions();
      logsGranted = permissions['deploy.logs'] === true;
      return permissions;
    });
    if (!target.connected) return;
    target.emit('deploy:apps', apps);
    if (remember) {
      lastProjectedDeployApps = apps;
      lastDeployLogsGranted = logsGranted;
    }
  } catch { /* non-fatal */ }
}

export async function handleManageDeploy(
  payload,
  ack,
  {
    handleHubDeployCommand = null,
    loadHubDeployCommand = () => import('../deploy/hubCommands.js'),
    target = socket,
  } = {},
) {
  return runCommand('hub:manageDeploy', payload, async (p, stillAllowed) => {
    if (!handleHubDeployCommand) {
      ({ handleHubDeployCommand } = await loadHubDeployCommand());
    }
    stillAllowed();
    const permissions = getPermissions();
    const startedWithLogs = permissions['deploy.logs'] === true;
    const progress = createCommandProgress(p?.requestId, {
      target,
      isAllowed: () => commandVerdict('hub:manageDeploy', p).allowed,
    });
    try {
      const result = await handleHubDeployCommand(p, {
        permissions,
        recheck: stillAllowed,
        onFinished: () => {
          if (commandVerdict('hub:manageDeploy', p).allowed) pushDeployApps({ target });
        },
        onProgress: guardSideEffect('hub:manageDeploy', p, progress),
      });
      if (startedWithLogs && getPermissions()['deploy.logs'] !== true) {
        const error = new Error('Permission was revoked while the deployment command was running, so its result was withheld.');
        error.code = 'HUB_PERMISSION_REVOKED';
        throw error;
      }
      return result;
    } finally {
      // Whatever the action was, the list is the thing that may have changed.
      const allowedNow = commandVerdict('hub:manageDeploy', p).allowed;
      if (allowedNow && !['list', 'detail', 'run', 'github', 'getEnv'].includes(p?.action)) {
        pushDeployApps({ target });
      }
      // Linking or deleting with a domain changes the domain list too.
      if (allowedNow && ['linkDomain', 'delete'].includes(p?.action)) {
        pushDomainConfigs({ target }); pushDomainHealth({ target }); notifyLocalDashboard('domains');
      }
    }
  }, ack, { target });
}

export async function handleDeployHook(
  payload,
  ack,
  { loadHubDeployHook = () => import('../deploy/hubCommands.js'), target = socket } = {},
) {
  return runCommand('hub:deployHook', payload, async (p, stillAllowed) => {
    const { handleHubDeployHook } = await loadHubDeployHook();
    stillAllowed();
    const startedWithLogs = getPermissions()['deploy.logs'] === true;
    const result = await handleHubDeployHook(p, {
      permissions: getPermissions(),
      onFinished: () => {
          if (commandVerdict('hub:deployHook', p).allowed) pushDeployApps({ target });
      },
    });
    if (startedWithLogs && getPermissions()['deploy.logs'] !== true) {
      const error = new Error('Permission was revoked while the CI status was loading, so its result was withheld.');
      error.code = 'HUB_PERMISSION_REVOKED';
      throw error;
    }
    if (result?.started) {
      stillAllowed();
      pushDeployApps({ target });
    }
    return result;
  }, ack, { target });
}

/**
 * Starts, stops or restarts one PM2 process, mirroring the dashboard's own
 * processes controller.
 *
 * The checks are the same ones, in the same order, and they are deliberately
 * repeated here rather than trusted from the Hub: the Hub's copy of the
 * permission map is a hint, and its process list is whatever the agent last
 * pushed. The agent is the only place that sees the real PM2 state of this
 * machine.
 */
export async function handleManageProcess(
  payload,
  ack,
  { runner: processRunner = runner, target = socket } = {},
) {
  return runCommand('hub:manageProcess', payload, async ({ action, name }, stillAllowed) => {
    const processActions = {
      // PM2 "start" for an app that exists is a restart.
      start: processRunner.restart,
      restart: processRunner.restart,
      stop: processRunner.stop,
    };
    const fn = processActions[action];
    if (!fn) throw new Error(`Unknown process action: ${action}`);
    if (typeof name !== 'string' || !name.trim()) throw new Error('A process name is required');
    if (name.length > 200) throw new Error('That process name is too long');

    const pm2 = await processRunner.detect();
    if (!pm2.installed) throw new Error('PM2 is not installed on this server');
    const pm2Path = pm2.path ?? 'pm2';

    // Only act on something PM2 actually knows, so a typo cannot be reported
    // as a success.
    const listed = await processRunner.list({ pm2Path });
    if (!listed.ok) throw new Error(listed.error || 'Could not read the PM2 process list');
    const app = listed.apps.find((a) => a.name === name);
    if (!app) throw new Error(`PM2 has no process named "${name}"`);

    // PM2 keeps one process list per OS user; another account's app may be
    // visible but cannot be controlled from this process.
    if (app.user && app.user !== processRunner.currentUser()) {
      throw new Error(
        `"${name}" belongs to OS user "${app.user}", not "${processRunner.currentUser()}". `
        + 'PM2 keeps a separate process list per user. Sign in as that user to control it.',
      );
    }

    // detect() and list() can both be slow on a cold Windows host. A
    // revocation that arrived during discovery must prevent the mutation.
    stillAllowed();
    const result = await fn(name, { pm2Path });
    if (!result.ok) throw new Error(result.output || `pm2 ${action} failed`);

    // The Hub's process table is fed by this push; without it the row would
    // keep showing the old status until the next 60-second heartbeat.
    stillAllowed();
    pushProcesses({ target });
    return { name, action, managed: Boolean(app.managed), output: result.output ?? '' };
  }, ack, { target });
}

// ─── Permission + revision sync ───────────────────────────────────────────────

/**
 * Sends the permission catalog and the current state to the Hub.
 * Called on connect and whenever permissions change, so the Hub UI can grey
 * out actions immediately instead of waiting for a poll.
 */
export function pushPermissions({ target = socket } = {}) {
  if (!target?.connected) return;
  try {
    target.emit('permissions:state', {
      tree: PERMISSION_TREE,
      permissions: getHubPermissions(),
      comingSoon: COMING_SOON_PERMISSION_IDS,
    });
  } catch { /* non-fatal */ }
}

/**
 * Watches the shared revision counter.
 *
 * The CLI runs in a different process from the agent, so an in-process event
 * cannot reach here. core/hubLink.js bumps a counter in SQLite on every change
 * the Hub should learn about; polling it is a cheap read and only triggers a
 * push when it actually moved — far better than the old 5-minute interval.
 */
let lastRevision = -1;

/**
 * Serialize revision refreshes and collapse requests that arrive while one is
 * running into one follow-up pass. The follow-up re-reads the counter, so an
 * older, slower telemetry build can never finish after a newer revision.
 */
export function createSerializedRevisionRunner(runOnce, { isConnected = () => true } = {}) {
  let current = null;
  let queued = false;

  return function requestRun() {
    if (current) {
      queued = true;
      return current;
    }
    current = (async () => {
      do {
        queued = false;
        await runOnce();
      } while (queued && isConnected());
    })().finally(() => {
      current = null;
    });
    return current;
  };
}

export async function refreshRevisionOnce({
  target = socket,
  revision = getHubRevision(),
  permissionSnapshot = null,
  pushServerInfoFn = pushServerInfo,
  pushDomainConfigsFn = pushDomainConfigs,
  pushDomainHealthFn = pushDomainHealth,
  pushCertExpiryFn = pushCertExpiry,
  pushServiceStateFn = pushServiceState,
  pushDeployAppsFn = pushDeployApps,
} = {}) {
  if (!target?.connected) return;
  const rev = revision;
  if (rev === lastRevision) return;
  lastRevision = rev;

  pushPermissions({ target });
  const permissions = permissionSnapshot ?? getPermissions();
  // Revocation is time-sensitive and does not need a PM2 call. Redact the
  // already-emitted snapshot now, then refresh PM2 state in the background.
  emitCachedDeployAppsAfterRevocation(permissions, { target });
  // `sslDir` is configuration data too. Re-send it so a view revocation
  // replaces a path the Hub already learned instead of waiting for the next
  // reconnect, and a grant makes it available without a restart.
  await Promise.all([
    pushServerInfoFn({ target }),
    pushDomainConfigsFn({ target }),
    pushDomainHealthFn({ target }),
    pushCertExpiryFn({ target }),
    pushServiceStateFn({ target }),
    pushDeployAppsFn({ target }),
  ]);
}

/**
 * Re-reads the shared revision for every serialized pass. If revision N+1
 * arrives while N is still refreshing, the queued pass sees N+1 rather than
 * repeating the stale value captured by the caller.
 */
export function createHubRevisionRefreshRunner({
  readRevision = getHubRevision,
  refresh = refreshRevisionOnce,
  isConnected = () => Boolean(socket?.connected),
} = {}) {
  return createSerializedRevisionRunner(async () => {
    try {
      const revision = readRevision();
      await refresh({ revision, target: socket });
    } catch { /* non-fatal telemetry refresh */ }
  }, { isConnected });
}

const checkRevision = createHubRevisionRefreshRunner();

/**
 * Tells any open dashboard that something changed, so the UI refreshes the
 * affected section without a page reload.
 *
 * This used to call the socket layer directly, which is what tied the agent to
 * a process that had a Socket.io server in it. It now publishes to the job bus,
 * and the transport is someone else's problem: a dashboard running the jobs
 * itself forwards it to its own browsers, and the daemon forwards it over IPC
 * to a dashboard in another process. The payload is unchanged, so
 * API-CONTRACT.md still describes it exactly.
 *
 * @param {'domains'|'ssl'|'nginx'|'settings'} section
 */
function notifyLocalDashboard(section) {
  try {
    publish('local:changed', { section, source: 'hub', at: Date.now() });
  } catch { /* never let a listener break a hub command */ }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

function startHeartbeats() {
  stopHeartbeats(); // clear any existing intervals first
  lastProjectedDeployApps = [];
  lastDeployLogsGranted = null;

  // Forget the revision we had last pushed. Anything could have changed while
  // the socket was down, and the hub may have been restarted or re-seeded, so
  // the next poll must be allowed to push even if the counter has not moved.
  lastRevision = -1;
  intervals.push(setInterval(pushNginxStatus, 5_000));
  intervals.push(setInterval(pushResources, 30_000));
  intervals.push(setInterval(pushDomainHealth, 60_000));
  intervals.push(setInterval(pushDomainConfigs, 5 * 60_000));
  intervals.push(setInterval(pushChannelsList, 5 * 60_000));
  intervals.push(setInterval(pushCertExpiry, 12 * 60 * 60 * 1000));
  // Both of these shell out to PM2, so they are deliberately infrequent.
  intervals.push(setInterval(pushServiceState, 5 * 60_000));
  intervals.push(setInterval(pushProcesses, 60_000));
  // A deployment can be started from the dashboard or by CI, in another
  // process, so the Hub learns about it from this rather than from an event.
  intervals.push(setInterval(pushDeployApps, 20_000));
  // Cheap shared signal so CLI-side changes reach the Hub in seconds.
  intervals.push(setInterval(checkRevision, REVISION_POLL_MS));
  // Push immediately on connect
  pushNginxStatus();
  pushResources();
  pushDomainHealth();
  pushDomainConfigs();
  pushChannelsList();
  pushCertExpiry();
  pushPermissions();
  pushServiceState();
  pushProcesses();
  pushDeployApps();
}

function stopHeartbeats() {
  for (const id of intervals) clearInterval(id);
  intervals = [];
}

function cancelRejoin() {
  if (rejoinTimer) {
    clearTimeout(rejoinTimer);
    rejoinTimer = null;
  }
  rejoinDelay = 0;
}

/**
 * Binds one command to the exact socket instance that received it.
 *
 * Socket.IO handlers live for the lifetime of their client. Re-pairing replaces
 * that client, so a handler that later writes through the module-level
 * `socket` would deliver an old command's result or progress to the new Hub.
 * Keeping the source instance in the handler context prevents that hand-off.
 */
export function bindCommandSocket(target, event, handler) {
  target.on(event, (payload, ack) => handler(payload, ack, { target }));
}

export function initHubAgent({ commandHandlers = null } = {}) {
  const link = getHubLink();
  if (!link) {
    setState(HUB_AGENT_STATUS.NOT_LINKED, null, 0);
    return;
  }

  const { hubUrl, serverId, secret } = link;
  const url = resolveHubOrigin(hubUrl);

  // Tear down any existing socket FIRST.
  //
  // This is the fix for a connection flap that looked like a hub problem.
  // Reassigning `socket` below without disconnecting the old one left it
  // CONNECTED but unreferenced — and the hub keeps one socket per serverId
  // (agentServer.ts), evicting the older when a second arrives. The evicted
  // client sees 'io server disconnect', re-dials, and evicts the other one:
  // two sockets taking turns, "Connected"/"Disconnected" every few seconds,
  // for ever. Reproduced against a test hub, which counted two live sockets
  // from a single process.
  //
  // So this function is now idempotent: calling it twice leaves exactly one
  // socket. That matters because it is reachable from more than one place —
  // the job owner starts it, and re-pairing restarts it.
  stopHubAgent();

  // Recorded AFTER the teardown, because stopHubAgent() clears it. Setting it
  // first left it null, so the next reconcile saw a mismatch and redialled —
  // the very churn this signature exists to prevent.
  activeLink = linkSignature(link);

  cancelRejoin();
  setState(HUB_AGENT_STATUS.CONNECTING, null, 0);

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
    cancelRejoin();
    setState(HUB_AGENT_STATUS.CONNECTED, null, 0);
    pushServerInfo();
    startHeartbeats();
    startDeployProgress({
      emit: (event, payload) => {
        if (socket === self && self.connected) self.emit(event, payload);
      },
      onAppsChanged: () => pushDeployApps(),
    });
  });

  self.on('disconnect', (reason) => {
    if (!isCurrent()) return;
    console.log('[hubAgent] Disconnected:', reason);
    stopDeployProgress();
    stopHeartbeats();

    if (agentState.status === HUB_AGENT_STATUS.CONNECTED) {
      setState(HUB_AGENT_STATUS.CONNECTING, null);
    }

    // 'io server disconnect' means the hub closed us deliberately — the most
    // common cause is a rotated secret. socket.io will not retry on its own
    // for this reason, so re-dial here: the next handshake either succeeds or
    // fails with INVALID_SECRET, which is how we reach the 'rejected' state.
    if (reason === 'io server disconnect') scheduleRejoin();
  });

  /** Manual re-dial with its own capped backoff (socket.io's is not used here). */
  function scheduleRejoin() {
    if (rejoinTimer) return;

    rejoinDelay = rejoinDelay
      ? Math.min(rejoinDelay * 2, RECONNECT_DELAY_MAX)
      : RECONNECT_DELAY_MIN;

    rejoinTimer = setTimeout(() => {
      rejoinTimer = null;
      if (!isCurrent()) return;
      // A rejection already decided the outcome; do not fight it.
      if (agentState.status === HUB_AGENT_STATUS.REJECTED) return;
      try {
        self.connect();
      } catch { /* manager torn down */ }
    }, rejoinDelay);
  }

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
      cancelRejoin();
      setState(HUB_AGENT_STATUS.REJECTED, describeRejection(message));
      stopDeployProgress();
      stopHeartbeats();
      return;
    }

    if (!isCurrent()) return;

    // A manual re-dial that fails on the transport gets its own retry, since
    // socket.io's backoff is not driving this attempt.
    if (!self.active) scheduleRejoin();

    // Transport/network failure — socket.io keeps retrying with backoff.
    setState(
      HUB_AGENT_STATUS.UNREACHABLE,
      `Cannot reach the hub (${message}). Retrying...`,
      agentState.attempts + 1,
    );
    console.error('[hubAgent] Connection error:', message);
  });

  const handlers = {
    'hub:reloadNginx': handleReloadNginx,
    'hub:manageDomain': handleManageDomain,
    'hub:manageSSL': handleManageSSL,
    'hub:nginxAction': handleNginxAction,
    'hub:getConfigs': handleGetConfigs,
    'hub:saveConfig': handleSaveConfig,
    'hub:getLogs': handleGetLogs,
    'hub:manageDeploy': handleManageDeploy,
    'hub:deployHook': handleDeployHook,
    'hub:manageProcess': handleManageProcess,
    ...(commandHandlers ?? {}),
  };
  for (const [event, handler] of Object.entries(handlers)) {
    if (typeof handler === 'function') bindCommandSocket(self, event, handler);
  }
}

/**
 * Identity of the pairing a socket was started with.
 *
 * Used to decide whether a stored pairing CHANGED, which is a different
 * question from whether the agent happens to be connected right now. The
 * secret is included as a hash so a rotated secret counts as a change, and
 * never as plain text — this value is compared, logged and kept in memory.
 */
function linkSignature(link) {
  if (!link) return null;
  const secretMark = createHash('sha256').update(String(link.secret ?? '')).digest('hex').slice(0, 12);
  return `${resolveHubOrigin(link.hubUrl)}|${link.serverId}|${secretMark}`;
}

/** The signature the current socket was created for, or null when stopped. */
let activeLink = null;

/**
 * Brings the agent into line with the stored pairing, and does nothing
 * otherwise.
 *
 * Called by the job owner when the shared revision counter moves, which is how
 * a pairing made in the dashboard or the CLI reaches the process that actually
 * holds the agent.
 *
 * ── Why this compares identity, not connectedness ──────────────────────────
 *
 * The first version re-ran `initHubAgent()` whenever the agent was not
 * CONNECTED. That looked harmless and was not: the revision counter also moves
 * on every domain, certificate and permission change, so a busy server tore
 * the socket down and redialled it repeatedly — including while it was still
 * mid-connect, which is a perfectly normal state. It showed up as Hub updates
 * arriving seconds late.
 *
 * So a socket that exists and was created for the pairing that is still stored
 * is left strictly alone, connected or not: socket.io's own reconnection is
 * what handles a transport problem, and this function must not fight it.
 *
 * @returns {{ action: 'none'|'started'|'restarted'|'stopped', reason: string }}
 */
export function reconcileHubAgent() {
  const link = getHubLink();

  if (!link) {
    if (!socket && !activeLink) return { action: 'none', reason: 'not linked, no agent running' };
    stopHubAgent();
    return { action: 'stopped', reason: 'the pairing was removed' };
  }

  const wanted = linkSignature(link);

  if (!socket) {
    initHubAgent();
    return { action: 'started', reason: 'a pairing exists but no agent was running' };
  }

  if (activeLink !== wanted) {
    initHubAgent();
    return { action: 'restarted', reason: 'the pairing changed' };
  }

  return { action: 'none', reason: 'the agent already matches the stored pairing' };
}

export function stopHubAgent() {
  stopDeployProgress();
  stopHeartbeats();
  cancelRejoin();
  activeLink = null;
  if (socket) {
    try {
      socket.io.reconnection(false);
    } catch { /* manager already gone */ }
    socket.disconnect();
    socket = null;
  }
  setState(HUB_AGENT_STATUS.NOT_LINKED, null, 0);
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
