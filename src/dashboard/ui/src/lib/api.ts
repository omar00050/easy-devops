/**
 * lib/api.ts — the only place that talks HTTP.
 *
 * Follows API-CONTRACT.md exactly:
 *   - session cookie, same-origin;
 *   - `X-EZ-Request: 1` on every state-changing request (and on the socket
 *     handshake, see lib/socket.ts);
 *   - 401 means the session ended → notify AuthProvider, which returns to the
 *     login screen with a short message;
 *   - 403 means the origin guard refused the request → surface "request
 *     blocked" with the contract's reason; it must NOT bounce to login.
 *
 * A mock adapter is selected at build/dev time with VITE_MOCK=1.
 */

import type {
  AuthMode,
  AuthStatus,
  BackupFile,
  Certificate,
  CertificateDeleteResult,
  ChannelInput,
  DeployApp,
  DeployAppCreated,
  DeployAppDetail,
  DeployAppInput,
  DeployDomainLink,
  DeployDomainLinkInput,
  DeployKeyGithubResult,
  DeployKeyRegenerateResult,
  DeployKeyTestResult,
  DeployMoveResult,
  DeployGithubApplyInput,
  DeployGithubApplyResult,
  DeployGithubSetup,
  DeployHook,
  DeployHookUpdate,
  DeployRunDetail,
  DeployStarted,
  DeploymentsResponse,
  DnsChallengePending,
  Domain,
  DomainDeleteResult,
  DomainInput,
  DomainNotifications,
  HubConnectResponse,
  HubPermissionsResponse,
  HubStatus,
  IssuanceSuccess,
  NginxCommandResult,
  NginxConfig,
  NginxLogs,
  NginxStatus,
  NotificationChannel,
  PermissionsSetupResult,
  PermissionsSetupStatus,
  ProcessAction,
  ProcessActionResponse,
  ProcessLogs,
  ProcessesResponse,
  RenewAllResult,
  ServiceActionResponse,
  ServiceStatus,
  Settings,
  SettingsUpdate,
  SettingsUpdateResult,
  SslCreateInput,
  SslSuggestion,
  ApiErrorPayload,
  UpdateCheck,
  UpdateStartResponse,
  UpdateStatusResponse,
} from './types';
import { ApiError } from './errors';

export { ApiError } from './errors';

const API_BASE = '/api';
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const MOCK_ENABLED = import.meta.env.VITE_MOCK === '1';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// ─── Auth / origin events ────────────────────────────────────────────────────

export const SESSION_ENDED_MESSAGE = 'Your session ended. Please sign in again.';

const unauthorizedListeners = new Set<(message: string) => void>();
const forbiddenListeners = new Set<(error: ApiError) => void>();

/** Called on 401 from a protected endpoint. Returns an unsubscribe function. */
export function onApiUnauthorized(listener: (message: string) => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** Called on 403 from the local-request guard. Returns an unsubscribe function. */
export function onApiForbidden(listener: (error: ApiError) => void): () => void {
  forbiddenListeners.add(listener);
  return () => forbiddenListeners.delete(listener);
}

// ─── Request plumbing ────────────────────────────────────────────────────────

interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
  /** Login and first-run setup report 401 for their own reasons. */
  skipAuthEvents?: boolean;
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

function buildQuery(query?: QueryParams): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

async function parseBody(response: Response): Promise<ApiErrorPayload> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as ApiErrorPayload) : { error: String(parsed) };
  } catch {
    // A proxy or a crash page instead of JSON. Keep a short hint only.
    return { error: text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) };
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';

  if (MOCK_ENABLED) {
    const { mockRequest } = await import('./mock');
    return mockRequest<T>(method, path, options.body, options.query);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (STATE_CHANGING.has(method)) headers['X-EZ-Request'] = '1';

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}${buildQuery(options.query)}`, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError(0, { error: 'Cannot reach the dashboard.' });
  }

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    const payload = await parseBody(response);
    const error = new ApiError(response.status, payload);

    if (!options.skipAuthEvents) {
      if (response.status === 401) {
        for (const listener of unauthorizedListeners) listener(SESSION_ENDED_MESSAGE);
      } else if (response.status === 403) {
        for (const listener of forbiddenListeners) listener(error);
      }
    }

    throw error;
  }

  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

type LoginResult = { ok: true };
type SetupResult = { ok: true; authMode: AuthMode };

export const api = {
  auth: {
    status: (signal?: AbortSignal) => request<AuthStatus>('/auth', { signal }),
    login: (password: string) =>
      request<LoginResult>('/login', { method: 'POST', body: { password }, skipAuthEvents: true }),
    setup: (input: { password?: string; mode?: AuthMode; setupCode?: string }) =>
      request<SetupResult>('/setup', { method: 'POST', body: input, skipAuthEvents: true }),
    logout: () => request<LoginResult>('/logout', { method: 'POST' }),
  },

  domains: {
    list: (signal?: AbortSignal) => request<Domain[]>('/domains', { signal }),
    create: (input: DomainInput) => request<Domain>('/domains', { method: 'POST', body: input }),
    update: (name: string, input: DomainInput) =>
      request<Domain>(`/domains/${enc(name)}`, { method: 'PUT', body: input }),
    remove: (name: string, deleteCert: boolean) =>
      request<DomainDeleteResult>(`/domains/${enc(name)}`, {
        method: 'DELETE',
        query: { deleteCert },
      }),
    toggle: (name: string) =>
      request<{ enabled: boolean }>(`/domains/${enc(name)}/toggle`, { method: 'PUT' }),
    reload: (name: string) =>
      request<{ message: string }>(`/domains/${enc(name)}/reload`, { method: 'POST' }),
    notifications: (name: string, signal?: AbortSignal) =>
      request<DomainNotifications>(`/domains/${enc(name)}/notifications`, { signal }),
    saveNotifications: (name: string, input: DomainNotifications) =>
      request<DomainNotifications>(`/domains/${enc(name)}/notifications`, {
        method: 'PUT',
        body: input,
      }),
    sslSuggestion: (name: string, signal?: AbortSignal) =>
      request<SslSuggestion>(`/domains/${enc(name)}/ssl-suggestion`, { signal }),
  },

  ssl: {
    list: (signal?: AbortSignal) => request<Certificate[]>('/ssl', { signal }),
    create: (input: SslCreateInput) =>
      request<IssuanceSuccess | DnsChallengePending>('/ssl/create', { method: 'POST', body: input }),
    confirmDns: (domain: string) =>
      request<IssuanceSuccess>('/ssl/create-confirm', { method: 'POST', body: { domain } }),
    cancelDns: (domain: string) =>
      request<{ cancelled: true }>('/ssl/create-cancel', { method: 'POST', body: { domain } }),
    renew: (domain: string, opId?: string) =>
      request<IssuanceSuccess>(`/ssl/renew/${enc(domain)}`, {
        method: 'POST',
        body: opId ? { opId } : {},
      }),
    renewAll: (opId?: string) =>
      request<RenewAllResult[]>('/ssl/renew-all', {
        method: 'POST',
        body: opId ? { opId } : {},
      }),
    remove: (domain: string) =>
      request<CertificateDeleteResult>(`/ssl/${enc(domain)}`, { method: 'DELETE' }),
  },

  nginx: {
    status: (signal?: AbortSignal) => request<NginxStatus>('/nginx/status', { signal }),
    reload: () => request<NginxCommandResult>('/nginx/reload', { method: 'POST' }),
    restart: () => request<NginxCommandResult>('/nginx/restart', { method: 'POST' }),
    start: () => request<NginxCommandResult>('/nginx/start', { method: 'POST' }),
    stop: () => request<NginxCommandResult>('/nginx/stop', { method: 'POST' }),
    test: () => request<NginxCommandResult>('/nginx/test', { method: 'POST' }),
    configs: (signal?: AbortSignal) => request<string[]>('/nginx/configs', { signal }),
    getConfig: (filename: string, signal?: AbortSignal) =>
      request<NginxConfig>(`/nginx/config/${enc(filename)}`, { signal }),
    saveConfig: (filename: string, content: string) =>
      request<NginxCommandResult>(`/nginx/config/${enc(filename)}`, {
        method: 'POST',
        body: { content },
      }),
    logs: (signal?: AbortSignal) => request<NginxLogs>('/nginx/logs', { signal }),
  },

  processes: {
    list: (signal?: AbortSignal) => request<ProcessesResponse>('/processes', { signal }),
    action: (name: string, action: ProcessAction) =>
      request<ProcessActionResponse>(`/processes/${enc(name)}/${action}`, { method: 'POST' }),
    logs: (name: string, lines = 200, signal?: AbortSignal) =>
      request<ProcessLogs>(`/processes/${enc(name)}/logs`, { signal, query: { lines } }),
  },

  deployments: {
    list: (signal?: AbortSignal) => request<DeploymentsResponse>('/deployments', { signal }),
    get: (id: string, signal?: AbortSignal) =>
      request<DeployAppDetail>(`/deployments/${enc(id)}`, { signal }),
    create: (input: DeployAppInput) =>
      request<DeployAppCreated>('/deployments', { method: 'POST', body: input }),
    update: (id: string, input: DeployAppInput) =>
      request<DeployApp>(`/deployments/${enc(id)}`, { method: 'PUT', body: input }),
    remove: (id: string, options: { deleteDomain?: boolean; purgeData?: boolean } = {}) =>
      request<{
        deleted: string;
        domainDeleted?: boolean;
        warning?: string | null;
        sharedKept?: boolean;
        sharedPath?: string;
      }>(`/deployments/${enc(id)}`, {
        method: 'DELETE',
        query: {
          deleteDomain: options.deleteDomain ? 1 : undefined,
          purgeData: options.purgeData ? 1 : undefined,
        },
      }),
    linkDomain: (id: string, input: DeployDomainLinkInput) =>
      request<DeployDomainLink>(`/deployments/${enc(id)}/domain`, {
        method: 'PUT',
        body: input,
      }),
    unlinkDomain: (id: string) =>
      request<{ unlinked: true }>(`/deployments/${enc(id)}/domain`, { method: 'DELETE' }),
    move: (id: string, path: string) =>
      request<DeployMoveResult>(`/deployments/${enc(id)}/move`, { method: 'POST', body: { path } }),
    deploy: (id: string, ref?: string) =>
      request<DeployStarted>(`/deployments/${enc(id)}/deploy`, {
        method: 'POST',
        body: ref ? { ref } : {},
      }),
    rollback: (id: string, releaseId?: string) =>
      request<DeployStarted>(`/deployments/${enc(id)}/rollback`, {
        method: 'POST',
        body: releaseId ? { releaseId } : {},
      }),
    removeRelease: (id: string, releaseId: string) =>
      request<{ deleted: string }>(`/deployments/${enc(id)}/releases/${enc(releaseId)}`, {
        method: 'DELETE',
      }),
    run: (id: string, runId: string, signal?: AbortSignal) =>
      request<DeployRunDetail>(`/deployments/${enc(id)}/runs/${enc(runId)}`, { signal }),
    issueHookToken: (id: string) =>
      request<{ token: string; tokenHint: string }>(`/deployments/${enc(id)}/hook-token`, {
        method: 'POST',
      }),
    revokeHookToken: (id: string) =>
      request<{ revoked: true }>(`/deployments/${enc(id)}/hook-token`, { method: 'DELETE' }),
    generateDeployKey: (id: string) =>
      request<DeployKeyRegenerateResult>(`/deployments/${enc(id)}/deploy-key`, { method: 'POST' }),
    testDeployKey: (id: string) =>
      request<DeployKeyTestResult>(`/deployments/${enc(id)}/deploy-key/test`, { method: 'POST' }),
    addDeployKeyToGithub: (id: string, token?: string) =>
      request<DeployKeyGithubResult>(`/deployments/${enc(id)}/deploy-key/github`, {
        method: 'POST',
        body: token ? { token } : {},
      }),
    github: (id: string, signal?: AbortSignal) =>
      request<DeployGithubSetup>(`/deployments/${enc(id)}/github`, { signal }),
    applyGithub: (id: string, input: DeployGithubApplyInput) =>
      request<DeployGithubApplyResult>(`/deployments/${enc(id)}/github/apply`, {
        method: 'POST',
        body: input,
      }),
    hook: (signal?: AbortSignal) => request<DeployHook>('/deployments/hook', { signal }),
    updateHook: (input: DeployHookUpdate) =>
      request<DeployHook>('/deployments/hook', { method: 'PUT', body: input }),
  },

  service: {
    status: (signal?: AbortSignal) => request<ServiceStatus>('/service', { signal }),
    start: () => request<ServiceActionResponse>('/service/start', { method: 'POST' }),
    stop: () => request<ServiceActionResponse>('/service/stop', { method: 'POST' }),
    restart: () => request<ServiceActionResponse>('/service/restart', { method: 'POST' }),
  },

  settings: {
    get: (signal?: AbortSignal) => request<Settings>('/settings', { signal }),
    update: (input: SettingsUpdate) =>
      request<SettingsUpdateResult>('/settings', { method: 'POST', body: input }),
    permissions: (signal?: AbortSignal) =>
      request<PermissionsSetupStatus>('/settings/permissions', { signal }),
    setupPermissions: () =>
      request<PermissionsSetupResult>('/settings/permissions/setup', { method: 'POST' }),
    backup: (signal?: AbortSignal) => request<BackupFile>('/settings/backup', { signal }),
    restore: (backup: BackupFile) =>
      request<{ success: true }>('/settings/restore', { method: 'POST', body: backup }),

    channels: {
      list: (signal?: AbortSignal) => request<NotificationChannel[]>('/settings/channels', { signal }),
      create: (input: ChannelInput) =>
        request<NotificationChannel>('/settings/channels', { method: 'POST', body: input }),
      update: (id: string, input: Partial<ChannelInput>) =>
        request<NotificationChannel>(`/settings/channels/${enc(id)}`, {
          method: 'PUT',
          body: input,
        }),
      remove: (id: string) =>
        request<{ deleted: string }>(`/settings/channels/${enc(id)}`, { method: 'DELETE' }),
      test: (id: string) =>
        request<{ success: true }>(`/settings/channels/${enc(id)}/test`, { method: 'POST' }),
    },
  },

  hub: {
    status: (signal?: AbortSignal) => request<HubStatus>('/hub/status', { signal }),
    connect: (connectionString: string) =>
      request<HubConnectResponse>('/hub/connect', {
        method: 'POST',
        body: { connectionString },
      }),
    unlink: () => request<{ ok: true }>('/hub/link', { method: 'DELETE' }),
    updatePermissions: (permissions: Record<string, boolean>) =>
      request<HubPermissionsResponse>('/hub/permissions', { method: 'PUT', body: permissions }),
  },

  update: {
    check: (signal?: AbortSignal) => request<UpdateCheck>('/update', { signal }),
    status: (signal?: AbortSignal) =>
      request<UpdateStatusResponse>('/update/status', { signal }),
    start: (version: string) =>
      request<UpdateStartResponse>('/update', { method: 'POST', body: { version } }),
  },
};
