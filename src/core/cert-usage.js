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
import { isWindows } from './platform.js';

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

/**
 * Collects every nginx configuration file under `dir` — the main nginx.conf,
 * domain configs, and the `.conf.disabled` copies a disabled domain leaves.
 */
async function collectConfigFiles(dir, found = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NGINX_SKIP_DIRS.has(entry.name.toLowerCase())) {
        await collectConfigFiles(full, found);
      }
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const name = entry.name.toLowerCase();
    if (name.endsWith('.conf') || name.endsWith('.conf.disabled')) found.push(full);
  }

  return found;
}

/**
 * Finds every nginx config line that points at a file inside the certificate's
 * directory, so deletion cannot leave nginx referencing missing files.
 *
 * @returns {Promise<Array<{ file: string, line: number, text: string }>>}
 */
export async function findCertReferences(domain, config = loadConfig()) {
  const target = `${comparablePath(path.join(config.sslDir, domain)).replace(/\/+$/, '')}/`;
  const files = await collectConfigFiles(config.nginxDir);
  const references = [];

  for (const file of files) {
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    content.split(/\r?\n/).forEach((text, index) => {
      if (comparablePath(text).includes(target)) {
        references.push({ file, line: index + 1, text: text.trim() });
      }
    });
  }

  return references;
}

/**
 * The enabled domains with SSL on whose configured certificate lives in the
 * directory for `certDomain` (or that are named `certDomain` themselves).
 *
 * @returns {string[]} domain names
 */
export function domainsUsingCert(certDomain, config = loadConfig()) {
  const dir = comparablePath(path.join(config.sslDir, certDomain)).replace(/\/+$/, '');
  const inside = (p) => {
    const value = comparablePath(p);
    return value === dir || value.startsWith(`${dir}/`);
  };

  return getDomains()
    .filter((d) => d.enabled !== false && d.ssl?.enabled)
    .filter((d) => d.name === certDomain || inside(d.ssl?.certPath) || inside(d.ssl?.keyPath))
    .map((d) => d.name);
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
 * Deletes one certificate directory under sslDir.
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
export async function deleteCertificate(domain) {
  const config = loadConfig();
  const certs = await listAllCerts({ includeUnusable: true });
  const cert = typeof domain === 'string' ? certs.find((entry) => entry.domain === domain) : null;
  if (!cert) return { ok: false, code: 'cert_not_found', domain: String(domain ?? '') };

  const directory = path.join(config.sslDir, cert.domain);
  const usedBy = domainsUsingCert(cert.domain, config);
  const references = await findCertReferences(cert.domain, config);

  if (usedBy.length > 0 || references.length > 0) {
    return { ok: false, code: 'cert_in_use', domain: cert.domain, directory, usedBy, references };
  }

  try {
    await fs.rm(directory, { recursive: true, force: true });
  } catch (error) {
    return {
      ok: false, code: 'delete_failed', domain: cert.domain, directory,
      detail: `Could not delete ${directory}: ${error.message}`,
    };
  }

  return { ok: true, domain: cert.domain, directory };
}
