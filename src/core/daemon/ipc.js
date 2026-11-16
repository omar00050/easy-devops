/**
 * core/daemon/ipc.js
 *
 * How live events get from the daemon to an open dashboard in another process.
 *
 * A named pipe on Windows, a Unix socket in the data directory elsewhere (see
 * `daemonIpcPath()` in core/platform.js). Deliberately NOT an HTTP port: the
 * daemon must not open one — a port is reachable from the network stack and
 * would need its own authentication, binding policy and firewall story, all to
 * carry events that are already available to anyone who can read the data
 * directory.
 *
 * ── The protocol, and why it is one-way ────────────────────────────────────
 *
 * Newline-delimited JSON, server to client only:
 *
 *   {"event":"nginx:status","payload":{...}}
 *
 * The server accepts NO commands. Nothing a client writes can make the daemon
 * do anything — the read side is drained and ignored. This is a security
 * decision, not laziness: the daemon may run as a Windows service account with
 * access the dashboard user does not have, and a named pipe's default ACL is
 * more permissive than people expect. A channel that cannot be asked to do
 * anything cannot be used to escalate.
 *
 * So what about the other direction? Changes made in the dashboard or the CLI
 * reach the daemon through the database: the revision counter in
 * core/jobs/revisionWatcher.js, which every process already polls. Slower than
 * a message, and entirely sufficient for "something changed, re-read it".
 *
 * ── Why the payloads are the contract's payloads ───────────────────────────
 *
 * The event names and shapes are the ones in docs/api-contract.md, so the
 * dashboard forwards each frame to the browser unchanged. Anything else would
 * mean two schemas describing the same data.
 */

import net from 'net';
import fs from 'fs';

import { daemonIpcPath, getDataDir, isWindows } from '../platform.js';
import { JOB_EVENTS, subscribeAll } from '../jobs/bus.js';

/** Reconnect backoff for a client that cannot reach the daemon. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/** A single frame may not exceed this, to bound a client's buffer. */
const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * Starts the daemon's event server and forwards every bus event to it.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {() => Object} [opts.hello] Builds the state frame a new client gets
 * @returns {Promise<{ close: () => Promise<void>, path: string, clients: () => number }>}
 */
export async function startIpcServer({ dataDir = getDataDir(), hello = null } = {}) {
  const socketPath = daemonIpcPath(dataDir);

  // A Unix socket file left behind by a crash makes bind() fail with EADDRINUSE
  // even though nothing is listening. Removing it is safe here because the
  // daemon lock has already established that we are the only daemon — without
  // that guarantee this would be how two daemons steal the socket from each
  // other. Windows named pipes need no equivalent: the name disappears with
  // the process that created it.
  if (!isWindows) {
    try {
      fs.unlinkSync(socketPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /** @type {Set<net.Socket>} */
  const clients = new Set();

  const server = net.createServer((socket) => {
    clients.add(socket);

    // Never buffer indefinitely for a client that has stopped reading: a
    // wedged dashboard tab must not grow the daemon's memory without bound.
    socket.setNoDelay(true);

    // The read side carries nothing we act on. It is still drained, because an
    // un-read stream applies backpressure that would eventually stall the
    // client's writes and look like a hang.
    socket.resume();

    socket.on('error', () => { /* a client that vanishes is normal */ });
    socket.on('close', () => clients.delete(socket));

    if (hello) {
      try {
        writeFrame(socket, 'daemon:hello', hello());
      } catch { /* client went away between connect and hello */ }
    }
  });

  server.on('error', (err) => {
    console.error('[ipc] server error:', err.message);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // Owner-only. The socket inherits the data directory's permissions, but the
  // directory may be group-readable on a shared machine and the socket should
  // not widen that. Not applicable to a Windows named pipe.
  if (!isWindows) {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch { /* best effort: a failure here does not justify no IPC at all */ }
  }

  const unsubscribe = subscribeAll((event, payload) => {
    for (const socket of clients) {
      try {
        writeFrame(socket, event, payload);
      } catch {
        clients.delete(socket);
      }
    }
  });

  return {
    path: socketPath,
    clients: () => clients.size,
    async close() {
      unsubscribe();
      for (const socket of clients) socket.destroy();
      clients.clear();

      await new Promise((resolve) => {
        const done = setTimeout(resolve, 2_000);
        server.close(() => { clearTimeout(done); resolve(); });
      });

      if (!isWindows) {
        try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
      }
    },
  };
}

/**
 * Connects to a running daemon and calls back for every event it sends.
 *
 * Reconnects for ever with capped backoff, because the daemon legitimately
 * comes and goes (a service restart, an upgrade) and a dashboard that gave up
 * after one failure would silently stop showing live data.
 *
 * @param {Object} opts
 * @param {(event: string, payload: *) => void} opts.onEvent
 * @param {(connected: boolean, detail?: string) => void} [opts.onStatus]
 * @param {string} [opts.dataDir]
 * @returns {{ close: () => void, connected: () => boolean, path: string }}
 */
export function connectToDaemon({ onEvent, onStatus = null, dataDir = getDataDir() } = {}) {
  const socketPath = daemonIpcPath(dataDir);

  let socket = null;
  let closed = false;
  let connected = false;
  let delay = RECONNECT_MIN_MS;
  let retryTimer = null;

  const setStatus = (value, detail) => {
    if (connected === value) return;
    connected = value;
    if (onStatus) {
      try { onStatus(value, detail); } catch { /* listener's problem */ }
    }
  };

  const scheduleRetry = () => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, delay);
    // Exponential up to the cap: a daemon that is not installed at all must
    // not mean a connection attempt every second for the life of the process.
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  };

  function open() {
    if (closed) return;

    let buffer = '';
    socket = net.createConnection(socketPath);

    socket.on('connect', () => {
      delay = RECONNECT_MIN_MS;
      setStatus(true);
    });

    socket.on('data', (chunk) => {
      buffer += chunk;

      if (buffer.length > MAX_FRAME_BYTES) {
        // A frame this large means the stream is out of sync or the peer is
        // not what we think it is. Dropping the connection re-syncs on a frame
        // boundary; keeping it would grow memory with no way back.
        console.error('[ipc] frame too large - reconnecting');
        buffer = '';
        socket.destroy();
        return;
      }

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue; // a malformed frame is skipped, not fatal
        }

        // Only names the contract knows. An unexpected name is ignored rather
        // than forwarded: the dashboard passes these straight to the browser,
        // so this is the boundary where that list is enforced.
        if (frame?.event === 'daemon:hello' || JOB_EVENTS.includes(frame?.event)) {
          try {
            onEvent(frame.event, frame.payload);
          } catch (err) {
            console.error('[ipc] event handler threw:', err.message);
          }
        }
      }
    });

    const drop = (detail) => {
      setStatus(false, detail);
      socket?.destroy();
      socket = null;
      scheduleRetry();
    };

    socket.on('error', (err) => drop(err.code || err.message));
    socket.on('close', () => drop('closed'));
  }

  open();

  return {
    path: socketPath,
    connected: () => connected,

    /**
     * Connects right now, discarding any pending backoff.
     *
     * The backoff only resets on a successful connect, so after a daemon has
     * been up and down a few times the next attempt can be fifteen seconds
     * away. That is correct for "the service is not installed" and wrong for
     * "a new daemon just appeared": the dashboard then logged
     * "no event channel (closed)", missed the new daemon, and its ownership
     * poll took the jobs back. The caller watches the daemon lock and calls
     * this the moment one appears.
     */
    reconnectNow() {
      if (closed || connected) return;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      delay = RECONNECT_MIN_MS;
      open();
    },

    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      socket?.destroy();
      socket = null;
      connected = false;
    },
  };
}

/** One newline-delimited JSON frame. */
function writeFrame(socket, event, payload) {
  socket.write(`${JSON.stringify({ event, payload })}\n`);
}
