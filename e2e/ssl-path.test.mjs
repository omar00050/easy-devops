/**
 * Tests for Windows SSL certificate path handling in generated nginx configs.
 *
 * Run with:  npm run test:e2e -- ssl-path
 *
 * Plain Node script on purpose: the easy-devops constitution forbids adding a
 * test framework to this project, so this uses no dependencies and no runner.
 *
 * Reads and writes nothing: every assertion is against pure functions
 * (buildConf, getDefaultCertPaths, and the platform path helpers). The config
 * and database are never touched.
 *
 * Both platform branches are exercised regardless of the host OS. `isWindows`
 * is a module-level constant in core/platform.js, and ESM gives no way to force
 * a transitive import to re-evaluate, so each platform's assertions run in a
 * CHILD PROCESS that overrides process.platform before the first import.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
import './lib/guard.mjs';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SELF = fileURLToPath(import.meta.url);

const MARKER = '@@RESULTS@@';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function sslLines(conf) {
  return conf.split('\n').filter((l) => /ssl_certificate(_key)?\s/.test(l));
}

function commentLines(conf) {
  return conf.split('\n').filter((l) => l.trim().startsWith('#'));
}

function makeDomain(gen, overrides = {}) {
  return {
    ...gen.DOMAIN_DEFAULTS,
    name: 'test.example.com',
    port: 3000,
    ...overrides,
    ssl: { ...gen.DOMAIN_DEFAULTS.ssl, enabled: true, ...(overrides.ssl ?? {}) },
  };
}

const WIN_NGINX = String.raw`C:\nginx`;
const WIN_SSL = String.raw`C:\nginx\test\certs`;

// ─── Child: run one platform's assertions ─────────────────────────────────────

async function runChild(platform) {
  // Must happen before the first import of core/platform.js.
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  const gen = await import(pathToFileURL(path.join(ROOT, 'src/core/nginx-conf-generator.js')).href);
  const plat = await import(pathToFileURL(path.join(ROOT, 'src/core/platform.js')).href);
  const apply = await import(pathToFileURL(path.join(ROOT, 'src/core/nginx-apply.js')).href);

  const out = [];
  let group = '';
  const setGroup = (g) => { group = g; };
  const check = (label, passed, detail = '') => out.push({ group, label, passed, detail });

  // Guard: confirm the override actually took effect, otherwise every result
  // below would be silently measuring the host platform instead.
  check('harness', plat.isWindows === (platform === 'win32'),
    `isWindows=${plat.isWindows} for platform=${platform}`);

  if (platform === 'win32') {
    setGroup('Windows: path helpers');

    check('toNginxPath converts backslashes',
      plat.toNginxPath(String.raw`C:\nginx\test\certs\a.pem`) === 'C:/nginx/test/certs/a.pem',
      plat.toNginxPath(String.raw`C:\nginx\test\certs\a.pem`));
    check('toNginxPath collapses duplicate separators',
      plat.toNginxPath(String.raw`C:\\nginx\\certs`) === 'C:/nginx/certs');
    check('toNginxPath leaves forward slashes alone',
      plat.toNginxPath('C:/nginx/certs/a.pem') === 'C:/nginx/certs/a.pem');
    check('toEscapedNginxPath quotes and doubles backslashes',
      plat.toEscapedNginxPath(String.raw`C:\nginx\test\a.pem`) === '"C:\\\\nginx\\\\test\\\\a.pem"',
      plat.toEscapedNginxPath(String.raw`C:\nginx\test\a.pem`));
    check('toEscapedNginxPath normalises forward slashes to escaped backslashes',
      plat.toEscapedNginxPath('C:/nginx/a.pem') === '"C:\\\\nginx\\\\a.pem"');
    check('hasBackslashPath detects legacy paths',
      plat.hasBackslashPath(String.raw`C:\ssl\a.pem`) === true &&
      plat.hasBackslashPath('C:/ssl/a.pem') === false);

    setGroup('Windows: generated config');

    const conf = gen.buildConf(makeDomain(gen), WIN_NGINX, WIN_SSL);
    const lines = sslLines(conf);

    check('cert paths contain no backslashes',
      lines.every((l) => !l.includes('\\')), lines.join(' | '));
    check('sslDir fallback produces a clean forward-slash path',
      lines[0].includes('C:/nginx/test/certs/test.example.com/fullchain.pem'), lines[0].trim());
    check('no mixed separators anywhere in the config',
      !/[A-Za-z]:\\[^\n]*\//.test(conf));
    check('explanatory comment is present',
      commentLines(conf).some((c) => c.includes('forward slashes')));

    const all = conf.split('\n');
    const certIdx = all.findIndex((l) => l.includes('ssl_certificate '));
    const cmtIdx = all.findIndex((l) => l.trim().startsWith('# Windows:'));
    check('comment sits immediately above ssl_certificate',
      cmtIdx >= 0 && cmtIdx < certIdx, `comment@${cmtIdx} cert@${certIdx}`);

    const legacy = makeDomain(gen, {
      ssl: {
        certPath: String.raw`C:\nginx\test\certs\fullchain.pem`,
        keyPath: String.raw`C:\nginx\test\certs\privkey.pem`,
      },
    });
    const legacyLines = sslLines(gen.buildConf(legacy, WIN_NGINX, WIN_SSL));
    check('legacy backslash certPath is normalised on regeneration',
      legacyLines.every((l) => !l.includes('\\')), legacyLines.join(' | '));

    const escaped = gen.buildConf(makeDomain(gen), WIN_NGINX, WIN_SSL, {
      certPathStyle: gen.CERT_PATH_STYLES.ESCAPED,
    });
    const escLines = sslLines(escaped);
    check('escaped style quotes the path',
      escLines.every((l) => /ssl_certificate(_key)? "/.test(l)), escLines[0].trim());
    check('escaped style doubles every backslash',
      escLines[0].includes('C:\\\\nginx\\\\test\\\\certs'), escLines[0].trim());
    check('escaped style leaves no single backslash',
      !/[^\\]\\[^\\]/.test(escLines[0]));
    check('escaped style comment mentions escaped backslashes',
      commentLines(escaped).some((c) => c.includes('escaped backslashes')));

    setGroup('Windows: default cert paths honour sslDir');

    const d1 = gen.getDefaultCertPaths('test.example.com', 'win32', String.raw`C:\ssl`);
    check('uses the configured sslDir',
      d1.certPath === 'C:/ssl/test.example.com/fullchain.pem', d1.certPath);
    check('key path matches', d1.keyPath === 'C:/ssl/test.example.com/privkey.pem');
    check('no backslashes in the suggestion', !d1.certPath.includes('\\'));
    check('falls back when sslDir is empty',
      gen.getDefaultCertPaths('a.com', 'win32', '').certPath === 'C:/easy-devops/ssl/a.com/fullchain.pem');
    // A raw template literal cannot end in a backslash, hence the plain string.
    check('trailing separator does not double up',
      gen.getDefaultCertPaths('a.com', 'win32', 'C:\\ssl\\').certPath === 'C:/ssl/a.com/fullchain.pem');

    setGroup('Windows: error attribution (retry only for this file)');

    const CONF = String.raw`C:\nginx\conf\conf.d\test.example.com.conf`;
    const here =
      'nginx: [emerg] cannot load certificate "C:/nginx/test/certs/fullchain.pem": ' +
      'BIO_new_file() failed (SSL: error:02001002) in C:/nginx/conf/conf.d/test.example.com.conf:7';
    const elsewhere =
      'nginx: [emerg] cannot load certificate "C:/other/cert.pem": BIO_new_file() failed ' +
      'in C:/nginx/conf/conf.d/other.conf:9';
    const syntax = 'nginx: [emerg] unexpected "}" in C:/nginx/conf/conf.d/test.example.com.conf:22';

    check("retries when this config's certificate fails", plat.isCertPathErrorFor(here, CONF) === true);
    check('does NOT retry when another config is to blame', plat.isCertPathErrorFor(elsewhere, CONF) === false);
    check('does NOT retry on a plain syntax error', plat.isCertPathErrorFor(syntax, CONF) === false);
    check('matches despite separator differences',
      plat.isCertPathErrorFor(here, String.raw`C:\nginx\conf\conf.d\test.example.com.conf`) === true);
    check('empty output is not a cert error', plat.isCertPathErrorFor('', CONF) === false);
    check('parseNginxErrorFiles extracts the blamed file',
      plat.parseNginxErrorFiles(here)[0] === 'C:/nginx/conf/conf.d/test.example.com.conf',
      plat.parseNginxErrorFiles(here).join(','));
  } else {
    setGroup('Linux: output must be unchanged');

    check('toNginxPath is identity',
      plat.toNginxPath('/etc/easy-devops/ssl/a.pem') === '/etc/easy-devops/ssl/a.pem');
    check('toNginxPath does not touch a literal backslash',
      plat.toNginxPath('/etc/we\\ird/a.pem') === '/etc/we\\ird/a.pem');

    const conf = gen.buildConf(makeDomain(gen), '/etc/nginx', '/etc/easy-devops/ssl');
    const lines = sslLines(conf);

    check('cert path is the plain sslDir convention',
      lines[0].trim() === 'ssl_certificate /etc/easy-devops/ssl/test.example.com/fullchain.pem;',
      lines[0].trim());
    check('key path is unchanged',
      lines[1].trim() === 'ssl_certificate_key /etc/easy-devops/ssl/test.example.com/privkey.pem;');
    check('NO Windows comment is emitted',
      !commentLines(conf).some((c) => c.includes('Windows:')),
      commentLines(conf).join(' | ') || '(no comments)');
    check('an escaped style request is ignored (paths never quoted)',
      sslLines(gen.buildConf(makeDomain(gen), '/etc/nginx', '/etc/easy-devops/ssl',
        { certPathStyle: 'escaped' }))[0].trim() ===
        'ssl_certificate /etc/easy-devops/ssl/test.example.com/fullchain.pem;');
    check('default cert path unchanged',
      gen.getDefaultCertPaths('a.com', 'linux', '/etc/easy-devops/ssl').certPath ===
        '/etc/easy-devops/ssl/a.com/fullchain.pem');
    check('no retry style is offered (single attempt only)',
      plat.isWindows === false);

    setGroup('Report-only scan (platform independent)');

    const scanned = apply.findBackslashCertPaths([
      { name: 'legacy.com', ssl: { enabled: true, certPath: String.raw`C:\ssl\legacy.com\f.pem`, keyPath: String.raw`C:\ssl\legacy.com\k.pem` } },
      { name: 'fixed.com', ssl: { enabled: true, certPath: 'C:/ssl/fixed.com/f.pem', keyPath: 'C:/ssl/fixed.com/k.pem' } },
      { name: 'nossl.com', ssl: { enabled: false, certPath: String.raw`C:\ssl\x\f.pem`, keyPath: '' } },
    ]);
    check('flags only the backslash SSL domain',
      scanned.length === 1 && scanned[0].name === 'legacy.com',
      scanned.map((s) => s.name).join(',') || '(none)');
    check('ignores SSL-disabled domains', !scanned.some((s) => s.name === 'nossl.com'));
    check('handles a non-array input', apply.findBackslashCertPaths(null).length === 0);
  }

  process.stdout.write(MARKER + JSON.stringify(out));
  process.exit(0);
}

// ─── Parent: spawn one child per platform and aggregate ───────────────────────

async function runPlatform(platform, configDir) {
  const child = spawn(process.execPath, [SELF], {
    cwd: ROOT,
    env: {
      ...process.env,
      EZ_FAKE_PLATFORM: platform,
      // Both guard variables are passed through explicitly rather than left
      // to inheritance: a child that loses them would resolve the REAL data
      // directory, and EZ_TEST=1 makes that throw rather than happen quietly.
      EZ_TEST: '1',
      EASY_DEVOPS_DATA_DIR: configDir,
      // Isolate the config directory. core/nginx-apply.js imports core/config.js
      // -> core/db.js, which picks its data dir from process.platform: forcing
      // 'linux' would otherwise resolve a POSIX path that does not exist and
      // trigger db.js's legacy migration, which RENAMES data/easy-devops.sqlite.
      APPDATA: configDir,
      HOME: configDir,
      USERPROFILE: configDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const [code] = await once(child, 'exit');

  const at = stdout.indexOf(MARKER);
  if (at === -1) {
    throw new Error(
      `child for ${platform} produced no results (exit ${code})\n${stdout}\n${stderr}`
    );
  }
  return JSON.parse(stdout.slice(at + MARKER.length));
}

async function main() {
  // A scratch config dir for the children, with a pre-created zero-byte SQLite
  // file (a valid empty database) so db.js's legacy migration is a no-op under
  // either platform branch. The real config is never opened.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ezdevops-sslpath-'));
  for (const sub of ['easy-devops', path.join('.config', 'easy-devops')]) {
    const dir = path.join(tmpRoot, sub);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'easy-devops.sqlite'), '');
  }

  const legacyDb = path.join(ROOT, 'data', 'easy-devops.sqlite');
  const legacyBefore = fs.existsSync(legacyDb) ? fs.statSync(legacyDb).mtimeMs : null;
  const legacyMarkerBefore = fs.existsSync(`${legacyDb}.migrated`)
    ? fs.statSync(`${legacyDb}.migrated`).mtimeMs
    : null;

  const all = [];
  for (const platform of ['win32', 'linux']) {
    const results = await runPlatform(platform, tmpRoot);
    let current = '';
    for (const r of results) {
      if (r.group && r.group !== current) {
        current = r.group;
        process.stdout.write(`\n── ${current}\n`);
      }
      process.stdout.write(
        `   ${r.passed ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? `  (${r.detail})` : ''}\n`
      );
      all.push(r);
    }
  }

  // Prove the real config and the legacy database were left alone.
  process.stdout.write('\n── Isolation\n');
  const legacyAfter = fs.existsSync(legacyDb) ? fs.statSync(legacyDb).mtimeMs : null;
  const legacyMarkerAfter = fs.existsSync(`${legacyDb}.migrated`)
    ? fs.statSync(`${legacyDb}.migrated`).mtimeMs
    : null;
  const untouched = legacyAfter === legacyBefore;
  const markerUnchanged = legacyMarkerAfter === legacyMarkerBefore;
  all.push({ group: 'Isolation', label: 'data/easy-devops.sqlite untouched', passed: untouched, detail: '' });
  all.push({ group: 'Isolation', label: 'the legacy .migrated marker was neither created nor modified', passed: markerUnchanged, detail: '' });
  process.stdout.write(`   ${untouched ? 'PASS' : 'FAIL'}  data/easy-devops.sqlite untouched\n`);
  process.stdout.write(`   ${markerUnchanged ? 'PASS' : 'FAIL'}  the legacy .migrated marker was neither created nor modified\n`);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.stdout.write('   cleaned up temp config dir\n');

  const failed = all.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${all.length}   PASS ${all.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label} ${f.detail}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

if (process.env.EZ_FAKE_PLATFORM) {
  runChild(process.env.EZ_FAKE_PLATFORM).catch((e) => {
    process.stderr.write(String(e.stack || e) + '\n');
    process.exit(1);
  });
} else {
  main().catch((e) => {
    process.stderr.write(String(e.stack || e) + '\n');
    process.exit(1);
  });
}
