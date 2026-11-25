import { useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, X } from 'lucide-react';
import { useService } from '../../app/ServiceProvider';
import { InlineAlert } from '../ui/States';
import { IconButton } from '../ui/Button';
import { cn } from '../../lib/cn';
import { describeService, type ServiceView } from '../../lib/service';

const DISMISS_KEY = 'ez-service-banner-dismissed';

interface BannerCopy {
  code: 'running' | 'stopped_by_user' | 'not_running';
  tone: 'info' | 'warning';
  title: string;
  body: ReactNode;
  action: string;
}

function Command({ children }: { children: string }) {
  return <code className="font-mono text-ink">{children}</code>;
}

function startsPhrase(view: ServiceView): string {
  if (view.startsAt === 'logon') return 'at your next logon';
  if (view.startsAt === 'boot') return 'at the next boot';
  return 'when the service starts';
}

function bannerFor(view: ServiceView): BannerCopy {
  if (view.running) {
    return {
      code: 'running',
      tone: 'info',
      title: 'Background service is running',
      body: 'This dashboard is the interface only.',
      action: 'Open Processes',
    };
  }

  if (view.stoppedByUser) {
    return {
      code: 'stopped_by_user',
      tone: 'warning',
      title: 'The background service is stopped',
      body: (
        <>
          You stopped it
          {view.stoppedAtLabel ? ` on ${view.stoppedAtLabel}` : ''}, so monitoring and
          notifications are paused. It starts again {startsPhrase(view)}, or run{' '}
          <Command>ezz service start</Command> to start it now.
        </>
      ),
      action: 'Open Processes',
    };
  }

  return {
    code: 'not_running',
    tone: 'warning',
    title: 'The background service is not running',
    body: view.installed === null ? (
      <>
        Windows could not inspect the installed service files. Run{' '}
        <Command>ezz service status</Command> from an Administrator PowerShell.
      </>
    ) : view.installed ? (
      <>
        Monitoring and notifications run in this dashboard and stop when it closes. Start the service
        with <Command>ezz service start</Command>.
      </>
    ) : (
      <>
        Monitoring and notifications would run in this dashboard and stop when it closes. Set up the
        service with <Command>{view.installCommand}</Command>.
      </>
    ),
    action: 'Open Processes',
  };
}

export function ServiceBanner() {
  const { service } = useService();
  const { pathname } = useLocation();
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  const view = describeService(service);
  const copy = view ? bannerFor(view) : null;
  const showAction = pathname !== '/processes';
  const signature = useMemo(() => {
    if (!view || !copy) return '';
    return [
      copy.code,
      view.pid,
      view.startedAt,
      view.stoppedByUser,
      view.stoppedAt,
      view.startsAt,
      view.installed,
    ].join('|');
  }, [view, copy]);

  if (!view || !copy || dismissed === signature) return null;

  const dismiss = () => {
    setDismissed(signature);
    try {
      sessionStorage.setItem(DISMISS_KEY, signature);
    } catch {
      /* non-fatal */
    }
  };

  return (
    <div className="fade-enter mb-5">
      <InlineAlert
        tone={copy.tone}
        title={copy.title}
        action={
          <div className="flex items-center gap-1">
            {showAction && (
              <Link
                to="/processes"
                className={cn(
                  'inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium text-ink',
                  'border border-line bg-raised transition-colors hover:border-line-strong hover:bg-inset'
                )}
              >
                {copy.action}
                <ArrowRight className="size-3" aria-hidden="true" />
              </Link>
            )}
            <IconButton label="Dismiss banner" size="sm" onClick={dismiss}>
              <X className="size-3.5" aria-hidden="true" />
            </IconButton>
          </div>
        }
      >
        {copy.body}
      </InlineAlert>
    </div>
  );
}
