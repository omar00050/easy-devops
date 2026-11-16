/**
 * Notification Dispatcher Core
 *
 * Named-channel registry model. Channels are stored as an array of objects:
 *   { id, name, type, ...typeSpecificFields }
 *
 * sendNotification(event, channelIds) looks up each ID, finds its type, and
 * dispatches to src/core/channels/{type}.js — the send() interface is unchanged.
 */

import { dbGet, dbSet } from './db.js';

const CHANNELS_KEY = 'notification_channels';

/**
 * Load the channel list from SQLite.
 * @returns {Array} Array of channel objects (empty array if none saved)
 */
export function loadChannels() {
  const stored = dbGet(CHANNELS_KEY);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Persist the channel list to SQLite.
 * @param {Array} channels
 */
export function saveChannels(channels) {
  dbSet(CHANNELS_KEY, channels);
}

/**
 * Find a single channel by ID.
 * @param {string} id
 * @returns {Object|null}
 */
export function getChannelById(id) {
  return loadChannels().find((ch) => ch.id === id) ?? null;
}

/**
 * What one sendNotification() call managed to do.
 *
 * @typedef {Object} SendResult
 * @property {number} attempted  Channels that existed and were tried
 * @property {number} delivered  Channels that accepted it
 * @property {Array<{id: string, name: string, error: string}>} failed
 * @property {boolean} ok        True when it is safe to record this as sent
 */

/**
 * Send a notification to a specific set of channels identified by ID.
 * Each channel's send() is called in a try/catch — one failure won't block others.
 * Passing null or an empty array is a no-op (dashboard-only path).
 *
 * Still never throws, but now REPORTS what happened. The caller needs this: a
 * notification that reached no channel must not be recorded as sent, or it is
 * never retried. Callers that ignore the return value behave exactly as before.
 *
 * @param {Object} event         - Notification event (type, message, severity, domain, timestamp)
 * @param {string[]|null} channelIds - Array of channel IDs to dispatch to
 * @returns {Promise<SendResult>}
 */
export async function sendNotification(event, channelIds = null) {
  /** @type {SendResult} */
  const result = { attempted: 0, delivered: 0, failed: [], ok: true };

  if (!channelIds || channelIds.length === 0) return result;

  const channels = loadChannels();

  for (const id of channelIds) {
    const channel = channels.find((ch) => ch.id === id);
    // An ID with no channel behind it is a stale reference, not a delivery
    // failure: there is nothing to retry, so it is not counted as attempted.
    if (!channel) continue;

    result.attempted++;

    try {
      const mod = await import(
        new URL(`./channels/${channel.type}.js`, import.meta.url)
      );

      if (typeof mod.send !== 'function') {
        console.error(`[notifier] channel type "${channel.type}" missing send()`);
        result.failed.push({ id, name: channel.name, error: `channel type "${channel.type}" has no send()` });
        continue;
      }

      await mod.send(event, channel);
      result.delivered++;
    } catch (err) {
      console.error(`[notifier] channel "${channel.name}" (${channel.type}):`, err.message);
      result.failed.push({ id, name: channel.name, error: err.message });
    }
  }

  // Partial delivery counts as ok: re-sending would duplicate the notification
  // on the channels that did work, which is worse than one channel missing it.
  result.ok = result.attempted === 0 || result.delivered > 0;
  return result;
}
