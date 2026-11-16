import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Info,
  Loader2,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import { ApiError } from '../../lib/errors';
import { cn } from '../../lib/cn';
import { Button } from './Button';
import { Card } from './Card';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('spin size-4 text-muted', className)} aria-hidden="true" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden="true" />;
}

export function PageSkeleton({ children }: { children: ReactNode }) {
  return (
    <div className="page-enter space-y-5" aria-busy="true" aria-label="Loading">
      {children}
    </div>
  );
}

export function BootScreen() {
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas">
      <div className="flex items-center gap-3 text-muted">
        <Loader2 className="spin size-5 text-accent-text" aria-hidden="true" />
        <span className="text-sm">Loading Easy DevOps…</span>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-inset text-faint">
        {icon ?? <Inbox className="size-5" aria-hidden="true" />}
      </div>
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      {description && <p className="mt-1 max-w-md text-xs text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function InlineAlert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const styles = {
    info: 'border-info/25 bg-info-soft text-info',
    warning: 'border-warn/30 bg-warn-soft text-warn',
    danger: 'border-bad/30 bg-bad-soft text-bad',
    success: 'border-ok/30 bg-ok-soft text-ok',
  }[tone];

  const Icon = {
    info: Info,
    warning: TriangleAlert,
    danger: AlertTriangle,
    success: CheckCircle2,
  }[tone];

  return (
    <div className={cn('rounded-md border px-3.5 py-3 text-xs', styles, className)} role="status">
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 text-muted">
          {title && <div className="font-medium text-ink">{title}</div>}
          {children && <div className={cn(title ? 'mt-0.5' : undefined, 'break-words')}>{children}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
}) {
  const apiError = error instanceof ApiError ? error : null;
  const blocked = apiError?.status === 403;
  const detail =
    typeof apiError?.payload?.detail === 'string' ? apiError.payload.detail : undefined;
  const message =
    apiError?.message ??
    (error instanceof Error ? error.message : 'Something went wrong while loading this section.');

  return (
    <Card className={cn('border-bad/25', className)}>
      <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-bad-soft text-bad">
          {blocked ? (
            <ShieldAlert className="size-5" aria-hidden="true" />
          ) : (
            <AlertTriangle className="size-5" aria-hidden="true" />
          )}
        </div>
        <h3 className="text-sm font-semibold text-ink">
          {title ?? (blocked ? 'Request blocked' : 'Could not load this section')}
        </h3>
        <p className="mt-1 max-w-md text-xs text-muted">{message}</p>
        {detail && <p className="mt-1 max-w-md break-all font-mono text-2xs text-faint">{detail}</p>}
        {apiError && (
          <p className="mt-2 text-2xs text-faint">
            HTTP {apiError.status}
            {apiError.code ? ` · ${apiError.code}` : ''}
          </p>
        )}
        {onRetry && (
          <Button
            className="mt-4"
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
            onClick={onRetry}
          >
            Try again
          </Button>
        )}
      </div>
    </Card>
  );
}
