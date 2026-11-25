/**
 * dashboard/socketManager.js
 *
 * The browser-facing Socket.io layer. It no longer DOES any monitoring.
 *
 * It used to: nginx polling, domain health probes, certificate checks and the
 * notification decisions all lived here, driven by intervals that only ran
 * while a browser was connected. That is why none of it worked without an open
 * dashboard.
 *
 * All of it now lives in core/jobs/, runs in whichever process owns the jobs,
 * and arrives here as events on core/jobs/bus.js — published either by the
 * monitors in this process, or by the daemon over IPC and republished onto the
 * bus by dashboard/lib/daemonBridge.js. This module's whole job is to forward
 * them to connected browsers unchanged, which is why the bus uses the names
 * and payloads from API-CONTRACT.md.
 *
 * What is still genuinely socket work and stays here: the session and
 * local-request guards on the handshake, and the live log tails — a tail exists
 * only for a client that is watching it, and dies with that client.
 */

import { spawn } from 'child_process';
import { Server as SocketIO } from 'socket.io';

import { socketRequireAuth } from './lib/requireAuth.js';
import { socketRequireLocalRequest } from './lib/localRequest.js';
import { loadConfig } from '../core/config.js';
import { nginxLogPath } from '../core/platform.js';
import { subscribe, subscribeAll } from '../core/jobs/bus.js';

let connectedClients = 0;
const activeTails = new Map();

let ioServer = null;
let unsubscribeBus = null;
let unsubscribeSslProgress = null;

/** A socket client never receives an unbounded newline-free log fragment. */
export const MAX_SOCKET_LOG_LINE_BYTES = 16 * 1024;

/**
 * The most recent payload for each replayable event.
 *
 * A newly opened tab has to show something immediately. The monitors publish
 * on their own schedule — domain health every 60 seconds — so without this a
 * tab opened just after a poll would sit empty until the next one. Previously
 * the fix was to run a fresh poll per connection; that does not work when the
 * polling happens in another process, and it meant every opened tab triggered
 * real work.
 *
 * `service:changed` is cached for the same reason, and matters more: a tab
 * that opens while the daemon is already running must render the banner right
 * away rather than waiting for the next hand-over to tell it anything.
 *
 * Only the state-like events are cached. `notification:new` is not: it is a
 * discrete thing that happened, and replaying old notifications into each new
 * tab would announce outages that are long over.
 */
const REPLAYABLE = ['nginx:status', 'domain:health', 'service:changed'];
const lastKnown = new Map();

/**
 * Initialize the Socket.IO server.
 *
 * @param {import('http').Server} httpServer
 * @param {Function} sessionMiddleware Shared with Express so sockets see the same session
 * @param {Function} getBinding Returns the current { port, bindAddress }
 * @returns {import('socket.io').Server}
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

  // One subscription for the whole server, not one per client: these events are
  // broadcasts, and subscribing per socket would deliver each one as many times
  // as there are tabs open.
  unsubscribeBus = subscribeAll((event, payload) => {
    if (REPLAYABLE.includes(event)) lastKnown.set(event, payload);
    if (connectedClients > 0) io.emit(event, payload);
  });

  // `ssl:progress` is a moment in one certificate operation, never state, so
  // it is forwarded but deliberately not replayed. It is subscribed here
  // rather than added to JOB_EVENTS until API-CONTRACT.md documents it: the
  // contract check compares that list with the document, and the contract is
  // updated in its own change.
  unsubscribeSslProgress = subscribe('ssl:progress', (payload) => {
    if (connectedClients > 0) io.emit('ssl:progress', payload);
  });

  io.on('connection', (socket) => {
    connectedClients++;

    // Whatever we last heard, so the UI renders immediately instead of waiting
    // for the next poll in whichever process owns the jobs.
    for (const event of REPLAYABLE) {
      if (lastKnown.has(event)) socket.emit(event, lastKnown.get(event));
    }

    socket.on('logs:subscribe', ({ logFile } = {}) => startTail(socket, logFile || 'error'));
    socket.on('logs:unsubscribe', () => stopTail(socket.id));

    socket.on('disconnect', () => {
      connectedClients--;
      stopTail(socket.id);
    });
  });

  return io;
}

// ─── Live log tails ───────────────────────────────────────────────────────────

/**
 * Starts tailing a log file for one socket.
 *
 * `-n 50` / `-Tail 50` is what satisfies the contract's promise that a
 * subscribe replays the last 50 lines before streaming: the tail command does
 * both in one call, so there is no window between the replay and the live
 * stream in which a line could be missed.
 */
function startTail(socket, logFile) {
  stopTail(socket.id);

  const { nginxDir } = loadConfig();
  const logPath = nginxLogPath(nginxDir, logFile === 'access' ? 'access' : 'error');

  const args = process.platform === 'win32'
    ? ['Get-Content', '-Path', logPath, '-Wait', '-Tail', '50']
    : ['-n', '50', '-f', logPath];
  const cmd = process.platform === 'win32' ? 'powershell' : 'tail';

  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  let buf = Buffer.alloc(0);
  let droppedBytes = 0;
  const emitBufferedLine = (lineBuffer) => {
    let line = lineBuffer.toString('utf8').trim();
    if (droppedBytes > 0) {
      line = `[line truncated: ${droppedBytes} bytes] ${line}`;
      droppedBytes = 0;
    }
    if (line) socket.emit('logs:line', { line, logFile });
  };

  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let newline;
    while ((newline = buf.indexOf(0x0a)) !== -1) {
      emitBufferedLine(buf.subarray(0, newline));
      buf = buf.subarray(newline + 1);
    }

    if (buf.length > MAX_SOCKET_LOG_LINE_BYTES) {
      const drop = buf.length - MAX_SOCKET_LOG_LINE_BYTES;
      buf = buf.subarray(drop);
      droppedBytes += drop;
    }
  });

  child.on('error', () => {});
  child.on('close', () => {
    if (buf.length > 0) emitBufferedLine(buf);
    buf = Buffer.alloc(0);
    activeTails.delete(socket.id);
  });

  activeTails.set(socket.id, { process: child, logFile });
}

/** Stops the tail belonging to one socket. */
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
 * Stops everything initSocket() started: the bus subscription, every active
 * log tail (each is a spawned child process), and the Socket.io server itself.
 * Safe to call more than once.
 *
 * It does NOT stop the background jobs — server.js owns those, because their
 * lifetime is the process's, not the socket server's.
 *
 * @returns {Promise<void>} Resolves once the Socket.io server has closed
 */
async function stopSocket() {
  if (unsubscribeBus) {
    unsubscribeBus();
    unsubscribeBus = null;
  }

  if (unsubscribeSslProgress) {
    unsubscribeSslProgress();
    unsubscribeSslProgress = null;
  }

  // Kill the tail/Get-Content children; stopTail() removes each map entry.
  for (const socketId of [...activeTails.keys()]) stopTail(socketId);

  connectedClients = 0;
  lastKnown.clear();

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

export { initSocket, stopSocket };
