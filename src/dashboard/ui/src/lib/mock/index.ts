/**
 * lib/mock/index.ts — an in-browser implementation of the REST contract.
 *
 * Enabled with VITE_MOCK=1. Requests go through the same typed API client as
 * production, so pages exercise their real loading/error paths; only the
 * transport is substituted. State lives in sessionStorage so a reload keeps
 * what you changed, and resets when the scenario changes.
 *
 * Scenarios (append `?mock=<name>` to the dev URL):
 *   dashboard           signed in, fully populated (default)
 *   service-stopped     signed in, background service installed but stopped
 *   service-stopped-by-you  signed in, stopped deliberately (starts at logon)
 *   service-not-installed   signed in, no launcher/service installed
 *   login               signed out, password set
 *   setup               first run, no password yet
 *   setupcode           first run with a setup code (mock code: 123456)
 *   none                no authentication mode
 */

import { ApiError } from '../errors';
import {
  COMING_SOON_IDS,
  PERMISSION_TREE,
  defaultNotifications,
  seedAccessLog,
  seedApps,
  seedCertificates,
  seedChannels,
  seedDomains,
  seedErrorLog,
  seedHub,
  seedNginxConfigs,
  seedNginxStatus,
  seedPermissions,
  seedProcesses,
  seedService,
  seedSettings,
  isoDaysFromNow,
} from './fixtures';
import type {
  Certificate,
  ChannelInput,
  Domain,
  DomainNotifications,
  HubStatus,
  NginxStatus,
  NotificationChannel,
  PermissionMap,
  ProcessAction,
  ProcessesResponse,
  ServiceStatus,
  Settings,
  SslCreateInput,
} from '../types';
import type { HttpMethod, QueryParams } from '../api';

export type MockScenario =
  | 'dashboard'
  | 'service-stopped'
  | 'service-stopped-by-you'
  | 'service-not-installed'
  | 'login'
  | 'setup'
  | 'setupcode'
  | 'none';

const SCENARIOS: MockScenario[] = [
  'dashboard',
  'service-stopped',
  'service-stopped-by-you',
  'service-not-installed',
  'login',
  'setup',
  'setupcode',
  'none',
];
const STORAGE_PREFIX = 'ez-mock-state-v3';
const SCENARIO_KEY = 'ez-mock-scenario';

interface MockState {
  scenario: MockScenario;
  authenticated: boolean;
  authMode: 'password' | 'none';
  setupConfigured: boolean;
  hasPassword: boolean;
  domains: Domain[];
  certs: Certificate[];
  channels: NotificationChannel[];
  nginx: NginxStatus;
  configs: Record<string, string>;
  errorLog: string[];
  accessLog: string[];
  processes: ProcessesResponse;
  service: ServiceStatus;
  settings: Settings;
  hub: HubStatus;
  pendingDns: Record<string, { txtName: string; txtValue: string }>;
}

function readScenario(): MockScenario {
  try {
    const search = new URLSearchParams(window.location.search);
    const fromHash = window.location.hash.includes('?')
      ? new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf('?') + 1))
      : null;
    const requested = search.get('mock') ?? fromHash?.get('mock');
    if (requested && (SCENARIOS as string[]).includes(requested)) {
      sessionStorage.setItem(SCENARIO_KEY, requested);
      return requested as MockScenario;
    }
    const stored = sessionStorage.getItem(SCENARIO_KEY);
    if (stored && (SCENARIOS as string[]).includes(stored)) return stored as MockScenario;
  } catch {
    /* storage unavailable: fall through to the default */
  }
  return 'dashboard';
}

function serviceForScenario(scenario: MockScenario): ServiceStatus {
  const service = seedService();
  const personalInstall = {
    command: 'ezz service install',
    needsElevation: false,
    shell: null,
  };

  if (scenario === 'service-stopped') {
    service.backgroundService = {
      ...service.backgroundService,
      running: false,
      connected: false,
      pid: null,
      version: null,
      startedAt: null,
      jobsRunningHere: true,
    };
  }

  if (scenario === 'service-stopped-by-you') {
    service.bootMode = 'personal';
    service.install = personalInstall;
    service.backgroundService = {
      ...service.backgroundService,
      running: false,
      connected: false,
      pid: null,
      version: null,
      startedAt: null,
      jobsRunningHere: true,
      mechanism: 'startup-supervisor',
      mode: 'personal',
      installed: true,
      startsAt: 'logon',
      stoppedByUser: true,
      stoppedAt: new Date(Date.now() - 3_600_000).toISOString(),
    };
  }

  if (scenario === 'service-not-installed') {
    service.bootMode = null;
    service.install = personalInstall;
    service.backgroundService = {
      running: false,
      connected: false,
      pid: null,
      version: null,
      startedAt: null,
      jobsRunningHere: true,
      mechanism: 'startup-supervisor',
      mode: 'personal',
      installed: false,
      startsAt: 'logon',
      stoppedByUser: false,
      stoppedAt: null,
      runtime: null,
      warnings: [],
    };
  }

  return service;
}

function createState(scenario: MockScenario): MockState {
  const domains = seedDomains();
  const apps = seedApps();
  const permissions = seedPermissions();
  const settings = seedSettings();

  const authenticated =
    scenario === 'dashboard' || scenario === 'none' || scenario.startsWith('service-');
  const firstRun = scenario === 'setup' || scenario === 'setupcode';

  return {
    scenario,
    authenticated,
    authMode: scenario === 'none' ? 'none' : 'password',
    setupConfigured: !firstRun,
    hasPassword: !firstRun,
    domains,
    certs: seedCertificates(),
    channels: seedChannels(),
    nginx: seedNginxStatus(),
    configs: seedNginxConfigs(),
    errorLog: seedErrorLog(),
    accessLog: seedAccessLog(),
    processes: { ...seedProcesses(), apps },
    service: serviceForScenario(scenario),
    settings: {
      ...settings,
      dashboardAuth: scenario === 'none' ? 'none' : 'password',
      canUseNoPassword: true,
    },
    hub: seedHub(permissions),
    pendingDns: {},
  };
}

let state: MockState | null = null;

function storageKey(scenario: MockScenario): string {
  return `${STORAGE_PREFIX}:${scenario}`;
}

function getState(): MockState {
  if (state) return state;
  const scenario = readScenario();
  try {
    const raw = sessionStorage.getItem(storageKey(scenario));
    if (raw) {
      const parsed = JSON.parse(raw) as MockState;
      if (parsed && parsed.scenario === scenario) {
        state = parsed;
        return state;
      }
    }
  } catch {
    /* corrupt or unavailable: reseed */
  }
  state = createState(scenario);
  persist();
  return state;
}

function persist(): void {
  if (!state) return;
  try {
    sessionStorage.setItem(storageKey(state.scenario), JSON.stringify(state));
  } catch {
    /* over quota or blocked: keep the in-memory copy */
  }
}

const clone = <T>(value: T): T => structuredClone(value);

function delay(ms?: number): Promise<void> {
  const wait = ms ?? 140 + Math.random() * 180;
  return new Promise((resolve) => setTimeout(resolve, wait));
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}): never {
  throw new ApiError(status, { error, ...extra });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function requireAuth(s: MockState): void {
  if (s.authMode !== 'none' && !s.authenticated) {
    throw new ApiError(401, { error: 'Unauthorized' });
  }
}

function normalisePermissions(input: unknown): PermissionMap {
  const stored = asRecord(input);
  const map: PermissionMap = {};
  for (const group of PERMISSION_TREE) {
    for (const child of group.children) {
      map[child.id] = !child.comingSoon && stored[child.id] === true;
    }
  }
  return map;
}

function normaliseNotifications(input: unknown): DomainNotifications {
  const stored = asRecord(input);
  const result = defaultNotifications();
  for (const type of ['nginx_down', 'cert_expiry', 'domain_health'] as const) {
    const entry = asRecord(stored[type]);
    if (typeof entry.enabled === 'boolean') result[type].enabled = entry.enabled;
    if (Array.isArray(entry.channelIds)) {
      result[type].channelIds = entry.channelIds.filter((id): id is string => typeof id === 'string');
    }
  }
  return result;
}

function certStatus(daysLeft: number | null): Certificate['status'] {
  if (daysLeft === null) return 'error';
  if (daysLeft <= 0) return 'expired';
  if (daysLeft < 30) return 'expiring';
  return 'valid';
}

function upsertCertificate(s: MockState, name: string, days = 90): void {
  const daysLeft = days;
  s.certs = s.certs.filter((c) => c.domain !== name);
  s.certs.push({
    domain: name,
    expiry: isoDaysFromNow(days),
    daysLeft,
    status: certStatus(daysLeft),
  });
}

function emptyDomain(input: Record<string, unknown>): Domain {
  const name = String(input.name ?? '').trim();
  const now = new Date().toISOString();
  const ssl = asRecord(input.ssl);
  const performance = asRecord(input.performance);
  const security = asRecord(input.security);
  const advanced = asRecord(input.advanced);
  const defaults = seedDomains()[2];

  return {
    name,
    port: Number(input.port ?? 80),
    backendHost: String(input.backendHost ?? defaults.backendHost),
    upstreamType: (input.upstreamType as Domain['upstreamType']) ?? 'http',
    www: Boolean(input.www ?? false),
    wildcard: Boolean(input.wildcard ?? false),
    enabled: true,
    configFile: `/etc/nginx/conf.d/${name}.conf`,
    createdAt: now,
    updatedAt: now,
    ssl: {
      enabled: Boolean(ssl.enabled ?? false),
      certPath: String(ssl.certPath ?? ''),
      keyPath: String(ssl.keyPath ?? ''),
      redirect: Boolean(ssl.redirect ?? true),
      hsts: Boolean(ssl.hsts ?? false),
      hstsMaxAge: Number(ssl.hstsMaxAge ?? 31_536_000),
    },
    performance: {
      ...defaults.performance,
      ...(performance as Partial<Domain['performance']>),
    },
    security: {
      ...defaults.security,
      ...(security as Partial<Domain['security']>),
    },
    advanced: {
      ...defaults.advanced,
      ...(advanced as Partial<Domain['advanced']>),
    },
    certExpiry: null,
    daysLeft: null,
    notifications: normaliseNotifications(input.notifications),
  };
}

function sslShapeCheck(s: MockState, domain: Domain): void {
  if (domain.ssl.enabled && domain.ssl.certPath) {
    const known =
      s.certs.some((c) => c.domain === domain.name) ||
      s.domains.some((d) => d.ssl.certPath === domain.ssl.certPath && d.name !== domain.name);
    if (!known) {
      throw new ApiError(422, {
        error: 'cert_missing',
        certPath: domain.ssl.certPath,
        keyPath: domain.ssl.keyPath,
        hint: 'The SSL certificate files do not exist at the configured paths. Create the certificate first, or disable SSL.',
      });
    }
  }
}

function nginxTestOutput(): string {
  return [
    'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok',
    'nginx: configuration file /etc/nginx/nginx.conf test is successful',
  ].join('\n');
}

function processLogLines(name: string): string[] {
  const now = Date.now();
  const stamp = (offset: number) => new Date(now - offset).toISOString().slice(11, 19);
  return [
    `${stamp(120_000)} PM2 | ${name} starting…`,
    `${stamp(118_000)} ${name} | server listening on port 3000`,
    `${stamp(60_000)} ${name} | GET /health 200 3ms`,
    `${stamp(12_000)} ${name} | GET /api/items 200 18ms`,
  ];
}

function getAuthPayload(s: MockState) {
  return {
    authenticated: s.authMode === 'none' ? true : s.authenticated,
    needsSetup: s.authMode === 'password' && !s.hasPassword,
    authMode: s.authMode,
    canUseNoPassword: s.settings.bindsToLoopbackOnly,
    bindAddress: s.settings.dashboardBindAddress,
    minPasswordLength: 6,
    ...(s.scenario === 'setupcode' && !s.setupConfigured ? { setupCodeRequired: true } : {}),
  };
}

// ─── Request router ──────────────────────────────────────────────────────────

function handle(
  method: HttpMethod,
  path: string,
  body: unknown,
  query: QueryParams
): unknown {
  const s = getState();
  const data = asRecord(body);

  // Public auth surface.
  if (path === '/auth' && method === 'GET') return getAuthPayload(s);

  if (path === '/login' && method === 'POST') {
    if (s.authMode === 'none') {
      fail(409, 'This dashboard is configured without a password.', { authMode: 'none' });
    }
    if (!s.hasPassword) {
      fail(401, 'No dashboard password is set. Set one to continue.', { needsSetup: true });
    }
    const password = String(data.password ?? '');
    if (!password) fail(401, 'Invalid password');
    s.authenticated = true;
    persist();
    return { ok: true };
  }

  if (path === '/setup' && method === 'POST') {
    if (s.setupConfigured) {
      fail(409, 'This dashboard is already configured. Sign in, then change it in Settings.');
    }
    if (data.mode === 'none') {
      s.authMode = 'none';
      s.setupConfigured = true;
      s.authenticated = true;
      s.settings.dashboardAuth = 'none';
      persist();
      return { ok: true, authMode: 'none' };
    }
    const password = String(data.password ?? '');
    if (password.length < 6) {
      fail(400, 'Password must be at least 6 characters long.');
    }
    if (s.scenario === 'setupcode' && data.setupCode !== '123456') {
      fail(400, 'That setup code is not valid.');
    }
    s.authMode = 'password';
    s.setupConfigured = true;
    s.hasPassword = true;
    s.authenticated = true;
    s.settings.dashboardAuth = 'password';
    s.settings.hasPassword = true;
    persist();
    return { ok: true, authMode: 'password' };
  }

  if (path === '/logout' && method === 'POST') {
    s.authenticated = false;
    persist();
    return { ok: true };
  }

  requireAuth(s);

  // ── Domains ───────────────────────────────────────────────────────────────
  if (path === '/domains' && method === 'GET') return s.domains;

  if (path === '/domains' && method === 'POST') {
    const name = String(data.name ?? '').trim();
    if (!name) fail(400, 'Domain name is required.');
    if (s.domains.some((d) => d.name === name)) fail(409, `Domain already exists: ${name}`);
    if (Number.isNaN(Number(data.port)) || Number(data.port) < 1 || Number(data.port) > 65535) {
      fail(400, 'Port must be between 1 and 65535.');
    }
    const created = emptyDomain(data);
    sslShapeCheck(s, created);
    s.domains.push(created);
    persist();
    return created;
  }

  const domainMatch = /^\/domains\/([^/]+)(\/[a-z]+)?$/.exec(path);
  if (domainMatch) {
    const name = decodeURIComponent(domainMatch[1]);
    const suffix = domainMatch[2] ?? '';
    const index = s.domains.findIndex((d) => d.name === name);
    const existing = index >= 0 ? s.domains[index] : undefined;

    if (suffix === '/notifications') {
      if (!existing) fail(404, `Domain not found: ${name}`);
      if (method === 'GET') return existing.notifications;
      if (method === 'PUT') {
        existing.notifications = normaliseNotifications(data);
        persist();
        return existing.notifications;
      }
    }

    if (suffix === '/toggle' && method === 'PUT') {
      if (!existing) fail(404, `Domain not found: ${name}`);
      existing.enabled = !existing.enabled;
      existing.configFile = existing.enabled
        ? `/etc/nginx/conf.d/${name}.conf`
        : `/etc/nginx/conf.d/${name}.conf.disabled`;
      existing.updatedAt = new Date().toISOString();
      persist();
      return { enabled: existing.enabled };
    }

    if (suffix === '/reload' && method === 'POST') {
      if (!existing) fail(404, `Domain not found: ${name}`);
      return { message: 'nginx reloaded successfully' };
    }

    if (suffix && suffix !== '/notifications' && suffix !== '/toggle' && suffix !== '/reload') {
      fail(404, 'Not found');
    }

    if (!suffix && method === 'PUT') {
      if (!existing) fail(404, `Domain not found: ${name}`);
      const merged: Domain = {
        ...existing,
        ...(data as Partial<Domain>),
        name,
        updatedAt: new Date().toISOString(),
        ssl: { ...existing.ssl, ...asRecord(data.ssl) },
        performance: { ...existing.performance, ...asRecord(data.performance) },
        security: { ...existing.security, ...asRecord(data.security) },
        advanced: { ...existing.advanced, ...asRecord(data.advanced) },
        notifications: data.notifications
          ? normaliseNotifications(data.notifications)
          : existing.notifications,
      };
      sslShapeCheck(s, merged);
      s.domains[index] = merged;
      persist();
      return merged;
    }

    if (!suffix && method === 'DELETE') {
      if (!existing) fail(404, `Domain not found: ${name}`);
      const deleteCert = query?.deleteCert === true || query?.deleteCert === 'true';
      s.domains.splice(index, 1);
      if (deleteCert) s.certs = s.certs.filter((c) => c.domain !== name);
      persist();
      return { deleted: name, certDeleted: Boolean(deleteCert) };
    }
  }

  // ── SSL ───────────────────────────────────────────────────────────────────
  if (path === '/ssl' && method === 'GET') return s.certs;

  if (path === '/ssl/create' && method === 'POST') {
    const input = data as unknown as SslCreateInput;
    const name = String(input.domain ?? '').trim();
    if (!name) fail(400, 'domain is required');

    if (input.validationMethod === 'dns') {
      const token = Math.random().toString(36).slice(2, 12);
      s.pendingDns[name] = {
        txtName: `_acme-challenge.${name.replace(/^\*\./, '')}`,
        txtValue: `${token}${token.split('').reverse().join('')}`,
      };
      persist();
      return {
        status: 'waiting_dns',
        domain: name,
        txtName: s.pendingDns[name].txtName,
        txtValue: s.pendingDns[name].txtValue,
        hint: 'Add a DNS TXT record with the name and value above, then confirm.',
      };
    }

    upsertCertificate(s, name, 90);
    persist();
    return {
      success: true,
      certPath: `/etc/easy-devops/ssl/${name}/fullchain.pem`,
      keyPath: `/etc/easy-devops/ssl/${name}/privkey.pem`,
      mode: 'proxy',
      fellBack: false,
      nginxDownMs: 0,
      staging: false,
      summary:
        'The HTTP-01 challenge was answered through nginx, so nginx stayed running for the whole issuance.',
    };
  }

  if (path === '/ssl/create-confirm' && method === 'POST') {
    const name = String(data.domain ?? '').trim();
    if (!s.pendingDns[name]) {
      fail(404, 'No DNS challenge is pending for this domain. Start a new certificate issuance.', {
        error: 'no_pending_challenge',
      });
    }
    delete s.pendingDns[name];
    upsertCertificate(s, name, 90);
    persist();
    return {
      success: true,
      certPath: `/etc/easy-devops/ssl/${name}/fullchain.pem`,
      keyPath: `/etc/easy-devops/ssl/${name}/privkey.pem`,
      mode: 'dns',
      staging: false,
      summary: 'The DNS TXT record was found and the certificate was issued.',
    };
  }

  if (path === '/ssl/create-cancel' && method === 'POST') {
    const name = String(data.domain ?? '').trim();
    if (!s.pendingDns[name]) {
      fail(404, 'No DNS challenge is pending for this domain.', { error: 'no_pending_challenge' });
    }
    delete s.pendingDns[name];
    persist();
    return { cancelled: true };
  }

  const renewMatch = /^\/ssl\/renew\/([^/]+)$/.exec(path);
  if (renewMatch && method === 'POST') {
    const name = decodeURIComponent(renewMatch[1]);
    if (!s.certs.some((c) => c.domain === name)) fail(404, `Domain '${name}' not found`);
    upsertCertificate(s, name, 90);
    persist();
    return {
      success: true,
      certPath: `/etc/easy-devops/ssl/${name}/fullchain.pem`,
      keyPath: `/etc/easy-devops/ssl/${name}/privkey.pem`,
      mode: 'proxy',
      fellBack: false,
      nginxDownMs: 0,
      staging: false,
      summary: 'Renewed over HTTP-01 with nginx serving the challenge.',
    };
  }

  if (path === '/ssl/renew-all' && method === 'POST') {
    const expiring = s.certs.filter((c) => c.daysLeft !== null && c.daysLeft < 30);
    const results = expiring.map((cert) => {
      const days = cert.daysLeft !== null && cert.daysLeft < 0 ? 90 : 90;
      upsertCertificate(s, cert.domain, days);
      return {
        domain: cert.domain,
        success: true,
        certPath: `/etc/easy-devops/ssl/${cert.domain}/fullchain.pem`,
        keyPath: `/etc/easy-devops/ssl/${cert.domain}/privkey.pem`,
        mode: 'proxy',
        fellBack: false,
        nginxDownMs: 0,
        configRegenerated: false,
        summary: 'Renewed over HTTP-01 with nginx serving the challenge.',
      };
    });
    persist();
    return results;
  }

  // ── Nginx ─────────────────────────────────────────────────────────────────
  if (path === '/nginx/status' && method === 'GET') return s.nginx;

  if (path === '/nginx/configs' && method === 'GET') return Object.keys(s.configs);

  if (path === '/nginx/logs' && method === 'GET') return { lines: s.errorLog };

  const configMatch = /^\/nginx\/config\/([^/]+)$/.exec(path);
  if (configMatch) {
    const filename = decodeURIComponent(configMatch[1]);
    if (method === 'GET') {
      const content = s.configs[filename];
      if (content === undefined) throw new ApiError(404, { error: 'Config file not found' });
      return { content };
    }
    if (method === 'POST') {
      const content = String(data.content ?? '');
      if (content.includes('definitely-broken')) {
        throw new ApiError(400, {
          error: 'nginx config test failed',
          success: false,
          output:
            'nginx: [emerg] unknown directive "definitely-broken" in /etc/nginx/conf.d/' +
            filename +
            ':1\nnginx: configuration file /etc/nginx/nginx.conf test failed\nThe previous file was restored.',
        });
      }
      s.configs[filename] = content;
      persist();
      return { success: true, output: nginxTestOutput() };
    }
  }

  const nginxAction = /^\/nginx\/(start|stop|restart|reload|test)$/.exec(path);
  if (nginxAction && method === 'POST') {
    const action = nginxAction[1];
    if (action === 'start') s.nginx = { ...s.nginx, running: true, pid: s.nginx.pid ?? 1421 };
    if (action === 'stop') s.nginx = { ...s.nginx, running: false, pid: null };
    if (action === 'test') persist();
    if (action !== 'test') persist();
    return { success: true, output: action === 'test' ? nginxTestOutput() : `nginx ${action}: ok` };
  }

  // ── Processes & service ───────────────────────────────────────────────────
  if (path === '/processes' && method === 'GET') return s.processes;

  if (path === '/service' && method === 'GET') return s.service;

  const processMatch = /^\/processes\/([^/]+)\/(logs|start|stop|restart|reload)$/.exec(path);
  if (processMatch) {
    const name = decodeURIComponent(processMatch[1]);
    const action = processMatch[2];
    const app = s.processes.apps.find((a) => a.name === name);
    if (!app && action !== 'logs') fail(404, `PM2 has no process named "${name}"`);

    if (action === 'logs' && method === 'GET') {
      if (!app) fail(404, `PM2 has no process named "${name}"`);
      return { name, lines: processLogLines(name) };
    }

    if (method === 'POST' && app) {
      if (action === 'stop') {
        app.status = 'stopped';
        app.pid = null;
        app.cpu = null;
        app.memoryBytes = null;
        app.uptimeMs = null;
      } else {
        app.status = 'online';
        app.pid = 2000 + Math.floor(Math.random() * 800);
        app.cpu = 0.4;
        app.memoryBytes = 90_000_000;
        app.uptimeMs = 1_000;
        app.startedAt = Date.now();
        if (action === 'restart' || action === 'reload') app.restarts += 1;
      }
      persist();
      return {
        ok: true,
        name,
        action: action as ProcessAction,
        managed: app.managed,
        output: `pm2 ${action} ${name}: ok`,
      };
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  if (path === '/settings' && method === 'GET') return s.settings;

  if (path === '/settings' && method === 'POST') {
    const next = { ...s.settings };
    let needsRestart = false;

    if (data.dashboardPort !== undefined) {
      const port = Number(data.dashboardPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        fail(400, 'Port must be between 1 and 65535.');
      }
      if (port !== s.settings.dashboardPort) needsRestart = true;
      next.dashboardPort = port;
    }
    if (data.dashboardPassword !== undefined) {
      const password = String(data.dashboardPassword);
      if (password.length < 6) fail(400, 'Password must be at least 6 characters long.');
      next.hasPassword = true;
      next.dashboardAuth = 'password';
      s.hasPassword = true;
      s.authMode = 'password';
    }
    if (data.dashboardBindAddress !== undefined) {
      const bind = String(data.dashboardBindAddress);
      if (!['127.0.0.1', '0.0.0.0', '::1'].includes(bind)) {
        fail(400, 'Bind address must be 127.0.0.1 (this machine only) or 0.0.0.0 (all interfaces)');
      }
      if (bind !== s.settings.dashboardBindAddress) needsRestart = true;
      next.dashboardBindAddress = bind;
      next.bindsToLoopbackOnly = bind !== '0.0.0.0';
    }
    if (data.dashboardAuth !== undefined) {
      if (!['password', 'none'].includes(String(data.dashboardAuth))) {
        fail(400, "Authentication must be 'password' or 'none'");
      }
      next.dashboardAuth = data.dashboardAuth as 'password' | 'none';
    }
    if (data.nginxDir !== undefined) {
      const value = String(data.nginxDir).trim();
      if (!value) fail(400, 'Nginx directory must be a non-empty string');
      next.nginxDir = value;
    }
    if (data.sslDir !== undefined) {
      const value = String(data.sslDir).trim();
      if (!value) fail(400, 'SSL directory must be a non-empty string');
      next.sslDir = value;
    }
    if (data.acmeEmail !== undefined) {
      const value = String(data.acmeEmail).trim();
      if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        fail(400, 'Enter a valid email address.');
      }
      next.acmeEmail = value;
    }

    const nextAuth = next.dashboardAuth;
    const nextBind = next.dashboardBindAddress;
    if (nextAuth === 'none' && nextBind === '0.0.0.0') {
      fail(
        400,
        'Running without a password requires the dashboard to listen on this machine only.',
        { reason: 'no_auth_requires_loopback' }
      );
    }

    s.settings = next;
    s.authMode = nextAuth;
    persist();
    return { success: true, needsRestart, dashboardAuth: nextAuth };
  }

  if (path === '/settings/permissions' && method === 'GET') return { configured: true };

  if (path === '/settings/permissions/setup' && method === 'POST') {
    if (String(data.password ?? '') === 'wrong') {
      throw new ApiError(401, { error: 'Incorrect password', output: 'Sorry, try again.' });
    }
    return { success: true };
  }

  if (path === '/settings/backup' && method === 'GET') {
    const { hasPassword: _hasPassword, ...safeSettings } = s.settings;
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      config: safeSettings,
      domains: s.domains,
    };
  }

  if (path === '/settings/restore' && method === 'POST') {
    const incoming = asRecord(data);
    if (!incoming.config || typeof incoming.config !== 'object') {
      fail(400, 'Invalid backup: missing config');
    }
    if (Array.isArray(incoming.domains)) {
      s.domains = incoming.domains as Domain[];
    }
    const config = asRecord(incoming.config);
    s.settings = {
      ...s.settings,
      ...(config as Partial<Settings>),
      dashboardAuth: s.settings.dashboardAuth,
      dashboardBindAddress: s.settings.dashboardBindAddress,
      hasPassword: s.hasPassword,
    };
    persist();
    return { success: true };
  }

  if (path === '/settings/channels' && method === 'GET') return s.channels;

  if (path === '/settings/channels' && method === 'POST') {
    const input = data as unknown as ChannelInput;
    if (!input.name?.trim()) fail(400, 'Channel name is required.');
    if (input.type !== 'discord' && input.type !== 'telegram') {
      fail(400, 'Channel type must be discord or telegram.');
    }
    if (input.type === 'discord' && !input.webhookUrl?.trim()) {
      fail(400, 'Discord channels require a webhookUrl.');
    }
    if (input.type === 'telegram' && (!input.botToken?.trim() || !input.chatId?.trim())) {
      fail(400, 'Telegram channels require a botToken and a chatId.');
    }
    const channel: NotificationChannel = {
      id: `ch-${crypto.randomUUID()}`,
      name: input.name.trim(),
      type: input.type,
      ...(input.type === 'discord'
        ? { webhookUrl: input.webhookUrl?.trim() }
        : { botToken: input.botToken?.trim(), chatId: input.chatId?.trim() }),
      ...(input.message?.trim() ? { message: input.message.trim() } : {}),
    };
    s.channels.push(channel);
    persist();
    return channel;
  }

  const channelMatch = /^\/settings\/channels\/([^/]+)(\/test)?$/.exec(path);
  if (channelMatch) {
    const id = decodeURIComponent(channelMatch[1]);
    const isTest = Boolean(channelMatch[2]);
    const index = s.channels.findIndex((c) => c.id === id);
    if (index === -1) fail(404, 'Channel not found');

    if (isTest && method === 'POST') {
      if (s.channels[index].name.toLowerCase().includes('broken')) {
        fail(500, 'Webhook returned 404 Not Found.');
      }
      return { success: true };
    }
    if (!isTest && method === 'PUT') {
      const existing = s.channels[index];
      const updated: NotificationChannel = {
        ...existing,
        ...(data.name !== undefined ? { name: String(data.name).trim() } : {}),
        ...(existing.type === 'discord' && data.webhookUrl !== undefined
          ? { webhookUrl: String(data.webhookUrl).trim() }
          : {}),
        ...(existing.type === 'telegram' && data.botToken !== undefined
          ? { botToken: String(data.botToken).trim() }
          : {}),
        ...(existing.type === 'telegram' && data.chatId !== undefined
          ? { chatId: String(data.chatId).trim() }
          : {}),
        ...(data.message !== undefined
          ? String(data.message).trim()
            ? { message: String(data.message).trim() }
            : { message: undefined }
          : {}),
      };
      if (!updated.name) fail(400, 'Channel name cannot be empty.');
      s.channels[index] = updated;
      persist();
      return updated;
    }
    if (!isTest && method === 'DELETE') {
      s.channels.splice(index, 1);
      persist();
      return { deleted: id };
    }
  }

  // ── Hub ───────────────────────────────────────────────────────────────────
  if (path === '/hub/status' && method === 'GET') {
    return { ...s.hub, tree: PERMISSION_TREE, comingSoon: COMING_SOON_IDS };
  }

  if (path === '/hub/connect' && method === 'POST') {
    const connectionString = String(data.connectionString ?? '');
    const parsed = /^ezops:\/\/([^|\s]+)\|([^|\s]+)\|([^|\s]+)$/.exec(connectionString);
    if (!parsed) {
      fail(400, 'Paste the connection string exactly as the Hub shows it, including the ezops:// prefix.');
    }
    s.hub = {
      ...seedHub(normalisePermissions({})),
      linked: true,
      hubUrl: parsed[1].startsWith('http') ? parsed[1] : `https://${parsed[1]}`,
      serverId: parsed[2],
      connected: true,
      status: 'connected',
    };
    persist();
    return { ok: true, status: { ...s.hub, tree: PERMISSION_TREE, comingSoon: COMING_SOON_IDS } };
  }

  if (path === '/hub/link' && method === 'DELETE') {
    s.hub = {
      ...s.hub,
      linked: false,
      hubUrl: null,
      serverId: null,
      connected: false,
      status: 'not_linked',
      permissions: normalisePermissions({}),
      lastError: null,
      attempts: 0,
    };
    persist();
    return { ok: true };
  }

  if (path === '/hub/permissions' && method === 'PUT') {
    const permissions = normalisePermissions({ ...s.hub.permissions, ...data });
    s.hub = {
      ...s.hub,
      permissions,
      tree: PERMISSION_TREE,
      comingSoon: COMING_SOON_IDS,
    };
    persist();
    return { permissions, tree: PERMISSION_TREE, comingSoon: COMING_SOON_IDS };
  }

  throw new ApiError(404, { error: `Not found: ${method} ${path}` });
}

/** Entry point used by lib/api.ts when VITE_MOCK=1. */
export async function mockRequest<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  query?: QueryParams
): Promise<T> {
  const slow = path.startsWith('/ssl/') || path === '/settings/restore';
  await delay(slow ? 650 + Math.random() * 400 : undefined);
  const result = handle(method, path, body, query ?? {});
  return clone(result) as T;
}

export function resetMockState(): void {
  const scenario = readScenario();
  state = createState(scenario);
  persist();
}
