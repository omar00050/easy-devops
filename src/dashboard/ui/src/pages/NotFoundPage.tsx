import { Link } from 'react-router-dom';
import { ArrowLeft, Compass, Globe2, ShieldCheck } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { buttonClasses } from '../components/ui/Button';
import { useDocumentTitle } from '../hooks/useResource';

export function NotFoundPage() {
  useDocumentTitle('Page not found');
  return (
    <>
      <PageHeader
        title="Page not found"
        description="That address does not match a dashboard section."
      />
      <Card className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-accent/60 to-transparent"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -top-28 left-1/2 size-72 -translate-x-1/2 rounded-full bg-accent-soft blur-3xl"
          aria-hidden="true"
        />
        <div className="relative flex flex-col items-center px-6 py-14 text-center">
          <span className="font-mono text-2xs font-semibold uppercase tracking-[0.22em] text-faint">
            HTTP 404 · route not found
          </span>
          <span className="mt-3 bg-linear-to-b from-ink to-ink/25 bg-clip-text font-mono text-6xl font-bold tracking-tighter text-transparent">
            404
          </span>
          <span className="mt-5 flex size-11 items-center justify-center rounded-full border border-line-strong bg-raised text-muted">
            <Compass className="size-5" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-lg font-semibold tracking-tight text-ink">
            This section isn't in the dashboard
          </h2>
          <p className="mt-1.5 max-w-md text-sm leading-6 text-muted">
            The link may be old, or the page moved. Everything else is one click away —
            nginx, domains and certificates are untouched.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <Link to="/" className={buttonClasses('primary', 'sm')}>
              <ArrowLeft className="size-3.5" aria-hidden="true" />
              Back to Overview
            </Link>
            <Link to="/domains" className={buttonClasses('secondary', 'sm')}>
              <Globe2 className="size-3.5" aria-hidden="true" />
              Domains
            </Link>
            <Link to="/ssl" className={buttonClasses('secondary', 'sm')}>
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              Certificates
            </Link>
          </div>
        </div>
      </Card>
    </>
  );
}
