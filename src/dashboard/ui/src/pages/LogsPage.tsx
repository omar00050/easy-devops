import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { cn } from '../lib/cn';
import { useDocumentTitle } from '../hooks/useResource';
import { useLogStream, type LogFile } from '../hooks/useLogStream';
import { useRealtime } from '../app/RealtimeProvider';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge, StatusDot } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { CopyButton } from '../components/ui/CopyButton';
import { InlineAlert } from '../components/ui/States';

const FILES: { id: LogFile; label: string; fileName: string }[] = [
  { id: 'error', label: 'Error', fileName: 'error.log' },
  { id: 'access', label: 'Access', fileName: 'access.log' },
];

function lineClass(line: string): string {
  if (/\[(error|crit|emerg|alert)\]/.test(line)) return 'text-bad';
  if (/\[(warn|warning)\]/.test(line)) return 'text-warn';
  if (/\s(2\d\d|3\d\d)\s/.test(line)) return 'text-ok';
  return 'text-muted';
}

export function LogsPage() {
  useDocumentTitle('Logs');
  const { connectionError } = useRealtime();
  const [params, setParams] = useSearchParams();
  const requested = params.get('file');
  const file: LogFile = requested === 'access' ? 'access' : 'error';
  const meta = FILES.find((entry) => entry.id === file) as (typeof FILES)[number];

  const setFile = (next: LogFile) => {
    const nextParams = new URLSearchParams(params);
    if (next === 'error') nextParams.delete('file');
    else nextParams.set('file', next);
    setParams(nextParams, { replace: true });
  };

  const logs = useLogStream(file, { limit: 500 });

  const logBoxRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    const element = logBoxRef.current;
    if (element && autoScroll) element.scrollTop = element.scrollHeight;
  }, [logs.lines, autoScroll]);

  const paused = logs.paused;
  const live = logs.connected && !paused;

  return (
    <>
      <PageHeader
        title="Logs"
        description="nginx output as it is written. The stream follows the file; switching tabs does not restart nginx."
        meta={
          <Badge tone={paused ? 'warn' : logs.connected ? 'ok' : 'bad'} dot>
            {paused ? 'Paused' : logs.connected ? 'Live' : 'Reconnecting'}
          </Badge>
        }
        actions={
          <>
            <div
              className="flex items-center gap-1 rounded-md border border-line bg-raised/60 p-1"
              role="group"
              aria-label="Log file"
            >
              {FILES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={file === entry.id}
                  onClick={() => setFile(entry.id)}
                  className={cn(
                    'rounded-sm px-3 py-1 text-xs font-medium transition-colors duration-[var(--ez-motion-fast)]',
                    file === entry.id
                      ? 'bg-surface text-ink shadow-sm'
                      : 'text-muted hover:text-ink'
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            <Button
              variant="secondary"
              size="sm"
              icon={
                paused ? (
                  <Play className="size-3.5" aria-hidden="true" />
                ) : (
                  <Pause className="size-3.5" aria-hidden="true" />
                )
              }
              onClick={() => logs.setPaused(!paused)}
            >
              {paused ? 'Resume' : 'Pause'}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 className="size-3.5" aria-hidden="true" />}
              onClick={logs.clear}
              disabled={logs.lines.length === 0}
            >
              Clear
            </Button>

            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
              onClick={logs.restart}
              disabled={!logs.connected}
            >
              Reload tail
            </Button>

            <CopyButton value={logs.lines.join('\n')} label="Copy logs" withText />
          </>
        }
      />

      {connectionError && (
        <InlineAlert tone="warning" title="The live stream is disconnected" className="mb-4">
          New lines appear once the dashboard socket reconnects. nginx itself is unaffected.
        </InlineAlert>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-raised/40 px-4 py-2 sm:px-5">
          <span className="inline-flex items-center gap-2 font-mono text-2xs text-muted">
            <StatusDot
              tone={paused ? 'warn' : logs.connected ? 'ok' : 'bad'}
              pulse={live}
            />
            {paused ? 'Paused' : logs.connected ? 'Live' : 'Reconnecting'}
          </span>
          <span className="font-mono text-2xs text-faint">{meta.fileName}</span>
          <span className="font-mono text-2xs text-faint">
            {logs.lines.length === 1 ? '1 line' : `${logs.lines.length} lines`}
          </span>
          {paused && logs.missed > 0 && (
            <Badge tone="warn">
              {logs.missed === 999 ? '999+' : logs.missed} new while paused
            </Badge>
          )}
          <span className="ml-auto text-2xs text-faint">
            {autoScroll ? 'Following the tail' : 'Scrolled back'}
          </span>
        </div>

        <div className="relative">
          <div
            ref={logBoxRef}
            role="log"
            aria-label={`nginx ${meta.label.toLowerCase()} log`}
            aria-live="off"
            onScroll={() => {
              const element = logBoxRef.current;
              if (!element) return;
              setAutoScroll(
                element.scrollHeight - element.scrollTop - element.clientHeight < 40
              );
            }}
            className="h-[calc(100dvh-20rem)] min-h-72 overflow-y-auto bg-canvas p-4 font-mono text-xs leading-relaxed"
          >
            {logs.lines.length === 0 ? (
              <p className="italic text-faint">
                {!logs.connected
                  ? 'Waiting for the live stream…'
                  : file === 'access'
                    ? 'No access lines yet. They appear here as nginx writes them.'
                    : 'No error lines yet.'}
              </p>
            ) : (
              logs.lines.map((line, index) => (
                <div
                  key={`${index}-${line}`}
                  className={cn('whitespace-pre-wrap break-all py-0.5', lineClass(line))}
                >
                  {line}
                </div>
              ))
            )}
          </div>

          {!autoScroll && (
            <button
              type="button"
              onClick={() => {
                const element = logBoxRef.current;
                if (element) element.scrollTop = element.scrollHeight;
                setAutoScroll(true);
              }}
              className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-pill border border-line bg-surface px-3 py-1.5 text-2xs font-medium text-ink shadow-pop transition-colors hover:bg-inset"
            >
              <ArrowDown className="size-3" aria-hidden="true" />
              Jump to latest
            </button>
          )}
        </div>
      </Card>

      <p className="mt-3 text-2xs text-faint">
        The dashboard keeps the last 500 lines in memory for this tab. Pausing only stops the
        display — lines keep being written to disk.
      </p>
    </>
  );
}
