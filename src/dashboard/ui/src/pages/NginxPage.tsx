import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pause,
  Play,
  RefreshCw,
  Save,
  Server,
  Undo2,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { NginxCommandResult, NginxStatus } from '../lib/types';
import { cn } from '../lib/cn';
import {
  useConfirm,
  useDocumentTitle,
  useRefreshOnVisible,
  useResource,
} from '../hooks/useResource';
import { useLocalChange } from '../hooks/useLocalChange';
import { useLogStream } from '../hooks/useLogStream';
import { useRealtime } from '../app/RealtimeProvider';
import { PageHeader } from '../components/layout/PageHeader';
import { Card, CardBody } from '../components/ui/Card';
import { Badge, StatusDot } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { CopyButton } from '../components/ui/CopyButton';
import { Select } from '../components/ui/Field';
import {
  ErrorState,
  InlineAlert,
  PageSkeleton,
  Skeleton,
} from '../components/ui/States';
import { useToast } from '../components/ui/Toast';

type NginxAction = 'start' | 'stop' | 'restart' | 'reload' | 'test';

const ACTION_LABEL: Record<NginxAction, string> = {
  start: 'Start nginx',
  stop: 'Stop nginx',
  restart: 'Restart nginx',
  reload: 'Reload nginx',
  test: 'Test configuration',
};

const NGINX_ACTIONS: Record<NginxAction, () => Promise<NginxCommandResult>> = {
  start: () => api.nginx.start(),
  stop: () => api.nginx.stop(),
  restart: () => api.nginx.restart(),
  reload: () => api.nginx.reload(),
  test: () => api.nginx.test(),
};

function actionErrorOutput(error: unknown): string {
  if (error instanceof ApiError) {
    if (typeof error.payload.output === 'string' && error.payload.output) {
      return error.payload.output;
    }
    if (typeof error.payload.error === 'string' && error.payload.error) {
      return error.payload.error;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'The action failed.';
}

function lineClass(line: string): string {
  if (/\[(error|crit|emerg|alert)\]/i.test(line)) return 'text-bad';
  if (/\[warn(ing)?\]/i.test(line)) return 'text-warn';
  return 'text-muted';
}

export function NginxPage() {
  useDocumentTitle('Nginx');
  const toast = useToast();
  const confirm = useConfirm();
  const { nginxStatus: liveStatus, connectionError } = useRealtime();

  const statusResource = useResource<NginxStatus>((signal) => api.nginx.status(signal));
  const configsResource = useResource<string[]>((signal) => api.nginx.configs(signal));

  const [status, setStatus] = useState<NginxStatus | null>(null);
  const [busy, setBusy] = useState<NginxAction | null>(null);
  const [actionResult, setActionResult] = useState<{
    action: NginxAction;
    ok: boolean;
    output: string;
  } | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [configError, setConfigError] = useState<unknown>(null);
  const [configResult, setConfigResult] = useState<{ ok: boolean; output: string } | null>(
    null
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const logs = useLogStream('error', { limit: 300 });
  const logBoxRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (statusResource.data) setStatus(statusResource.data);
  }, [statusResource.data]);

  useEffect(() => {
    if (liveStatus) setStatus(liveStatus);
  }, [liveStatus]);

  useEffect(() => {
    const element = logBoxRef.current;
    if (element && autoScroll) element.scrollTop = element.scrollHeight;
  }, [logs.lines, autoScroll]);

  const dirty = selected !== null && content !== original;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const reloadAll = () => {
    statusResource.reload();
    configsResource.reload();
  };

  useRefreshOnVisible(reloadAll);
  useLocalChange('nginx', reloadAll);

  async function selectConfig(filename: string) {
    if (!filename || filename === selected || loadingFile || saving) return;
    if (dirty) {
      const ok = await confirm({
        title: 'Discard unsaved changes?',
        body: `${selected} has edits that were not saved.`,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setSelected(filename);
    setLoadingFile(true);
    setConfigError(null);
    setConfigResult(null);
    try {
      const result = await api.nginx.getConfig(filename);
      setContent(result.content);
      setOriginal(result.content);
    } catch (error) {
      setConfigError(error);
      setContent('');
      setOriginal('');
    } finally {
      setLoadingFile(false);
    }
  }

  useEffect(() => {
    if (selected || !configsResource.data?.length) return;
    void selectConfig(configsResource.data[0]);
    // selectConfig reads the current selection and edit state at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configsResource.data, selected]);

  const runAction = async (action: NginxAction) => {
    if (busy) return;
    if (action === 'stop' || action === 'restart') {
      const ok = await confirm({
        title: action === 'stop' ? 'Stop nginx?' : 'Restart nginx?',
        body:
          action === 'stop'
            ? 'Every site nginx serves goes offline until it is started again.'
            : 'Open connections are dropped for a moment while nginx restarts.',
        confirmLabel: action === 'stop' ? 'Stop nginx' : 'Restart nginx',
        tone: 'danger',
      });
      if (!ok) return;
    }

    setBusy(action);
    setActionResult(null);
    try {
      const result = await NGINX_ACTIONS[action]();
      setActionResult({ action, ok: result.success, output: result.output });
      if (result.success) {
        toast.success(
          `${ACTION_LABEL[action]} succeeded`,
          action === 'test' ? 'nginx -t accepted the configuration.' : undefined
        );
        if (action !== 'test') statusResource.reload();
      } else {
        toast.error(`${ACTION_LABEL[action]} failed`, result.output || undefined);
      }
    } catch (error) {
      const output = actionErrorOutput(error);
      setActionResult({ action, ok: false, output });
      toast.error(`${ACTION_LABEL[action]} failed`, output);
    } finally {
      setBusy(null);
    }
  };

  const saveConfig = async () => {
    if (!selected || saving || loadingFile || !dirty) return;
    setSaving(true);
    setConfigResult(null);
    try {
      const result = await api.nginx.saveConfig(selected, content);
      setOriginal(content);
      setConfigResult({
        ok: true,
        output: result.output || 'Saved and tested successfully.',
      });
      toast.success('Configuration saved', 'nginx -t passed. Reload nginx to apply it.');
    } catch (error) {
      setConfigResult({ ok: false, output: actionErrorOutput(error) });
      toast.error('Configuration rejected', 'The previous file was restored.');
    } finally {
      setSaving(false);
    }
  };

  const revertConfig = () => {
    setContent(original);
    setConfigResult(null);
  };

  const lineNumbers = useMemo(() => {
    const count = content.split('\n').length;
    return Array.from({ length: Math.max(count, 1) }, (_, index) => index + 1);
  }, [content]);

  const running = Boolean(status?.running);
  const initialLoading = !status && (statusResource.loading || Boolean(statusResource.error));
  const logsValue = logs.lines.join('\n');

  return (
    <>
      <PageHeader
        title="Nginx"
        description="Service controls, configuration files and the error log, without leaving the dashboard."
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={statusResource.loading || configsResource.loading}
            icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
            onClick={() => {
              reloadAll();
              logs.restart();
            }}
          >
            Refresh
          </Button>
        }
      />

      {statusResource.error && !status ? (
        <ErrorState error={statusResource.error} onRetry={statusResource.reload} />
      ) : initialLoading ? (
        <PageSkeleton>
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-[380px] rounded-lg" />
        </PageSkeleton>
      ) : (
        <div className="space-y-5">
          {statusResource.error && status && (
            <div className="rounded-md border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-xs text-muted">
              Showing the last known status. {statusResource.error.message}{' '}
              <button
                type="button"
                className="font-medium text-ink underline-offset-2 hover:underline"
                onClick={statusResource.reload}
              >
                Try again
              </button>
            </div>
          )}

          <Card className="overflow-hidden">
            <div
              className={cn('h-0.5 w-full', running ? 'bg-ok/60' : 'bg-bad/60')}
              aria-hidden="true"
            />
            <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3.5">
                <div className="relative flex size-11 shrink-0 items-center justify-center rounded-lg border border-line bg-raised">
                  <Server className="size-5 text-ink" aria-hidden="true" />
                  <StatusDot
                    tone={running ? 'ok' : 'bad'}
                    pulse={running}
                    className="absolute -right-0.5 -top-0.5 ring-2 ring-surface"
                  />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-ink">
                      {running ? 'nginx is running' : 'nginx is stopped'}
                    </h2>
                    {status?.pid !== null && status?.pid !== undefined && running && (
                      <Badge tone="neutral">pid {status.pid}</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-muted">
                    {status?.version ?? 'Version unavailable'}
                  </p>
                  {status?.error && <p className="mt-1 text-xs text-bad">{status.error}</p>}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {running ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === 'reload'}
                      disabled={busy !== null && busy !== 'reload'}
                      onClick={() => runAction('reload')}
                    >
                      Reload
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === 'restart'}
                      disabled={busy !== null && busy !== 'restart'}
                      onClick={() => runAction('restart')}
                    >
                      Restart
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={busy === 'stop'}
                      disabled={busy !== null && busy !== 'stop'}
                      onClick={() => runAction('stop')}
                    >
                      Stop
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy === 'start'}
                    disabled={busy !== null && busy !== 'start'}
                    onClick={() => runAction('start')}
                  >
                    Start nginx
                  </Button>
                )}
                <span className="mx-0.5 hidden h-6 w-px bg-line sm:block" aria-hidden="true" />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === 'test'}
                  disabled={busy !== null && busy !== 'test'}
                  onClick={() => runAction('test')}
                >
                  Test config
                </Button>
              </div>
            </CardBody>

            {actionResult && (
              <div className="border-t border-line px-4 py-3 sm:px-5">
                <InlineAlert
                  tone={actionResult.ok ? 'success' : 'danger'}
                  title={`${ACTION_LABEL[actionResult.action]} ${
                    actionResult.ok ? 'succeeded' : 'failed'
                  }`}
                >
                  {actionResult.output && (
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs">
                      {actionResult.output}
                    </pre>
                  )}
                </InlineAlert>
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-line px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">Configuration</h2>
                  {dirty && <Badge tone="warn">Unsaved changes</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  Every save is written, tested with nginx -t, and rolled back if nginx
                  rejects it.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label="Configuration file"
                  value={selected ?? ''}
                  disabled={saving || loadingFile || !configsResource.data?.length}
                  onChange={(event) => void selectConfig(event.target.value)}
                  className="w-full sm:w-60"
                >
                  <option value="" disabled>
                    Select a config file…
                  </option>
                  {(configsResource.data ?? []).map((filename) => (
                    <option key={filename} value={filename}>
                      {filename}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!dirty || saving}
                  icon={<Undo2 className="size-3.5" aria-hidden="true" />}
                  onClick={revertConfig}
                >
                  Revert
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!selected || !dirty}
                  loading={saving}
                  icon={<Save className="size-3.5" aria-hidden="true" />}
                  onClick={saveConfig}
                >
                  Save
                </Button>
              </div>
            </div>

            {configsResource.error && !configsResource.data ? (
              <div className="p-4 sm:p-5">
                <ErrorState error={configsResource.error} onRetry={configsResource.reload} />
              </div>
            ) : !configsResource.data ? (
              <div className="space-y-2 p-4 sm:p-5">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-[300px]" />
              </div>
            ) : configsResource.data.length === 0 ? (
              <div className="px-4 py-14 text-center text-sm text-muted sm:px-5">
                No configuration files were found.
              </div>
            ) : loadingFile ? (
              <div className="flex h-[360px] items-center justify-center gap-2 text-sm text-muted">
                <RefreshCw className="spin size-4" aria-hidden="true" />
                Loading configuration…
              </div>
            ) : configError ? (
              <div className="p-4 sm:p-5">
                <ErrorState
                  error={configError}
                  title="Could not load this configuration"
                  onRetry={() => (selected ? void selectConfig(selected) : undefined)}
                />
              </div>
            ) : !selected ? (
              <div className="px-4 py-14 text-center text-sm text-muted sm:px-5">
                Select a configuration file to start editing.
              </div>
            ) : (
              <div className="relative flex h-[min(56vh,520px)] min-h-[280px] overflow-hidden bg-canvas">
                <div
                  ref={gutterRef}
                  aria-hidden="true"
                  className="config-editor pointer-events-none w-12 shrink-0 overflow-hidden border-r border-line bg-inset/40 py-3 pr-2 text-right text-faint"
                >
                  {lineNumbers.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
                <textarea
                  ref={textareaRef}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  onScroll={() => {
                    if (gutterRef.current && textareaRef.current) {
                      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
                    }
                  }}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                      event.preventDefault();
                      void saveConfig();
                    }
                  }}
                  wrap="off"
                  spellCheck={false}
                  aria-label={selected ? `${selected} contents` : 'nginx configuration'}
                  className="config-editor h-full w-full resize-none bg-transparent py-3 pl-4 pr-4 text-ink caret-accent outline-none"
                />
              </div>
            )}

            {configResult && (
              <div
                className={cn(
                  'border-t px-4 py-3 sm:px-5',
                  configResult.ok
                    ? 'border-ok/25 bg-ok-soft'
                    : 'border-bad/25 bg-bad-soft'
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p
                    className={cn(
                      'text-xs font-medium',
                      configResult.ok ? 'text-ok' : 'text-bad'
                    )}
                  >
                    {configResult.ok
                      ? 'Saved — nginx test passed'
                      : 'Save rejected — the previous file was restored'}
                  </p>
                  {configResult.ok && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === 'reload'}
                      disabled={busy !== null && busy !== 'reload'}
                      onClick={() => runAction('reload')}
                    >
                      Reload nginx
                    </Button>
                  )}
                </div>
                {configResult.output && (
                  <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs text-muted">
                    {configResult.output}
                  </pre>
                )}
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-ink">Error log</h2>
                <span className="inline-flex items-center gap-1.5 text-2xs text-faint">
                  <StatusDot tone={logs.paused ? 'warn' : logs.connected ? 'ok' : 'neutral'} pulse={!logs.paused && logs.connected} />
                  {logs.paused ? 'Paused' : logs.connected ? 'Live' : 'Connecting…'}
                </span>
                {logs.paused && logs.missed > 0 && (
                  <Badge tone="warn">{logs.missed} new</Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {logsValue && <CopyButton value={logsValue} label="Copy lines" withText />}
                <IconButton
                  label={logs.paused ? 'Resume the log stream' : 'Pause the log stream'}
                  size="sm"
                  onClick={() => logs.setPaused(!logs.paused)}
                >
                  {logs.paused ? (
                    <Play className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Pause className="size-3.5" aria-hidden="true" />
                  )}
                </IconButton>
                <IconButton
                  label="Clear the log view"
                  size="sm"
                  onClick={logs.clear}
                  disabled={logs.lines.length === 0}
                >
                  <RefreshCw className="size-3.5 rotate-45" aria-hidden="true" />
                </IconButton>
              </div>
            </div>

            <div
              ref={logBoxRef}
              aria-label="Recent nginx error log"
              onScroll={(event) => {
                const element = event.currentTarget;
                setAutoScroll(
                  element.scrollHeight - element.scrollTop - element.clientHeight < 40
                );
              }}
              className="h-64 overflow-y-auto bg-canvas px-4 py-3 font-mono text-2xs leading-relaxed sm:px-5"
            >
              {!logs.connected && logs.lines.length === 0 ? (
                <p className="text-faint">Waiting for the live stream…</p>
              ) : logs.lines.length === 0 ? (
                <p className="text-faint">No errors logged.</p>
              ) : (
                logs.lines.map((line, index) => (
                  <div
                    key={index}
                    className={cn('whitespace-pre-wrap break-all py-0.5', lineClass(line))}
                  >
                    {line}
                  </div>
                ))
              )}
            </div>

            {connectionError && (
              <div className="border-t border-line px-4 py-2 text-2xs text-muted sm:px-5">
                The live log stream is disconnected. New lines appear once the dashboard socket
                reconnects.{' '}
                <button
                  type="button"
                  className="font-medium text-ink underline-offset-2 hover:underline"
                  onClick={logs.restart}
                >
                  Try again
                </button>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
