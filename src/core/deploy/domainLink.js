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
import { validateDomainName } from '../validators.js';
import { issueCertificate, prepareDomainForHttpChallenge, reloadNginx, describeIssuance } from '../ssl-issuer.js';

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

/**
 * Links an app to a domain.
 *
 * `domain` may name an existing domain — it is re-pointed at the app — or a
 * new one, which is created. With `ssl: true` a certificate is requested over
 * HTTP-01 once the domain answers; if that fails the link still stands, over
 * plain HTTP, and the answer says why.
 *
 * @param {string} appId
 * @param {{ domain: string, ssl?: boolean }} input
 * @param {Object} [deps] Injected collaborators (testing only)
 * @returns {Promise<{ ok: boolean, status: number, error: string|null,
 *   domain?: string, created?: boolean, port?: number, ssl?: Object|null, nginxReloaded?: boolean }>}
 */
export async function linkDomain(appId, { domain, ssl = false } = {}, deps = {}) {
  const {
    domainCommand = handleHubDomainCommand,
    reload = reloadNginx,
    issue = issueCertificate,
    prepare = prepareDomainForHttpChallenge,
  } = deps;

  const app = getApp(appId);
  if (!app) return { ok: false, status: 404, error: `No app named "${appId}".` };

  const name = String(domain ?? '').trim().toLowerCase();
  const nameError = validateDomainName(name);
  if (nameError) return { ok: false, status: 400, error: nameError };

  const port = appPort(app);
  if (!port) {
    return {
      ok: false,
      status: 409,
      error: 'This app has no port yet. Set its port (or put "port" in ez.json and deploy once), then link the domain.',
    };
  }

  const existing = findDomain(name);
  const result = existing
    ? await domainCommand({ action: 'update', name, domain: { port, backendHost: '127.0.0.1' } })
    : await domainCommand({ action: 'create', domain: { name, port } });

  if (!result?.ok) return { ok: false, status: 500, error: result?.error ?? 'nginx rejected the configuration.' };

  setAppDomain(appId, name);

  let reloaded = await reload();
  let sslResult = null;

  if (ssl && !findDomain(name)?.ssl?.enabled) {
    sslResult = await requestCertificate(name, { domainCommand, issue, prepare });
    if (sslResult.ok) reloaded = await reload();
  }

  return {
    ok: true,
    status: 200,
    error: null,
    domain: name,
    created: !existing,
    port,
    ssl: sslResult,
    nginxReloaded: Boolean(reloaded?.ok),
  };
}

/** Requests a certificate for a freshly linked domain and switches the domain to HTTPS. */
async function requestCertificate(name, { domainCommand, issue, prepare }) {
  const config = loadConfig();
  if (!config.acmeEmail) {
    return { ok: false, detail: 'No certificate was requested: set an ACME email in Settings first.' };
  }

  try {
    const record = findDomain(name);
    const prepared = await prepare(record);
    if (!prepared.ok) return { ok: false, detail: `Could not prepare nginx for the challenge: ${prepared.error}` };

    const issued = await issue(name, { validationMethod: 'http', email: config.acmeEmail });
    if (!issued.success) {
      const cause = String(issued.error?.cause ?? 'The certificate could not be issued.').split('\n')[0];
      return { ok: false, detail: `${cause} The domain works over HTTP; issue the certificate from the SSL page once its DNS points here.` };
    }

    const updated = await domainCommand({
      action: 'update',
      name,
      domain: { ssl: { enabled: true, certPath: issued.certPath, keyPath: issued.keyPath } },
    });
    if (!updated?.ok) {
      return { ok: false, detail: `The certificate was issued, but nginx rejected the HTTPS config: ${updated?.error ?? 'unknown error'}` };
    }
    return { ok: true, detail: describeIssuance(issued) || 'Certificate issued.' };
  } catch (err) {
    return { ok: false, detail: `The certificate could not be issued: ${err.message}` };
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
