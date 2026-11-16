import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { ServiceBanner } from './ServiceBanner';
import { BlockedBanner } from './BlockedBanner';
import { ErrorBoundary } from '../ErrorBoundary';
import { findNavItem } from '../../lib/navigation';

export function AppShell() {
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  const closeNav = useCallback(() => setNavOpen(false), []);

  useEffect(() => {
    setNavOpen(false);
    mainRef.current?.scrollTo({ top: 0 });
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (query.matches) setNavOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const item = findNavItem(pathname);

  return (
    <div className="flex h-full min-h-0 bg-canvas">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[80] focus:rounded-md focus:border focus:border-line focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-ink focus:shadow-pop"
      >
        Skip to content
      </a>

      <Sidebar open={navOpen} onClose={closeNav} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setNavOpen(true)} />
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto outline-none"
        >
          <div className="mx-auto w-full max-w-[var(--ez-content-max)] px-3 py-4 sm:px-5 sm:py-5 lg:px-7 lg:py-6">
            <ServiceBanner />
            <BlockedBanner />
            <div key={pathname} className="page-enter">
              <ErrorBoundary area={item?.title}>
                <Outlet />
              </ErrorBoundary>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
