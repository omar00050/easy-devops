/**
 * lib/types.ts — the wire shapes of docs/api-contract.md, typed.
 *
 * These mirror the contract version the dashboard implements. Nothing here is
 * invented: fields absent from the contract are marked optional, and fields the
 * contract guarantees are required so a missing one is a compile error.
 */

// ─── Auth ────────────────────────────────────────────────────────────────────

export type AuthMode = 'password' | 'none';

export interface AuthStatus {
  authenticated: boolean;
  needsSetup: boolean;
  authMode: AuthMode;
  canUseNoPassword: boolean;
  bindAddress: string;
  minPasswordLength: number;
  /** Advertised by servers that gate first-run setup behind a code. */
  setupCodeRequired?: boolean;
}

// ─── Domains ─────────────────────────────────────────────────────────────────

export type UpstreamType = 'http' | 'https' | 'ws';
export type DomainEventType = 'nginx_down' | 'cert_expiry' | 'domain_health';

export interface DomainEventRouting {
  enabled: boolean;
  channelIds: string[];
}

export type DomainNotifications = Record<DomainEventType, DomainEventRouting>;

export interface DomainSsl {
  enabled: boolean;
  certPath: string;
  keyPath: string;
  redirect: boolean;
  hsts: boolean;
  hstsMaxAge: number;
}

export interface DomainPerformance {
  maxBodySize: string;
  readTimeout: number;
  connectTimeout: number;
  proxyBuffers: boolean;
  gzip: boolean;
  gzipTypes: string;
}

export interface DomainSecurity {
  rateLimit: boolean;
  rateLimitRate: number;
  rateLimitBurst: number;
  securityHeaders: boolean;
  custom404: boolean;
  custom50x: boolean;
}

export interface DomainAdvanced {
  accessLog: boolean;
  customLocations: string;
}

export interface Domain {
  name: string;
  port: number;
  backendHost: string;
  upstreamType: UpstreamType;
  www: boolean;
  wildcard: boolean;
  enabled: boolean;
  configFile: string | null;
  createdAt: string;
  updatedAt: string;
  ssl: DomainSsl;
  performance: DomainPerformance;
  security: DomainSecurity;
  advanced: DomainAdvanced;
  /** Enrichment added by GET /api/domains */
  certExpiry: string | null;
  daysLeft: number | null;
  notifications: DomainNotifications;
  sslPathWarning?: boolean;
}

/** Body accepted by POST /api/domains and PUT /api/domains/:name. */
export type DomainInput = Omit<
  Domain,
  'configFile' | 'createdAt' | 'updatedAt' | 'certExpiry' | 'daysLeft' | 'sslPathWarning'
>;

export interface DomainDeleteResult {
  deleted: string;
  certDeleted: boolean;
}

// ─── SSL ─────────────────────────────────────────────────────────────────────

export type CertStatus = 'valid' | 'expiring' | 'expired' | 'error';

export interface Certificate {
  domain: string;
  expiry: string | null;
  daysLeft: number | null;
  status: CertStatus;
}

export interface IssuanceFailure {
  step?: string;
  cause?: string;
  consequence?: string;
  nginxRunning?: boolean;
  configSaved?: boolean;
}

export interface IssuanceSuccess {
  success: true;
  certPath: string;
  keyPath: string;
  /** 'proxy' when nginx answered the challenge, 'standalone' when it stopped. */
  mode?: string;
  fellBack?: boolean;
  nginxDownMs?: number;
  staging?: boolean;
  summary?: string;
}

export interface DnsChallengePending {
  status: 'waiting_dns';
  domain: string;
  txtName: string;
  txtValue: string;
  hint?: string;
}

export interface RenewAllResult {
  domain: string;
  success: boolean;
  certPath: string | null;
  keyPath: string | null;
  mode?: string;
  fellBack?: boolean;
  nginxDownMs?: number;
  configRegenerated?: boolean;
  summary?: string;
  error?: string | IssuanceFailure;
  detail?: string;
}

export interface SslCreateInput {
  domain: string;
  www?: boolean;
  validationMethod: 'http' | 'dns';
  email?: string | null;
}

// ─── Nginx ───────────────────────────────────────────────────────────────────

export interface NginxStatus {
  running: boolean;
  version: string | null;
  pid: number | null;
  error?: string;
}

export interface NginxCommandResult {
  success: boolean;
  output: string;
}

export interface NginxConfig {
  content: string;
}

export interface NginxLogs {
  lines: string[];
}

// ─── Processes & service ─────────────────────────────────────────────────────

export interface Pm2Info {
  installed: boolean;
  version: string | null;
  path: string | null;
}

export interface ProcessApp {
  name: string;
  pmId: number | null;
  pid: number | null;
  status: string;
  cpu: number | null;
  memoryBytes: number | null;
  startedAt: number | null;
  uptimeMs: number | null;
  restarts: number;
  unstableRestarts: number;
  execPath: string | null;
  cwd: string | null;
  user: string | null;
  managed: boolean;
  dataDir: string | null;
}

export type ProcessAction = 'start' | 'stop' | 'restart' | 'reload';

export interface ProcessesResponse {
  pm2: Pm2Info;
  apps: ProcessApp[];
  currentUser: string;
  pm2Home?: string;
  hint?: string;
}

export interface ProcessActionResponse {
  ok: true;
  name: string;
  action: ProcessAction;
  managed: boolean;
  output: string;
}

export interface ProcessLogs {
  name: string;
  lines: string[];
}

export interface ServiceRuntimeNode {
  path: string;
  version: string | null;
  kind?: string;
  abi?: string;
  exists?: boolean;
  broken?: boolean;
  differsFromSystem?: boolean;
}

/** Mirrors core/service/runtime.js inspectRuntime(). */
export interface ServiceRuntime {
  systemNode: ServiceRuntimeNode;
  pinned: ServiceRuntimeNode | null;
  warnings?: string[];
}

/**
 * The Easy DevOps daemon — not PM2. `running` is read from the daemon lock
 * file; `connected` only says whether this dashboard has a live event channel.
 *
 * mechanism/mode/installed/startsAt/stoppedByUser/runtime are already computed
 * by core/service/index.js but are not exposed over HTTP yet; see UI_NEEDS.md.
 */
export interface BackgroundServiceStatus {
  running: boolean;
  connected: boolean;
  pid: number | null;
  version: string | null;
  startedAt: number | null;
  jobsRunningHere: boolean;
  mechanism?: 'startup-supervisor' | 'winsw' | 'systemd' | string;
  mode?: 'personal' | 'server' | string | null;
  installed?: boolean;
  startsAt?: 'logon' | 'boot' | string | null;
  stoppedByUser?: boolean;
  stoppedAt?: string | null;
  runtime?: ServiceRuntime | null;
  warnings?: string[];
}

/** Structured form of the CLI install instructions. */
export interface ServiceInstallInfo {
  command: string;
  needsElevation: boolean;
  shell: string | null;
}

export interface ServiceStatus {
  pm2: Pm2Info;
  dev: boolean;
  dataDir: string;
  /**
   * Records the Windows mode chosen at install ("personal" | "server").
   * "logon" and "boot" are PM2-era leftovers and are not used for the daemon.
   */
  bootMode: string | null;
  backgroundService: BackgroundServiceStatus;
  install: ServiceInstallInfo;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface Settings {
  dashboardPort: number;
  nginxDir: string;
  sslDir: string;
  acmeEmail: string;
  dashboardBindAddress: string;
  bindsToLoopbackOnly: boolean;
  dashboardAuth: AuthMode;
  canUseNoPassword: boolean;
  hasPassword: boolean;
  platform: 'win32' | 'linux';
}

export interface SettingsUpdate {
  dashboardPort?: number;
  dashboardPassword?: string;
  nginxDir?: string;
  sslDir?: string;
  acmeEmail?: string;
  dashboardBindAddress?: string;
  dashboardAuth?: AuthMode;
}

export interface SettingsUpdateResult {
  success: true;
  needsRestart: boolean;
  dashboardAuth: AuthMode;
}

export interface PermissionsSetupStatus {
  configured: boolean;
}

export interface BackupFile {
  version: number;
  exportedAt: string;
  config: Record<string, unknown>;
  domains: Domain[];
}

// ─── Notification channels ───────────────────────────────────────────────────

export type ChannelType = 'discord' | 'telegram';

export interface NotificationChannel {
  id: string;
  name: string;
  type: ChannelType;
  webhookUrl?: string;
  botToken?: string;
  chatId?: string;
  message?: string;
}

export interface ChannelInput {
  name: string;
  type: ChannelType;
  webhookUrl?: string;
  botToken?: string;
  chatId?: string;
  message?: string;
}

// ─── Hub ─────────────────────────────────────────────────────────────────────

export interface PermissionLeaf {
  id: string;
  label: string;
  description: string;
  comingSoon?: boolean;
}

export interface PermissionGroup {
  id: string;
  label: string;
  description: string;
  children: PermissionLeaf[];
}

export type PermissionMap = Record<string, boolean>;

export type HubAgentState =
  | 'not_linked'
  | 'connecting'
  | 'connected'
  | 'rejected'
  | 'unreachable'
  | string;

export interface HubStatus {
  linked: boolean;
  hubUrl: string | null;
  serverId: string | null;
  permissions: PermissionMap;
  tree: PermissionGroup[];
  comingSoon: string[];
  connected: boolean;
  status: HubAgentState;
  lastError: string | null;
  attempts: number;
  dataDir: string;
  devDataDir: boolean;
}

export interface HubConnectResponse {
  ok: true;
  status: HubStatus;
}

export interface HubPermissionsResponse {
  permissions: PermissionMap;
  tree: PermissionGroup[];
  comingSoon: string[];
}

// ─── Realtime ────────────────────────────────────────────────────────────────

export type NotificationType = 'nginx_down' | 'cert_expiry' | 'domain_health' | 'test' | string;
export type NotificationSeverity = 'success' | 'warning' | 'danger' | 'info' | string;

export interface NotificationEvent {
  id: string;
  type: NotificationType;
  subtype?: 'down' | 'recovery';
  severity: NotificationSeverity;
  message: string;
  domain?: string;
  timestamp: number;
}

export interface DomainHealthEntry {
  name: string;
  up: boolean | null;
  port?: number;
  host?: string;
}

export interface LocalChangeEvent {
  section: 'domains' | 'ssl' | 'nginx' | 'settings' | string;
  source: string;
  at: number;
}

export interface LogLine {
  line: string;
  logFile: 'access' | 'error' | string;
}

export interface ServerEvents {
  'nginx:status': NginxStatus;
  'domain:health': DomainHealthEntry[];
  'notification:new': NotificationEvent;
  'logs:line': LogLine;
  'local:changed': LocalChangeEvent;
  connect: undefined;
  disconnect: undefined;
  connect_error: Error;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export interface ApiErrorPayload {
  error?: string | IssuanceFailure;
  reason?: string;
  detail?: string;
  hint?: string;
  output?: string;
  expected?: string;
  found?: string[];
  certPath?: string;
  keyPath?: string;
  retryAfterSeconds?: number;
  needsSetup?: boolean;
  authMode?: AuthMode;
  [key: string]: unknown;
}
