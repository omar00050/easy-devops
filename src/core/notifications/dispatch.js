/**
 * core/notifications/dispatch.js
 *
 * The one correct way to send a state-transition notification.
 *
 * Everything that monitors a domain or nginx goes through here, because the
 * ordering is easy to get wrong and the failure is silent when you do: the old
 * code recorded "notified" before sending, so a webhook that was down meant the
 * user simply never heard about an outage.
 *
 * The order, and why each step is where it is:
 *
 *   1. evaluate  — is this a real transition? (pure; records nothing)
 *   2. claim     — atomically become the only process sending it
 *   3. send      — the actual channels
 *   4. commit    — record it as sent, THEN drop the claim
 *
 * On a send failure step 4 is skipped and the claim is released, so the next
 * poll evaluates the same transition again and retries it.
 *
 * Commit before release matters: if the process dies between them, the worst
 * case is a claim file left behind that the TTL sweep clears. Releasing first
 * would risk another process re-sending something already recorded as sent.
 *
 * A transition that needs no notification (no change, first sighting) never
 * takes a claim — contention on the claim file would otherwise be constant,
 * since the common case is "nothing happened".
 */

import {
  evaluateTransition,
  commitNotification,
  getEffectiveChannelIds,
  getAllDomainChannelIds,
} from '../domainNotifier.js';
import { sendNotification } from '../notifier.js';
import { claim } from './claim.js';

/**
 * @typedef {Object} DispatchResult
 * @property {boolean} sent        Whether a notification actually went out
 * @property {string} reason       Why, in a form a log line can use
 * @property {Object} decision     The evaluateTransition() result
 * @property {Object|null} event    The event that was emitted, if any
 * @property {Object|null} send     The sendNotification() result, if it was tried
 * @property {boolean} claimed     Whether this process won the claim
 */

/**
 * Evaluates a transition and, if it is worth announcing, sends it exactly once
 * across every process sharing this data directory.
 *
 * @param {Object} opts
 * @param {string|null} opts.domain               null for global events
 * @param {string} opts.eventType                 e.g. 'nginx_down', 'domain_health'
 * @param {string} opts.status                    'up' | 'down'
 * @param {(decision: Object) => Object} opts.buildEvent
 *        Builds the event from the decision. Called only when something will be
 *        sent, so the caller does not pay for an event nobody sees.
 * @param {(event: Object) => void} [opts.emitLocal]
 *        Pushes the event to connected dashboards. Called only by the process
 *        that won the claim, for the same no-duplicates reason as the channels.
 * @param {string[]} [opts.channelIds]            Overrides channel resolution
 * @param {string} [opts.dataDir]
 * @param {Function} [opts.send]                  Injectable, for tests
 * @returns {Promise<DispatchResult>}
 */
export async function dispatchTransition({
  domain,
  eventType,
  status,
  buildEvent,
  emitLocal = null,
  channelIds = null,
  dataDir = undefined,
  send = sendNotification,
} = {}) {
  const decision = evaluateTransition(domain, eventType, status);

  if (!decision.shouldNotify) {
    // Still record the status: a first sighting has to be remembered or every
    // poll treats itself as the first. No claim is needed because no
    // notification goes out, and the write is idempotent.
    commitNotification(domain, eventType, decision);
    return { sent: false, reason: decision.reason, decision, event: null, send: null, claimed: false };
  }

  const held = claim({ domain, eventType, status: decision.currentStatus, dataDir });
  if (!held.ok) {
    // Another process is sending it. Record nothing at all: the winner commits
    // the state, and writing it here would mask a failure over there.
    return { sent: false, reason: `another process has it: ${held.reason}`, decision, event: null, send: null, claimed: false };
  }

  const event = buildEvent(decision);

  let result = null;
  try {
    const ids = channelIds ?? resolveChannelIds(domain, eventType);
    result = await send(event, ids);

    if (!result?.ok) {
      held.release();
      return {
        sent: false,
        reason: `delivery failed on every channel (${result?.failed?.length ?? 0} error(s)); will retry`,
        decision,
        event,
        send: result,
        claimed: true,
      };
    }

    // Order: record, emit, then drop the claim.
    commitNotification(domain, eventType, decision);
    if (emitLocal) {
      try {
        emitLocal(event);
      } catch (err) {
        // A broken socket must not undo a successful send.
        console.error('[dispatch] local emit failed:', err.message);
      }
    }
    held.commit();

    return { sent: true, reason: decision.reason, decision, event, send: result, claimed: true };
  } catch (err) {
    // sendNotification() is not supposed to throw, but an injected sender or a
    // module-load failure can. Release so it is retried rather than lost.
    held.release();
    return {
      sent: false,
      reason: `send threw: ${err.message}; will retry`,
      decision,
      event,
      send: result,
      claimed: true,
    };
  }
}

/**
 * Which channels a given event goes to.
 *
 * Global events (no domain) fan out to every channel configured for that event
 * type; a domain event uses that domain's effective channels.
 *
 * @param {string|null} domain
 * @param {string} eventType
 * @returns {string[]}
 */
export function resolveChannelIds(domain, eventType) {
  return domain ? getEffectiveChannelIds(domain, eventType) : getAllDomainChannelIds(eventType);
}
