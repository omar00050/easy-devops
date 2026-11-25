/**
 * Explicit projections for data that leaves this server through the Hub.
 *
 * The Hub is a separate trust boundary. An object that is safe on the local
 * dashboard must still be copied field by field before it is emitted, because
 * a future field on a domain or deploy run would otherwise become telemetry
 * without anyone deciding that it was safe.
 */

import { isRedactedDeployRun } from '../deploy/logSecurity.js';
import { isSafeBackendHost } from '../nginx-fields.js';

const DOMAIN_FIELDS = [
  'name',
  'port',
  'backendHost',
  'upstreamType',
  'www',
  'wildcard',
  'behindCloudflare',
  'enabled',
  'createdAt',
  'updatedAt',
  'certStatus',
  'certLabel',
];

const SSL_FIELDS = ['enabled', 'redirect', 'hsts', 'hstsMaxAge'];
const CERTIFICATE_PATH_FIELDS = ['certPath', 'keyPath'];
const PERFORMANCE_FIELDS = [
  'maxBodySize',
  'readTimeout',
  'connectTimeout',
  'proxyBuffers',
  'gzip',
  'gzipTypes',
];
const SECURITY_FIELDS = [
  'rateLimit',
  'rateLimitRate',
  'rateLimitBurst',
  'securityHeaders',
  'custom404',
  'custom50x',
];
const ADVANCED_FIELDS = ['accessLog'];
const NOTIFICATION_EVENTS = ['domain_health', 'cert_expiry', 'nginx_down'];

const RUN_FIELDS = [
  'id',
  'appId',
  'trigger',
  'ref',
  'sha',
  'releaseId',
  'status',
  'step',
  'stage',
  'skippedStages',
  'startedAt',
  'finishedAt',
  'rolledBackTo',
  'rollbackSucceeded',
];

function own(source, key) {
  return source && Object.prototype.hasOwnProperty.call(source, key);
}

function pick(source, keys) {
  const out = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const key of keys) {
    if (own(source, key)) out[key] = source[key];
  }
  return out;
}

function notificationsForHub(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  let found = false;
  for (const id of NOTIFICATION_EVENTS) {
    const route = value[id];
    if (!route || typeof route !== 'object' || Array.isArray(route)) continue;
    found = true;
    const projected = {};
    if (own(route, 'enabled')) projected.enabled = route.enabled === true;
    if (Array.isArray(route.channelIds)) {
      projected.channelIds = route.channelIds.filter((entry) => typeof entry === 'string');
    }
    out[id] = projected;
  }
  return found ? out : undefined;
}

/**
 * Domain data for `domain:configs`.
 *
 * Monitoring and ordinary editing fields remain available to a paired Hub.
 * Local filesystem paths and the free-form nginx fragment are included only
 * when `nginx.config.view` is granted. Writing the fragment still requires
 * `nginx.config.edit` in hub:manageDomain.
 */
export function projectDomainForHub(domain, permissions = {}) {
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)) return null;

  const configView = permissions?.['nginx.config.view'] === true;
  const out = pick(domain, DOMAIN_FIELDS);
  // Older versions accepted credential-bearing backend URLs. They are
  // invalid now, but a legacy record still must not cross the Hub trust
  // boundary while repair has not rewritten it.
  if (own(out, 'backendHost') && !isSafeBackendHost(out.backendHost)) {
    out.backendHost = null;
  }

  if (domain.ssl && typeof domain.ssl === 'object' && !Array.isArray(domain.ssl)) {
    out.ssl = pick(domain.ssl, configView ? [...SSL_FIELDS, ...CERTIFICATE_PATH_FIELDS] : SSL_FIELDS);
  }
  if (domain.performance && typeof domain.performance === 'object' && !Array.isArray(domain.performance)) {
    out.performance = pick(domain.performance, PERFORMANCE_FIELDS);
  }
  if (domain.security && typeof domain.security === 'object' && !Array.isArray(domain.security)) {
    out.security = pick(domain.security, SECURITY_FIELDS);
  }
  if (domain.advanced && typeof domain.advanced === 'object' && !Array.isArray(domain.advanced)) {
    out.advanced = pick(
      domain.advanced,
      configView ? [...ADVANCED_FIELDS, 'customLocations'] : ADVANCED_FIELDS,
    );
  }

  const notifications = notificationsForHub(domain.notifications);
  if (notifications) out.notifications = notifications;
  if (configView && own(domain, 'configFile')) out.configFile = domain.configFile;
  return out;
}

/**
 * `server:info` is emitted on every connection. An empty sslDir is deliberate:
 * it lets the Hub overwrite a path retained from an older agent instead of
 * preserving it with a nullish fallback.
 */
export function projectServerInfoForHub({ platform, sslDir } = {}, permissions = {}) {
  const configView = permissions?.['nginx.config.view'] === true;
  return {
    platform: platform ?? null,
    sslDir: configView && typeof sslDir === 'string' ? sslDir : '',
  };
}

/**
 * Deployment runs for every Hub-facing surface.
 *
 * The operational record is always present. Human-readable diagnostics and
 * captured process output stay null or empty until `deploy.logs` is granted.
 */
export function projectRunForHub(run, permissions = {}) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null;

  const logs = permissions?.['deploy.logs'] === true;
  // The marker belongs to the writer that persisted each diagnostic. A
  // pre-1.4.5 run has no such proof, and re-redacting it with today's values
  // cannot remove a credential that has since been rotated.
  const trustedDiagnostics = logs && isRedactedDeployRun(run);
  const out = pick(run, RUN_FIELDS);
  out.skippedStages = Array.isArray(run.skippedStages)
    ? run.skippedStages.filter((stage) => typeof stage === 'string')
    : [];

  out.error = trustedDiagnostics && typeof run.error === 'string' ? run.error : null;
  out.reason = trustedDiagnostics && typeof run.reason === 'string' ? run.reason : null;
  out.warnings = trustedDiagnostics && Array.isArray(run.warnings)
    ? run.warnings.filter((warning) => typeof warning === 'string')
    : [];
  out.logTail = trustedDiagnostics && Array.isArray(run.logTail)
    ? run.logTail.filter((line) => typeof line === 'string')
    : [];
  return out;
}

/**
 * Finalize deployment telemetry only after its asynchronous data load.
 *
 * A permission snapshot taken before listRuns(), PM2 discovery, or a
 * certificate stat can complete after a later revocation and become the newest
 * event in the Hub. Callers load the unprojected operational records first,
 * then this function asks for permissions and projects in one uninterrupted
 * turn.
 */
export async function describeDeployAppsForHub(loadApps, permissionsForHub) {
  const apps = await loadApps();
  if (!Array.isArray(apps)) return [];
  const permissions = permissionsForHub();
  return apps.map((app) => ({
    ...app,
    lastRun: app?.lastRun ? projectRunForHub(app.lastRun, permissions) : null,
  }));
}
