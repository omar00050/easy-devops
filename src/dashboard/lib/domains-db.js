import fs from 'fs/promises';
import path from 'node:path';
import { dbGet, dbSet } from '../../core/db.js';
import { DOMAIN_DEFAULTS, migrateDomain, generateConf } from '../../core/nginx-conf-generator.js';
import { run } from '../../core/shell.js';
import { loadConfig } from '../../core/config.js';
import { isWindows, nginxTestCmd, nginxReloadCmd, isNginxTestOk } from '../../core/platform.js';
import { saveDomainNotifConfig } from '../../core/domainNotifier.js';

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
      if (!domain?.name) { console.warn('[hubAgent] create: missing domain.name'); return; }
      if (findDomain(domain.name)) { console.warn('[hubAgent] create: domain already exists:', domain.name); return; }

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

      try { await generateConf(newDomain); } catch (err) {
        console.error('[hubAgent] create: generateConf failed:', err.message); return;
      }

      const testResult = await run(isWindows ? nginxTestCmd(nginxDir) : 'nginx -t', { cwd: nginxDir });
      if (!isNginxTestOk(testResult)) {
        try { await fs.unlink(newDomain.configFile); } catch { /* ignore */ }
        console.error('[hubAgent] create: nginx test failed'); return;
      }

      const domains = getDomains();
      domains.push(newDomain);
      saveDomains(domains);

      if (domain.notifications && typeof domain.notifications === 'object') {
        try { saveDomainNotifConfig(domain.name, domain.notifications); } catch { /* non-fatal */ }
      }

      console.log('[hubAgent] domain created:', domain.name);
      break;
    }

    case 'update': {
      const targetName = name ?? domain?.name;
      const existing = targetName ? findDomain(targetName) : null;
      if (!existing) { console.warn('[hubAgent] update: domain not found:', targetName); return; }

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

      const bakPath = existing.configFile ? `${existing.configFile}.bak` : null;
      if (bakPath) { try { await fs.copyFile(existing.configFile, bakPath); } catch { /* skip */ } }

      try { await generateConf(updatedDomain); } catch (err) {
        console.error('[hubAgent] update: generateConf failed:', err.message); return;
      }

      const testResult = await run(isWindows ? nginxTestCmd(nginxDir) : 'nginx -t', { cwd: nginxDir });
      if (!isNginxTestOk(testResult)) {
        if (bakPath) { try { await fs.rename(bakPath, existing.configFile); } catch { /* ignore */ } }
        console.error('[hubAgent] update: nginx test failed'); return;
      }

      const domains = getDomains();
      const idx = domains.findIndex((d) => d.name === existing.name);
      domains[idx] = updatedDomain;
      saveDomains(domains);
      if (bakPath) { try { await fs.unlink(bakPath); } catch { /* ignore */ } }

      if (updates.notifications && typeof updates.notifications === 'object') {
        try { saveDomainNotifConfig(existing.name, updates.notifications); } catch { /* non-fatal */ }
      }

      console.log('[hubAgent] domain updated:', existing.name);
      break;
    }

    case 'delete': {
      const domain = findDomain(name);
      if (!domain) { console.warn('[hubAgent] delete: domain not found:', name); return; }

      if (domain.configFile) {
        try { await fs.unlink(domain.configFile); } catch (err) {
          if (err.code !== 'ENOENT') { console.error('[hubAgent] delete: unlink failed:', err.message); return; }
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
      break;
    }

    case 'toggle': {
      const domain = findDomain(name);
      if (!domain) { console.warn('[hubAgent] toggle: domain not found:', name); return; }

      const isEnabled = domain.enabled !== false;
      const confPath = domain.configFile;
      if (!confPath) { console.warn('[hubAgent] toggle: no configFile for domain:', name); return; }

      const basePath = confPath.replace(/\.disabled$/, '');
      const enabledPath = basePath;
      const disabledPath = `${basePath}.disabled`;

      if (isEnabled) {
        try { await fs.rename(enabledPath, disabledPath); } catch (err) {
          console.error('[hubAgent] toggle disable: rename failed:', err.message); return;
        }
        const domains = getDomains();
        const idx = domains.findIndex((d) => d.name === name);
        domains[idx] = { ...domain, enabled: false, configFile: disabledPath, updatedAt: new Date().toISOString() };
        saveDomains(domains);
      } else {
        try { await fs.rename(disabledPath, enabledPath); } catch (err) {
          console.error('[hubAgent] toggle enable: rename failed:', err.message); return;
        }
        const testResult = await run(isWindows ? nginxTestCmd(nginxDir) : 'nginx -t', { cwd: nginxDir });
        if (!isNginxTestOk(testResult)) {
          await fs.rename(enabledPath, disabledPath).catch(() => {});
          console.error('[hubAgent] toggle enable: nginx test failed'); return;
        }
        const domains = getDomains();
        const idx = domains.findIndex((d) => d.name === name);
        domains[idx] = { ...domain, enabled: true, configFile: enabledPath, updatedAt: new Date().toISOString() };
        saveDomains(domains);
      }

      await run(isWindows ? nginxReloadCmd(nginxDir) : 'sudo -n /usr/bin/systemctl reload nginx', { cwd: nginxDir });
      console.log('[hubAgent] domain toggled:', name, '→', !isEnabled);
      break;
    }

    case 'reload': {
      const testResult = await run(isWindows ? nginxTestCmd(nginxDir) : 'nginx -t', { cwd: nginxDir });
      if (!isNginxTestOk(testResult)) { console.error('[hubAgent] reload: nginx test failed'); return; }
      await run(isWindows ? nginxReloadCmd(nginxDir) : 'sudo -n /usr/bin/systemctl reload nginx', { cwd: nginxDir });
      console.log('[hubAgent] nginx reloaded for domain:', name);
      break;
    }

    default:
      console.warn('[hubAgent] handleHubDomainCommand: unknown action:', action);
  }
}
