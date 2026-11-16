import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  GitBranch,
  Globe2,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Settings2,
  Trash2,
  Webhook,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { DeployApp, DeploymentsResponse } from '../lib/types';
import { formatBytes, formatUptime, pluralize, timeAgo, truncateMiddle } from '../lib/format';
import { RUN_STATUS, processTone, shortSha, stepLabel } from '../lib/deployments';
import {
  useDocumentTitle,
  usePolling,
  useRefreshOnVisible,
  useResource,
} from '../hooks/useResource';
import { PageHeader } from '../components/layout/PageHeader';
import { AppDetailModal } from '../components/deployments/AppDetailModal';
import { AppFormModal } from '../components/deployments/AppFormModal';
import { DeleteAppModal } from '../components/deployments/AppSetupTabs';
import { HookSettingsModal } from '../components/deployments/HookSettingsModal';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge, StatusDot } from '../components/ui/Badge';
import { Button, IconButton, buttonClasses } from '../components/ui/Button';
import {
  EmptyState,
  ErrorState,
  InlineAlert,
  PageSkeleton,
  Skeleton,
} from '../components/ui/States';
import { useToast } from '../components/ui/Toast';

type DetailTab = 'activity' | 'releases' | 'github' | 'setup' | 'ezjson';

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

function HookCard({
  data,
  onConfigure,
}: {
  data: DeploymentsResponse;
  onConfigure: () => void;
}) {
  const { hook } = data;
  const exposed = hook.enabled && (hook.domain !== null || hook.bind === '0.0.0.0');
  const domain = hook.domain ? data.domains.find((d) => d.name === hook.domain) : undefined;
  const secure = Boolean(domain?.ssl);

  let tone: 'ok' | 'warn' | 'neutral' = 'neutral';
  let label = 'Off';
  let detail = 'Apps are deployed from this dashboard only. Turn it on to deploy from GitHub Actions.';

  if (hook.enabled && !hook.listening) {
    tone = 'warn';
    label = 'Not listening';
    detail =
      'It is switched on, but nothing answers on its port yet. The background service starts it within a few seconds; if it stays like this, check that the service is running.';
  } else if (hook.enabled && !exposed) {
    tone = 'neutral';
    label = 'This machine only';
    detail = 'Listening, but only programs on this server can call it. GitHub cannot reach it.';
  } else if (hook.enabled && hook.domain) {
    tone = secure ? 'ok' : 'warn';
    label = secure ? 'On' : 'On — no SSL';
    detail = secure
      ? `Reached through https://${hook.domain}${hook.path}`
      : `Reached through http://${hook.domain}${hook.path} — the deploy token travels unencrypted. Issue a certificate for that domain.`;
  } else if (hook.enabled) {
    tone = 'warn';
    label = 'On — plain HTTP';
    detail = `Listening on every interface, port ${hook.port}. The deploy token travels unencrypted; prefer a domain with SSL.`;
  }

  return (
    <Card>
      <CardHeader
        icon={<Webhook className="size-4" aria-hidden="true" />}
        title={
          <span className="flex flex-wrap items-center gap-2">
            Deploy hook
            <Badge tone={tone} dot>
              {label}
            </Badge>
          </span>
        }
        description={detail}
        actions={
          <Button
            size="sm"
            icon={<Settings2 className="size-3.5" aria-hidden="true" />}
            onClick={onConfigure}
          >
            Configure
          </Button>
        }
      />
    </Card>
  );
}

function AppRow({
  app,
  canDeploy,
  busy,
  onDeploy,
  onOpen,
  onEdit,
  onDelete,
}: {
  app: DeployApp;
  canDeploy: boolean;
  busy: boolean;
  onDeploy: () => void;
  onOpen: (tab: DetailTab) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const run = app.lastRun ?? null;
  const proc = app.process ?? null;
  const status = run ? RUN_STATUS[run.status] : null;

  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 transition-colors duration-[var(--ez-motion-fast)] hover:bg-raised/40 lg:flex-row lg:items-center lg:gap-4">
      <button
        type="button"
        onClick={() => onOpen('activity')}
        className="flex min-w-0 flex-1 items-start gap-3 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <StatusDot
          tone={proc ? processTone(proc.status) : 'neutral'}
          pulse={proc?.status === 'online'}
          className="mt-1.5"
        />
        <span className="min-w-0">
          <span className="block truncate font-mono text-sm font-semibold text-ink">{app.id}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted">
            <span className="truncate font-mono" title={app.repoUrl}>
              {truncateMiddle(app.repoUrl, 44)}
            </span>
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3" aria-hidden="true" />
              {app.branch}
            </span>
            {app.domain && (
              <span className="inline-flex items-center gap-1 text-accent-text">
                <Globe2 className="size-3" aria-hidden="true" />
                {app.domain}
              </span>
            )}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-faint">
            {proc ? (
              <>
                <span>
                  {proc.status}
                  {proc.status === 'online' && proc.uptimeMs !== null
                    ? ` · up ${formatUptime(proc.uptimeMs)}`
                    : ''}
                </span>
                {proc.memoryBytes !== null && <span>· {formatBytes(proc.memoryBytes)}</span>}
                {proc.restarts > 0 && <span>· {pluralize(proc.restarts, 'restart')}</span>}
              </>
            ) : (
              <span>{app.currentRelease ? 'Not running' : 'Never deployed'}</span>
            )}
          </span>
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-2 pl-7 lg:w-56 lg:shrink-0 lg:pl-0">
        {app.deploying ? (
          <Badge tone="info" dot>
            {run?.status === 'running' ? stepLabel(run.step) : 'Deploying'}
          </Badge>
        ) : status && run ? (
          <>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
            <span className="font-mono text-2xs text-faint">{shortSha(run.sha)}</span>
            <span className="text-2xs text-faint">{timeAgo(run.finishedAt ?? run.startedAt)}</span>
          </>
        ) : (
          <span className="text-2xs text-faint">No deployments yet</span>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1.5 pl-7 lg:pl-0">
        <Button
          variant="primary"
          size="sm"
          icon={<Rocket className="size-3.5" aria-hidden="true" />}
          onClick={onDeploy}
          loading={busy}
          disabled={!canDeploy || Boolean(app.deploying)}
        >
          Deploy
        </Button>
        <Button size="sm" onClick={() => onOpen('setup')}>
          Domain
        </Button>
        <Button size="sm" onClick={() => onOpen('github')}>
          GitHub
        </Button>
        <IconButton label={`Edit ${app.id}`} size="sm" onClick={onEdit}>
          <Pencil className="size-4" aria-hidden="true" />
        </IconButton>
        <IconButton
          label={`Delete ${app.id}`}
          size="sm"
          variant="dangerGhost"
          onClick={onDelete}
          disabled={Boolean(app.deploying)}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </IconButton>
      </div>
    </li>
  );
}

export function DeploymentsPage() {
  useDocumentTitle('Deployments');
  const toast = useToast();

  const resource = useResource<DeploymentsResponse>((signal) => api.deployments.list(signal), []);
  const data = resource.data;
  const anyDeploying = Boolean(data?.apps.some((app) => app.deploying));

  useRefreshOnVisible(resource.reload);
  // Fast while something is building, slow otherwise — process status and a
  // deployment started by CI both show up without a manual refresh.
  usePolling(resource.reload, anyDeploying ? 2000 : 15000);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DeployApp | null>(null);
  const [hookOpen, setHookOpen] = useState(false);
  const [detail, setDetail] = useState<{ id: string; tab: DetailTab } | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DeployApp | null>(null);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const deploy = async (app: DeployApp) => {
    if (starting) return;
    setStarting(app.id);
    try {
      await api.deployments.deploy(app.id);
      setDetail({ id: app.id, tab: 'activity' });
      resource.reload();
    } catch (error) {
      toast.error(`Could not deploy ${app.id}`, errorText(error, 'Nothing was started.'));
    } finally {
      setStarting(null);
    }
  };

  const header = (
    <PageHeader
      title="Deployments"
      description="Put a project from a git repository on this server: fetched, built and started here, with earlier releases kept to roll back to."
      actions={
        <>
          <IconButton label="Refresh" onClick={resource.reload}>
            <RefreshCw className="size-4" aria-hidden="true" />
          </IconButton>
          <Button
            variant="primary"
            icon={<Plus className="size-4" aria-hidden="true" />}
            onClick={openCreate}
            disabled={!data}
          >
            New app
          </Button>
        </>
      }
    />
  );

  if (resource.error && !data) {
    return (
      <>
        {header}
        <ErrorState error={resource.error} onRetry={resource.reload} />
      </>
    );
  }

  if (!data) {
    return (
      <>
        {header}
        <PageSkeleton>
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-56 rounded-lg" />
        </PageSkeleton>
      </>
    );
  }

  const canDeploy = data.requirements.git && data.requirements.pm2;

  return (
    <>
      {header}

      <div className="space-y-5">
        {!data.requirements.git && (
          <InlineAlert tone="danger" title="git is not installed on this server">
            Deployments fetch the code with git. Install it, and make sure it is on the PATH of the
            Easy DevOps service.
          </InlineAlert>
        )}
        {!data.requirements.pm2 && (
          <InlineAlert
            tone="warning"
            title="PM2 is not installed"
            action={
              <Link to="/processes" className={buttonClasses('secondary', 'sm')}>
                Open Processes
              </Link>
            }
          >
            Deployed apps are kept running by PM2. Install it from the Processes page, or with{' '}
            <code className="font-mono">npm install -g pm2</code>.
          </InlineAlert>
        )}

        <HookCard data={data} onConfigure={() => setHookOpen(true)} />

        <Card className="overflow-hidden">
          <CardHeader
            icon={<Rocket className="size-4" aria-hidden="true" />}
            title="Apps"
            description={
              data.apps.length === 0
                ? 'Nothing is deployed from here yet.'
                : `${pluralize(data.apps.length, 'app')}. Each runs under PM2 as ez-<name>.`
            }
          />
          {data.apps.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<Rocket className="size-5" aria-hidden="true" />}
                title="Deploy your first app"
                description={
                  <>
                    Give it a repository. A Node project needs nothing else; for any other
                    language, add an <code className="font-mono">ez.json</code> with its install,
                    build and start commands.
                  </>
                }
                action={
                  <Button
                    variant="primary"
                    icon={<Plus className="size-4" aria-hidden="true" />}
                    onClick={openCreate}
                  >
                    New app
                  </Button>
                }
              />
            </CardBody>
          ) : (
            <ul className="divide-y divide-line">
              {data.apps.map((app) => (
                <AppRow
                  key={app.id}
                  app={app}
                  canDeploy={canDeploy}
                  busy={starting === app.id}
                  onDeploy={() => void deploy(app)}
                  onOpen={(tab) => setDetail({ id: app.id, tab })}
                  onEdit={() => {
                    setEditing(app);
                    setFormOpen(true);
                  }}
                  onDelete={() => setDeleting(app)}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <AppFormModal
        open={formOpen}
        app={editing}
        meta={data}
        onClose={() => setFormOpen(false)}
        onSaved={(saved, created) => {
          setFormOpen(false);
          resource.reload();
          if (created) {
            toast.success(`${saved.id} created`, 'Press Deploy to build and start it.');
            // A deploy-key app is not usable until its key exists; take the
            // user straight back to where it is generated.
            if (saved.authType === 'deployKey') {
              setEditing(saved);
              setFormOpen(true);
            }
          } else {
            toast.success(`${saved.id} saved`, 'It applies to the next deployment.');
          }
        }}
      />

      <HookSettingsModal
        open={hookOpen}
        hook={data.hook}
        domains={data.domains}
        onClose={() => setHookOpen(false)}
        onSaved={() => {
          setHookOpen(false);
          resource.reload();
        }}
      />

      <AppDetailModal
        appId={detail?.id ?? null}
        initialTab={detail?.tab}
        hook={data.hook}
        meta={data}
        onClose={() => setDetail(null)}
        onConfigureHook={() => setHookOpen(true)}
        onChanged={resource.reload}
        onDelete={(app) => setDeleting(app)}
      />

      <DeleteAppModal
        app={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          setDetail(null);
          resource.reload();
        }}
      />
    </>
  );
}
