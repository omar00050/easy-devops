import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from './ui/Button';
import { Card } from './ui/Card';

interface Props {
  children: ReactNode;
  /** Shown so the fallback names the area that broke. */
  area?: string;
}

interface State {
  error: Error | null;
}

/**
 * Per-page boundary: a render error shows a recoverable card instead of
 * blanking the whole dashboard. Keyed by route in AppShell, so navigating
 * elsewhere resets it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ui] ${this.props.area ?? 'page'} crashed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <Card className="border-bad/30">
        <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
          <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-bad-soft text-bad">
            <ShieldAlert className="size-5" aria-hidden="true" />
          </div>
          <h2 className="text-sm font-semibold text-ink">
            {this.props.area ? `${this.props.area} hit an error` : 'This page hit an error'}
          </h2>
          <p className="mt-1 max-w-lg text-xs text-muted">
            The rest of the dashboard still works. Try again, or reload the page if it keeps
            happening.
          </p>
          <p className="mt-2 max-w-lg break-all font-mono text-2xs text-faint">
            {this.state.error.message}
          </p>
          <Button
            className="mt-4"
            size="sm"
            icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </Button>
        </div>
      </Card>
    );
  }
}
