import { useEffect, useRef } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { X } from 'lucide-react';
import { NAV_SECTIONS } from '../../lib/navigation';
import { BrandMark } from './BrandMark';
import { useService } from '../../app/ServiceProvider';
import { cn } from '../../lib/cn';
import { describeService } from '../../lib/service';
import { StatusDot } from '../ui/Badge';
import { IconButton } from '../ui/Button';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { service } = useService();
  const view = describeService(service);
  const summary = !view
    ? { tone: 'neutral' as const, label: 'Checking service…' }
    : view.running
      ? { tone: 'ok' as const, label: 'Service running' }
      : view.stoppedByUser
        ? { tone: 'warn' as const, label: 'Service stopped by you' }
        : { tone: 'warn' as const, label: 'Service stopped' };

  return (
    <>
      <div
        className={cn(
          'flex h-[var(--ez-topbar-height)] shrink-0 items-center gap-2.5 border-b border-line px-4',
          onNavigate && 'pr-12'
        )}
      >
        <BrandMark className="h-5" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight text-ink">Easy DevOps</div>
          <div className="text-2xs text-faint">Server control plane</div>
        </div>
      </div>

      <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-3 py-4">
        {NAV_SECTIONS.map((section, sectionIndex) => (
          <div key={section.label} className={cn(sectionIndex > 0 && 'mt-5')}>
            <div className="mb-1.5 px-2 text-2xs font-semibold uppercase tracking-[0.14em] text-faint">
              {section.label}
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors duration-[var(--ez-motion-fast)]',
                        isActive
                          ? 'bg-accent-soft text-ink'
                          : 'text-muted hover:bg-inset hover:text-ink'
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          className={cn(
                            'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-pill bg-accent transition-opacity duration-[var(--ez-motion-fast)]',
                            isActive ? 'opacity-100' : 'opacity-0'
                          )}
                          aria-hidden="true"
                        />
                        <Icon
                          className={cn(
                            'size-4 shrink-0 transition-colors',
                            isActive ? 'text-accent-text' : 'text-faint group-hover:text-muted'
                          )}
                          aria-hidden="true"
                        />
                        {item.label}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-line p-3">
        <Link
          to="/processes"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-md border border-line bg-raised/60 px-2.5 py-2 transition-colors hover:border-line-strong hover:bg-inset"
          aria-label={`Background service: ${summary.label}. Open Processes.`}
        >
          <StatusDot tone={summary.tone} pulse={summary.tone === 'ok'} />
          <div className="min-w-0">
            <div className="text-2xs font-medium text-ink">Background service</div>
            <div className="truncate text-2xs text-faint">{summary.label}</div>
          </div>
        </Link>
      </div>
    </>
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open, onClose]);

  return (
    <>
      <aside className="hidden w-[var(--ez-sidebar-width)] shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <SidebarContent />
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="fade-enter absolute inset-0 bg-[var(--ez-overlay)] backdrop-blur-[1px]"
            onClick={onClose}
            aria-hidden="true"
          />
          <aside
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Main navigation"
            tabIndex={-1}
            className="drawer-enter absolute inset-y-0 left-0 flex w-[276px] flex-col border-r border-line bg-surface shadow-pop outline-none"
          >
            <IconButton
              ref={closeRef}
              label="Close navigation"
              size="sm"
              onClick={onClose}
              className="absolute right-2 top-2 z-10"
            >
              <X className="size-4" aria-hidden="true" />
            </IconButton>
            <SidebarContent onNavigate={onClose} />
          </aside>
        </div>
      )}
    </>
  );
}
