/**
 * core/deploy/domainLink.js
 *
 * Ties a deployed app to a domain: nginx proxies the domain to the port the
 * app listens on, and the two stay in step.
 *
 * Nothing new is invented for nginx here. A link is an ordinary domain record,
 * created or updated through handleHubDomainCommand() — the same path the
 * dashboard, the CLI and the Hub use, with the same "test, and restore the
 * previous config if nginx rejects it" guarantee. What this module adds is the
 * bookkeeping: the app remembers its domain, and a deployment that changes the
 * app's port moves the domain with it.
 */

import fs from 'fs';
import path from 'path';

import { loadConfig } from '../config.js';
import { findDomain, handleHubDomainCommand } from '../domains-db.js';
import { validateDomainName, validateBoolean, validateBehindCloudflare } from '../validators.js';
import { findCertificateForDomain, normalizeForMatch, wildcardCovers } from '../cert-suggest.js';
import { issueCertificate, prepareDomainForHttpChallenge, reloadNginx, describeIssuance, verifyServedCertificate } from '../ssl-issuer.js';

import { getApp, setAppDomain } from './apps.js';
import { readState, releaseDir } from './store.js';

/**
 * The port an app listens on: what is set on the app, else what its live
 * release was started with (from ez.json or PORT).
 *
 * @returns {number|null}
 */
export function appPort(app) {
  const own = Number(app?.settings?.port);
  if (Number.isInteger(own) && own > 0) return own;

  try {
    const current = readState(app.id).current;
    if (!current) return null;
    const meta = JSON.parse(fs.readFileSync(path.join(releaseDir(app.id, current), 'ez.release.json'), 'utf8'));
    return Number.isInteger(meta.port) && meta.port > 0 ? meta.port : null;
  } catch {
    return null;
  }
}

/** The one wording used for a wildcard certificate request, from the API and the Hub. */
export const WILDCARD_ISSUE_ERROR =
  'A new wildcard certificate needs DNS validation, which linking does not do. '
  + 'Issue it from the SSL page, then link with an existing certificate.';

/**
 * Normalises the `ssl` input. The old boolean is kept: true = issue,
 * false = none. Anything else must be `{ mode, certName? }`.
 *
 * @returns {{ mode: 'none'|'issue'|'existing', certName: string|null } | { error: string }}
 */
function parseSslInput(input) {
  if (input === undefined || input === null || input === false) return { mode: 'none', certName: null };
  if (input === true) return { mode: 'issue', certName: null };

  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Invalid ssl: use { mode: "none" | "issue" | "existing", certName? } or true/false.' };
  }

  const mode = input.mode ?? 'none';
  if (!['none', 'issue', 'existing'].includes(mode)) {
    return { error: 'Invalid ssl.mode: must be "none", "issue" or "existing".' };
  }

  const certName = input.certName === undefined || input.certName === null
    ? null
    : String(input.certName).trim().toLowerCase();
  if (mode === 'existing' && !certName) {
    return { error: 'ssl.certName is required when ssl.mode is "existing". Choose a certificate from the suggestion list.' };
  }

  return { mode, certName };
}

/** True when a suggested certificate covers `domain`, wildcards included. */
function certificateCovers(certificate, domain) {
  const wanted = normalizeForMatch(domain);
  const names = [certificate?.domain, ...(certificate?.names ?? [])]
    .map(normalizeForMatch)
    .filter(Boolean);
  return names.includes(wanted) || names.some((name) => wildcardCovers(name, wanted));
}

/**
 * Re-runs the server's own certificate suggestion for every name the link must
 * serve. The caller only names a certificate; the paths ALWAYS come from here.
 *
 * @returns {{ certificate: Object } | { error: string }}
 */
async function resolveExistingCertificate(name, www, certName, suggest) {
  const wanted = normalizeForMatch(certName);
  const names = www ? [name, `www.${name}`] : [name];
  const found = [];

  for (const candidate of names) {
    const suggestion = await suggest(candidate);
    const certificate = suggestion?.found ? suggestion.certificate : null;
    if (!certificate?.certPath || !certificate?.keyPath) {
      return {
        error: `No existing certificate covers ${candidate}. Issue a certificate from the SSL page first, or choose "issue" for this link.`,
      };
    }
    if (normalizeForMatch(certificate.domain) !== wanted || !certificateCovers(certificate, candidate)) {
      const suggested = certificate.domain ? ` The suggestion for ${candidate} is "${certificate.domain}".` : '';
      return {
        error: `Certificate "${certName}" is not a certificate the server suggests for ${candidate}.${suggested} `
          + 'Choose one from the suggestion list, or issue a new certificate.',
      };
    }
    found.push(certificate);
  }

  return { certificate: found[0] };
}

/**
 * Links an app to a domain.
 *
 * `domain` may name an existing domain — it is re-pointed at the app — or a
 * new one, which is created. The optional SSL mode either uses a suggested
 * existing certificate or requests a new one over HTTP-01. The domain and its
 * nginx config are applied first: if issuance then fails the link still
 * stands, over HTTP, and the answer says why.
 *
 * @param {string} appId
 * @param {{ domain: string, www?: boolean, ssl?: boolean|{mode:string, certName?:string},
 *   redirect?: boolean, behindCloudflare?: boolean }} input
 * @param {Object} [deps] Injected collaborators (testing only)
 * @param {(step: string, status: string, detail?: string) => void} [deps.onProgress]
 *   Live progress for a Hub command. Absent on the dashboard path.
 * @returns {Promise<{ ok: boolean, status: number, error: string|null,
 *   domain?: string, created?: boolean, port?: number, www?: boolean,
 *   behindCloudflare?: boolean, ssl?: Object|null, redirect?: boolean,
 *   nginxReloaded?: boolean }>}
 */
export async function linkDomain(appId, input = {}, deps = {}) {
  const {
    domainCommand = handleHubDomainCommand,
    reload = reloadNginx,
    issue = issueCertificate,
    prepare = prepareDomainForHttpChallenge,
    suggest = findCertificateForDomain,
    verify = verifyServedCertificate,
    onProgress = null,
  } = deps;
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  const {
    domain,
    www: rawWww,
    ssl: rawSsl,
    redirect: rawRedirect,
    behindCloudflare: rawBehindCloudflare,
  } = input ?? {};

  const app = getApp(appId);
  if (!app) return { ok: false, status: 404, error: `No app named "${appId}".` };

  const name = String(domain ?? '').trim().toLowerCase();
  const nameError = validateDomainName(name);
  if (nameError) return { ok: false, status: 400, error: nameError };

  const www = rawWww === undefined || rawWww === null ? false : rawWww;
  const wwwError = validateBoolean(www, 'www');
  if (wwwError) return { ok: false, status: 400, error: wwwError };

  const behindCloudflare = rawBehindCloudflare === undefined || rawBehindCloudflare === null
    ? false
    : rawBehindCloudflare;
  const cloudflareError = validateBehindCloudflare(behindCloudflare);
  if (cloudflareError) return { ok: false, status: 400, error: cloudflareError };

  const sslInput = parseSslInput(rawSsl);
  if (sslInput.error) return { ok: false, status: 400, error: sslInput.error };
  const { mode: sslMode, certName } = sslInput;

  if (sslMode === 'issue' && name.startsWith('*.')) {
    return { ok: false, status: 400, error: WILDCARD_ISSUE_ERROR };
  }

  let redirect = false;
  if (sslMode !== 'none') {
    const redirectError = validateBoolean(rawRedirect, 'redirect');
    if (redirectError) return { ok: false, status: 400, error: redirectError };
    redirect = rawRedirect === undefined || rawRedirect === null ? true : rawRedirect;
  }

  const port = appPort(app);
  if (!port) {
    return {
      ok: false,
      status: 409,
      error: 'This app has no port yet. Set its port (or put "port" in ez.json and deploy once), then link the domain.',
    };
  }

  // An existing certificate is resolved BEFORE anything is written, so a
  // forged or non-covering certName cannot leave a half-linked domain behind.
  let existingCertificate = null;
  if (sslMode === 'existing') {
    const resolved = await resolveExistingCertificate(name, www, certName, suggest);
    if (resolved.error) return { ok: false, status: 400, error: resolved.error };
    existingCertificate = resolved.certificate;
  }

  const existing = findDomain(name);
  const record = {
    port,
    backendHost: '127.0.0.1',
    www,
    behindCloudflare,
  };
  if (existingCertificate) {
    record.ssl = {
      enabled: true,
      certPath: existingCertificate.certPath,
      keyPath: existingCertificate.keyPath,
      redirect,
    };
  }

  progress('domain', 'running');
  const result = existing
    ? await domainCommand({ action: 'update', name, domain: record })
    : await domainCommand({ action: 'create', domain: { name, ...record } });

  if (!result?.ok) {
    const error = result?.error ?? 'nginx rejected the configuration.';
    progress('domain', 'failed', error);
    return { ok: false, status: 500, error };
  }

  setAppDomain(appId, name);
  progress('domain', 'ok');

  let reloaded = null;
  let sslResult = null;

  if (sslMode === 'issue') {
    // The HTTP config must be live before the ACME challenge is attempted.
    // This reload belongs to the certificate step; the final one is reported
    // as its own `nginx reload` stage below.
    reloaded = await reload();
    sslResult = await requestCertificate(name, {
      www, redirect, domainCommand, issue, prepare, onProgress: progress,
    });

    progress('nginx config test', 'running');
    if (sslResult.ok) reloaded = await reload();
    const reloadDetail = reloaded?.ok ? undefined : 'nginx reload failed';
    progress('nginx config test', reloaded?.ok ? 'ok' : 'failed', reloadDetail);
    progress('nginx reload', 'running');
    progress('nginx reload', reloaded?.ok ? 'ok' : 'failed', reloadDetail);

    if (!sslResult.ok) {
      progress('https verified', 'skipped', 'no new certificate to verify');
    } else if (behindCloudflare || sslResult.preflight?.proxied) {
      progress('https verified', 'skipped', "served by Cloudflare's edge");
    } else {
      progress('https verified', 'running');
      try {
        const checked = await verify(name, sslResult.certPath);
        progress('https verified', checked?.ok ? 'ok' : 'failed', checked?.ok ? undefined : checked?.message);
      } catch (err) {
        progress('https verified', 'failed', String(err.message).split('\n')[0]);
      }
    }
  } else {
    if (existingCertificate) {
      progress('https', 'running');
      sslResult = {
        mode: 'existing',
        ok: true,
        detail: `Using the existing certificate "${existingCertificate.domain}".`,
        certName: existingCertificate.domain,
        certPath: existingCertificate.certPath,
      };
      progress('https', 'ok', sslResult.detail);
    } else {
      progress('https', 'skipped');
    }

    progress('nginx config test', 'running');
    reloaded = await reload();
    const reloadDetail = reloaded?.ok ? undefined : 'nginx reload failed';
    progress('nginx config test', reloaded?.ok ? 'ok' : 'failed', reloadDetail);
    progress('nginx reload', 'running');
    progress('nginx reload', reloaded?.ok ? 'ok' : 'failed', reloadDetail);

    if (!existingCertificate) {
      progress('https verified', 'skipped', 'no certificate was requested');
    } else if (behindCloudflare) {
      progress('https verified', 'skipped', "served by Cloudflare's edge");
    } else {
      progress('https verified', 'running');
      try {
        const checked = await verify(name, existingCertificate.certPath);
        progress('https verified', checked?.ok ? 'ok' : 'failed', checked?.ok ? undefined : checked?.message);
      } catch (err) {
        progress('https verified', 'failed', String(err.message).split('\n')[0]);
      }
    }
  }

  return {
    ok: true,
    status: 200,
    error: null,
    domain: name,
    created: !existing,
    port,
    www,
    behindCloudflare,
    ssl: sslResult,
    redirect,
    nginxReloaded: Boolean(reloaded?.ok),
  };
}

/** Requests a certificate for a freshly linked domain and switches the domain to HTTPS. */
async function requestCertificate(name, { www, redirect, domainCommand, issue, prepare, onProgress = null }) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const config = loadConfig();
  if (!config.acmeEmail) {
    const detail = 'No certificate was requested: set an ACME email in Settings first.';
    progress('account and order', 'failed', detail);
    progress('https', 'skipped');
    return { mode: 'issue', ok: false, detail };
  }

  let stage = 'challenge ready';
  try {
    const record = findDomain(name);
    const prepared = await prepare(record);
    if (!prepared.ok) {
      progress('challenge ready', 'failed', `Could not prepare nginx for the challenge: ${prepared.error}`);
      progress('https', 'skipped');
      return { mode: 'issue', ok: false, detail: `Could not prepare nginx for the challenge: ${prepared.error}` };
    }

    const issued = await issue(name, {
      validationMethod: 'http',
      email: config.acmeEmail,
      www: Boolean(www),
      // The link reports nginx test/reload/verify itself, after the domain
      // record has been switched to the new certificate paths.
      manageNginx: false,
      onProgress: progress,
    });
    if (!issued.success) {
      const cause = String(issued.error?.cause ?? 'The certificate could not be issued.').split('\n')[0];
      progress('https', 'skipped');
      return {
        mode: 'issue',
        ok: false,
        detail: `${cause} The domain works over HTTP; issue the certificate from the SSL page once its DNS points here.`,
      };
    }

    stage = 'https';
    progress('https', 'running');
    const updated = await domainCommand({
      action: 'update',
      name,
      domain: { ssl: { enabled: true, certPath: issued.certPath, keyPath: issued.keyPath, redirect } },
    });
    if (!updated?.ok) {
      progress('https', 'failed', `nginx rejected the HTTPS config: ${updated?.error ?? 'unknown error'}`);
      return {
        mode: 'issue',
        ok: false,
        detail: `The certificate was issued, but nginx rejected the HTTPS config: ${updated?.error ?? 'unknown error'}`,
      };
    }
    progress('https', 'ok');
    return {
      mode: 'issue',
      ok: true,
      detail: describeIssuance(issued) || 'Certificate issued.',
      certName: name,
      certPath: issued.certPath,
      keyPath: issued.keyPath,
      preflight: issued.preflight,
    };
  } catch (err) {
    if (stage === 'https') {
      progress('https', 'failed', err.message);
    } else {
      progress('challenge ready', 'failed', err.message);
      progress('https', 'skipped');
    }
    return { mode: 'issue', ok: false, detail: `The certificate could not be issued: ${err.message}` };
  }
}

/**
 * Forgets the link. The domain itself is left exactly as it is — it may be
 * serving traffic, and removing a domain is its own decision.
 *
 * @returns {{ ok: boolean, status: number, error: string|null }}
 */
export function unlinkDomain(appId) {
  const app = getApp(appId);
  if (!app) return { ok: false, status: 404, error: `No app named "${appId}".` };
  setAppDomain(appId, null);
  return { ok: true, status: 200, error: null };
}

/**
 * Deletes the domain an app is linked to. Used when an app is removed and the
 * person removing it asked for the domain to go too.
 *
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function deleteLinkedDomain(app, deps = {}) {
  const { domainCommand = handleHubDomainCommand } = deps;
  if (!app?.domain || !findDomain(app.domain)) return { ok: true, error: null };
  const result = await domainCommand({ action: 'delete', name: app.domain });
  return { ok: Boolean(result?.ok), error: result?.ok ? null : (result?.error ?? 'The domain could not be removed.') };
}

/**
 * After a deployment: if the app's port changed, move the linked domain to it.
 *
 * Without this, changing `port` in ez.json and deploying would leave nginx
 * proxying to a port nothing listens on any more — the app healthy, the site
 * down. Never throws; a failure is returned as a warning for the run.
 *
 * @param {Object} app
 * @param {number|null} port The port the release that just went live listens on
 * @returns {Promise<string|null>} A line for the deployment log, or null when nothing changed
 */
export async function syncLinkedDomain(app, port, deps = {}) {
  const { domainCommand = handleHubDomainCommand, reload = reloadNginx } = deps;
  try {
    if (!app?.domain || !port) return null;
    const record = findDomain(app.domain);
    if (!record) return `warning: the linked domain ${app.domain} no longer exists.`;
    if (Number(record.port) === Number(port) && (record.backendHost ?? '127.0.0.1') === '127.0.0.1') return null;

    const result = await domainCommand({ action: 'update', name: app.domain, domain: { port, backendHost: '127.0.0.1' } });
    if (!result?.ok) return `warning: ${app.domain} could not be pointed at port ${port}: ${result?.error ?? 'nginx rejected the config'}`;

    const reloaded = await reload();
    return reloaded?.ok
      ? `${app.domain} now proxies to port ${port}.`
      : `warning: ${app.domain} was pointed at port ${port}, but nginx was not reloaded.`;
  } catch (err) {
    return `warning: the linked domain could not be updated: ${err.message}`;
  }
}
