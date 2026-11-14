/**
 * core/jobs/revisionWatcher.js
 *
 * Watches the shared change counter in the database and publishes a
 * `local:changed` event when another process moved it.
 *
 * Why this exists: the CLI, the dashboard and the daemon are separate
 * processes. When `ezz` adds a domain, a dashboard tab that is already open
 * has no way to find out — there is no shared memory and no message passing
 * between them. `hub-revision` in the database is the cheapest signal that
 * works for every combination: one process bumps it, the others notice.
 *
 * The hub agent already polls the same counter for its own purposes (pushing
 * changes to the Hub). This watcher is the local half of that: it tells open
 * dashboards to refresh. Both read the counter; neither writes it.
 *
 * ── Why a poll and not fs.watch ────────────────────────────────────────────
 *
 * The counter is a row inside the SQLite file, and a file watcher on a SQLite
 * database reports write-ahead-log churn rather than logical changes — it
 * fires when nothing we care about moved, and can miss a change that was
 * already flushed. A 3-second read of one integer is far cheaper than getting
 * that wrong. `fs.watch` is used elsewhere for the daemon lock, which really
 * is one file whose existence is the signal.
 */

import { getHubRevision } from '../hubLink.js';
import { publish } from './bus.js';

/** How often the counter is read. */
export const REVISION_POLL_MS = 3_000;

/**
 * Starts watching. The first read only establishes a baseline — it never
 * publishes, or every start-up would tell the UI that everything changed.
 *
 * @param {Object} [opts]
 * @param {number} [opts.intervalMs]
 * @returns {{ stop: () => void, check: () => void, revision: () => number }}
 */
export function startRevisionWatcher({ intervalMs = REVISION_POLL_MS, onChange = null } = {}) {
  let last = safeRevision() ?? 0;

  const check = () => {
    const current = safeRevision();
    // A failed read is not a change. Returning 0 here instead of null would
    // read as the counter going backwards and publish a spurious refresh every
    // time the database was momentarily locked by another process's write.
    if (current === null || current === last) return;

    // Going DOWN means the database was replaced or reset — a restore, or a
    // fresh install over the top. Treat it as a change too: the UI's cached
    // view is wrong either way, and refusing to refresh would leave it stale
    // for ever.
    const direction = current > last ? 'changed' : 'reset';
    last = current;

    // Section 'domains' is the broadest useful hint: the counter is bumped for
    // domains, certificates and permissions, and the UI refreshes the section
    // it is shown. A more precise signal would need the writer to record what
    // it changed, which is a change to every writer for little gain.
    publish('local:changed', {
      section: 'domains',
      source: 'revision',
      at: Date.now(),
      revision: current,
      direction,
    });

    // The job owner also uses this to reconcile things that live outside the
    // UI — the hub agent in particular, since pairing changes are made in the
    // dashboard or the CLI but the agent belongs to whichever process owns the
    // jobs. A throw here must not stop the watcher: the next change retries.
    if (onChange) {
      try {
        onChange({ revision: current, direction });
      } catch (err) {
        console.error('[revisionWatcher] change handler threw:', err.message);
      }
    }
  };

  const timer = setInterval(check, intervalMs);

  return {
    stop() { clearInterval(timer); },
    check,
    revision: () => last,
  };
}

/**
 * Reading the counter must never kill the watcher: a locked database during
 * another process's write is transient, and the next tick will succeed.
 *
 * @returns {number|null} null when the read failed — NOT 0, which is a real
 *   revision value and would be mistaken for the counter being reset.
 */
function safeRevision() {
  try {
    const n = getHubRevision();
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}
