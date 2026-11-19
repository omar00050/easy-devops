import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { api } from '../lib/api';
import type { ApiError } from '../lib/errors';
import type {
  BackgroundServiceEvent,
  BackgroundServiceStatus,
  ServiceStatus,
} from '../lib/types';
import { usePolling, useResource } from '../hooks/useResource';
import { useAuth } from './AuthProvider';
import { useRealtime } from './RealtimeProvider';

interface ServiceContextValue {
  service: ServiceStatus | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
  /**
   * Applies the cheap `backgroundService` half immediately (from a lifecycle
   * response or `service:changed`). Rich fields already fetched — runtime,
   * warnings, restarts — are preserved.
   */
  applyBackgroundService: (update: Partial<BackgroundServiceStatus>) => void;
}

const ServiceContext = createContext<ServiceContextValue | null>(null);

/**
 * GET /api/service, shared by the banner, Processes, Settings and Overview so
 * those four never disagree about the background service.
 *
 * `service:changed` is replayed on connect and then published on every real
 * change, so the socket is the live path. The event carries the same cheap
 * state as `GET /api/service`'s first half; runtime probes and warnings come
 * from the HTTP read, which is re-fetched once per change (coalesced).
 */
export function ServiceProvider({ children }: { children: ReactNode }) {
  const { phase } = useAuth();
  const authenticated = phase === 'authenticated';
  const { client, connected } = useRealtime();

  const resource = useResource<ServiceStatus>(
    (signal) => api.service.status(signal),
    [authenticated],
    { enabled: authenticated }
  );
  const { setData, reload, reloadSilent } = resource;

  usePolling(reload, 60_000, authenticated);

  // A pending response means at least one cached probe has never completed, so
  // the measured fields are null. Re-read once shortly after instead of
  // blocking the first render — and only once, so a slow probe never becomes
  // a poll loop. A non-pending response re-arms this for the next episode.
  const pendingRetryScheduled = useRef(false);
  useEffect(() => {
    if (!authenticated) {
      pendingRetryScheduled.current = false;
      return;
    }
    const probes = resource.data?.probes;
    if (!probes) return;
    if (!probes.pending) {
      pendingRetryScheduled.current = false;
      return;
    }
    if (pendingRetryScheduled.current) return;
    const id = setTimeout(() => {
      pendingRetryScheduled.current = true;
      reloadSilent();
    }, 1_500);
    return () => clearTimeout(id);
  }, [authenticated, resource.data, reloadSilent]);

  const applyBackgroundService = useCallback(
    (update: Partial<BackgroundServiceStatus>) => {
      setData((current) =>
        current
          ? {
              ...current,
              backgroundService: { ...current.backgroundService, ...update },
            }
          : current
      );
    },
    [setData]
  );

  // A restart publishes several events in a second. One HTTP read for the
  // burst is enough; the socket already updated the user-visible state.
  // The native status probe can take longer than the interval, so never abort
  // a read that is already running: mark it dirty and refetch after it lands.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRefresh = useRef(false);
  const loadingRef = useRef(false);
  loadingRef.current = resource.loading;

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      if (loadingRef.current) {
        pendingRefresh.current = true;
        return;
      }
      reload();
    }, 250);
  }, [reload]);

  useEffect(() => {
    if (!resource.loading && pendingRefresh.current) {
      pendingRefresh.current = false;
      reload();
    }
  }, [resource.loading, reload]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!authenticated || !client) return;

    const onServiceChanged = (payload: BackgroundServiceEvent) => {
      applyBackgroundService(payload);
      scheduleRefresh();
    };

    client.on('service:changed', onServiceChanged);
    return () => client.off('service:changed', onServiceChanged);
  }, [authenticated, client, applyBackgroundService, scheduleRefresh]);

  // Reconnect fallback: the server replays service:changed, and this refills
  // the GET-only fields even if that replay is all the socket delivers.
  const previousConnected = useRef(false);
  const connectedOnce = useRef(false);
  useEffect(() => {
    if (!authenticated) {
      previousConnected.current = false;
      connectedOnce.current = false;
      return;
    }
    if (connected && !previousConnected.current) {
      if (connectedOnce.current) scheduleRefresh();
      connectedOnce.current = true;
    }
    previousConnected.current = connected;
  }, [authenticated, connected, scheduleRefresh]);

  const value = useMemo<ServiceContextValue>(
    () => ({
      service: resource.data,
      loading: resource.loading,
      error: resource.error,
      reload: resource.reload,
      applyBackgroundService,
    }),
    [
      resource.data,
      resource.loading,
      resource.error,
      resource.reload,
      applyBackgroundService,
    ]
  );

  return <ServiceContext.Provider value={value}>{children}</ServiceContext.Provider>;
}

export function useService(): ServiceContextValue {
  const context = useContext(ServiceContext);
  if (!context) throw new Error('useService must be used inside ServiceProvider');
  return context;
}
