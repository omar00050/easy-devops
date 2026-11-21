/**
 * lib/types.ts — the wire shapes of API-CONTRACT.md, typed.
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

/**
 * `not_issued` (2.16.0) is a certificate directory with no certificate file;
 * `unreadable` (2.16.0) is a file neither Node nor openssl can parse. `error`
 * is what a backend older than 2.16.0 called the unreadable case and is kept
 * so an older server still type-checks.
 */
export type CertStatus = 'valid' | 'expiring' | 'expired' | 'not_issued' | 'unreadable' | 'error';

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
  /** "Not issued yet" for `not_issued`; null for an unreadable file. */
  label?: string | null;
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

export type SslSuggestionMatch = 'exact' | 'san' | 'wildcard';

export interface SslSuggestionCertificate {
  /** Certificate directory name. */
  domain: string;
  /** Every name the certificate covers. */
  names: string[];
  certPath: string;
  keyPath: string;
  expiry: string | null;
  daysLeft: number | null;
  status: CertStatus;
}

export type SslSuggestion =
  | { found: false }
  | { found: true; match: SslSuggestionMatch; certificate: SslSuggestionCertificate };

/** One preflight check (`core/ssl/preflight.js`): id is `dns:<name>`, `a:…`, `aaaa:…` or `http:…`. */
export type PreflightCheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface PreflightCheck {
  id: string;
  status: PreflightCheckStatus;
  message: string;
  /** The one-line next step; present when there is something to do. */
  fix?: string;
}

/** What `/api/ssl` checks before it spends a Let's Encrypt attempt (normalised view). */
export interface PreflightResult {
  ok: boolean;
  detail?: string;
  results: PreflightCheck[];
  /** A Cloudflare address answered for at least one name. */
  proxied?: boolean;
  /** The public HTTP probe reached this server. */
  reachesUs?: boolean;
}

/**
 * The wire shape since 2.16.0: `POST /api/ssl/create`, `renew/:domain` and every
 * renew-all entry carry the checks as a plain array (or null when the request
 * stopped before preflight ran). An older body wrapped them as
 * `{ ok, results }`; `preflightFrom()` accepts either.
 */
export type PreflightPayload = PreflightCheck[] | PreflightResult;

export interface IssuanceFailure {
  step?: string;
  cause?: string;
  consequence?: string;
  /** The stage that failed, when the server names it (2.16.0). */
  stage?: string;
  /** The one-line remedy (2.16.0). */
  fix?: string;
  nginxRunning?: boolean;
  configSaved?: boolean;
}

export interface IssuanceSuccess {
  success: true;
  /** The client's correlation id, echoed by the server. */
  opId?: string;
  certPath: string;
  keyPath: string;
  /** 'proxy' when nginx answered the challenge, 'standalone' when it stopped. */
  mode?: string;
  fellBack?: boolean;
  nginxDownMs?: number;
  staging?: boolean;
  summary?: string;
  preflight?: PreflightPayload | null;
}

export interface DnsChallengePending {
  status: 'waiting_dns';
  /** The client's correlation id, echoed by the 202. */
  opId?: string;
  domain: string;
  txtName: string;
  txtValue: string;
  hint?: string;
}

export interface RenewAllResult {
  domain: string;
  /** The one id shared by every item in a renew-all request. */
  opId?: string;
  success: boolean;
  certPath: string | null;
  keyPath: string | null;
  mode?: string;
  fellBack?: boolean;
  nginxDownMs?: number;
  configRegenerated?: boolean;
  nginxReloaded?: boolean | null;
  summary?: string;
  error?: string | IssuanceFailure;
  detail?: string;
  preflight?: PreflightPayload | null;
}

export interface SslCreateInput {
  domain: string;
  www?: boolean;
  validationMethod: 'http' | 'dns';
  email?: string | null;
  /** Optional client correlation id, `/^[A-Za-z0-9_-]{8,64}$/`. */
  opId?: string;
}

// ─── SSL live progress ───────────────────────────────────────────────────────

/** The nine stages of API-CONTRACT.md §2.3 / §3.5, in order. */
export type SslStageStatus = 'running' | 'ok' | 'failed' | 'skipped';

/**
 * One `ssl:progress` frame. Published while issue, renew and renew-all run and
 * deliberately NOT replayed on reconnect: a stage is a moment, not state.
 */
export interface SslProgressEvent {
  /** Correlates every frame with the request that started the operation. */
  opId: string;
  domain: string;
  /** A stage id from `core/ssl/progress.js` (e.g. `waiting for validation`). */
  stage: string;
  status: SslStageStatus;
  /** At most 300 characters; never a key or file contents. */
  detail?: string;
  /** Measured from the start of the operation. */
  elapsedMs: number;
  at: string;
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
  /** Null while the cached probe has not completed for the first time. */
  installed: boolean | null;
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

/**
 * Describes how fresh the cached half of `GET /api/service` is. While
 * `pending` is true the measured fields (`state`, `enabledOnBoot`, `runtime`,
 * warnings, PM2 detection) are null because no probe has finished yet.
 */
export interface ServiceProbes {
  ageMs: number | null;
  fresh: boolean;
  pending: boolean;
  refreshing: boolean;
}

export interface ServiceStatus {
  pm2: Pm2Info;
  dev: boolean;
  dataDir: string;
  backgroundService: BackgroundServiceStatus;
  install: ServiceInstallInfo;
  /** Absent on a backend that predates the probes split. */
  probes?: ServiceProbes;
}

export type ServiceAction = 'start' | 'stop' | 'restart';

export interface ServiceActionResponse {
  ok: true;
  action: ServiceAction;
  output: string | null;
  backgroundService: BackgroundServiceEvent;
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** Which page `ezz --dash` serves: the legacy EJS page or this React app. */
export type DashboardUi = 'classic' | 'new';

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
  /** Absent on a backend that predates the setting. Applies at the next dashboard start. */
  dashboardUi?: DashboardUi;
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
  dashboardUi?: DashboardUi;
}

export interface SettingsUpdateResult {
  success: true;
  needsRestart: boolean;
  dashboardAuth: AuthMode;
  dashboardUi?: DashboardUi;
}

export interface PermissionsSetupStatus {
  configured: boolean;
}

export interface RefusedPermissionDir {
  dir: string;
  reason: string;
}

/** `POST /settings/permissions/setup` never installs anything; it hands back
 *  the lines the operator runs once in their own terminal. */
export interface PermissionsSetupResult extends PermissionsSetupStatus {
  commands: string[];
  refusedDirs: RefusedPermissionDir[];
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

export interface UpdateElevation {
  /** True when replacing this install's files needs an administrator. */
  required: boolean;
  /** The command to run instead, e.g. `ezz update`; null when not required. */
  command: string | null;
  /** Where to run it, e.g. "Administrator PowerShell"; null when not required. */
  shell: string | null;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  reachable: boolean;
  updateAvailable: boolean;
  source: UpdateSource;
  /** Absent on a server older than this UI: treat it as not required. */
  elevation?: UpdateElevation;
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
  /** The last test result, when the server reports one; absent older servers do not. */
  lastTest?: 'passed' | 'failed' | null;
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

/** The agent half of `HubStatus`, published on every state transition. */
export interface HubAgentStateEvent {
  linked: boolean;
  connected: boolean;
  status: HubAgentState;
  lastError: string | null;
  attempts: number;
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
  'hub:agentState': HubAgentStateEvent;
  'ssl:progress': SslProgressEvent;
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

/** PM2 process model: one process (fork) or one worker per instance (cluster). */
export type DeployExecMode = 'fork' | 'cluster';

/** A whole number 1..CPU count, or "max" (one per CPU). */
export type DeployInstances = number | 'max';

/** The runtime an app runs on. Only Node.js exists today. */
export type DeployRuntime = 'node';

/** What one ordered step is for. `custom` is a free-form command. */
export type DeployStepKind = 'install' | 'build' | 'migrate' | 'custom';

/** One step in the ordered list run after checkout and before start (max 5). */
export interface DeployStep {
  /** One non-empty command line. */
  run: string;
  kind: DeployStepKind;
  /** Defaults to true; a disabled step is skipped and logged as skipped. */
  enabled?: boolean;
}

/** Per-app overrides. Absent means "use ez.json, then package.json". */
export interface DeploySettings {
  /** The ordered command list. One field: it replaces ez.json's list, and [] clears it. */
  steps?: DeployStep[];
  /** The runtime. Absent means ez.json's runtime, else "node". */
  runtime?: DeployRuntime;
  /** Legacy fields, still read by the server as the equivalent steps. */
  install?: DeployCommands;
  build?: DeployCommands;
  /** Runs after build, before the new release starts. Forward-only. */
  migrate?: DeployCommands;
  pre?: DeployCommands;
  post?: DeployCommands;
  start?: string;
  port?: number;
  healthPath?: string;
  healthTimeout?: number;
  /** Project-relative paths that survive deployments — folders or one file: ["data", "prisma/hub.db"]. */
  persist?: string | string[];
  instances?: DeployInstances;
  execMode?: DeployExecMode;
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
  /**
   * Canonical stage id (fetch|settings|pre|install|build|migrate|start|health|
   * post|finish|done). Absent on older agents; for a custom step the record's
   * `step` is "step N" while this stays canonical.
   */
  stage?: string;
  /** Canonical stages this run does not use, e.g. ['pre','migrate','post']. */
  skippedStages?: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  warnings: string[];
  rolledBackTo: string | null;
  /** A boot crash or health failure, in the server's words. */
  reason?: string | null;
  /** Last ~40 lines of a boot-crashed release, already redacted. */
  logTail?: string[];
  /** true/false once an automatic rollback was attempted; null when none was. */
  rollbackSucceeded?: boolean | null;
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
  execMode?: DeployExecMode;
  instances?: DeployInstances;
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
  /** The key's SHA256 fingerprint, when one has been generated. */
  deployKeyFingerprint?: string | null;
  deployKeyCreatedAt?: string | null;
  /** True while the private half is still on the server. */
  deployKeyOnDisk?: boolean;
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
  /** Advisory notes from the server; in cluster mode, the stateless warning. */
  warnings?: string[];
  /** Configured values from the live release, else settings, else fork/1. */
  execMode?: DeployExecMode;
  instances?: DeployInstances;
  /** How many copies PM2 currently reports online; 0 when PM2 is not running. */
  instancesOnline?: number;
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
  /** Create only: generate the deploy key in the same request. Ignored unless authType is deployKey; defaults to true. */
  generateKey?: boolean;
  settings?: DeploySettings;
  env?: Record<string, string>;
  keepReleases?: number;
  autoRollback?: boolean;
  notifyChannelIds?: string[];
}

/** A freshly generated deploy key, as the create and regenerate answers carry it. */
export interface DeployKeyInfo {
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  /** GitHub's "add deploy key" page for this repository, or null for other hosts. */
  addUrl: string | null;
}

/** The create response: the app, plus its key (an object) or why it could not be made. */
export type DeployAppCreated = Omit<DeployApp, 'deployKey'> & {
  deployKey?: DeployKeyInfo | string | null;
  deployKeyError?: string;
};

export interface DeployKeyRegenerateResult extends DeployKeyInfo {
  previousFingerprint?: string | null;
}

export interface DeployKeyTestResult {
  ok: boolean;
  status: number;
  error: string | null;
  detail?: string;
  branchFound?: boolean;
  fingerprint?: string;
}

export interface DeployKeyGithubResult {
  ok: boolean;
  steps?: Array<{ id: string; ok: boolean; detail: string }>;
  error: string | null;
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
  channels: Array<{
    id: string;
    name: string;
    type: string;
    lastTest?: 'passed' | 'failed' | null;
  }>;
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

export type DeploySslMode = 'none' | 'issue' | 'existing';

export interface DeployDomainLinkInput {
  domain: string;
  www?: boolean;
  /** Existing certificates are named by `certName`; the server uses its own suggestion's paths. */
  ssl?: { mode: DeploySslMode; certName?: string };
  redirect?: boolean;
  behindCloudflare?: boolean;
  /** Optional client correlation id for the live `ssl:progress` stages. */
  opId?: string;
}

export interface DeployDomainLink {
  ok?: boolean;
  /** The client's correlation id, echoed by the server. */
  opId?: string;
  domain: string;
  created: boolean;
  port: number;
  www?: boolean;
  behindCloudflare?: boolean;
  redirect?: boolean;
  nginxReloaded: boolean;
  /** null for mode "none"; a failed issuance leaves the link standing over HTTP. */
  ssl: { mode: DeploySslMode; ok: boolean; detail: string; certName?: string } | null;
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
  /** SSL failures (2.16.0): every check that ran, or null before preflight. */
  preflight?: PreflightPayload | null;
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
