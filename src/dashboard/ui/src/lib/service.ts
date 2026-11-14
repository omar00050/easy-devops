/**
 * One reading of GET /api/service for every screen that shows the daemon.
 *
 * The API still carries PM2-era fields (`installed`, `running`, `status`,
 * `enabledOnBoot`) that describe the old `ez-dashboard` PM2 app. They are
 * deliberately ignored: the authority on the background service is
 * `backgroundService`, which is read from the daemon's lock file.
 *
 * `mechanism`, `installed`, `startsAt`, `stoppedByUser` and `runtime` are not
 * exposed over HTTP yet (UI_NEEDS.md #11). When the backend adds them here,
 * they win; until then the mechanism falls back to the mode recorded at
 * install, and the rest is reported as unknown rather than guessed.
 */

import type { ServiceRuntime, ServiceStatus } from './types';

export type ServiceMechanism = 'personal' | 'windows-service' | 'systemd' | 'unknown';
export type ServiceStart = 'logon' | 'boot' | 'unknown';

export interface ServiceView {
  running: boolean;
  connected: boolean;
  jobsRunningHere: boolean;
  pid: number | null;
  version: string | null;
  startedAt: number | null;
  uptimeMs: number | null;
  mechanism: ServiceMechanism;
  mechanismLabel: string;
  mechanismDetail: string;
  startsAt: ServiceStart;
  startsAtLabel: string;
  installed: boolean | null;
  stoppedByUser: boolean;
  stoppedAt: string | null;
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
  personal: 'Startup supervisor · starts at logon',
  'windows-service': 'WinSW service · NT SERVICE\\EasyDevOps',
  systemd: 'systemd unit',
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

function explicitMechanism(service: ServiceStatus): ServiceMechanism | null {
  const value = service.backgroundService.mechanism;
  if (value === 'startup-supervisor') return 'personal';
  if (value === 'winsw') return 'windows-service';
  if (value === 'systemd') return 'systemd';
  if (value === 'personal' || value === 'windows-service' || value === 'systemd') {
    return value;
  }
  return null;
}

/**
 * Windows is recognisable from `install` even on an older response, and the
 * chosen mode is recorded in the same `service-state` key Phase 1 writes.
 * "logon"/"boot" are the removed PM2-era values, so they are not treated as
 * evidence of a native install.
 */
function resolveMechanism(service: ServiceStatus): ServiceMechanism {
  const explicit = explicitMechanism(service);
  if (explicit) return explicit;

  const mode = service.backgroundService.mode ?? null;
  if (mode === 'personal') return 'personal';
  if (mode === 'server') return 'windows-service';

  const windows = service.install.needsElevation || Boolean(service.install.shell);
  if (windows) {
    if (service.bootMode === 'server') return 'windows-service';
    if (service.bootMode === 'personal' || service.bootMode === null) return 'personal';
    return 'unknown';
  }
  return 'systemd';
}

function resolveStartsAt(service: ServiceStatus, mechanism: ServiceMechanism): ServiceStart {
  const explicit = service.backgroundService.startsAt;
  if (explicit === 'logon' || explicit === 'boot') return explicit;
  if (mechanism === 'personal') return 'logon';
  if (mechanism === 'windows-service' || mechanism === 'systemd') return 'boot';
  return 'unknown';
}

/**
 * `backgroundService.installed` is the real answer. Until it is exposed, a
 * recorded mode means an install happened (the new uninstall clears it), while
 * a running daemon alone proves nothing — it can be started by hand.
 */
function resolveInstalled(service: ServiceStatus): boolean | null {
  const explicit = service.backgroundService.installed;
  if (typeof explicit === 'boolean') return explicit;
  if (service.backgroundService.mode === 'personal' || service.backgroundService.mode === 'server') {
    return true;
  }
  if (service.bootMode === 'personal' || service.bootMode === 'server') return true;
  return null;
}

export function describeService(service: ServiceStatus | null): ServiceView | null {
  if (!service) return null;

  const bg = service.backgroundService;
  const mechanism = resolveMechanism(service);
  const startsAt = resolveStartsAt(service, mechanism);
  const runtime = bg.runtime ?? null;

  return {
    running: bg.running,
    connected: bg.connected,
    jobsRunningHere: bg.jobsRunningHere,
    pid: bg.pid,
    version: bg.version,
    startedAt: bg.startedAt,
    uptimeMs: bg.startedAt ? Math.max(0, Date.now() - bg.startedAt) : null,
    mechanism,
    mechanismLabel: MECHANISM_LABEL[mechanism],
    mechanismDetail: MECHANISM_DETAIL[mechanism],
    startsAt,
    startsAtLabel:
      startsAt === 'logon' ? 'At logon' : startsAt === 'boot' ? 'At boot' : 'Unknown',
    installed: resolveInstalled(service),
    stoppedByUser: bg.stoppedByUser === true,
    stoppedAt: bg.stoppedAt ?? null,
    installCommand: service.install.command,
    installGuidance: INSTALL_GUIDANCE[mechanism],
    runtime,
    warnings: [...(bg.warnings ?? []), ...(runtime?.warnings ?? [])],
  };
}

export function serviceStateLabel(view: ServiceView | null): string {
  if (!view) return 'Unknown';
  if (view.running) return 'Running';
  if (view.stoppedByUser) return 'Stopped by you';
  if (view.installed === false) return 'Not installed';
  return 'Not running';
}

export interface RuntimeView {
  serviceVersion: string | null;
  servicePath: string | null;
  systemVersion: string | null;
  systemPath: string | null;
  sameAsSystem: boolean;
  broken: boolean;
}

export function describeRuntime(runtime: ServiceRuntime | null): RuntimeView | null {
  if (!runtime) return null;
  const serviceVersion = runtime.pinned?.version ?? null;
  const systemVersion = runtime.systemNode.version ?? null;
  const sameAsSystem =
    Boolean(serviceVersion && systemVersion) &&
    serviceVersion === systemVersion &&
    !runtime.pinned?.differsFromSystem;

  return {
    serviceVersion,
    servicePath: runtime.pinned?.path ?? null,
    systemVersion,
    systemPath: runtime.systemNode.path ?? null,
    sameAsSystem,
    broken: runtime.pinned?.broken === true,
  };
}
