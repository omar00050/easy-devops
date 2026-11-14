import { ShieldAlert } from 'lucide-react';
import { useAuth } from '../../app/AuthProvider';
import { Button } from '../ui/Button';

const REASONS: Record<string, string> = {
  host_missing: 'The request arrived without a Host header.',
  host_port_mismatch: 'The request was addressed to a different port.',
  host_not_local: 'The request hostname does not mean this machine.',
  origin_malformed: 'The request carried an unreadable Origin.',
  origin_port_mismatch: 'The request came from a different port.',
  origin_not_local: 'The request came from another site.',
  origin_cross_site: 'The request came from another site.',
  missing_request_header: 'The request was missing the dashboard’s safety header.',
};

/**
 * The origin guard answered 403. This is deliberately NOT a login redirect:
 * signing in cannot fix a request the dashboard refused to accept at all.
 */
export function BlockedBanner() {
  const { blocked, dismissBlocked } = useAuth();
  if (!blocked) return null;

  const reason = blocked.blockedReason;
  const detail =
    typeof blocked.payload.detail === 'string' ? blocked.payload.detail : undefined;

  return (
    <div
      className="fade-enter mb-5 rounded-md border border-bad/30 bg-bad-soft px-3.5 py-3 text-xs"
      role="alert"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-ink">Request blocked</div>
          <div className="mt-0.5 text-muted">
            {reason ? REASONS[reason] ?? 'The dashboard refused this request.' : blocked.message}
          </div>
          {detail && (
            <div className="mt-1 break-all font-mono text-2xs text-faint">{detail}</div>
          )}
          <div className="mt-1.5 text-2xs text-faint">
            This happens when a request comes from another site or through a different port. Try
            reloading the dashboard from its own address.
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={dismissBlocked} className="-mr-1 -mt-1 shrink-0">
          Dismiss
        </Button>
      </div>
    </div>
  );
}
