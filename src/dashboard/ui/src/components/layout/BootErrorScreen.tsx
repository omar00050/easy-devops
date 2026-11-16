import { useState } from 'react';
import { PlugZap, RefreshCw } from 'lucide-react';
import { useAuth } from '../../app/AuthProvider';
import { Button } from '../ui/Button';

export function BootErrorScreen() {
  const { bootError, retryBoot } = useAuth();
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    await retryBoot();
    setRetrying(false);
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-card">
        <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-bad-soft text-bad">
          <PlugZap className="size-5" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-semibold text-ink">Cannot reach the dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          {bootError?.message ?? 'The dashboard did not answer.'} Check that Easy DevOps is running,
          then try again.
        </p>
        {bootError && (
          <p className="mt-2 text-2xs text-faint">
            HTTP {bootError.status === 0 ? 'connection failed' : bootError.status}
          </p>
        )}
        <Button
          variant="primary"
          loading={retrying}
          onClick={retry}
          icon={<RefreshCw className="size-4" aria-hidden="true" />}
          className="mt-5"
        >
          Try again
        </Button>
      </div>
    </div>
  );
}
