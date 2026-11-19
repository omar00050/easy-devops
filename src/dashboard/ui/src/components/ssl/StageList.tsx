/**
 * components/ssl/StageList.tsx — the ordered, live story of one certificate
 * operation (API-CONTRACT.md §3.5), plus the failure that stopped it.
 *
 * The list is the same for issue, renew, renew-all and a link-domain that
 * issues, because the server reports the same stage ids. It never invents a
 * stage: a caller passes the ordered definitions and the states the socket
 * reported.
 *
 * Accessibility: only stage *changes* reach the polite live region. The running
 * stage's elapsed clock ticks every second and is `aria-hidden`, so a screen
 * reader is not interrupted once a second. Status is an icon + a word, never
 * colour alone.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Loader2,
  MinusCircle,
  TimerOff,
  Wrench,
  XCircle,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  formatElapsed,
  stageLabel,
  type StageDefinition,
  type StageRowState,
  type StageStateMap,
} from '../../lib/sslProgress';
import { InlineAlert } from '../ui/States';

const STATUS_WORD: Record<string, string> = {
  running: 'Running',
  ok: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  pending: 'Waiting',
};

function StageIcon({ status }: { status: string }) {
  if (status === 'running') {
    return <Loader2 className="spin size-4 text-accent-text" aria-hidden="true" />;
  }
  if (status === 'ok') {
    return <CheckCircle2 className="size-4 text-ok" aria-hidden="true" />;
  }
  if (status === 'failed') {
    return <XCircle className="size-4 text-bad" aria-hidden="true" />;
  }
  if (status === 'skipped') {
    return <MinusCircle className="size-4 text-faint" aria-hidden="true" />;
  }
  return <Circle className="size-4 text-faint/60" aria-hidden="true" />;
}

export interface StageListFailure {
  /** The failed stage, or `timeout` when the five-minute bound fired. */
  stage?: string | null;
  /** Let's Encrypt's real error, or the server's own sentence. */
  message?: string | null;
  /** The one-line next step, shown in a warning tip. */
  fix?: string | null;
  consequence?: string | null;
}

export function StageList({
  stages,
  states,
  ariaLabel = 'Certificate operation stages',
  failure = null,
  timedOut = false,
  className,
}: {
  stages: readonly StageDefinition[];
  states: StageStateMap;
  ariaLabel?: string;
  /** The failed stage, Let's Encrypt's error and the one-line fix. */
  failure?: StageListFailure | null;
  /** True when the server's five-minute bound fired (also inferred from `failure.stage`). */
  timedOut?: boolean;
  className?: string;
}) {
  const running = stages.some((stage) => states[stage.id]?.status === 'running');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // Only statuses are spoken. A `waiting for validation` frame arrives every
  // couple of seconds with new detail and elapsed time; including either here
  // would announce a tick, which is exactly what this must not do.
  const announcement = useMemo(
    () =>
      stages
        .map((stage) => {
          const state = states[stage.id];
          if (!state) return null;
          return `${stage.label}: ${STATUS_WORD[state.status] ?? state.status}`;
        })
        .filter(Boolean)
        .join('. '),
    [stages, states]
  );

  const failureStage =
    failure?.stage && failure.stage !== 'timeout'
      ? failure.stage
      : stages.find((stage) => states[stage.id]?.status === 'failed')?.id ?? null;
  const isTimeout = timedOut || failure?.stage === 'timeout';
  const message = failure?.message ?? null;
  const fix = failure?.fix ?? null;

  return (
    <div className={cn('min-w-0', className)}>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <ol aria-label={ariaLabel} className="space-y-1">
        {stages.map((stage, index) => {
          const state = states[stage.id];
          const status: StageRowState['status'] | 'pending' = state?.status ?? 'pending';
          const isPending = !state;
          const isRunning = status === 'running';
          const isFailed = status === 'failed' || failureStage === stage.id;
          const detail = state?.detail;
          const elapsed =
            isRunning && state?.elapsedMs != null
              ? state.elapsedMs + (state.elapsedAt != null ? Math.max(0, now - state.elapsedAt) : 0)
              : null;

          return (
            <li
              key={stage.id}
              aria-busy={isRunning || undefined}
              className={cn(
                'flex items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors duration-[var(--ez-motion-fast)]',
                isFailed
                  ? 'bg-bad-soft/50 ring-1 ring-bad/30'
                  : isRunning
                    ? 'bg-accent-soft/40'
                    : 'bg-transparent'
              )}
            >
              <div className="mt-0.5 shrink-0">
                <StageIcon status={isFailed && status !== 'failed' ? 'failed' : status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-2xs font-mono text-faint" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span
                    className={cn(
                      'text-xs font-medium',
                      isFailed ? 'text-bad' : isPending ? 'text-muted' : 'text-ink'
                    )}
                  >
                    {stage.label}
                  </span>
                  {isRunning && elapsed !== null && (
                    <span
                      className="font-mono text-2xs font-medium text-accent-text"
                      aria-hidden="true"
                    >
                      {formatElapsed(elapsed)}
                    </span>
                  )}
                  <span
                    className={cn(
                      'text-2xs uppercase tracking-wide',
                      isFailed
                        ? 'text-bad'
                        : status === 'ok'
                          ? 'text-ok'
                          : status === 'running'
                            ? 'text-accent-text'
                            : 'text-faint'
                    )}
                  >
                    {isFailed && status !== 'failed' ? 'Failed' : STATUS_WORD[status]}
                  </span>
                </div>
                {detail && (
                  <p className="mt-0.5 break-words text-2xs text-muted">{detail}</p>
                )}
                {status === 'skipped' && !detail && (
                  <p className="mt-0.5 text-2xs text-faint">Skipped.</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {isTimeout ? (
        <InlineAlert
          tone="warning"
          title="The five-minute limit was reached"
          className="mt-3"
        >
          <p className="break-words">
            {message ??
              'The certificate operation ran past its five-minute limit and stopped.'}
          </p>
          <p className="mt-1.5 text-2xs text-faint">
            It stopped at {failureStage ? stageLabel(failureStage) : 'an unknown stage'}. Nothing
            later in the list ran, and the certificate already on disk was not replaced. Check the
            preflight checks, then try again.
          </p>
        </InlineAlert>
      ) : message ? (
        <InlineAlert
          tone="danger"
          title={
            failureStage
              ? `Stopped at ${stageLabel(failureStage)}`
              : 'The certificate operation failed'
          }
          className="mt-3"
        >
          <p className="break-words">{message}</p>
          {failure?.consequence && (
            <p className="mt-1.5 break-words text-2xs text-faint">{failure.consequence}</p>
          )}
        </InlineAlert>
      ) : null}

      {fix && !isTimeout && (
        <div
          role="note"
          className="mt-2 flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn"
        >
          <Wrench className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <p className="break-words">
            <span className="font-medium">Fix:</span> {fix}
          </p>
        </div>
      )}

      {isTimeout && (
        <p className="mt-2 flex items-center gap-1.5 text-2xs text-faint">
          <TimerOff className="size-3.5 shrink-0" aria-hidden="true" />
          The limit exists so a stuck ACME server cannot hold the dashboard open.
        </p>
      )}
    </div>
  );
}
