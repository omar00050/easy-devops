import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { Server as SocketIO } from 'socket.io';

import { getStatus } from './lib/nginx-service.js';
import { socketRequireAuth } from './lib/requireAuth.js';
import { socketRequireLocalRequest } from './lib/localRequest.js';
import { listAllCerts } from './lib/cert-reader.js';
import { loadConfig } from '../core/config.js';
import { dbGet } from '../core/db.js';
import {
  createNginxDownEvent,
  createNginxRecoveredEvent,
  createDomainDownEvent,
  createDomainRecoveredEvent,
} from '../core/events.js';
import { sendNotification } from '../core/notifier.js';
import {
  getEffectiveChannelIds,
  getAllDomainChannelIds,
  shouldSendNotification,
} from '../core/domainNotifier.js';

let connectedClients = 0;
const activeTails = new Map();

// Handles kept so stopSocket() can shut everything down cleanly.
const pollTimers = [];
let ioServer = null;

/**
 * Emit nginx status and handle notification state transitions.
 * Uses state tracking to prevent spam and support recovery notifications.
 */
async function emitNginxStatus(target) {
  try {
    const status = await getStatus();
    target.emit('nginx:status', status);

    const currentStatus = status.running ? 'up' : 'down';
    const decision = shouldSendNotification(null, 'nginx_down', currentStatus);

    if (decision.shouldNotify) {
      let event;
      if (decision.reason === 'recovery') {
        event = createNginxRecoveredEvent();
      } else {
        event = createNginxDownEvent();
      }

      console.log(`[socketManager] Sending nginx notification: ${decision.reason}`);
      target.emit('notification:new', event);

      // External channel routing (fire-and-forget, isolated)
      try {
        const channels = getAllDomainChannelIds('nginx_down');
        await sendNotification(event, channels);
      } catch (err) {
        console.error('[socketManager] sendNotification failed:', err.message);
      }
    }
  } catch (err) {
    target.emit('nginx:status', { running: false, version: null, pid: null, error: err.message });
  }
}

/**
 * Emit cert expiry notifications.
 * Note: Cert expiry doesn't use state tracking because it's a time-based event,
 * not a state transition. We notify whenever a cert is expiring, regardless of
 * whether we notified before.
 */
async function emitCertNotifications(target) {
  try {
    const certs = await listAllCerts();
    for (const cert of certs) {
      if (cert.daysLeft !== null && cert.daysLeft < 30) {
        const event = {
          id: `cert-expiry-${cert.domain}-${Date.now()}`,
          type: 'cert_expiry',
          severity: cert.daysLeft < 10 ? 'danger' : 'warning',
          message: `🔒 SSL cert for ${cert.domain} expires in ${cert.daysLeft} day${cert.daysLeft === 1 ? '' : 's'}`,
          domain: cert.domain,
          timestamp: Date.now(),
        };
        target.emit('notification:new', event);

        // External channel routing (fire-and-forget, isolated)
        try {
          const channels = getEffectiveChannelIds(cert.domain, 'cert_expiry');
          await sendNotification(event, channels);
        } catch (err) {
          console.error('[socketManager] sendNotification failed:', err.message);
        }
      }
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Check if a domain backend is responding.
 */
function checkDomainHealth(host, port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port: Number(port),
        path: '/',
        method: 'HEAD',
        timeout: 5000,
      },
      (res) => {
        resolve({ up: true, status: res.statusCode });
        res.resume();
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ up: false });
    });
    req.on('error', () => resolve({ up: false }));
    req.end();
  });
}

/**
 * Emit domain health status and handle notification state transitions.
 * Uses state tracking to:
 * 1. Prevent spam (don't re-notify if already down)
 * 2. Send recovery notifications when domain comes back up
 */
async function emitDomainHealth(target) {
  try {
    const domains = dbGet('domains') || [];
    const results = await Promise.all(
      domains.map(async (d) => {
        const host = d.backendHost || '127.0.0.1';
        const port = d.port || 80;

        // Skip external URL backends
        if (typeof host === 'string' && host.startsWith('http')) return { name: d.name, up: null };

        const { up } = await checkDomainHealth(host, port);
        return { name: d.name, up, port, host };
      })
    );

    target.emit('domain:health', results);

    // Process state transitions for each domain
    for (const result of results) {
      if (result.up === null) continue; // Skip external URL backends

      const currentStatus = result.up ? 'up' : 'down';
      const decision = shouldSendNotification(result.name, 'domain_health', currentStatus);

      if (decision.shouldNotify) {
        let event;
        if (decision.reason === 'recovery') {
          event = createDomainRecoveredEvent(result.name, result.port);
        } else {
          event = createDomainDownEvent(result.name, result.port);
        }

        console.log(`[socketManager] Sending domain health notification for ${result.name}: ${decision.reason}`);
        target.emit('notification:new', event);

        try {
          const channelIds = getEffectiveChannelIds(result.name, 'domain_health');
          await sendNotification(event, channelIds);
        } catch (err) {
          console.error('[socketManager] domain health sendNotification failed:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('[socketManager] emitDomainHealth error:', err.message);
  }
}

/**
 * Get the path to a log file.
 */
function getLogPath(logFile) {
  const { nginxDir } = loadConfig();
  const file = logFile === 'access' ? 'access.log' : 'error.log';

  // Linux standard path first, fall back to nginxDir/logs/
  if (process.platform !== 'win32') {
    return `/var/log/nginx/${file}`;
  }
  return path.join(nginxDir, 'logs', file);
}

/**
 * Start tailing a log file for a socket.
 */
function startTail(socket, logFile) {
  // Kill any existing tail for this socket
  stopTail(socket.id);

  const logPath = getLogPath(logFile);
  const args = process.platform === 'win32'
    ? ['Get-Content', '-Path', logPath, '-Wait', '-Tail', '50']
    : ['-n', '50', '-f', logPath];
  const cmd = process.platform === 'win32' ? 'powershell' : 'tail';

  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      if (line.trim()) socket.emit('logs:line', { line: line.trim(), logFile });
    }
  });

  child.on('error', () => {});
  child.on('close', () => {
    activeTails.delete(socket.id);
  });

  activeTails.set(socket.id, { process: child, logFile });
}

/**
 * Stop tailing a log file for a socket.
 */
function stopTail(socketId) {
  const entry = activeTails.get(socketId);
  if (entry) {
    try {
      entry.process.kill();
    } catch {}
    activeTails.delete(socketId);
  }
}

/**
 * Initialize the Socket.IO server.
 */
function initSocket(httpServer, sessionMiddleware, getBinding) {
  const io = new SocketIO(httpServer);
  ioServer = io;

  // The socket stream is not a lesser surface than the REST API: it carries
  // nginx status, domain health and live log tails. It gets the same session
  // check.
  //
  // `io.engine.use` runs the express-session middleware on the handshake
  // request, which is what puts `socket.request.session` in place for
  // socketRequireAuth to read. Without the middleware there is no session
  // object at all, and the guard then refuses every connection — which is the
  // correct direction to fail, but would break the dashboard, so it is worth
  // noticing rather than shipping.
  if (typeof sessionMiddleware === 'function') {
    io.engine.use(sessionMiddleware);
  } else {
    console.error('[socketManager] no session middleware supplied — refusing all socket connections');
  }

  // Host / Origin / X-EZ-Request, before the session check — the handshake is
  // as reachable from a hostile page as any POST is, and a socket has no
  // "safe method", so the custom header is required unconditionally.
  //
  // This is why the browser client must NOT force transports: ['websocket']:
  // browsers cannot set headers on a WebSocket upgrade. socket.io's default
  // starts with HTTP polling, where extraHeaders does apply, and the
  // handshake is authenticated there before any upgrade happens.
  if (typeof getBinding === 'function') {
    io.use(socketRequireLocalRequest(getBinding));
  } else {
    console.error('[socketManager] no binding supplied — refusing all socket connections');
    io.use((socket, next) => next(new Error('FORBIDDEN')));
  }

  io.use(socketRequireAuth);

  io.on('connection', (socket) => {
    connectedClients++;

    emitNginxStatus(socket);
    emitCertNotifications(socket);

    socket.on('logs:subscribe', ({ logFile }) => startTail(socket, logFile || 'error'));
    socket.on('logs:unsubscribe', () => stopTail(socket.id));

    // Send initial domain health on connect
    emitDomainHealth(socket);

    socket.on('disconnect', () => {
      connectedClients--;
      stopTail(socket.id);
    });
  });

  // Tracked so stopSocket() can clear them — otherwise these keep the event
  // loop alive and the process never exits on Ctrl+C.
  pollTimers.push(
    // Poll domain health every 60 seconds
    setInterval(() => {
      if (connectedClients > 0) emitDomainHealth(io);
    }, 60_000),

    // Broadcast nginx status to all clients every 5 seconds
    setInterval(() => {
      if (connectedClients > 0) emitNginxStatus(io);
    }, 5000),

    // Check cert expiry every 12 hours
    setInterval(() => {
      if (connectedClients > 0) emitCertNotifications(io);
    }, 12 * 60 * 60 * 1000)
  );

  return io;
}

/**
 * Tells every open dashboard tab that a section changed, so the UI can refresh
 * just that part instead of reloading the page.
 *
 * Used when a change did NOT originate in this browser — most importantly when
 * the Hub applies a command through hubAgent.js. Without it an operator
 * watching the local dashboard would see stale data after a remote action.
 *
 * Safe to call before initSocket(): it simply does nothing.
 *
 * @param {'domains'|'ssl'|'nginx'|'settings'} section
 * @param {Object} [detail] Optional extra context for the client
 */
function emitLocalChange(section, detail = {}) {
  if (!ioServer) return;
  try {
    ioServer.emit('local:changed', { section, source: 'hub', at: Date.now(), ...detail });
  } catch { /* non-fatal */ }
}

/**
 * Stops everything initSocket() started: the polling intervals, every active
 * log tail (each is a spawned child process), and the Socket.io server itself.
 * Safe to call more than once.
 *
 * @returns {Promise<void>} Resolves once the Socket.io server has closed
 */
async function stopSocket() {
  for (const id of pollTimers) clearInterval(id);
  pollTimers.length = 0;

  // Kill the tail/Get-Content children; stopTail() removes each map entry.
  for (const socketId of [...activeTails.keys()]) stopTail(socketId);

  connectedClients = 0;

  const io = ioServer;
  ioServer = null;
  if (!io) return;

  await new Promise((resolve) => {
    // close() disconnects clients and stops accepting new ones. It is given a
    // short grace period so a wedged client cannot block shutdown.
    const done = setTimeout(resolve, 2000);
    io.close(() => {
      clearTimeout(done);
      resolve();
    });
  });
}

export { initSocket, stopSocket, emitLocalChange };
