import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Globe2,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { ApiError } from '../lib/errors';
import type {
  Certificate,
  Domain,
  DomainHealthEntry,
  NginxStatus,
  NotificationEvent,
} from '../lib/types';
import {
  useConfirm,
  useDocumentTitle,
  useRefreshOnVisible,
  useResource,
} from '../hooks/useResource';
import { useLocalChange } from '../hooks/useLocalChange';
import { useRealtime } from '../app/RealtimeProvider';
import { useService } from '../app/ServiceProvider';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge, StatusDot, type Tone } from '../components/ui/Badge';
import { Button, buttonClasses } from '../components/ui/Button';
import {
  ErrorState,
  InlineAlert,
  PageSkeleton,
  Skeleton,
} from '../components/ui/States';
import { useToast } from '../components/ui/Toast';
import { cn } from '../lib/cn';
import { formatDaysLeft, pluralize, timeAgo } from '../lib/format';
import { describeService } from '../lib/service';

interface OverviewData {
  domains: Domain[];
  certs: Certificate[];
  nginx: NginxStatus;
}

function loadOverview(signal: AbortSignal): Promise<OverviewData> {
  return Promise.all([
    api.domains.list(signal),
    api.ssl.list(signal),
    api.nginx.status(signal),
  ]).then(([domains, certs, nginx]) => ({ domains, certs, nginx }));
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted',
  accent: 'text-accent-text',
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  info: 'text-info',
};

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
  pulse = false,
  to,
}: {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  tone?: Tone;
  pulse?: boolean;
  to: string;
}) {
  return (
    <Link to={to} className="group block rounded-lg">
      <Card className="h-full px-4 py-3.5 transition-colors duration-[var(--ez-motion-fast)] group-hover:border-line-strong">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-faint">
              {label}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className={cn('text-xl font-semibold tracking-tight', TONE_TEXT[tone])}>
                {value}
              </span>
              {(tone === 'ok' || tone === 'bad' || tone === 'warn') && (
                <StatusDot tone={tone} pulse={pulse} />
              )}
            </div>
          </div>
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-inset text-muted transition-colors group-hover:text-ink">
            <Icon className="size-4" aria-hidden="true" />
          </div>
        </div>
        <div className="mt-2 truncate text-2xs text-muted">{hint}</div>
      </Card>
    </Link>
  );
}

interface Issue {
  id: string;
  tone: Tone;
  title: string;
  detail: string;
  to: string;
}

function buildIssues(
  nginx: NginxStatus | null,
  domains: Domain[],
  certs: Certificate[],
  health: Map<string, DomainHealthEntry>
): Issue[] {
  const issues: Issue[] = [];

  if (nginx && !nginx.running) {
    issues.push({
      id: 'nginx-down',
      tone: 'bad',
      title: 'nginx is not running',
      detail: 'No domain is being proxied until nginx is started.',
      to: '/nginx',
    });
  }

  for (const cert of certs) {
    if (cert.status === 'error') {
      issues.push({
        id: `cert-error-${cert.domain}`,
        tone: 'bad',
        title: `Certificate for ${cert.domain} cannot be read`,
        detail: 'The certificate files are missing or unreadable.',
        to: '/ssl',
      });
    } else if (cert.status === 'expired' || (cert.daysLeft !== null && cert.daysLeft < 0)) {
      issues.push({
        id: `cert-expired-${cert.domain}`,
        tone: 'bad',
        title: `Certificate for ${cert.domain} has expired`,
        detail: formatDaysLeft(cert.daysLeft),
        to: '/ssl',
      });
    } else if (cert.status === 'expiring') {
      issues.push({
        id: `cert-expiring-${cert.domain}`,
        tone: 'warn',
        title: `Certificate for ${cert.domain} expires soon`,
        detail: formatDaysLeft(cert.daysLeft),
        to: '/ssl',
      });
    }
  }

  for (const domain of domains) {
    const entry = health.get(domain.name);
    if (entry?.up === false) {
      issues.push({
        id: `domain-down-${domain.name}`,
        tone: 'bad',
        title: `${domain.name} is not responding`,
        detail: `The backend ${domain.backendHost}:${domain.port} did not answer a health check.`,
        to: '/domains',
      });
    }
  }

  return issues;
}

function HealthBadge({ entry }: { entry: DomainHealthEntry | undefined }) {
  if (!entry) return <span className="text-2xs text-faint">Awaiting check</span>;
  if (entry.up === null) {
    return (
      <Badge tone="neutral" dot>
        External
      </Badge>
    );
  }
  return entry.up ? (
    <Badge tone="ok" dot>
      Up
    </Badge>
  ) : (
    <Badge tone="bad" dot>
      Down
    </Badge>
  );
}

function eventIcon(event: NotificationEvent): { icon: LucideIcon; tone: string } {
  if (event.type === 'nginx_down') return { icon: Server, tone: 'text-muted' };
  if (event.type === 'cert_expiry') return { icon: ShieldAlert, tone: 'text-warn' };
  if (event.type === 'domain_health') return { icon: Activity, tone: 'text-info' };
  return { icon: Activity, tone: 'text-muted' };
}

export function OverviewPage() {
  useDocumentTitle('Overview');
  const toast = useToast();
  const confirm = useConfirm();
  const { nginxStatus: liveNginx, domainHealth, notifications } = useRealtime();
  const { service } = useService();
  const serviceView = describeService(service);
  const resource = useResource<OverviewData>(loadOverview);
  const [reloading, setReloading] = useState(false);

  useRefreshOnVisible(resource.reload);
  useLocalChange(['domains', 'ssl', 'nginx'], resource.reload);

  const data = resource.data;
  const nginx = liveNginx ?? data?.nginx ?? null;
  const domains = data?.domains ?? [];
  const certs = data?.certs ?? [];
  const health = new Map((domainHealth ?? []).map((entry) => [entry.name, entry]));

  const enabledDomains = domains.filter((domain) => domain.enabled).length;
  const expiring = certs.filter((cert) => cert.status === 'expiring');
  const badCerts = certs.filter((cert) => cert.status === 'expired' || cert.status === 'error');
  const issues = data ? buildIssues(nginx, domains, certs, health) : [];
  const critical = issues.filter((issue) => issue.tone === 'bad').length;
  const healthy = data !== null && nginx?.running === true && issues.length === 0;

  const certHint =
    badCerts.length > 0
      ? `${pluralize(badCerts.length, 'certificate')} expired or unreadable`
      : expiring.length > 0
        ? `${expiring.length} expiring within 30 days`
        : certs.length > 0
          ? 'All certificates healthy'
          : 'No certificates yet';

  const reloadNginx = async () => {
    const ok = await confirm({
      title: 'Reload nginx?',
      body: 'Reloading applies configuration changes. Existing connections are kept open.',
      confirmLabel: 'Reload nginx',
    });
    if (!ok) return;
    setReloading(true);
    try {
      const result = await api.nginx.reload();
      if (result.success) {
        toast.success('Nginx reloaded', result.output.trim() || 'Configuration reloaded.');
        resource.reload();
      } else {
        toast.error('Nginx reload failed', result.output.trim() || 'nginx refused the reload.');
      }
    } catch (error) {
      toast.error(
        'Nginx reload failed',
        error instanceof ApiError ? error.message : 'The dashboard could not complete the reload.'
      );
    } finally {
      setReloading(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Overview"
        description="The state of nginx, your domains and their certificates, live."
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={resource.loading}
            icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
            onClick={resource.reload}
          >
            Refresh
          </Button>
        }
      />

      {resource.error && !data ? (
        <ErrorState error={resource.error} onRetry={resource.reload} />
      ) : !data ? (
        <PageSkeleton>
          <Skeleton className="h-28 w-full rounded-lg" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((key) => (
              <Skeleton key={key} className="h-[92px] rounded-lg" />
            ))}
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            <Skeleton className="h-64 rounded-lg xl:col-span-2" />
            <Skeleton className="h-64 rounded-lg" />
          </div>
        </PageSkeleton>
      ) : (
        <div className="space-y-4">
          {resource.error && (
            <InlineAlert
              tone="warning"
              title="Showing the last known state"
              action={
                <Button variant="ghost" size="sm" onClick={resource.reload}>
                  Try again
                </Button>
              }
            >
              {resource.error.message}
            </InlineAlert>
          )}

          <Card className="relative overflow-hidden">
            <div
              className="status-sheen pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden"
              aria-hidden="true"
            />
            <div className="flex flex-col gap-5 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-4">
                <div
                  className={cn(
                    'relative mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-full border',
                    critical > 0
                      ? 'border-bad/30 bg-bad-soft text-bad'
                      : issues.length > 0
                        ? 'border-warn/30 bg-warn-soft text-warn'
                        : 'border-ok/30 bg-ok-soft text-ok'
                  )}
                >
                  {critical > 0 || issues.length > 0 ? (
                    <TriangleAlert className="size-5" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="size-5" aria-hidden="true" />
                  )}
                  <span
                    className={cn(
                      'absolute -inset-px rounded-full border',
                      critical > 0
                        ? 'border-bad/20'
                        : issues.length > 0
                          ? 'border-warn/20'
                          : 'border-ok/20'
                    )}
                    aria-hidden="true"
                  />
                </div>

                <div aria-live="polite">
                  <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-faint">
                    System status
                  </div>
                  <div className="mt-0.5 text-lg font-semibold tracking-tight text-ink">
                    {critical > 0
                      ? 'Attention needed'
                      : issues.length > 0
                        ? 'A few things to check'
                        : 'All systems healthy'}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {nginx?.running ? 'nginx running' : 'nginx stopped'}
                    {' · '}
                    {pluralize(domains.length, 'domain')}
                    {' · '}
                    {pluralize(certs.length, 'certificate')}
                    {issues.length > 0 && (
                      <>
                        {' · '}
                        <span className={critical > 0 ? 'text-bad' : 'text-warn'}>
                          {pluralize(issues.length, 'item')} need attention
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 sm:flex-col sm:items-end">
                <Badge tone={healthy ? 'ok' : critical > 0 ? 'bad' : 'warn'} dot>
                  {healthy ? 'Healthy' : critical > 0 ? 'Degraded' : 'Check'}
                </Badge>
                <span className="text-2xs text-faint">
                  Checked {data.nginx ? 'live' : '—'}
                  {nginx?.version ? ` · ${nginx.version}` : ''}
                </span>
              </div>
            </div>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Nginx"
              value={nginx ? (nginx.running ? 'Active' : 'Offline') : 'Unknown'}
              hint={
                nginx?.running
                  ? `PID ${nginx.pid ?? '—'}${nginx.version ? ` · ${nginx.version}` : ''}`
                  : 'Traffic is not being proxied.'
              }
              icon={Server}
              tone={nginx ? (nginx.running ? 'ok' : 'bad') : 'neutral'}
              pulse={nginx?.running === true}
              to="/nginx"
            />
            <StatCard
              label="Domains"
              value={`${enabledDomains}/${domains.length}`}
              hint={
                domains.length === 0
                  ? 'No domains configured yet.'
                  : enabledDomains === domains.length
                    ? 'All domains enabled.'
                    : `${domains.length - enabledDomains} disabled.`
              }
              icon={Globe2}
              tone={domains.length === 0 ? 'neutral' : enabledDomains > 0 ? 'accent' : 'warn'}
              to="/domains"
            />
            <StatCard
              label="Certificates"
              value={String(certs.length)}
              hint={certHint}
              icon={ShieldCheck}
              tone={badCerts.length > 0 ? 'bad' : expiring.length > 0 ? 'warn' : certs.length > 0 ? 'ok' : 'neutral'}
              to="/ssl"
            />
            <StatCard
              label="Background service"
              value={!serviceView ? 'Unknown' : serviceView.running ? 'Running' : 'Stopped'}
              hint={
                !serviceView
                  ? 'Checking…'
                  : serviceView.running
                    ? serviceView.startsAt === 'unknown'
                      ? serviceView.mechanismDetail
                      : `${serviceView.mechanismLabel} · starts ${serviceView.startsAtLabel.toLowerCase()}`
                    : serviceView.stoppedByUser
                      ? serviceView.installed
                        ? `You stopped it${
                            serviceView.stoppedAtLabel ? ` on ${serviceView.stoppedAtLabel}` : ''
                          }; it starts again automatically.`
                        : 'You stopped it; start it to resume monitoring.'
                      : serviceView.installed
                        ? 'Monitoring runs in this window.'
                        : 'Not installed; monitoring runs in this window.'
              }
              icon={Boxes}
              tone={!serviceView ? 'neutral' : serviceView.running ? 'ok' : 'warn'}
              pulse={serviceView?.running === true}
              to="/processes"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link to="/domains?new=1" className={buttonClasses('primary', 'sm')}>
              <Plus className="size-3.5" aria-hidden="true" />
              Add domain
            </Link>
            <Link to="/ssl?new=1" className={buttonClasses('secondary', 'sm')}>
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              Issue certificate
            </Link>
            <Button
              variant="secondary"
              size="sm"
              loading={reloading}
              disabled={!nginx?.running}
              icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
              onClick={reloadNginx}
            >
              Reload nginx
            </Button>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
                <div>
                  <h2 className="text-sm font-semibold text-ink">Domain health</h2>
                  <p className="mt-0.5 text-xs text-muted">
                    Backends are checked on connect and every 60 seconds.
                  </p>
                </div>
                <Link to="/domains" className="text-2xs font-medium text-muted hover:text-ink">
                  Manage
                </Link>
              </div>
              {domains.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
                  <Globe2 className="size-5 text-faint" aria-hidden="true" />
                  <div>
                    <div className="text-sm font-medium text-ink">No domains yet</div>
                    <p className="mt-1 text-xs text-muted">
                      Add a domain to put a backend behind nginx.
                    </p>
                  </div>
                  <Link to="/domains?new=1" className={buttonClasses('primary', 'sm')}>
                    Add your first domain
                  </Link>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-faint">
                        <th className="px-4 py-2 font-medium sm:px-5">Domain</th>
                        <th className="hidden px-3 py-2 font-medium sm:table-cell">Target</th>
                        <th className="px-3 py-2 font-medium">Health</th>
                        <th className="hidden px-3 py-2 font-medium md:table-cell">Certificate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {domains.map((domain) => {
                        const entry = health.get(domain.name);
                        return (
                          <tr
                            key={domain.name}
                            className="border-b border-line/60 last:border-0 hover:bg-raised/40"
                          >
                            <td className="px-4 py-2.5 sm:px-5">
                              <Link
                                to={`/domains?domain=${encodeURIComponent(domain.name)}`}
                                className="flex items-center gap-2 font-medium text-ink hover:text-accent-text"
                              >
                                <span className="truncate">{domain.name}</span>
                                {!domain.enabled && <Badge tone="neutral">Disabled</Badge>}
                              </Link>
                            </td>
                            <td className="hidden px-3 py-2.5 font-mono text-2xs text-muted sm:table-cell">
                              {domain.backendHost}:{domain.port}
                            </td>
                            <td className="px-3 py-2.5">
                              <HealthBadge entry={entry} />
                            </td>
                            <td className="hidden px-3 py-2.5 text-2xs md:table-cell">
                              {domain.ssl.enabled ? (
                                <span
                                  className={cn(
                                    domain.daysLeft !== null && domain.daysLeft < 30
                                      ? 'text-warn'
                                      : 'text-muted'
                                  )}
                                >
                                  {domain.daysLeft !== null
                                    ? formatDaysLeft(domain.daysLeft)
                                    : 'Unknown'}
                                </span>
                              ) : (
                                <span className="text-faint">Not enabled</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {domainHealth === null && domains.length > 0 && (
                <div className="border-t border-line px-4 py-2 text-2xs text-faint sm:px-5">
                  Waiting for the first health check…
                </div>
              )}
            </Card>

            <div className="space-y-4">
              <Card>
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <h2 className="text-sm font-semibold text-ink">Needs attention</h2>
                  <span className="text-2xs text-faint">{issues.length}</span>
                </div>
                {issues.length === 0 ? (
                  <div className="flex items-center gap-2.5 px-4 py-5 text-xs text-muted">
                    <CheckCircle2 className="size-4 text-ok" aria-hidden="true" />
                    Nothing needs attention right now.
                  </div>
                ) : (
                  <div className="max-h-[280px] overflow-y-auto">
                    {issues.map((issue) => (
                      <Link
                        key={issue.id}
                        to={issue.to}
                        className="group flex items-start gap-2.5 border-b border-line/60 px-4 py-2.5 last:border-0 hover:bg-raised/50"
                      >
                        <StatusDot
                          tone={issue.tone}
                          className="mt-1"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-ink">{issue.title}</div>
                          <div className="mt-0.5 text-2xs text-muted">{issue.detail}</div>
                        </div>
                        <ChevronRight
                          className="mt-0.5 size-3.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
                          aria-hidden="true"
                        />
                      </Link>
                    ))}
                  </div>
                )}
              </Card>

              <Card>
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <h2 className="text-sm font-semibold text-ink">Recent events</h2>
                  <Link to="/notifications" className="text-2xs font-medium text-muted hover:text-ink">
                    All events
                  </Link>
                </div>
                {notifications.length === 0 ? (
                  <div className="px-4 py-5 text-xs text-muted">
                    No events since this tab opened. Alerts from nginx, certificates and domain
                    health appear here live.
                  </div>
                ) : (
                  <div>
                    {notifications.slice(0, 6).map((event) => {
                      const { icon: Icon, tone } = eventIcon(event);
                      return (
                        <div
                          key={event.id}
                          className="flex items-start gap-2.5 border-b border-line/60 px-4 py-2.5 last:border-0"
                        >
                          <Icon className={cn('mt-0.5 size-3.5 shrink-0', tone)} aria-hidden="true" />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs leading-snug text-ink">{event.message}</div>
                            <div className="mt-0.5 text-2xs text-faint">{timeAgo(event.timestamp)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
