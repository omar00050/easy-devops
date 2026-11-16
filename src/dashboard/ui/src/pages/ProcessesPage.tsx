import { useState } from 'react';
import {
  List,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  ServerCog,
  Square,
  Table2,
  X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type {
  ProcessAction,
  ProcessApp,
  ProcessLogs,
  ProcessesResponse,
  ServiceAction,
  ServiceRuntime,
} from '../lib/types';
import { cn } from '../lib/cn';
import { formatBytes, formatPercent, formatUptime, pluralize } from '../lib/format';
import { describeRuntime, describeService, serviceStateLabel } from '../lib/service';
import {
  useConfirm,
  useDocumentTitle,
  usePolling,
  useRefreshOnVisible,
  useResource,
} from '../hooks/useResource';
import { useService } from '../app/ServiceProvider';
import { PageHeader } from '../components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge, StatusDot, type Tone } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { CopyButton } from '../components/ui/CopyButton';
import { Modal } from '../components/ui/Modal';
import {
  EmptyState,
  ErrorState,
  InlineAlert,
  PageSkeleton,
  Skeleton,
  Spinner,
} from '../components/ui/States';
import { useToast } from '../components/ui/Toast';

function failureText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (typeof error.payload.detail === 'string') return error.payload.detail;
    if (typeof error.payload.message === 'string') return error.payload.message;
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

function statusTone(status: string): Tone {
  if (status === 'online') return 'ok';
  if (status === 'errored') return 'bad';
  if (status === 'stopping' || status === 'launching') return 'warn';
  return 'neutral';
}

// PM2 reports 0 for CPU and memory it cannot measure, which is common on
// Windows. A live process cannot occupy 0 bytes, so 0 means "not reported".
function metricPercent(value: number | null): string {
  return value === null || value === 0 ? '—' : formatPercent(value);
}

function metricBytes(value: number | null): string {
  return value === null || value === 0 ? '—' : formatBytes(value);
}

/**
 * PM2 modules are installed under `<PM2 home>/modules/<name>` and run from
 * there. The API has no module flag, so the path is the only marker.
 */
function isPm2Module(app: ProcessApp, pm2Home: string | null): boolean {
  const home = pm2Home?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ?? null;
  return [app.execPath, app.cwd].some((value) => {
    if (!value) return false;
    const path = value.replace(/\\/g, '/').toLowerCase();
    if (home && path.startsWith(`${home}/modules/`)) return true;
    return /(^|\/)(\.pm2|pm2)\/modules\//.test(path);
  });
}

interface ServiceGuidance {
  kind: 'elevation' | 'install';
  action: ServiceAction;
  command: string;
  shell: string | null;
  message: string | null;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-0.5 text-xs tabular-nums text-muted">{value}</div>
    </div>
  );
}

function ServiceFact({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-2xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className={cn('mt-0.5 text-sm font-medium', tone ?? 'text-ink')}>{value}</div>
      {detail && <div className="mt-0.5 text-2xs text-faint">{detail}</div>}
    </div>
  );
}

function InstallCommand({ command, guidance }: { command: string; guidance: string }) {
  return (
    <div className="rounded-md border border-line bg-canvas p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="break-all font-mono text-xs text-ink">{command}</code>
        <CopyButton value={command} label="Copy command" withText />
      </div>
      <p className="mt-2 text-2xs leading-relaxed text-muted">{guidance}</p>
    </div>
  );
}

function NodeFact({
  label,
  version,
  path,
  broken = false,
  emptyLabel = 'Unknown',
}: {
  label: string;
  version: string | null;
  path: string | null;
  broken?: boolean;
  emptyLabel?: string;
}) {
  return (
    <div>
      <div className="text-2xs text-faint">{label}</div>
      <div className={cn('text-xs font-medium', broken ? 'text-warn' : 'text-ink')}>
        {version ?? (broken ? 'Missing' : emptyLabel)}
      </div>
      <div className="break-all font-mono text-2xs text-faint">{path ?? '—'}</div>
    </div>
  );
}

function RuntimeBlock({ runtime }: { runtime: ServiceRuntime }) {
  const view = describeRuntime(runtime);
  if (!view) return null;

  return (
    <div className="rounded-md border border-line bg-canvas/40 px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-2xs font-medium uppercase tracking-wider text-faint">Node runtime</div>
        {view.broken ? (
          <Badge tone="warn">service runtime missing</Badge>
        ) : !view.pinned ? (
          <Badge tone="warn">not pinned</Badge>
        ) : view.sameAsSystem ? (
          <Badge tone="neutral">same as system</Badge>
        ) : (
          <Badge tone="info">pinned copy</Badge>
        )}
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <NodeFact
          label="Service Node"
          version={view.serviceVersion}
          path={view.servicePath}
          broken={view.broken}
          emptyLabel={view.pinned ? 'Unknown' : 'Not pinned'}
        />
        <NodeFact label="System Node" version={view.systemVersion} path={view.systemPath} />
      </div>
      {view.manager && (
        <p className="mt-2 text-2xs text-faint">
          The system Node is managed by {view.manager}. The service uses its own pinned binary so
          switching versions cannot break it.
        </p>
      )}
      {!view.pinned && !view.broken && (
        <p className="mt-2 text-2xs text-faint">
          No pinned Node was found. The service will start with whatever{' '}
          <code className="font-mono">node</code> its launcher resolves;{' '}
          <code className="font-mono">ezz service repair</code> pins one.
        </p>
      )}
      {view.pinned && !view.sameAsSystem && !view.broken && view.serviceVersion && (
        <p className="mt-2 text-2xs text-faint">
          The service is pinned to a different Node than this dashboard. That is normal after an
          upgrade; <code className="font-mono">ezz service repair</code> re-pins it.
        </p>
      )}
    </div>
  );
}

function ProcessLogsModal({ app, onClose }: { app: ProcessApp; onClose: () => void }) {
  const logs = useResource<ProcessLogs>((signal) => api.processes.logs(app.name, 200, signal));
  const text = (logs.data?.lines ?? []).join('\n');

  return (
    <Modal
      open
      onClose={onClose}
      title={`Logs — ${app.name}`}
      description="The last 200 lines PM2 has written for this process."
      size="lg"
      footer={
        <>
          {text.trim() && <CopyButton value={text} label="Copy logs" withText />}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {logs.error && !logs.data ? (
        <ErrorState
          error={logs.error}
          title="Could not read the logs"
          onRetry={logs.reload}
          className="border-0"
        />
      ) : !logs.data ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Spinner />
          Reading logs…
        </div>
      ) : (
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-canvas p-3.5 font-mono text-2xs leading-relaxed text-muted">
          {text.trim() ? text : '(no output)'}
        </pre>
      )}
    </Modal>
  );
}

function ProcessRow({
  app,
  isModule,
  busy,
  currentUser,
  onAction,
  onLogs,
}: {
  app: ProcessApp;
  isModule: boolean;
  busy: { name: string; action: ProcessAction } | null;
  currentUser: string | null;
  onAction: (app: ProcessApp, action: ProcessAction, isModule: boolean) => void;
  onLogs: (app: ProcessApp) => void;
}) {
  const isBusy = busy?.name === app.name;
  const otherUser = Boolean(app.user && currentUser && app.user !== currentUser);

  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot tone={statusTone(app.status)} pulse={app.status === 'online'} />
            <span className="truncate text-sm font-medium text-ink">{app.name}</span>
            <Badge tone={statusTone(app.status)}>{app.status}</Badge>
            {isModule && <Badge tone="info">module</Badge>}
            {otherUser && <Badge tone="warn">{app.user}</Badge>}
          </div>
          {(app.execPath || app.cwd) && (
            <p className="mt-0.5 truncate font-mono text-2xs text-faint">
              {app.execPath ?? app.cwd}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {app.status === 'online' ? (
            <Button
              variant="secondary"
              size="sm"
              loading={isBusy && busy?.action === 'stop'}
              disabled={isBusy || otherUser}
              icon={<Square className="size-3" aria-hidden="true" />}
              onClick={() => onAction(app, 'stop', isModule)}
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={isBusy && busy?.action === 'start'}
              disabled={isBusy || otherUser}
              icon={<Play className="size-3" aria-hidden="true" />}
              onClick={() => onAction(app, 'start', isModule)}
            >
              Start
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            loading={isBusy && busy?.action === 'restart'}
            disabled={isBusy || otherUser}
            icon={<RotateCw className="size-3.5" aria-hidden="true" />}
            onClick={() => onAction(app, 'restart', isModule)}
          >
            Restart
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={isBusy}
            icon={<ScrollText className="size-3.5" aria-hidden="true" />}
            onClick={() => onLogs(app)}
          >
            Logs
          </Button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="CPU" value={metricPercent(app.cpu)} />
        <Metric label="Memory" value={metricBytes(app.memoryBytes)} />
        <Metric label="Uptime" value={formatUptime(app.uptimeMs)} />
        <Metric
          label="Restarts"
          value={
            app.unstableRestarts > 0
              ? `${app.restarts} · ${app.unstableRestarts} unstable`
              : String(app.restarts)
          }
        />
      </div>
    </li>
  );
}

type ProcessView = 'list' | 'table';

const PROCESS_VIEW_KEY = 'ez.processes.view';

function readStoredView(): ProcessView {
  try {
    return localStorage.getItem(PROCESS_VIEW_KEY) === 'table' ? 'table' : 'list';
  } catch {
    return 'list';
  }
}

function ViewToggle({ view, onChange }: { view: ProcessView; onChange: (view: ProcessView) => void }) {
  const options = [
    { id: 'list' as const, label: 'List view', icon: List },
    { id: 'table' as const, label: 'Table view', icon: Table2 },
  ];

  return (
    <div
      role="group"
      aria-label="Process layout"
      className="inline-flex items-center gap-0.5 rounded-md border border-line bg-raised p-0.5"
    >
      {options.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          title={label}
          onClick={() => onChange(id)}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-sm transition-colors duration-[var(--ez-motion-fast)]',
            view === id ? 'bg-surface text-ink shadow-sm' : 'text-faint hover:text-ink'
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}

function RestartCell({ app }: { app: ProcessApp }) {
  return app.unstableRestarts > 0
    ? `${app.restarts} · ${app.unstableRestarts} unstable`
    : String(app.restarts);
}

function ProcessTable({
  apps,
  isModule,
  busy,
  currentUser,
  onAction,
  onLogs,
}: {
  apps: ProcessApp[];
  isModule: boolean;
  busy: { name: string; action: ProcessAction } | null;
  currentUser: string | null;
  onAction: (app: ProcessApp, action: ProcessAction, isModule: boolean) => void;
  onLogs: (app: ProcessApp) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[42rem] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-2xs uppercase tracking-wider text-faint">
            <th scope="col" className="px-4 py-2 font-medium sm:px-5">
              Process
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              CPU
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Memory
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Uptime
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Restarts
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium sm:px-5">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {apps.map((app) => {
            const isBusy = busy?.name === app.name;
            const otherUser = Boolean(app.user && currentUser && app.user !== currentUser);

            return (
              <tr key={`${app.name}-${app.pmId ?? 'x'}`} className="border-b border-line/70 last:border-0">
                <td className="px-4 py-2 sm:px-5">
                  <div className="flex items-center gap-2">
                    <StatusDot tone={statusTone(app.status)} pulse={app.status === 'online'} />
                    <span className="truncate text-sm font-medium text-ink">{app.name}</span>
                    {isModule && <Badge tone="info">module</Badge>}
                    {otherUser && <Badge tone="warn">{app.user}</Badge>}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <Badge tone={statusTone(app.status)}>{app.status}</Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted">
                  {metricPercent(app.cpu)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted">
                  {metricBytes(app.memoryBytes)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted">
                  {formatUptime(app.uptimeMs)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted">
                  <RestartCell app={app} />
                </td>
                <td className="px-4 py-2 sm:px-5">
                  <div className="flex items-center justify-end gap-1">
                    {app.status === 'online' ? (
                      <IconButton
                        label={`Stop ${app.name}`}
                        size="sm"
                        disabled={isBusy || otherUser}
                        onClick={() => onAction(app, 'stop', isModule)}
                      >
                        {isBusy && busy?.action === 'stop' ? (
                          <Loader2 className="spin size-3.5" aria-hidden="true" />
                        ) : (
                          <Square className="size-3" aria-hidden="true" />
                        )}
                      </IconButton>
                    ) : (
                      <IconButton
                        label={`Start ${app.name}`}
                        size="sm"
                        disabled={isBusy || otherUser}
                        onClick={() => onAction(app, 'start', isModule)}
                      >
                        {isBusy && busy?.action === 'start' ? (
                          <Loader2 className="spin size-3.5" aria-hidden="true" />
                        ) : (
                          <Play className="size-3" aria-hidden="true" />
                        )}
                      </IconButton>
                    )}
                    <IconButton
                      label={`Restart ${app.name}`}
                      size="sm"
                      disabled={isBusy || otherUser}
                      onClick={() => onAction(app, 'restart', isModule)}
                    >
                      {isBusy && busy?.action === 'restart' ? (
                        <Loader2 className="spin size-3.5" aria-hidden="true" />
                      ) : (
                        <RotateCw className="size-3.5" aria-hidden="true" />
                      )}
                    </IconButton>
                    <IconButton
                      label={`View logs for ${app.name}`}
                      size="sm"
                      disabled={isBusy}
                      onClick={() => onLogs(app)}
                    >
                      <ScrollText className="size-3.5" aria-hidden="true" />
                    </IconButton>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ProcessesPage() {
  useDocumentTitle('Processes');
  const toast = useToast();
  const confirm = useConfirm();
  const {
    service,
    loading: serviceLoading,
    error: serviceError,
    reload: reloadService,
    applyBackgroundService,
  } = useService();
  const serviceView = describeService(service);

  const processes = useResource<ProcessesResponse>((signal) => api.processes.list(signal));
  const [busy, setBusy] = useState<{ name: string; action: ProcessAction } | null>(null);
  const [logsFor, setLogsFor] = useState<ProcessApp | null>(null);
  const [serviceBusy, setServiceBusy] = useState<ServiceAction | null>(null);
  const [serviceGuidance, setServiceGuidance] = useState<ServiceGuidance | null>(null);
  const [view, setView] = useState<ProcessView>(readStoredView);

  const changeView = (next: ProcessView) => {
    setView(next);
    try {
      localStorage.setItem(PROCESS_VIEW_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice just will not stick.
    }
  };

  const reloadAll = () => {
    processes.reload();
    reloadService();
  };

  usePolling(processes.reload, 15_000);
  // Fallback if a service:changed event is missed. Skip while a read is still
  // in flight: the native status probe can take longer than the interval, and
  // each reload aborts the previous request.
  usePolling(() => {
    if (!serviceLoading) reloadService();
  }, 15_000);
  useRefreshOnVisible(reloadAll);

  const runAction = async (app: ProcessApp, action: ProcessAction, isModule: boolean) => {
    if (busy) return;
    if (action === 'stop' || action === 'restart') {
      const body = isModule
        ? action === 'stop'
          ? app.name.toLowerCase().includes('logrotate')
            ? `${app.name} rotates PM2's logs. Stopping it lets PM2 logs grow without limit until you start it again. It is a PM2 module, not one of your apps.`
            : `${app.name} is a PM2 module, not one of your apps. Stopping it changes how PM2 itself behaves.`
          : `${app.name} is a PM2 module. Restarting it briefly stops the behaviour it adds to PM2.`
        : `${app.name} is one of your own PM2 apps. ${
            action === 'stop' ? 'Stopping' : 'Restarting'
          } it affects whatever else relies on it.`;
      const ok = await confirm({
        title: `${action === 'stop' ? 'Stop' : 'Restart'} ${app.name}?`,
        body,
        confirmLabel:
          isModule && action === 'stop'
            ? 'Stop module anyway'
            : `${action === 'stop' ? 'Stop' : 'Restart'} anyway`,
        tone: 'danger',
      });
      if (!ok) return;
    }

    setBusy({ name: app.name, action });
    try {
      const result = await api.processes.action(app.name, action);
      toast.success(`${app.name}: ${action} done`, result.output || undefined);
      reloadAll();
    } catch (error) {
      toast.error(
        `Could not ${action} ${app.name}`,
        failureText(error, 'PM2 refused the action. Check the PM2 log for details.')
      );
    } finally {
      setBusy(null);
    }
  };

  const runServiceAction = async (action: ServiceAction) => {
    if (!serviceView || serviceBusy) return;

    const startsPhrase =
      serviceView.startsAt === 'logon'
        ? 'at your next logon'
        : serviceView.startsAt === 'boot'
          ? 'at the next boot'
          : 'when the service starts';
    const ok = await confirm(
      action === 'start'
        ? {
            title: 'Start the background service?',
            body: serviceView.installed
              ? `Monitoring and notifications keep running after this dashboard closes. From now on it also starts ${startsPhrase}.`
              : 'The service is not installed; if it cannot start, the exact install command is shown instead.',
            confirmLabel: 'Start service',
          }
        : action === 'stop'
          ? {
              title: 'Stop the background service?',
              body: serviceView.installed
                ? `Monitoring and notifications pause while it is down. It returns ${startsPhrase} or as soon as you start it again.`
                : 'Monitoring and notifications pause while it is down. It will not restart until you start it, because it is not installed.',
              confirmLabel: 'Stop service',
              tone: 'danger' as const,
            }
          : {
              title: 'Restart the background service?',
              body: 'Monitoring pauses for a moment while the service restarts. Jobs resume when it is back up.',
              confirmLabel: 'Restart service',
              tone: 'danger' as const,
            }
    );
    if (!ok) return;

    setServiceBusy(action);
    setServiceGuidance(null);
    try {
      const result = await api.service[action]();
      applyBackgroundService(result.backgroundService);
      toast.success(
        action === 'start'
          ? 'Background service started'
          : action === 'stop'
            ? 'Background service stopped'
            : 'Background service restarted',
        result.output?.trim() || undefined
      );
      reloadService();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.payload.backgroundService) {
          applyBackgroundService(error.payload.backgroundService);
        }
        if (error.status === 403 && error.code === 'elevation_required') {
          setServiceGuidance({
            kind: 'elevation',
            action,
            command:
              typeof error.payload.command === 'string'
                ? error.payload.command
                : `ezz service ${action}`,
            shell: typeof error.payload.shell === 'string' ? error.payload.shell : null,
            message: typeof error.payload.message === 'string' ? error.payload.message : null,
          });
          return;
        }
        if (error.status === 409 && error.code === 'not_installed') {
          setServiceGuidance({
            kind: 'install',
            action,
            command:
              typeof error.payload.command === 'string'
                ? error.payload.command
                : service?.install.command ?? 'ezz service install',
            shell: service?.install.shell ?? null,
            message: typeof error.payload.message === 'string' ? error.payload.message : null,
          });
          return;
        }
        if (error.status === 409 && error.code === 'already_running') {
          toast.info(
            'The background service is already running.',
            typeof error.payload.message === 'string' ? error.payload.message : undefined
          );
          reloadService();
          return;
        }
        toast.error(
          `Could not ${action} the background service`,
          failureText(error, 'The service manager refused the action.')
        );
        reloadService();
        return;
      }
      toast.error(
        `Could not ${action} the background service`,
        error instanceof Error ? error.message : 'The dashboard could not complete the action.'
      );
    } finally {
      setServiceBusy(null);
    }
  };

  const apps = (processes.data?.apps ?? []).filter((app) => !app.managed);
  const currentUser = processes.data?.currentUser ?? null;
  const pm2Home = processes.data?.pm2Home ?? null;
  const modules = apps.filter((app) => isPm2Module(app, pm2Home));
  const userApps = apps.filter((app) => !isPm2Module(app, pm2Home));

  return (
    <>
      <PageHeader
        title="Processes"
        description="The Easy DevOps background service, plus every PM2 app you run for yourself."
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={processes.loading || serviceLoading}
            icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
            onClick={reloadAll}
          >
            Refresh
          </Button>
        }
      />

      {processes.error && !processes.data ? (
        <ErrorState error={processes.error} onRetry={processes.reload} />
      ) : !processes.data ? (
        <PageSkeleton>
          <Skeleton className="h-56 rounded-lg" />
          <Skeleton className="h-72 rounded-lg" />
        </PageSkeleton>
      ) : (
        <div className="space-y-5">
          <Card className="overflow-hidden">
            <div
              className={cn('h-0.5 w-full', serviceView?.running ? 'bg-ok/60' : 'bg-warn/60')}
              aria-hidden="true"
            />
            <CardHeader
              icon={<ServerCog className="size-4" aria-hidden="true" />}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  Background service
                  {serviceView && (
                    <Badge tone={serviceView.running ? 'ok' : 'warn'} dot>
                      {serviceStateLabel(serviceView)}
                    </Badge>
                  )}
                  {service?.dev && <Badge tone="warn">dev data dir</Badge>}
                </span>
              }
              description="Runs monitoring and notifications in the background, independent of this dashboard."
              actions={
                serviceView ? (
                  serviceView.running ? (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={serviceBusy === 'stop'}
                        disabled={serviceBusy !== null}
                        icon={<Square className="size-3" aria-hidden="true" />}
                        onClick={() => void runServiceAction('stop')}
                      >
                        Stop
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={serviceBusy === 'restart'}
                        disabled={serviceBusy !== null}
                        icon={<RotateCw className="size-3.5" aria-hidden="true" />}
                        onClick={() => void runServiceAction('restart')}
                      >
                        Restart
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      loading={serviceBusy === 'start'}
                      disabled={serviceBusy !== null}
                      icon={<Play className="size-3" aria-hidden="true" />}
                      onClick={() => void runServiceAction('start')}
                    >
                      Start
                    </Button>
                  )
                ) : undefined
              }
            />

            <CardBody className="space-y-4">
              {serviceGuidance && (
                <InlineAlert
                  tone="warning"
                  title={
                    serviceGuidance.kind === 'install'
                      ? 'The background service is not installed'
                      : `${
                          serviceGuidance.action === 'start'
                            ? 'Starting'
                            : serviceGuidance.action === 'stop'
                              ? 'Stopping'
                              : 'Restarting'
                        } needs ${serviceGuidance.shell ?? 'a terminal with extra rights'}`
                  }
                  action={
                    <IconButton
                      label="Dismiss"
                      size="sm"
                      onClick={() => setServiceGuidance(null)}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </IconButton>
                  }
                >
                  {serviceGuidance.message && <p>{serviceGuidance.message}</p>}
                  <div className="mt-2 rounded-md border border-line bg-canvas p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="break-all font-mono text-xs text-ink">
                        {serviceGuidance.command}
                      </code>
                      <CopyButton
                        value={serviceGuidance.command}
                        label="Copy command"
                        withText
                      />
                    </div>
                    {serviceGuidance.shell && (
                      <p className="mt-1.5 text-2xs text-faint">
                        Run it in {serviceGuidance.shell}.
                      </p>
                    )}
                  </div>
                  <p className="mt-2 text-2xs text-faint">
                    {serviceGuidance.kind === 'elevation'
                      ? 'The dashboard cannot elevate itself or ask for a password. Run the command in a terminal you control.'
                      : 'The command is run in a terminal, not from this dashboard.'}
                  </p>
                </InlineAlert>
              )}

              {serviceError && !service ? (
                <ErrorState
                  error={serviceError}
                  title="Could not read the service state"
                  onRetry={reloadService}
                  className="border-0"
                />
              ) : !serviceView ? (
                <div className="flex items-center gap-2 py-6 text-sm text-muted">
                  <Spinner />
                  Checking the background service…
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
                    <ServiceFact
                      label="Status"
                      value={serviceStateLabel(serviceView)}
                      tone={serviceView.running ? 'text-ok' : 'text-warn'}
                      detail={
                        serviceView.stoppedByUser && serviceView.stoppedAtLabel
                          ? `Stopped ${serviceView.stoppedAtLabel}`
                          : serviceView.detail ?? undefined
                      }
                    />
                    <ServiceFact
                      label="PID"
                      value={serviceView.pid === null ? '—' : String(serviceView.pid)}
                    />
                    <ServiceFact label="Uptime" value={formatUptime(serviceView.uptimeMs)} />
                    <ServiceFact
                      label="Installed"
                      value={serviceView.installed ? 'Yes' : 'No'}
                    />
                    <ServiceFact
                      label="Mode"
                      value={serviceView.mechanismLabel}
                      detail={serviceView.mechanismDetail}
                    />
                    <ServiceFact label="Starts" value={serviceView.startsAtLabel} />
                    <ServiceFact
                      label="Monitoring runs in"
                      value={serviceView.jobsOwnerLabel}
                    />
                    <ServiceFact
                      label="Live channel"
                      value={serviceView.connected ? 'Connected' : 'Not connected'}
                    />
                  </div>

                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-2xs text-faint">
                    <span className="min-w-0">
                      Data directory{' '}
                      <code className="break-all font-mono text-muted">{service?.dataDir ?? '—'}</code>
                    </span>
                    {serviceView.version && (
                      <span>
                        Daemon <code className="font-mono text-muted">{serviceView.version}</code>
                      </span>
                    )}
                  </div>

                  {serviceView.runtime ? (
                    <RuntimeBlock runtime={serviceView.runtime} />
                  ) : (
                    <p className="text-2xs text-faint">
                      The service and system Node versions are not available for this install.
                    </p>
                  )}

                  {serviceView.warnings.map((warning) => (
                    <InlineAlert key={warning} tone="warning">
                      <span className="whitespace-pre-line">{warning}</span>
                    </InlineAlert>
                  ))}

                  {!serviceView.running && (
                    <InlineAlert
                      tone="warning"
                      title={
                        serviceView.stoppedByUser
                          ? 'The background service is stopped'
                          : !serviceView.installed
                            ? 'The background service is not set up'
                            : 'The background service is not running'
                      }
                    >
                      {serviceView.stoppedByUser ? (
                        <>
                          You stopped it
                          {serviceView.stoppedAtLabel
                            ? ` on ${serviceView.stoppedAtLabel}`
                            : ''}
                          . Monitoring and notifications are paused until it starts again{' '}
                          {serviceView.startsAt === 'logon'
                            ? 'at your next logon'
                            : serviceView.startsAt === 'boot'
                              ? 'at the next boot'
                              : 'when the service starts'}
                          . Use Start above, or run{' '}
                          <code className="font-mono">ezz service start</code>.
                        </>
                      ) : !serviceView.installed ? (
                        <>
                          Monitoring and notifications run in this dashboard and stop when it
                          closes. Set up the service with{' '}
                          <code className="font-mono">{serviceView.installCommand}</code>.
                        </>
                      ) : (
                        <>
                          Monitoring and notifications run in this dashboard and stop when it closes.
                          Start the service with <code className="font-mono">ezz service start</code>,
                          or use Start above.
                        </>
                      )}
                    </InlineAlert>
                  )}

                  <details className="rounded-md border border-line bg-canvas/40 px-3.5 py-3">
                    <summary className="cursor-pointer select-none text-xs font-medium text-ink">
                      Install or repair the service
                    </summary>
                    <div className="mt-3 space-y-2.5">
                      <InstallCommand
                        command={serviceView.installCommand}
                        guidance={serviceView.installGuidance}
                      />
                      <p className="text-2xs text-faint">
                        The command is run in a terminal, not from this dashboard.{' '}
                        {serviceView.startsAt === 'logon'
                          ? 'It starts the service at logon.'
                          : serviceView.startsAt === 'boot'
                            ? 'It starts the service at boot.'
                            : 'It sets the service up to start automatically.'}{' '}
                        It never asks for an account password.
                      </p>
                    </div>
                  </details>
                </>
              )}
            </CardBody>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  Your PM2 apps
                  {userApps.length > 0 && (
                    <Badge tone="neutral">{pluralize(userApps.length, 'app')}</Badge>
                  )}
                </span>
              }
              description={
                currentUser
                  ? `Apps PM2 is supervising for ${currentUser}. Easy DevOps itself is not one of them.`
                  : 'Apps PM2 is supervising for you. Easy DevOps itself is not one of them.'
              }
              actions={
                userApps.length > 0 || modules.length > 0 ? (
                  <ViewToggle view={view} onChange={changeView} />
                ) : undefined
              }
            />

            {processes.data.pm2.installed && processes.data.hint && (
              <div className="border-b border-line px-4 py-2.5 sm:px-5">
                <InlineAlert tone="warning">{processes.data.hint}</InlineAlert>
              </div>
            )}

            {processes.error && (
              <div className="border-b border-line px-4 py-2 text-2xs text-muted sm:px-5">
                Showing the last known list. {processes.error.message}{' '}
                <button
                  type="button"
                  className="font-medium text-ink underline-offset-2 hover:underline"
                  onClick={processes.reload}
                >
                  Try again
                </button>
              </div>
            )}

            {!processes.data.pm2.installed ? (
              <EmptyState
                icon={<ScrollText className="size-5" aria-hidden="true" />}
                title="PM2 is not installed"
                description="PM2 is optional. It is only for apps you run yourself; Easy DevOps uses its own background service."
              />
            ) : userApps.length === 0 ? (
              <EmptyState
                icon={<ScrollText className="size-5" aria-hidden="true" />}
                title="No PM2 apps of your own"
                description="Start an app with PM2 and it will appear here. Easy DevOps does not run itself under PM2."
              />
            ) : (
              <div key={view} className="panel-enter">
                {view === 'table' ? (
                  <ProcessTable
                    apps={userApps}
                    isModule={false}
                    busy={busy}
                    currentUser={currentUser}
                    onAction={runAction}
                    onLogs={setLogsFor}
                  />
                ) : (
                  <ul className="divide-y divide-line/70">
                    {userApps.map((app) => (
                      <ProcessRow
                        key={`${app.name}-${app.pmId ?? 'x'}`}
                        app={app}
                        isModule={false}
                        busy={busy}
                        currentUser={currentUser}
                        onAction={runAction}
                        onLogs={setLogsFor}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>

          {modules.length > 0 && (
            <Card className="overflow-hidden">
              <CardHeader
                title={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    PM2 modules
                    <Badge tone="neutral">{pluralize(modules.length, 'module')}</Badge>
                  </span>
                }
                description="Modules extend PM2 itself and are not your apps. Stopping pm2-logrotate lets PM2 logs grow without limit."
              />
              <div key={view} className="panel-enter">
                {view === 'table' ? (
                  <ProcessTable
                    apps={modules}
                    isModule={true}
                    busy={busy}
                    currentUser={currentUser}
                    onAction={runAction}
                    onLogs={setLogsFor}
                  />
                ) : (
                  <ul className="divide-y divide-line/70">
                    {modules.map((app) => (
                      <ProcessRow
                        key={`${app.name}-${app.pmId ?? 'x'}`}
                        app={app}
                        isModule={true}
                        busy={busy}
                        currentUser={currentUser}
                        onAction={runAction}
                        onLogs={setLogsFor}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          )}
        </div>
      )}

      {logsFor && <ProcessLogsModal app={logsFor} onClose={() => setLogsFor(null)} />}
    </>
  );
}
