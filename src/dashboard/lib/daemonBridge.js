/**
 * dashboard/lib/daemonBridge.js
 *
 * The dashboard's end of the daemon's event channel.
 *
 * It connects to the daemon's IPC socket and REPUBLISHES every frame onto this
 * process's job bus. That one decision is what keeps the rest of the dashboard
 * simple: dashboard/socketManager.js subscribes to the bus and nothing else,
 * so it does not care whether an event came from monitors running here or from
 * a daemon in another process. There is exactly one path to the browser.
 *
 * The two cases never overlap. When a daemon is running, core/jobs/index.js
 * stops this process's monitors, so the only events on the bus are the ones
 * arriving over IPC. When no daemon is running, there is nothing to connect to
 * and the bus carries local events only.
 *
 * It also answers "is the service running?" for the banner — from the lock
 * file, not from whether the socket happens to be connected. A daemon that is
 * up but whose IPC failed to bind is still running the jobs, and telling the
 * user to install a service they already have would be worse than saying
 * nothing.
 */

import { connectToDaemon } from '../../core/daemon/ipc.js';
import { publish } from '../../core/jobs/bus.js';
import { inspect, watchLock } from '../../core/daemon/lock.js';
import { getDataDir } from '../../core/platform.js';
import { backgroundServiceState, invalidateProbes } from '../../core/service/index.js';

let bridge = null;
let hello = null;
let lockWatch = null;
let lastAnnounced = null;

/**
 * Starts the bridge. Safe to call when no daemon exists: the client retries
 * quietly with backoff and connects if one appears later.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @returns {{ stop: () => void, status: () => DaemonStatus }}
 *
 * @typedef {Object} DaemonStatus
 * @property {boolean} running    A daemon holds the lock
 * @property {boolean} connected  We have a live event channel to it
 * @property {number|null} pid
 * @property {string|null} version
 * @property {number|null} startedAt
 */
export function startDaemonBridge({ dataDir = getDataDir() } = {}) {
  stopDaemonBridge();

  bridge = connectToDaemon({
    dataDir,
    onEvent(event, payload) {
      if (event === 'daemon:hello') {
        // Identity, not an event the browser needs: the banner reads it from
        // status() instead.
        hello = payload;
        announce(dataDir);
        return;
      }
      publish(event, payload);
    },
    onStatus(connected, detail) {
      if (connected) {
        console.log('[daemonBridge] connected to the background service');
      } else {
        hello = null;
        // A daemon that stopped is not the same as one we cannot reach, and
        // saying "no event channel" for both was misleading during an ordinary
        // restart. The lock tells us which this is.
        const stillThere = inspect({ dataDir }).running;
        console.log(stillThere
          ? `[daemonBridge] lost the event channel to the running service (${detail ?? 'disconnected'}) — retrying`
          : '[daemonBridge] the background service is not running');
      }
      announce(dataDir);
    },
  });

  // The lock is the authority on whether a daemon exists, and it changes the
  // instant one starts. Watching it does two things the backoff cannot:
  // reconnect the event channel immediately instead of waiting out a delay
  // computed from earlier failures, and tell the browser about the new state
  // at once.
  lockWatch = watchLock({
    dataDir,
    onChange() {
      if (inspect({ dataDir }).running) bridge?.reconnectNow();
      announce(dataDir);
    },
  });

  announce(dataDir);

  return { stop: stopDaemonBridge, status: daemonStatus, announce: () => announce(dataDir) };
}

/**
 * Publishes the background-service state to the browser, when it changes.
 *
 * Only on a real change: this is called from a lock watcher and from every
 * connect and disconnect, and a browser that re-rendered on each of those
 * would flicker during an ordinary restart.
 */
function announce(dataDir) {
  try {
    const next = daemonStatus({ dataDir });
    const signature = JSON.stringify(next);
    if (signature === lastAnnounced) return;
    lastAnnounced = signature;

    // The service state changed, so the cached probes in GET /api/service no
    // longer describe it. Dropped here rather than only on a TTL, because this
    // fires the moment a daemon appears or goes away - including when a change
    // was made by `ezz service start` in another process, which nothing in
    // THIS process would otherwise know about.
    invalidateProbes();

    publish('service:changed', next);
  } catch (err) {
    console.error('[daemonBridge] could not publish the service state:', err.message);
  }
}

/** Stops the bridge if one is running. Idempotent. */
export function stopDaemonBridge() {
  if (bridge) {
    bridge.close();
    bridge = null;
  }
  lockWatch?.close();
  lockWatch = null;
  hello = null;
  lastAnnounced = null;
}

/**
 * What the dashboard should tell the user about the background service.
 *
 * `running` comes from the lock file — the authority on whether a daemon
 * exists. `connected` is about this process's event channel to it, which is a
 * separate question and only affects how fresh the live view is.
 *
 * @param {Object} [opts]
 * @returns {DaemonStatus}
 */
export function daemonStatus({ dataDir = getDataDir() } = {}) {
  // Everything about the service itself comes from core, so the HTTP response
  // and the `service:changed` socket event carry the identical shape and the
  // UI has one type to render. Only `connected` is the bridge's own business —
  // it describes THIS process's event channel, not the service.
  const state = backgroundServiceState({ dataDir });

  return {
    ...state,
    connected: Boolean(bridge?.connected()),
    // The hello frame is the daemon's own word for its version; the lock is a
    // fallback for a daemon whose IPC never came up.
    version: hello?.version ?? state.version,
  };
}
