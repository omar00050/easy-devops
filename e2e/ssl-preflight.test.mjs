/**
 * SSL preflight, live progress and "not issued yet" tests.
 *
 * Run with:  npm run test:e2e -- ssl-preflight
 *
 * No real DNS, HTTP, TLS or ACME request is made. DNS resolvers, the HTTP
 * probe, the challenge listener, the ACME client and the nginx shell runner
 * are all injected. Only temporary files under the runner's temporary area
 * are written.
 */

// MUST be the first import: the guard refuses to run unless EZ_TEST and a
// throwaway EASY_DEVOPS_DATA_DIR were set before Node started.
import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { promises as dnsPromises } from 'node:dns';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed: Boolean(passed), detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const DAY = 86_400_000;

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
  return dir;
}

function dnsMock({ a = [], aaaa = [], any = [], aErr = null, aaaaErr = null, anyErr = null } = {}) {
  const make = (values, err) => async () => {
    if (err) {
      const error = new Error(err);
      error.code = err;
      throw error;
    }
    return values;
  };
  return { resolve4: make(a, aErr), resolve6: make(aaaa, aaaaErr), resolveAny: make(any, anyErr) };
}

/** A challenge listener stand-in that remembers the token/body it serves. */
function challengeMock({ onGet = null, throwOnStart = null } = {}) {
  const served = new Map();
  const calls = [];
  return {
    served,
    calls,
    deps: {
      serveChallenge: async (port, token, expected, fn) => {
        if (throwOnStart) throw new Error(throwOnStart);
        served.set(token, expected);
        return fn();
      },
      httpGet: async (url, opts = {}) => {
        calls.push({ url, opts });
        const parsed = new URL(url);
        const token = parsed.pathname.split('/').pop();
        const expected = served.get(token) ?? '';
        if (onGet) return onGet({ url, opts, token, expected, calls });
        return { ok: true, status: 200, body: expected, headers: {} };
      },
    },
  };
}

let stubCertificatePair;
function validStubCertificatePair() {
  if (stubCertificatePair) return stubCertificatePair;
  const forge = require('node-forge');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + DAY);
  const subject = [{ name: 'commonName', value: 'stage.example.com' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'stage.example.com' }] }]);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  stubCertificatePair = {
    privateKey,
    certificate: forge.pki.certificateToPem(cert),
  };
  return stubCertificatePair;
}

function acmeStub(auto) {
  const pair = validStubCertificatePair();
  return {
    directory: {
      letsencrypt: {
        staging: 'https://acme-staging.invalid/directory',
        production: 'https://acme.invalid/directory',
      },
    },
    crypto: {
      createPrivateKey: () => 'stub-account-key',
      createCsr: async () => [Buffer.from(pair.privateKey), Buffer.from('stub-csr')],
    },
    Client: class {
      constructor(options) { this.options = options; }
      auto(args) { return auto(args, pair); }
    },
  };
}

const fakeRun = async (cmd) => {
  if (/pgrep|tasklist|Get-Process/i.test(cmd)) {
    return { success: true, stdout: process.platform === 'win32' ? 'nginx.exe 123' : '123', stderr: '', exitCode: 0 };
  }
  return { success: true, stdout: '', stderr: '', exitCode: 0 };
};

const successAcme = () => acmeStub(async (args, pair) => {
  await args.challengeCreateFn({}, { token: 'tok' }, 'tok.keyauth');
  await args.challengeRemoveFn?.({}, { token: 'tok' });
  return pair.certificate;
});

async function main() {
  // Keep certificates beside the temporary data directory. Easy DevOps
  // refuses an sslDir that overlaps its dataDir, and this fixture must use the
  // same supported layout as an installed service.
  const scratch = path.join(path.dirname(TEST_DATA_DIR), 'ssl-preflight');
  const sslDir = path.join(scratch, 'ssl');
  const nginxDir = path.join(scratch, 'nginx');
  assertInsideTestDataDir(sslDir, 'create the preflight ssl dir');
  fs.mkdirSync(sslDir, { recursive: true });
  fs.mkdirSync(nginxDir, { recursive: true });

  const { saveConfig, loadConfig } = await import(srcUrl('core/config.js'));
  saveConfig({
    ...loadConfig(),
    sslDir,
    nginxDir,
    acmeEmail: 'ops@example.com',
    acmeChallengePort: 18089,
    sslChallengeMode: 'auto',
  });

  const preflight = await import(srcUrl('core/ssl/preflight.js'));
  const progressModule = await import(srcUrl('core/ssl/progress.js'));
  const issuer = await import(srcUrl('core/ssl-issuer.js'));
  const renewal = await import(srcUrl('core/cert-renewal.js'));
  const reader = await import(srcUrl('core/cert-reader.js'));

  // ── 1. Preflight checks ───────────────────────────────────────────────────
  setGroup('1. Preflight checks');

  {
    const outcome = await preflight.runPreflight('typo.exampel.com', {
      deps: dnsMock({ aErr: 'ENOTFOUND', aaaaErr: 'ENOTFOUND', anyErr: 'ENOTFOUND' }),
    });
    const dns = outcome.results.find((r) => r.id.startsWith('dns:'));
    check('a name that does not resolve fails', !outcome.ok && dns?.status === 'fail');
    check('and says there is no DNS record', /has no DNS record/.test(dns?.message ?? ''), dns?.message);
    check('with a fix that names the record to add', /A record/.test(dns?.fix ?? ''), dns?.fix);
  }

  {
    const challenge = challengeMock();
    const outcome = await preflight.runPreflight('cf.example.com', {
      deps: {
        ...dnsMock({ a: ['104.16.1.2'], any: [{ type: 'A', address: '104.16.1.2' }] }),
        ...challenge.deps,
      },
    });
    const a = outcome.results.find((r) => r.id.startsWith('a:'));
    check('a Cloudflare A record is accepted', outcome.ok && a?.status === 'ok');
    check('and reported as proxied by Cloudflare', /proxied by Cloudflare/.test(a?.message ?? ''), a?.message);
    check('the HTTP probe still ran through the public path',
      challenge.calls.some((call) => call.url.startsWith('http://cf.example.com')));
    check('preflight records that Cloudflare is in front', outcome.proxied === true);
  }

  {
    const challenge = challengeMock({
      onGet: ({ opts, expected }) => (opts.address
        ? { ok: false, status: null, body: '', error: 'ECONNREFUSED' }
        : { ok: true, status: 200, body: expected, headers: {} }),
    });
    const outcome = await preflight.runPreflight('v6.example.com', {
      deps: {
        ...dnsMock({ a: ['10.0.0.5'], aaaa: ['2001:db8::1'], any: [] }),
        ...challenge.deps,
        localAddresses: ['10.0.0.5'],
      },
    });
    const aaaa = outcome.results.find((r) => r.id.startsWith('aaaa:'));
    check('an AAAA record that does not reach this server fails', !outcome.ok && aaaa?.status === 'fail');
    check('and the message explains that Let\'s Encrypt prefers IPv6',
      /prefers IPv6/i.test(aaaa?.message ?? ''), aaaa?.message);
    check('the AAAA address itself was probed with the Host header',
      challenge.calls.some((call) => call.opts?.address === '2001:db8::1'
        && call.opts?.hostHeader === 'v6.example.com'));
  }

  {
    const challenge = challengeMock({
      onGet: () => ({ ok: true, status: 301, body: '', headers: { location: 'https://cf.example.com/' } }),
    });
    const outcome = await preflight.runPreflight('redirect.example.com', {
      deps: {
        ...dnsMock({ a: ['10.0.0.5'] }),
        ...challenge.deps,
        localAddresses: ['10.0.0.5'],
      },
    });
    const http = outcome.results.find((r) => r.id.startsWith('http:'));
    check('an http -> https redirect fails the check', !outcome.ok && http?.status === 'fail');
    check('and names Cloudflare Always Use HTTPS', /Always Use HTTPS/.test(http?.message ?? ''), http?.message);
    check('with the Cloudflare fix', /Cloudflare/.test(http?.fix ?? ''), http?.fix);
  }

  {
    const challenge = challengeMock({
      onGet: () => ({ ok: true, status: 404, body: 'not here', headers: {} }),
    });
    const outcome = await preflight.runPreflight('wrong.example.com', {
      deps: {
        ...dnsMock({ a: ['10.0.0.5'] }),
        ...challenge.deps,
        localAddresses: ['10.0.0.5'],
      },
    });
    const http = outcome.results.find((r) => r.id.startsWith('http:'));
    check('a different server answering is a fail', !outcome.ok && http?.status === 'fail');
    check('and says another server answers', /another server answers/.test(http?.message ?? ''), http?.message);
  }

  {
    const challenge = challengeMock({
      onGet: () => ({ ok: false, status: null, body: '', error: 'ECONNREFUSED' }),
    });
    const outcome = await preflight.runPreflight('closed.example.com', {
      deps: {
        ...dnsMock({ a: ['10.0.0.5'] }),
        ...challenge.deps,
        localAddresses: ['10.0.0.5'],
      },
    });
    const http = outcome.results.find((r) => r.id.startsWith('http:'));
    check('a refused connection is a fail', !outcome.ok && http?.status === 'fail');
    check('and says port 80 is closed or blocked', /port 80 is closed or blocked/.test(http?.message ?? ''), http?.message);
  }

  {
    const challenge = challengeMock();
    const outcome = await preflight.runPreflight('dns.example.com', {
      validationMethod: 'dns',
      deps: {
        ...dnsMock({ a: ['10.0.0.5'] }),
        ...challenge.deps,
        localAddresses: ['10.0.0.5'],
      },
    });
    const skipped = outcome.results.filter((r) => r.status === 'skipped');
    check('DNS-01 skips the IPv6 and HTTP checks, with a reason',
      skipped.some((r) => r.id === 'aaaa' && /DNS-01/.test(r.message))
      && skipped.some((r) => r.id === 'http' && /DNS-01/.test(r.message)));
    check('DNS-01 makes no HTTP probe', challenge.calls.length === 0);
  }

  // ── 2. A failed preflight stops before ACME ───────────────────────────────
  setGroup('2. A failed preflight spends no Let\'s Encrypt attempt');

  {
    let acmeCalls = 0;
    const acme = acmeStub(async () => { acmeCalls += 1; return 'cert'; });
    const result = await issuer.issueCertificate('typo.exampel.com', {
      email: 'ops@example.com',
      opId: 'preflight-fail-1',
      deps: {
        acme,
        preflight: (name, opts) => preflight.runPreflight(name, {
          ...opts,
          deps: dnsMock({ aErr: 'ENOTFOUND', aaaaErr: 'ENOTFOUND', anyErr: 'ENOTFOUND' }),
        }),
      },
    });
    check('the operation fails at preflight', result.success === false && result.error?.step === 'preflight');
    check('the ACME client was never called', acmeCalls === 0);
    check('the error carries the real cause and a fix',
      /has no DNS record/.test(result.error?.cause ?? '') && /A record/.test(result.error?.fix ?? ''));
    check('the result carries the server opId', result.opId === 'preflight-fail-1');
  }

  // ── 3. Stage order for a successful issue ─────────────────────────────────
  setGroup('3. Live stages for a successful issue');

  const successDeps = (auto = successAcme()) => ({
    acme: auto,
    preflight: async () => ({
      ok: true,
      results: [{ id: 'dns:stage.example.com', status: 'ok', message: 'ok', fix: '' }],
      proxied: false,
    }),
    withChallengeServer: async (port, fn) => fn({ setToken() {}, removeToken() {} }),
    verifyHttps: async () => ({ ok: true, message: 'ok' }),
    progress: { maxPerWindow: 1000, windowMs: 0 },
  });

  {
    const events = [];
    const result = await issuer.issueCertificate('stage.example.com', {
      email: 'ops@example.com',
      mode: 'proxy',
      opId: 'issue-stages-01',
      onEvent: (event) => events.push(event),
      deps: successDeps(),
      run: fakeRun,
    });

    const sequence = events.map((event) => `${event.stage}:${event.status}`);
    const expected = [
      'preflight:running', 'preflight:ok',
      'account and order:running', 'account and order:ok',
      'challenge ready:running', 'challenge ready:ok',
      'waiting for validation:running', 'waiting for validation:ok',
      'certificate received:ok',
      'files written:running', 'files written:ok',
      'nginx config test:running', 'nginx config test:ok',
      'nginx reload:running', 'nginx reload:ok',
      'https verified:running', 'https verified:ok',
    ];
    check('the stages arrive in the documented order',
      JSON.stringify(sequence) === JSON.stringify(expected), sequence.join(', '));
    check('every event carries the opId, domain, elapsed time and timestamp',
      events.every((event) => event.opId === 'issue-stages-01'
        && event.domain === 'stage.example.com'
        && typeof event.elapsedMs === 'number'
        && typeof event.at === 'string'));
    check('the issuance still succeeds', result.success === true);
  }

  // ── 4. Stage order for a renewal ──────────────────────────────────────────
  setGroup('4. Live stages for a renewal');

  {
    const events = [];
    const result = await renewal.renewCertificate('renew.example.com', {
      opId: 'renew-stages-01',
      onEvent: (event) => events.push(event),
      deps: {
        describe: async () => ({
          names: ['renew.example.com'], www: false, wildcard: false,
          validationMethod: 'http', source: 'certificate',
        }),
        lookupDomain: () => null,
        prepare: async () => ({ ok: true, regenerated: false }),
        issue: (domain, options) => issuer.issueCertificate(domain, { ...options, deps: successDeps(), run: fakeRun }),
        reload: async () => ({ ok: true, output: '' }),
        nginxStatus: async () => ({ running: true }),
        verify: async () => ({ ok: true, message: 'ok' }),
        progress: { maxPerWindow: 1000, windowMs: 0 },
      },
    });

    const sequence = events.map((event) => `${event.stage}:${event.status}`);
    const expected = [
      'preflight:running', 'preflight:ok',
      'account and order:running', 'account and order:ok',
      'challenge ready:running', 'challenge ready:ok',
      'waiting for validation:running', 'waiting for validation:ok',
      'certificate received:ok',
      'files written:running', 'files written:ok',
      'nginx config test:running', 'nginx config test:ok',
      'nginx reload:running', 'nginx reload:ok',
      'https verified:running', 'https verified:ok',
    ];
    check('a renewal reports the same stages, once each, in order',
      JSON.stringify(sequence) === JSON.stringify(expected), sequence.join(', '));
    check('the renewal still succeeds', result.success === true && result.nginxReloaded === true);
  }

  // ── 5. Failures carry the stage, the real error and a fix ─────────────────
  setGroup('5. Failure reporting');

  {
    const events = [];
    const acme = acmeStub(async (args) => {
      await args.challengeCreateFn({}, { token: 'tok' }, 'tok.keyauth');
      throw new Error('urn:ietf:params:acme:error:dns :: DNS problem: NXDOMAIN looking up A for broken.example.com');
    });
    const result = await issuer.issueCertificate('broken.example.com', {
      email: 'ops@example.com',
      mode: 'proxy',
      onEvent: (event) => events.push(event),
      deps: successDeps(acme),
      run: fakeRun,
    });
    const failed = events.filter((event) => event.status === 'failed');
    check('the failed stage is reported', result.success === false && result.error?.step === 'waiting for validation');
    check('the real Let\'s Encrypt text is kept', /NXDOMAIN/.test(result.error?.cause ?? ''), result.error?.cause);
    check('and a one-line fix is attached', /A record/.test(result.error?.fix ?? ''), result.error?.fix);
    check('the progress event says which stage failed',
      failed.length > 0 && failed[0].stage === 'waiting for validation'
      && /NXDOMAIN/.test(failed[0].detail ?? ''));
  }

  {
    const acme = acmeStub(async (args) => {
      await args.challengeCreateFn({}, { token: 'tok' }, 'tok.keyauth');
      throw new Error('too many certificates already issued for this name; retry after 3600');
    });
    const result = await issuer.issueCertificate('limited.example.com', {
      email: 'ops@example.com',
      mode: 'proxy',
      deps: successDeps(acme),
      run: fakeRun,
    });
    check('a rate limit names the wait time', /3600s/.test(result.error?.fix ?? ''), result.error?.fix);
    check('and explains it is rate limiting', /rate limiting/i.test(result.error?.fix ?? ''));
  }

  {
    const acme = acmeStub(async (args) => {
      await args.challengeCreateFn({}, { token: 'tok' }, 'tok.keyauth');
      return new Promise(() => {});
    });
    const result = await issuer.issueCertificate('slow.example.com', {
      email: 'ops@example.com',
      mode: 'proxy',
      timeoutMs: 40,
      deps: successDeps(acme),
      run: fakeRun,
    });
    check('the overall time is bounded', result.success === false && result.error?.step === 'timeout');
    check('the timeout names the stage that was running',
      /timed out/i.test(result.error?.cause ?? '') && /waiting for validation/.test(result.error?.cause ?? ''),
      result.error?.cause);
  }

  // ── 6. Throttling ─────────────────────────────────────────────────────────
  setGroup('6. Progress throttling');

  {
    let now = 1_000_000;
    const scheduled = [];
    const sent = [];
    const progress = progressModule.createSslProgress({
      opId: 'throttle-01',
      domain: 'throttle.example.com',
      onEvent: (event) => sent.push(event),
      now: () => now,
      schedule: (fn) => { scheduled.push(fn); return { unref() {} }; },
      cancel: () => {},
    });

    progress.report('a', 'running');
    progress.report('a', 'ok');
    progress.report('b', 'running');
    progress.report('b', 'ok');
    progress.report('c', 'running');
    progress.report('c', 'ok');
    progress.report('d', 'running');
    progress.report('d', 'failed');

    check('at most five events leave in one second', sent.length === 5, String(sent.length));
    check('the last event of each throttled stage is kept',
      progress.pendingCount() === 2);

    now += 1000;
    progress.flush();
    const last = sent.slice(-2).map((event) => `${event.stage}:${event.status}`);
    check('the held events are the newest for their stage',
      JSON.stringify(last) === JSON.stringify(['c:ok', 'd:failed']), last.join(', '));
  }

  {
    const progress = progressModule.createSslProgress({
      opId: 'throttle-02',
      domain: 'throws.example.com',
      onEvent: () => { throw new Error('listener exploded'); },
      schedule: () => ({ unref() {} }),
      cancel: () => {},
    });
    let threw = false;
    try {
      progress.report('preflight', 'running');
      progress.report('preflight', 'ok');
    } catch {
      threw = true;
    }
    check('a throwing listener never breaks the operation', threw === false);
  }

  // ── 7. opId validation ────────────────────────────────────────────────────
  setGroup('7. opId validation');

  {
    const generated = progressModule.resolveOpId(undefined);
    const valid = progressModule.resolveOpId('Abc_123-xyz');
    const invalid = progressModule.resolveOpId('no spaces allowed');
    check('an absent opId is generated server-side and matches the pattern',
      progressModule.isValidOpId(generated.opId));
    check('a valid client opId is kept', valid.opId === 'Abc_123-xyz' && valid.error === null);
    check('an invalid client opId is refused', invalid.opId === null && Boolean(invalid.error));
    check('short and overlong ids are refused',
      !progressModule.isValidOpId('short') && !progressModule.isValidOpId('x'.repeat(65)));
  }

  // ── 8. No secrets in progress events ──────────────────────────────────────
  setGroup('8. Progress carries no secrets');

  {
    const events = [];
    const acme = acmeStub(async (args) => {
      await args.challengeCreateFn({}, { token: 'tok' }, 'tok.keyauth');
      throw new Error('bad material -----BEGIN PRIVATE KEY-----\nMIIEprivateBodyThatMustNotLeave\n-----END PRIVATE KEY-----');
    });
    await issuer.issueCertificate('secret.example.com', {
      email: 'ops@example.com',
      mode: 'proxy',
      onEvent: (event) => events.push(event),
      deps: successDeps(acme),
      run: fakeRun,
    });
    const text = JSON.stringify(events);
    check('no private key block appears in any event', !text.includes('BEGIN PRIVATE KEY'));
    check('no key material body appears in any event', !text.includes('MIIEprivateBodyThatMustNotLeave'));
  }

  // ── 9. "Not issued yet" vs unreadable ─────────────────────────────────────
  setGroup('9. Certificates that do not exist yet');

  {
    const readDir = path.join(scratch, 'ssl-reader');
    fs.mkdirSync(readDir, { recursive: true });

    fs.mkdirSync(path.join(readDir, 'new.example.com'), { recursive: true });
    fs.mkdirSync(path.join(readDir, 'bad.example.com'), { recursive: true });
    fs.writeFileSync(path.join(readDir, 'bad.example.com', 'fullchain.pem'), 'not a certificate');
    writeCert(readDir, 'good.example.com', ['good.example.com'], 60);

    const certs = await reader.listAllCerts({ sslDir: readDir, includeUnusable: true });
    const of = (name) => certs.find((cert) => cert.domain === name);
    check('a directory with no certificate is "not_issued", labelled "Not issued yet"',
      of('new.example.com')?.status === 'not_issued' && of('new.example.com')?.label === 'Not issued yet');
    check('a file that exists but cannot be parsed stays "unreadable"',
      of('bad.example.com')?.status === 'unreadable');
    check('a real certificate is still valid with days left',
      of('good.example.com')?.status === 'valid' && of('good.example.com')?.daysLeft >= 59,
      JSON.stringify(of('good.example.com')));

    const state = await reader.getCertExpiry('new.example.com', { sslDir: readDir });
    check('getCertExpiry distinguishes not_issued from unreadable',
      state.state === 'not_issued'
      && (await reader.getCertExpiry('bad.example.com', { sslDir: readDir })).state === 'unreadable');
  }

  // ── 10. API failure bodies carry the per-check preflight array ─────────────
  setGroup('10. API failure bodies carry the preflight checks');

  {
    const controllerModule = await import(srcUrl('dashboard/controllers/sslController.js'));
    const domainsDb = await import(srcUrl('core/domains-db.js'));
    const controller = new controllerModule.default();

    const controllerSsl = path.join(scratch, 'ssl-controller');
    fs.mkdirSync(controllerSsl, { recursive: true });
    const previousConfig = loadConfig();
    saveConfig({
      ...previousConfig,
      sslDir: controllerSsl,
      nginxDir: path.join(scratch, 'nginx-controller'),
      acmeEmail: 'ops@example.com',
    });
    domainsDb.saveDomains([]);

    const originalDns = {
      resolve4: dnsPromises.resolve4,
      resolve6: dnsPromises.resolve6,
      resolveAny: dnsPromises.resolveAny,
    };
    const nxdomain = async () => {
      const err = new Error('queryA ENOTFOUND api-preflight.example.com');
      err.code = 'ENOTFOUND';
      throw err;
    };

    const fakeRes = () => {
      const out = { statusCode: 200, body: null };
      out.status = (code) => { out.statusCode = code; return out; };
      out.json = (body) => { out.body = body; return out; };
      return out;
    };
    const next = (err) => { throw err; };

    try {
      dnsPromises.resolve4 = nxdomain;
      dnsPromises.resolve6 = nxdomain;
      dnsPromises.resolveAny = nxdomain;

      const created = fakeRes();
      await controller.create(
        { body: { domain: 'api-preflight.example.com', validationMethod: 'http' }, params: {} },
        created,
        next,
      );
      check('an issue failure is a 500 with a preflight array',
        created.statusCode === 500 && Array.isArray(created.body?.preflight),
        `status ${created.statusCode}, ${created.body?.preflight?.length} check(s)`);
      check('each check has id, status, message and fix',
        created.body?.preflight?.every((entry) =>
          typeof entry.id === 'string' && typeof entry.status === 'string'
          && typeof entry.message === 'string' && typeof entry.fix === 'string'));
      check('the failure still carries the stage, cause and fix',
        created.body?.error?.step === 'preflight'
        && /has no DNS record/.test(created.body?.error?.cause ?? '')
        && /A record/.test(created.body?.error?.fix ?? ''));
      check('the preflight checks carry no key material',
        !JSON.stringify(created.body.preflight).includes('PRIVATE KEY'));

      writeCert(controllerSsl, 'renew-preflight.example.com', ['renew-preflight.example.com'], 5);
      const renewed = fakeRes();
      await controller.renew(
        { params: { domain: 'renew-preflight.example.com' }, body: {} },
        renewed,
        next,
      );
      check('a renew failure body carries the preflight array',
        renewed.statusCode === 500 && Array.isArray(renewed.body?.preflight)
        && renewed.body.preflight.some((entry) => entry.status === 'fail'),
        `status ${renewed.statusCode}`);

      const renewedAll = fakeRes();
      await controller.renewAll({ body: {} }, renewedAll, next);
      check('every renew-all entry carries its own preflight array',
        Array.isArray(renewedAll.body)
        && renewedAll.body.length === 1
        && Array.isArray(renewedAll.body[0].preflight)
        && renewedAll.body[0].preflight.some((entry) => entry.status === 'fail'),
        JSON.stringify(renewedAll.body?.map?.((entry) => Boolean(entry.preflight))));
    } finally {
      dnsPromises.resolve4 = originalDns.resolve4;
      dnsPromises.resolve6 = originalDns.resolve6;
      dnsPromises.resolveAny = originalDns.resolveAny;
      saveConfig(previousConfig);
      domainsDb.saveDomains([]);
    }
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
