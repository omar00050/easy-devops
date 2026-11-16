import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { MOCK_ENABLED } from '../lib/api';
import type { RealtimeClient } from '../lib/socket';
import type {
  DomainHealthEntry,
  LocalChangeEvent,
  NginxStatus,
  NotificationEvent,
} from '../lib/types';
import { useAuth } from './AuthProvider';

const MAX_NOTIFICATIONS = 50;

interface RealtimeContextValue {
  client: RealtimeClient | null;
  connected: boolean;
  connectionError: string | null;
  nginxStatus: NginxStatus | null;
  domainHealth: DomainHealthEntry[] | null;
  notifications: NotificationEvent[];
  unread: number;
  markAllRead: () => void;
  clearNotifications: () => void;
  lastChange: LocalChangeEvent | null;
  changeSeq: number;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { phase, reportUnauthorized } = useAuth();
  const authenticated = phase === 'authenticated';

  const [client, setClient] = useState<RealtimeClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [nginxStatus, setNginxStatus] = useState<NginxStatus | null>(null);
  const [domainHealth, setDomainHealth] = useState<DomainHealthEntry[] | null>(null);
  const [notifications, setNotifications] = useState<NotificationEvent[]>([]);
  const [unread, setUnread] = useState(0);
  const [lastChange, setLastChange] = useState<LocalChangeEvent | null>(null);
  const [changeSeq, setChangeSeq] = useState(0);

  const markAllRead = useCallback(() => setUnread(0), []);
  const clearNotifications = useCallback(() => {
    setNotifications([]);
    setUnread(0);
  }, []);

  useEffect(() => {
    if (!authenticated) {
      setClient(null);
      setConnected(false);
      setConnectionError(null);
      setNginxStatus(null);
      setDomainHealth(null);
      setNotifications([]);
      setUnread(0);
      setLastChange(null);
      return;
    }

    let cancelled = false;
    let created: RealtimeClient | null = null;

    const onConnect = () => {
      setConnected(true);
      setConnectionError(null);
    };
    const onDisconnect = () => setConnected(false);
    const onConnectError = (error: Error) => {
      setConnected(false);
      const data = (error as Error & { data?: { reason?: string; detail?: string } }).data;
      if (error.message === 'UNAUTHORIZED' || data?.reason === 'unauthorized') {
        // The socket guard is a session check too; a socket-only failure must
        // still put the user back on the login screen.
        reportUnauthorized();
        return;
      }
      if (error.message === 'FORBIDDEN' || data?.reason) {
        setConnectionError(data?.detail ?? 'Live updates were blocked by the dashboard.');
        return;
      }
      setConnectionError('Live updates are unavailable. Data still refreshes on the page.');
    };
    const onNginx = (status: NginxStatus) => setNginxStatus(status);
    const onHealth = (entries: DomainHealthEntry[]) => setDomainHealth(entries);
    const onNotification = (event: NotificationEvent) => {
      setNotifications((current) => {
        const withoutDuplicate = current.filter((item) => item.id !== event.id);
        const next = [event, ...withoutDuplicate];
        return next.length > MAX_NOTIFICATIONS ? next.slice(0, MAX_NOTIFICATIONS) : next;
      });
      setUnread((current) => Math.min(current + 1, 99));
    };
    const onChange = (event: LocalChangeEvent) => {
      setLastChange(event);
      setChangeSeq((current) => current + 1);
    };

    void (async () => {
      try {
        if (MOCK_ENABLED) {
          const { createMockSocket } = await import('../lib/mock/socket');
          created = await createMockSocket();
        } else {
          const { createRealtimeClient } = await import('../lib/socket');
          created = createRealtimeClient();
        }
        if (cancelled) {
          created.disconnect();
          return;
        }

        created.on('connect', onConnect);
        created.on('disconnect', onDisconnect);
        created.on('connect_error', onConnectError);
        created.on('nginx:status', onNginx);
        created.on('domain:health', onHealth);
        created.on('notification:new', onNotification);
        created.on('local:changed', onChange);

        setClient(created);
        created.connect();
      } catch {
        if (!cancelled) {
          setConnectionError('Could not start the live connection.');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (created) {
        created.off('connect', onConnect);
        created.off('disconnect', onDisconnect);
        created.off('connect_error', onConnectError);
        created.off('nginx:status', onNginx);
        created.off('domain:health', onHealth);
        created.off('notification:new', onNotification);
        created.off('local:changed', onChange);
        created.disconnect();
      }
      setConnected(false);
    };
  }, [authenticated, reportUnauthorized]);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      client,
      connected,
      connectionError,
      nginxStatus,
      domainHealth,
      notifications,
      unread,
      markAllRead,
      clearNotifications,
      lastChange,
      changeSeq,
    }),
    [
      client,
      connected,
      connectionError,
      nginxStatus,
      domainHealth,
      notifications,
      unread,
      markAllRead,
      clearNotifications,
      lastChange,
      changeSeq,
    ]
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error('useRealtime must be used inside RealtimeProvider');
  return context;
}
