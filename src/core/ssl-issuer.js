/**
 * core/ssl-issuer.js
 *
 * The one place certificates are issued. The CLI, the dashboard API and the
 * Hub command path all call issueCertificate(), so the challenge strategy,
 * the preflight gate and the nginx-state guarantees cannot drift apart.
 *
 * Proxy mode (the default) keeps nginx running: each port-80 server block
 * proxies /.well-known/acme-challenge/ to a loopback listener this process
 * starts for the duration of the issuance. Only a graceful reload is used.
 *
 * Standalone mode is the fallback for machines where nginx is not installed
 * or not running. It stops nginx, and a finally block always restores nginx
 * to the state it was found in.
 *
 * The choice between them is made from a LOCAL preflight only, never from a
 * Let's Encrypt failure, so a misconfiguration cannot burn rate limits.
 */

import fs from 'fs/promises';
import path from 'path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import * as acme from 'acme-client';

import { loadConfig } from './config.js';
import { runPreflight, summarizePreflight, fixForAcmeError } from './ssl/preflight.js';
import {
  createSslProgress,
  isValidOpId,
  newOpId,
  sanitizeDetail,
} from './ssl/progress.js';
import { run as defaultRun } from './shell.js';
import {
  isDevDataDir,
  getDataDir,
  nginxServiceStartCmd,
  nginxServiceStopCmd,
  nginxServiceReloadCmd,
  nginxIsRunningCmd,
  isNginxRunning,
  nginxTestCmd,
  isNginxTestOk,
  combineOutput,
} from './platform.js';
import {
  getConfDDir,
  hasChallengeLocation,
  DEFAULT_ACME_CHALLENGE_PORT,
} from './nginx-conf-generator.js';
import { protectKeyDirectory, loadAccountKey } from './ssl/private-keys.js';
import { recordManagedArtifacts } from './ssl/managed-artifacts.js';
import { publishCertificateFiles } from './ssl/certificate-transaction.js';
import { withChallengeServer } from './acme-challenge.js';
import {
  acquireArtifactLock,
  SSL_ARTIFACT_LIFECYCLE_LOCK,
} from './ssl/artifact-lock.js';

/**
 * Written next to fullchain.pem after every successful issuance. It records
 * HOW the certificate was obtained, which the certificate itself cannot say:
 * a single-name certificate validated over DNS-01 looks exactly like one
 * validated over HTTP-01. core/cert-renewal.js reads it to decide whether a
 * certificate can be renewed unattended.
 */
export const CERT_META_FILE = 'ez-cert.json';

export const CHALLENGE_MODES = Object.freeze({
  AUTO: 'auto',
  PROXY: 'proxy',
  STANDALONE: 'standalone',
});

/**
 * One-line human summary of how an issuance went, for the CLI, the dashboard
 * toast and the Hub command result — so all three report the same thing.
 *
 * @param {Object} result Value returned by issueCertificate()
 * @returns {string}
 */
export function describeIssuance(result) {
  if (!result) return '';

  const parts = [];
  if (result.staging) parts.push('Let\'s Encrypt STAGING (not a trusted certificate)');

  if (result.mode === CHALLENGE_MODES.PROXY) {
    parts.push('nginx kept running (proxy challenge)');
  } else if (result.mode === CHALLENGE_MODES.STANDALONE) {
    const secs = (result.nginxDownMs / 1000).toFixed(1);
    parts.push(
      result.fellBack
        ? `fell back to standalone — nginx was stopped for ${secs}s`
        : `standalone mode — nginx was stopped for ${secs}s`
    );
    if (result.nginxRestored === false) parts.push('nginx did NOT come back up');
  } else if (result.mode === 'dns-01') {
    parts.push('DNS-01 challenge (nginx untouched)');
  }

  if (result.configRegenerated) parts.push('the nginx config was regenerated to add the challenge location');

  return parts.join('; ');
}

/** ACME directory for the configured environment. */
function directoryUrl(staging, acmeLib = acme) {
  return staging ? acmeLib.directory.letsencrypt.staging : acmeLib.directory.letsencrypt.production;
}

/**
 * Staging is used when explicitly enabled, and always in dev data mode, so
 * development and testing can never consume production rate limits.
 *
 * Exported so the decision can be asserted directly. That matters more than it
 * looks: `isDevDataDir()` used to be true whenever `EASY_DEVOPS_DATA_DIR` was
 * set, and every installed service sets it — so a real install silently issued
 * **staging certificates**, which browsers reject, on the user's real domains.
 * A test that pins "service data directory ⇒ production ACME" is the guard
 * against that coming back.
 *
 * @param {Object} config
 * @param {boolean} [override]
 * @returns {boolean}
 */
export function useStaging(config, override) {
  if (typeof override === 'boolean') return override;
  if (isDevDataDir()) return true;
  return Boolean(config.acmeStaging);
}

async function nginxRunning(run) {
  try {
    return isNginxRunning(await run(nginxIsRunningCmd()));
  } catch {
    return false;
  }
}

/** Reads the current config file for a domain, or null when absent. */
async function readDomainConf(nginxDir, domainName) {
  const confPath = path.join(getConfDDir(nginxDir), `${domainName}.conf`);
  try {
    return { confPath, text: await fs.readFile(confPath, 'utf8') };
  } catch {
    return { confPath, text: null };
  }
}

/**
 * Graceful reload. Never stops nginx; validity is checked with isNginxTestOk().
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function reloadNginx(run = defaultRun) {
  const { nginxDir } = loadConfig();

  const testResult = await run(nginxTestCmd(nginxDir), { cwd: nginxDir });
  if (!isNginxTestOk(testResult)) {
    return { ok: false, output: combineOutput(testResult) };
  }

  const result = await run(nginxServiceReloadCmd(nginxDir), { cwd: nginxDir });
  return { ok: result.success, output: combineOutput(result) };
}

/**
 * Ensures the certificate directory exists.
 *
 * No sudo: the directory is created and handed to this account ONCE by the
 * setup script in core/permissions.js (`Settings -> Linux permissions`), so
 * there is no standing grant for mkdir or chown to abuse. If the directory
 * was never handed over, the failure names that setup rather than looking
 * like an unexplained issuance error.
 *
 * @param {string} sslDir
 * @param {string} domainName
 */
async function ensureCertDir(sslDir, domainName) {
  try {
    await protectKeyDirectory(sslDir, domainName);
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      throw new Error(
        `Cannot create the certificate directory ${path.join(sslDir, domainName)}: permission denied. `
        + 'Run the one-time setup from a terminal so this account owns it '
        + '(dashboard: Settings -> Linux permissions; CLI: Settings -> Linux Permissions), '
        + 'then try again.',
      );
    }
    throw err;
  }
}

async function pathIsPresentNoFollow(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function buildError(step, cause, consequence, extra = {}) {
  return { step, cause, consequence, ...extra };
}

/**
 * Makes sure nginx can answer an HTTP-01 challenge for a domain before any
 * certificate is requested.
 *
 * Covers both flows:
 *  - new domain: no config exists yet, so an HTTP-only one is written first
 *    (there is no certificate to reference yet, so a 443 block would fail
 *    `nginx -t`)
 *  - existing domain whose config predates this feature and therefore has no
 *    challenge location: it is regenerated
 *
 * In both cases the config is written through writeConfWithTest(), so a bad
 * config is rolled back, and nginx is only ever reloaded — never stopped.
 *
 * @param {Object} domain Domain object (v2 schema)
 * @param {Function} [run] Injected shell runner (testing only)
 * @returns {Promise<{ ok: boolean, regenerated: boolean, reason: string, error: string|null }>}
 */
export async function prepareDomainForHttpChallenge(domain, run = defaultRun) {
  const { nginxDir } = loadConfig();
  const { confPath, text } = await readDomainConf(nginxDir, domain.name);

  const missing = text === null;
  const stale = text !== null && !hasChallengeLocation(text);

  if (!missing && !stale) {
    return { ok: true, regenerated: false, reason: 'config already serves the challenge', error: null };
  }

  // Write an HTTP-only variant: at this point the certificate may not exist,
  // and a 443 block pointing at a missing certificate fails nginx -t.
  const httpOnly = { ...domain, ssl: { ...(domain.ssl ?? {}), enabled: false } };

  const { writeConfWithTest } = await import('./nginx-apply.js');
  const applied = await writeConfWithTest(httpOnly);

  if (!applied.ok) {
    return {
      ok: false,
      regenerated: false,
      reason: missing ? 'no config existed' : 'config had no challenge location',
      error: applied.error ?? `nginx rejected the temporary HTTP config for ${domain.name}`,
    };
  }

  const reloaded = await reloadNginx(run);
  if (!reloaded.ok) {
    return {
      ok: false,
      regenerated: true,
      reason: 'config written but nginx reload failed',
      error: reloaded.output,
    };
  }

  return {
    ok: true,
    regenerated: true,
    reason: missing
      ? `wrote a temporary HTTP-only config for ${domain.name} (${confPath})`
      : `regenerated ${confPath} to add the ACME challenge location`,
    error: null,
  };
}

/** The whole operation is bounded, so a stuck ACME server cannot hang a job. */
export const ISSUANCE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The stages every certificate operation reports, in order. Exported so the
 * tests and the documentation cannot drift from the implementation.
 */
export const ISSUANCE_STAGES = Object.freeze([
  'preflight',
  'account and order',
  'challenge ready',
  'waiting for validation',
  'certificate received',
  'files written',
  'nginx config test',
  'nginx reload',
  'https verified',
]);

function firstLine(value) {
  return String(value ?? '').split('\n')[0].trim();
}

function timeoutError(ms, stage) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const err = new Error(`The certificate operation timed out after ${seconds}s while ${stage}.`);
  err.code = 'EZ_TIMEOUT';
  err.stage = stage;
  return err;
}

/**
 * Rejects if `promise` does not settle in time. The stage may be a function so
 * the message names the stage that was actually running when the clock ran out.
 */
function withTimeout(promise, ms, stage) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  const stageName = () => (typeof stage === 'function' ? stage() : stage);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(timeoutError(ms, stageName()));
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** A one-second-granularity "still waiting" heartbeat, throttled downstream. */
function startValidationHeartbeat(report) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    report(
      'waiting for validation',
      'running',
      `Waiting for Let's Encrypt validation (${seconds}s)`,
    );
  }, 2000);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stopHeartbeat(timer) {
  if (timer) clearInterval(timer);
}

/**
 * Compares the certificate nginx serves with the file just written.
 *
 * A missing file, a refused connection or a timeout is reported as a skipped
 * check rather than a failed issuance: the certificate exists either way.
 *
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function verifyServedCertificate(domainName, certPath, { timeoutMs = 5000, deps = {} } = {}) {
  const readFile = deps.readFile ?? fs.readFile;
  const connect = deps.tlsConnect ?? tls.connect;

  try {
    const localPem = deps.localCertificate ?? await readFile(certPath, 'utf8');
    const local = new X509Certificate(localPem);
    const expected = local.fingerprint256.replace(/:/g, '').toLowerCase();

    const peer = await new Promise((resolve, reject) => {
      let settled = false;
      const socket = connect({
        host: deps.host ?? domainName,
        port: deps.port ?? 443,
        servername: domainName,
        timeout: timeoutMs,
        rejectUnauthorized: false,
      });
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* already gone */ }
        if (err) reject(err);
        else resolve(value);
      };
      socket.once('secureConnect', () => finish(null, socket.getPeerCertificate(true)));
      socket.once('timeout', () => finish(new Error('timed out')));
      socket.once('error', (err) => finish(err));
    });

    if (!peer?.raw) return { ok: false, message: 'the server did not present a certificate' };
    const served = new X509Certificate(peer.raw);
    const actual = served.fingerprint256.replace(/:/g, '').toLowerCase();
    if (actual !== expected) {
      return {
        ok: false,
        message: 'the server is not serving the new certificate yet (nginx may not have reloaded)',
      };
    }
    return { ok: true, message: 'the server is serving the new certificate' };
  } catch (err) {
    return { ok: false, message: `could not verify HTTPS: ${firstLine(err.message)}` };
  }
}

/**
 * The stages after the certificate files exist: test, reload, and verify.
 * Failures here are reported but do not turn a certificate that was issued
 * into "no certificate": the files are already on disk for the next retry.
 */
async function applyNginxAndVerify({
  report, run, domainName, certPath, mode, preflightInfo, behindCloudflare,
  manageNginx, remaining, deps,
}) {
  let nginxReloaded = null;
  let httpsVerified = null;

  if (mode === 'dns-01') {
    report('nginx config test', 'skipped', 'DNS-01 leaves nginx untouched');
    report('nginx reload', 'skipped', 'DNS-01 leaves nginx untouched');
  } else if (manageNginx) {
    report('nginx config test', 'running');

    let reloaded;
    try {
      reloaded = await withTimeout(reloadNginx(run), remaining(), 'nginx reload');
    } catch (err) {
      reloaded = { ok: false, output: err.message };
    }

    const detail = reloaded.ok ? undefined : firstLine(reloaded.output) || 'nginx did not reload';
    report('nginx config test', reloaded.ok ? 'ok' : 'failed', detail);
    report('nginx reload', 'running');
    report('nginx reload', reloaded.ok ? 'ok' : 'failed', detail);
    nginxReloaded = Boolean(reloaded.ok);
  }

  const proxied = Boolean(behindCloudflare || preflightInfo?.proxied);
  if (proxied) {
    report('https verified', 'skipped', "served by Cloudflare's edge");
  } else if (!certPath) {
    report('https verified', 'skipped', 'no certificate file to compare');
  } else {
    report('https verified', 'running');
    let verified;
    try {
      const verify = deps.verifyHttps ?? verifyServedCertificate;
      verified = await withTimeout(
        verify(domainName, certPath, deps.https ?? {}),
        remaining(),
        'https verified',
      );
    } catch (err) {
      verified = { ok: false, message: firstLine(err.message) };
    }
    httpsVerified = Boolean(verified?.ok);
    report('https verified', verified?.ok ? 'ok' : 'failed', verified?.ok ? undefined : verified?.message);
  }

  return { nginxReloaded, httpsVerified };
}

/**
 * Issues or renews a certificate.
 *
 * @param {string} domainName
 * @param {Object} [options]
 * @param {boolean} [options.www]
 * @param {boolean} [options.wildcard]
 * @param {'http'|'dns'} [options.validationMethod]
 * @param {string|null} [options.email]
 * @param {Function|null} [options.onDnsChallenge]
 * @param {'auto'|'proxy'|'standalone'} [options.mode] Overrides sslChallengeMode
 * @param {boolean} [options.staging] Overrides the staging setting
 * @param {Function} [options.run] Injected shell runner (testing only)
 * @param {string} [options.opId] Client operation id (validated, generated when absent)
 * @param {(event: Object) => void} [options.onEvent] Full progress payload
 * @param {(stage: string, status: string, detail?: string) => void} [options.onProgress]
 * @param {boolean} [options.manageNginx] Run the test/reload/verify stages here
 * @param {number} [options.timeoutMs] Overall bound (testing only)
 * @param {Object} [options.deps] Injected collaborators (testing only)
 * @returns {Promise<{
 *   success: boolean,
 *   opId: string,
 *   certPath: string|null,
 *   keyPath: string|null,
 *   mode: string|null,
 *   fellBack: boolean,
 *   nginxDownMs: number,
 *   staging: boolean,
 *   preflight: { ok: boolean, detail: string, results?: Array<Object>, proxied?: boolean }|null,
 *   configRegenerated: boolean,
 *   nginxReloaded: boolean|null,
 *   httpsVerified: boolean|null,
 *   error: object|null
 * }>}
 */
export async function issueCertificate(domainName, options = {}) {
  const lifecycle = await acquireArtifactLock({
    dataDir: getDataDir(),
    key: SSL_ARTIFACT_LIFECYCLE_LOCK,
    timeoutMs: 6 * 60_000,
  });
  try {
    return await issueCertificateLocked(domainName, options);
  } finally {
    lifecycle.release();
  }
}

async function issueCertificateLocked(domainName, options = {}) {
  const {
    www = false,
    wildcard = false,
    validationMethod = 'http',
    email = null,
    onDnsChallenge = null,
    mode: modeOverride = null,
    staging: stagingOverride,
    run = defaultRun,
    opId: rawOpId = null,
    onEvent = null,
    onProgress = null,
    manageNginx = true,
    timeoutMs = ISSUANCE_TIMEOUT_MS,
    deps = {},
  } = options;

  const acmeLib = deps.acme ?? acme;
  const preflightFn = deps.preflight ?? runPreflight;
  const challengeServer = deps.withChallengeServer ?? withChallengeServer;
  const recordArtifacts = deps.recordManagedArtifacts ?? recordManagedArtifacts;
  const now = deps.now ?? Date.now;
  const opId = isValidOpId(rawOpId) ? rawOpId : newOpId();
  const progress = createSslProgress({
    opId, domain: domainName, onEvent, onProgress, now,
    ...(deps.progress ?? {}),
  });

  const startedAt = now();
  const deadlineAt = Number.isFinite(timeoutMs) && timeoutMs > 0 ? startedAt + timeoutMs : Infinity;
  const remaining = () => (deadlineAt === Infinity ? Infinity : Math.max(1, deadlineAt - now()));

  let currentStage = 'preflight';
  const report = (stage, status, detail) => {
    currentStage = stage;
    progress.report(stage, status, detail);
  };

  const config = loadConfig();
  const sslDir = config.sslDir;
  const nginxDir = config.nginxDir;
  const certDir = path.join(sslDir, domainName);
  const challengePort = Number(config.acmeChallengePort) || DEFAULT_ACME_CHALLENGE_PORT;
  const staging = useStaging(config, stagingOverride);

  const base = {
    success: false,
    opId,
    domain: domainName,
    certPath: null,
    keyPath: null,
    mode: null,
    fellBack: false,
    nginxDownMs: 0,
    staging,
    preflight: null,
    configRegenerated: false,
    nginxReloaded: null,
    httpsVerified: null,
    error: null,
  };

  const fail = (stage, err, consequence, extra = {}) => {
    const cause = sanitizeDetail(err?.message || String(err ?? 'Certificate request failed.'));
    return {
      ...base,
      ...extra,
      error: buildError(stage, cause, consequence, {
        stage,
        fix: fixForAcmeError(cause, domainName),
        nginxRunning: true,
        configSaved: false,
        ...extra,
      }),
    };
  };

  const acmeEmail = email || config.acmeEmail;
  if (!acmeEmail) {
    return {
      ...base,
      error: buildError(
        'email configuration',
        "No email address configured. Let's Encrypt requires an email for account creation.",
        'No certificate was issued. Set acmeEmail in Settings or pass an email.',
        { nginxRunning: true, configSaved: false }
      ),
    };
  }

  if (wildcard && validationMethod === 'http') {
    return {
      ...base,
      error: buildError(
        'validation method',
        'Wildcard certificates require DNS-01 validation, not HTTP-01.',
        'No certificate was issued. Use the DNS validation method.',
        { nginxRunning: true, configSaved: false }
      ),
    };
  }

  // ─── Preflight: nothing below this may run if a check fails ────────────────
  let nginxUp = false;
  if (validationMethod !== 'dns') {
    try { nginxUp = await nginxRunning(run); } catch { nginxUp = false; }
  }
  const requestedMode = modeOverride || config.sslChallengeMode || CHALLENGE_MODES.AUTO;
  const wantProxy = validationMethod !== 'dns'
    && (requestedMode === CHALLENGE_MODES.PROXY
      || (requestedMode === CHALLENGE_MODES.AUTO && nginxUp));
  const preflightMode = validationMethod === 'dns'
    ? 'dns'
    : (wantProxy ? CHALLENGE_MODES.PROXY : CHALLENGE_MODES.STANDALONE);

  report('preflight', 'running', 'Checking DNS and port 80');

  let pre;
  try {
    pre = await withTimeout(
      preflightFn(domainName, {
        www: Boolean(www),
        validationMethod,
        mode: preflightMode,
        challengePort,
        deps: deps.preflightDeps ?? {},
      }),
      remaining(),
      'preflight',
    );
  } catch (err) {
    report('preflight', 'failed', firstLine(err.message));
    return {
      ...base,
      mode: validationMethod === 'dns' ? 'dns-01' : preflightMode,
      preflight: { ok: false, detail: firstLine(err.message), results: [] },
      error: buildError('preflight', err.message, "No certificate was requested, so Let's Encrypt rate limits are untouched.", {
        stage: 'preflight',
        fix: fixForAcmeError(err.message, domainName),
        nginxRunning: true,
        configSaved: false,
      }),
    };
  }

  const preflightInfo = {
    ok: Boolean(pre?.ok),
    detail: summarizePreflight(pre),
    results: Array.isArray(pre?.results) ? pre.results : [],
    proxied: Boolean(pre?.proxied),
    reachesUs: Boolean(pre?.reachesUs),
  };

  if (!preflightInfo.ok) {
    const summary = preflightInfo.detail || 'A preflight check failed.';
    const failedCheck = preflightInfo.results.find((entry) => entry.status === 'fail');
    report('preflight', 'failed', firstLine(summary));
    return {
      ...base,
      mode: validationMethod === 'dns' ? 'dns-01' : preflightMode,
      preflight: preflightInfo,
      error: buildError('preflight', summary, "No certificate was requested, so Let's Encrypt rate limits are untouched.", {
        stage: 'preflight',
        fix: failedCheck?.fix || fixForAcmeError(summary, domainName),
        nginxRunning: true,
        configSaved: false,
      }),
    };
  }

  report(
    'preflight',
    'ok',
    preflightInfo.results.some((entry) => entry.status === 'warn')
      ? 'Checks passed with warnings'
      : 'All checks passed',
  );

  // ─── Account, order and key material ──────────────────────────────────────
  let client;
  let csr;
  let domainKey;
  let altNames;
  let rootWasPresent = true;
  let domainDirWasPresent = true;
  let accountDirWasPresent = true;
  let accountKeyWasPresent = true;
  try {
    report('account and order', 'running', "Preparing the Let's Encrypt account and order");
    [rootWasPresent, domainDirWasPresent, accountDirWasPresent, accountKeyWasPresent] =
      await Promise.all([
        pathIsPresentNoFollow(sslDir),
        pathIsPresentNoFollow(certDir),
        pathIsPresentNoFollow(path.join(sslDir, '.account')),
        pathIsPresentNoFollow(path.join(sslDir, '.account', 'account.key')),
      ]);
    await ensureCertDir(sslDir, domainName);

    const createdCertificateDirectories = domainDirWasPresent ? [] : [domainName];
    if (!rootWasPresent || createdCertificateDirectories.length) {
      await recordArtifacts({
        dataDir: getDataDir(),
        sslDir,
        rootCreated: !rootWasPresent,
        directories: createdCertificateDirectories,
      });
    }

    let accountKey;
    try {
      accountKey = await loadAccountKey(sslDir, () => acmeLib.crypto.createPrivateKey());
    } finally {
      const accountDirectoryNowExists = !accountDirWasPresent
        && await pathIsPresentNoFollow(path.join(sslDir, '.account'));
      const accountKeyNowExists = !accountKeyWasPresent
        && await pathIsPresentNoFollow(path.join(sslDir, '.account', 'account.key'));
      if (accountDirectoryNowExists || accountKeyNowExists) {
        await recordArtifacts({
          dataDir: getDataDir(),
          sslDir,
          directories: accountDirectoryNowExists ? ['.account'] : [],
          files: accountKeyNowExists ? ['.account/account.key'] : [],
        });
      }
    }
    client = new acmeLib.Client({ directoryUrl: directoryUrl(staging, acmeLib), accountKey });

    altNames = wildcard
      ? [domainName, `*.${domainName}`]
      : (www ? [domainName, `www.${domainName}`] : [domainName]);
    [domainKey, csr] = await acmeLib.crypto.createCsr({ commonName: domainName, altNames });
    report('account and order', 'ok', 'ACME account ready');
  } catch (err) {
    report('account and order', 'failed', firstLine(err.message));
    return fail('account and order', err, 'No certificate was issued.');
  }

  const writeCert = async (cert) => {
    const dataDir = getDataDir();
    return publishCertificateFiles({
      dataDir,
      sslDir,
      domain: domainName,
      files: {
        'privkey.pem': domainKey,
        'fullchain.pem': cert,
        [CERT_META_FILE]: JSON.stringify({
          domain: domainName,
          altNames,
          validationMethod: validationMethod === 'dns' ? 'dns' : 'http',
          staging,
          issuedAt: new Date().toISOString(),
        }, null, 2),
      },
      onPublished: () => recordArtifacts({
        dataDir,
        sslDir,
        files: [
          `${domainName}/fullchain.pem`,
          `${domainName}/privkey.pem`,
          `${domainName}/${CERT_META_FILE}`,
        ],
      }),
    });
  };

  // ─── DNS-01 (wildcards) — nginx is never touched ──────────────────────────
  if (validationMethod === 'dns') {
    let phase = 'challenge ready';
    let heartbeat = null;
    report('challenge ready', 'running', 'Waiting for the DNS TXT record');
    try {
      const cert = await withTimeout(client.auto({
        csr,
        email: acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          if (onDnsChallenge) await onDnsChallenge(`_acme-challenge.${domainName}`, keyAuthorization);
          report('challenge ready', 'ok', 'The DNS TXT record is ready');
          phase = 'waiting for validation';
          report('waiting for validation', 'running', "Waiting for Let's Encrypt validation");
          heartbeat = startValidationHeartbeat(report);
        },
        challengeRemoveFn: async () => { /* TXT cleanup is the user's */ },
      }), remaining(), () => phase);

      stopHeartbeat(heartbeat);
      report('waiting for validation', 'ok', "Let's Encrypt validated the DNS record");
      report('certificate received', 'ok', "Certificate received from Let's Encrypt");

      report('files written', 'running');
      const paths = await writeCert(cert);
      report('files written', 'ok', 'Certificate and key saved');

      const finish = manageNginx
        ? await applyNginxAndVerify({
          report, run, domainName, certPath: paths.certPath, mode: 'dns-01',
          preflightInfo, behindCloudflare: Boolean(options.behindCloudflare), manageNginx,
          remaining, deps,
        })
        : {};

      return { ...base, success: true, mode: 'dns-01', preflight: preflightInfo, ...paths, ...finish };
    } catch (err) {
      stopHeartbeat(heartbeat);
      const stage = err?.code === 'EZ_TIMEOUT' ? 'timeout' : phase;
      report(phase, 'failed', firstLine(err.message));
      return fail(stage, err, 'No certificate was issued. nginx was not touched.', {
        mode: 'dns-01', preflight: preflightInfo,
      });
    }
  }

  // ─── HTTP-01 ───────────────────────────────────────────────────────────────
  const shared = {
    client, csr, acmeEmail, domainName, nginxDir, challengePort, run, writeCert, base,
    report, preflightInfo, behindCloudflare: Boolean(options.behindCloudflare),
    manageNginx, remaining, deps, challengeServer, fail,
  };

  if (wantProxy) {
    return issueViaProxy(shared);
  }

  return issueViaStandalone({
    ...shared,
    nginxWasRunning: nginxUp,
  });
}

/**
 * Proxy mode: nginx keeps serving; we answer the challenge behind it.
 */
async function issueViaProxy({
  client, csr, acmeEmail, domainName, nginxDir, challengePort, run, writeCert, base,
  report, preflightInfo, behindCloudflare, manageNginx, remaining, deps, challengeServer, fail,
}) {
  // Flow 1: a config generated before this feature has no challenge location.
  const { confPath, text } = await readDomainConf(nginxDir, domainName);
  let configRegenerated = false;

  if (text !== null && !hasChallengeLocation(text)) {
    const detail =
      `${confPath} has no ACME challenge location (it predates this feature). ` +
      'Regenerate the domain config first — saving the domain does this.';
    report('challenge ready', 'failed', detail);
    return {
      ...base,
      mode: CHALLENGE_MODES.PROXY,
      configRegenerated: false,
      preflight: preflightInfo,
      error: buildError(
        'challenge configuration',
        `The nginx config for ${domainName} does not forward ${'/.well-known/acme-challenge/'} to Easy DevOps.`,
        'No certificate was issued. Save the domain once to regenerate its config, then retry.',
        { stage: 'challenge ready', fix: 'Save the domain once to regenerate its nginx config, then retry.', nginxRunning: true, configSaved: false }
      ),
    };
  }

  let phase = 'challenge ready';
  let heartbeat = null;
  report('challenge ready', 'running', 'Starting the ACME challenge listener');

  try {
    const cert = await challengeServer(challengePort, async ({ setToken, removeToken }) => {
      return withTimeout(client.auto({
        csr,
        email: acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          setToken(challenge.token, keyAuthorization);
          report('challenge ready', 'ok', 'The challenge token is being served over HTTP');
          phase = 'waiting for validation';
          report('waiting for validation', 'running', "Waiting for Let's Encrypt validation");
          heartbeat = startValidationHeartbeat(report);
        },
        challengeRemoveFn: async (authz, challenge) => {
          removeToken(challenge.token);
        },
      }), remaining(), () => phase);
    });

    stopHeartbeat(heartbeat);
    report('waiting for validation', 'ok', "Let's Encrypt accepted the challenge");
    report('certificate received', 'ok', "Certificate received from Let's Encrypt");

    report('files written', 'running');
    const paths = await writeCert(cert);
    report('files written', 'ok', 'Certificate and key saved');

    const finish = manageNginx
      ? await applyNginxAndVerify({
        report, run, domainName, certPath: paths.certPath, mode: CHALLENGE_MODES.PROXY,
        preflightInfo, behindCloudflare, manageNginx, remaining, deps,
      })
      : {};

    return {
      ...base,
      success: true,
      mode: CHALLENGE_MODES.PROXY,
      configRegenerated,
      preflight: preflightInfo,
      ...paths,
      ...finish,
    };
  } catch (err) {
    stopHeartbeat(heartbeat);
    const stage = err?.code === 'EZ_TIMEOUT' ? 'timeout' : phase;
    report(phase, 'failed', firstLine(err.message));
    return fail(stage, err, 'No certificate was issued. nginx kept running throughout.', {
      mode: CHALLENGE_MODES.PROXY,
      configRegenerated,
      preflight: preflightInfo,
    });
  }
}

/**
 * Standalone mode: stop nginx, bind port 80 directly, then ALWAYS put nginx
 * back the way it was found.
 */
async function issueViaStandalone({
  client, csr, acmeEmail, domainName, nginxDir, run, writeCert, base, nginxWasRunning,
  report, preflightInfo, behindCloudflare, manageNginx, remaining, deps, challengeServer,
}) {
  let stoppedAt = null;
  const outcome = { ...base, mode: CHALLENGE_MODES.STANDALONE, nginxRestored: !nginxWasRunning };
  let phase = 'challenge ready';
  let heartbeat = null;

  try {
    if (nginxWasRunning) {
      stoppedAt = Date.now();
      await run(nginxServiceStopCmd(nginxDir), { cwd: nginxDir });
    }

    report('challenge ready', 'running', 'Starting the ACME challenge listener on port 80');

    const cert = await challengeServer(80, async ({ setToken, removeToken }) => {
      return withTimeout(client.auto({
        csr,
        email: acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          setToken(challenge.token, keyAuthorization);
          report('challenge ready', 'ok', 'The challenge token is being served on port 80');
          phase = 'waiting for validation';
          report('waiting for validation', 'running', "Waiting for Let's Encrypt validation");
          heartbeat = startValidationHeartbeat(report);
        },
        challengeRemoveFn: async (authz, challenge) => {
          removeToken(challenge.token);
        },
      }), remaining(), () => phase);
    });

    stopHeartbeat(heartbeat);
    report('waiting for validation', 'ok', "Let's Encrypt accepted the challenge");
    report('certificate received', 'ok', "Certificate received from Let's Encrypt");

    report('files written', 'running');
    const paths = await writeCert(cert);
    report('files written', 'ok', 'Certificate and key saved');

    outcome.success = true;
    outcome.certPath = paths.certPath;
    outcome.keyPath = paths.keyPath;
    outcome.preflight = preflightInfo;
  } catch (err) {
    stopHeartbeat(heartbeat);
    const stage = err?.code === 'EZ_TIMEOUT' ? 'timeout' : phase;
    report(phase, 'failed', firstLine(err.message));
    outcome.error = buildError(stage, err.message || 'HTTP-01 challenge failed in standalone mode.', 'No certificate was issued.', {
      stage,
      fix: fixForAcmeError(err.message, domainName),
      nginxRunning: true,
      configSaved: false,
    });
    outcome.preflight = preflightInfo;
  } finally {
    // Restore nginx no matter how we leave this block — success, failure, or
    // an exception thrown past the catch.
    if (nginxWasRunning) {
      let restored = false;
      try {
        await run(nginxServiceStartCmd(nginxDir), { cwd: nginxDir, timeout: 15000 });
        // Confirm rather than assume; retry once before giving up.
        await new Promise((r) => setTimeout(r, 1500));
        restored = await nginxRunning(run);
        if (!restored) {
          await run(nginxServiceStartCmd(nginxDir), { cwd: nginxDir, timeout: 15000 });
          await new Promise((r) => setTimeout(r, 1500));
          restored = await nginxRunning(run);
        }
      } catch {
        restored = false;
      }

      outcome.nginxDownMs = stoppedAt ? Date.now() - stoppedAt : 0;
      outcome.nginxRestored = restored;

      if (!restored) {
        outcome.error = buildError(
          'nginx restore',
          'nginx was stopped for the standalone challenge and did not come back up.',
          `Start it manually: ${nginxServiceStartCmd(nginxDir)}`,
          { nginxRunning: false, configSaved: false }
        );
      }
    }
  }

  if (outcome.success && manageNginx) {
    const finish = await applyNginxAndVerify({
      report, run, domainName: base.domain, certPath: outcome.certPath,
      mode: CHALLENGE_MODES.STANDALONE, preflightInfo, behindCloudflare, manageNginx, remaining, deps,
    });
    Object.assign(outcome, finish);
  }

  return outcome;
}
