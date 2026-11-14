import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { ApiError } from '../lib/errors';
import type { ServiceStatus } from '../lib/types';
import { usePolling, useResource } from '../hooks/useResource';
import { useAuth } from './AuthProvider';

interface ServiceContextValue {
  service: ServiceStatus | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

const ServiceContext = createContext<ServiceContextValue | null>(null);

/**
 * GET /api/service, shared by the banner, Processes and Settings so those
 * three never disagree about whether the background service is running.
 */
export function ServiceProvider({ children }: { children: ReactNode }) {
  const { phase } = useAuth();
  const authenticated = phase === 'authenticated';

  const resource = useResource<ServiceStatus>(
    (signal) => api.service.status(signal),
    [authenticated],
    { enabled: authenticated }
  );

  usePolling(resource.reload, 60_000, authenticated);

  const value = useMemo<ServiceContextValue>(
    () => ({
      service: resource.data,
      loading: resource.loading,
      error: resource.error,
      reload: resource.reload,
    }),
    [resource.data, resource.loading, resource.error, resource.reload]
  );

  return <ServiceContext.Provider value={value}>{children}</ServiceContext.Provider>;
}

export function useService(): ServiceContextValue {
  const context = useContext(ServiceContext);
  if (!context) throw new Error('useService must be used inside ServiceProvider');
  return context;
}
