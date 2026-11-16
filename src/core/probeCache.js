/**
 * core/probeCache.js
 *
 * Cache for probes that cost a subprocess, with refresh in the background.
 *
 * ── Why this exists, with numbers ──────────────────────────────────────────
 *
 * `GET /api/service` took about twenty seconds on a Windows machine. Nothing
 * in it was slow by itself; it was the spawn count. Measured on that machine:
 *
 *   one bare `run()` through PowerShell        ~0.9 - 1.4 s
 *   `where.exe pm2`                            ~2.0 s
 *   `pm2 --version`                            ~4.0 s
 *   `schtasks /Query`                          ~1.7 s
 *
 * and the endpoint made about six of them, in sequence: the service manager's
 * status, the pinned runtime's `--version`, the legacy PM2 scan (which detects
 * PM2 and lists its apps), and PM2 detection again for the Processes panel.
 * Five spawns run one after another cost ~6 s; the same five together cost
 * ~1.7 s. So there are two separate wins, and this module is the bigger one.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 *
 * A caller asks for a key and gets an answer immediately whenever one exists,
 * even a stale one, and a refresh is started in the background. Only a COLD
 * key — nothing cached at all — can make a caller wait, and then only up to
 * the timeout it passes.
 *
 * Serving a stale answer is the right default here because of what these
 * probes describe: whether PM2 is installed, which Node the service is pinned
 * to, whether a Task Scheduler leftover exists. Those change when the user
 * runs a command, never on their own — and every command that changes one
 * calls `invalidate()`. The things that DO change on their own, the daemon
 * lock and the heartbeat, are read fresh on every request and never come from
 * here; they cost microseconds.
 *
 * ── Single-flight ──────────────────────────────────────────────────────────
 *
 * Two requests arriving together must not both spawn `where.exe pm2`. A key
 * has at most one producer in flight, and everyone waiting on that key gets
 * its result. Without this, an open dashboard polling every fifteen seconds
 * with two tabs would double the spawn count rather than halve it.
 */

/**
 * @typedef {Object} Entry
 * @property {*} value
 * @property {number} at           When the value was produced
 * @property {number} ttlMs
 * @property {Promise|null} inFlight
 * @property {string|null} error   The last failure, if the value is stale
 */

/** @type {Map<string, Entry>} */
const entries = new Map();

/** Counters, for tests and for a status line. Not a metrics system. */
const counters = { hits: 0, stale: 0, misses: 0, refreshes: 0, failures: 0 };

/** Default lifetime. Overridden per key by every real caller. */
export const DEFAULT_TTL_MS = 30_000;

/**
 * How long a cold caller may wait before being answered with "pending".
 *
 * Chosen so the FIRST request after a dashboard starts still returns inside a
 * couple of seconds even when every probe is cold and slow. The dashboard also
 * warms the cache at startup, so in practice this deadline is rarely reached.
 */
export const DEFAULT_COLD_WAIT_MS = 1_500;

/**
 * Reads a key, refreshing it in the background when it is past its TTL.
 *
 * @param {string} key
 * @param {() => Promise<*>} producer       Does the expensive work
 * @param {Object} [opts]
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.coldWaitMs]        Max wait when nothing is cached
 * @param {number} [opts.now]
 * @returns {Promise<{ value: *, ageMs: number|null, fresh: boolean, pending: boolean, refreshing: boolean, error: string|null }>}
 */
export async function probe(key, producer, {
  ttlMs = DEFAULT_TTL_MS,
  coldWaitMs = DEFAULT_COLD_WAIT_MS,
  now = Date.now(),
} = {}) {
  const entry = entries.get(key);

  // ── Fresh ────────────────────────────────────────────────────────────────
  if (entry && entry.at !== null && now - entry.at < ttlMs) {
    counters.hits += 1;
    return {
      value: entry.value,
      ageMs: now - entry.at,
      fresh: true,
      pending: false,
      refreshing: Boolean(entry.inFlight),
      error: entry.error,
    };
  }

  // ── Stale: answer now, refresh behind ────────────────────────────────────
  if (entry && entry.at !== null) {
    counters.stale += 1;
    startRefresh(key, producer, ttlMs);
    return {
      value: entry.value,
      ageMs: now - entry.at,
      fresh: false,
      pending: false,
      refreshing: true,
      error: entry.error,
    };
  }

  // ── Cold: wait, but not for ever ─────────────────────────────────────────
  counters.misses += 1;
  const refresh = startRefresh(key, producer, ttlMs);

  const raced = await Promise.race([
    refresh.then(() => 'done', () => 'failed'),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), coldWaitMs);
      // Never hold the event loop open for a deadline nobody is waiting on:
      // this is what stops `ezz --dash` hanging on Ctrl+C.
      timer.unref?.();
    }),
  ]);

  const settled = entries.get(key);

  if (raced === 'done' && settled?.at !== null) {
    return {
      value: settled.value,
      ageMs: Date.now() - settled.at,
      fresh: true,
      pending: false,
      refreshing: false,
      error: settled.error,
    };
  }

  // Either it is still running, or it failed with nothing cached to fall back
  // on. Both are "no answer yet", and the caller decides what to render.
  return {
    value: null,
    ageMs: null,
    fresh: false,
    pending: true,
    refreshing: Boolean(settled?.inFlight),
    error: settled?.error ?? null,
  };
}

/**
 * Starts a refresh unless one is already running for this key.
 *
 * @returns {Promise<*>} The in-flight promise, so a cold caller can await it
 */
function startRefresh(key, producer, ttlMs) {
  const existing = entries.get(key);
  if (existing?.inFlight) return existing.inFlight;

  const entry = existing ?? { value: null, at: null, ttlMs, inFlight: null, error: null };
  entry.ttlMs = ttlMs;
  entries.set(key, entry);

  counters.refreshes += 1;

  entry.inFlight = (async () => {
    try {
      const value = await producer();
      entry.value = value;
      entry.at = Date.now();
      entry.error = null;
      return value;
    } catch (err) {
      counters.failures += 1;
      entry.error = err?.message ?? String(err);
      // A failed refresh does NOT discard the previous value. A probe that
      // fails once - a tool busy, a transient permission error - must not turn
      // a working status display into an empty one.
      throw err;
    } finally {
      entry.inFlight = null;
    }
  })();

  // The rejection is handled by whoever awaits it; this keeps a background
  // refresh from becoming an unhandled rejection that takes the daemon down.
  entry.inFlight.catch(() => {});

  return entry.inFlight;
}

/**
 * Drops cached values so the next read re-probes.
 *
 * Called by every operation that changes what the probes describe: install,
 * uninstall, start, stop, restart, repair, a runtime update, and the
 * dashboard's `service:changed`. Without that, a user who had just started the
 * service would be shown "not running" for the rest of the TTL — which is the
 * failure mode that makes caching feel broken.
 *
 * @param {string} [prefix] Only keys starting with this; everything when omitted
 * @returns {number} How many keys were dropped
 */
export function invalidate(prefix) {
  let dropped = 0;
  for (const key of [...entries.keys()]) {
    if (prefix !== undefined && !key.startsWith(prefix)) continue;
    const entry = entries.get(key);
    // An in-flight producer is left to finish, but its result is no longer
    // wanted: clearing `at` makes the next read treat the key as cold.
    if (entry) {
      entry.value = null;
      entry.at = null;
      entry.error = null;
    }
    entries.delete(key);
    dropped += 1;
  }
  return dropped;
}

/** The cached value without producing or refreshing anything. For tests. */
export function peek(key, { now = Date.now() } = {}) {
  const entry = entries.get(key);
  if (!entry || entry.at === null) return { cached: false, value: null, ageMs: null };
  return { cached: true, value: entry.value, ageMs: now - entry.at, refreshing: Boolean(entry.inFlight) };
}

/** Hit/miss counters. Reset by `resetStats()`; for tests and diagnostics. */
export function stats() {
  return { ...counters, keys: entries.size };
}

/** Zeroes the counters, leaving the cached values alone. */
export function resetStats() {
  for (const key of Object.keys(counters)) counters[key] = 0;
}

/**
 * Waits for every in-flight refresh to settle.
 *
 * For tests and for a deliberate warm-up, so a caller can say "fill the cache,
 * then measure a warm call" without sleeping for an arbitrary length of time.
 *
 * @returns {Promise<void>}
 */
export async function settle() {
  for (let round = 0; round < 10; round += 1) {
    const pending = [...entries.values()].map((e) => e.inFlight).filter(Boolean);
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}
