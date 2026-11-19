/**
 * core/nginx-conf-generator.js
 *
 * Shared nginx configuration generator used by both dashboard routes and CLI.
 * Generates complete nginx reverse proxy configs from domain objects.
 *
 * This module is pure (no side effects) — only generateConf() writes files.
 */

import fs from 'fs/promises';
import path from 'path';
import { loadConfig } from './config.js';
import { isWindows, toNginxPath, toEscapedNginxPath } from './platform.js';
import { CLOUDFLARE_RANGES } from './cloudflare-ips.js';

/**
 * How certificate paths are written into a generated config.
 * 'forward'  — C:/nginx/certs/a.pem   (default everywhere; the only form on Linux)
 * 'escaped'  — "C:\\nginx\\certs\\a.pem"  (Windows fallback, quoted + doubled)
 */
export const CERT_PATH_STYLES = Object.freeze({ FORWARD: 'forward', ESCAPED: 'escaped' });

/** Comment written above the SSL directives, explaining the path form in use. */
const CERT_PATH_COMMENTS = {
  [CERT_PATH_STYLES.FORWARD]:
    '# Windows: certificate paths use forward slashes (backslashes can be read as escape sequences by nginx).',
  [CERT_PATH_STYLES.ESCAPED]:
    '# Windows: certificate paths use escaped backslashes in quotes (nginx reads each \\\\ as one literal backslash).',
};

/** Path prefix Let's Encrypt fetches during an HTTP-01 challenge. */
export const ACME_CHALLENGE_PATH = '/.well-known/acme-challenge/';

/** Default loopback port the temporary challenge listener binds. */
export const DEFAULT_ACME_CHALLENGE_PORT = 8089;

/**
 * Builds the location block that forwards ACME challenge requests to the
 * temporary listener this process starts during issuance.
 *
 * `^~` makes it a prefix match that wins outright, so neither `location /`
 * nor any regex location can intercept the challenge.
 *
 * @param {number} [port] Loopback port of the challenge listener
 * @returns {string} Indented nginx location block
 */
export function buildChallengeLocation(port = DEFAULT_ACME_CHALLENGE_PORT) {
  const target = `http://127.0.0.1:${Number(port) || DEFAULT_ACME_CHALLENGE_PORT}`;
  return [
    ` # ACME HTTP-01 challenge — answered by Easy DevOps so nginx never stops.`,
    ` location ^~ ${ACME_CHALLENGE_PATH} {`,
    ` proxy_pass ${target};`,
    ` proxy_set_header Host $host;`,
    ` }`,
  ].join('\n');
}

/** Path prefix the deploy hook answers on. Shared with core/deploy/hookServer.js. */
export const DEPLOY_HOOK_PATH = '/.ez-deploy/';

/**
 * File holding the single `map $http_upgrade $ezz_connection_upgrade` definition.
 *
 * nginx permits a `map` only in the `http` context, and a second definition of
 * the same variable fails `nginx -t`. Writing it to one file in conf.d means
 * every domain config can use `$ezz_connection_upgrade` without any of them
 * defining it, so the map exists exactly once no matter how many domains there
 * are. The leading `00-` keeps it first in conf.d's lexical include order.
 */
export const WEBSOCKET_MAP_FILENAME = '00-easy-devops-websocket.conf';

/** Prefix the Socket.IO endpoint is served under. */
export const SOCKET_IO_PATH = '/socket.io/';

/** Long enough for an idle WebSocket behind Socket.IO (1 hour). */
export const SOCKET_IO_TIMEOUT = '3600s';

/**
 * Content of the shared WebSocket map file.
 *
 * `'' ''` (empty, not `close`) is deliberate: a plain HTTP request has no
 * `Upgrade` header, so nginx sends no `Connection` header at all and upstream
 * keep-alive keeps working. `close` would force every ordinary request onto a
 * new connection. A real WebSocket request gets `upgrade` via `default`.
 *
 * @returns {string}
 */
export function buildWebsocketMapConf() {
  return [
    '# Easy DevOps — WebSocket upgrade map. Written once for ALL proxied domains;',
    '# a map may only live in the http context and must not be defined twice.',
    'map $http_upgrade $ezz_connection_upgrade {',
    '    default upgrade;',
    "    ''      '';",
    '}',
    '',
  ].join('\n');
}

/**
 * Path of the shared WebSocket map file for a given nginx installation.
 * @param {string} nginxDir
 * @returns {string}
 */
export function websocketMapPath(nginxDir) {
  const join = isWindows ? path.win32.join : path.posix.join;
  return join(getConfDDir(nginxDir), WEBSOCKET_MAP_FILENAME);
}

/**
 * Writes the shared WebSocket map file, overwriting it with identical content
 * on later calls. One file, so it can never be included twice from our side.
 * @param {string} nginxDir
 * @returns {Promise<string>} Path written
 */
export async function ensureWebsocketMap(nginxDir) {
  const confPath = websocketMapPath(nginxDir);
  await fs.mkdir(path.dirname(confPath), { recursive: true });
  await fs.writeFile(confPath, buildWebsocketMapConf(), 'utf8');
  return confPath;
}

/**
 * Builds the location block that exposes the deploy hook through a domain.
 *
 * The hook listener binds to loopback; this is what lets GitHub Actions reach
 * it over the domain's own HTTPS without opening another port. Only this one
 * prefix is forwarded — nothing else on the listener, and nothing at all on
 * the dashboard, becomes reachable.
 *
 * `X-Forwarded-For` is overwritten with `$remote_addr`, not appended to: the
 * hook rate-limits failed attempts per client, and an appended header would
 * let a caller choose its own identity.
 *
 * @param {number} port Loopback port of the deploy hook listener
 * @returns {string} Indented nginx location block
 */
export function buildDeployHookLocation(port) {
  return [
    ` # Easy DevOps deploy hook — lets CI trigger a deployment over this domain.`,
    ` location ^~ ${DEPLOY_HOOK_PATH} {`,
    ` proxy_pass http://127.0.0.1:${Number(port)};`,
    ` proxy_set_header Host $host;`,
    ` proxy_set_header X-Forwarded-For $remote_addr;`,
    ` proxy_set_header X-Forwarded-Proto $scheme;`,
    ` client_max_body_size 16k;`,
    ` }`,
  ].join('\n');
}

/**
 * The deploy hook port to expose on `domainName`, or null.
 *
 * @param {string} domainName
 * @param {Object} config Result of loadConfig()
 * @returns {number|null}
 */
export function deployHookPortFor(domainName, config) {
  const hook = config?.deployHook;
  if (!hook?.enabled || !hook.domain || hook.domain !== domainName) return null;
  const port = Number(hook.port);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * True when a config already contains an ACME challenge location.
 * Used to detect configs generated before this feature existed.
 *
 * @param {string} confText
 * @returns {boolean}
 */
export function hasChallengeLocation(confText) {
  if (typeof confText !== 'string') return false;
  return new RegExp(
    `location\\s+\\^~\\s+${ACME_CHALLENGE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  ).test(confText);
}

/**
 * Extracts the addresses a config's port-80 server blocks listen on.
 *
 * The preflight needs this: a config that says `listen 203.0.113.5:80` is not
 * reachable on 127.0.0.1, and probing the wrong address would look like a
 * broken challenge setup when nothing is actually wrong.
 *
 * @param {string} confText
 * @param {number} [port] Port to filter on
 * @returns {Array<{ host: string, port: number, wildcard: boolean }>}
 */
export function parseListenAddresses(confText, port = 80) {
  if (typeof confText !== 'string') return [];

  // Strip comments so a commented-out `# listen 80;` is never counted, then
  // match anywhere rather than at line start — directives are not always on
  // their own line in hand-edited configs.
  const stripped = confText.replace(/#[^\n]*/g, '');

  const found = [];
  const re = /\blisten\s+([^;]+);/g;
  let match;

  while ((match = re.exec(stripped)) !== null) {
    // Strip option words such as `default_server`, `ssl`, `http2`.
    const spec = match[1].trim().split(/\s+/)[0];
    if (!spec) continue;

    let host = null;
    let listenPort = null;

    if (/^\[(.+)\]:(\d+)$/.test(spec)) {
      const m = spec.match(/^\[(.+)\]:(\d+)$/);        // [::]:80
      host = m[1];
      listenPort = Number(m[2]);
    } else if (/^\d+$/.test(spec)) {
      listenPort = Number(spec);                        // 80
      host = '0.0.0.0';
    } else if (/^([^:]+):(\d+)$/.test(spec)) {
      const m = spec.match(/^([^:]+):(\d+)$/);          // 1.2.3.4:80
      host = m[1];
      listenPort = Number(m[2]);
    } else {
      continue;                                         // unix: sockets etc.
    }

    if (listenPort !== port) continue;

    const wildcard = host === '0.0.0.0' || host === '*' || host === '::' || host === '[::]';
    found.push({ host, port: listenPort, wildcard });
  }

  return found;
}

/**
 * Formats a certificate path for inclusion in a config file.
 * @param {string} p
 * @param {string} style One of CERT_PATH_STYLES
 * @returns {string}
 */
function formatCertPath(p, style) {
  if (isWindows && style === CERT_PATH_STYLES.ESCAPED) return toEscapedNginxPath(p);
  return toNginxPath(p);
}

/** Returns the conf.d directory for domain config files. */
export function getConfDDir(nginxDir) {
  // Explicit win32/posix instead of the host default: `isWindows` is the only
  // decision, so the generated location cannot depend on which OS runs the
  // code (and a simulated platform in tests gets the real separators).
  return isWindows
    ? path.win32.join(nginxDir, 'conf', 'conf.d')
    : path.posix.join(nginxDir, 'conf.d');
}

/** Returns the path to nginx.conf. */
function getNginxConfPath(nginxDir) {
  return isWindows
    ? path.join(nginxDir, 'conf', 'nginx.conf')
    : path.join(nginxDir, 'nginx.conf');
}

/** Returns the include directive line for this platform. */
function buildIncludeLine(nginxDir) {
  if (isWindows) {
    const fwd = nginxDir.replace(/\\/g, '/');
    return ` include "${fwd}/conf/conf.d/*.conf";`;
  }
  return ` include ${nginxDir}/conf.d/*.conf;`;
}

/**
 * Ensures that nginx.conf contains an include directive for conf.d/*.conf.
 * If the line is missing it is inserted just before the closing } of the http block.
 * @param {string} nginxDir
 */
export async function ensureNginxInclude(nginxDir) {
  const confPath = getNginxConfPath(nginxDir);

  let content;
  try {
    content = await fs.readFile(confPath, 'utf8');
  } catch {
    return; // nginx.conf not present yet — skip silently
  }

  // Already has a conf.d include
  if (/include\s+[^\n]*conf\.d[^\n]*\*\.conf/.test(content)) return;

  const includeLine = buildIncludeLine(nginxDir);

  // Insert before the last } in the file (closes the http block)
  const lastBrace = content.lastIndexOf('}');
  if (lastBrace === -1) return;

  const newContent =
    content.slice(0, lastBrace) +
    `${includeLine}\n` +
    content.slice(lastBrace);

  await fs.writeFile(confPath, newContent, 'utf8');
}

// ─── DOMAIN DEFAULTS (v2 schema) ─────────────────────────────────────────────

export const DOMAIN_DEFAULTS = {
  backendHost: '127.0.0.1',
  upstreamType: 'http', // 'http' | 'https' | 'ws'
  www: false,
  wildcard: false,    // *.example.com server_name; forces DNS-01
  enabled: true,      // false = conf file renamed to .conf.disabled
  behindCloudflare: false, // true = trust CF-Connecting-IP from Cloudflare ranges
  ssl: {
    enabled: false,
    certPath: '',
    keyPath: '',
    redirect: true,
    hsts: false,
    hstsMaxAge: 31536000, // 1 year
  },
  performance: {
    maxBodySize: '10m',
    readTimeout: 60,
    connectTimeout: 10,
    proxyBuffers: false,
    gzip: true,
    gzipTypes: 'text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript',
  },
  security: {
    rateLimit: false,
    rateLimitRate: 10,
    rateLimitBurst: 20,
    securityHeaders: false,
    custom404: false,
    custom50x: false,
  },
  advanced: {
    accessLog: true,
    customLocations: '',
  },
};

// ─── MIGRATION: v1 → v2 ──────────────────────────────────────────────────────

export function migrateDomain(d) {
  if (!d) return d;

  // Already v2 format (has nested ssl object)
  if (d.ssl && typeof d.ssl === 'object') {
    // Ensure all nested properties exist with defaults
    return {
      ...DOMAIN_DEFAULTS,
      ...d,
      wildcard: d.wildcard ?? false,
      enabled: d.enabled ?? true,
      behindCloudflare: d.behindCloudflare ?? false,
      ssl: { ...DOMAIN_DEFAULTS.ssl, ...d.ssl },
      performance: { ...DOMAIN_DEFAULTS.performance, ...d.performance },
      security: { ...DOMAIN_DEFAULTS.security, ...d.security },
      advanced: { ...DOMAIN_DEFAULTS.advanced, ...d.advanced },
    };
  }

  // v1 flat schema → v2 nested
  return {
    ...DOMAIN_DEFAULTS,
    name: d.name,
    port: d.port,
    www: d.www ?? false,
    backendHost: d.backendHost ?? '127.0.0.1',
    upstreamType: d.upstreamType ?? 'http',
    ssl: {
      ...DOMAIN_DEFAULTS.ssl,
      enabled: d.sslEnabled ?? false,
      certPath: d.certPath ?? '',
      keyPath: d.keyPath ?? '',
    },
    performance: {
      ...DOMAIN_DEFAULTS.performance,
      maxBodySize: d.maxBodySize ?? '10m',
    },
    security: { ...DOMAIN_DEFAULTS.security },
    advanced: { ...DOMAIN_DEFAULTS.advanced },
    wildcard: d.wildcard ?? false,
    enabled: d.enabled ?? true,
    behindCloudflare: d.behindCloudflare ?? false,
    configFile: d.configFile ?? null,
    createdAt: d.createdAt ?? new Date().toISOString(),
    updatedAt: d.updatedAt ?? new Date().toISOString(),
  };
}

// ─── CONF BUILDER ─────────────────────────────────────────────────────────────

/**
 * Builds an nginx server block configuration from a domain object.
 * @param {Object} domain - Domain configuration object (v2 schema)
 * @param {string} nginxDir - Nginx directory path
 * @param {string} sslDir - SSL certificate directory path
 * @param {Object} [options]
 * @param {string} [options.certPathStyle] - One of CERT_PATH_STYLES (default 'forward')
 * @returns {string} Complete nginx conf content for the domain
 */
export function buildConf(domain, nginxDir, sslDir, options = {}) {
  const certPathStyle = options.certPathStyle ?? CERT_PATH_STYLES.FORWARD;
  const {
    name,
    port,
    backendHost = '127.0.0.1',
    upstreamType = 'http',
    www = false,
    ssl,
    performance,
    security,
    advanced,
  } = domain;

  // Determine proxy scheme based on upstreamType
  const proxyScheme = upstreamType === 'https' ? 'https' : 'http';

  // Detect if backendHost is a full external URL (e.g. https://app.vercel.app)
  const backendIsUrl = /^https?:\/\//i.test(backendHost);

  // Host header: for external URLs send the upstream's own hostname so the
  // remote service (Vercel, Railway, etc.) can route the request correctly.
  // For local upstreams keep $host (the client's domain).
  let upstreamHostHeader = '$host';
  if (backendIsUrl) {
    try { upstreamHostHeader = new URL(backendHost).host; } catch { /* keep $host */ }
  }

  // Build proxy headers (always include standard set).
  //
  // WebSocket-ready for EVERY proxied domain: `$ezz_connection_upgrade` is empty
  // for a plain request (see buildWebsocketMapConf) and `upgrade` only when the
  // client asked for an upgrade. The old `Connection "upgrade"` forced every
  // ordinary request to claim an upgrade, which is wrong.
  const proxyHeaders = `
 proxy_http_version 1.1;
 proxy_set_header Upgrade $http_upgrade;
 proxy_set_header Connection $ezz_connection_upgrade;
 proxy_set_header Host ${upstreamHostHeader};
 proxy_set_header X-Real-IP $remote_addr;
 proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 proxy_set_header X-Forwarded-Proto $scheme;`;

  // Build rate limiting zone name (dots → underscores)
  const rateLimitZone = name.replace(/\./g, '_').replace(/\*/g, 'wildcard');

  // SSL cert/key paths — fall back to the sslDir convention when unset.
  // sslDir is normalised first so a Windows value (C:\ssl) does not produce a
  // mixed-separator path like C:\ssl/example.com/fullchain.pem.
  const sslBase = toNginxPath(sslDir).replace(/\/+$/, '');
  const rawCertPath = ssl?.certPath || `${sslBase}/${name}/fullchain.pem`;
  const rawKeyPath = ssl?.keyPath || `${sslBase}/${name}/privkey.pem`;
  const certPath = formatCertPath(rawCertPath, certPathStyle);
  const keyPath = formatCertPath(rawKeyPath, certPathStyle);

  // Build the config sections
  const sections = [];

  // ─── Rate Limit Zone Comment ────────────────────────────────────────────────
  if (security?.rateLimit) {
    sections.push(`# Rate limit zone — add to nginx.conf http block:
 # limit_req_zone $binary_remote_addr zone=${rateLimitZone}:10m rate=${security.rateLimitRate}r/s;`);
  }

  // Compute server_name: wildcard covers all subdomains; www adds explicit www
  const wildcardEnabled = domain.wildcard ?? false;
  const mainServerNames = wildcardEnabled ? `*.${name} ${name}` : (www ? `${name} www.${name}` : name);
  const redirectServerNames = wildcardEnabled ? `*.${name} ${name}` : (www ? `${name} www.${name}` : name);

  // The ACME HTTP-01 challenge location, emitted into every port-80 server
  // block so certificates can be issued and renewed without stopping nginx.
  const challengeLocation = buildChallengeLocation(options.acmeChallengePort);

  // ─── WWW Redirect (non-SSL, non-wildcard only) ───────────────────────────────
  //
  // NOTE: the redirect lives in `location /`, NOT at server level. nginx runs a
  // server-level `return` during the rewrite phase, before location matching,
  // so a server-level redirect would swallow the challenge request and answer
  // 301 instead of serving the token.
  if (www && !ssl?.enabled && !wildcardEnabled) {
    sections.push(`server {
 listen 80;
 server_name www.${name};
${challengeLocation}
 location / {
 return 301 http://${name}$request_uri;
 }
 }`);
  }

  // ─── HTTP → HTTPS Redirect ──────────────────────────────────────────────────
  // Same rule as above: the redirect must sit inside `location /`.
  if (ssl?.enabled && ssl?.redirect) {
    sections.push(`server {
 listen 80;
 server_name ${redirectServerNames};
${challengeLocation}
 location / {
 return 301 https://${name}$request_uri;
 }
 }`);
  }

  // ─── Challenge-only port 80 (SSL on, redirect off) ──────────────────────────
  //
  // Without this the domain has no port-80 listener at all, so an HTTP-01
  // renewal could never reach us and every renewal would be forced into
  // standalone mode (stopping nginx). This block serves the ACME path and
  // nothing else — plain HTTP traffic still gets a 404, as before.
  if (ssl?.enabled && !ssl?.redirect) {
    sections.push(`server {
 listen 80;
 server_name ${redirectServerNames};
${challengeLocation}
 location / {
 return 404;
 }
 }`);
  }

  // ─── Main Server Block ──────────────────────────────────────────────────────
  const listenPort = ssl?.enabled ? '443 ssl' : '80';
  const serverNames = mainServerNames;

  const mainBlock = [];

  mainBlock.push(`server {`);
  mainBlock.push(` listen ${listenPort};`);
  mainBlock.push(` server_name ${serverNames};`);

  // ─── Cloudflare real IP (per domain, opt-in) ────────────────────────────────
  // set_real_ip_from only says whose X-Forwarded-For/CF-Connecting-IP to
  // believe. It does NOT stop a direct connection to this origin: limit ports
  // 80/443 to Cloudflare's ranges at the firewall for that. The app then trusts
  // exactly one proxy — for the Hub that is TRUST_PROXY=1.
  if (domain.behindCloudflare === true) {
    mainBlock.push(``);
    mainBlock.push(` # Behind Cloudflare: trust CF-Connecting-IP only from Cloudflare ranges.`);
    mainBlock.push(` # The app trusts one proxy (Hub: TRUST_PROXY=1); firewall 80/443 to these ranges to block direct origin access.`);
    for (const range of CLOUDFLARE_RANGES) {
      mainBlock.push(` set_real_ip_from ${range};`);
    }
    mainBlock.push(` real_ip_header CF-Connecting-IP;`);
  }

  // When this block is the port-80 listener (SSL off) it must answer the ACME
  // challenge too. `location ^~` outranks the `location /` proxy below.
  if (!ssl?.enabled) {
    mainBlock.push(``);
    mainBlock.push(challengeLocation);
  }

  // SSL configuration
  if (ssl?.enabled) {
    mainBlock.push(``);
    // The comment is Windows-only: on Linux the path form never varies.
    if (isWindows) mainBlock.push(` ${CERT_PATH_COMMENTS[certPathStyle]}`);
    mainBlock.push(` ssl_certificate ${certPath};`);
    mainBlock.push(` ssl_certificate_key ${keyPath};`);
  }

  // Performance: client_max_body_size
  mainBlock.push(``);
  mainBlock.push(` client_max_body_size ${performance?.maxBodySize || '10m'};`);

  // Performance: gzip
  if (performance?.gzip) {
    mainBlock.push(` gzip on;`);
    mainBlock.push(` gzip_types ${performance?.gzipTypes || DOMAIN_DEFAULTS.performance.gzipTypes};`);
  }

  // Performance: proxy buffering
  if (performance?.proxyBuffers) {
    mainBlock.push(` proxy_buffering on;`);
  }

  // Logging - use platform-appropriate log path
  if (advanced?.accessLog) {
    const logDir = isWindows ? `${nginxDir.replace(/\\/g, '/')}/logs` : '/var/log/nginx';
    mainBlock.push(` access_log ${logDir}/${name}.access.log;`);
  }

  // The deploy hook, when this domain is the one chosen to expose it. It goes
  // in the block that actually serves the site (443 with SSL on, 80 without),
  // so the hook is reached over HTTPS whenever the domain has a certificate.
  if (options.deployHookPort) {
    mainBlock.push(``);
    mainBlock.push(buildDeployHookLocation(options.deployHookPort));
  }

  // ─── Location Blocks ────────────────────────────────────────────────────────
  // proxy_pass: full external URL → use directly (no scheme/port added)
  // local backend → build from scheme + host + port
  const proxyTarget = backendIsUrl
    ? backendHost.replace(/\/$/, '')
    : `${proxyScheme}://${backendHost}:${port}`;

  // Add proxy_ssl_server_name for external HTTPS upstreams (SNI — required for Vercel, Railway, etc.)
  // Only when: HTTPS URL, not an IP address, not localhost, and nginx itself is not terminating SSL
  // (if nginx has its own cert the backend connection is separate — SNI directive is irrelevant)
  let needsSni = false;
  if (backendIsUrl && /^https:/i.test(backendHost) && !ssl?.enabled) {
    let upstreamHostname = '';
    try { upstreamHostname = new URL(backendHost).hostname; } catch { /* skip */ }
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(upstreamHostname) || upstreamHostname.startsWith('[');
    const isLocal = upstreamHostname === 'localhost' || upstreamHostname === '127.0.0.1';
    needsSni = !isIp && !isLocal;
  }

  // Socket.IO / WebSocket path: no buffering and long idle timeouts. `^~` makes
  // it win over `location /` (and regex locations) without stopping ordinary
  // HTTP on the rest of the domain.
  mainBlock.push(``);
  mainBlock.push(` # Socket.IO / WebSockets — long-lived, unbuffered.`);
  mainBlock.push(` location ^~ ${SOCKET_IO_PATH} {`);
  mainBlock.push(` proxy_pass ${proxyTarget};`);
  if (needsSni) mainBlock.push(` proxy_ssl_server_name on;`);
  mainBlock.push(proxyHeaders);
  mainBlock.push(``);
  mainBlock.push(` proxy_buffering off;`);
  mainBlock.push(` proxy_read_timeout ${SOCKET_IO_TIMEOUT};`);
  mainBlock.push(` proxy_send_timeout ${SOCKET_IO_TIMEOUT};`);
  mainBlock.push(` }`);

  mainBlock.push(``);
  mainBlock.push(` location / {`);
  mainBlock.push(` proxy_pass ${proxyTarget};`);
  if (needsSni) mainBlock.push(` proxy_ssl_server_name on;`);
  mainBlock.push(proxyHeaders);
  mainBlock.push(``);
  mainBlock.push(` proxy_read_timeout ${performance?.readTimeout || 60}s;`);
  mainBlock.push(` proxy_connect_timeout ${performance?.connectTimeout || 10}s;`);

  // Rate limiting
  if (security?.rateLimit) {
    mainBlock.push(``);
    mainBlock.push(` limit_req zone=${rateLimitZone} burst=${security.rateLimitBurst} nodelay;`);
  }

  // Security headers
  if (security?.securityHeaders) {
    mainBlock.push(``);
    mainBlock.push(` add_header X-Frame-Options "SAMEORIGIN" always;`);
    mainBlock.push(` add_header X-Content-Type-Options "nosniff" always;`);
    mainBlock.push(` add_header Referrer-Policy "strict-origin-when-cross-origin" always;`);
  }

  // HSTS
  if (ssl?.enabled && ssl?.hsts) {
    mainBlock.push(``);
    mainBlock.push(` add_header Strict-Transport-Security "max-age=${ssl.hstsMaxAge}; includeSubDomains" always;`);
  }

  mainBlock.push(` }`);

  // Custom error pages
  if (security?.custom404 || security?.custom50x) {
    mainBlock.push(``);
    if (security.custom404) {
      mainBlock.push(` error_page 404 /404.html;`);
    }
    if (security.custom50x) {
      mainBlock.push(` error_page 500 502 503 504 /50x.html;`);
    }
    if (security.custom404) {
      mainBlock.push(` location = /404.html { root ${isWindows ? nginxDir.replace(/\\/g, '/') + '/html' : '/usr/share/nginx/html'}; internal; }`);
    }
    if (security.custom50x) {
      mainBlock.push(` location = /50x.html { root ${isWindows ? nginxDir.replace(/\\/g, '/') + '/html' : '/usr/share/nginx/html'}; internal; }`);
    }
  }

  // Custom location blocks
  if (advanced?.customLocations && advanced.customLocations.trim()) {
    mainBlock.push(``);
    mainBlock.push(` # Custom locations`);
    mainBlock.push(advanced.customLocations);
  }

  mainBlock.push(`}`);

  sections.push(mainBlock.join('\n'));

  return sections.join('\n\n') + '\n';
}

// ─── FILE GENERATION ──────────────────────────────────────────────────────────

/**
 * Generates and writes an nginx conf file for a domain.
 * @param {Object} domain - Domain configuration object
 * @returns {Promise<string>} Path to the generated conf file
 */
export async function generateConf(domain, options = {}) {
  const config = loadConfig();
  const { nginxDir, sslDir, acmeChallengePort } = config;
  const confDir = getConfDDir(nginxDir);
  const confPath = path.join(confDir, `${domain.name}.conf`);
  const confContent = buildConf(domain, nginxDir, sslDir, {
    acmeChallengePort,
    deployHookPort: deployHookPortFor(domain.name, config),
    ...options,
  });

  // Ensure conf.d directory exists
  await fs.mkdir(confDir, { recursive: true });
  await fs.writeFile(confPath, confContent, 'utf8');

  // The single WebSocket map lives in its own conf.d file, so every domain can
  // reference $ezz_connection_upgrade without defining the map itself.
  await ensureWebsocketMap(nginxDir);

  // Ensure nginx.conf includes conf.d
  await ensureNginxInclude(nginxDir);

  // Update domain with config file path
  domain.configFile = confPath;
  domain.updatedAt = new Date().toISOString();

  return confPath;
}

/**
 * Generates the default SSL certificate paths for a domain.
 *
 * Always returns forward slashes on Windows, matching what is written into the
 * config. The sslDir argument is honoured on every platform: certificates are
 * actually issued into `path.join(sslDir, domainName)`, so suggesting a
 * different fixed directory pointed users at files that were never there.
 *
 * @param {string} domainName - Domain name
 * @param {string} platform - 'win32' or 'linux'
 * @param {string} sslDir - SSL directory from config
 * @returns {Object} { certPath, keyPath }
 */
export function getDefaultCertPaths(domainName, platform, sslDir) {
  const fallback = platform === 'win32' ? 'C:\\easy-devops\\ssl' : '/etc/easy-devops/ssl';
  const base = String(sslDir || fallback)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');

  return {
    certPath: `${base}/${domainName}/fullchain.pem`,
    keyPath: `${base}/${domainName}/privkey.pem`,
  };
}
