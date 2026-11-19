import { CheckCircle2 } from 'lucide-react';
import { ApiError } from '../../lib/errors';
import type { IssuanceFailure, IssuanceSuccess } from '../../lib/types';
import { CopyButton } from '../ui/CopyButton';
import { InlineAlert } from '../ui/States';

interface FailureView {
  title: string;
  summary?: string;
  step?: string;
  stage?: string;
  cause?: string;
  consequence?: string;
  fix?: string;
  detail?: string;
  nginxRunning?: boolean;
}

function normalizeFailure(value: unknown, fallbackTitle: string): FailureView {
  if (value instanceof ApiError) {
    const inner = value.payload.error;
    if (inner && typeof inner === 'object') {
      return {
        title: fallbackTitle,
        step: inner.step,
        stage: inner.stage,
        cause: inner.cause,
        consequence: inner.consequence,
        fix: inner.fix ?? (typeof value.payload.hint === 'string' ? value.payload.hint : undefined),
        nginxRunning: inner.nginxRunning,
      };
    }
    const summary =
      value.code === 'email_required'
        ? 'Set the ACME email in Settings → General, or provide an email with this request.'
        : typeof value.payload.hint === 'string'
          ? value.payload.hint
          : undefined;
    const detail =
      typeof value.payload.detail === 'string'
        ? value.payload.detail
        : typeof value.payload.output === 'string'
          ? value.payload.output
          : value.message;
    return { title: fallbackTitle, summary, detail };
  }

  if (value && typeof value === 'object') {
    const failure = value as IssuanceFailure;
    return {
      title: failure.step === 'email configuration' ? 'ACME email is not configured' : fallbackTitle,
      step: failure.step,
      stage: failure.stage,
      cause: failure.cause,
      consequence: failure.consequence,
      fix: failure.fix,
      nginxRunning: failure.nginxRunning,
    };
  }

  if (typeof value === 'string' && value) {
    return { title: fallbackTitle, detail: value };
  }

  return { title: fallbackTitle, summary: 'No certificate was issued.' };
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'unknown';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function modeText(mode: string | undefined): string | null {
  if (!mode) return null;
  if (mode === 'proxy') return 'The HTTP-01 challenge was answered through nginx, so nginx stayed running.';
  if (mode === 'standalone') return 'The challenge ran in standalone mode.';
  if (mode === 'dns') return 'Validated with a DNS TXT record.';
  return `Validation mode: ${mode}.`;
}

export function IssuanceFailurePanel({
  value,
  title = 'Certificate issuance failed',
}: {
  value: unknown;
  title?: string;
}) {
  const view = normalizeFailure(value, title);
  const hasSteps = Boolean(view.step || view.cause || view.consequence);

  return (
    <InlineAlert tone="danger" title={view.title}>
      {view.summary && <p>{view.summary}</p>}
      {hasSteps && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
          {view.step && (
            <>
              <dt className="text-faint">Step</dt>
              <dd className="text-muted">{view.stage ?? view.step}</dd>
            </>
          )}
          {view.cause && (
            <>
              <dt className="text-faint">Cause</dt>
              <dd className="text-muted">{view.cause}</dd>
            </>
          )}
          {view.consequence && (
            <>
              <dt className="text-faint">Note</dt>
              <dd className="text-muted">{view.consequence}</dd>
            </>
          )}
        </dl>
      )}
      {view.nginxRunning === false && (
        <p className="mt-2 text-2xs">nginx is not running right now.</p>
      )}
      {view.fix && (
        <p className="mt-2 break-words rounded border border-warn/25 bg-warn-soft px-2 py-1 text-2xs text-warn">
          <span className="font-medium">Fix:</span> {view.fix}
        </p>
      )}
      {view.detail && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs text-muted">
          {view.detail}
        </pre>
      )}
    </InlineAlert>
  );
}

export function IssuanceSuccessPanel({
  result,
  title = 'Certificate issued',
}: {
  result: IssuanceSuccess;
  title?: string;
}) {
  const mode = modeText(result.mode);

  return (
    <div className="rounded-md border border-ok/30 bg-ok-soft/40 px-3.5 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-ink">
        <CheckCircle2 className="size-4 shrink-0 text-ok" aria-hidden="true" />
        {title}
      </div>
      {result.summary && <p className="mt-1 text-xs text-muted">{result.summary}</p>}

      {result.fellBack && (
        <InlineAlert tone="warning" className="mt-2.5">
          The HTTP challenge could not be answered through nginx, so the standalone challenge
          was used. nginx was stopped for {formatDurationMs(result.nginxDownMs)}.
        </InlineAlert>
      )}
      {result.staging && (
        <InlineAlert tone="warning" className="mt-2.5">
          This is a staging certificate. Browsers will not trust it; issue again against
          production before relying on it.
        </InlineAlert>
      )}

      <dl className="mt-2.5 space-y-1.5">
        <div className="flex items-start gap-2">
          <dt className="w-16 shrink-0 pt-0.5 text-2xs text-faint">Certificate</dt>
          <dd className="min-w-0 flex-1 break-all font-mono text-2xs text-muted">
            {result.certPath}
          </dd>
          <CopyButton value={result.certPath} label="Copy certificate path" />
        </div>
        <div className="flex items-start gap-2">
          <dt className="w-16 shrink-0 pt-0.5 text-2xs text-faint">Private key</dt>
          <dd className="min-w-0 flex-1 break-all font-mono text-2xs text-muted">
            {result.keyPath}
          </dd>
          <CopyButton value={result.keyPath} label="Copy private key path" />
        </div>
      </dl>

      {mode && <p className="mt-2 text-2xs text-faint">{mode}</p>}
    </div>
  );
}
