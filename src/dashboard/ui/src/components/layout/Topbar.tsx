import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LogOut, Menu, Moon, Sun } from 'lucide-react';
import { useTheme } from '../../app/ThemeProvider';
import { useRealtime } from '../../app/RealtimeProvider';
import { useAuth } from '../../app/AuthProvider';
import { findNavItem } from '../../lib/navigation';
import { cn } from '../../lib/cn';
import { StatusDot } from '../ui/Badge';
import { IconButton } from '../ui/Button';
import { NotificationsMenu } from './NotificationsMenu';
import { useToast } from '../ui/Toast';

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { pathname } = useLocation();
  const { theme, toggleTheme } = useTheme();
  const { nginxStatus, connected, connectionError } = useRealtime();
  const { logout } = useAuth();
  const toast = useToast();
  const [signingOut, setSigningOut] = useState(false);

  const title = findNavItem(pathname)?.title ?? 'Easy DevOps';
  const nginxRunning = nginxStatus?.running === true;
  const nginxLabel = nginxStatus === null ? 'Unknown' : nginxRunning ? 'Running' : 'Stopped';

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      toast.success('Signed out', 'Your dashboard session has ended.');
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <header className="sticky top-0 z-30 flex h-[var(--ez-topbar-height)] shrink-0 items-center justify-between gap-3 border-b border-line bg-canvas/85 px-3 backdrop-blur sm:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <IconButton label="Open navigation" size="sm" onClick={onMenu} className="lg:hidden">
          <Menu className="size-4.5" aria-hidden="true" />
        </IconButton>
        <div className="truncate text-sm font-semibold text-ink">{title}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
        <Link
          to="/nginx"
          aria-label={`Nginx is ${nginxLabel.toLowerCase()}. Open Nginx.`}
          className="hidden items-center gap-1.5 rounded-pill border border-line bg-raised px-2.5 py-1 text-2xs transition-colors hover:border-line-strong hover:bg-inset sm:inline-flex"
        >
          <StatusDot
            tone={nginxStatus === null ? 'neutral' : nginxRunning ? 'ok' : 'bad'}
            pulse={nginxRunning && connected}
          />
          <span className="font-medium text-ink">nginx</span>
          <span className="text-faint">{nginxLabel}</span>
        </Link>

        <Link
          to="/nginx"
          aria-label={`Nginx is ${nginxLabel.toLowerCase()}. Open Nginx.`}
          className="flex size-9 items-center justify-center rounded-md transition-colors hover:bg-inset sm:hidden"
        >
          <StatusDot
            tone={nginxStatus === null ? 'neutral' : nginxRunning ? 'ok' : 'bad'}
            pulse={nginxRunning && connected}
          />
        </Link>

        <span
          className="hidden items-center gap-1.5 pl-1 pr-2 text-2xs text-faint md:flex"
          title={
            connectionError ??
            (connected ? 'Live updates are connected.' : 'Reconnecting to live updates…')
          }
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              connectionError ? 'bg-bad' : connected ? 'bg-ok live-dot' : 'bg-faint'
            )}
            aria-hidden="true"
          />
          {connectionError ? 'Live blocked' : connected ? 'Live' : 'Connecting'}
        </span>

        <NotificationsMenu />

        <IconButton
          label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? (
            <Sun className="size-4.5" aria-hidden="true" />
          ) : (
            <Moon className="size-4.5" aria-hidden="true" />
          )}
        </IconButton>

        <IconButton
          label="Sign out"
          onClick={signOut}
          disabled={signingOut}
          className="hover:text-bad"
        >
          <LogOut className="size-4.5" aria-hidden="true" />
        </IconButton>
      </div>
    </header>
  );
}
