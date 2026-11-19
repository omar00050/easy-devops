/**
 * Tests for certificate renewal: the shared renewCertificate() path and the
 * unattended job the daemon runs (core/cert-renewal.js), plus the two
 * monitor changes that depend on them (core/jobs/monitors.js).
 *
 * Run with:  npm run test:e2e -- cert-renewal
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * No ACME request is ever made and nginx is never touched: issuance, the
 * nginx reload and the nginx status probe are injected. What is real is
 * everything the decisions are made from — the config and the bookkeeping in
 * the test database, and X.509 certificates written to the temporary
 * directory so the names are read back out of actual certificates.
 *
 * Writes only inside the temporary data directory the runner provides.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed: Boolean(passed), detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

const DAY = 86_400_000;

// ─── Certificate fixtures ─────────────────────────────────────────────────────

/**
 * Writes a self-signed certificate for `names` into `<sslDir>/<domain>/`.
 *
 * node-forge is already installed (acme-client depends on it), so this adds
 * no dependency and does not need an openssl binary — which a Windows machine
 * often does not have on PATH.
 *
 * The file's mtime is set to (expiry − 90 days). cert-reader falls back to
 * "mtime + 90 days" when openssl is unavailable, so both of its paths arrive
 * at the same days-left and the suite behaves identically with or without it.
 */
function writeCert(sslDir, domain, names, daysLeft) {
  const forge = require('node-forge');
  const dir = path.join(sslDir, domain);
  assertInsideTestDataDir(dir, `write the test certificate for ${domain}`);
  fs.mkdirSync(dir, { recursive: true });

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Half a day past the whole number, so Math.floor() lands on `daysLeft`
  // however long the suite takes to reach the assertion.
  const expiry = new Date(Date.now() + daysLeft * DAY + DAY / 2);

  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(expiry.getTime() - 90 * DAY);
  cert.validity.notAfter = expiry;
  const subject = [{ name: 'commonName', value: names[0] }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }]);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());

  const certPath = path.join(dir, 'fullchain.pem');
  fs.writeFileSync(certPath, forge.pki.certificateToPem(cert));
  fs.writeFileSync(path.join(dir, 'privkey.pem'), privateKey);

  const mtime = new Date(expiry.getTime() - 90 * DAY);
  fs.utimesSync(certPath, mtime, mtime);
  return dir;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const sslDir = path.join(TEST_DATA_DIR, 'scratch', 'ssl');
  const nginxDir = path.join(TEST_DATA_DIR, 'scratch', 'nginx');
  assertInsideTestDataDir(sslDir, 'create the test ssl dir');
  fs.mkdirSync(sslDir, { recursive: true });
  fs.mkdirSync(nginxDir, { recursive: true });

  const { loadConfig, saveConfig } = await import(srcUrl('core/config.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));
  const { saveDomains, createDomain } = await import(srcUrl('core/domains-db.js'));
  const renewal = await import(srcUrl('core/cert-renewal.js'));
  const events = await import(srcUrl('core/events.js'));
  const { CERT_META_FILE } = await import(srcUrl('core/ssl-issuer.js'));

  const setConfig = (overrides = {}) => saveConfig({
    ...loadConfig(),
    sslDir,
    nginxDir,
    acmeEmail: 'ops@example.com',
    sslChallengeMode: 'auto',
    sslAutoRenew: true,
    sslAutoRenewDays: 7,
    ...overrides,
  });
  const resetState = () => dbSet('sslAutoRenewState', {});

  /** A domain record that serves the certificate in `<sslDir>/<name>`. */
  const sslDomain = (name, overrides = {}) => createDomain({
    name,
    port: 3000,
    ...overrides,
    ssl: {
      enabled: true,
      certPath: path.join(sslDir, name, 'fullchain.pem'),
      keyPath: path.join(sslDir, name, 'privkey.pem'),
      ...(overrides.ssl ?? {}),
    },
  });

  // ── 1. Settings ─────────────────────────────────────────────────────────────
  setGroup('1. Settings');
  {
    const fresh = loadConfig();
    check('a config with nothing stored reads as enabled',
      renewal.getAutoRenewSettings(fresh).enabled === true);
    check('the default window is 7 days',
      renewal.getAutoRenewSettings(fresh).days === 7 && renewal.DEFAULT_AUTO_RENEW_DAYS === 7);
    check('an install that predates the setting is enabled at 7 days',
      JSON.stringify(renewal.getAutoRenewSettings({})) === JSON.stringify({ enabled: true, days: 7 }));
    check('sslAutoRenew: false disables it',
      renewal.getAutoRenewSettings({ sslAutoRenew: false, sslAutoRenewDays: 7 }).enabled === false);
    check('an unusable stored window falls back to the default rather than disabling',
      renewal.getAutoRenewSettings({ sslAutoRenewDays: 'soon' }).days === 7
      && renewal.getAutoRenewSettings({ sslAutoRenewDays: 0 }).days === 7);

    const n = renewal.normalizeAutoRenewDays;
    check('normalizeAutoRenewDays accepts whole numbers in range, as number or string',
      n(7) === 7 && n('14') === 14 && n(renewal.MIN_AUTO_RENEW_DAYS) === 1 && n(renewal.MAX_AUTO_RENEW_DAYS) === 30);
    check('normalizeAutoRenewDays refuses everything else',
      [0, 31, -1, 1.5, '', 'x', null, undefined, true, NaN].every((v) => n(v) === null));
  }

  // ── 2. Reading a certificate ────────────────────────────────────────────────
  setGroup('2. What a certificate covers');
  {
    setConfig();

    writeCert(sslDir, 'plain.example.com', ['plain.example.com'], 60);
    const plain = await renewal.describeCertificate('plain.example.com');
    check('a single-name certificate is HTTP-01, no www, no wildcard',
      plain.validationMethod === 'http' && !plain.www && !plain.wildcard && plain.source === 'certificate',
      JSON.stringify(plain));

    writeCert(sslDir, 'www.example.org', ['www.example.org'], 60);
    writeCert(sslDir, 'site.example.com', ['site.example.com', 'www.site.example.com'], 60);
    const www = await renewal.describeCertificate('site.example.com');
    check('a certificate issued with www is recognised from its own names',
      www.www === true && www.names.includes('www.site.example.com') && www.validationMethod === 'http',
      www.names.join(', '));

    writeCert(sslDir, 'wild.example.com', ['wild.example.com', '*.wild.example.com'], 60);
    const wild = await renewal.describeCertificate('wild.example.com');
    check('a wildcard certificate is DNS-01', wild.wildcard === true && wild.validationMethod === 'dns');

    // A single-name certificate validated over DNS looks identical to an
    // HTTP one. Only the metadata written at issuance can tell them apart.
    const dnsDir = writeCert(sslDir, 'dnsonly.example.com', ['dnsonly.example.com'], 60);
    fs.writeFileSync(path.join(dnsDir, CERT_META_FILE), JSON.stringify({ validationMethod: 'dns' }));
    const dnsOnly = await renewal.describeCertificate('dnsonly.example.com');
    check('the issuance metadata marks a single-name DNS-01 certificate',
      dnsOnly.validationMethod === 'dns' && dnsOnly.wildcard === false);

    const metaDir = path.join(sslDir, 'metaonly.example.com');
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(path.join(metaDir, 'fullchain.pem'), 'not a certificate');
    fs.writeFileSync(path.join(metaDir, CERT_META_FILE),
      JSON.stringify({ altNames: ['metaonly.example.com', 'www.metaonly.example.com'], validationMethod: 'http' }));
    const metaOnly = await renewal.describeCertificate('metaonly.example.com');
    check('an unparseable certificate falls back to the metadata names',
      metaOnly.source === 'meta' && metaOnly.www === true);

    const missing = await renewal.describeCertificate('nothing.example.com');
    check('with neither, it assumes the bare domain over HTTP-01 and says the source is unknown',
      missing.source === 'unknown' && missing.names.join() === 'nothing.example.com'
      && missing.validationMethod === 'http');

    const garbageMeta = writeCert(sslDir, 'badmeta.example.com', ['badmeta.example.com'], 60);
    fs.writeFileSync(path.join(garbageMeta, CERT_META_FILE), '{ not json');
    const badMeta = await renewal.describeCertificate('badmeta.example.com');
    check('corrupt metadata is ignored, not fatal',
      badMeta.source === 'certificate' && badMeta.validationMethod === 'http');
  }

  // ── 2b. Not issued yet vs unreadable ────────────────────────────────────────
  setGroup('2b. Certificates that do not exist yet');
  {
    const reader = await import(srcUrl('core/cert-reader.js'));
    const readDir = path.join(TEST_DATA_DIR, 'scratch', 'ssl-states');
    fs.mkdirSync(readDir, { recursive: true });
    fs.mkdirSync(path.join(readDir, 'new.example.com'), { recursive: true });
    fs.mkdirSync(path.join(readDir, 'bad.example.com'), { recursive: true });
    fs.writeFileSync(path.join(readDir, 'bad.example.com', 'fullchain.pem'), 'not a certificate');
    writeCert(readDir, 'valid.example.com', ['valid.example.com'], 60);

    const certs = await reader.listAllCerts({ sslDir: readDir, includeUnusable: true });
    const of = (name) => certs.find((cert) => cert.domain === name);
    check('a missing certificate is not_issued with the "Not issued yet" label',
      of('new.example.com')?.status === 'not_issued' && of('new.example.com')?.label === 'Not issued yet');
    check('an unparseable certificate file stays unreadable',
      of('bad.example.com')?.status === 'unreadable');
    check('a valid certificate still reads normally',
      of('valid.example.com')?.status === 'valid' && of('valid.example.com')?.daysLeft >= 59);
  }

  // ── 3. In use? ──────────────────────────────────────────────────────────────
  setGroup('3. Which certificates are in use');
  {
    const inUse = (domains, cert = 'a.example.com') => renewal.isCertInUse(cert, domains, sslDir);

    check('an enabled domain with SSL on uses its own certificate',
      inUse([sslDomain('a.example.com')]));
    check('a disabled domain does not',
      !inUse([sslDomain('a.example.com', { enabled: false })]));
    check('a domain with SSL off does not',
      !inUse([sslDomain('a.example.com', { ssl: { enabled: false } })]));
    check('another domain pointing its paths into the directory does',
      inUse([sslDomain('other.example.com', {
        ssl: { certPath: path.join(sslDir, 'a.example.com', 'fullchain.pem'), keyPath: '' },
      })]));
    check('Windows-style backslash paths still match',
      inUse([sslDomain('other.example.com', {
        ssl: { certPath: `${sslDir.replace(/\//g, '\\')}\\a.example.com\\fullchain.pem`, keyPath: '' },
      })]));
    check('a directory that merely shares the prefix does not',
      !inUse([sslDomain('other.example.com', {
        ssl: { certPath: path.join(sslDir, 'a.example.com.evil', 'fullchain.pem'), keyPath: '' },
      })]));
    check('no domains at all means not in use', !inUse([]) && !inUse(undefined));
  }

  // ── 4. renewCertificate ─────────────────────────────────────────────────────
  setGroup('4. Renewing one certificate');
  {
    setConfig();

    /** Collaborators that record what they were asked to do. */
    const harness = ({ mode = 'proxy', success = true, nginxUp = true, reloadOk = true, prepareOk = true, record = null } = {}) => {
      const calls = { issue: [], reload: 0, prepare: 0 };
      const deps = {
        issue: async (domain, options) => {
          calls.issue.push({ domain, options });
          return success
            ? { success: true, mode, certPath: 'c', keyPath: 'k', fellBack: false, nginxDownMs: mode === 'standalone' ? 1200 : 0, staging: false }
            : { success: false, mode, error: { step: 'ACME validation', cause: 'boom\nsecond line', consequence: 'x' } };
        },
        reload: async () => { calls.reload += 1; return { ok: reloadOk, output: reloadOk ? '' : 'nginx: [emerg] bad' }; },
        prepare: async () => { calls.prepare += 1; return prepareOk ? { ok: true, regenerated: true } : { ok: false, error: 'nginx -t failed' }; },
        nginxStatus: async () => ({ running: nginxUp }),
        lookupDomain: () => record,
      };
      return { calls, deps };
    };

    {
      const h = harness();
      const r = await renewal.renewCertificate('site.example.com', { deps: h.deps });
      check('a www certificate is renewed WITH www',
        r.success && h.calls.issue[0]?.options.www === true && h.calls.issue[0]?.options.validationMethod === 'http');
      check('the configured ACME email is used when none is passed',
        h.calls.issue[0]?.options.email === 'ops@example.com');
      check('nginx is reloaded after a proxy-mode renewal', h.calls.reload === 1 && r.nginxReloaded === true);
      check('the summary says so', renewal.describeRenewal(r).includes('nginx reloaded'), renewal.describeRenewal(r));
    }

    {
      const h = harness();
      const r = await renewal.renewCertificate('plain.example.com', { deps: h.deps });
      check('a single-name certificate is renewed without www', h.calls.issue[0]?.options.www === false && r.success);
    }

    {
      const h = harness();
      const r = await renewal.renewCertificate('wild.example.com', { deps: h.deps });
      check('a wildcard certificate is refused, not replaced by a single-name one',
        !r.success && r.skipped === 'manual' && h.calls.issue.length === 0);
      check('and nginx is left alone', h.calls.reload === 0 && h.calls.prepare === 0);
    }

    {
      const h = harness();
      const r = await renewal.renewCertificate('dnsonly.example.com', { deps: h.deps });
      check('a DNS-validated single-name certificate is refused too',
        r.skipped === 'manual' && h.calls.issue.length === 0);
    }

    {
      const h = harness({ reloadOk: false });
      const r = await renewal.renewCertificate('plain.example.com', { deps: h.deps });
      check('a failed reload does not turn a successful renewal into a failure',
        r.success === true && r.nginxReloaded === false);
      check('but the summary is loud about it', renewal.describeRenewal(r).includes('reload FAILED'));
    }

    {
      const h = harness({ mode: 'standalone' });
      const r = await renewal.renewCertificate('plain.example.com', { deps: h.deps });
      check('standalone mode restarts nginx itself, so no extra reload',
        r.success && h.calls.reload === 0 && r.nginxReloaded === null);
    }

    {
      const h = harness({ success: false });
      const r = await renewal.renewCertificate('plain.example.com', { deps: h.deps });
      check('a failed renewal does not reload nginx', !r.success && h.calls.reload === 0);
      check('failureReason() is the first line of the cause', renewal.failureReason(r) === 'boom');
    }

    {
      const h = harness({ prepareOk: false, record: { name: 'plain.example.com' } });
      const r = await renewal.renewCertificate('plain.example.com', { deps: h.deps });
      check('a config that cannot be prepared stops before any ACME request',
        !r.success && r.error.step === 'challenge setup' && h.calls.issue.length === 0);
    }

    {
      const h = harness({ record: { name: 'plain.example.com' } });
      const r = await renewal.renewCertificate('plain.example.com', { deps: h.deps });
      check('a regenerated config is reported', h.calls.prepare === 1 && r.configRegenerated === true);
    }

    // The unattended rule: never stop a running nginx.
    {
      const h = harness({ nginxUp: true });
      await renewal.renewCertificate('plain.example.com', { unattended: true, deps: h.deps });
      check('unattended + nginx running + auto → pinned to proxy mode',
        h.calls.issue[0]?.options.mode === 'proxy');
    }
    {
      const h = harness({ nginxUp: false });
      await renewal.renewCertificate('plain.example.com', { unattended: true, deps: h.deps });
      check('unattended + nginx NOT running → mode left to the issuer (nothing to stop)',
        h.calls.issue[0]?.options.mode === undefined);
    }
    {
      const h = harness({ nginxUp: true });
      await renewal.renewCertificate('plain.example.com', { deps: h.deps });
      check('an attended renewal keeps the configured mode', h.calls.issue[0]?.options.mode === undefined);
    }
    {
      setConfig({ sslChallengeMode: 'standalone' });
      const h = harness({ nginxUp: true });
      await renewal.renewCertificate('plain.example.com', { unattended: true, deps: h.deps });
      check('an explicit standalone setting is respected even unattended',
        h.calls.issue[0]?.options.mode === undefined);
      setConfig();
    }
    {
      const h = harness({ nginxUp: true });
      h.deps.nginxStatus = async () => { throw new Error('cannot ask'); };
      await renewal.renewCertificate('plain.example.com', { unattended: true, deps: h.deps });
      check('a status probe that throws is treated as "not running", not as a crash',
        h.calls.issue.length === 1 && h.calls.issue[0].options.mode === undefined);
    }
  }

  // ── 5. The unattended job ───────────────────────────────────────────────────
  setGroup('5. The automatic renewal job');
  {
    const httpInfo = { names: ['x'], www: false, wildcard: false, validationMethod: 'http', source: 'certificate' };
    const dnsInfo = { ...httpInfo, wildcard: true, validationMethod: 'dns' };

    /**
     * Runs one pass over `certs` ({ domain, daysLeft, dns?, unused? }).
     * Every certificate is "in use" unless marked otherwise.
     */
    const pass = async (certs, { now = Date.now(), renew, onEvent } = {}) => {
      const renewed = [];
      const emitted = [];
      let bumps = 0;
      const out = await renewal.runAutoRenewal({
        now,
        onEvent: onEvent ?? ((event, domain) => { emitted.push({ event, domain }); }),
        deps: {
          listCerts: async () => certs.map(({ domain, daysLeft }) => ({ domain, daysLeft })),
          describe: async (domain) => (certs.find((c) => c.domain === domain)?.dns ? dnsInfo : httpInfo),
          listDomains: () => certs.filter((c) => !c.unused).map((c) => sslDomain(c.domain)),
          renew: renew ?? (async (domain, options) => {
            renewed.push({ domain, options });
            return { success: true, mode: 'proxy', nginxReloaded: true };
          }),
          bumpRevision: () => { bumps += 1; },
        },
      });
      return { out, renewed, emitted, bumps: () => bumps };
    };
    const actionFor = (out, domain) => out.results.find((r) => r.domain === domain)?.action;

    setConfig({ sslAutoRenew: false });
    resetState();
    {
      const { out, renewed } = await pass([{ domain: 'a.example.com', daysLeft: 2 }]);
      check('switched off: nothing is renewed, even two days from expiry',
        out.enabled === false && renewed.length === 0 && out.results.length === 0);
    }

    setConfig();
    resetState();
    {
      const { out, renewed, emitted, bumps } = await pass([
        { domain: 'far.example.com', daysLeft: 40 },
        { domain: 'eight.example.com', daysLeft: 8 },
        { domain: 'seven.example.com', daysLeft: 7 },
        { domain: 'expired.example.com', daysLeft: -3 },
        { domain: 'unreadable.example.com', daysLeft: null },
      ]);
      check('8 days left is outside a 7-day window', !renewed.some((r) => r.domain === 'eight.example.com'));
      check('exactly 7 days left is inside it', renewed.some((r) => r.domain === 'seven.example.com'));
      check('an already-expired certificate is renewed', renewed.some((r) => r.domain === 'expired.example.com'));
      check('a certificate far from expiry is left alone', !renewed.some((r) => r.domain === 'far.example.com'));
      check('an unreadable certificate is not attempted', !renewed.some((r) => r.domain === 'unreadable.example.com'));
      check('the job always renews unattended', renewed.every((r) => r.options.unattended === true));
      check('each renewal emits a "renewed" event for that domain',
        emitted.length === 2 && emitted.every((e) => e.event.type === 'cert_expiry' && e.event.subtype === 'renewed'
          && e.event.severity === 'success' && e.event.domain === e.domain));
      check('the Hub revision is bumped once', bumps() === 1);
      check('the summary reports both', out.results.filter((r) => r.action === 'renewed').length === 2);

      const state = renewal.getAutoRenewState();
      check('the outcome is recorded', state['seven.example.com']?.lastResult === 'renewed'
        && typeof state['seven.example.com']?.lastRenewedAt === 'number');
    }

    setConfig({ sslAutoRenewDays: 20 });
    resetState();
    {
      const { renewed } = await pass([
        { domain: 'eighteen.example.com', daysLeft: 18 },
        { domain: 'twentyfive.example.com', daysLeft: 25 },
      ]);
      check('the window follows the setting',
        renewed.length === 1 && renewed[0].domain === 'eighteen.example.com');
    }

    setConfig();
    resetState();
    {
      const { out, renewed, emitted, bumps } = await pass([
        { domain: 'wild.example.com', daysLeft: 3, dns: true },
        { domain: 'leftover.example.com', daysLeft: 3, unused: true },
      ]);
      check('a DNS-01 certificate is reported as manual and never attempted',
        actionFor(out, 'wild.example.com') === 'manual' && renewed.length === 0);
      check('a certificate no enabled domain uses is skipped',
        actionFor(out, 'leftover.example.com') === 'skipped');
      check('neither produces a renewal event or a Hub bump', emitted.length === 0 && bumps() === 0);
      check('neither is recorded as an attempt',
        Object.keys(renewal.getAutoRenewState()).length === 0);
    }

    // Failure, and the gap that stops a restart loop from hammering Let's Encrypt.
    resetState();
    {
      const t0 = 1_800_000_000_000;
      let attempts = 0;
      let attemptSeenBeforeIssuing = null;
      const failing = async (domain) => {
        attempts += 1;
        attemptSeenBeforeIssuing = renewal.getAutoRenewState()[domain]?.lastAttemptAt ?? null;
        return { success: false, error: { step: 'ACME validation', cause: 'DNS problem: NXDOMAIN\nmore detail' } };
      };
      const certs = [{ domain: 'broken.example.com', daysLeft: 5 }];

      const first = await pass(certs, { now: t0, renew: failing });
      check('a failed attempt is reported as failed', actionFor(first.out, 'broken.example.com') === 'failed');
      check('the attempt is written down BEFORE issuance starts', attemptSeenBeforeIssuing === t0);
      check('it emits a danger event carrying the reason and the days left',
        first.emitted.length === 1
        && first.emitted[0].event.subtype === 'renew_failed'
        && first.emitted[0].event.severity === 'danger'
        && first.emitted[0].event.message.includes('NXDOMAIN')
        && first.emitted[0].event.message.includes('5 days left')
        && !first.emitted[0].event.message.includes('more detail'),
        first.emitted[0]?.event.message);
      check('a failure does not bump the Hub revision', first.bumps() === 0);

      const again = await pass(certs, { now: t0 + 60_000, renew: failing });
      check('a second pass a minute later does NOT retry',
        attempts === 1 && actionFor(again.out, 'broken.example.com') === 'skipped' && again.emitted.length === 0);

      const justBefore = await pass(certs, { now: t0 + renewal.RENEW_RETRY_MS - 1, renew: failing });
      check('still not just inside the retry gap', attempts === 1 && justBefore.emitted.length === 0);

      await pass(certs, { now: t0 + renewal.RENEW_RETRY_MS, renew: failing });
      check('it retries once the gap has passed', attempts === 2);
      check('failures are counted',
        renewal.getAutoRenewState()['broken.example.com']?.failures === 2
        && renewal.getAutoRenewState()['broken.example.com']?.lastError === 'DNS problem: NXDOMAIN');

      const fixed = await pass(certs, { now: t0 + 3 * renewal.RENEW_RETRY_MS });
      check('a later success clears the failure count',
        fixed.renewed.length === 1 && renewal.getAutoRenewState()['broken.example.com']?.failures === 0
        && renewal.getAutoRenewState()['broken.example.com']?.lastError === null);
    }

    resetState();
    {
      let order = [];
      const { out } = await pass(
        [{ domain: 'throws.example.com', daysLeft: 4 }, { domain: 'after.example.com', daysLeft: 4 }],
        {
          renew: async (domain) => {
            order.push(domain);
            if (domain === 'throws.example.com') throw new Error('socket hang up');
            return { success: true, mode: 'proxy', nginxReloaded: true };
          },
        },
      );
      check('a renewal that throws is a failure, and the next certificate is still handled',
        actionFor(out, 'throws.example.com') === 'failed' && actionFor(out, 'after.example.com') === 'renewed'
        && order.length === 2);
    }

    resetState();
    {
      const { out, emitted } = await pass(
        [{ domain: 'a.example.com', daysLeft: 4 }, { domain: 'b.example.com', daysLeft: 4 }],
        { onEvent: () => { throw new Error('discord is down'); } },
      );
      check('a notification that throws does not stop the job',
        out.results.filter((r) => r.action === 'renewed').length === 2 && emitted.length === 0);
    }

    setConfig({ acmeEmail: '' });
    resetState();
    {
      const { out, renewed, emitted } = await pass([{ domain: 'noemail.example.com', daysLeft: 4 }]);
      check('without an ACME email nothing is requested, and the failure says why',
        renewed.length === 0 && actionFor(out, 'noemail.example.com') === 'failed'
        && emitted[0]?.event.message.includes('ACME email'), emitted[0]?.event.message);
    }

    setConfig();
    dbSet('sslAutoRenewState', {
      'gone.example.com': { lastAttemptAt: 1, lastResult: 'failed', failures: 3 },
      'kept.example.com': { lastAttemptAt: 1, lastResult: 'renewed', failures: 0 },
    });
    {
      await pass([{ domain: 'kept.example.com', daysLeft: 60 }]);
      const state = renewal.getAutoRenewState();
      check('bookkeeping for a certificate that no longer exists is dropped',
        !('gone.example.com' in state) && 'kept.example.com' in state);
    }

    resetState();
    {
      const out = await renewal.runAutoRenewal({
        deps: { listCerts: async () => { throw new Error('EACCES'); } },
      });
      check('an unreadable certificate directory is not an error', out.enabled && out.results.length === 0);
    }
  }

  // ── 6. Events ───────────────────────────────────────────────────────────────
  setGroup('6. Notification events');
  {
    const plain = events.createCertExpiryEvent('a.example.com', 5);
    check('the expiry warning is unchanged for an ordinary certificate',
      plain.message === '🔒 SSL cert for a.example.com expires in 5 days' && plain.severity === 'danger'
      && plain.type === 'cert_expiry' && plain.subtype === undefined, plain.message);
    check('singular day', events.createCertExpiryEvent('a.example.com', 1).message.endsWith('expires in 1 day'));

    const manual = events.createCertExpiryEvent('w.example.com', 20, { manualRenewal: true });
    check('a DNS-01 certificate\'s warning says it must be renewed manually',
      manual.message.includes('renewed manually') && manual.severity === 'warning', manual.message);

    const ok = events.createCertRenewedEvent('a.example.com', 'nginx kept running');
    const bad = events.createCertRenewFailedEvent('a.example.com', 1, 'boom');
    check('renewed / failed share the cert_expiry type so they follow its channel routing',
      ok.type === 'cert_expiry' && bad.type === 'cert_expiry' && ok.subtype === 'renewed' && bad.subtype === 'renew_failed');
    check('the failed event handles a singular day and a missing count',
      bad.message.includes('(1 day left)')
      && !events.createCertRenewFailedEvent('a.example.com', null, 'boom').message.includes('left'));
  }

  // ── 7. The expiry warning, now aware of auto-renewal ────────────────────────
  setGroup('7. Expiry warnings and auto-renewal');
  {
    // A fresh directory, so only these certificates are seen.
    const sslDir7 = path.join(TEST_DATA_DIR, 'scratch', 'ssl-warnings');
    fs.mkdirSync(sslDir7, { recursive: true });
    const domainIn = (name) => createDomain({
      name, port: 3000,
      ssl: { enabled: true, certPath: path.join(sslDir7, name, 'fullchain.pem'), keyPath: path.join(sslDir7, name, 'privkey.pem') },
    });

    writeCert(sslDir7, 'covered.example.com', ['covered.example.com'], 20);
    writeCert(sslDir7, 'inwindow.example.com', ['inwindow.example.com'], 5);
    writeCert(sslDir7, 'leftover.example.com', ['leftover.example.com'], 20);
    writeCert(sslDir7, 'wild.example.com', ['wild.example.com', '*.wild.example.com'], 20);
    writeCert(sslDir7, 'healthy.example.com', ['healthy.example.com'], 60);

    saveDomains([
      domainIn('covered.example.com'), domainIn('inwindow.example.com'),
      domainIn('wild.example.com'), domainIn('healthy.example.com'),
    ]);

    const monitors = await import(srcUrl('core/jobs/monitors.js'));
    const warned = async () => (await monitors.checkCertExpiry()).map((e) => e.domain).sort();

    setConfig({ sslDir: sslDir7 });
    const on = await monitors.checkCertExpiry();
    const onNames = on.map((e) => e.domain).sort();

    check('a certificate auto-renewal will handle is NOT warned about before its window',
      !onNames.includes('covered.example.com'), onNames.join(', '));
    check('inside the window and still not renewed, the warning is back',
      onNames.includes('inwindow.example.com'));
    check('a certificate no domain uses is still warned about — nothing will renew it',
      onNames.includes('leftover.example.com'));
    check('a wildcard is warned about, and told it needs a manual renewal',
      on.find((e) => e.domain === 'wild.example.com')?.message.includes('renewed manually'));
    check('a certificate with 60 days left is not mentioned', !onNames.includes('healthy.example.com'));

    setConfig({ sslDir: sslDir7, sslAutoRenew: false });
    const offNames = await warned();
    check('with auto-renewal off, every certificate under 30 days is warned about again',
      ['covered.example.com', 'inwindow.example.com', 'leftover.example.com', 'wild.example.com']
        .every((n) => offNames.includes(n)), offNames.join(', '));

    // ── 8. Real domain health for the Hub ─────────────────────────────────────
    setGroup('8. Domain health is measured, not assumed');

    const server = http.createServer((req, res) => { res.statusCode = 204; res.end(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const openPort = server.address().port;

    // A port nothing listens on: bind one, note it, release it.
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const closedPort = probe.address().port;
    await new Promise((r) => probe.close(r));

    const probed = await monitors.probeDomains([
      { name: 'up.example.com', port: openPort },
      { name: 'down.example.com', port: closedPort },
      { name: 'remote.example.com', backendHost: 'https://elsewhere.example.net', port: 443 },
    ]);
    const upOf = (list, name) => list.find((r) => r.name === name)?.up;

    check('a backend that answers is up', upOf(probed, 'up.example.com') === true);
    check('a backend that refuses the connection is down — whatever its enabled flag says',
      upOf(probed, 'down.example.com') === false);
    check('an external URL backend is "not applicable"', upOf(probed, 'remote.example.com') === null);
    check('probeDomains() tolerates a missing list', (await monitors.probeDomains(undefined)).length === 0);

    saveDomains([
      createDomain({ name: 'up.example.com', port: openPort }),
      createDomain({ name: 'down.example.com', port: closedPort }),
    ]);
    const before = Date.now();
    const swept = await monitors.checkDomainHealth();
    const last = monitors.getLastDomainHealth();
    check('a sweep is kept for the Hub agent to report',
      last !== null && last.at >= before && upOf(last.results, 'up.example.com') === true
      && upOf(last.results, 'down.example.com') === false && last.results.length === swept.length);

    await new Promise((r) => server.close(r));
    saveDomains([]);
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label} ${f.detail}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
