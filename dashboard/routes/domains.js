import express from 'express';
import fs from 'fs/promises';
import { run } from '../../core/shell.js';
import { loadConfig } from '../../core/config.js';
import { getDomains, saveDomains, findDomain, createDomain, DOMAIN_DEFAULTS } from '../lib/domains-db.js';
import { generateConf, getDefaultCertPaths } from '../lib/nginx-conf-generator.js';
import { getCertExpiry } from '../lib/cert-reader.js';

const router = express.Router();

// ─── shared nginx helpers ─────────────────────────────────────────────────────

const isWindows = process.platform === 'win32';

function getNginxExe(nginxDir) {
  return isWindows ? `${nginxDir}\\nginx.exe` : 'nginx';
}

function nginxTestCmd(nginxDir) {
  const exe = getNginxExe(nginxDir);
  // Use explicit -c flag on Windows to avoid path issues
  if (isWindows) {
    const confPath = `${nginxDir}\\conf\\nginx.conf`;
    return `& "${exe}" -c "${confPath}" -t`;
  }
  return 'nginx -t';
}

function nginxReloadCmd(nginxDir) {
  const exe = getNginxExe(nginxDir);
  return isWindows ? `& "${exe}" -s reload` : 'nginx -s reload';
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateDomainName(name) {
  if (!name || typeof name !== 'string') {
    return 'name is required';
  }
  // Allow wildcards and standard hostnames
  const validPattern = /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
  if (!validPattern.test(name) || name.includes('/') || name.includes(' ')) {
    return 'Invalid domain name format';
  }
  return null;
}

function validatePort(port) {
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return 'Invalid port: must be 1-65535';
  }
  return null;
}

function validateUpstreamType(type) {
  if (type && !['http', 'https', 'ws'].includes(type)) {
    return 'Invalid upstreamType: must be http, https, or ws';
  }
  return null;
}

function validateMaxBodySize(size) {
  if (size && !/^\d+[kmgKMG]?$/.test(size)) {
    return 'Invalid maxBodySize format (e.g., 10m, 1g)';
  }
  return null;
}

function validatePositiveInteger(val, field) {
  if (val !== undefined && (!Number.isInteger(Number(val)) || Number(val) < 1)) {
    return `Invalid ${field}: must be a positive integer`;
  }
  return null;
}

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

  const portError = validatePort(body.port);
  if (portError) {
    return res.status(400).json({ error: portError });
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

  // Validate port if provided
  if (body.port !== undefined) {
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
  const domain = findDomain(name);
  if (!domain) {
    return res.status(404).json({ error: `Domain not found: ${name}` });
  }

  if (domain.configFile) {
    try {
      await fs.unlink(domain.configFile);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return res.status(500).json({ error: 'Failed to delete conf file', details: err.message });
      }
    }
  }

  const domains = getDomains().filter((d) => d.name !== name);
  saveDomains(domains);

  res.json({ message: `Domain deleted: ${name}` });
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
