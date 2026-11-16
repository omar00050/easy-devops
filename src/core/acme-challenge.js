/**
 * core/acme-challenge.js
 *
 * The temporary HTTP listener that answers ACME HTTP-01 challenges, plus the
 * local preflight that proves nginx can reach it before Let's Encrypt is
 * contacted.
 *
 * Why a loopback listener behind nginx rather than a webroot: on Linux nginx
 * runs as another user and cannot read files under the operator's config
 * directory, and creating a system webroot would need extra sudo rules. A
 * proxy_pass to 127.0.0.1 behaves identically on Linux and Windows and needs
 * no filesystem permissions at all.
 *
 * Concurrency: the listener is reference counted and every start/stop goes
 * through one promise chain, so two issuances running at once share a single
 * listener and the last one out closes it.
 */

import http from 'http';
import net from 'net';
import { ACME_CHALLENGE_PATH, DEFAULT_ACME_CHALLENGE_PORT } from './nginx-conf-generator.js';

/** token -> keyAuthorization, shared by every concurrent issuance. */
const tokens = new Map();

let server = null;
let serverPort = null;
let refCount = 0;

/** Serialises start/stop so concurrent callers cannot race the listener. */
let chain = Promise.resolve();

/** Runs `fn` with exclusive access to the listener bookkeeping. */
function serialize(fn) {
  const next = chain.then(fn, fn);
  // Keep the chain alive regardless of outcome.
  chain = next.then(() => undefined, () => undefined);
  return next;
}

/** True when something is already listening on the port. */
export function isPortBusy(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.connect({ port, host });
    const done = (busy) => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(busy);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

function createServer() {
  return http.createServer((req, res) => {
    let pathname = req.url || '/';
    const q = pathname.indexOf('?');
    if (q !== -1) pathname = pathname.slice(0, q);

    if (pathname.startsWith(ACME_CHALLENGE_PATH)) {
      const token = pathname.slice(ACME_CHALLENGE_PATH.length);
      const keyAuth = tokens.get(token);
      if (keyAuth) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': Buffer.byteLength(keyAuth),
        });
        res.end(keyAuth);
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
}

/**
 * Starts the listener if it is not already running and increments the refcount.
 * @param {number} port
 * @returns {Promise<number>} The bound port
 */
function acquire(port) {
  return serialize(async () => {
    if (server) {
      if (serverPort !== port) {
        throw new Error(
          `ACME challenge listener is already running on port ${serverPort}; ` +
          `cannot also bind ${port}. Finish the other issuance first.`
        );
      }
      refCount++;
      return serverPort;
    }

    if (await isPortBusy(port)) {
      throw new Error(
        `Port ${port} on 127.0.0.1 is already in use, so the ACME challenge ` +
        `listener cannot start. Stop whatever is using it, or set a different ` +
        `acmeChallengePort in Settings (it must match the port in the nginx configs).`
      );
    }

    const srv = createServer();
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', reject);
        resolve();
      });
    });

    server = srv;
    serverPort = port;
    refCount = 1;
    return serverPort;
  });
}

/** Decrements the refcount and closes the listener when it hits zero. */
function release() {
  return serialize(async () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount > 0 || !server) return;

    const srv = server;
    server = null;
    serverPort = null;

    await new Promise((resolve) => {
      const done = setTimeout(resolve, 2000);
      srv.close(() => {
        clearTimeout(done);
        resolve();
      });
    });
  });
}

/**
 * Runs `fn` with the challenge listener available.
 *
 * @param {number} port Loopback port to serve on
 * @param {(api: {
 *   port: number,
 *   setToken: (token: string, keyAuth: string) => void,
 *   removeToken: (token: string) => void,
 * }) => Promise<any>} fn
 * @returns {Promise<any>} Whatever `fn` resolves to
 */
export async function withChallengeServer(port, fn) {
  const bound = await acquire(port);
  const owned = new Set();

  try {
    return await fn({
      port: bound,
      setToken(token, keyAuth) {
        tokens.set(token, keyAuth);
        owned.add(token);
      },
      removeToken(token) {
        tokens.delete(token);
        owned.delete(token);
      },
    });
  } finally {
    // Never leave this issuance's tokens behind for another one to serve.
    for (const token of owned) tokens.delete(token);
    await release();
  }
}

/**
 * Fetches a URL with an explicit Host header and a short timeout.
 * @returns {Promise<{ ok: boolean, status: number|null, body: string, error: string|null }>}
 */
function probe({ host, port, path: reqPath, hostHeader, timeout = 5000 }) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: reqPath, method: 'GET', headers: { Host: hostHeader }, timeout },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ ok: true, status: res.statusCode, body, error: null }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null, body: '', error: 'timed out' }); });
    req.on('error', (err) => resolve({ ok: false, status: null, body: '', error: err.message }));
    req.end();
  });
}

/**
 * Chooses which address(es) to probe for a domain's port-80 server block.
 *
 * A config that binds a specific address (`listen 203.0.113.5:80`) is not
 * reachable on 127.0.0.1, so probing loopback would wrongly look like a
 * broken setup. Wildcard listens are reachable on loopback.
 *
 * @param {Array<{host: string, port: number, wildcard: boolean}>} listens
 * @returns {string[]} Hosts to try, in order
 */
export function resolveProbeHosts(listens) {
  if (!Array.isArray(listens) || listens.length === 0) return ['127.0.0.1'];
  if (listens.some((l) => l.wildcard)) return ['127.0.0.1'];

  // Specific addresses only — probe each one as bound.
  const hosts = [];
  for (const l of listens) {
    const host = l.host === '::1' ? '::1' : l.host;
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * Confirms nginx forwards the challenge path to our listener, by serving a
 * throwaway token and fetching it back through nginx.
 *
 * Runs entirely on this machine: it never contacts Let's Encrypt, so a failure
 * here costs nothing against the rate limits.
 *
 * @param {Object} opts
 * @param {string} opts.domain         Host header to send
 * @param {number} opts.challengePort  Loopback port of our listener
 * @param {string[]} [opts.probeHosts] Addresses to try (from resolveProbeHosts)
 * @param {number} [opts.httpPort]     Port nginx serves HTTP on
 * @returns {Promise<{ ok: boolean, detail: string, triedHosts: string[] }>}
 */
export async function preflight({
  domain,
  challengePort = DEFAULT_ACME_CHALLENGE_PORT,
  probeHosts = ['127.0.0.1'],
  httpPort = 80,
}) {
  const token = `easy-devops-preflight-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const expected = `${token}.preflight`;
  const attempts = [];

  return withChallengeServer(challengePort, async ({ setToken }) => {
    setToken(token, expected);

    for (const host of probeHosts) {
      const res = await probe({
        host,
        port: httpPort,
        path: `${ACME_CHALLENGE_PATH}${token}`,
        hostHeader: domain,
      });

      if (res.ok && res.status === 200 && res.body === expected) {
        return { ok: true, detail: `${host}:${httpPort} returned the token`, triedHosts: probeHosts };
      }

      if (!res.ok) {
        attempts.push(`${host}:${httpPort} — ${res.error}`);
      } else if (res.status === 301 || res.status === 302) {
        attempts.push(
          `${host}:${httpPort} — HTTP ${res.status} redirect; the challenge path is being redirected ` +
          `instead of proxied (the config may predate the ACME challenge location)`
        );
      } else {
        attempts.push(`${host}:${httpPort} — HTTP ${res.status}, unexpected body`);
      }
    }

    return { ok: false, detail: attempts.join('; ') || 'no addresses probed', triedHosts: probeHosts };
  });
}
