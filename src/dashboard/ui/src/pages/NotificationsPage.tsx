import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BellRing,
  FlaskConical,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Server,
  ShieldAlert,
  Sparkles,
  Trash2,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type {
  Domain,
  DomainEventRouting,
  NotificationChannel,
  NotificationEvent,
} from '../lib/types';
import { cn } from '../lib/cn';
import { timeAgo, pluralize } from '../lib/format';
import {
  useConfirm,
  useDocumentTitle,
  useRefreshOnVisible,
  useResource,
} from '../hooks/useResource';
import { useLocalChange } from '../hooks/useLocalChange';
import { useRealtime } from '../app/RealtimeProvider';
import { PageHeader } from '../components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge, StatusDot } from '../components/ui/Badge';
import { Button, buttonClasses, IconButton } from '../components/ui/Button';
import {
  EmptyState,
  ErrorState,
  InlineAlert,
  PageSkeleton,
  Skeleton,
} from '../components/ui/States';
import { useToast } from '../components/ui/Toast';
import { ChannelFormModal } from '../components/notifications/ChannelFormModal';

const TYPE_LABEL: Record<string, string> = {
  nginx_down: 'nginx',
  cert_expiry: 'Certificate',
  domain_health: 'Health check',
  test: 'Test message',
};

function iconFor(event: NotificationEvent): LucideIcon {
  if (event.type === 'nginx_down') return Server;
  if (event.type === 'cert_expiry') return ShieldAlert;
  if (event.type === 'domain_health') return Activity;
  return Sparkles;
}

function toneFor(severity: NotificationEvent['severity']): string {
  if (severity === 'danger') return 'text-bad';
  if (severity === 'warning') return 'text-warn';
  if (severity === 'success') return 'text-ok';
  if (severity === 'info') return 'text-info';
  return 'text-muted';
}

function failureText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const detail = typeof error.payload.detail === 'string' ? error.payload.detail : null;
    return detail ?? error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

function webhookSummary(url?: string): string {
  if (!url) return 'Webhook URL not set';
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    return `${parsed.host}/…${last.slice(-4)}`;
  } catch {
    return 'Webhook URL configured';
  }
}

function channelSubtitle(channel: NotificationChannel): string {
  if (channel.type === 'discord') return webhookSummary(channel.webhookUrl);
  return `Chat ${channel.chatId ?? '—'} · bot token saved`;
}

interface UsageEntry {
  domains: number;
  rules: number;
}

export function NotificationsPage() {
  useDocumentTitle('Notifications');
  const toast = useToast();
  const confirm = useConfirm();
  const { notifications, clearNotifications, connected, connectionError } = useRealtime();

  const channelsResource = useResource<NotificationChannel[]>((signal) =>
    api.settings.channels.list(signal)
  );
  const domainsResource = useResource<Domain[]>((signal) => api.domains.list(signal));

  const [modal, setModal] = useState<{ channel: NotificationChannel | null } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    // Relative timestamps ("2m ago") go stale while the page sits open.
    const id = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const reloadAll = () => {
    channelsResource.reload();
    domainsResource.reload();
  };
  useRefreshOnVisible(reloadAll);
  useLocalChange(['settings', 'domains'], reloadAll);

  // How many enabled domains (and individual event rules) deliver to each channel.
  const usage = useMemo(() => {
    const map = new Map<string, UsageEntry>();
    for (const domain of domainsResource.data ?? []) {
      if (!domain.enabled) continue;
      const perChannel = new Map<string, number>();
      for (const routing of Object.values(domain.notifications) as DomainEventRouting[]) {
        if (!routing.enabled) continue;
        for (const id of routing.channelIds) {
          perChannel.set(id, (perChannel.get(id) ?? 0) + 1);
        }
      }
      for (const [id, rules] of perChannel) {
        const entry = map.get(id) ?? { domains: 0, rules: 0 };
        entry.domains += 1;
        entry.rules += rules;
        map.set(id, entry);
      }
    }
    return map;
  }, [domainsResource.data]);

  const testChannel = async (channel: NotificationChannel) => {
    if (testing) return;
    setTesting(channel.id);
    try {
      await api.settings.channels.test(channel.id);
      toast.success(
        `Test sent to ${channel.name}`,
        'Check the channel to confirm the message arrived.'
      );
    } catch (error) {
      toast.error(
        `Test failed for ${channel.name}`,
        failureText(error, 'The test message could not be delivered.')
      );
    } finally {
      setTesting(null);
    }
  };

  const deleteChannel = async (channel: NotificationChannel) => {
    if (deleting) return;
    const ok = await confirm({
      title: `Delete ${channel.name}?`,
      body: 'Domains routed to this channel stop delivering alerts there. The domains themselves are not changed.',
      confirmLabel: 'Delete channel',
      tone: 'danger',
    });
    if (!ok) return;
    setDeleting(channel.id);
    try {
      await api.settings.channels.remove(channel.id);
      toast.success('Channel deleted', `${channel.name} will no longer receive alerts.`);
      channelsResource.reload();
    } catch (error) {
      toast.error(
        'Could not delete the channel',
        failureText(error, 'The channel is still configured.')
      );
    } finally {
      setDeleting(null);
    }
  };

  const channels = channelsResource.data;

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Delivery channels for alerts, and the events received in this session."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              loading={channelsResource.loading || domainsResource.loading}
              icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
              onClick={reloadAll}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="size-3.5" aria-hidden="true" />}
              onClick={() => setModal({ channel: null })}
            >
              New channel
            </Button>
          </>
        }
      />

      {channelsResource.error && !channels ? (
        <ErrorState error={channelsResource.error} onRetry={channelsResource.reload} />
      ) : !channels ? (
        <PageSkeleton>
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </PageSkeleton>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-5">
            <Card className="overflow-hidden">
              <CardHeader
                title="Channels"
                description="Named Discord and Telegram destinations. Domains choose which channels receive their events."
                actions={
                  channels.length > 0 ? (
                    <Badge tone="neutral">{pluralize(channels.length, 'channel')}</Badge>
                  ) : undefined
                }
              />

              {channelsResource.error && (
                <div className="border-b border-line px-4 py-2 text-2xs text-muted sm:px-5">
                  Showing the last known list. {channelsResource.error.message}{' '}
                  <button
                    type="button"
                    className="font-medium text-ink underline-offset-2 hover:underline"
                    onClick={channelsResource.reload}
                  >
                    Try again
                  </button>
                </div>
              )}

              {channels.length === 0 ? (
                <EmptyState
                  icon={<Webhook className="size-5" aria-hidden="true" />}
                  title="No channels yet"
                  description="Add a Discord webhook or a Telegram bot, then route domain events to it. Until then, alerts stay in the dashboard only."
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Plus className="size-3.5" aria-hidden="true" />}
                      onClick={() => setModal({ channel: null })}
                    >
                      New channel
                    </Button>
                  }
                />
              ) : (
                <ul className="divide-y divide-line/70">
                  {channels.map((channel) => {
                    const Icon = channel.type === 'discord' ? Webhook : Send;
                    const entry = usage.get(channel.id);
                    const isDeleting = deleting === channel.id;
                    return (
                      <li
                        key={channel.id}
                        className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                      >
                        <div className="flex min-w-0 items-start gap-3">
                          <div
                            className={cn(
                              'flex size-9 shrink-0 items-center justify-center rounded-md border border-line',
                              channel.type === 'discord'
                                ? 'bg-info-soft text-info'
                                : 'bg-accent-soft text-accent-text'
                            )}
                          >
                            <Icon className="size-4" aria-hidden="true" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-ink">
                                {channel.name}
                              </span>
                              <Badge tone="neutral">
                                {channel.type === 'discord' ? 'Discord' : 'Telegram'}
                              </Badge>
                              {domainsResource.data &&
                                (entry ? (
                                  <Badge
                                    tone="ok"
                                    dot
                                    className="cursor-default"
                                  >
                                    {entry.domains} {entry.domains === 1 ? 'domain' : 'domains'}
                                  </Badge>
                                ) : (
                                  <Badge tone="neutral">Not routed yet</Badge>
                                ))}
                            </div>
                            <p className="mt-0.5 truncate font-mono text-xs text-muted">
                              {channelSubtitle(channel)}
                            </p>
                            {channel.type === 'discord' && channel.message && (
                              <p className="mt-0.5 truncate text-2xs text-faint">
                                Prefix: {channel.message}
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5 pl-12 sm:pl-0">
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={testing === channel.id}
                            disabled={testing !== null && testing !== channel.id}
                            icon={<FlaskConical className="size-3.5" aria-hidden="true" />}
                            onClick={() => void testChannel(channel)}
                          >
                            Test
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isDeleting}
                            icon={<Pencil className="size-3.5" aria-hidden="true" />}
                            onClick={() => setModal({ channel })}
                          >
                            Edit
                          </Button>
                          <IconButton
                            label={`Delete ${channel.name}`}
                            size="sm"
                            disabled={isDeleting}
                            className="hover:text-bad"
                            onClick={() => void deleteChannel(channel)}
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          </IconButton>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {channels.length > 0 && (
                <div className="border-t border-line bg-raised/40 px-4 py-2.5 text-2xs text-faint sm:px-5">
                  {domainsResource.error
                    ? 'Domain routing could not be loaded, so usage counts are hidden.'
                    : 'Counts include enabled domains that route at least one event to a channel.'}
                </div>
              )}
            </Card>
          </div>

          <div className="space-y-5">
            <Card className="overflow-hidden">
              <CardHeader
                icon={<BellRing className="size-4" aria-hidden="true" />}
                title="Recent events"
                description="Received live while this page is open."
                actions={
                  <span className="inline-flex items-center gap-1.5 text-2xs text-faint">
                    <StatusDot tone={connected ? 'ok' : 'warn'} pulse={connected} />
                    {connected ? 'Live' : 'Reconnecting…'}
                  </span>
                }
              />

              {connectionError && (
                <div className="border-b border-line px-4 py-2.5 sm:px-5">
                  <InlineAlert tone="warning">{connectionError}</InlineAlert>
                </div>
              )}

              {notifications.length === 0 ? (
                <EmptyState
                  icon={<BellRing className="size-5" aria-hidden="true" />}
                  title="No events yet"
                  description="Alerts appear here as they happen. The bell in the header keeps the same list between pages."
                  className="py-9"
                />
              ) : (
                <>
                  <ul className="max-h-[420px] divide-y divide-line/70 overflow-y-auto">
                    {notifications.map((event) => {
                      const Icon = iconFor(event);
                      return (
                        <li key={event.id} className="flex items-start gap-2.5 px-4 py-2.5 sm:px-5">
                          <Icon
                            className={cn('mt-0.5 size-4 shrink-0', toneFor(event.severity))}
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs leading-snug text-ink">{event.message}</p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-2xs text-faint">
                              <span>{TYPE_LABEL[event.type] ?? 'Notification'}</span>
                              {event.domain && <span>· {event.domain}</span>}
                              <span>· {timeAgo(event.timestamp)}</span>
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="border-t border-line bg-raised/40 px-4 py-2 sm:px-5">
                    <button
                      type="button"
                      onClick={clearNotifications}
                      className="text-2xs font-medium text-muted transition-colors hover:text-ink"
                    >
                      Clear all events
                    </button>
                  </div>
                </>
              )}
            </Card>

            <Card>
              <CardHeader
                title="How routing works"
                description="Channels do nothing until a domain sends to them."
              />
              <CardBody className="space-y-3">
                <ol className="space-y-2.5">
                  {[
                    'Create a channel here and send it a test message.',
                    'Open a domain and pick channels for nginx downtime, certificate expiry and health events.',
                    'Toggle each event separately — turning one off keeps the others delivering.',
                  ].map((step, index) => (
                    <li key={step} className="flex gap-2.5 text-xs text-muted">
                      <span className="mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full bg-inset text-2xs font-semibold text-muted">
                        {index + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
                <Link
                  to="/domains"
                  className={buttonClasses('secondary', 'sm', 'w-full')}
                >
                  Open domains
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              </CardBody>
            </Card>
          </div>
        </div>
      )}

      {modal && (
        <ChannelFormModal
          key={modal.channel?.id ?? 'new'}
          channel={modal.channel}
          onClose={() => setModal(null)}
          onSaved={(saved, created) => {
            setModal(null);
            channelsResource.reload();
            toast.success(
              created ? 'Channel created' : 'Channel updated',
              created
                ? `${saved.name} is ready to receive alerts.`
                : `${saved.name} was saved.`
            );
          }}
        />
      )}
    </>
  );
}
