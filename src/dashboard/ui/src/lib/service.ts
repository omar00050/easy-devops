/**
 * One reading of GET /api/service for every screen that shows the daemon.
 *
 * Contract 2.0.0 exposes the native service fields explicitly, so nothing here
 * is inferred from the PM2-era `bootMode`/`install` pair. `backgroundService`
 * is the single authority: `mechanism`, `installed`, `startsAt`,
 * `stoppedByUser`, `stoppedAt`, `runtime` and `warnings` are read as-is.
 */

import { formatDateTime } from './format';
import type {
  BackgroundServiceLiveStatus,
  ServiceRuntime,
  ServiceStatus,
} from './types';

export type ServiceMechanism = 'personal' | 'windows-service' | 'systemd' | 'unknown';
export type ServiceStart = 'logon' | 'boot' | 'unknown';

export interface ServiceView {
  running: boolean;
  connected: boolean;
  jobsRunningHere: boolean;
  jobsOwnerLabel: string;
  pid: number | null;
  version: string | null;
  startedAt: number | null;
  uptimeMs: number | null;
  heartbeatAgeMs: number | null;
  mechanism: ServiceMechanism;
  mechanismLabel: string;
  mechanismDetail: string;
  startsAt: ServiceStart;
  startsAtLabel: string;
  installed: boolean;
  stoppedByUser: boolean;
  stoppedAt: string | null;
  /** Local time, ready to render next to "Stopped by you". */
  stoppedAtLabel: string | null;
  state: string | null;
  detail: string | null;
  enabledOnBoot: boolean | null;
  restarts: number;
  crashLooping: boolean;
  dataDir: string;
  installCommand: string;
  installGuidance: string;
  runtime: ServiceRuntime | null;
  warnings: string[];
}

const MECHANISM_LABEL: Record<ServiceMechanism, string> = {
  personal: 'Personal',
  'windows-service': 'Windows service',
  systemd: 'systemd',
  unknown: 'Unknown',
};

const MECHANISM_DETAIL: Record<ServiceMechanism, string> = {
  personal: 'Startup supervisor · runs as you, starts at logon',
  'windows-service': 'WinSW service · NT SERVICE\\EasyDevOps',
  systemd: 'systemd unit · starts at boot',
  unknown: 'Not reported by this API',
};

const INSTALL_GUIDANCE: Record<ServiceMechanism, string> = {
  personal:
    'No administrator needed — run it in a normal PowerShell. Personal mode starts at logon and stops when you sign out.',
  'windows-service':
    'Run it in an Administrator PowerShell. It creates a Windows service that runs as NT SERVICE\\EasyDevOps and never asks for an account password.',
  systemd: 'Run it once with sudo; the unit then starts at boot.',
  unknown: 'Run it in a terminal with the rights your platform requires.',
};

function resolveMechanism(service: ServiceStatus): ServiceMechanism {
  switch (service.backgroundService.mechanism) {
    case 'startup-supervisor':
      return 'personal';
    case 'winsw':
      return 'windows-service';
    case 'systemd':
      return 'systemd';
    default:
      return 'unknown';
  }
}

function startsAtLabel(startsAt: ServiceStart): string {
  if (startsAt === 'logon') return 'At logon';
  if (startsAt === 'boot') return 'At boot';
  return 'Unknown';
}

function resolveJobsOwner(bg: BackgroundServiceLiveStatus): string {
  if (bg.jobsRunningHere) return 'This dashboard';
  if (bg.jobsOwnerRole === 'daemon') return 'Background service';
  if (bg.jobsOwnerRole === 'dashboard') return 'Another dashboard process';
  if (bg.running) return 'Background service';
  return 'Paused — no owner';
}

export function describeService(service: ServiceStatus | null): ServiceView | null {
  if (!service) return null;

  const bg = service.backgroundService;
  const mechanism = resolveMechanism(service);
  const startsAt: ServiceStart =
    bg.startsAt === 'logon' || bg.startsAt === 'boot' ? bg.startsAt : 'unknown';
  const runtime = bg.runtime ?? null;
  const stoppedAt = bg.stoppedAt ?? null;

  // The controller folds runtime warnings into `warnings` as well; dedupe so a
  // caller renders each line once.
  const warnings = Array.from(
    new Set([...(bg.warnings ?? []), ...(runtime?.warnings ?? [])])
  );

  return {
    running: bg.running,
    connected: bg.connected,
    jobsRunningHere: bg.jobsRunningHere,
    jobsOwnerLabel: resolveJobsOwner(bg),
    pid: bg.pid,
    version: bg.version,
    startedAt: bg.startedAt,
    uptimeMs: bg.startedAt ? Math.max(0, Date.now() - bg.startedAt) : null,
    heartbeatAgeMs: bg.heartbeatAgeMs ?? null,
    mechanism,
    mechanismLabel: MECHANISM_LABEL[mechanism],
    mechanismDetail: MECHANISM_DETAIL[mechanism],
    startsAt,
    startsAtLabel: startsAtLabel(startsAt),
    installed: bg.installed === true,
    stoppedByUser: bg.stoppedByUser === true,
    stoppedAt,
    stoppedAtLabel: stoppedAt ? formatDateTime(stoppedAt) : null,
    state: bg.state ?? null,
    detail: bg.detail ?? null,
    enabledOnBoot: bg.enabledOnBoot ?? null,
    restarts: bg.restarts ?? 0,
    crashLooping: bg.crashLooping === true,
    dataDir: bg.dataDir,
    installCommand: service.install.command,
    installGuidance: INSTALL_GUIDANCE[mechanism],
    runtime,
    warnings,
  };
}

export function serviceStateLabel(view: ServiceView | null): string {
  if (!view) return 'Unknown';
  if (view.running) return 'Running';
  if (view.stoppedByUser) return 'Stopped by you';
  if (!view.installed) return 'Not installed';
  return 'Not running';
}

export interface RuntimeView {
  serviceVersion: string | null;
  servicePath: string | null;
  systemVersion: string | null;
  systemPath: string | null;
  sameAsSystem: boolean;
  broken: boolean;
  /** A pin exists and points at a usable file. */
  pinned: boolean;
  kind: string | null;
  /** Version manager that owns the system Node, when one was detected. */
  manager: string | null;
}

export function describeRuntime(runtime: ServiceRuntime | null): RuntimeView | null {
  if (!runtime) return null;
  const pinnedNode = runtime.pinned;
  const serviceVersion = pinnedNode?.version ?? null;
  const systemVersion = runtime.systemNode.version ?? null;
  const pinned = Boolean(
    pinnedNode && pinnedNode.kind !== 'none' && pinnedNode.exists !== false
  );
  const sameAsSystem =
    pinned &&
    Boolean(serviceVersion && systemVersion) &&
    serviceVersion === systemVersion &&
    !pinnedNode?.differsFromSystem;

  return {
    serviceVersion,
    servicePath: pinnedNode?.path ?? null,
    systemVersion,
    systemPath: runtime.systemNode.path ?? null,
    sameAsSystem,
    broken: pinnedNode?.broken === true,
    pinned,
    kind: pinnedNode?.kind ?? null,
    manager: runtime.manager?.managed ? runtime.manager.manager ?? null : null,
  };
}
