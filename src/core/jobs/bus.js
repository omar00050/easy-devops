/**
 * core/jobs/bus.js
 *
 * The in-process channel between whatever is running the background jobs and
 * whatever wants to show their output.
 *
 * Before this existed, the monitors WERE the socket layer: they polled nginx
 * and called `target.emit(...)` directly, so they could only run inside a
 * process that had a Socket.io server. That is precisely what stopped the work
 * from moving into a daemon.
 *
 * The monitors now publish here and know nothing about transports. Two
 * subscribers exist: the dashboard (forwards straight to connected browsers)
 * and the daemon's IPC server (forwards to a dashboard in another process).
 *
 * ── Why the event names are the browser's names ────────────────────────────
 *
 * `nginx:status`, `domain:health`, `notification:new` and `local:changed` are
 * the names in docs/api-contract.md, and they are used unchanged here. A
 * translation table between internal and external names would be one more
 * thing to keep in step with the contract, and the contract is the thing that
 * must not drift. So a forwarder is a one-liner: subscribe, emit the same name
 * with the same payload.
 *
 * `logs:line` is deliberately NOT here. A log tail exists only for a client
 * that is watching, so it belongs to the socket layer and dies with the socket.
 *
 * `service:changed` is published only by the DASHBOARD (dashboard/lib/
 * daemonBridge.js): it describes the background service as that process sees
 * it, including whether this process is the one running the jobs. It is listed
 * here so the forwarding and replay machinery treats it like any other event;
 * the daemon never publishes it, so nothing conflicting crosses the IPC link.
 */

import { EventEmitter } from 'events';

/**
 * Every event the background jobs publish.
 *
 * Exported as a frozen list so a forwarder can iterate it rather than repeat
 * the names — a new event then reaches every subscriber without anyone having
 * to remember to add it in three places.
 */
export const JOB_EVENTS = Object.freeze([
  'nginx:status',
  'domain:health',
  'notification:new',
  'local:changed',
  'service:changed',
  // The Hub agent lives in whichever process owns the jobs. A dashboard in
  // another process reads its state from the daemon's IPC channel, so every
  // transition has to travel: without this event the dashboard only ever saw
  // the hello snapshot and reported "Connecting…" for ever.
  'hub:agentState',
]);

/**
 * One emitter per process. The jobs run in exactly one process at a time, so
 * a module-level instance is the right scope: there is nothing to multiplex.
 */
const bus = new EventEmitter();

// The monitors, the hub agent and the IPC server can all subscribe, and a
// dashboard with several internal listeners is normal. The default limit of 10
// would start printing warnings that mean nothing here.
bus.setMaxListeners(50);

/**
 * Publishes a job event.
 *
 * Never throws: a listener that fails must not take down the monitor that
 * produced the event, or one broken socket stops nginx from being watched.
 *
 * @param {string} event One of JOB_EVENTS
 * @param {*} payload
 */
export function publish(event, payload) {
  try {
    bus.emit(event, payload);
  } catch (err) {
    console.error(`[jobs/bus] listener for "${event}" threw:`, err.message);
  }
}

/**
 * Subscribes to one event.
 * @param {string} event
 * @param {Function} listener
 * @returns {() => void} Unsubscribe
 */
export function subscribe(event, listener) {
  bus.on(event, listener);
  return () => bus.off(event, listener);
}

/**
 * Subscribes to every job event at once.
 *
 * This is what a transport wants: it forwards all of them identically, and
 * using this means a newly added event is forwarded without a code change.
 *
 * @param {(event: string, payload: *) => void} listener
 * @returns {() => void} Unsubscribe from all of them
 */
export function subscribeAll(listener) {
  const offs = JOB_EVENTS.map((event) =>
    subscribe(event, (payload) => listener(event, payload)),
  );
  return () => { for (const off of offs) off(); };
}

/**
 * Removes every listener.
 *
 * For a dashboard that stops running the jobs and hands them to a daemon: its
 * forwarders must go, or a later re-subscribe would double every event.
 */
export function clearAll() {
  bus.removeAllListeners();
}

/** Listener count, for diagnostics and tests. */
export function listenerCount(event) {
  return bus.listenerCount(event);
}
