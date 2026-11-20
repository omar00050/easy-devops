import fs from 'fs/promises';
import path from 'path';
import { run } from '../../core/shell.js';
import { loadConfig } from '../../core/config.js';
import { getDomains, saveDomains, findDomain, createDomain, DOMAIN_DEFAULTS } from '../../core/domains-db.js';
import { writeConfWithTest } from '../../core/nginx-apply.js';
import { missingCertFiles, CERT_MISSING_HINT } from '../../core/cert-usage.js';
import { getCertExpiry } from '../../core/cert-reader.js';
import { findCertificateForDomain } from '../../core/cert-suggest.js';
import { isWindows, nginxTestCmd, nginxReloadCmd, isNginxTestOk, hasBackslashPath } from '../../core/platform.js';
import {
  validateDomainName, validatePort, validateUpstreamType,
  validateMaxBodySize, validateBehindCloudflare,
} from '../../core/validators.js';
import { getDomainNotifConfig, saveDomainNotifConfig } from '../../core/domainNotifier.js';

/**
 * Maps a failed writeConfWithTest() result to an API error body, preserving
 * the Linux permissions hint that the old inline checks surfaced.
 * @param {{ error: string|null, output: string }} applied
 */
function applyErrorResponse(applied) {
  const output = applied.output || '';
  if (!isWindows && output.includes('password is required')) {
    return {
      error: 'Linux permissions not configured. Open Settings → Setup Linux Permissions.',
      output,
    };
  }
  return { error: 'nginx config test failed', details: applied.error, output };
}

function certMissingBody({ certPath, keyPath }) {
  return { error: 'cert_missing', certPath, keyPath, hint: CERT_MISSING_HINT };
}

class DomainsController {
  async list(req, res, next) {
    try {
      const domains = getDomains();
      const result = await Promise.all(
        domains.map(async (domain) => {
          const { expiry, daysLeft } = await getCertExpiry(domain.name);
          const notifications = getDomainNotifConfig(domain.name);
          // Report-only: existing configs are never rewritten automatically.
          // Saving the domain regenerates it through the shared apply, which
          // writes forward-slash paths and clears the warning.
          const sslPathWarning = Boolean(
            isWindows &&
              domain.ssl?.enabled &&
              (hasBackslashPath(domain.ssl.certPath) || hasBackslashPath(domain.ssl.keyPath))
          );
          return { ...domain, certExpiry: expiry, daysLeft, notifications, sslPathWarning };
        })
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const body = req.body ?? {};

      // Validate required fields
      const nameError = validateDomainName(body.name);
      if (nameError) {
        return res.status(400).json({ error: nameError });
      }

      // Port validation is skipped when backendHost is a full external URL
      const backendIsUrl = /^https?:\/\//i.test(body.backendHost ?? '');
      if (!backendIsUrl) {
        const portError = validatePort(body.port);
        if (portError) {
          return res.status(400).json({ error: portError });
        }
      }

      // Validate optional fields
      const upstreamError = validateUpstreamType(body.upstreamType);
      if (upstreamError) {
        return res.status(400).json({ error: upstreamError });
      }

      const maxSizeError = validateMaxBodySize(body.performance?.maxBodySize);
      if (maxSizeError) {
        return res.status(400).json({ error: maxSizeError });
      }

      const cloudflareError = validateBehindCloudflare(body.behindCloudflare);
      if (cloudflareError) {
        return res.status(400).json({ error: cloudflareError });
      }

      // Check for duplicate
      if (findDomain(body.name)) {
        return res.status(409).json({ error: `Domain already exists: ${body.name}` });
      }

      // Build domain object with defaults
      const domain = createDomain({
        name: body.name,
        port: Number(body.port),
        backendHost: body.backendHost ?? DOMAIN_DEFAULTS.backendHost,
        upstreamType: body.upstreamType ?? DOMAIN_DEFAULTS.upstreamType,
        www: body.www ?? false,
        ssl: {
          enabled: body.ssl?.enabled ?? false,
          certPath: body.ssl?.certPath ?? '',
          keyPath: body.ssl?.keyPath ?? '',
          redirect: body.ssl?.redirect ?? true,
          hsts: body.ssl?.hsts ?? false,
          hstsMaxAge: body.ssl?.hstsMaxAge ?? DOMAIN_DEFAULTS.ssl.hstsMaxAge,
        },
        performance: {
          maxBodySize: body.performance?.maxBodySize ?? DOMAIN_DEFAULTS.performance.maxBodySize,
          readTimeout: body.performance?.readTimeout ?? DOMAIN_DEFAULTS.performance.readTimeout,
          connectTimeout: body.performance?.connectTimeout ?? DOMAIN_DEFAULTS.performance.connectTimeout,
          proxyBuffers: body.performance?.proxyBuffers ?? false,
          gzip: body.performance?.gzip ?? true,
          gzipTypes: body.performance?.gzipTypes ?? DOMAIN_DEFAULTS.performance.gzipTypes,
        },
        security: {
          rateLimit: body.security?.rateLimit ?? false,
          rateLimitRate: body.security?.rateLimitRate ?? DOMAIN_DEFAULTS.security.rateLimitRate,
          rateLimitBurst: body.security?.rateLimitBurst ?? DOMAIN_DEFAULTS.security.rateLimitBurst,
          securityHeaders: body.security?.securityHeaders ?? false,
          custom404: body.security?.custom404 ?? false,
          custom50x: body.security?.custom50x ?? false,
        },
        advanced: {
          accessLog: body.advanced?.accessLog ?? true,
          customLocations: body.advanced?.customLocations ?? '',
        },
        wildcard: body.wildcard ?? false,
        behindCloudflare: body.behindCloudflare ?? false,
        enabled: true,
      });

      // Cert existence check (FR-001): prevent saving a config that references non-existent cert files
      const missingCert = await missingCertFiles(domain);
      if (missingCert) {
        return res.status(422).json(certMissingBody(missingCert));
      }

      // Shared core apply: writes, tests via isNginxTestOk(), and on Windows
      // retries once with escaped backslash cert paths before rolling back.
      const applied = await writeConfWithTest(domain);
      if (!applied.ok) {
        return res.status(500).json(applyErrorResponse(applied));
      }

      const domains = getDomains();
      domains.push(domain);
      saveDomains(domains);

      // Save per-domain notification config if provided
      if (body.notifications && typeof body.notifications === 'object') {
        try {
          saveDomainNotifConfig(domain.name, body.notifications);
        } catch { /* ignore validation errors — fall back to defaults */ }
      }

      res.status(201).json({ ...domain, notifications: getDomainNotifConfig(domain.name) });
    } catch (error) {
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const { name } = req.params;
      const existing = findDomain(name);
      if (!existing) {
        return res.status(404).json({ error: `Domain not found: ${name}` });
      }

      const body = req.body ?? {};

      // Validate port if provided (skip when backendHost is a full external URL)
      const backendIsUrl = /^https?:\/\//i.test(body.backendHost ?? existing.backendHost ?? '');
      if (body.port !== undefined && !backendIsUrl) {
        const portError = validatePort(body.port);
        if (portError) {
          return res.status(400).json({ error: portError });
        }
        body.port = Number(body.port);
      }

      // Validate upstreamType if provided
      if (body.upstreamType !== undefined) {
        const upstreamError = validateUpstreamType(body.upstreamType);
        if (upstreamError) {
          return res.status(400).json({ error: upstreamError });
        }
      }

      // Validate behindCloudflare if provided
      if (body.behindCloudflare !== undefined) {
        const cloudflareError = validateBehindCloudflare(body.behindCloudflare);
        if (cloudflareError) {
          return res.status(400).json({ error: cloudflareError });
        }
      }

      // name is immutable — merge everything except name, configFile, and notifications
      const { name: _ignored, configFile: _cf, notifications, ...updates } = body;

      // Deep merge nested objects
      const updatedDomain = {
        ...existing,
        ...updates,
        ssl: { ...existing.ssl, ...updates.ssl },
        performance: { ...existing.performance, ...updates.performance },
        security: { ...existing.security, ...updates.security },
        advanced: { ...existing.advanced, ...updates.advanced },
        wildcard: updates.wildcard ?? existing.wildcard ?? false,
        updatedAt: new Date().toISOString(),
      };

      // An update must not point nginx at certificate files that are not on disk.
      const missingCert = await missingCertFiles(updatedDomain);
      if (missingCert) {
        return res.status(422).json(certMissingBody(missingCert));
      }

      // Shared core apply — snapshots the current file and restores it exactly
      // if every attempt fails, so no .bak juggling is needed here.
      const applied = await writeConfWithTest(updatedDomain);
      if (!applied.ok) {
        return res.status(500).json(applyErrorResponse(applied));
      }

      const domains = getDomains();
      const idx = domains.findIndex((d) => d.name === name);
      domains[idx] = updatedDomain;
      saveDomains(domains);

      // Save per-domain notification config if provided
      if (notifications && typeof notifications === 'object') {
        try {
          saveDomainNotifConfig(name, notifications);
        } catch { /* ignore validation errors — keep existing config */ }
      }

      res.json({ ...updatedDomain, notifications: getDomainNotifConfig(name) });
    } catch (error) {
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      const { name } = req.params;
      const deleteCert = req.query.deleteCert === 'true';
      const domain = findDomain(name);
      if (!domain) {
        return res.status(404).json({ error: `Domain not found: ${name}` });
      }

      // Delete nginx conf file
      if (domain.configFile) {
        try {
          await fs.unlink(domain.configFile);
        } catch (err) {
          if (err.code !== 'ENOENT') {
            return res.status(500).json({ error: 'Failed to delete conf file', details: err.message });
          }
        }
      }

      // Optionally delete the SSL certificate directory for this domain
      if (deleteCert && domain.ssl?.enabled) {
        const { sslDir } = loadConfig();
        const certDir = path.join(sslDir, name);
        try {
          await fs.rm(certDir, { recursive: true, force: true });
        } catch { /* ignore — cert dir may not exist */ }
      }

      const domains = getDomains().filter((d) => d.name !== name);
      saveDomains(domains);

      res.json({ deleted: name, certDeleted: deleteCert && domain.ssl?.enabled });
    } catch (error) {
      next(error);
    }
  }

  async toggle(req, res, next) {
    try {
      const { name } = req.params;
      const domain = findDomain(name);
      if (!domain) {
        return res.status(404).json({ error: `Domain not found: ${name}` });
      }

      const { nginxDir } = loadConfig();
      const isEnabled = domain.enabled !== false;
      const confPath = domain.configFile;

      if (!confPath) {
        return res.status(400).json({ error: 'Domain has no config file path stored' });
      }

      // Normalise paths regardless of current stored extension
      const basePath = confPath.replace(/\.disabled$/, '');
      const enabledPath = basePath;
      const disabledPath = `${basePath}.disabled`;

      if (isEnabled) {
        // Disable: rename .conf → .conf.disabled, then reload nginx
        try {
          await fs.rename(enabledPath, disabledPath);
        } catch (err) {
          return res.status(500).json({ error: 'Failed to rename config file', details: err.message });
        }

        const domains = getDomains();
        const idx = domains.findIndex(d => d.name === name);
        domains[idx] = { ...domain, enabled: false, configFile: disabledPath, updatedAt: new Date().toISOString() };
        saveDomains(domains);

        // Reload so nginx stops serving this domain
        await run(isWindows ? nginxReloadCmd(nginxDir) : 'sudo -n /usr/bin/systemctl reload nginx', { cwd: nginxDir });

        return res.json({ enabled: false });
      } else {
        // Enable: rename .conf.disabled → .conf, test, reload
        try {
          await fs.rename(disabledPath, enabledPath);
        } catch (err) {
          return res.status(500).json({ error: 'Failed to rename config file', details: err.message });
        }

        const testCmd = isWindows ? nginxTestCmd(nginxDir) : 'nginx -t';
        const testResult = await run(testCmd, { cwd: nginxDir });
        if (!isNginxTestOk(testResult)) {
          // Roll back rename
          await fs.rename(enabledPath, disabledPath).catch(() => {});
          const output = testResult.stderr || testResult.stdout;
          const error = !isWindows && output.includes('password is required')
            ? 'Linux permissions not configured. Open Settings → Setup Linux Permissions.'
            : 'nginx config test failed';
          return res.status(500).json({ error, output });
        }

        const domains = getDomains();
        const idx = domains.findIndex(d => d.name === name);
        domains[idx] = { ...domain, enabled: true, configFile: enabledPath, updatedAt: new Date().toISOString() };
        saveDomains(domains);

        await run(isWindows ? nginxReloadCmd(nginxDir) : 'sudo -n /usr/bin/systemctl reload nginx', { cwd: nginxDir });

        return res.json({ enabled: true });
      }
    } catch (error) {
      next(error);
    }
  }

  async reload(req, res, next) {
    try {
      const { name } = req.params;
      if (!findDomain(name)) {
        return res.status(404).json({ error: `Domain not found: ${name}` });
      }

      const { nginxDir } = loadConfig();

      const testCmd = isWindows ? nginxTestCmd(nginxDir) : 'nginx -t';
      const testResult = await run(testCmd, { cwd: nginxDir });
      if (!isNginxTestOk(testResult)) {
        const output = testResult.stderr || testResult.stdout;
        const error = !isWindows && output.includes('password is required')
          ? 'Linux permissions not configured. Open Settings → Setup Linux Permissions.'
          : 'nginx config test failed';
        return res.status(500).json({ error, output });
      }

      const reloadCmd = isWindows ? nginxReloadCmd(nginxDir) : 'sudo -n /usr/bin/systemctl reload nginx';
      const reloadResult = await run(reloadCmd, { cwd: nginxDir });
      if (!reloadResult.success) {
        const output = reloadResult.stderr || reloadResult.stdout;
        const error = !isWindows && output.includes('password is required')
          ? 'Linux permissions not configured. Open Settings → Setup Linux Permissions.'
          : 'nginx reload failed';
        return res.status(500).json({ error, output });
      }

      res.json({ message: 'nginx reloaded successfully' });
    } catch (error) {
      next(error);
    }
  }

  async getNotifications(req, res, next) {
    try {
      const config = getDomainNotifConfig(req.params.name);
      res.json(config);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Reports an existing certificate that could serve this domain, so the edit
   * modal can offer to fill the cert/key paths in. Read-only: nothing is
   * changed until the operator accepts and saves.
   */
  async sslSuggestion(req, res, next) {
    try {
      const { name } = req.params;
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'A domain name is required' });
      }
      // The deployments link dialog asks about a domain before it exists, so
      // an unknown name is not an error: the answer is simply "not found".
      res.json(await findCertificateForDomain(name));
    } catch (error) {
      next(error);
    }
  }

  async updateNotifications(req, res, next) {
    try {
      saveDomainNotifConfig(req.params.name, req.body ?? {});
      res.json(getDomainNotifConfig(req.params.name));
    } catch (error) {
      if (error.message?.startsWith('Invalid') || error.message?.startsWith('Config') || error.message?.startsWith('Entry')) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  }
}

export default DomainsController;
