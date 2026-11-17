import { useEffect, useRef, useState } from 'react';
import { Cable, Link2, RefreshCw, Unplug } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type {
  HubStatus,
  PermissionGroup,
  PermissionLeaf,
  PermissionMap,
} from '../../lib/types';
import { cn } from '../../lib/cn';
import { validateConnectionString } from '../../lib/validation';
import {
  useConfirm,
  useResource,
} from '../../hooks/useResource';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Badge, StatusDot, type Tone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { TextArea } from '../ui/Field';
import {
  ErrorState,
  InlineAlert,
  Skeleton,
  Spinner,
} from '../ui/States';
import { useToast } from '../ui/Toast';

const STATUS_LABEL: Record<string, string> = {
  not_linked: 'Not linked',
  connecting: 'Connecting…',
  connected: 'Connected',
  rejected: 'Rejected by the Hub',
  unreachable: 'Hub unreachable',
};

const STATUS_TONE: Record<string, Tone> = {
  connected: 'ok',
  connecting: 'warn',
  unreachable: 'warn',
  rejected: 'bad',
  not_linked: 'neutral',
};

function failureText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const detail = typeof error.payload.detail === 'string' ? error.payload.detail : null;
    return detail ?? error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

/** A checkbox whose indeterminate flag has to be set imperatively. */
function GroupCheckbox({
  checked,
  indeterminate,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={`All ${label} permissions`}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-line accent-[var(--ez-accent)]"
    />
  );
}

function isComingSoon(leaf: PermissionLeaf, comingSoon: string[]): boolean {
  return Boolean(leaf.comingSoon) || comingSoon.includes(leaf.id);
}

export function HubPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const hub = useResource<HubStatus>((signal) => api.hub.status(signal));

  const [connectionString, setConnectionString] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);

  const status = hub.data?.status ?? 'not_linked';

  // Keep asking while the outcome can still change on its own — including when
  // the connection is healthy, because the agent may live in the background
  // service and restart without this page knowing. The refresh is SILENT: the
  // status line must not flash a loading bar on every poll.
  useEffect(() => {
    if (!hub.data?.linked) return;
    const delay = status === 'connecting' ? 2_000 : status === 'unreachable' ? 5_000 : 15_000;
    const id = window.setTimeout(hub.reloadSilent, delay);
    return () => window.clearTimeout(id);
  }, [hub.data, hub.reloadSilent, status]);

  const connect = async () => {
    if (connecting) return;
    const problem = validateConnectionString(connectionString);
    if (problem) {
      setConnectError(problem);
      return;
    }
    setConnectError(null);
    setConnecting(true);
    try {
      const result = await api.hub.connect(connectionString.trim());
      hub.setData(result.status);
      setConnectionString('');
      toast.success(
        'Connection string saved',
        result.status.status === 'connecting'
          ? 'Connecting to the Hub…'
          : 'This server is now linked to the Hub.'
      );
    } catch (error) {
      setConnectError(failureText(error, 'The Hub did not accept that connection string.'));
    } finally {
      setConnecting(false);
    }
  };

  const unlink = async () => {
    if (unlinking) return;
    const ok = await confirm({
      title: 'Unlink this server from the Hub?',
      body: 'The Hub stops receiving data from this server. Domains and certificates are not affected.',
      confirmLabel: 'Unlink',
      tone: 'danger',
    });
    if (!ok) return;
    setUnlinking(true);
    try {
      await api.hub.unlink();
      hub.setData((current) =>
        current
          ? {
              ...current,
              linked: false,
              hubUrl: null,
              serverId: null,
              connected: false,
              status: 'not_linked',
              permissions: {},
              lastError: null,
              attempts: 0,
            }
          : current
      );
      setConnectionString('');
      setConnectError(null);
      toast.success('Unlinked from the Hub');
    } catch (error) {
      toast.error('Could not unlink', failureText(error, 'The link is still in place.'));
    } finally {
      setUnlinking(false);
    }
  };

  const permissions: PermissionMap = hub.data?.permissions ?? {};
  const tree = hub.data?.tree ?? [];
  const comingSoon = hub.data?.comingSoon ?? [];

  const savePermissions = async (ids: string[], value: boolean) => {
    if (permissionBusy) return;
    setPermissionBusy(true);
    hub.setData((current) => {
      if (!current) return current;
      const next = { ...current.permissions };
      for (const id of ids) next[id] = value;
      return { ...current, permissions: next };
    });
    try {
      const body: Record<string, boolean> = {};
      for (const id of ids) body[id] = value;
      const result = await api.hub.updatePermissions(body);
      hub.setData((current) =>
        current
          ? {
              ...current,
              permissions: result.permissions,
              tree: result.tree,
              comingSoon: result.comingSoon,
            }
          : current
      );
    } catch (error) {
      toast.error('Could not save permissions', failureText(error, 'The change was not kept.'));
      hub.reload();
    } finally {
      setPermissionBusy(false);
    }
  };

  const groupState = (group: PermissionGroup): 'on' | 'off' | 'partial' => {
    const grantable = group.children.filter((child) => !isComingSoon(child, comingSoon));
    if (grantable.length === 0) return 'off';
    const granted = grantable.filter((child) => permissions[child.id] === true).length;
    if (granted === 0) return 'off';
    return granted === grantable.length ? 'on' : 'partial';
  };

  const toggleGroup = (group: PermissionGroup, turnOn: boolean) => {
    const ids = group.children
      .filter((child) => !isComingSoon(child, comingSoon))
      .map((child) => child.id);
    if (ids.length === 0) return;
    void savePermissions(ids, turnOn);
  };

  const grantedCount = Object.values(permissions).filter(Boolean).length;

  const connectionForm = (submitLabel: string) => (
    <div className="w-full max-w-md space-y-3">
      <TextArea
        label="Connection string"
        value={connectionString}
        onChange={(event) => {
          setConnectionString(event.target.value);
          if (connectError) setConnectError(null);
        }}
        placeholder="ezops://https://hub.example.com|server-id|secret"
        hint="Shown only once by the Hub. Treat it like a password."
        error={connectError}
        className="font-mono"
        spellCheck={false}
        autoComplete="off"
        rows={3}
      />
      <Button
        variant="primary"
        loading={connecting}
        disabled={!connectionString.trim()}
        icon={<Link2 className="size-4" aria-hidden="true" />}
        onClick={() => void connect()}
      >
        {submitLabel}
      </Button>
    </div>
  );

  const topTone = STATUS_TONE[status] ?? 'neutral';
  const content = (() => {
    if (hub.error && !hub.data) {
      return (
        <CardBody>
          <ErrorState
            error={hub.error}
            title="Could not read the Hub status"
            onRetry={hub.reload}
            className="border-0"
          />
        </CardBody>
      );
    }
    if (!hub.data) {
      return (
        <CardBody className="space-y-3">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-24 rounded-md" />
          <Skeleton className="h-40 rounded-md" />
        </CardBody>
      );
    }

    const data = hub.data;
    const label = STATUS_LABEL[data.status] ?? 'Unknown state';
    const tone = STATUS_TONE[data.status] ?? 'neutral';

    return (
      <>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-raised/40 px-4 py-3 sm:px-5">
          <StatusDot tone={tone} pulse={data.status === 'connecting'} />
          <span className="text-sm font-medium text-ink">{label}</span>
          {data.hubUrl && (
            <code className="break-all font-mono text-xs text-muted">{data.hubUrl}</code>
          )}
          {data.serverId && (
            <span className="text-2xs text-faint">
              Server ID <code className="font-mono text-muted">{data.serverId}</code>
            </span>
          )}
          {data.linked && (
            <span className="text-2xs text-faint" title={
              data.agentOwner === 'daemon'
                ? 'The Hub connection is held by the background service, which keeps it alive with no browser open.'
                : 'The Hub connection is held by this dashboard and stops when it closes.'
            }>
              {data.agentOwner === 'daemon' && !data.agentReported
                ? 'waiting for the background service…'
                : data.agentOwner === 'daemon'
                  ? 'via the background service'
                  : 'via this dashboard'}
            </span>
          )}
          {data.status === 'unreachable' && data.attempts > 0 && (
            <span className="text-2xs text-faint">
              {data.attempts} reconnect attempt{data.attempts === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-start gap-x-2 gap-y-1 border-b border-line px-4 py-2.5 text-2xs sm:px-5">
          <span className="font-medium uppercase tracking-wider text-faint">Data directory</span>
          <code className="break-all font-mono text-muted">{data.dataDir}</code>
          {data.devDataDir && <Badge tone="warn">dev override</Badge>}
          {data.devDataDir && (
            <span className="w-full text-faint">
              This is not the normal data directory. The CLI must run with the same override, or
              it reads and writes a different domain list.
            </span>
          )}
        </div>

        <CardBody className="space-y-5">
          {data.lastError && (
            <InlineAlert
              tone={data.status === 'rejected' ? 'danger' : 'warning'}
              title={
                data.status === 'rejected'
                  ? 'The Hub rejected this server'
                  : 'The Hub cannot be reached right now'
              }
            >
              {data.lastError}
            </InlineAlert>
          )}

          {!data.linked ? (
            <>
              <div className="space-y-2">
                <p className="text-sm text-muted">
                  Add this server in the Hub first, then paste the connection string it gives you.
                </p>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
                  <li>
                    Open your Hub dashboard → <span className="text-ink">Add Server</span>
                  </li>
                  <li>Enter a display name and submit</li>
                  <li>Copy the connection string the Hub shows you</li>
                  <li>Paste it below and click Connect</li>
                </ol>
              </div>
              {connectionForm('Connect')}
            </>
          ) : (
            <>
              {data.status === 'rejected' && (
                <div className="space-y-3 border-t border-line pt-4">
                  <p className="text-sm text-muted">
                    This link cannot recover by itself. Paste a fresh connection string from the
                    Hub to replace it.
                  </p>
                  {connectionForm('Reconnect')}
                </div>
              )}

              <section className="space-y-3" aria-labelledby="hub-permissions-heading">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <h3 id="hub-permissions-heading" className="text-sm font-semibold text-ink">
                      Allow the Hub to
                    </h3>
                    <p className="mt-0.5 text-xs text-muted">
                      Monitoring — metrics, nginx status, domains and certificate expiry — is
                      always on. These toggles are enforced on this server; the Hub cannot grant
                      itself anything.
                    </p>
                  </div>
                  <Badge tone={grantedCount > 0 ? 'accent' : 'neutral'}>
                    {grantedCount} granted
                  </Badge>
                </div>

                <div className="space-y-2.5">
                  {tree.map((group) => {
                    const state = groupState(group);
                    return (
                      <div
                        key={group.id}
                        className="overflow-hidden rounded-md border border-line"
                      >
                        <label className="flex cursor-pointer items-start gap-3 bg-raised/60 px-3.5 py-2.5">
                          <GroupCheckbox
                            checked={state === 'on'}
                            indeterminate={state === 'partial'}
                            disabled={permissionBusy}
                            label={group.label}
                            onChange={(checked) => toggleGroup(group, checked)}
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-ink">
                              {group.label}
                            </span>
                            <span className="mt-0.5 block text-xs text-muted">
                              {group.description}
                            </span>
                          </span>
                        </label>
                        <ul className="divide-y divide-line/60">
                          {group.children.map((child) => {
                            const soon = isComingSoon(child, comingSoon);
                            const checked = permissions[child.id] === true;
                            return (
                              <li key={child.id}>
                                <label
                                  className={cn(
                                    'flex items-start gap-3 px-3.5 py-2.5 pl-8',
                                    soon
                                      ? 'cursor-not-allowed opacity-60'
                                      : 'cursor-pointer hover:bg-inset/60'
                                  )}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={soon || permissionBusy}
                                    onChange={() =>
                                      void savePermissions([child.id], !checked)
                                    }
                                    className="mt-0.5 size-3.5 shrink-0 cursor-pointer rounded border-line accent-[var(--ez-accent)]"
                                  />
                                  <span className="min-w-0">
                                    <span className="inline-flex flex-wrap items-center gap-2 text-sm text-ink">
                                      {child.label}
                                      {soon && <Badge tone="warn">Coming soon</Badge>}
                                    </span>
                                    <span className="mt-0.5 block text-xs text-faint">
                                      {child.description}
                                    </span>
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </section>

              <div className="border-t border-line pt-4">
                <Button
                  variant="dangerGhost"
                  loading={unlinking}
                  icon={<Unplug className="size-4" aria-hidden="true" />}
                  onClick={() => void unlink()}
                >
                  Unlink from Hub
                </Button>
              </div>
            </>
          )}
        </CardBody>
      </>
    );
  })();

  return (
    <Card className="overflow-hidden">
      <div
        className={cn(
          'h-0.5 w-full',
          topTone === 'ok'
            ? 'bg-ok/60'
            : topTone === 'bad'
              ? 'bg-bad/60'
              : 'bg-warn/60'
        )}
        aria-hidden="true"
      />
      <CardHeader
        icon={<Cable className="size-4" aria-hidden="true" />}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            Easy DevOps Hub
            {hub.data && (
              <Badge tone={topTone} dot>
                {STATUS_LABEL[hub.data.status] ?? 'Unknown'}
              </Badge>
            )}
            {hub.data?.devDataDir && <Badge tone="warn">dev data dir</Badge>}
          </span>
        }
        description="Monitor and control this server from a central dashboard."
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={hub.loading}
            icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
            onClick={hub.reload}
          >
            Refresh
          </Button>
        }
      />
      {content}
      {hub.loading && hub.data && (
        <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-2xs text-faint sm:px-5">
          <Spinner />
          Refreshing the Hub state…
        </div>
      )}
    </Card>
  );
}
