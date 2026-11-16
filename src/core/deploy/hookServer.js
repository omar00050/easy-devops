/**
 * core/deploy/hookServer.js
 *
 * The deploy hook: a small HTTP listener that lets a CI job say "deploy this
 * commit" — the trigger for a GitHub Action that has no Hub to go through.
 *
 * ── Why this is its own listener, and not a dashboard route ──────────────────
 *
 * The dashboard is started on demand; a deployment trigger has to be there at
 * three in the morning. So it runs with the background jobs, in whichever
 * process owns them (normally the daemon).
 *
 * That reverses a deliberate property of the daemon — it used to open no port
 * at all — so it is held to a narrow shape:
 *
 *   - OFF by default. Nothing listens until `deployHook.enabled` is set.
 *   - Loopback by default, reached through one nginx location on a domain the
 *     operator picks (HTTPS, if the domain has a certificate). Binding it to
 *     every interface is possible and is plain HTTP — the UI says so.
 *   - It serves exactly two things, both under /.ez-deploy/: start a
 *     deployment, and read that deployment's status. No dashboard API, no
 *     static files, nothing else.
 *   - Each app has its own token (256 random bits, stored as a hash). A token
 *     can start a deployment of ITS app from the app's configured repository,
 *     and nothing more: it cannot choose the repository, the commands or the
 *     environment.
 *   - Failed attempts are rate-limited per client, and an unknown app is
 *     indistinguishable from a wrong token.
 */

import http from 'http';

import { loadConfig } from '../config.js';
import { DEPLOY_HOOK_PATH } from '../nginx-conf-generator.js';
import { getApp, verifyHookToken } from './apps.js';
import { startDeployment } from './engine.js';
import { readRun, isId } from './store.js';

const MAX_BODY_BYTES = 16 * 1024;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
/** How often the manager re-reads the setting. */
const SETTINGS_POLL_MS = 10_000;

function isLoopback(address) {
  const a = String(address ?? '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/**
 * Who is calling.
 *
 * X-Forwarded-For is believed only when the connection itself comes from
 * loopback — that is, from the nginx location, which overwrites the header
 * with the real peer. From anywhere else the header is the caller's own
 * claim and is ignored.
 */
function clientAddress(req) {
  const peer = req.socket?.remoteAddress ?? '';
  if (isLoopback(peer)) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return peer || 'unknown';
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function bearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
  return m ? m[1] : null;
}

/**
 * Builds the request handler. Separate from the listener so it can be tested
 * without binding a port policy to it.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.deploy] startDeployment, injectable for tests
 * @param {() => number} [opts.now]
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>}
 */
export function createHookHandler({ deploy = startDeployment, now = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} client → timestamps of recent failures */
  const failures = new Map();

  const recentFailures = (client) => {
    const cutoff = now() - FAILURE_WINDOW_MS;
    const list = (failures.get(client) ?? []).filter((t) => t > cutoff);
    if (list.length > 0) failures.set(client, list); else failures.delete(client);
    return list;
  };
  const recordFailure = (client) => {
    const list = recentFailures(client);
    list.push(now());
    failures.set(client, list);
    // A flood of distinct clients must not grow this map without bound.
    if (failures.size > 5000) failures.delete(failures.keys().next().value);
  };

  /** Authenticates a request for an app. Sends the refusal itself. */
  const authenticate = (req, res, appId) => {
    const client = clientAddress(req);

    if (recentFailures(client).length >= MAX_FAILURES) {
      send(res, 429, { error: 'Too many failed attempts. Try again later.' });
      return null;
    }

    const app = /^[a-z0-9][a-z0-9-]{0,39}$/.test(appId) ? getApp(appId) : null;
    // One answer for "no such app", "hook not set up for it" and "wrong
    // token": the difference would tell a stranger which app names exist.
    if (!app || !verifyHookToken(app, bearer(req) ?? '')) {
      recordFailure(client);
      send(res, 401, { error: 'Unauthorized' });
      return null;
    }
    return app;
  };

  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      if (!pathname.startsWith(DEPLOY_HOOK_PATH)) return send(res, 404, { error: 'Not found' });
      const parts = pathname.slice(DEPLOY_HOOK_PATH.length).split('/').filter(Boolean);

      // Liveness, for the dashboard's "is the hook reachable" check. Says
      // nothing about apps.
      if (req.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
        return send(res, 200, { ok: true });
      }

      // POST /.ez-deploy/<app>
      if (req.method === 'POST' && parts.length === 1) {
        const app = authenticate(req, res, parts[0]);
        if (!app) return undefined;

        let ref = null;
        const raw = await readBody(req);
        if (raw.trim()) {
          let body;
          try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'The body must be JSON.' }); }
          if (body && typeof body.ref === 'string' && body.ref.trim()) ref = body.ref.trim();
        }

        const started = deploy(app.id, { trigger: 'webhook', ref, actor: 'deploy hook' });
        if (!started.ok) {
          return send(res, started.status ?? 500, { error: started.error, runId: started.runId ?? null });
        }
        return send(res, 202, {
          runId: started.runId,
          status: 'running',
          statusPath: `${DEPLOY_HOOK_PATH}${app.id}/runs/${started.runId}`,
        });
      }

      // GET /.ez-deploy/<app>/runs/<runId>
      if (req.method === 'GET' && parts.length === 3 && parts[1] === 'runs') {
        const app = authenticate(req, res, parts[0]);
        if (!app) return undefined;

        const run = isId(parts[2]) ? readRun(app.id, parts[2]) : null;
        if (!run) return send(res, 404, { error: 'No such run.' });
        return send(res, 200, {
          runId: run.id,
          status: run.status,
          step: run.step,
          sha: run.sha,
          error: run.error,
          rolledBackTo: run.rolledBackTo ?? null,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        });
      }

      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!res.headersSent) send(res, err?.status ?? 500, { error: err?.status ? err.message : 'Internal error' });
      return undefined;
    }
  };
}

/**
 * Starts the listener.
 * @returns {Promise<{ port: number, bind: string, close: () => Promise<void> }>}
 */
export function startHookServer({ port, bind = '127.0.0.1', handler = createHookHandler() } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { handler(req, res); });
    // A CI job that stalls must not hold a socket open for ever.
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;

    server.once('error', reject);
    server.listen(port, bind, () => {
      server.removeListener('error', reject);
      server.on('error', (err) => console.error('[deploy hook] server error:', err.message));
      resolve({
        port: server.address().port,
        bind,
        close: () => new Promise((done) => {
          server.close(() => done());
          // Idle keep-alive sockets would otherwise keep close() waiting.
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        }),
      });
    });
  });
}

/** The hook settings in force, with anything unusable replaced by a safe value. */
export function hookSettings(config = loadConfig()) {
  const raw = config?.deployHook ?? {};
  const port = Number(raw.port);
  return {
    enabled: raw.enabled === true,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 6445,
    bind: raw.bind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
    domain: typeof raw.domain === 'string' && raw.domain ? raw.domain : null,
  };
}

/**
 * Keeps the listener in step with the setting.
 *
 * The setting is changed from the dashboard, which is usually a different
 * process from the one running this. Re-reading it on a timer is the same
 * mechanism the revision watcher uses, and it means turning the hook on or
 * off never needs a service restart.
 *
 * @param {Object} [opts]
 * @param {number} [opts.pollMs]
 * @param {(line: string) => void} [opts.log]
 * @returns {{ stop: () => Promise<void>, state: () => Object, check: () => Promise<void> }}
 */
export function startDeployHookManager({ pollMs = SETTINGS_POLL_MS, log = (l) => console.log(l) } = {}) {
  let server = null;
  let active = null; // the settings the running server was started with
  let lastError = null;
  let stopped = false;
  let busy = false;

  const check = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      let wanted;
      try { wanted = hookSettings(); } catch { return; }

      const same = active && wanted.enabled && active.port === wanted.port && active.bind === wanted.bind;
      if (same) return;

      if (server) {
        await server.close();
        log(`[deploy hook] stopped listening on ${active.bind}:${active.port}`);
        server = null;
        active = null;
      }
      if (!wanted.enabled) { lastError = null; return; }

      try {
        server = await startHookServer({ port: wanted.port, bind: wanted.bind });
        active = { port: wanted.port, bind: wanted.bind };
        lastError = null;
        log(`[deploy hook] listening on ${wanted.bind}:${wanted.port}`);
      } catch (err) {
        // Said once per distinct failure, then retried quietly on each poll:
        // a port that is busy now may be free in a minute.
        const message = err.code === 'EADDRINUSE'
          ? `port ${wanted.port} is already in use`
          : err.message;
        if (lastError !== message) log(`[deploy hook] could not listen on ${wanted.bind}:${wanted.port}: ${message}`);
        lastError = message;
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => { check(); }, pollMs);
  check();

  return {
    check,
    state: () => ({ listening: Boolean(server), ...(active ?? {}), error: lastError }),
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (server) {
        try { await server.close(); } catch { /* ignore */ }
        server = null;
        active = null;
      }
    },
  };
}
