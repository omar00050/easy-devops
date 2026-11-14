import fs from 'fs/promises';
import path from 'node:path';
import { dbGet, dbSet } from './db.js';
import { DOMAIN_DEFAULTS, migrateDomain } from './nginx-conf-generator.js';
import { writeConfWithTest } from './nginx-apply.js';
import { run } from './shell.js';
import { loadConfig } from './config.js';
import { isWindows, nginxTestCmd, nginxReloadCmd, isNginxTestOk } from './platform.js';
import { saveDomainNotifConfig } from './domainNotifier.js';
import { bumpHubRevision } from './hubLink.js';

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

export async function handleHubDomainCommand(payload) {
  const { action, name, domain, deleteCert } = payload ?? {};
  const { nginxDir } = loadConfig();

  switch (action) {

    case 'create': {
      if (!domain?.name) return { ok: false, error: 'domain.name is required' };
      if (findDomain(domain.name)) return { ok: false, error: `Domain ${domain.name} already exists` };

      const newDomain = createDomain({
        name: domain.name,
        port: Number(domain.port) || 3000,
        backendHost: domain.backendHost ?? DOMAIN_DEFAULTS.backendHost,
        upstreamType: domain.upstreamType ?? DOMAIN_DEFAULTS.upstreamType,
        www: domain.www ?? false,
        wildcard: domain.wildcard ?? false,
        enabled: true,
        ssl: { ...DOMAIN_DEFAULTS.ssl, ...domain.ssl },
        performance: { ...DOMAIN_DEFAULTS.performance, ...domain.performance },
        security: { ...DOMAIN_DEFAULTS.security, ...domain.security },
        advanced: { ...DOMAIN_DEFAULTS.advanced, ...domain.advanced },
      });

      // Shared core apply (same path as the CLI and the dashboard API).
      const created = await writeConfWithTest(newDomain);
      if (!created.ok) {
        return { ok: false, error: created.error ?? 'nginx rejected the new config' };
      }

      const domains = getDomains();
      domains.push(newDomain);
      saveDomains(domains);

      if (domain.notifications && typeof domain.notifications === 'object') {
        try { saveDomainNotifConfig(domain.name, domain.notifications); } catch { /* non-fatal */ }
      }

      bumpHubRevision();
      console.log('[hubAgent] domain created:', domain.name);
      return { ok: true, action: 'create', domain: domain.name };
    }

    case 'update': {
      const targetName = name ?? domain?.name;
      const existing = targetName ? findDomain(targetName) : null;
      if (!existing) return { ok: false, error: `Domain ${targetName} not found` };

      const updates = domain ?? {};
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

      // Shared core apply — restores the previous config exactly if it fails,
      // so the .bak dance is no longer needed here.
      const updatedResult = await writeConfWithTest(updatedDomain);
      if (!updatedResult.ok) {
        return { ok: false, error: updatedResult.error ?? 'nginx rejected the updated config' };
      }

      const domains = getDomains();
      const idx = domains.findIndex((d) => d.name === existing.name);
      domains[idx] = updatedDomain;
      saveDomains(domains);

      if (updates.notifications && typeof updates.notifications === 'object') {
        try { saveDomainNotifConfig(existing.name, updates.notifications); } catch { /* non-fatal */ }
      }

      bumpHubRevision();
      console.log('[hubAgent] domain updated:', existing.name);
      return { ok: true, action: 'update', domain: existing.name };
    }

    case 'delete': {
      const domain = findDomain(name);
      if (!domain) return { ok: false, error: `Domain ${name} not found` };

      if (domain.configFile) {
        try { await fs.unlink(domain.configFile); } catch (err) {
          if (err.code !== 'ENOENT') return { ok: false, error: `Could not remove config: ${err.message}` };
        }
      }

      saveDomains(getDomains().filter((d) => d.name !== name));

      // Optionally delete SSL certificate directory
      if (deleteCert && domain.ssl?.enabled) {
        const { sslDir } = loadConfig();
        const certDir = path.join(sslDir, name);
        try { await fs.rm(certDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }

      console.log('[hubAgent] domain deleted:', name);

      // Reload nginx so the deleted domain stops being served
      await run(isWindows ? nginxReloadCmd(nginxDir) : 'sudo -n /usr/bin/systemctl reload nginx', { cwd: nginxDir });
      bumpHubRevision();
      return { ok: true, action: 'delete', domain: name };
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
        try { await fs.rename(enabledPath, disabledPath); } catch (err) {
          return { ok: false, error: `Could not disable: ${err.message}` };
        }
        const domains = getDomains();
        const idx = domains.findIndex((d) => d.name === name);
        domains[idx] = { ...domain, enabled: false, configFile: disabledPath, updatedAt: new Date().toISOString() };
        saveDomains(domains);
      } else {
        try { await fs.rename(disabledPath, enabledPath); } catch (err) {
          return { ok: false, error: `Could not enable: ${err.message}` };
        }
        const testResult = await run(isWindows ? nginxTestCmd(nginxDir) : 'nginx -t', { cwd: nginxDir });
        if (!isNginxTestOk(testResult)) {
          await fs.rename(enabledPath, disabledPath).catch(() => {});
          return { ok: false, error: 'nginx rejected the config after enabling' };
        }
        const domains = getDomains();
        const idx = domains.findIndex((d) => d.name === name);
        domains[idx] = { ...domain, enabled: true, configFile: enabledPath, updatedAt: new Date().toISOString() };
        saveDomains(domains);
      }

      await run(isWindows ? nginxReloadCmd(nginxDir) : 'sudo -n /usr/bin/systemctl reload nginx', { cwd: nginxDir });
      bumpHubRevision();
      console.log('[hubAgent] domain toggled:', name, '→', !isEnabled);
      return { ok: true, action: 'toggle', domain: name, enabled: !isEnabled };
    }

    case 'reload': {
      const testResult = await run(isWindows ? nginxTestCmd(nginxDir) : 'nginx -t', { cwd: nginxDir });
      if (!isNginxTestOk(testResult)) return { ok: false, error: 'nginx config test failed' };
      await run(isWindows ? nginxReloadCmd(nginxDir) : 'sudo -n /usr/bin/systemctl reload nginx', { cwd: nginxDir });
      console.log('[hubAgent] nginx reloaded for domain:', name);
      return { ok: true, action: 'reload', domain: name };
    }

    default:
      return { ok: false, error: `Unknown domain action: ${action}` };
  }
}
