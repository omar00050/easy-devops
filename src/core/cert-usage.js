/**
 * core/cert-usage.js
 *
 * Who uses a certificate, whether a domain's certificate files exist, and
 * deleting a certificate safely. Shared by the dashboard's SSL and domain
 * controllers and by the Hub agent, so the two cannot drift: the same refusal
 * protects a certificate whichever side asks to delete it.
 */

import fs from 'fs/promises';
import path from 'path';
import { loadConfig } from './config.js';
import { listAllCerts } from './cert-reader.js';
import { getDomains } from './domains-db.js';
import { getDefaultCertPaths } from './nginx-conf-generator.js';
import { getDataDir, isWindows } from './platform.js';
import {
  acquireArtifactLock,
  SSL_ARTIFACT_LIFECYCLE_LOCK,
} from './ssl/artifact-lock.js';
import { removeManagedCertificateDomain } from './ssl/managed-artifacts.js';

// nginx writes its logs and scratch files here; those can grow large and never
// contain certificate paths.
const NGINX_SKIP_DIRS = new Set([
  'logs', 'temp', 'client_body_temp', 'proxy_temp', 'fastcgi_temp', 'uwsgi_temp', 'scgi_temp',
]);

/**
 * Flattens a path so nginx configs written with forward slashes, Windows
 * backslashes or doubled separators all compare equal.
 */
function comparablePath(value) {
  const slashed = String(value ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return isWindows ? slashed.toLowerCase() : slashed;
}

function resolveAgainst(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(base, value);
}

async function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function pointsAtPath(candidate, target) {
  if (!candidate || !target) return false;
  const [left, right] = await Promise.all([canonicalPath(candidate), canonicalPath(target)]);
  if (comparablePath(left) === comparablePath(right)) return true;
  try {
    const [a, b] = await Promise.all([fs.stat(left), fs.stat(right)]);
    return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/**
 * Collects every nginx configuration file under `dir` — the main nginx.conf,
 * domain configs, and the `.conf.disabled` copies a disabled domain leaves.
 */
async function collectConfigFiles(dir, state = null) {
  const current = state ?? {
    found: [],
    directories: new Set(),
    files: new Set(),
  };

  let canonicalDir;
  try {
    canonicalDir = await fs.realpath(dir);
  } catch {
    return current.found;
  }
  const dirKey = comparablePath(canonicalDir);
  if (current.directories.has(dirKey)) return current.found;
  current.directories.add(dirKey);

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return current.found;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (NGINX_SKIP_DIRS.has(entry.name.toLowerCase())) continue;

    let kind = entry;
    if (entry.isSymbolicLink()) {
      try {
        kind = await fs.stat(full);
      } catch {
        continue;
      }
    }
    if (kind.isDirectory()) {
      await collectConfigFiles(full, current);
      continue;
    }
    if (!kind.isFile()) continue;
    const name = entry.name.toLowerCase();
    if (!name.endsWith('.conf') && !name.endsWith('.conf.disabled')) continue;
    let canonicalFile;
    try {
      canonicalFile = await fs.realpath(full);
    } catch {
      continue;
    }
    const fileKey = comparablePath(canonicalFile);
    if (current.files.has(fileKey)) continue;
    current.files.add(fileKey);
    current.found.push(full);
  }

  return current.found;
}

/**
 * Finds every nginx config line that points at a file inside the certificate's
 * directory, so deletion cannot leave nginx referencing missing files.
 *
 * @returns {Promise<Array<{ file: string, line: number, text: string }>>}
 */
export async function findCertReferences(domain, config = loadConfig()) {
  const directory = path.join(config.sslDir, domain);
  const target = `${comparablePath(directory).replace(/\/+$/, '')}/`;
  const targetFiles = [
    path.join(directory, 'fullchain.pem'),
    path.join(directory, 'privkey.pem'),
  ];
  const files = await collectConfigFiles(config.nginxDir);
  const references = [];

  for (const file of files) {
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    for (const [index, text] of content.split(/\r?\n/).entries()) {
      let matched = comparablePath(text).includes(target);
      if (!matched) {
        const candidates = new Set();
        for (const match of text.matchAll(/(["'])(.*?)\1|(?:^|\s)([^\s;{}]+)/g)) {
          const value = (match[2] ?? match[3] ?? '').trim().replace(/[;,]+$/, '');
          if (value.includes('/') || value.includes('\\')) candidates.add(value);
        }
        for (const candidate of candidates) {
          if (candidate.includes('$') || candidate.includes('%')) {
            matched = comparablePath(candidate).includes(comparablePath(domain));
            if (matched) break;
            continue;
          }
          const resolved = resolveAgainst(candidate.replace(/['"]/g, ''), config.nginxDir);
          for (const certificateFile of targetFiles) {
            if (await pointsAtPath(resolved, certificateFile)) {
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
      }
      if (matched) {
        references.push({ file, line: index + 1, text: text.trim() });
      }
    }
  }

  return references;
}

/**
 * The enabled domains with SSL on whose configured certificate lives in the
 * directory for `certDomain` (or that are named `certDomain` themselves).
 *
 * @returns {string[]} domain names
 */
export async function domainsUsingCert(certDomain, config = loadConfig()) {
  const dir = comparablePath(path.join(config.sslDir, certDomain)).replace(/\/+$/, '');
  const targetFiles = [
    path.join(config.sslDir, certDomain, 'fullchain.pem'),
    path.join(config.sslDir, certDomain, 'privkey.pem'),
  ];
  const inside = (p) => {
    if (typeof p !== 'string' || !p.trim()) return false;
    const value = comparablePath(path.resolve(config.nginxDir, p));
    return value === dir || value.startsWith(`${dir}/`);
  };

  const usedBy = [];
  for (const domain of getDomains().filter((entry) => entry.enabled !== false && entry.ssl?.enabled)) {
    if (domain.name === certDomain || inside(domain.ssl?.certPath) || inside(domain.ssl?.keyPath)) {
      usedBy.push(domain.name);
      continue;
    }

    const candidates = [
      resolveAgainst(domain.ssl?.certPath, config.nginxDir),
      resolveAgainst(domain.ssl?.keyPath, config.nginxDir),
    ].filter(Boolean);
    let matches = false;
    for (const candidate of candidates) {
      for (const targetFile of targetFiles) {
        if (await pointsAtPath(candidate, targetFile)) {
          matches = true;
          break;
        }
      }
      if (matches) break;
    }
    if (matches) usedBy.push(domain.name);
  }
  return usedBy;
}

/**
 * Resolves the paths nginx will load and reports them when either file is
 * missing. Blank fields use the same `${sslDir}/${name}` fallback as the
 * config generator, so this check matches the generated config.
 *
 * @param {{ name: string, ssl?: { enabled?: boolean, certPath?: string, keyPath?: string } }} domain
 * @returns {Promise<{ certPath: string, keyPath: string } | null>}
 */
export async function missingCertFiles(domain) {
  if (!domain?.ssl?.enabled) return null;

  const { sslDir } = loadConfig();
  const defaults = getDefaultCertPaths(domain.name, isWindows ? 'win32' : 'linux', sslDir);
  const certPath = domain.ssl.certPath || defaults.certPath;
  const keyPath = domain.ssl.keyPath || defaults.keyPath;

  try {
    await fs.access(certPath, fs.constants.F_OK);
    await fs.access(keyPath, fs.constants.F_OK);
    return null;
  } catch {
    return { certPath, keyPath };
  }
}

export const CERT_MISSING_HINT =
  'The SSL certificate files do not exist at the configured paths. Create the certificate first, or disable SSL.';

/**
 * Runs a certificate-reference mutation while holding the same cross-process
 * lock used by issuance, deletion and purge.
 */
export async function withCertificateLifecycleLock(fn, {
  dataDir = getDataDir(),
  timeoutMs = 60_000,
} = {}) {
  const lifecycle = await acquireArtifactLock({
    dataDir,
    key: SSL_ARTIFACT_LIFECYCLE_LOCK,
    timeoutMs,
  });
  try {
    return await fn(lifecycle);
  } finally {
    lifecycle.release();
  }
}

/**
 * Deletes one certificate directory under sslDir while the caller holds the
 * lifecycle lock.
 *
 * The directory name is taken from listAllCerts(), never from the caller:
 * listAllCerts() only returns direct children of sslDir, so a name such as
 * `..` or `a/../../etc` simply is not found. This is the guard against path
 * traversal and must stay that way — the caller's string never reaches fs.rm.
 *
 * Refuses while the certificate is in use: an enabled domain with SSL points
 * at it, or any nginx config line references a file inside it (that covers
 * disabled domains' `.conf.disabled` copies and hand-written configs too).
 *
 * @param {string} domain
 * @returns {Promise<
 *   { ok: true, domain: string, directory: string } |
 *   { ok: false, code: 'cert_not_found', domain: string } |
 *   { ok: false, code: 'cert_in_use', domain: string, directory: string, usedBy: string[], references: Array<{ file: string, line: number, text: string }> } |
 *   { ok: false, code: 'delete_failed', domain: string, directory: string, detail: string }
 * >}
 */
export async function deleteCertificateUnderLock(domain, lifecycle, {
  dataDir = getDataDir(),
  config = loadConfig(),
} = {}) {
  if (!lifecycle?.isOwner?.()) {
    return {
      ok: false,
      code: 'delete_failed',
      domain: String(domain ?? ''),
      detail: 'The certificate lifecycle lock is not held by this operation.',
    };
  }

  const certs = await listAllCerts({ sslDir: config.sslDir, includeUnusable: true });
  const cert = typeof domain === 'string' ? certs.find((entry) => entry.domain === domain) : null;
  if (!cert) return { ok: false, code: 'cert_not_found', domain: String(domain ?? '') };

  const directory = path.join(config.sslDir, cert.domain);
  const usedBy = await domainsUsingCert(cert.domain, config);
  const references = await findCertReferences(cert.domain, config);

  if (usedBy.length > 0 || references.length > 0) {
    return { ok: false, code: 'cert_in_use', domain: cert.domain, directory, usedBy, references };
  }

  const removed = removeManagedCertificateDomain({
    dataDir,
    sslDir: config.sslDir,
    domain: cert.domain,
  });
  if (!removed.ok) {
    return {
      ...removed,
      domain: cert.domain,
      directory,
      detail: removed.detail ?? 'The certificate could not be deleted safely.',
    };
  }
  return {
    ok: true,
    domain: cert.domain,
    directory,
    removedFiles: removed.removedFiles,
  };
}

/** Deletes one managed certificate directory under the lifecycle lock. */
export async function deleteCertificate(domain) {
  return withCertificateLifecycleLock(
    (lifecycle) => deleteCertificateUnderLock(domain, lifecycle),
  );
}
