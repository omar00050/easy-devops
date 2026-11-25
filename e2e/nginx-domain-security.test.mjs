import './lib/guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';

const { buildConf, generateConf, getConfDDir } = await import('../src/core/nginx-conf-generator.js');
const { loadConfig, saveConfig } = await import('../src/core/config.js');
const { findDomain, handleHubDomainCommand } = await import('../src/core/domains-db.js');
const { saveHubPermissions } = await import('../src/core/hubLink.js');
const { writeConfWithTest } = await import('../src/core/nginx-apply.js');
const { default: DomainsController } = await import('../src/dashboard/controllers/domainsController.js');
const {
  isWindows,
  powerShellLiteral,
  powerShellCall,
  getNginxExe,
  nginxTestCmd,
  nginxReloadCmd,
  nginxServiceStartCmd,
} = await import('../src/core/platform.js');

const nginxDir = path.join(process.env.EASY_DEVOPS_DATA_DIR, 'nginx');
const sslDir = path.join(process.env.EASY_DEVOPS_DATA_DIR, 'certs');
saveConfig({ ...loadConfig(), nginxDir, sslDir });
saveHubPermissions({ 'domains.create': true, 'domains.edit': true, 'nginx.config.edit': false });
const basic = { name: 'site.example', port: 3000 };
const raw = '# operator configuration\n';
const command = (action, fields) => handleHubDomainCommand({ action, name: basic.name, domain: fields });
const confPath = path.join(getConfDDir(nginxDir), basic.name + '.conf');

// No subprocess can reach a real nginx. Accept only a syntax check in this suite's prefix.
const spawn = mock.method(childProcess, 'spawn', (_file, args, options) => {
  assert.equal(options.cwd, nginxDir);
  assert.match(args.at(-1), / -t$/);
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  queueMicrotask(() => child.emit('close', 0));
  return child;
});
syncBuiltinESMExports();

try {
  assert.equal(powerShellLiteral("C:\\nginx\\$()"), "'C:\\nginx\\$()'");
  assert.equal(powerShellLiteral("C:\\nginx\\`Write-Host injected`"), "'C:\\nginx\\`Write-Host injected`'");
  assert.equal(powerShellLiteral("C:\\nginx\\o'brien"), "'C:\\nginx\\o''brien'");
  assert.throws(() => powerShellLiteral('C:\\nginx\\bad\nWrite-Host injected'), /control characters/);
  assert.equal(
    powerShellCall("C:\\nginx\\$()\\`whoami`", ['-v']),
    "& 'C:\\nginx\\$()\\`whoami`' '-v'",
  );

  // Windows command sites that take nginx settings must have no double-quoted
  // interpolation left to PowerShell.
  for (const [label, file] of [
    ['detector', '../src/core/detector.js'],
    ['core nginx service', '../src/core/nginx-service.js'],
    ['CLI nginx manager', '../src/cli/managers/nginx-manager.js'],
  ]) {
    const source = await fs.readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /&\s*"\$\{(?:nginxExe|configuredExe|nginxDir)\}/, label);
    assert.doesNotMatch(source, /Get-Content[^\n]*"\$\{(?:logPath|nginxDir)\}/, label);
    assert.doesNotMatch(source, /tail -n[^\n]*\$\{(?:logPath|nginxDir)\}/, label);
  }
  if (isWindows) {
    const hostileDir = "C:\\nginx\\$()\\`whoami`";
    for (const value of [
      getNginxExe(hostileDir),
      nginxTestCmd(hostileDir),
      nginxReloadCmd(hostileDir),
      nginxServiceStartCmd(hostileDir),
    ]) {
      assert.ok(value.includes("'C:\\nginx\\$()\\`whoami`"), value);
      assert.ok(!value.includes('"C:\\nginx\\$()'), value);
    }
  }

  const denied = await command('create', { ...basic, advanced: { customLocations: raw } });
  assert.match(denied.error, /nginx\.config\.edit/);
  assert.equal(findDomain(basic.name), undefined);
  await assert.rejects(fs.stat(nginxDir), { code: 'ENOENT' });

  for (const field of [
    'name', 'backendHost', 'port', 'upstreamType', 'www', 'wildcard', 'behindCloudflare',
    'performance.gzipTypes', 'performance.maxBodySize', 'performance.readTimeout', 'performance.connectTimeout',
    'performance.gzip', 'performance.proxyBuffers', 'ssl.certPath', 'ssl.keyPath', 'ssl.hstsMaxAge',
    'ssl.enabled', 'ssl.redirect', 'ssl.hsts', 'security.rateLimitRate', 'security.rateLimitBurst',
    'security.rateLimit', 'security.custom404', 'security.custom50x', 'security.securityHeaders', 'advanced.accessLog',
  ]) {
    for (const delimiter of ['\n', '\r', ';', '{', '}']) {
      const [group, key] = field.split('.');
      const value = '1' + delimiter;
      const domain = { ...basic, [group]: key ? { [key]: value } : value };
      await assert.rejects(generateConf(domain), { name: 'Error' }, field);
      const refused = await command('create', domain);
      assert.equal(refused.ok, false, field);
    }
  }
  for (const bad of ['nginx;', 'nginx\n']) {
    assert.throws(() => buildConf(basic, bad, sslDir), /nginxDir/);
    assert.throws(() => buildConf(basic, nginxDir, bad), /sslDir/);
    assert.throws(() => buildConf(basic, nginxDir, sslDir, { acmeChallengePort: bad }), /acmeChallengePort/);
    assert.throws(() => buildConf(basic, nginxDir, sslDir, { deployHookPort: bad }), /deployHookPort/);
  }
  const credentialUrl = 'https://operator:secret@backend.example';
  await assert.rejects(generateConf({
    name: 'credential-url.example',
    port: 3000,
    backendHost: credentialUrl,
  }), /backendHost/i);
  const credentialRefused = await command('create', {
    ...basic,
    name: 'credential-url.example',
    backendHost: credentialUrl,
  });
  assert.equal(credentialRefused.ok, false);
  assert.match(credentialRefused.error, /backendHost/i);
  assert.equal(findDomain('credential-url.example'), undefined);
  await assert.rejects(fs.stat(nginxDir), { code: 'ENOENT' });
  assert.equal(spawn.mock.callCount(), 0);
  const controller = new DomainsController();
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await controller.create({ body: { ...basic, port: '3000\n' } }, res, error => { throw error; });
  assert.equal(res.code, 400);
  assert.match(res.body.error, /port/);

  assert.equal((await command('create', basic)).ok, true);
  const edit = customLocations => command('update', { advanced: { customLocations } });
  assert.match((await edit(raw)).error, /nginx\.config\.edit/);
  saveHubPermissions({ 'nginx.config.edit': true });
  assert.equal((await edit(raw)).ok, true);
  saveHubPermissions({ 'nginx.config.edit': false });
  assert.equal((await command('update', { port: 3100 })).ok, true);
  assert.equal((await edit(raw)).ok, true);
  const saved = await fs.readFile(confPath, 'utf8');
  assert.ok(saved.includes(raw) && saved.includes(':3100;'));
  const checks = spawn.mock.callCount();
  for (const replacement of ['', null, '# changed']) {
    assert.match((await edit(replacement)).error, /nginx\.config\.edit/);
  }
  await fs.utimes(confPath, 1000, 1000);
  assert.equal((await writeConfWithTest({ ...basic, performance: { readTimeout: '60;' } })).ok, false);
  assert.equal((await fs.stat(confPath)).mtimeMs, 1000000);
  assert.equal(await fs.readFile(confPath, 'utf8'), saved);
  assert.equal(findDomain(basic.name).advanced.customLocations, raw);
  assert.equal(spawn.mock.callCount(), checks);
  console.log('PASS typed domain fields, pre-write rejection, dashboard 400 and Hub raw-edit permissions');
} finally {
  mock.restoreAll();
  syncBuiltinESMExports();
}
