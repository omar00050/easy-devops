import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { run } from '../../core/shell.js';
import { loadConfig } from '../../core/config.js';
import { getDomains, saveDomains, findDomain, createDomain, DOMAIN_DEFAULTS } from '../lib/domains-db.js';
import { generateConf, getDefaultCertPaths } from '../lib/nginx-conf-generator.js';
import { getCertExpiry } from '../lib/cert-reader.js';
import { nginxTestCmd, nginxReloadCmd } from '../../core/platform.js';
import {
  validateDomainName, validatePort, validateUpstreamType,
  validateMaxBodySize, validatePositiveInteger,
} from '../../core/validators.js';

const router = express.Router();

// ─── GET /api/domains ─────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  const domains = getDomains();
  const result = await Promise.all(
    domains.map(async (domain) => {
      const { expiry, daysLeft } = await getCertExpiry(domain.name);
      return { ...domain, certExpiry: expiry, daysLeft };
    })
  );
  res.json(result);
});

// ─── POST /api/domains ────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
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
    enabled: true,
  });

  // Cert existence check (FR-001): prevent saving a config that references non-existent cert files
  if (domain.ssl.enabled && domain.ssl.certPath) {
    try {
      await fs.access(domain.ssl.certPath, fs.constants.F_OK);
    } catch {
      return res.status(422).json({
        error: 'cert_missing',
        certPath: domain.ssl.certPath,
        keyPath: domain.ssl.keyPath,
        hint: 'The SSL certificate files do not exist at the configured paths. Create the certificate first, or disable SSL.',
      });
    }
  }

  const { nginxDir } = loadConfig();

  try {
    await generateConf(domain);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to write nginx conf', details: err.message });
  }

  const testResult = await run(nginxTestCmd(nginxDir), { cwd: nginxDir });
  if (!testResult.success) {
    try { await fs.unlink(domain.configFile); } catch { /* ignore */ }
    return res.status(500).json({ error: 'nginx config test failed', output: testResult.stderr || testResult.stdout });
  }

  const domains = getDomains();
  domains.push(domain);
  saveDomains(domains);

  res.status(201).json(domain);
});

// ─── PUT /api/domains/:name ───────────────────────────────────────────────────

router.put('/:name', async (req, res) => {
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

  // name is immutable — merge everything except name and configFile
  const { name: _ignored, configFile: _cf, ...updates } = body;

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

  const { nginxDir } = loadConfig();
  const bakPath = existing.configFile ? `${existing.configFile}.bak` : null;

  // Backup existing conf
  if (bakPath && existing.configFile) {
    try {
      await fs.copyFile(existing.configFile, bakPath);
    } catch { /* file absent — skip backup */ }
  }

  try {
    await generateConf(updatedDomain);
  } catch (err) {
    if (bakPath) {
      try { await fs.copyFile(bakPath, existing.configFile); } catch { /* ignore restore failure */ }
    }
    return res.status(500).json({ error: 'Failed to write nginx conf', details: err.message });
  }

  const testResult = await run(nginxTestCmd(nginxDir), { cwd: nginxDir });
  if (!testResult.success) {
    if (bakPath) {
      try { await fs.rename(bakPath, existing.configFile); } catch { /* ignore */ }
    }
    return res.status(500).json({ error: 'nginx config test failed', output: testResult.stderr || testResult.stdout });
  }

  const domains = getDomains();
  const idx = domains.findIndex((d) => d.name === name);
  domains[idx] = updatedDomain;
  saveDomains(domains);

  res.json(updatedDomain);
});

// ─── DELETE /api/domains/:name ────────────────────────────────────────────────

router.delete('/:name', async (req, res) => {
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
});

// ─── PUT /api/domains/:name/toggle ───────────────────────────────────────────

router.put('/:name/toggle', async (req, res) => {
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
    await run(nginxReloadCmd(nginxDir), { cwd: nginxDir });

    return res.json({ enabled: false });
  } else {
    // Enable: rename .conf.disabled → .conf, test, reload
    try {
      await fs.rename(disabledPath, enabledPath);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to rename config file', details: err.message });
    }

    const testResult = await run(nginxTestCmd(nginxDir), { cwd: nginxDir });
    if (!testResult.success) {
      // Roll back rename
      await fs.rename(enabledPath, disabledPath).catch(() => {});
      return res.status(500).json({ error: 'nginx config test failed', output: testResult.stderr || testResult.stdout });
    }

    const domains = getDomains();
    const idx = domains.findIndex(d => d.name === name);
    domains[idx] = { ...domain, enabled: true, configFile: enabledPath, updatedAt: new Date().toISOString() };
    saveDomains(domains);

    await run(nginxReloadCmd(nginxDir), { cwd: nginxDir });

    return res.json({ enabled: true });
  }
});

// ─── POST /api/domains/:name/reload ──────────────────────────────────────────

router.post('/:name/reload', async (req, res) => {
  const { name } = req.params;
  if (!findDomain(name)) {
    return res.status(404).json({ error: `Domain not found: ${name}` });
  }

  const { nginxDir } = loadConfig();

  const testResult = await run(nginxTestCmd(nginxDir), { cwd: nginxDir });
  if (!testResult.success) {
    return res.status(500).json({ error: 'nginx config test failed', output: testResult.stderr || testResult.stdout });
  }

  const reloadResult = await run(nginxReloadCmd(nginxDir), { cwd: nginxDir });
  if (!reloadResult.success) {
    return res.status(500).json({ error: 'nginx reload failed', output: reloadResult.stderr || reloadResult.stdout });
  }

  res.json({ message: 'nginx reloaded successfully' });
});

export default router;
