/**
 * Link-domain parity tests: the dashboard/Hub link must offer what Add domain
 * offers, without inventing a second validator, config builder or certificate
 * path.
 *
 * Run with:  npm run test:e2e -- deploy-link-domain
 *
 * Everything that touches nginx, ACME or a certificate directory is injected.
 * The domain writer is a small in-memory stand-in that still goes through the
 * real createDomain()/saveDomains() so the stored record is the real shape.
 * No real nginx, ACME request, PM2 process or repository is touched.
 */

// MUST be the first import: the guard refuses to run unless EZ_TEST and a
// throwaway EASY_DEVOPS_DATA_DIR were set before Node started.
import './lib/guard.mjs';
import { TEST_DATA_DIR } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed: Boolean(passed), detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

/** The record fields Add domain would produce, compared without timestamps. */
function comparable(record) {
  return {
    name: record.name,
    port: record.port,
    backendHost: record.backendHost,
    upstreamType: record.upstreamType,
    www: record.www,
    wildcard: record.wildcard,
    enabled: record.enabled,
    behindCloudflare: record.behindCloudflare,
    ssl: {
      enabled: record.ssl.enabled,
      certPath: record.ssl.certPath,
      keyPath: record.ssl.keyPath,
      redirect: record.ssl.redirect,
      hsts: record.ssl.hsts,
      hstsMaxAge: record.ssl.hstsMaxAge,
    },
  };
}

async function main() {
  const db = await import(srcUrl('core/domains-db.js'));
  const apps = await import(srcUrl('core/deploy/apps.js'));
  const link = await import(srcUrl('core/deploy/domainLink.js'));
  const hub = await import(srcUrl('core/deploy/hubCommands.js'));
  const store = await import(srcUrl('core/deploy/store.js'));
  const config = await import(srcUrl('core/config.js'));
  const generator = await import(srcUrl('core/nginx-conf-generator.js'));
  const bus = await import(srcUrl('core/jobs/bus.js'));
  const deploymentsControllerModule = await import(srcUrl('dashboard/controllers/deploymentsController.js'));

  const { createDomain, saveDomains, findDomain } = db;

  /** Applies the real domain record shape, but never writes nginx. */
  function makeDomainStub() {
    const calls = [];
    return {
      calls,
      async domainCommand(payload) {
        calls.push(payload);
        if (payload.action === 'create') {
          saveDomains([...db.getDomains(), createDomain(payload.domain)]);
        } else if (payload.action === 'update') {
          const all = db.getDomains();
          const idx = all.findIndex((d) => d.name === payload.name);
          if (idx !== -1) {
            all[idx] = {
              ...all[idx],
              ...payload.domain,
              ssl: { ...all[idx].ssl, ...(payload.domain.ssl ?? {}) },
              updatedAt: new Date().toISOString(),
            };
            saveDomains(all);
          }
        }
        return { ok: true, error: null };
      },
    };
  }

  const noNginx = { reload: async () => ({ ok: true, output: '' }) };

  const certFor = (domain, names, { certPath, keyPath } = {}) => ({
    found: true,
    match: 'exact',
    certificate: {
      domain,
      names,
      certPath: certPath ?? `/srv/ssl/${domain}/fullchain.pem`,
      keyPath: keyPath ?? `/srv/ssl/${domain}/privkey.pem`,
      expiry: null,
      daysLeft: 90,
      status: 'valid',
    },
  });

  apps.createApp({ id: 'linked', repoUrl: 'https://github.com/me/linked.git', settings: { port: 4100 } });

  // ── 1. www + redirect + Cloudflare are the Add-domain record ───────────────
  setGroup('Same domain record as Add domain');
  {
    saveDomains([]);
    const domain = makeDomainStub();
    const certificate = certFor('shop.example.com', ['shop.example.com', 'www.shop.example.com']);
    const result = await link.linkDomain('linked', {
      domain: 'shop.example.com',
      www: true,
      ssl: { mode: 'existing', certName: 'shop.example.com' },
      behindCloudflare: true,
      // The caller's paths must never be used.
      certPath: '/forged/fullchain.pem',
      keyPath: '/forged/privkey.pem',
    }, {
      ...noNginx,
      ...domain,
      suggest: async (name) => (name === 'shop.example.com' || name === 'www.shop.example.com'
        ? certificate
        : { found: false }),
    });

    const stored = findDomain('shop.example.com');
    const expected = createDomain({
      name: 'shop.example.com',
      port: 4100,
      backendHost: '127.0.0.1',
      www: true,
      behindCloudflare: true,
      ssl: {
        enabled: true,
        certPath: certificate.certificate.certPath,
        keyPath: certificate.certificate.keyPath,
        redirect: true,
      },
    });

    check('the link succeeds and reports the requested fields',
      result.ok && result.www === true && result.behindCloudflare === true && result.redirect === true);
    check('www, Cloudflare and redirect are stored exactly as Add domain stores them',
      JSON.stringify(comparable(stored)) === JSON.stringify(comparable(expected)),
      JSON.stringify(comparable(stored)));
    check('the certificate paths come from the suggestion, never the caller',
      stored.ssl.certPath === certificate.certificate.certPath
      && stored.ssl.keyPath === certificate.certificate.keyPath);
    check('the generator output is identical to the Add-domain record',
      generator.buildConf(stored, '/etc/nginx', '/srv/ssl')
      === generator.buildConf(expected, '/etc/nginx', '/srv/ssl'));
  }

  // ── 2. An existing certificate is accepted only when suggested ──────────────
  setGroup('Existing certificate is server-suggested only');
  {
    saveDomains([]);
    const domain = makeDomainStub();
    const cert = certFor('api.example.com', ['api.example.com']);

    const forged = await link.linkDomain('linked', {
      domain: 'api.example.com',
      ssl: { mode: 'existing', certName: 'forged.example.com' },
    }, { ...noNginx, ...domain, suggest: async () => cert });
    check('a forged certName is refused before anything is written',
      forged.status === 400 && /not a certificate the server suggests/.test(forged.error)
      && domain.calls.length === 0);

    const wrong = await link.linkDomain('linked', {
      domain: 'api.example.com',
      ssl: { mode: 'existing', certName: 'other.example.com' },
    }, {
      ...noNginx,
      ...domain,
      suggest: async () => certFor('other.example.com', ['other.example.com']),
    });
    check('a certificate that does not cover the name is refused',
      wrong.status === 400 && domain.calls.length === 0);

    const wildcard = await link.linkDomain('linked', {
      domain: 'api.example.com',
      ssl: { mode: 'existing', certName: '*.example.com', certPath: '/forged', keyPath: '/forged' },
    }, {
      ...noNginx,
      ...domain,
      suggest: async () => certFor('*.example.com', ['*.example.com'], {
        certPath: '/srv/ssl/wild/fullchain.pem',
        keyPath: '/srv/ssl/wild/privkey.pem',
      }),
    });
    const stored = findDomain('api.example.com');
    check('a wildcard certificate is accepted for a one-label subdomain',
      wildcard.ok && wildcard.ssl?.mode === 'existing' && wildcard.ssl.ok === true);
    check('and its paths are the suggested ones, not the forged input',
      stored.ssl.certPath === '/srv/ssl/wild/fullchain.pem'
      && stored.ssl.keyPath === '/srv/ssl/wild/privkey.pem');
  }

  // ── 3. Issue mode: no ACME email, failure keeps HTTP, wildcard refused ─────
  setGroup('Issue mode');
  {
    saveDomains([]);
    const domain = makeDomainStub();
    config.saveConfig({ ...config.loadConfig(), acmeEmail: '' });

    const noEmail = await link.linkDomain('linked', {
      domain: 'no-email.example.com',
      ssl: { mode: 'issue' },
    }, {
      ...noNginx,
      ...domain,
      prepare: async () => ({ ok: true }),
      issue: async () => { throw new Error('must not be called without an email'); },
    });
    check('without an ACME email the link stands over HTTP and says what to set',
      noEmail.ok && noEmail.ssl.mode === 'issue' && noEmail.ssl.ok === false
      && /ACME email/.test(noEmail.ssl.detail)
      && findDomain('no-email.example.com').ssl.enabled === false);

    config.saveConfig({ ...config.loadConfig(), acmeEmail: 'ops@example.com' });
    const issueCalls = [];
    const failed = await link.linkDomain('linked', {
      domain: 'pending.example.com',
      ssl: { mode: 'issue' },
    }, {
      ...noNginx,
      ...domain,
      prepare: async () => ({ ok: true }),
      issue: async (name, options) => {
        issueCalls.push({ name, options });
        return { success: false, error: { cause: 'DNS problem: NXDOMAIN\nsecond line' } };
      },
    });
    check('a failed issuance keeps the HTTP link and reports the cause',
      failed.ok && failed.ssl.mode === 'issue' && failed.ssl.ok === false
      && /NXDOMAIN/.test(failed.ssl.detail) && !/second line/.test(failed.ssl.detail)
      && findDomain('pending.example.com').ssl.enabled === false
      && apps.getApp('linked').domain === 'pending.example.com');

    const wildcard = await link.linkDomain('linked', {
      domain: '*.wild.example.com',
      ssl: { mode: 'issue' },
    }, { ...noNginx, ...domain });
    check('a new wildcard certificate is refused with the next step',
      wildcard.status === 400 && wildcard.error === link.WILDCARD_ISSUE_ERROR
      && /Issue it from the SSL page/.test(wildcard.error));

    // ── 4. Legacy ssl: true is the issue form, and www reaches issuance ─────
    setGroup('Legacy ssl: true');
    const legacyDomain = makeDomainStub();
    const issued = await link.linkDomain('linked', {
      domain: 'legacy.example.com',
      www: true,
      ssl: true,
    }, {
      ...noNginx,
      ...legacyDomain,
      prepare: async () => ({ ok: true }),
      issue: async (name, options) => {
        issueCalls.push({ name, options });
        return {
          success: true,
          certPath: '/srv/ssl/legacy/fullchain.pem',
          keyPath: '/srv/ssl/legacy/privkey.pem',
          mode: 'proxy',
        };
      },
    });
    const legacyRecord = findDomain('legacy.example.com');
    check('legacy ssl:true requests a certificate and switches the domain to HTTPS',
      issued.ok && issued.ssl.mode === 'issue' && issued.ssl.ok === true
      && legacyRecord.ssl.enabled === true && legacyRecord.ssl.redirect === true);
    check('www is passed to issuance, mirroring Add domain',
      issueCalls.at(-1).name === 'legacy.example.com'
      && issueCalls.at(-1).options.validationMethod === 'http'
      && issueCalls.at(-1).options.www === true);
    check('the default redirect is true whenever SSL is not "none"',
      issued.redirect === true);
  }

  // ── 4b. Live progress: the steps a long link reports, in order ──────────
  setGroup('Live progress for linkDomain');
  {
    const recorder = () => {
      const events = [];
      return {
        events,
        onProgress: (step, status, detail) => events.push({ step, status, detail }),
      };
    };
    const sequence = (r) => r.events.map((e) => `${e.step}:${e.status}`);
    const verifyOk = async () => ({ ok: true, message: 'ok' });

    /** The stages the real issuer reports through the link's onProgress hook. */
    const emitIssueStages = (onProgress, { fail = false } = {}) => {
      if (typeof onProgress !== 'function') return;
      for (const stage of ['preflight', 'account and order', 'challenge ready']) {
        onProgress(stage, 'running');
        onProgress(stage, 'ok');
      }
      onProgress('waiting for validation', 'running');
      if (fail) {
        onProgress('waiting for validation', 'failed', 'DNS problem: NXDOMAIN');
        return;
      }
      onProgress('waiting for validation', 'ok');
      onProgress('certificate received', 'ok');
      onProgress('files written', 'running');
      onProgress('files written', 'ok');
    };

    config.saveConfig({ ...config.loadConfig(), acmeEmail: 'ops@example.com' });

    saveDomains([]);
    const issueDomain = makeDomainStub();
    const issueProgress = recorder();
    const issued = await link.linkDomain('linked', {
      domain: 'progress.example.com',
      ssl: { mode: 'issue' },
    }, {
      ...noNginx,
      ...issueDomain,
      verify: verifyOk,
      prepare: async () => ({ ok: true }),
      issue: async (name, options) => {
        emitIssueStages(options.onProgress);
        return {
          success: true,
          certPath: '/srv/ssl/progress/fullchain.pem',
          keyPath: '/srv/ssl/progress/privkey.pem',
          mode: 'proxy',
        };
      },
      onProgress: issueProgress.onProgress,
    });
    check('an issuing link reports domain, every certificate stage, https and the nginx stages',
      JSON.stringify(sequence(issueProgress))
        === JSON.stringify([
          'domain:running', 'domain:ok',
          'preflight:running', 'preflight:ok',
          'account and order:running', 'account and order:ok',
          'challenge ready:running', 'challenge ready:ok',
          'waiting for validation:running', 'waiting for validation:ok',
          'certificate received:ok',
          'files written:running', 'files written:ok',
          'https:running', 'https:ok',
          'nginx config test:running', 'nginx config test:ok',
          'nginx reload:running', 'nginx reload:ok',
          'https verified:running', 'https verified:ok',
        ]), sequence(issueProgress).join(', '));
    check('the certificate stages come from the issuer, not the link',
      issueProgress.events.some((e) => e.step === 'waiting for validation' && e.status === 'running'));
    check('the final result is unchanged by progress reporting',
      issued.ok === true && issued.ssl?.ok === true && issued.nginxReloaded === true);

    saveDomains([]);
    const failDomain = makeDomainStub();
    const failProgress = recorder();
    const failedIssue = await link.linkDomain('linked', {
      domain: 'progress-fail.example.com',
      ssl: { mode: 'issue' },
    }, {
      ...noNginx,
      ...failDomain,
      prepare: async () => ({ ok: true }),
      issue: async (name, options) => {
        emitIssueStages(options.onProgress, { fail: true });
        return { success: false, error: { cause: 'DNS problem: NXDOMAIN' } };
      },
      onProgress: failProgress.onProgress,
    });
    check('an issue failure reports the failed stage, https skipped and the reload',
      JSON.stringify(sequence(failProgress))
        === JSON.stringify([
          'domain:running', 'domain:ok',
          'preflight:running', 'preflight:ok',
          'account and order:running', 'account and order:ok',
          'challenge ready:running', 'challenge ready:ok',
          'waiting for validation:running', 'waiting for validation:failed',
          'https:skipped',
          'nginx config test:running', 'nginx config test:ok',
          'nginx reload:running', 'nginx reload:ok',
          'https verified:skipped',
        ]), sequence(failProgress).join(', '));
    check('and the link still stands over HTTP with the same result shape',
      failedIssue.ok === true && failedIssue.ssl?.ok === false
      && findDomain('progress-fail.example.com').ssl.enabled === false);

    saveDomains([]);
    const noneDomain = makeDomainStub();
    const noneProgress = recorder();
    const noSsl = await link.linkDomain('linked', {
      domain: 'progress-none.example.com',
      ssl: { mode: 'none' },
    }, {
      ...noNginx,
      ...noneDomain,
      onProgress: noneProgress.onProgress,
    });
    check('ssl none reports https skipped and still applies the nginx stages',
      JSON.stringify(sequence(noneProgress))
        === JSON.stringify([
          'domain:running', 'domain:ok',
          'https:skipped',
          'nginx config test:running', 'nginx config test:ok',
          'nginx reload:running', 'nginx reload:ok',
          'https verified:skipped',
        ]), sequence(noneProgress).join(', '));
    check('and still links successfully', noSsl.ok === true && noSsl.ssl === null);

    saveDomains([]);
    const noHookDomain = makeDomainStub();
    const noHook = await link.linkDomain('linked', {
      domain: 'progress-nohook.example.com',
      ssl: { mode: 'none' },
    }, { ...noNginx, ...noHookDomain });
    check('without onProgress the command works exactly as before',
      noHook.ok === true && findDomain('progress-nohook.example.com').port === 4100);
  }

  // ── 4c. Dashboard link-domain publishes ssl:progress with its opId ───────
  setGroup('Dashboard linkDomain publishes ssl:progress');
  {
    const previous = config.loadConfig();
    const blockerRoot = path.join(TEST_DATA_DIR, 'scratch', 'link-progress-blocker');
    fs.mkdirSync(blockerRoot, { recursive: true });
    const blocker = path.join(blockerRoot, 'not-a-directory');
    fs.writeFileSync(blocker, 'not a directory', 'utf8');

    config.saveConfig({
      ...previous,
      nginxDir: path.join(blocker, 'nginx'),
      sslDir: path.join(blockerRoot, 'ssl'),
      acmeEmail: 'ops@example.com',
    });
    saveDomains([]);
    apps.createApp({ id: 'link-progress', repoUrl: 'https://github.com/me/link-progress.git', settings: { port: 4102 } });

    const frames = [];
    const off = bus.subscribe('ssl:progress', (event) => frames.push(event));
    const controller = new deploymentsControllerModule.default();
    const fakeRes = () => {
      const out = { statusCode: 200, body: null };
      out.status = (code) => { out.statusCode = code; return out; };
      out.json = (body) => { out.body = body; return out; };
      return out;
    };
    const next = (err) => { throw err; };

    try {
      const res = fakeRes();
      await controller.linkDomain({
        params: { id: 'link-progress' },
        body: {
          domain: 'link-progress.example.com',
          ssl: { mode: 'none' },
          opId: 'link-op-12345',
        },
      }, res, next);

      check('the link response carries the client opId', res.body?.opId === 'link-op-12345');
      check('the link publishes ssl:progress frames', frames.length > 0, `${frames.length} frame(s)`);
      check('every frame carries the opId and the linked domain',
        frames.every((event) => event.opId === 'link-op-12345'
          && event.domain === 'link-progress.example.com'));
      check('the domain stage is reported running and then failed',
        frames.some((event) => event.stage === 'domain' && event.status === 'running')
        && frames.some((event) => event.stage === 'domain' && event.status === 'failed'));
      check('every frame has elapsedMs and an ISO timestamp',
        frames.every((event) => typeof event.elapsedMs === 'number'
          && typeof event.at === 'string' && !Number.isNaN(Date.parse(event.at))));
      check('a link without a client opId still returns one, generated server-side',
        /^[A-Za-z0-9_-]{8,64}$/.test((await controller.linkDomain({
          params: { id: 'link-progress' },
          body: { domain: 'link-progress-no-id.example.com', ssl: { mode: 'none' } },
        }, fakeRes(), next)).body?.opId ?? ''));

      const invalid = fakeRes();
      await controller.linkDomain({
        params: { id: 'link-progress' },
        body: { domain: 'link-progress.example.com', opId: 'not valid' },
      }, invalid, next);
      check('an invalid opId is refused before anything is written',
        invalid.statusCode === 400 && invalid.body?.error === 'invalid_opId');
    } finally {
      off();
      config.saveConfig(previous);
      saveDomains([]);
    }
  }

  // ── 5. hub:manageDeploy run redacts the log the same way ---------------
  setGroup('Hub run log filtering');
  {
    apps.createApp({
      id: 'logapp',
      repoUrl: 'https://github.com/me/logapp.git',
      settings: { port: 4101 },
      env: { API_KEY: 'super-secret-value' },
    });
    const runId = '20260101-120000-abcdef';
    const run = {
      id: runId,
      appId: 'logapp',
      status: 'success',
      step: 'done',
      startedAt: '2026-01-01T12:00:00.000Z',
      finishedAt: '2026-01-01T12:01:00.000Z',
      logTail: [],
    };
    store.writeRun(run, TEST_DATA_DIR);
    fs.writeFileSync(
      store.logFile('logapp', runId, TEST_DATA_DIR),
      [
        'installing dependencies',
        'API_KEY=super-secret-value',
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEprivateBodyThatMustNotLeave',
        '-----END RSA PRIVATE KEY-----',
        'done',
      ].join('\n'),
      'utf8'
    );

    const answer = await hub.handleHubDeployCommand({ action: 'run', id: 'logapp', runId });
    check('the environment value becomes ***',
      answer.log.includes('API_KEY=***') && !answer.log.includes('super-secret-value'));
    check('the whole PEM private-key block is absent, not just its markers',
      !answer.log.includes('BEGIN RSA PRIVATE KEY')
      && !answer.log.includes('MIIEprivateBodyThatMustNotLeave')
      && !answer.log.includes('END RSA PRIVATE KEY'));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  saveDomains([]);
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
