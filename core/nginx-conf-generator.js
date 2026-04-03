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
import { isWindows } from './platform.js';

/** Returns the conf.d directory for domain config files. */
export function getConfDDir(nginxDir) {
  return isWindows
    ? path.join(nginxDir, 'conf', 'conf.d')
    : path.join(nginxDir, 'conf.d');
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
 * @returns {string} Complete nginx conf content for the domain
 */
export function buildConf(domain, nginxDir, sslDir) {
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

  // Build proxy headers (always include standard set)
  let proxyHeaders = `
 proxy_set_header Host ${upstreamHostHeader};
 proxy_set_header X-Real-IP $remote_addr;
 proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 proxy_set_header X-Forwarded-Proto $scheme;`;

  // Add WebSocket headers if upstreamType is 'ws'
  if (upstreamType === 'ws') {
    proxyHeaders = `
 proxy_http_version 1.1;
 proxy_set_header Upgrade $http_upgrade;
 proxy_set_header Connection "upgrade";${proxyHeaders}`;
  }

  // Build rate limiting zone name (dots → underscores)
  const rateLimitZone = name.replace(/\./g, '_').replace(/\*/g, 'wildcard');

  // SSL cert/key paths - use sslDir convention if empty
  const certPath = ssl?.certPath || `${sslDir}/${name}/fullchain.pem`;
  const keyPath = ssl?.keyPath || `${sslDir}/${name}/privkey.pem`;

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

  // ─── WWW Redirect (non-SSL, non-wildcard only) ───────────────────────────────
  if (www && !ssl?.enabled && !wildcardEnabled) {
    sections.push(`server {
 listen 80;
 server_name www.${name};
 return 301 http://${name}$request_uri;
 }`);
  }

  // ─── HTTP → HTTPS Redirect ──────────────────────────────────────────────────
  if (ssl?.enabled && ssl?.redirect) {
    sections.push(`server {
 listen 80;
 server_name ${redirectServerNames};
 return 301 https://${name}$request_uri;
 }`);
  }

  // ─── Main Server Block ──────────────────────────────────────────────────────
  const listenPort = ssl?.enabled ? '443 ssl' : '80';
  const serverNames = mainServerNames;

  const mainBlock = [];

  mainBlock.push(`server {`);
  mainBlock.push(` listen ${listenPort};`);
  mainBlock.push(` server_name ${serverNames};`);

  // SSL configuration
  if (ssl?.enabled) {
    mainBlock.push(``);
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

  // ─── Location Block ─────────────────────────────────────────────────────────
  mainBlock.push(``);
  mainBlock.push(` location / {`);
  // proxy_pass: full external URL → use directly (no scheme/port added)
  // local backend → build from scheme + host + port
  const proxyTarget = backendIsUrl
    ? backendHost.replace(/\/$/, '')
    : `${proxyScheme}://${backendHost}:${port}`;
  mainBlock.push(` proxy_pass ${proxyTarget};`);
  // Add proxy_ssl_server_name for external HTTPS upstreams (SNI — required for Vercel, Railway, etc.)
  // Only when: HTTPS URL, not an IP address, not localhost, and nginx itself is not terminating SSL
  // (if nginx has its own cert the backend connection is separate — SNI directive is irrelevant)
  if (backendIsUrl && /^https:/i.test(backendHost) && !ssl?.enabled) {
    let upstreamHostname = '';
    try { upstreamHostname = new URL(backendHost).hostname; } catch { /* skip */ }
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(upstreamHostname) || upstreamHostname.startsWith('[');
    const isLocal = upstreamHostname === 'localhost' || upstreamHostname === '127.0.0.1';
    if (!isIp && !isLocal) {
      mainBlock.push(` proxy_ssl_server_name on;`);
    }
  }
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
export async function generateConf(domain) {
  const { nginxDir, sslDir } = loadConfig();
  const confDir = getConfDDir(nginxDir);
  const confPath = path.join(confDir, `${domain.name}.conf`);
  const confContent = buildConf(domain, nginxDir, sslDir);

  // Ensure conf.d directory exists
  await fs.mkdir(confDir, { recursive: true });
  await fs.writeFile(confPath, confContent, 'utf8');

  // Ensure nginx.conf includes conf.d
  await ensureNginxInclude(nginxDir);

  // Update domain with config file path
  domain.configFile = confPath;
  domain.updatedAt = new Date().toISOString();

  return confPath;
}

/**
 * Generates a default SSL certificate path for a domain based on platform.
 * @param {string} domainName - Domain name
 * @param {string} platform - 'win32' or 'linux'
 * @param {string} sslDir - SSL directory from config
 * @returns {Object} { certPath, keyPath }
 */
export function getDefaultCertPaths(domainName, platform, sslDir) {
  if (platform === 'win32') {
    return {
      certPath: `C:\\ssl\\${domainName}\\fullchain.pem`,
      keyPath: `C:\\ssl\\${domainName}\\privkey.pem`,
    };
  }
  return {
    certPath: `${sslDir}/${domainName}/fullchain.pem`,
    keyPath: `${sslDir}/${domainName}/privkey.pem`,
  };
}
