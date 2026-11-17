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
  /** True while first-run setup is pending and a code is required. */
  setupCodeRequired: boolean;
  /**
   * Epoch ms when the outstanding setup code stops being valid, or null when
   * no usable code is outstanding (none issued, expired, or burned). Meaningful
   * only alongside `setupCodeRequired`.
   */
  setupCodeExpiresAt: number | null;
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

/**
 * What the background job intends for a certificate.
 *   auto   — renewed automatically once inside the window
 *   manual — DNS-01 / wildcard: needs a TXT record, so warning only
 *   unused — no enabled domain serves it, so it is left alone
 *   off    — auto-renewal is switched off in Settings
 */
export type CertAutoRenew = 'auto' | 'manual' | 'unused' | 'off';

export interface Certificate {
  domain: string;
  expiry: string | null;
  daysLeft: number | null;
  status: CertStatus;
  /** Optional: absent on a backend older than contract 2.3.0. */
  autoRenew?: CertAutoRenew;
  autoRenewDays?: number;
  lastAutoRenew?: {
    at: number | null;
    result: 'renewed' | 'failed' | null;
    error: string | null;
  } | null;
}

/** One nginx config line that points into a certificate's directory. */
export interface CertConfigReference {
  file: string;
  line: number;
  text: string;
}

export interface CertificateDeleteResult {
  deleted: string;
  directory: string;
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
  path: string | null;
  version: string | null;
  kind?: string;
  abi?: string;
  exists?: boolean;
  broken?: boolean;
  target?: string | null;
  differsFromSystem?: boolean;
}

export interface ServiceRuntimeManager {
  managed: boolean;
  manager: string | null;
}

/** Mirrors core/service/runtime.js inspectRuntime(). */
export interface ServiceRuntime {
  systemNode: ServiceRuntimeNode;
  pinned: ServiceRuntimeNode | null;
  manager?: ServiceRuntimeManager;
  mixed?: { mixed: boolean; msiPath: string | null; managed: string | null };
  warnings: string[];
}

export type ServiceMechanismWire = 'systemd' | 'winsw' | 'startup-supervisor';
export type ServiceStartsAt = 'logon' | 'boot';

/**
 * The cheap half of the service state: a lock read and a database read.
 * `GET /api/service` and the `service:changed` socket event both carry this.
 */
export interface BackgroundServiceLiveStatus {
  running: boolean;
  connected: boolean;
  pid: number | null;
  version: string | null;
  startedAt: number | null;
  heartbeatAgeMs: number | null;
  jobsRunningHere: boolean;
  jobsOwnerPid: number | null;
  jobsOwnerRole: 'daemon' | 'dashboard' | string | null;
  mechanism: ServiceMechanismWire;
  mode: 'personal' | 'server' | null;
  installed: boolean;
  startsAt: ServiceStartsAt;
  stoppedByUser: boolean;
  stoppedAt: string | null;
  dataDir: string;
  serverMode: boolean;
  detail: string | null;
}

/**
 * What `GET /api/service` returns. The socket event is the cheap half above
 * (the controller's rich fields need the service manager and runtime probes),
 * so a client merges the event over the last full read.
 */
export interface BackgroundServiceStatus extends BackgroundServiceLiveStatus {
  state: string | null;
  enabledOnBoot: boolean | null;
  restarts: number;
  crashLooping: boolean;
  warnings: string[];
  runtime: ServiceRuntime | null;
}

/**
 * The `service:changed` payload. The contract promises the full object; the
 * dashboard's bridge publishes the cheap half, so the rich fields are optional
 * and a merge keeps the last known values.
 */
export type BackgroundServiceEvent = BackgroundServiceLiveStatus &
  Partial<Pick<BackgroundServiceStatus, 'state' | 'enabledOnBoot' | 'restarts' | 'crashLooping' | 'warnings' | 'runtime'>>;

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
  backgroundService: BackgroundServiceStatus;
  install: ServiceInstallInfo;
}

export type ServiceAction = 'start' | 'stop' | 'restart';

export interface ServiceActionResponse {
  ok: true;
  action: ServiceAction;
  output: string | null;
  backgroundService: BackgroundServiceEvent;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface Settings {
  dashboardPort: number;
  nginxDir: string;
  sslDir: string;
  acmeEmail: string;
  /** Optional: absent on a backend older than contract 2.3.0. */
  sslAutoRenew?: boolean;
  sslAutoRenewDays?: number;
  sslAutoRenewDaysMin?: number;
  sslAutoRenewDaysMax?: number;
  /** Folder new deployed apps are created in. Absent before contract 2.6.0. */
  deployDir?: string;
  deployDirDefault?: string;
  deployDirIsDefault?: boolean;
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
  sslAutoRenew?: boolean;
  sslAutoRenewDays?: number;
  /** An absolute path, or '' to go back to the default. */
  deployDir?: string;
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

// ─── Updating Easy DevOps ────────────────────────────────────────────────────

export type UpdatePhase =
  | 'starting'
  | 'stopping'
  | 'updating'
  | 'restarting'
  | 'done'
  | 'failed'
  | 'interrupted';

export interface UpdateSource {
  kind: 'clone' | 'npm' | 'unknown';
  reason: string;
  /** False means the Update button is not offered at all. */
  npmUpdatable: boolean;
  howToUpdate: string[];
}

export interface UpdateRun {
  id: string;
  phase: UpdatePhase;
  from: string;
  to: string;
  /** Which sub-step failed, on a failure. */
  step: string | null;
  reason: string | null;
  logTail: string[];
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  rolledBack?: boolean;
  restored?: boolean | null;
  runningVersion?: string | null;
  versionConfirmed?: boolean;
  serviceInstalled?: boolean;
  refreshedCopy?: boolean;
  dashboardRestarted?: boolean;
  dashboardPort?: number;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  reachable: boolean;
  updateAvailable: boolean;
  source: UpdateSource;
  /** The last run, so a page loaded after a restart can report its outcome. */
  run: UpdateRun | null;
}

export interface UpdateStatusResponse {
  current: string;
  run: UpdateRun | null;
}

export interface UpdateStartResponse {
  started: true;
  run: UpdateRun;
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
  /** Which process owns the Hub connection: the background service or this dashboard. */
  agentOwner: 'daemon' | 'dashboard';
  /** False while the daemon is running but has not reported its agent state yet. */
  agentReported: boolean;
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

export type NotificationType = 'nginx_down' | 'cert_expiry' | 'domain_health' | 'test' | string | 'deploy';
export type NotificationSeverity = 'success' | 'warning' | 'danger' | 'info' | string;

export interface NotificationEvent {
  id: string;
  type: NotificationType;
  subtype?: string;
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
  'service:changed': BackgroundServiceEvent;
  connect: undefined;
  disconnect: undefined;
  connect_error: Error;
}

// ─── Deployments ─────────────────────────────────────────────────────────────

export type DeployAuthType = 'none' | 'deployKey' | 'token';
export type DeployRunStatus = 'running' | 'success' | 'failed' | 'rolled_back';
export type DeployTrigger = 'manual' | 'webhook' | 'hub' | 'rollback';

/** A command field: one command, several, or `false` to switch the step off. */
export type DeployCommands = string | string[] | false;

/** Per-app overrides. Absent means "use ez.json, then package.json". */
export interface DeploySettings {
  install?: DeployCommands;
  build?: DeployCommands;
  pre?: DeployCommands;
  post?: DeployCommands;
  start?: string;
  port?: number;
  healthPath?: string;
  healthTimeout?: number;
  /** Project-relative paths that survive deployments — folders or one file: ["data", "prisma/hub.db"]. */
  persist?: string | string[];
}

export interface DeployRun {
  id: string;
  appId: string;
  trigger: DeployTrigger;
  actor: string | null;
  ref: string | null;
  sha: string | null;
  releaseId: string;
  status: DeployRunStatus;
  step: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  warnings: string[];
  rolledBackTo: string | null;
}

export interface DeployRunDetail extends DeployRun {
  log: string;
  logTruncated: boolean;
}

export interface DeployRelease {
  id: string;
  sha: string | null;
  ref: string | null;
  startable: boolean;
  current: boolean;
  previous: boolean;
}

export interface DeployProcess {
  status: string;
  pid: number | null;
  cpu: number | null;
  memoryBytes: number | null;
  uptimeMs: number | null;
  restarts: number;
}

export interface DeployApp {
  id: string;
  pm2Name: string;
  repoUrl: string;
  branch: string;
  authType: DeployAuthType;
  hasToken: boolean;
  deployKey: string | null;
  settings: DeploySettings;
  env: Record<string, string>;
  keepReleases: number;
  autoRollback: boolean;
  notifyChannelIds: string[];
  /** The folder the app lives in. Absent before contract 2.6.0. */
  dir?: string;
  /** Where paths listed in `settings.persist` are kept between deployments. */
  sharedDir?: string;
  /** True when that folder holds anything, so deleting the app would leave data behind. */
  hasSharedData?: boolean;
  /** The domain linked to the app, or null. */
  domain?: string | null;
  hook: { hasToken: boolean; tokenHint: string | null; createdAt: string | null };
  createdAt: string | null;
  updatedAt: string | null;
  /** Present in the list and the detail response. */
  currentRelease?: string | null;
  previousRelease?: string | null;
  deploying?: boolean;
  activeRunId?: string | null;
  lastRun?: DeployRun | null;
  process?: DeployProcess | null;
}

export interface DeployAppDetail extends DeployApp {
  runs: DeployRun[];
  releases: DeployRelease[];
}

export interface DeployAppInput {
  id?: string;
  repoUrl?: string;
  branch?: string;
  authType?: DeployAuthType;
  token?: string;
  settings?: DeploySettings;
  env?: Record<string, string>;
  keepReleases?: number;
  autoRollback?: boolean;
  notifyChannelIds?: string[];
}

export type DeployHookMode = 'domain' | 'direct' | 'none';

export interface DeployHook {
  enabled: boolean;
  port: number;
  bind: string;
  domain: string | null;
  listening: boolean;
  path: string;
  urlExample?: string | null;
  mode?: DeployHookMode;
  secure?: boolean;
  note?: string;
  nginxReloaded?: boolean | null;
  appliesWithinSeconds?: number;
}

export interface DeployHookUpdate {
  enabled?: boolean;
  port?: number;
  bind?: string;
  domain?: string | null;
}

export interface DeploymentsResponse {
  apps: DeployApp[];
  hook: DeployHook;
  requirements: { git: boolean; gitVersion: string | null; pm2: boolean };
  limits: { keepReleasesDefault: number; keepReleasesMin: number; keepReleasesMax: number };
  ezFileLocations: string[];
  /** Where a new app would be created. Absent before contract 2.6.0. */
  deployDir?: string;
  channels: Array<{ id: string; name: string; type: string }>;
  domains: Array<{ name: string; enabled: boolean; ssl: boolean }>;
}

export interface DeployGithubSetup {
  hookUrl: string | null;
  hookMode: DeployHookMode;
  hookSecure: boolean;
  hookNote: string;
  hasToken: boolean;
  tokenHint: string | null;
  workflowPath: string;
  workflow: string;
  secrets: Array<{ name: string; value: string | null }>;
  deployKey: string | null;
  /** The ways GitHub can reach this server. Absent before contract 2.5.0. */
  targets?: DeployGithubTarget[];
}

export interface DeployGithubTarget {
  id: 'hook' | 'hub';
  label: string;
  url: string | null;
  secure: boolean;
  note: string;
  /** Hub target only: false until the server grants deploy.ci. */
  ready?: boolean;
}

export interface DeployGithubApplyInput {
  token?: string;
  target?: 'hook' | 'hub';
  secrets?: boolean;
  workflow?: boolean;
  deployKey?: boolean;
}

export interface DeployGithubApplyResult {
  ok: boolean;
  repo: string | null;
  error: string | null;
  target: 'hook' | 'hub' | null;
  deployUrl: string | null;
  steps: Array<{ id: 'secrets' | 'workflow' | 'deployKey'; ok: boolean; detail: string }>;
}

export interface DeployDomainLink {
  domain: string;
  created: boolean;
  port: number;
  nginxReloaded: boolean;
  ssl: { ok: boolean; detail: string } | null;
}

export interface DeployMoveResult {
  from: string;
  to: string;
  restarted: boolean;
  warning: string | null;
}

export interface DeployStarted {
  runId: string;
  status: 'running';
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export interface ApiErrorPayload {
  error?: string | IssuanceFailure;
  reason?: string;
  detail?: string;
  hint?: string;
  output?: string;
  /** Service lifecycle failures: elevation_required / not_installed / action_failed. */
  action?: ServiceAction;
  message?: string;
  command?: string;
  shell?: string;
  backgroundService?: BackgroundServiceEvent;
  expected?: string;
  found?: string[];
  certPath?: string;
  keyPath?: string;
  /** DELETE /api/ssl/:domain: certificate still referenced by nginx configs. */
  directory?: string;
  references?: CertConfigReference[];
  retryAfterSeconds?: number;
  needsSetup?: boolean;
  authMode?: AuthMode;
  [key: string]: unknown;
}
