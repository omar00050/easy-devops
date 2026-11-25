/**
 * core/jobs/index.js
 *
 * Decides WHICH process runs the background jobs, and hands them over when
 * that answer changes.
 *
 * The rule, from the Phase 1 brief:
 *
 *   The jobs run in exactly one process. The daemon runs them whenever it is
 *   running. An open dashboard runs them only while no daemon is running, and
 *   gives them up as soon as one appears.
 *
 * Two roles, one module, because the hand-over is a single piece of logic seen
 * from both ends and splitting it would let the two halves disagree:
 *
 *   - OWNER role ('daemon'): takes the lock, keeps the heartbeat alive, runs
 *     the jobs for as long as it holds it. If it ever loses the lock it stops
 *     the jobs rather than carrying on — a daemon that lost its lock is, by
 *     definition, no longer the one process.
 *
 *   - STANDBY role ('dashboard'): never takes the lock. Polls it, runs the
 *     jobs while nobody holds it, and stops within one poll of a daemon
 *     appearing. On a fresh start it runs them immediately if no daemon is
 *     there, so a user with no service installed still gets monitoring.
 *
 * ── Why the dashboard does not take the lock ───────────────────────────────
 *
 * Tempting, and wrong: the daemon is the intended long-term owner, and a
 * dashboard holding the lock would make `ezz daemon` refuse to start — a user
 * installing the service would have to close their browser tab to get it
 * running. The asymmetry is deliberate: the lock means "a daemon is running",
 * not "someone is running the jobs".
 *
 * The cost is a window during hand-over where neither side is running them
 * (dashboard stops, daemon starts) or, briefly, both are. Both are bounded by
 * one poll interval, and the notification claim in core/notifications/claim.js
 * is what makes the overlap harmless: even with two runners, a transition is
 * sent exactly once.
 */

import {
  acquire,
  heartbeat,
  release,
  inspect,
  isDaemonRunning,
  watchLock,
  HEARTBEAT_INTERVAL_MS,
} from '../daemon/lock.js';
import { sweepAbandoned } from '../notifications/claim.js';
import {
  claim as claimOwner,
  release as releaseOwner,
  heartbeat as heartbeatOwner,
  waitUntilFree,
  HANDOVER_WAIT_MS,
  OWNER_HEARTBEAT_MS,
} from './owner.js';
import { initHubAgent, stopHubAgent, reconcileHubAgent } from '../hub/agent.js';
import { startMonitors } from './monitors.js';
import { startDeployHookManager } from '../deploy/hookServer.js';
import { startRevisionWatcher } from './revisionWatcher.js';
import { retireLegacyDeployLogs } from '../deploy/logRetirement.js';

/** How often a standby re-checks whether a daemon has appeared or gone. */
export const OWNERSHIP_POLL_MS = 15_000;

/**
 * Asks the agent to match the stored pairing, when the revision counter moves.
 *
 * The decision lives in `core/hub/agent.js` because it needs the agent's own
 * state: whether a socket exists and which pairing it was created for. An
 * earlier version decided here from `getHubAgentStatus().connected`, and that
 * was wrong — the counter moves on every domain, certificate and permission
 * change, so a busy server redialled the socket constantly, including while it
 * was still mid-connect. Hub updates then arrived seconds late.
 */
function onRevisionChange() {
  try {
    const result = reconcileHubAgent();
    if (result.action !== 'none') {
      console.log(`[jobs] hub agent ${result.action}: ${result.reason}`);
    }
  } catch (err) {
    console.error('[jobs] could not reconcile the hub agent:', err.message);
  }
}

/**
 * Starts the jobs under an ownership policy.
 *
 * @param {Object} opts
 * @param {'daemon'|'dashboard'} opts.role
 * @param {string} [opts.dataDir]
 * @param {string} [opts.version] Recorded in the lock, shown by `service status`
 * @param {Object} [opts.intervals] Monitor interval overrides, for tests
 * @param {boolean} [opts.hub] Run the Hub agent as part of the jobs (default true)
 * @param {number} [opts.pollMs] Ownership re-check interval
 * @param {(state: JobState) => void} [opts.onChange] Called whenever ownership changes
 * @returns {{ stop: () => Promise<void>, state: () => JobState, poll: () => void }
 *          | { ok: false, reason: string, lock: Object|null }}
 *
 * @typedef {Object} JobState
 * @property {'daemon'|'dashboard'} role
 * @property {boolean} running      Whether this process is running the jobs
 * @property {string} reason        Why, in a form a log line or a banner can use
 * @property {boolean} daemonSeen   Whether a daemon holds the lock
 */
export function startJobs({
  role,
  dataDir = undefined,
  version = null,
  intervals = {},
  hub = true,
  pollMs = OWNERSHIP_POLL_MS,
  handoverWaitMs = HANDOVER_WAIT_MS,
  onChange = null,
} = {}) {
  if (role !== 'daemon' && role !== 'dashboard') {
    throw new Error(`startJobs: role must be 'daemon' or 'dashboard', got ${JSON.stringify(role)}`);
  }

  const lockOpts = dataDir ? { dataDir } : {};

  if (role === 'daemon') {
    const got = acquire({ ...lockOpts, version, mode: 'daemon' });
    if (!got.ok) {
      // The caller decides what to print: `ezz daemon` says another daemon is
      // already running, the service wrapper treats it as "nothing to do".
      return { ok: false, reason: got.reason, lock: got.lock };
    }
  }

  /** @type {{ monitors: Object|null, revisions: Object|null }} */
  const handles = { monitors: null, revisions: null, ownerBeat: null, deployHook: null };
  let running = false;
  let reason = 'starting';
  let stopped = false;

  const state = () => ({
    role,
    running,
    reason,
    daemonSeen: role === 'daemon' ? true : isDaemonRunning(lockOpts),
  });

  const announce = () => {
    if (!onChange) return;
    try {
      onChange(state());
    } catch (err) {
      console.error('[jobs] onChange listener threw:', err.message);
    }
  };

  const startRunning = (why) => {
    if (running || stopped) return;

    // Exactly one process may run the jobs, and the daemon lock alone could
    // not enforce that: the dashboard never takes it. So ownership has its own
    // marker, and refusing to start without it is what makes the hand-over
    // exclusive rather than merely quick.
    const claimed = claimOwner({ ...lockOpts, role });
    if (!claimed.ok) {
      if (reason !== claimed.reason) { reason = claimed.reason; announce(); }
      console.log(`[jobs] not starting the jobs: ${claimed.reason}`);
      return;
    }
    if (claimed.recovered) {
      console.log('[jobs] recovered the jobs marker from a process that is gone');
    }

    // A crashed owner can leave claims behind. Clearing the ones whose owners
    // are gone means the first poll can send immediately instead of waiting
    // out the claim TTL — without it, a daemon restart during an outage would
    // stay silent for two minutes.
    try {
      const swept = sweepAbandoned(lockOpts);
      if (swept > 0) console.log(`[jobs] cleared ${swept} abandoned notification claim(s)`);
    } catch { /* non-fatal */ }

    // Pre-1.4.5 deployment logs cannot be re-redacted with values that have
    // since been removed. Retire their bytes before any monitor or Hub agent
    // can read deployment history. Active deployments are retried next start.
    try {
      const retired = retireLegacyDeployLogs(lockOpts);
      if (retired.retiredRuns > 0 || retired.removedLogs > 0) {
        console.log(
          `[jobs] retired ${retired.retiredRuns} legacy deployment run(s) `
          + `and ${retired.removedLogs} log file(s)`,
        );
      }
      if (retired.activeApps.length > 0) {
        console.log(
          `[jobs] deferred legacy-log retirement for ${retired.activeApps.length} active deployment(s)`,
        );
      }
      if (!retired.ok) {
        console.error('[jobs] legacy deployment-log retirement reported an error');
      }
    } catch (err) {
      console.error('[jobs] legacy deployment-log retirement failed:', err.message);
    }

    handles.monitors = startMonitors({ intervals });

    // The revision counter is also how a pairing change reaches this process.
    // Without this, pairing from the dashboard while the daemon owns the jobs
    // left the daemon with no agent until it was restarted — and tempted the
    // dashboard into starting one itself, which is the two-socket flap.
    handles.revisions = startRevisionWatcher({
      onChange: hub ? onRevisionChange : null,
    });

    // The hub agent is background work like any other, so it follows ownership
    // exactly. It must: two agents connected with the same credentials would
    // both receive every command from the Hub and both execute it, so an
    // "apply this config" would run twice. Tying it to the same election as
    // the monitors is what makes that impossible — rather than two call sites
    // each deciding for themselves whether to start one.
    if (hub) {
      try {
        initHubAgent();
      } catch (err) {
        console.error('[jobs] hub agent failed to start:', err.message);
      }
    }

    // The deploy hook follows ownership for the same reason the agent does:
    // two processes cannot both bind its port, and a CI job must reach the one
    // that is actually going to run the deployment. It listens on nothing
    // unless `deployHook.enabled` is set — see core/deploy/hookServer.js.
    try {
      handles.deployHook = startDeployHookManager();
    } catch (err) {
      console.error('[jobs] deploy hook failed to start:', err.message);
    }

    // The marker has to be refreshed or it goes stale in 20 seconds and
    // another process would be entitled to take the jobs from under us.
    //
    // The whole callback is guarded: a throw from a state write inside a timer
    // is an uncaught exception, and in 1.4.6 that killed the daemon on Windows
    // (finding A4). heartbeatOwner() already logs a failed write and retries on
    // the next beat; this is the belt to that braces.
    handles.ownerBeat = setInterval(() => {
      if (stopped || !running) return;
      try {
        if (!heartbeatOwner({ ...lockOpts, role })) {
          // Someone else owns the jobs now. Standing down is the safe direction,
          // for the same reason the daemon stands down when it loses its lock.
          console.error('[jobs] lost the jobs marker - standing down');
          stopRunning('another process holds the jobs');
        }
      } catch (err) {
        console.error('[jobs] jobs marker heartbeat failed:', err?.message ?? String(err));
      }
    }, OWNER_HEARTBEAT_MS);

    running = true;
    reason = why;
    console.log(`[jobs] running the background jobs (${why})`);
    announce();
  };

  const stopRunning = (why) => {
    if (!running) {
      // Keep the reason current even when nothing was running, so a banner
      // reads "a daemon is running" rather than the stale startup reason.
      if (reason !== why) { reason = why; announce(); }
      return;
    }

    handles.monitors?.stop();
    handles.revisions?.stop();
    if (handles.ownerBeat) clearInterval(handles.ownerBeat);
    // Its port must be free before another process is told the jobs are
    // available; the close is quick, and is not awaited because this path is
    // synchronous — a successor that finds the port briefly busy retries.
    handles.deployHook?.stop().catch(() => {});
    handles.monitors = null;
    handles.revisions = null;
    handles.ownerBeat = null;
    handles.deployHook = null;

    if (hub) {
      try {
        stopHubAgent();
      } catch (err) {
        console.error('[jobs] hub agent failed to stop cleanly:', err.message);
      }
    }

    // Released LAST, after the agent and the monitors are actually down. A
    // daemon waiting on this marker must not be told the jobs are free while
    // a Hub socket is still open here — that is the overlap the marker exists
    // to prevent.
    releaseOwner(lockOpts);

    running = false;
    reason = why;
    console.log(`[jobs] stopped the background jobs (${why})`);
    announce();
  };

  // ── Role: daemon ──────────────────────────────────────────────────────────

  let beat = null;
  let ready = Promise.resolve();

  if (role === 'daemon') {
    // The lock is ALREADY taken at this point (above), which is what the
    // dashboard's watcher reacts to. Starting the jobs is deliberately
    // deferred until the dashboard has actually released them: taking the lock
    // tells it to stand down, and this waits until it has.
    //
    // The wait is bounded. If it expires the jobs start anyway — a server with
    // no monitoring is worse than a few seconds of overlap, and the
    // notification claim makes an overlap harmless.
    ready = (async () => {
      const free = await waitUntilFree({ ...lockOpts, timeoutMs: handoverWaitMs });

      if (stopped) return;

      if (!free.free) {
        console.warn(
          `[jobs] starting anyway after waiting ${Math.round(free.waitedMs / 1000)}s `
          + `for the jobs to be released - ${free.reason}`,
        );
      } else if (free.waitedMs > 200) {
        console.log(`[jobs] the previous owner released the jobs after ${free.waitedMs}ms`);
      }

      startRunning('this process is the daemon');
    })();

    beat = setInterval(() => {
      if (stopped) return;
      // A failed lock write is logged and retried on the next beat; a throw
      // here would be an uncaught exception in a timer and would take the
      // daemon down (finding A4).
      try {
        const stillMine = heartbeat({ ...lockOpts, version, mode: 'daemon' });
        if (stillMine) return;

        // Someone else took the lock — a stale-lock recovery that fired while we
        // were paused, or a second daemon started by a service manager that
        // thought we were dead. Standing down is the safe direction: the other
        // process is the one the lock file names, and two daemons competing for
        // the hub socket is worse than one.
        console.error('[jobs] lost the daemon lock - standing down');
        stopRunning('another process holds the daemon lock');
        clearInterval(beat);
        beat = null;
      } catch (err) {
        console.error('[jobs] daemon lock heartbeat failed:', err?.message ?? String(err));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ── Role: dashboard (standby) ─────────────────────────────────────────────

  const poll = () => {
    if (stopped || role !== 'dashboard') return;

    const daemon = inspect(lockOpts);
    if (daemon.running) {
      stopRunning(`a daemon is running (pid ${daemon.lock?.pid})`);
    } else {
      startRunning('no daemon is running, so this dashboard runs them');
    }
  };

  let watcher = null;
  let lockWatch = null;

  if (role === 'dashboard') {
    poll();
    watcher = setInterval(poll, pollMs);

    // The poll alone was too slow in the direction that matters. A daemon
    // appearing had to wait up to a full interval to be noticed, and for that
    // whole window both processes ran the jobs — including two Hub agents with
    // the same serverId, which the Hub evicts in turn. Watching the lock makes
    // standing down immediate; the interval stays as the fallback for a
    // platform where the watch cannot be established.
    lockWatch = watchLock({ ...lockOpts, onChange: poll });
  }

  return {
    /**
     * Resolves once this process has decided whether to run the jobs.
     *
     * For a daemon that means the hand-over wait is over and the jobs are
     * started; `startDaemon()` awaits it so it never reports itself ready
     * while the previous owner is still shutting down.
     */
    ready: () => ready,

    async stop() {
      stopped = true;
      if (beat) clearInterval(beat);
      if (watcher) clearInterval(watcher);
      lockWatch?.close();
      stopRunning('shutting down');
      if (role === 'daemon') release(lockOpts);
    },
    state,
    poll,
  };
}
