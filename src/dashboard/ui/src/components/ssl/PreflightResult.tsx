/**
 * components/ssl/PreflightResult.tsx — what the server checked before it spent
 * a Let's Encrypt attempt (core/ssl/preflight.js).
 *
 * Each row is one real check: the DNS record, every A and AAAA address (with
 * "proxied by Cloudflare" classified as OK), IPv6 reachability and the public
 * HTTP self-check. A failed or warned check carries its one-line fix.
 */

import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  MinusCircle,
  XCircle,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { preflightCheckLabel, preflightCheckTarget } from '../../lib/sslProgress';
import type { PreflightCheck, PreflightResult as PreflightData } from '../../lib/types';
import { Badge } from '../ui/Badge';

const STATUS_WORD: Record<PreflightCheck['status'], string> = {
  ok: 'OK',
  warn: 'Warning',
  fail: 'Failed',
  skipped: 'Skipped',
};

function CheckIcon({ status }: { status: PreflightCheck['status'] }) {
  if (status === 'ok') return <CheckCircle2 className="size-4 text-ok" aria-hidden="true" />;
  if (status === 'warn') return <AlertTriangle className="size-4 text-warn" aria-hidden="true" />;
  if (status === 'fail') return <XCircle className="size-4 text-bad" aria-hidden="true" />;
  if (status === 'skipped') return <CircleSlash className="size-4 text-faint" aria-hidden="true" />;
  return <MinusCircle className="size-4 text-faint" aria-hidden="true" />;
}

export function PreflightResult({
  preflight,
  className,
}: {
  preflight?: PreflightData | null;
  className?: string;
}) {
  if (!preflight || preflight.results.length === 0) return null;

  const failures = preflight.results.filter((check) => check.status === 'fail').length;
  const warnings = preflight.results.filter((check) => check.status === 'warn').length;
  const tone = failures > 0 ? 'bad' : warnings > 0 ? 'warn' : 'ok';
  const summary =
    failures > 0
      ? `${failures} ${failures === 1 ? 'check' : 'checks'} failed`
      : warnings > 0
        ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`
        : 'All checks passed';

  return (
    <section
      aria-label="Preflight checks"
      className={cn('rounded-md border border-line bg-raised/30 p-3', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-ink">Preflight checks</h3>
        <Badge tone={tone}>{summary}</Badge>
      </div>
      {preflight.detail && (
        <p className="mt-1.5 break-words text-2xs text-muted">{preflight.detail}</p>
      )}

      <ul className="mt-2 space-y-2">
        {preflight.results.map((check, index) => {
          const label = preflightCheckLabel(check.id);
          const target = preflightCheckTarget(check.id);
          const isProblem = check.status === 'fail' || check.status === 'warn';

          return (
            <li key={`${check.id}-${index}`} className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0">
                <CheckIcon status={check.status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-2xs font-medium text-ink">{label}</span>
                  {target && (
                    <span className="break-all font-mono text-2xs text-faint">{target}</span>
                  )}
                  <span
                    className={cn(
                      'text-2xs uppercase tracking-wide',
                      check.status === 'fail'
                        ? 'text-bad'
                        : check.status === 'warn'
                          ? 'text-warn'
                          : check.status === 'ok'
                            ? 'text-ok'
                            : 'text-faint'
                    )}
                  >
                    {STATUS_WORD[check.status]}
                  </span>
                </div>
                <p className="mt-0.5 break-words text-2xs text-muted">{check.message}</p>
                {isProblem && check.fix && (
                  <p className="mt-1 break-words rounded border border-warn/25 bg-warn-soft px-2 py-1 text-2xs text-warn">
                    <span className="font-medium">Fix:</span> {check.fix}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
