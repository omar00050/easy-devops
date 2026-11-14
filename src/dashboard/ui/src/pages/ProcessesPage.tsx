import { useState } from 'react';
import {
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  ServerCog,
  Square,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type {
  ProcessAction,
  ProcessApp,
  ProcessLogs,
  ProcessesResponse,
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
import { Button } from '../components/ui/Button';
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
    const detail = typeof error.payload.detail === 'string' ? error.payload.detail : null;
    return detail ?? error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

function statusTone(status: string): Tone {
  if (status === 'online') return 'ok';
  if (status === 'errored') return 'bad';
  if (status === 'stopping' || status === 'launching') return 'warn';
  return 'neutral';
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
}: {
  label: string;
  version: string | null;
  path: string | null;
  broken?: boolean;
}) {
  return (
    <div>
      <div className="text-2xs text-faint">{label}</div>
      <div className={cn('text-xs font-medium', broken ? 'text-warn' : 'text-ink')}>
        {version ?? (broken ? 'Missing' : 'Unknown')}
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
          <Badge tone="warn">service copy missing</Badge>
        ) : view.sameAsSystem ? (
          <Badge tone="neutral">same as system</Badge>
        ) : (
          <Badge tone="info">pinned copy</Badge>
        )}
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <NodeFact
          label="Service"
          version={view.serviceVersion}
          path={view.servicePath}
          broken={view.broken}
        />
        <NodeFact label="System" version={view.systemVersion} path={view.systemPath} />
      </div>
      {!view.sameAsSystem && !view.broken && view.serviceVersion && (
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

export function ProcessesPage() {
  useDocumentTitle('Processes');
  const toast = useToast();
  const confirm = useConfirm();
  const { service, loading: serviceLoading, error: serviceError, reload: reloadService } = useService();
  const serviceView = describeService(service);

  const processes = useResource<ProcessesResponse>((signal) => api.processes.list(signal));
  const [busy, setBusy] = useState<{ name: string; action: ProcessAction } | null>(null);
  const [logsFor, setLogsFor] = useState<ProcessApp | null>(null);

  const reloadAll = () => {
    processes.reload();
    reloadService();
  };

  usePolling(processes.reload, 15_000);
  useRefreshOnVisible(reloadAll);

  const runAction = async (app: ProcessApp, action: ProcessAction) => {
    if (busy) return;
    if (action === 'stop' || action === 'restart') {
      const ok = await confirm({
        title: `${action === 'stop' ? 'Stop' : 'Restart'} ${app.name}?`,
        body: `${app.name} is one of your own PM2 apps. ${
          action === 'stop' ? 'Stopping' : 'Restarting'
        } it affects whatever else relies on it.`,
        confirmLabel: `${action === 'stop' ? 'Stop' : 'Restart'} anyway`,
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

  const apps = (processes.data?.apps ?? []).filter((app) => !app.managed);
  const currentUser = processes.data?.currentUser ?? null;

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
            />

            <CardBody className="space-y-4">
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
                    />
                    <ServiceFact
                      label="PID"
                      value={serviceView.pid === null ? '—' : String(serviceView.pid)}
                    />
                    <ServiceFact label="Uptime" value={formatUptime(serviceView.uptimeMs)} />
                    <ServiceFact
                      label="Installed"
                      value={
                        serviceView.installed === null
                          ? 'Unknown'
                          : serviceView.installed
                            ? 'Yes'
                            : 'No'
                      }
                    />
                    <ServiceFact
                      label="Mode"
                      value={serviceView.mechanismLabel}
                      detail={serviceView.mechanismDetail}
                    />
                    <ServiceFact label="Starts" value={serviceView.startsAtLabel} />
                    <ServiceFact
                      label="Monitoring runs in"
                      value={serviceView.jobsRunningHere ? 'This dashboard' : 'Background service'}
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
                      The service and system Node versions are not reported by this API yet.
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
                          : serviceView.installed === false
                            ? 'The background service is not set up'
                            : 'The background service is not running'
                      }
                    >
                      {serviceView.stoppedByUser ? (
                        <>
                          You stopped it. Monitoring and notifications are paused until it starts
                          again {serviceView.startsAt === 'logon'
                            ? 'at your next logon'
                            : serviceView.startsAt === 'boot'
                              ? 'at the next boot'
                              : 'when the service starts'}
                          . Start it now with <code className="font-mono">ezz service start</code>.
                        </>
                      ) : serviceView.installed === false ? (
                        <>
                          Monitoring and notifications run in this dashboard and stop when it
                          closes. Set up the service with{' '}
                          <code className="font-mono">{serviceView.installCommand}</code>.
                        </>
                      ) : (
                        <>
                          Monitoring and notifications run in this dashboard and stop when it closes.
                          Start the service with <code className="font-mono">ezz service start</code>
                          {serviceView.installed === null ? (
                            <>
                              , or set it up with{' '}
                              <code className="font-mono">{serviceView.installCommand}</code> if it was
                              never installed
                            </>
                          ) : null}
                          .
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
                  {apps.length > 0 && (
                    <Badge tone="neutral">{pluralize(apps.length, 'app')}</Badge>
                  )}
                </span>
              }
              description={
                currentUser
                  ? `Apps PM2 is supervising for ${currentUser}. Easy DevOps itself is not one of them.`
                  : 'Apps PM2 is supervising for you. Easy DevOps itself is not one of them.'
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
            ) : apps.length === 0 ? (
              <EmptyState
                icon={<ScrollText className="size-5" aria-hidden="true" />}
                title="No PM2 apps of your own"
                description="Start an app with PM2 and it will appear here. Easy DevOps does not run itself under PM2."
              />
            ) : (
              <ul className="divide-y divide-line/70">
                {apps.map((app) => {
                  const isBusy = busy?.name === app.name;
                  const otherUser = Boolean(app.user && currentUser && app.user !== currentUser);
                  return (
                    <li key={`${app.name}-${app.pmId ?? 'x'}`} className="px-4 py-3.5 sm:px-5">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusDot tone={statusTone(app.status)} pulse={app.status === 'online'} />
                            <span className="truncate text-sm font-medium text-ink">{app.name}</span>
                            <Badge tone={statusTone(app.status)}>{app.status}</Badge>
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
                              onClick={() => void runAction(app, 'stop')}
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
                              onClick={() => void runAction(app, 'start')}
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
                            onClick={() => void runAction(app, 'restart')}
                          >
                            Restart
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isBusy}
                            icon={<ScrollText className="size-3.5" aria-hidden="true" />}
                            onClick={() => setLogsFor(app)}
                          >
                            Logs
                          </Button>
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <Metric label="CPU" value={formatPercent(app.cpu)} />
                        <Metric label="Memory" value={formatBytes(app.memoryBytes)} />
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
                })}
              </ul>
            )}
          </Card>
        </div>
      )}

      {logsFor && <ProcessLogsModal app={logsFor} onClose={() => setLogsFor(null)} />}
    </>
  );
}
