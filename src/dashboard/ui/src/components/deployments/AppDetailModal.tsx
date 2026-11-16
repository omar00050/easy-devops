import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, History, KeyRound, RotateCcw, ShieldAlert, Wand2, XCircle } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type {
  DeployAppDetail,
  DeploymentsResponse,
  DeployGithubApplyResult,
  DeployGithubSetup,
  DeployGithubTarget,
  DeployHook,
  DeployRelease,
  DeployRun,
  DeployRunDetail,
} from '../../lib/types';
import { cn } from '../../lib/cn';
import { formatDateTime, timeAgo } from '../../lib/format';
import {
  RUN_STATUS,
  TRIGGER_LABELS,
  runDuration,
  shortSha,
  stepLabel,
} from '../../lib/deployments';
import { useConfirm, usePolling, useResource } from '../../hooks/useResource';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Select, TextInput } from '../ui/Field';
import { CopyButton } from '../ui/CopyButton';
import { Modal } from '../ui/Modal';
import { EmptyState, ErrorState, InlineAlert, Skeleton, Spinner } from '../ui/States';
import { Tabs, TabPanel } from '../ui/Tabs';
import { useToast } from '../ui/Toast';
import { DomainFolderTab, EzJsonTab } from './AppSetupTabs';

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

// ─── Activity: runs and their logs ────────────────────────────────────────────

function RunLog({ appId, run }: { appId: string; run: DeployRun }) {
  const detail = useResource<DeployRunDetail>(
    (signal) => api.deployments.run(appId, run.id, signal),
    [appId, run.id]
  );
  const running = (detail.data?.status ?? run.status) === 'running';
  // A build prints continuously; poll while it runs, stop when it is over.
  usePolling(detail.reload, 1500, running);

  const preRef = useRef<HTMLPreElement>(null);
  const pinnedRef = useRef(true);
  const log = detail.data?.log ?? '';

  // Follow the output while the reader is at the bottom; leave them alone once
  // they scroll up to read something.
  useEffect(() => {
    const el = preRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  const current = detail.data ?? run;

  return (
    <div className="space-y-2.5">
      {current.error && (
        <InlineAlert
          tone={current.status === 'rolled_back' ? 'warning' : 'danger'}
          title={
            current.status === 'rolled_back'
              ? 'The new release was not healthy — the previous one is running again'
              : `Failed while: ${stepLabel(current.step).toLowerCase()}`
          }
        >
          {current.error}
        </InlineAlert>
      )}
      {current.warnings?.map((warning) => (
        <InlineAlert key={warning} tone="warning">
          {warning}
        </InlineAlert>
      ))}
      {detail.error && !detail.data ? (
        <ErrorState error={detail.error} onRetry={detail.reload} title="Could not load the log" />
      ) : (
        <pre
          ref={preRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="h-[42vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-canvas p-3.5 font-mono text-2xs leading-relaxed text-muted"
          aria-label="Deployment log"
          aria-busy={running}
        >
          {detail.data?.logTruncated && '… earlier output is not shown …\n'}
          {log || (detail.loading ? 'Loading…' : 'No output yet.')}
        </pre>
      )}
    </div>
  );
}

function ActivityTab({ app, initialRunId }: { app: DeployAppDetail; initialRunId: string | null }) {
  const [selected, setSelected] = useState<string | null>(initialRunId);

  // A deployment started while this is open should be the one on screen.
  useEffect(() => {
    if (app.activeRunId) setSelected(app.activeRunId);
  }, [app.activeRunId]);

  if (app.runs.length === 0) {
    return (
      <EmptyState
        icon={<History className="size-5" aria-hidden="true" />}
        title="No deployments yet"
        description="Press Deploy to build and start this app for the first time."
      />
    );
  }

  const run = app.runs.find((r) => r.id === selected) ?? app.runs[0];

  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <ul className="max-h-[52vh] space-y-1 overflow-y-auto pr-1" aria-label="Deployments">
        {app.runs.map((r) => {
          const status = RUN_STATUS[r.status];
          const active = r.id === run.id;
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setSelected(r.id)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'w-full rounded-md border px-3 py-2 text-left transition-colors duration-[var(--ez-motion-fast)]',
                  active
                    ? 'border-accent/40 bg-accent-soft'
                    : 'border-transparent hover:bg-inset'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={status.tone} dot>
                    {r.status === 'running' ? stepLabel(r.step) : status.label}
                  </Badge>
                  <span className="font-mono text-2xs text-faint">{shortSha(r.sha)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-2xs text-muted">
                  <span>{TRIGGER_LABELS[r.trigger] ?? r.trigger}</span>
                  <span title={formatDateTime(r.startedAt)}>
                    {timeAgo(r.startedAt)} · {runDuration(r)}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      <RunLog key={run.id} appId={app.id} run={run} />
    </div>
  );
}

// ─── Releases ─────────────────────────────────────────────────────────────────

function ReleasesTab({
  app,
  onRollback,
  busy,
}: {
  app: DeployAppDetail;
  onRollback: (release: DeployRelease) => void;
  busy: boolean;
}) {
  if (app.releases.length === 0) {
    return (
      <EmptyState
        title="No releases on disk"
        description="Each successful deployment leaves a release here to roll back to."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        A rollback starts an earlier release exactly as it was built — nothing is fetched or
        rebuilt. The newest {app.keepReleases} are kept.
      </p>
      <ul className="divide-y divide-line rounded-md border border-line">
        {app.releases.map((release) => (
          <li key={release.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-ink">{release.id}</span>
                {release.current && <Badge tone="ok">Live</Badge>}
                {release.previous && <Badge tone="neutral">Previous</Badge>}
              </div>
              <div className="mt-0.5 font-mono text-2xs text-faint">
                {shortSha(release.sha)}
                {release.ref ? ` · ${release.ref}` : ''}
              </div>
            </div>
            {!release.current && (
              <Button
                size="sm"
                icon={<RotateCcw className="size-3.5" aria-hidden="true" />}
                onClick={() => onRollback(release)}
                disabled={busy || !release.startable}
                title={release.startable ? undefined : 'This release never got as far as starting.'}
              >
                Roll back to this
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── GitHub Actions ───────────────────────────────────────────────────────────

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-pill bg-inset font-mono text-2xs font-semibold text-muted"
        aria-hidden="true"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h4 className="text-sm font-medium text-ink">{title}</h4>
        {children}
      </div>
    </li>
  );
}

function SecretRow({ name, value, note }: { name: string; value: string | null; note?: string }) {
  return (
    <div className="rounded-md border border-line bg-inset/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <code className="font-mono text-xs font-semibold text-ink">{name}</code>
        <CopyButton value={name} label={`Copy the name ${name}`} />
      </div>
      {value ? (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <code className="min-w-0 break-all font-mono text-2xs text-muted">{value}</code>
          <CopyButton value={value} label={`Copy the value of ${name}`} withText />
        </div>
      ) : (
        note && <p className="mt-1.5 text-2xs text-faint">{note}</p>
      )}
    </div>
  );
}

function GithubTab({
  app,
  hook,
  onConfigureHook,
  onChanged,
}: {
  app: DeployAppDetail;
  hook: DeployHook;
  onConfigureHook: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const setup = useResource<DeployGithubSetup>(
    (signal) => api.deployments.github(app.id, signal),
    [app.id, hook.enabled, hook.domain, hook.bind, hook.port, app.branch]
  );
  // Held in memory only, and only until this panel closes: the server keeps a
  // hash, so this is the one moment the token can be copied.
  const [token, setToken] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [targetId, setTargetId] = useState<'hook' | 'hub' | null>(null);
  const [githubToken, setGithubToken] = useState('');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<DeployGithubApplyResult | null>(null);

  const issue = async () => {
    if (issuing) return;
    if (app.hook.hasToken) {
      const ok = await confirm({
        title: 'Replace the deploy token?',
        body: 'The current token stops working immediately. The repository’s EZ_DEPLOY_TOKEN secret has to be updated before the next push can deploy.',
        confirmLabel: 'Replace token',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setIssuing(true);
    try {
      const result = await api.deployments.issueHookToken(app.id);
      setToken(result.token);
      onChanged();
    } catch (error) {
      toast.error('Could not create the token', errorText(error, 'Try again.'));
    } finally {
      setIssuing(false);
    }
  };

  if (setup.error && !setup.data) {
    return <ErrorState error={setup.error} onRetry={setup.reload} />;
  }
  if (!setup.data) return <Skeleton className="h-64 rounded-lg" />;

  const data = setup.data;
  const hasToken = app.hook.hasToken || token !== null;

  // A backend older than 2.5.0 has only the direct hook.
  const targets: DeployGithubTarget[] = data.targets ?? [
    { id: 'hook', label: 'This server’s deploy hook', url: data.hookUrl, secure: data.hookSecure, note: data.hookNote },
  ];
  // Default to whichever can actually be reached: the direct hook when it has
  // a URL, otherwise the Hub when the server allows it.
  const usable = (t: DeployGithubTarget) => Boolean(t.url) && (t.id !== 'hub' || t.ready !== false);
  const target =
    targets.find((t) => t.id === targetId) ?? targets.find(usable) ?? targets[0];
  const targetUsable = usable(target);
  const isGithub = /github\.com[:/]/.test(app.repoUrl);
  const keyStep = app.authType === 'deployKey' ? 1 : 0;

  const apply = async () => {
    if (applying) return;
    if (app.hook.hasToken) {
      const ok = await confirm({
        title: 'Set up GitHub automatically?',
        body: 'A new deploy token is created and stored straight into the repository’s secrets; the current one stops working. The workflow file is committed to the branch, which starts a deployment.',
        confirmLabel: 'Set up',
        tone: 'accent',
      });
      if (!ok) return;
    }
    setApplying(true);
    setApplied(null);
    try {
      const result = await api.deployments.applyGithub(app.id, {
        target: target.id,
        ...(githubToken.trim() ? { token: githubToken.trim() } : {}),
      });
      setApplied(result);
      setGithubToken('');
      setToken(null);
      onChanged();
      if (result.ok) toast.success('GitHub is set up', `${result.repo} deploys on every push to ${app.branch}.`);
      else toast.warning('Partly set up', 'Some steps need a token with more access. They are listed below.');
    } catch (error) {
      // A 502 still carries the structured result; show it rather than a toast alone.
      const payload = error instanceof ApiError ? (error.payload as unknown as DeployGithubApplyResult) : null;
      if (payload && Array.isArray(payload.steps)) setApplied(payload);
      toast.error('Could not set up GitHub', errorText(error, 'Nothing was changed on GitHub.'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-line bg-inset/40 p-3.5">
        <h4 className="text-sm font-medium text-ink">How it works</h4>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-muted">
          <li>
            You push to <code className="font-mono text-ink">{app.branch}</code>.
          </li>
          <li>
            GitHub runs the workflow file in your repository. It makes one request: “deploy this
            commit”, with the app’s deploy token.
          </li>
          <li>
            This server fetches that commit, builds it and starts it — the same steps as the
            Deploy button, with the log in the Deployments tab.
          </li>
          <li>
            The workflow waits for the result. A green check means the new version is live; a red
            one means it failed, and the previous version is still running.
          </li>
        </ol>
        <p className="mt-2 text-xs text-muted">
          GitHub never gets access to the server: it holds a URL and a token that can start a
          deployment of this one app, and nothing else.
        </p>
      </div>

      {targets.length > 1 && (
        <Select
          label="How GitHub reaches this server"
          value={target.id}
          onChange={(event) => setTargetId(event.target.value as 'hook' | 'hub')}
          hint={target.note}
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
              {usable(t) ? '' : ' — not available yet'}
            </option>
          ))}
        </Select>
      )}

      {!targetUsable ? (
        <InlineAlert
          tone="warning"
          title={target.id === 'hub' ? 'Not available through the Hub yet' : 'GitHub cannot reach this server yet'}
          action={
            target.id === 'hook' ? (
              <Button size="sm" onClick={onConfigureHook}>
                Set up the deploy hook
              </Button>
            ) : undefined
          }
        >
          {target.note}
        </InlineAlert>
      ) : (
        !target.secure && (
          <InlineAlert
            tone="warning"
            title="The deploy token would be sent unencrypted"
            action={
              target.id === 'hook' ? (
                <Button size="sm" onClick={onConfigureHook}>
                  Change
                </Button>
              ) : undefined
            }
          >
            {target.note}
          </InlineAlert>
        )
      )}

      {isGithub && (
        <div className="rounded-md border border-line bg-inset/40 p-3.5">
          <div className="flex items-start gap-2.5">
            <Wand2 className="mt-0.5 size-4 shrink-0 text-accent-text" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-2.5">
              <div>
                <h4 className="text-sm font-medium text-ink">Do it for me</h4>
                <p className="mt-0.5 text-xs text-muted">
                  Stores both secrets, commits the workflow file
                  {app.authType === 'deployKey' ? ' and adds the deploy key' : ''}. Needs a GitHub
                  token that may write this repository’s <em>secrets</em>, <em>contents</em> and{' '}
                  <em>workflows</em>
                  {app.authType === 'deployKey' ? ', and administer it (for the deploy key)' : ''}. A
                  token typed here is used once and not stored.
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <TextInput
                  label="GitHub token"
                  optional={app.authType === 'token' && app.hasToken}
                  type="password"
                  value={githubToken}
                  onChange={(event) => setGithubToken(event.target.value)}
                  placeholder={
                    app.authType === 'token' && app.hasToken ? 'leave empty to try the app’s token' : 'github_pat_…'
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-56 flex-1"
                />
                <Button
                  variant="primary"
                  onClick={() => void apply()}
                  loading={applying}
                  disabled={
                    !targetUsable ||
                    (!githubToken.trim() && !(app.authType === 'token' && app.hasToken))
                  }
                >
                  Set up on GitHub
                </Button>
              </div>
              {applied && (
                <ul className="space-y-1.5" aria-label="Setup result">
                  {applied.error && (
                    <li className="flex items-start gap-2 text-xs text-bad">
                      <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      <span>{applied.error}</span>
                    </li>
                  )}
                  {applied.steps.map((step) => (
                    <li
                      key={step.id}
                      className={cn('flex items-start gap-2 text-xs', step.ok ? 'text-muted' : 'text-bad')}
                    >
                      {step.ok ? (
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden="true" />
                      ) : (
                        <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      )}
                      <span>{step.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-faint">
        {isGithub ? 'Or by hand' : 'Steps'}
      </h4>

      <ol className="space-y-5">
        {data.deployKey !== null && (
          <Step n={1} title="Let this server read the repository">
            <p className="text-xs text-muted">
              In the repository: Settings → Deploy keys → Add deploy key. Paste this, and leave
              “Allow write access” off.
            </p>
            <div className="flex items-start justify-between gap-2 rounded-md border border-line bg-inset/50 p-2.5">
              <code className="min-w-0 break-all font-mono text-2xs text-muted">
                {data.deployKey}
              </code>
              <CopyButton value={data.deployKey} label="Copy the deploy key" withText />
            </div>
          </Step>
        )}
        {app.authType === 'deployKey' && data.deployKey === null && (
          <Step n={1} title="Let this server read the repository">
            <InlineAlert tone="warning">
              This app uses a deploy key but none has been generated. Open Edit and press
              “Generate key”.
            </InlineAlert>
          </Step>
        )}

        <Step n={keyStep + 1} title="Create the deploy token">
          <p className="text-xs text-muted">
            It can start a deployment of this app and nothing else. Only a hash of it is stored
            here, so it is shown once.
          </p>
          {token ? (
            <InlineAlert tone="success" title="Copy it now — it will not be shown again">
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <code className="min-w-0 break-all font-mono text-2xs">{token}</code>
                <CopyButton value={token} label="Copy the deploy token" withText />
              </div>
            </InlineAlert>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                size="sm"
                icon={<KeyRound className="size-3.5" aria-hidden="true" />}
                onClick={() => void issue()}
                loading={issuing}
              >
                {app.hook.hasToken ? 'Replace the token' : 'Create token'}
              </Button>
              {app.hook.hasToken && (
                <span className="text-2xs text-faint">
                  One exists, ending in{' '}
                  <code className="font-mono">{app.hook.tokenHint}</code>
                  {app.hook.createdAt ? `, created ${formatDateTime(app.hook.createdAt)}` : ''}.
                </span>
              )}
            </div>
          )}
        </Step>

        <Step n={keyStep + 2} title="Add two repository secrets">
          <p className="text-xs text-muted">
            In the repository: Settings → Secrets and variables → Actions → New repository secret.
          </p>
          <div className="space-y-2">
            <SecretRow
              name="EZ_DEPLOY_URL"
              value={targetUsable ? target.url : null}
              note="Available once GitHub can reach this server (see above)."
            />
            <SecretRow
              name="EZ_DEPLOY_TOKEN"
              value={token}
              note={
                hasToken
                  ? 'The token from the step above. If you no longer have it, replace it.'
                  : 'Create the token in the step above first.'
              }
            />
          </div>
        </Step>

        <Step n={keyStep + 3} title="Add the workflow file">
          <p className="text-xs text-muted">
            Commit this to the repository as{' '}
            <code className="break-all font-mono text-ink">{data.workflowPath}</code>. It contains
            no secrets, and it is the same file whichever way GitHub reaches the server.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton value={data.workflowPath} label="Copy the file path" withText />
            <CopyButton value={data.workflow} label="Copy the workflow" withText />
          </div>
          <pre className="max-h-64 overflow-auto rounded-md border border-line bg-canvas p-3.5 font-mono text-2xs leading-relaxed text-muted">
            {data.workflow}
          </pre>
        </Step>
      </ol>

      <InlineAlert tone="info" title="Optional: ez.json">
        To keep the install, build and start commands with the code, add an{' '}
        <code className="font-mono">ez.json</code> to the repository. Without one, a Node project
        is deployed from its <code className="font-mono">package.json</code> scripts.
      </InlineAlert>
    </div>
  );
}

// ─── The modal ────────────────────────────────────────────────────────────────

export function AppDetailModal({
  appId,
  hook,
  meta,
  initialTab = 'activity',
  onClose,
  onConfigureHook,
  onChanged,
  onDelete,
}: {
  /** The app to show, or null when closed. */
  appId: string | null;
  hook: DeployHook;
  meta: DeploymentsResponse;
  initialTab?: 'activity' | 'releases' | 'github' | 'setup' | 'ezjson';
  onClose: () => void;
  onConfigureHook: () => void;
  onChanged: () => void;
  /** Asks the page to open the delete dialog for this app. */
  onDelete: (app: DeployAppDetail) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const open = appId !== null;
  const [tab, setTab] = useState<string>(initialTab);
  const [acting, setActing] = useState(false);

  const detail = useResource<DeployAppDetail>(
    (signal) => api.deployments.get(appId ?? '', signal),
    [appId],
    { enabled: open }
  );
  const app = detail.data && detail.data.id === appId ? detail.data : null;

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, appId, initialTab]);

  // While a deployment runs, the run list (step, status) is changing.
  usePolling(detail.reload, 2000, open && Boolean(app?.deploying));

  const rollback = async (release: DeployRelease) => {
    if (!app || acting) return;
    const ok = await confirm({
      title: `Roll back ${app.id}?`,
      body: `Release ${release.id} (${shortSha(release.sha)}) will be started in place of the live one. The app restarts.`,
      confirmLabel: 'Roll back',
      tone: 'danger',
    });
    if (!ok) return;

    setActing(true);
    try {
      await api.deployments.rollback(app.id, release.id);
      toast.info('Rollback started');
      setTab('activity');
      detail.reload();
      onChanged();
    } catch (error) {
      toast.error('Could not roll back', errorText(error, 'Nothing was changed.'));
    } finally {
      setActing(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={
        <span className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono">{appId}</span>
          {app?.deploying && (
            <Badge tone="info" dot>
              Deploying
            </Badge>
          )}
        </span>
      }
      description={app ? `${app.repoUrl} · ${app.branch}` : undefined}
    >
      {detail.error && !app ? (
        <ErrorState error={detail.error} onRetry={detail.reload} />
      ) : !app ? (
        <div className="flex items-center gap-2.5 py-10 text-sm text-muted">
          <Spinner /> Loading…
        </div>
      ) : (
        <div className="space-y-4">
          <Tabs
            ariaLabel="App sections"
            value={tab}
            onChange={setTab}
            items={[
              { id: 'activity', label: 'Deployments', count: app.runs.length },
              { id: 'releases', label: 'Releases', count: app.releases.length },
              { id: 'setup', label: 'Domain & folder' },
              { id: 'github', label: 'GitHub Actions' },
              { id: 'ezjson', label: 'ez.json' },
            ]}
          />
          <TabPanel id="activity" value={tab}>
            <ActivityTab app={app} initialRunId={app.activeRunId ?? null} />
          </TabPanel>
          <TabPanel id="releases" value={tab}>
            <ReleasesTab app={app} onRollback={(r) => void rollback(r)} busy={acting || Boolean(app.deploying)} />
          </TabPanel>
          <TabPanel id="setup" value={tab}>
            <DomainFolderTab
              app={app}
              meta={meta}
              onChanged={() => {
                detail.reload();
                onChanged();
              }}
              onDelete={() => onDelete(app)}
            />
          </TabPanel>
          <TabPanel id="ezjson" value={tab}>
            <EzJsonTab app={app} locations={meta.ezFileLocations} />
          </TabPanel>
          <TabPanel id="github" value={tab}>
            <GithubTab
              app={app}
              hook={hook}
              onConfigureHook={onConfigureHook}
              onChanged={() => {
                detail.reload();
                onChanged();
              }}
            />
          </TabPanel>
          {!hook.enabled && tab !== 'github' && app.hook.hasToken && (
            <InlineAlert tone="warning" title="The deploy hook is switched off">
              <span className="inline-flex items-center gap-1.5">
                <ShieldAlert className="size-3.5" aria-hidden="true" />
                This app has a deploy token, but nothing is listening for it.
              </span>
            </InlineAlert>
          )}
        </div>
      )}
    </Modal>
  );
}
