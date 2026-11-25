import fs from 'fs/promises';
import { dbGet, dbSet } from './db.js';
import { DOMAIN_DEFAULTS, migrateDomain } from './nginx-conf-generator.js';
import { writeConfWithTest } from './nginx-apply.js';
import { run } from './shell.js';
import { loadConfig } from './config.js';
import { isWindows, nginxTestCmd, nginxReloadCmd, isNginxTestOk } from './platform.js';
import { saveDomainNotifConfig } from './domainNotifier.js';
import { bumpHubRevision, getHubPermissions } from './hubLink.js';
import { nginxDomainError } from './nginx-fields.js';
import {
  missingCertFiles, CERT_MISSING_HINT,
  withCertificateLifecycleLock, deleteCertificateUnderLock,
} from './cert-usage.js';
import {
  validateDomainName, validatePort, validateUpstreamType,
  validateMaxBodySize, validateBehindCloudflare,
} from './validators.js';

// Re-export DOMAIN_DEFAULTS for consumers
export { DOMAIN_DEFAULTS, migrateDomain };

/**
 * Get all domains, applying v2 migration to each record.
 * @returns {Array} Array of domain objects (v2 schema)
 */
export function getDomains() {
  const raw = dbGet('domains') ?? [];
  return raw.map(migrateDomain);
}

/**
 * Save domains array to storage.
 * @param {Array} arr - Array of domain objects
 */
export function saveDomains(arr) {
  dbSet('domains', arr);

  // Every domain write goes through here — dashboard, CLI and hub alike — so
  // this is the one place that can tell the agent "something changed". The
  // agent polls the counter every few seconds and pushes only when it moves,
  // which is what gets CLI-side edits to the Hub in seconds instead of
  // waiting for the 5-minute config heartbeat.
  try {
    bumpHubRevision();
  } catch { /* never block a domain save on hub bookkeeping */ }
}

/**
 * Find a domain by name.
 * @param {string} name - Domain name to find
 * @returns {Object|undefined} Domain object or undefined
 */
export function findDomain(name) {
  return getDomains().find((d) => d.name === name);
}

/**
 * Create a new domain object with defaults merged.
 * @param {Object} partial - Partial domain data
 * @returns {Object} Complete domain object with defaults
 */
export function createDomain(partial) {
  const now = new Date().toISOString();
  return {
    ...DOMAIN_DEFAULTS,
    ...partial,
    ssl: { ...DOMAIN_DEFAULTS.ssl, ...partial.ssl },
    performance: { ...DOMAIN_DEFAULTS.performance, ...partial.performance },
    security: { ...DOMAIN_DEFAULTS.security, ...partial.security },
    advanced: { ...DOMAIN_DEFAULTS.advanced, ...partial.advanced },
    configFile: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Hub command handler ───────────────────────────────────────────────────────
// Called by hubAgent when the hub dispatches a hub:manageDomain event.
// Payload shape: { action: 'create'|'update'|'delete'|'toggle'|'reload', name?, domain? }

/**
 * The checks the dashboard's domain controller runs, applied to a Hub payload.
 * On update only the fields present are checked, as the dashboard does.
 *
 * @param {Object} input The payload's `domain`
 * @param {{ creating: boolean, existing?: Object }} options
 * @returns {string|null} The first problem, or null
 */
function hubDomainInputError(input, { creating, existing = null }) {
  const fieldError = nginxDomainError({ ...input, backendHost: input.backendHost ?? existing?.backendHost, name: creating ? input.name : existing.name });
  if (fieldError) return fieldError;
  const raw = input.advanced?.customLocations;
  if (raw !== undefined && (raw ?? '') !== (existing?.advanced?.customLocations ?? '') &&
      getHubPermissions()['nginx.config.edit'] !== true) {
    return "Permission 'nginx.config.edit' is required to change custom locations.";
  }
  if (creating) {
    const nameError = validateDomainName(input.name);
    if (nameError) return nameError;
  }

  const backendIsUrl = /^https?:\/\//i.test(input.backendHost ?? existing?.backendHost ?? '');
  if ((creating || input.port !== undefined) && !backendIsUrl) {
    const portError = validatePort(input.port);
    if (portError) return portError;
  }
  if (input.upstreamType !== undefined) {
    const upstreamError = validateUpstreamType(input.upstreamType);
    if (upstreamError) return upstreamError;
  }
  if (input.performance?.maxBodySize !== undefined) {
    const sizeError = validateMaxBodySize(input.performance.maxBodySize);
    if (sizeError) return sizeError;
  }
  if (input.behindCloudflare !== undefined) {
    const cloudflareError = validateBehindCloudflare(input.behindCloudflare);
    if (cloudflareError) return cloudflareError;
  }
  return null;
}

/**
 * The dashboard's 422 `cert_missing`, as a Hub refusal: the resolved paths
 * and the hint travel to the Hub as the command's data.
 */
function certMissingResult({ certPath, keyPath }) {
  const out = { ok: false, code: 'cert_missing', hint: CERT_MISSING_HINT, error: CERT_MISSING_HINT };
  if (getHubPermissions()['nginx.config.view'] === true) {
    out.certPath = certPath;
    out.keyPath = keyPath;
  }
  return out;
}

function certificateRetention(result) {
  if (result.ok) return { certDeleted: true, certificate: result.domain };
  return {
    certDeleted: false,
    certRetained: true,
    certReason: result.code ?? 'delete_failed',
    certMessage: result.code === 'cert_in_use'
      ? 'The domain was deleted, but its certificate is still used by another domain or nginx configuration and was retained.'
      : result.code === 'cert_not_managed'
        ? 'The domain was deleted, but Easy DevOps did not create that certificate, so it was retained.'
        : 'The domain was deleted, but its certificate could not be removed safely and was retained.',
    usedBy: Array.isArray(result.usedBy) ? result.usedBy : [],
    references: Array.isArray(result.references)
      ? result.references.map((reference) => ({
        file: String(reference.file ?? '').split(/[\\/]/).pop(),
        line: Number(reference.line) || null,
      }))
      : [],
  };
}

export async function handleHubDomainCommand(payload, { runFn = run, recheck = null } = {}) {
  const { action, name, domain, deleteCert } = payload ?? {};
  const { nginxDir } = loadConfig();
  const authorize = () => {
    if (typeof recheck === 'function') recheck();
  };

  switch (action) {

    case 'create': {
      if (!domain?.name) return { ok: false, error: 'domain.name is required' };
      // The same checks the dashboard runs. The name becomes a config file
      // name, so it must be a plain hostname before anything is written.
      const invalid = hubDomainInputError(domain, { creating: true });
      if (invalid) return { ok: false, error: invalid };
      return withCertificateLifecycleLock(async () => {
        if (findDomain(domain.name)) return { ok: false, error: `Domain ${domain.name} already exists` };

        const newDomain = createDomain({
          name: domain.name,
          port: Number(domain.port) || 3000,
          backendHost: domain.backendHost ?? DOMAIN_DEFAULTS.backendHost,
          upstreamType: domain.upstreamType ?? DOMAIN_DEFAULTS.upstreamType,
          www: domain.www ?? false,
          wildcard: domain.wildcard ?? false,
          behindCloudflare: domain.behindCloudflare ?? false,
          enabled: true,
          ssl: { ...DOMAIN_DEFAULTS.ssl, ...domain.ssl },
          performance: { ...DOMAIN_DEFAULTS.performance, ...domain.performance },
          security: { ...DOMAIN_DEFAULTS.security, ...domain.security },
          advanced: { ...DOMAIN_DEFAULTS.advanced, ...domain.advanced },
        });

        // Same refusal as the dashboard: never point nginx at certificate files
        // that are not on disk. The Hub offers Create certificate on this code.
        const missingNew = await missingCertFiles(newDomain);
        if (missingNew) return certMissingResult(missingNew);

        // Shared core apply (same path as the CLI and the dashboard API).
        authorize();
        const created = await writeConfWithTest(newDomain);
        if (!created.ok) {
          return { ok: false, error: created.error ?? 'nginx rejected the new config' };
        }

        const domains = getDomains();
        authorize();
        domains.push(newDomain);
        saveDomains(domains);

        if (domain.notifications && typeof domain.notifications === 'object') {
          try {
            authorize();
            saveDomainNotifConfig(domain.name, domain.notifications);
          } catch (error) {
            if (error?.code === 'HUB_PERMISSION_REVOKED') throw error;
          }
        }

        bumpHubRevision();
        console.log('[hubAgent] domain created:', domain.name);
        return { ok: true, action: 'create', domain: domain.name };
      });
    }

    case 'update': {
      const targetName = name ?? domain?.name;
      return withCertificateLifecycleLock(async () => {
        const existing = targetName ? findDomain(targetName) : null;
        if (!existing) return { ok: false, error: `Domain ${targetName} not found` };

        // Fields the agent owns are never taken from the Hub: the config path is
        // derived from the name, and enabling is hub:manageDomain toggle, which
        // has its own permission.
        const { configFile: _cf, enabled: _en, createdAt: _ca, ...updates } = domain ?? {};
        const invalid = hubDomainInputError(updates, { creating: false, existing });
        if (invalid) return { ok: false, error: invalid };
        const updatedDomain = {
          ...existing,
          ...updates,
          name: existing.name, // name is immutable
          ssl: { ...existing.ssl, ...updates.ssl },
          performance: { ...existing.performance, ...updates.performance },
          security: { ...existing.security, ...updates.security },
          advanced: { ...existing.advanced, ...updates.advanced },
          updatedAt: new Date().toISOString(),
        };

        // Same refusal as the dashboard: never point nginx at certificate files
        // that are not on disk. The Hub offers Create certificate on this code.
        const missingUpdated = await missingCertFiles(updatedDomain);
        if (missingUpdated) return certMissingResult(missingUpdated);

        // Shared core apply — restores the previous config exactly if it fails,
        // so the .bak dance is no longer needed here.
        authorize();
        const updatedResult = await writeConfWithTest(updatedDomain);
        if (!updatedResult.ok) {
          return { ok: false, error: updatedResult.error ?? 'nginx rejected the updated config' };
        }

        const domains = getDomains();
        const idx = domains.findIndex((d) => d.name === existing.name);
        authorize();
        domains[idx] = updatedDomain;
        saveDomains(domains);

        if (updates.notifications && typeof updates.notifications === 'object') {
          try {
            authorize();
            saveDomainNotifConfig(existing.name, updates.notifications);
          } catch (error) {
            if (error?.code === 'HUB_PERMISSION_REVOKED') throw error;
          }
        }

        bumpHubRevision();
        console.log('[hubAgent] domain updated:', existing.name);
        return { ok: true, action: 'update', domain: existing.name };
      });
    }

    case 'delete': {
      const result = await withCertificateLifecycleLock(async (lifecycle) => {
        const domain = findDomain(name);
        if (!domain) return { ok: false, error: `Domain ${name} not found` };

        if (domain.configFile) {
          authorize();
          try { await fs.unlink(domain.configFile); } catch (err) {
            if (err.code !== 'ENOENT') return { ok: false, error: `Could not remove config: ${err.message}` };
          }
        }

        // Remove the domain record before the shared deletion path scans for
        // users. Other domains and every nginx reference are still considered.
        authorize();
        saveDomains(getDomains().filter((d) => d.name !== name));

        let certificate = null;
        if (deleteCert && domain.ssl?.enabled) {
          authorize();
          certificate = certificateRetention(
            await deleteCertificateUnderLock(name, lifecycle),
          );
        }
        return {
          ok: true,
          action: 'delete',
          domain: name,
          certDeleted: certificate?.certDeleted ?? false,
          ...(certificate?.certRetained ? certificate : {}),
        };
      });
      if (!result.ok) return result;

      console.log('[hubAgent] domain deleted:', name);

      // Reload nginx so the deleted domain stops being served
      authorize();
      await runFn(isWindows ? nginxReloadCmd(nginxDir) : 'sudo -n /usr/bin/systemctl reload nginx', { cwd: nginxDir });
      bumpHubRevision();
      return result;
    }

    case 'toggle': {
      const domain = findDomain(name);
      if (!domain) return { ok: false, error: `Domain ${name} not found` };

      const isEnabled = domain.enabled !== false;
      const confPath = domain.configFile;
      if (!confPath) return { ok: false, error: `Domain ${name} has no config file` };

      const basePath = confPath.replace(/\.disabled$/, '');
      const enabledPath = basePath;
      const disabledPath = `${basePath}.disabled`;

      if (isEnabled) {
        authorize();
        try { await fs.rename(enabledPath, disabledPath); } catch (err) {
          return { ok: false, error: `Could not disable: ${err.message}` };
        }
        const domains = getDomains();
        const idx = domains.findIndex((d) => d.name === name);
        authorize();
        domains[idx] = { ...domain, enabled: false, configFile: disabledPath, updatedAt: new Date().toISOString() };
        saveDomains(domains);
      } else {
        authorize();
        try { await fs.rename(disabledPath, enabledPath); } catch (err) {
          return { ok: false, error: `Could not enable: ${err.message}` };
        }
        const testResult = await runFn(isWindows ? nginxTestCmd(nginxDir) : 'nginx -t', { cwd: nginxDir });
        if (!isNginxTestOk(testResult)) {
          await fs.rename(enabledPath, disabledPath).catch(() => {});
          return { ok: false, error: 'nginx rejected the config after enabling' };
        }
        const domains = getDomains();
        const idx = domains.findIndex((d) => d.name === name);
        authorize();
        domains[idx] = { ...domain, enabled: true, configFile: enabledPath, updatedAt: new Date().toISOString() };
        saveDomains(domains);
      }

      authorize();
      await runFn(isWindows ? nginxReloadCmd(nginxDir) : 'sudo -n /usr/bin/systemctl reload nginx', { cwd: nginxDir });
      bumpHubRevision();
      console.log('[hubAgent] domain toggled:', name, '→', !isEnabled);
      return { ok: true, action: 'toggle', domain: name, enabled: !isEnabled };
    }

    case 'reload': {
      const testResult = await runFn(isWindows ? nginxTestCmd(nginxDir) : 'nginx -t', { cwd: nginxDir });
      if (!isNginxTestOk(testResult)) return { ok: false, error: 'nginx config test failed' };
      authorize();
      await runFn(isWindows ? nginxReloadCmd(nginxDir) : 'sudo -n /usr/bin/systemctl reload nginx', { cwd: nginxDir });
      console.log('[hubAgent] nginx reloaded for domain:', name);
      return { ok: true, action: 'reload', domain: name };
    }

    default:
      return { ok: false, error: `Unknown domain action: ${action}` };
  }
}
