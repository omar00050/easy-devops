/**
 * core/jobs/monitors.js
 *
 * The background monitoring that used to live inside the dashboard's socket
 * layer: nginx status, per-domain backend health, certificate expiry — and,
 * since it has to run where no browser is open, automatic certificate renewal.
 *
 * Moved here so it can run in the daemon with no HTTP server anywhere near it.
 * The behaviour is the same, with two deliberate changes:
 *
 *  1. Results are published to core/jobs/bus.js instead of being emitted at a
 *     socket. Nothing here knows what a socket is.
 *  2. Notifications go through core/notifications/dispatch.js, so a transition
 *     is claimed before it is sent and only recorded once it has been. The old
 *     code recorded it first, which made a failed send permanently invisible.
 *
 * Each monitor is a plain function plus an interval. `startMonitors()` returns
 * a stop handle; nothing is global except the bus.
 */

import http from 'http';

import { getStatus } from '../nginx-service.js';
import { listAllCerts } from '../cert-reader.js';
import { dbGet } from '../db.js';
import { loadConfig } from '../config.js';
import { getDomains } from '../domains-db.js';
import {
  runAutoRenewal,
  describeCertificate,
  getAutoRenewSettings,
  autoRenewPlan,
} from '../cert-renewal.js';
import {
  createNginxDownEvent,
  createNginxRecoveredEvent,
  createDomainDownEvent,
  createDomainRecoveredEvent,
  createCertExpiryEvent,
} from '../events.js';
import { getEffectiveChannelIds } from '../domainNotifier.js';
import { sendNotification } from '../notifier.js';
import { dispatchTransition } from '../notifications/dispatch.js';
import { publish } from './bus.js';

/** Poll intervals, unchanged from the socket implementation. */
export const NGINX_POLL_MS = 5_000;
export const DOMAIN_HEALTH_POLL_MS = 60_000;
export const CERT_CHECK_MS = 12 * 60 * 60 * 1000;

/**
 * A certificate is worth warning about below this many days.
 * The danger-vs-warning threshold is not here: createCertExpiryEvent() in
 * core/events.js owns the severity, and two places deciding it would drift.
 */
export const CERT_WARN_DAYS = 30;

/** Backend health probe timeout. */
const HEALTH_TIMEOUT_MS = 5_000;

// ─── nginx status ─────────────────────────────────────────────────────────────

/**
 * Polls nginx and publishes its status, notifying on an up↔down transition.
 *
 * @returns {Promise<Object>} The status that was published
 */
export async function checkNginx() {
  let status;
  try {
    status = await getStatus();
  } catch (err) {
    // A failed status read is itself a status: publish it so the UI shows the
    // error rather than the last good value. It is NOT treated as "down" for
    // notification purposes — we do not know that nginx is down, only that we
    // could not ask, and crying wolf on a transient read error is worse than
    // staying quiet.
    status = { running: false, version: null, pid: null, error: err.message };
    publish('nginx:status', status);
    return status;
  }

  publish('nginx:status', status);

  await dispatchTransition({
    domain: null,
    eventType: 'nginx_down',
    status: status.running ? 'up' : 'down',
    buildEvent: (d) => (d.reason === 'recovery' ? createNginxRecoveredEvent() : createNginxDownEvent()),
    emitLocal: (event) => publish('notification:new', event),
  });

  return status;
}

// ─── domain health ────────────────────────────────────────────────────────────

/**
 * HEAD request against a domain's backend.
 *
 * @param {string} host
 * @param {number|string} port
 * @returns {Promise<{ up: boolean, status?: number }>}
 */
export function probeBackend(host, port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port: Number(port), path: '/', method: 'HEAD', timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        resolve({ up: true, status: res.statusCode });
        res.resume();
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ up: false }); });
    req.on('error', () => resolve({ up: false }));
    req.end();
  });
}

/**
 * Probes a list of domains and returns the results. Pure measurement: nothing
 * is published and nobody is notified, so a caller that only wants the answer
 * (the Hub agent, before the first scheduled sweep) can ask without side
 * effects.
 *
 * @param {Array<Object>} domains
 * @returns {Promise<Array<{ name: string, up: boolean|null, port?: number, host?: string }>>}
 */
export function probeDomains(domains) {
  return Promise.all(
    (domains ?? []).map(async (d) => {
      const host = d.backendHost || '127.0.0.1';
      const port = d.port || 80;

      // A backend given as a URL is proxied somewhere we do not own; `up: null`
      // is the contract's "not applicable", and it must not be notified about.
      if (typeof host === 'string' && host.startsWith('http')) return { name: d.name, up: null };

      const { up } = await probeBackend(host, port);
      return { name: d.name, up, port, host };
    }),
  );
}

/**
 * The most recent sweep, kept so the Hub agent can report REAL health.
 *
 * The agent used to send `up: d.enabled` — the enabled flag dressed up as a
 * health result — so the Hub showed every enabled domain as healthy whether
 * its backend answered or not. It runs in the same process as these monitors
 * (core/jobs/index.js starts both), so it reads the sweep rather than probing
 * every backend a second time.
 */
let lastDomainHealth = null;

/** @returns {{ at: number, results: Array<Object> }|null} */
export function getLastDomainHealth() {
  return lastDomainHealth;
}

/**
 * Probes every configured domain, publishes the list, and notifies on each
 * domain's transitions.
 *
 * @returns {Promise<Array<{ name: string, up: boolean|null, port?: number, host?: string }>>}
 */
export async function checkDomainHealth() {
  const domains = dbGet('domains') || [];

  const results = await probeDomains(domains);
  lastDomainHealth = { at: Date.now(), results };

  publish('domain:health', results);

  for (const result of results) {
    if (result.up === null) continue;

    await dispatchTransition({
      domain: result.name,
      eventType: 'domain_health',
      status: result.up ? 'up' : 'down',
      buildEvent: (d) => (d.reason === 'recovery'
        ? createDomainRecoveredEvent(result.name, result.port)
        : createDomainDownEvent(result.name, result.port)),
      emitLocal: (event) => publish('notification:new', event),
    });
  }

  return results;
}

// ─── certificate expiry ───────────────────────────────────────────────────────

/**
 * Warns about certificates close to expiry.
 *
 * Expiry is NOT a state transition, so it does not go through the claim path:
 * it is time-based, and the same warning is meant to repeat on each check
 * until the certificate is renewed. The dedupe that matters here is "once per
 * check interval", which the 12-hour timer already provides.
 *
 * That does mean a daemon and a dashboard both running this would double a
 * warning — which is exactly why only one process owns the jobs. The owner
 * election in core/jobs/index.js is what prevents it, not a per-event claim.
 *
 * @returns {Promise<Array<Object>>} The events that were published
 */
export async function checkCertExpiry() {
  const events = [];

  let certs;
  try {
    certs = await listAllCerts();
  } catch {
    // A missing or unreadable cert directory is normal on a fresh install.
    return events;
  }

  const config = loadConfig();
  const settings = getAutoRenewSettings(config);
  // Migrated records, the same ones the renewal job reads, so the two cannot
  // reach different conclusions about whether a certificate is in use.
  const domains = getDomains();

  for (const cert of certs) {
    if (cert.daysLeft === null || cert.daysLeft >= CERT_WARN_DAYS) continue;

    // What auto-renewal intends for this certificate decides what the warning
    // should say, and whether it is worth sending yet.
    let plan = 'off';
    try {
      const info = await describeCertificate(cert.domain);
      plan = autoRenewPlan({ certDomain: cert.domain, info, settings, domains, sslDir: config.sslDir });
    } catch { /* unreadable: warn as before */ }

    // A certificate that WILL be renewed in the background, and has not
    // reached its renewal window yet, is not a problem to report: warning
    // twice a day for three weeks about something that is already handled
    // only teaches people to ignore the channel. Once it is inside the window
    // and still not renewed, the renewal has failed and the warning returns
    // alongside the failure notification.
    if (plan === 'auto' && cert.daysLeft > settings.days) continue;

    // The socket layer built this event inline, duplicating a factory that
    // already existed in core/events.js with the identical shape. Using the
    // factory keeps the payload in one place, next to the others the contract
    // documents.
    const event = createCertExpiryEvent(cert.domain, cert.daysLeft, {
      manualRenewal: plan === 'manual',
    });

    publish('notification:new', event);
    events.push(event);

    try {
      await sendNotification(event, getEffectiveChannelIds(cert.domain, 'cert_expiry'));
    } catch (err) {
      console.error('[jobs/monitors] cert expiry notification failed:', err.message);
    }
  }

  return events;
}

// ─── certificate renewal ──────────────────────────────────────────────────────

/**
 * Renews HTTP-01 certificates that are inside the configured window
 * (`sslAutoRenew`, `sslAutoRenewDays` — 7 days by default).
 *
 * The decisions live in core/cert-renewal.js; this only gives the job a place
 * in the schedule and routes its notifications the same way the expiry warning
 * is routed, so a domain's `cert_expiry` channels receive "renewed" and
 * "renewal failed" without any new configuration.
 *
 * @returns {Promise<Object>} runAutoRenewal()'s summary
 */
export async function checkCertRenewal() {
  return runAutoRenewal({
    onEvent: async (event, domain) => {
      publish('notification:new', event);
      await sendNotification(event, getEffectiveChannelIds(domain, 'cert_expiry'));
    },
  });
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Starts every monitor and returns a handle that stops them.
 *
 * Each tick is guarded against overlapping with itself: a domain-health sweep
 * over many domains can outlast its interval, and starting a second sweep
 * while the first is still probing would double the work and let two
 * transitions for the same domain be evaluated concurrently.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.runImmediately] Poll once on start (default true)
 * @param {Object} [opts.intervals] Override the intervals, for tests
 * @returns {{ stop: () => void, tick: () => Promise<void> }}
 */
export function startMonitors({ runImmediately = true, intervals = {} } = {}) {
  const every = {
    nginx: intervals.nginx ?? NGINX_POLL_MS,
    domains: intervals.domains ?? DOMAIN_HEALTH_POLL_MS,
    certs: intervals.certs ?? CERT_CHECK_MS,
  };

  const timers = [];
  let stopped = false;

  /** Wraps a monitor so it never overlaps itself and never throws into a timer. */
  const guarded = (name, fn) => {
    let running = false;
    return async () => {
      if (stopped || running) return;
      running = true;
      try {
        await fn();
      } catch (err) {
        console.error(`[jobs/monitors] ${name} failed:`, err.message);
      } finally {
        running = false;
      }
    };
  };

  const runNginx = guarded('nginx status', checkNginx);
  const runDomains = guarded('domain health', checkDomainHealth);
  // Renewal first, then the expiry check: a certificate that was just renewed
  // must not also be warned about in the same pass. Each half is isolated so a
  // failure in renewal can never silence the warning it would have prevented.
  const runCerts = guarded('certificates', async () => {
    try {
      await checkCertRenewal();
    } catch (err) {
      console.error('[jobs/monitors] cert renewal failed:', err.message);
    }
    await checkCertExpiry();
  });

  timers.push(setInterval(runNginx, every.nginx));
  timers.push(setInterval(runDomains, every.domains));
  timers.push(setInterval(runCerts, every.certs));

  // unref() is wrong here: the daemon's whole purpose is to keep running, and
  // the one process that must not be kept alive by these timers (a CLI that
  // only reads status) does not start them at all.

  const tick = async () => {
    await runNginx();
    await runDomains();
    await runCerts();
  };

  if (runImmediately) {
    tick().catch((err) => console.error('[jobs/monitors] first poll failed:', err.message));
  }

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
    tick,
  };
}
