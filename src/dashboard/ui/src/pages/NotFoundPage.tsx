import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/States';
import { buttonClasses } from '../components/ui/Button';
import { useDocumentTitle } from '../hooks/useResource';

export function NotFoundPage() {
  useDocumentTitle('Page not found');
  return (
    <>
      <PageHeader title="Page not found" description="That address does not match a dashboard section." />
      <Card>
        <EmptyState
          title="Nothing here"
          description="The link may be old, or the section may have moved."
          action={
            <Link to="/" className={buttonClasses('secondary', 'sm')}>
              <ArrowLeft className="size-3.5" aria-hidden="true" />
              Back to Overview
            </Link>
          }
        />
      </Card>
    </>
  );
}
