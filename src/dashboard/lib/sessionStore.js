/**
 * dashboard/lib/sessionStore.js
 *
 * The dashboard's session store: session-file-store's own FileStore, with the
 * one thing it cannot do — a write that survives Windows — replaced.
 *
 * ── The failure this exists for ───────────────────────────────────────────
 *
 * On a Windows Server the daemon and the dashboard share
 * `C:\ProgramData\easy-devops`, and a virus scanner, the indexer or another
 * process holding the session file open for a few microseconds makes the
 * rename write-file-atomic performs fail:
 *
 *   EPERM: operation not permitted, rename
 *   '...\sessions\otb-....json.1705416166' ->
 *   '...\sessions\otb-....json' (errno -4048)
 *
 * session-file-store 1.5.0 passes that error straight to express-session,
 * which answers the request with a 500 and prints the whole stack (`logerror`
 * in express). Its `retries` option only ever applied to the READ path, so the
 * write had no retry at all — and with no `rolling` and no cookie `maxAge`,
 * every single response touched the session file, so one open tab produced a
 * rename per request.
 *
 * ── What this class changes, and what it deliberately does not ────────────
 *
 * `get`, `destroy`, `length`, `clear`, `list`, `expired` and the expiry reaper
 * are inherited unchanged. The file keeps its name (`<sessionId>.json`), its
 * folder and its format (`JSON` with `__lastAccess`), so sessions written by an
 * earlier version — or by stock session-file-store — keep loading exactly as
 * before. Unknown properties a future version adds survive a touch, because a
 * touch merges into the document that is on disk rather than rebuilding it.
 *
 * Only the write is ours, and it publishes through core/atomicState.js:
 * `replaceStateFile` writes a uniquely named temp file and renames it with the
 * shared retry for EPERM/EBUSY/EACCES. That is the same retry the daemon lock,
 * the jobs marker and the update status already use, so this is not a sixth
 * copy of it.
 *
 * ── A failed write is not a failed request ────────────────────────────────
 *
 * A transient sharing denial says nothing about whether the user is allowed to
 * do what they asked. Turning it into a 500 replaced a working page with a
 * stack trace, and the session itself was still valid in memory. So a write
 * that finally fails is reported once per failure streak (`reportStateWrite
 * Failure`, no per-request spam), the callback gets no error, the in-memory
 * session stays usable, and the next request's touch tries again. The first
 * successful write afterwards says so once (`reportStateWriteSuccess`).
 *
 * ── Skipping the touch rewrite ────────────────────────────────────────────
 *
 * A touch exists to move `__lastAccess` forward so the session does not
 * expire. Rewriting the whole file for every response buys nothing while the
 * file is already seconds old, so a touch that finds it younger than
 * `touchMinIntervalMs` (default 60 s) does no write at all. The window is
 * capped at a tenth of the session's own lifetime, so it can never let an
 * active session expire: with the default `ttl` of an hour it is the full
 * 60 s, with a 30 s cookie it is 3 s. After a failed write the next touch
 * always writes, whatever the age of the file.
 */

import path from 'node:path';
import { createRequire } from 'node:module';

import session from 'express-session';

import {
  replaceStateFile,
  reportStateWriteFailure,
  reportStateWriteSuccess,
} from '../../core/atomicState.js';

const require = createRequire(import.meta.url);
const FileStore = require('session-file-store')(session);

/** Default: a session file younger than this is not rewritten by a touch. */
export const DEFAULT_TOUCH_MIN_INTERVAL_MS = 60_000;

/**
 * session-file-store's FileStore, with `set` and `touch` writing through
 * core/atomicState.js.
 *
 * Constructed exactly like FileStore — `{ path, ttl, retries, logFn }` — plus
 * the optional `touchMinIntervalMs` (set it to 0 to disable touch skipping).
 */
export class SessionFileStore extends FileStore {
  /**
   * Session ids whose most recent write failed.
   *
   * Kept so the next touch writes even when the file it is about to update is
   * still young: "the next request retries" has to mean the next request, not
   * the next request after the skip window.
   */
  #failedWrites = new Set();

  /**
   * Encrypted stores (`secret` option) keep session-file-store's own path: its
   * encoder/decoder pair is not reproducible here, and nothing in Easy DevOps
   * uses it — the cookie is signed, the file holds no secret. Inheriting it
   * unchanged is better than silently corrupting such a store if one is ever
   * configured.
   */
  get #encrypted() {
    return this.options?.secret != null;
  }

  /** The file session-file-store would read and write for this id. */
  #file(sessionId) {
    return path.join(this.options.path, `${sessionId}${this.options.fileExtension}`);
  }

  /**
   * Whether a touch can leave the file alone.
   *
   * @param {Object} document The session document read from disk
   * @returns {boolean}
   */
  #canSkipTouch(document) {
    const interval = Number(this.options.touchMinIntervalMs ?? DEFAULT_TOUCH_MIN_INTERVAL_MS);
    if (!(interval > 0)) return false;

    const cookieTtl = Number(document?.cookie?.originalMaxAge);
    const configuredTtl = Number(this.options.ttl) * 1000;
    const lifetime = Number.isFinite(cookieTtl) && cookieTtl > 0 ? cookieTtl : configuredTtl;

    // A tenth of the lifetime at most, so the file is always refreshed well
    // before the session would be considered expired.
    const window = Math.min(interval, Math.floor(lifetime / 10));
    if (!(window > 0)) return false;

    const lastAccess = Number(document?.__lastAccess);
    return Number.isFinite(lastAccess) && Date.now() - lastAccess < window;
  }

  /**
   * Serialises a session document and publishes it atomically.
   *
   * @param {string} sessionId
   * @param {Object} document The document to store (the caller's own copy)
   * @param {Object} value What the store callback reports back
   * @param {(err: Error|null, value?: Object) => void} callback
   */
  #write(sessionId, document, value, callback) {
    const file = this.#file(sessionId);

    try {
      const body = this.options.encoder({ ...document, __lastAccess: Date.now() });
      replaceStateFile(file, body);
      this.#failedWrites.delete(String(sessionId));
      reportStateWriteSuccess(file);
      process.nextTick(callback, null, value);
    } catch (err) {
      this.#failedWrites.add(String(sessionId));
      // Once per streak: a retry on every request would bury the one line that
      // explains it.
      reportStateWriteFailure(
        file,
        err,
        'The session stays usable in memory and the next request tries again.',
      );
      // Deliberately not an error: express-session would turn it into a 500
      // with a stack trace, and the request itself was fine.
      process.nextTick(callback, null, value);
    }
  }

  /**
   * Commits a session. Same contract as FileStore#set.
   *
   * @param {string} sessionId
   * @param {Object} session
   * @param {(err: Error|null, session?: Object) => void} [callback]
   */
  set(sessionId, session, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    if (this.#encrypted) return super.set(sessionId, session, done);
    this.#write(sessionId, session, session, done);
  }

  /**
   * Updates `__lastAccess` (and the cookie) without losing anything else.
   *
   * Same read-then-merge as session-file-store's touch, so a property written
   * by another process between our read and our write is preserved, and only
   * the write itself differs.
   *
   * @param {string} sessionId
   * @param {Object} session
   * @param {(err: Error|null, session?: Object) => void} [callback]
   */
  touch(sessionId, session, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    if (this.#encrypted) return super.touch(sessionId, session, done);

    // The inherited get already retries a momentary read denial, and already
    // turns an expired file into null — so this is exactly the document a
    // stock touch would have written.
    this.get(sessionId, (err, stored) => {
      if (err) return done(err);

      const document = { ...(stored ?? {}) };
      if (session?.cookie) document.cookie = session.cookie;

      if (
        !this.#failedWrites.has(String(sessionId))
        && this.#canSkipTouch(document)
      ) {
        return done(null, stored);
      }

      this.#write(sessionId, document, stored, done);
    });
  }
}

export default SessionFileStore;
