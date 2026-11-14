import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Globe2,
  Loader2,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import type { Domain, DomainHealthEntry } from '../lib/types';
import { formatDaysLeft } from '../lib/format';
import {
  useConfirm,
  useDocumentTitle,
  useRefreshOnVisible,
  useResource,
} from '../hooks/useResource';
import { useLocalChange } from '../hooks/useLocalChange';
import { useRealtime } from '../app/RealtimeProvider';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge, StatusDot } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Checkbox } from '../components/ui/Field';
import { Modal } from '../components/ui/Modal';
import {
  EmptyState,
  ErrorState,
  PageSkeleton,
  Skeleton,
} from '../components/ui/States';
import { useToast } from '../components/ui/Toast';
import { DomainFormModal, type DomainEditor } from '../components/domains/DomainFormModal';

type Filter = 'all' | 'enabled' | 'disabled';

function targetLabel(domain: Domain): string {
  if (/^https?:\/\//i.test(domain.backendHost || '')) return domain.backendHost;
  return `${domain.upstreamType || 'http'}://${domain.backendHost || '127.0.0.1'}:${domain.port}`;
}

function SslBadge({ domain }: { domain: Domain }) {
  if (!domain.ssl?.enabled) return <Badge tone="neutral">HTTP only</Badge>;
  const days = domain.daysLeft;
  if (days === null || days === undefined) return <Badge tone="neutral">SSL</Badge>;
  if (days < 0) return <Badge tone="bad">SSL expired</Badge>;
  if (days < 30) return <Badge tone="warn">{formatDaysLeft(days)}</Badge>;
  return <Badge tone="ok">{formatDaysLeft(days)}</Badge>;
}

function HealthBadge({ entry }: { entry: DomainHealthEntry | undefined }) {
  if (!entry) return null;
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

export function DomainsPage() {
  useDocumentTitle('Domains');
  const toast = useToast();
  const confirm = useConfirm();
  const { domainHealth } = useRealtime();
  const resource = useResource<Domain[]>((signal) => api.domains.list(signal));
  const [params, setParams] = useSearchParams();

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [pending, setPending] = useState<{
    name: string;
    action: 'toggle' | 'reload';
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Domain | null>(null);
  const [deleteCert, setDeleteCert] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useRefreshOnVisible(resource.reload);
  useLocalChange('domains', resource.reload);

  const data = resource.data;
  const health = useMemo(
    () => new Map((domainHealth ?? []).map((entry) => [entry.name, entry])),
    [domainHealth]
  );

  const requestedNew = params.get('new') === '1';
  const requestedName = params.get('domain');
  const requestedDomain = requestedName
    ? (data ?? []).find((domain) => domain.name === requestedName)
    : undefined;

  const editor: DomainEditor | null = requestedNew
    ? { mode: 'create' }
    : requestedDomain
      ? { mode: 'edit', domain: requestedDomain }
      : null;

  const missingReported = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !requestedName) {
      missingReported.current = null;
      return;
    }
    if (requestedDomain) {
      missingReported.current = null;
      return;
    }
    if (missingReported.current === requestedName) return;
    missingReported.current = requestedName;
    toast.error('Domain not found', requestedName);
    setParams({}, { replace: true });
  }, [data, requestedName, requestedDomain, setParams, toast]);

  const openCreate = () => setParams({ new: '1' });
  const openEdit = (name: string) => setParams({ domain: name });
  const closeEditor = () => setParams({}, { replace: true });

  const counts = useMemo(() => {
    const list = data ?? [];
    return {
      all: list.length,
      enabled: list.filter((domain) => domain.enabled).length,
      disabled: list.filter((domain) => !domain.enabled).length,
    };
  }, [data]);

  const visible = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (data ?? []).filter((domain) => {
      if (filter === 'enabled' && !domain.enabled) return false;
      if (filter === 'disabled' && domain.enabled) return false;
      if (!search) return true;
      return [domain.name, domain.backendHost, String(domain.port)]
        .join(' ')
        .toLowerCase()
        .includes(search);
    });
  }, [data, filter, query]);

  const toggleDomain = async (domain: Domain) => {
    const enabling = !domain.enabled;
    const ok = await confirm({
      title: `${enabling ? 'Enable' : 'Disable'} "${domain.name}"?`,
      body: enabling
        ? 'nginx resumes serving this domain with its saved configuration.'
        : 'nginx stops serving this domain until you enable it again. The config file is kept.',
      confirmLabel: enabling ? 'Enable' : 'Disable',
      tone: enabling ? 'accent' : 'danger',
    });
    if (!ok) return;

    setPending({ name: domain.name, action: 'toggle' });
    try {
      const result = await api.domains.toggle(domain.name);
      resource.setData((current) =>
        current
          ? current.map((entry) =>
              entry.name === domain.name ? { ...entry, enabled: result.enabled } : entry
            )
          : current
      );
      toast.success(
        result.enabled ? 'Domain enabled' : 'Domain disabled',
        result.enabled
          ? `${domain.name} is being served again.`
          : `${domain.name} is no longer served by nginx.`
      );
    } catch (error) {
      toast.error(
        `Could not ${enabling ? 'enable' : 'disable'} the domain`,
        error instanceof ApiError ? error.message : undefined
      );
    } finally {
      setPending(null);
    }
  };

  const reloadDomain = async (domain: Domain) => {
    setPending({ name: domain.name, action: 'reload' });
    try {
      const result = await api.domains.reload(domain.name);
      toast.success(
        'nginx reloaded',
        result.message || `${domain.name} is live with its current configuration.`
      );
    } catch (error) {
      toast.error(
        'Could not reload nginx',
        error instanceof ApiError ? error.message : undefined
      );
    } finally {
      setPending(null);
    }
  };

  const requestDelete = (domain: Domain) => {
    setDeleteCert(false);
    setDeleteTarget(domain);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await api.domains.remove(
        deleteTarget.name,
        deleteTarget.ssl.enabled && deleteCert
      );
      toast.success(
        'Domain deleted',
        result.certDeleted
          ? `${deleteTarget.name}, its nginx config and its certificate files were removed.`
          : `${deleteTarget.name} and its nginx config were removed. The certificate files were kept.`
      );
      setDeleteTarget(null);
      resource.reload();
    } catch (error) {
      toast.error(
        'Could not delete the domain',
        error instanceof ApiError ? error.message : undefined
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Domains"
        description="Reverse-proxy hosts, their backends and their nginx configuration."
        meta={
          data ? (
            <span className="text-2xs text-faint">
              {counts.all} total · {counts.enabled} enabled
            </span>
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              loading={resource.loading}
              icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
              onClick={resource.reload}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="size-3.5" aria-hidden="true" />}
              onClick={openCreate}
            >
              Add domain
            </Button>
          </>
        }
      />

      {resource.error && !data ? (
        <ErrorState error={resource.error} onRetry={resource.reload} />
      ) : !data ? (
        <PageSkeleton>
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-[320px] rounded-lg" />
        </PageSkeleton>
      ) : data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Globe2 className="size-5" aria-hidden="true" />}
            title="No domains yet"
            description="Add a domain and Easy DevOps writes its nginx config, tests it, and reloads nginx."
            action={
              <Button
                variant="primary"
                size="sm"
                icon={<Plus className="size-3.5" aria-hidden="true" />}
                onClick={openCreate}
              >
                Add your first domain
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {resource.error && (
            <div className="rounded-md border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-xs text-muted">
              Showing the last known list. {resource.error.message}{' '}
              <button
                type="button"
                className="font-medium text-ink underline-offset-2 hover:underline"
                onClick={resource.reload}
              >
                Try again
              </button>
            </div>
          )}

          <Card className="overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-line p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-xs">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  aria-label="Search domains"
                  placeholder="Search domain or backend…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-9 w-full rounded-md border border-line bg-canvas pl-8 pr-3 text-sm text-ink placeholder:text-faint transition-colors duration-[var(--ez-motion-fast)] hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
                />
              </div>
              <div role="group" aria-label="Filter domains" className="flex flex-wrap gap-1.5">
                {(
                  [
                    ['all', 'All', counts.all],
                    ['enabled', 'Enabled', counts.enabled],
                    ['disabled', 'Disabled', counts.disabled],
                  ] as const
                ).map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={filter === id}
                    onClick={() => setFilter(id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs transition-colors duration-[var(--ez-motion-fast)]',
                      filter === id
                        ? 'border-accent/50 bg-accent-soft text-accent-text'
                        : 'border-line text-muted hover:border-line-strong hover:text-ink'
                    )}
                  >
                    {label}
                    <span
                      className={cn(
                        'rounded-pill px-1 text-2xs',
                        filter === id ? 'bg-accent/15' : 'bg-inset text-faint'
                      )}
                    >
                      {count}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {visible.length === 0 ? (
              <EmptyState
                title="No domains match"
                description="Try a different search or show all domains."
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setQuery('');
                      setFilter('all');
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y divide-line">
                {visible.map((domain) => {
                  const entry = health.get(domain.name);
                  const down = entry?.up === false;
                  const busyHere = pending?.name === domain.name;
                  const action = busyHere ? pending?.action : null;
                  return (
                    <li
                      key={domain.name}
                      className={cn(
                        'group flex flex-col gap-2.5 px-4 py-3 transition-colors duration-[var(--ez-motion-fast)] hover:bg-raised/40 sm:flex-row sm:items-center sm:gap-4',
                        !domain.enabled && 'opacity-60'
                      )}
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <StatusDot
                          tone={!domain.enabled ? 'neutral' : down ? 'bad' : 'ok'}
                          pulse={domain.enabled && !down}
                          className="mt-1.5"
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openEdit(domain.name)}
                              className="max-w-full truncate text-left font-mono text-sm font-semibold text-ink transition-colors hover:text-accent-text"
                            >
                              {domain.name}
                            </button>
                            {domain.wildcard && <Badge tone="accent">wildcard</Badge>}
                            {domain.www && <Badge tone="neutral">www</Badge>}
                            {!domain.enabled && <Badge tone="neutral">disabled</Badge>}
                            {domain.sslPathWarning && (
                              <span
                                className="inline-flex"
                                title="Certificate paths contain backslashes, which nginx on Windows can fail to load. Open and save this domain to regenerate them with forward slashes."
                              >
                                <Badge tone="warn">
                                  <ShieldAlert className="size-3" aria-hidden="true" />
                                  Backslash cert paths
                                </Badge>
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
                            <span className="max-w-full truncate font-mono">
                              {targetLabel(domain)}
                            </span>
                            {domain.ssl.enabled && domain.ssl.redirect && (
                              <>
                                <span className="text-faint" aria-hidden="true">
                                  ·
                                </span>
                                <span>HTTP redirects to HTTPS</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 pl-7 sm:w-52 sm:shrink-0 sm:pl-0">
                        <SslBadge domain={domain} />
                        <HealthBadge entry={entry} />
                      </div>

                      <div className="flex shrink-0 items-center justify-end gap-1 pl-7 sm:pl-0">
                        <IconButton
                          label={domain.enabled ? `Disable ${domain.name}` : `Enable ${domain.name}`}
                          size="sm"
                          disabled={busyHere}
                          onClick={() => toggleDomain(domain)}
                          className="text-muted hover:text-ink"
                        >
                          {action === 'toggle' ? (
                            <Loader2 className="spin size-3.5" aria-hidden="true" />
                          ) : domain.enabled ? (
                            <PowerOff className="size-3.5" aria-hidden="true" />
                          ) : (
                            <Power className="size-3.5" aria-hidden="true" />
                          )}
                        </IconButton>
                        <IconButton
                          label={`Reload nginx for ${domain.name}`}
                          size="sm"
                          disabled={busyHere}
                          onClick={() => reloadDomain(domain)}
                          className="text-muted hover:text-ink"
                        >
                          {action === 'reload' ? (
                            <Loader2 className="spin size-3.5" aria-hidden="true" />
                          ) : (
                            <RefreshCw className="size-3.5" aria-hidden="true" />
                          )}
                        </IconButton>
                        <IconButton
                          label={`Edit ${domain.name}`}
                          size="sm"
                          onClick={() => openEdit(domain.name)}
                          className="text-muted hover:text-accent-text"
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={`Delete ${domain.name}`}
                          size="sm"
                          onClick={() => requestDelete(domain)}
                          className="text-muted hover:text-bad"
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </IconButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      )}

      {editor && (
        <DomainFormModal
          key={editor.mode === 'edit' ? `edit:${editor.domain.name}` : 'create'}
          editor={editor}
          onClose={closeEditor}
          onSaved={() => {
            closeEditor();
            resource.reload();
          }}
        />
      )}

      <Modal
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        title={deleteTarget ? `Delete "${deleteTarget.name}"?` : 'Delete domain'}
        description="This also removes the domain's nginx config. It cannot be undone."
        size="sm"
        preventClose={deleting}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="danger" loading={deleting} onClick={confirmDelete}>
              Delete domain
            </Button>
          </>
        }
      >
        {deleteTarget && (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              nginx stops serving <span className="font-mono text-ink">{deleteTarget.name}</span>{' '}
              as soon as the config is removed.
            </p>
            {deleteTarget.ssl.enabled && (
              <div className="rounded-md border border-line bg-raised/40 p-3">
                <Checkbox
                  checked={deleteCert}
                  onChange={setDeleteCert}
                  label="Also delete the SSL certificate files"
                  hint={`Otherwise ${deleteTarget.name}'s certificate stays on disk and can be reused.`}
                />
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
