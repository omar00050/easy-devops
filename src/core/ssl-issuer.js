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
import os from 'os';
import * as acme from 'acme-client';

import { loadConfig } from './config.js';
import { run as defaultRun } from './shell.js';
import {
  isWindows,
  isDevDataDir,
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
  parseListenAddresses,
  DEFAULT_ACME_CHALLENGE_PORT,
} from './nginx-conf-generator.js';
import { withChallengeServer, preflight, resolveProbeHosts } from './acme-challenge.js';

export const CHALLENGE_MODES = Object.freeze({
  AUTO: 'auto',
  PROXY: 'proxy',
  STANDALONE: 'standalone',
});

/** Advice shown when neither mode could complete the challenge. */
const EXTERNAL_CAUSE_HINT = [
  'Both challenge modes failed locally, which usually means the cause is outside Easy DevOps:',
  '  • the domain\'s DNS A record does not point at this server',
  '  • port 80 is blocked by a firewall or security group',
  '  • an AAAA/IPv6 record points somewhere else (Let\'s Encrypt prefers IPv6)',
  '  • a CDN or proxy in front of the server forces HTTPS or intercepts the path',
].join('\n');

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
function directoryUrl(staging) {
  return staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
}

/**
 * Staging is used when explicitly enabled, and always in dev data mode, so
 * development and testing can never consume production rate limits.
 */
function useStaging(config, override) {
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

/** Ensures the certificate directory exists, with the right ownership. */
async function ensureCertDir(certDir, run) {
  if (isWindows) {
    await fs.mkdir(certDir, { recursive: true });
    return;
  }
  const user = os.userInfo().username;
  await run(`sudo -n mkdir -p "${certDir}"`);
  await run(`sudo -n chown ${user}:${user} "${certDir}"`);
}

/** Loads or creates the persistent ACME account key. */
async function getAccountKey(sslDir) {
  const keyPath = path.join(sslDir, '.account', 'account.key');
  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  try {
    return await fs.readFile(keyPath);
  } catch {
    const key = await acme.crypto.createPrivateKey();
    await fs.writeFile(keyPath, key);
    return key;
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
 * @returns {Promise<{
 *   success: boolean,
 *   certPath: string|null,
 *   keyPath: string|null,
 *   mode: string|null,
 *   fellBack: boolean,
 *   nginxDownMs: number,
 *   staging: boolean,
 *   preflight: { ok: boolean, detail: string }|null,
 *   configRegenerated: boolean,
 *   error: object|null
 * }>}
 */
export async function issueCertificate(domainName, options = {}) {
  const {
    www = false,
    wildcard = false,
    validationMethod = 'http',
    email = null,
    onDnsChallenge = null,
    mode: modeOverride = null,
    staging: stagingOverride,
    run = defaultRun,
  } = options;

  const config = loadConfig();
  const sslDir = config.sslDir;
  const nginxDir = config.nginxDir;
  const challengePort = Number(config.acmeChallengePort) || DEFAULT_ACME_CHALLENGE_PORT;
  const staging = useStaging(config, stagingOverride);

  const base = {
    success: false,
    certPath: null,
    keyPath: null,
    mode: null,
    fellBack: false,
    nginxDownMs: 0,
    staging,
    preflight: null,
    configRegenerated: false,
    error: null,
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

  const certDir = path.join(sslDir, domainName);
  await ensureCertDir(certDir, run);

  const accountKey = await getAccountKey(sslDir);
  const client = new acme.Client({ directoryUrl: directoryUrl(staging), accountKey });

  const altNames = wildcard
    ? [domainName, `*.${domainName}`]
    : (www ? [domainName, `www.${domainName}`] : [domainName]);
  const [domainKey, csr] = await acme.crypto.createCsr({ commonName: domainName, altNames });

  const writeCert = async (cert) => {
    const certPath = path.join(certDir, 'fullchain.pem');
    const keyPath = path.join(certDir, 'privkey.pem');
    await fs.writeFile(keyPath, domainKey);
    await fs.writeFile(certPath, cert);
    return { certPath, keyPath };
  };

  // ─── DNS-01 (wildcards) — unchanged, nginx is never touched ────────────────
  if (validationMethod === 'dns') {
    try {
      const cert = await client.auto({
        csr,
        email: acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          if (onDnsChallenge) await onDnsChallenge(`_acme-challenge.${domainName}`, keyAuthorization);
        },
        challengeRemoveFn: async () => { /* TXT cleanup is the user's */ },
      });
      const paths = await writeCert(cert);
      return { ...base, success: true, mode: 'dns-01', ...paths };
    } catch (err) {
      return {
        ...base,
        mode: 'dns-01',
        error: buildError(
          'ACME validation',
          err.message || 'DNS-01 challenge failed.',
          'No certificate was issued. nginx was not touched.',
          { nginxRunning: true, configSaved: false }
        ),
      };
    }
  }

  // ─── HTTP-01 ───────────────────────────────────────────────────────────────
  const requestedMode = modeOverride || config.sslChallengeMode || CHALLENGE_MODES.AUTO;
  const nginxUp = await nginxRunning(run);

  let result = { ...base };

  // Proxy mode is viable only when nginx is actually serving port 80.
  const wantProxy =
    requestedMode === CHALLENGE_MODES.PROXY ||
    (requestedMode === CHALLENGE_MODES.AUTO && nginxUp);

  if (wantProxy) {
    result = await issueViaProxy({
      client, csr, acmeEmail, domainName, nginxDir, challengePort, run, writeCert, base,
    });

    if (result.success) return result;

    // Only a FAILED LOCAL PREFLIGHT may trigger the fallback. A Let's Encrypt
    // failure must not, or a broken DNS record would cost two attempts.
    const preflightFailed = result.preflight && result.preflight.ok === false;
    const mayFallBack = requestedMode === CHALLENGE_MODES.AUTO && preflightFailed;

    if (!mayFallBack) return result;
  }

  // ─── Standalone fallback ───────────────────────────────────────────────────
  if (requestedMode === CHALLENGE_MODES.PROXY) return result;

  const standalone = await issueViaStandalone({
    client, csr, acmeEmail, nginxDir, run, writeCert, base, nginxWasRunning: nginxUp,
  });

  standalone.fellBack = wantProxy;
  standalone.preflight = result.preflight ?? null;

  if (!standalone.success && wantProxy) {
    const seen = result.preflight?.detail ? `\n\nPreflight saw: ${result.preflight.detail}` : '';
    standalone.error = buildError(
      standalone.error?.step ?? 'ACME validation',
      `${standalone.error?.cause ?? 'Challenge failed.'}\n\n${EXTERNAL_CAUSE_HINT}${seen}`,
      standalone.error?.consequence ?? 'No certificate was issued.',
      { nginxRunning: standalone.error?.nginxRunning ?? true, configSaved: false }
    );
  }

  return standalone;
}

/**
 * Proxy mode: nginx keeps serving; we answer the challenge behind it.
 */
async function issueViaProxy({
  client, csr, acmeEmail, domainName, nginxDir, challengePort, run, writeCert, base,
}) {
  // Flow 1: a config generated before this feature has no challenge location.
  const { confPath, text } = await readDomainConf(nginxDir, domainName);
  let configRegenerated = false;

  if (text !== null && !hasChallengeLocation(text)) {
    return {
      ...base,
      mode: CHALLENGE_MODES.PROXY,
      configRegenerated: false,
      preflight: {
        ok: false,
        detail:
          `${confPath} has no ACME challenge location (it predates this feature). ` +
          'Regenerate the domain config first — saving the domain does this.',
      },
      error: buildError(
        'challenge configuration',
        `The nginx config for ${domainName} does not forward ${'/.well-known/acme-challenge/'} to Easy DevOps.`,
        'No certificate was issued. Save the domain once to regenerate its config, then retry.',
        { nginxRunning: true, configSaved: false }
      ),
    };
  }

  // Adjustment 3: probe the address nginx actually listens on.
  const listens = text !== null ? parseListenAddresses(text, 80) : [];
  const probeHosts = resolveProbeHosts(listens);

  const pre = await preflight({ domain: domainName, challengePort, probeHosts });

  if (!pre.ok) {
    const bound = listens.length > 0
      ? ` The config binds: ${listens.map((l) => `${l.host}:${l.port}`).join(', ')}.`
      : '';
    return {
      ...base,
      mode: CHALLENGE_MODES.PROXY,
      configRegenerated,
      preflight: pre,
      error: buildError(
        'local preflight',
        `nginx did not return the challenge token on ${pre.triedHosts.join(', ')}.${bound} ${pre.detail}`,
        "No certificate was requested, so Let's Encrypt rate limits are untouched.",
        { nginxRunning: true, configSaved: false }
      ),
    };
  }

  try {
    const cert = await withChallengeServer(challengePort, async ({ setToken, removeToken }) => {
      return client.auto({
        csr,
        email: acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          setToken(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (authz, challenge) => {
          removeToken(challenge.token);
        },
      });
    });

    const paths = await writeCert(cert);
    return {
      ...base,
      success: true,
      mode: CHALLENGE_MODES.PROXY,
      configRegenerated,
      preflight: pre,
      ...paths,
    };
  } catch (err) {
    return {
      ...base,
      mode: CHALLENGE_MODES.PROXY,
      configRegenerated,
      preflight: pre,
      error: buildError(
        'ACME validation',
        err.message || 'HTTP-01 challenge failed.',
        'No certificate was issued. nginx kept running throughout.',
        { nginxRunning: true, configSaved: false }
      ),
    };
  }
}

/**
 * Standalone mode: stop nginx, bind port 80 directly, then ALWAYS put nginx
 * back the way it was found.
 */
async function issueViaStandalone({
  client, csr, acmeEmail, nginxDir, run, writeCert, base, nginxWasRunning,
}) {
  let stoppedAt = null;

  // The result is built up in place so the finally block can record how long
  // nginx was down — a `return { ...base }` would have been evaluated before
  // finally ran, and the timing would never reach the caller.
  const outcome = { ...base, mode: CHALLENGE_MODES.STANDALONE, nginxRestored: !nginxWasRunning };

  try {
    if (nginxWasRunning) {
      stoppedAt = Date.now();
      await run(nginxServiceStopCmd(nginxDir), { cwd: nginxDir });
    }

    const cert = await withChallengeServer(80, async ({ setToken, removeToken }) => {
      return client.auto({
        csr,
        email: acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          setToken(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (authz, challenge) => {
          removeToken(challenge.token);
        },
      });
    });

    const paths = await writeCert(cert);
    outcome.success = true;
    outcome.certPath = paths.certPath;
    outcome.keyPath = paths.keyPath;
    return outcome;
  } catch (err) {
    outcome.error = buildError(
      'ACME validation',
      err.message || 'HTTP-01 challenge failed in standalone mode.',
      'No certificate was issued.',
      { nginxRunning: true, configSaved: false }
    );
    return outcome;
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
}
