import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Bell,
  BellOff,
  Server,
  ShieldAlert,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useRealtime } from '../../app/RealtimeProvider';
import { timeAgo } from '../../lib/format';
import { cn } from '../../lib/cn';
import { IconButton } from '../ui/Button';
import type { NotificationEvent } from '../../lib/types';

function iconFor(event: NotificationEvent): LucideIcon {
  if (event.type === 'nginx_down') return Server;
  if (event.type === 'cert_expiry') return ShieldAlert;
  if (event.type === 'domain_health') return Activity;
  return Sparkles;
}

function toneFor(severity: NotificationEvent['severity']): string {
  if (severity === 'danger') return 'text-bad';
  if (severity === 'warning') return 'text-warn';
  if (severity === 'success') return 'text-ok';
  if (severity === 'info') return 'text-info';
  return 'text-muted';
}

export function NotificationsMenu() {
  const { notifications, unread, markAllRead, clearNotifications } = useRealtime();
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    markAllRead();
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, markAllRead]);

  useEffect(() => {
    if (open) markAllRead();
  }, [open, notifications.length, markAllRead]);

  useEffect(() => {
    if (!open) return;
    // Relative timestamps ("2m ago") go stale while the panel sits open.
    const id = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(id);
  }, [open]);

  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';

  return (
    <div ref={rootRef} className="sm:relative">
      <div className="relative">
        <IconButton
          ref={buttonRef}
          label={label}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls="notifications-panel"
          className={cn(open && 'bg-inset text-ink')}
        >
          <Bell className="size-4.5" aria-hidden="true" />
        </IconButton>
        {unread > 0 && (
          <span
            className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-pill bg-accent px-1 text-[10px] font-semibold leading-none text-accent-ink"
            aria-hidden="true"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </div>

      {open && (
        <div
          id="notifications-panel"
          role="dialog"
          aria-label="Notifications"
          className="panel-enter absolute right-3 top-[calc(100%+10px)] z-50 w-[min(92vw,360px)] overflow-hidden rounded-lg border border-line bg-surface shadow-pop sm:right-0"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-sm font-semibold text-ink">Notifications</span>
            {notifications.length > 0 && (
              <button
                type="button"
                onClick={clearNotifications}
                className="text-2xs text-muted transition-colors hover:text-ink"
              >
                Clear all
              </button>
            )}
          </div>

          <div className="max-h-[min(60vh,320px)] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <BellOff className="size-5 text-faint" aria-hidden="true" />
                <div className="text-xs text-muted">All clear — no notifications yet.</div>
              </div>
            ) : (
              notifications.map((event) => {
                const Icon = iconFor(event);
                return (
                  <div
                    key={event.id}
                    className="flex items-start gap-2.5 border-b border-line/70 px-4 py-2.5 last:border-0"
                  >
                    <Icon
                      className={cn('mt-0.5 size-4 shrink-0', toneFor(event.severity))}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs leading-snug text-ink">{event.message}</div>
                      <div className="mt-0.5 text-2xs text-faint">{timeAgo(event.timestamp)}</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="border-t border-line bg-raised/50 px-4 py-2">
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              className="text-2xs font-medium text-muted transition-colors hover:text-ink"
            >
              Open notification settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
