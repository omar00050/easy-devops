/**
 * lib/mock/socket.ts — a stand-in for the Socket.io connection.
 *
 * Emits the same events on the same schedule shape as socketManager.js, so
 * pages that rely on live data behave identically with no backend.
 */

import type { RealtimeClient } from '../socket';
import type {
  DomainHealthEntry,
  HubAgentStateEvent,
  LogLine,
  NginxStatus,
  NotificationEvent,
  ServerEvents,
} from '../types';
import {
  mockHubAgentSnapshot,
  mockServiceSnapshot,
  subscribeMockServiceChanges,
} from './index';
import { subscribeMockSslProgress } from './ssl';

type Handler = (payload: unknown) => void;

const MOCK_NGINX: NginxStatus = { running: true, version: '1.24.0', pid: 1421 };

const MOCK_HEALTH: DomainHealthEntry[] = [
  { name: 'app.example.com', up: true, port: 3000, host: '127.0.0.1' },
  { name: 'api.example.com', up: true, port: 8080, host: '127.0.0.1' },
  { name: 'blog.example.com', up: false, port: 4000, host: '10.0.0.12' },
  { name: 'staging.example.com', up: true, port: 5000, host: '127.0.0.1' },
];

function makeEvent(
  type: string,
  severity: string,
  message: string,
  extra: Partial<NotificationEvent> = {}
): NotificationEvent {
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    severity,
    message,
    timestamp: Date.now(),
    ...extra,
  };
}

export async function createMockSocket(): Promise<RealtimeClient> {
  const handlers = new Map<string, Set<Handler>>();
  let connected = false;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let intervals: ReturnType<typeof setInterval>[] = [];
  let logTimer: ReturnType<typeof setInterval> | null = null;
  let lineIndex = 0;
  let unsubscribeService: (() => void) | null = null;
  let unsubscribeSsl: (() => void) | null = null;

  const fire = <K extends keyof ServerEvents>(event: K, payload: ServerEvents[K]): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };

  const subscribe = (event: string, handler: Handler): void => {
    const set = handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(event, set);
  };

  const unsubscribe = (event: string, handler: Handler): void => {
    handlers.get(event)?.delete(handler);
  };

  const stopTimers = (): void => {
    timers.forEach(clearTimeout);
    timers = [];
    intervals.forEach(clearInterval);
    intervals = [];
    if (logTimer) clearInterval(logTimer);
    logTimer = null;
  };

  const client: RealtimeClient = {
    get connected() {
      return connected;
    },
    on(event, handler) {
      subscribe(event, handler as Handler);
    },
    off(event, handler) {
      unsubscribe(event, handler as Handler);
    },
    emit(event, payload) {
      if (event === 'logs:unsubscribe') {
        if (logTimer) clearInterval(logTimer);
        logTimer = null;
        return;
      }
      const logFile = payload?.logFile === 'access' ? 'access' : 'error';
      if (logTimer) clearInterval(logTimer);
      // socketManager tails with `-n 50`, so subscribers receive the last 50
      // lines before new ones arrive.
      for (let index = 50; index > 0; index -= 1) {
        const stamp = new Date(Date.now() - index * 30_000)
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19);
        fire('logs:line', {
          logFile,
          line:
            logFile === 'access'
              ? `10.0.0.${5 + (index % 4)} - - [${stamp}] "GET /health HTTP/1.1" 200 ${300 + index} "-" "Mozilla/5.0"`
              : `${stamp} [warn] 1421#1421: *${100 + index} an upstream response is buffered to a temporary file`,
        });
      }
      logTimer = setInterval(() => {
        lineIndex += 1;
        const line: LogLine =
          logFile === 'access'
            ? {
                line: `10.0.0.${5 + (lineIndex % 4)} - - [${new Date().toISOString()}] "GET / HTTP/1.1" 200 ${1000 + lineIndex * 37} "-" "Mozilla/5.0"`,
                logFile,
              }
            : {
                line: `${new Date()
                  .toISOString()
                  .replace('T', ' ')
                  .slice(0, 19)} [warn] 1421#1421: *${400 + lineIndex} an upstream response is buffered to a temporary file`,
                logFile,
              };
        fire('logs:line', line);
      }, 900);
    },
    connect() {
      if (connected) return;
      stopTimers();
      timers.push(
        setTimeout(() => {
          connected = true;
          fire('connect', undefined);
          fire('nginx:status', MOCK_NGINX);
          fire('domain:health', MOCK_HEALTH);
          // socketManager keeps the last `service:changed` and replays it to
          // every new connection; mirror that so the card is live on connect.
          const snapshot = mockServiceSnapshot();
          if (snapshot) fire('service:changed', snapshot);
          // The server replays the agent state on connect; keep the Hub card
          // live from the same event the real backend publishes.
          const hub = mockHubAgentSnapshot();
          if (hub) fire('hub:agentState', hub);
          unsubscribeService?.();
          unsubscribeService = subscribeMockServiceChanges((payload) => {
            if (connected) fire('service:changed', payload);
          });
          unsubscribeSsl?.();
          unsubscribeSsl = subscribeMockSslProgress((payload) => {
            if (connected) fire('ssl:progress', payload);
          });
        }, 120),
        setTimeout(() => {
          fire(
            'notification:new',
            makeEvent(
              'nginx_down',
              'success',
              'Nginx is running again',
              { subtype: 'recovery' }
            )
          );
        }, 2200),
        setTimeout(() => {
          fire(
            'notification:new',
            makeEvent('cert_expiry', 'warning', '🔒 SSL cert for api.example.com expires in 12 days', {
              domain: 'api.example.com',
            })
          );
        }, 5200),
        setTimeout(() => {
          const current = mockHubAgentSnapshot();
          if (!current?.linked) return;
          const dropped: HubAgentStateEvent = {
            ...current,
            connected: false,
            status: 'unreachable',
            attempts: current.attempts + 1,
            lastError: 'connect ECONNREFUSED 10.0.0.20:443',
          };
          fire('hub:agentState', dropped);
        }, 9_000),
        setTimeout(() => {
          const current = mockHubAgentSnapshot();
          if (!current?.linked) return;
          fire('hub:agentState', {
            ...current,
            connected: true,
            status: 'connected',
            attempts: 0,
            lastError: null,
          });
        }, 15_000)
      );
      intervals.push(
        setInterval(() => {
          if (connected) fire('nginx:status', MOCK_NGINX);
        }, 5000),
        setInterval(() => {
          if (connected) fire('domain:health', MOCK_HEALTH);
        }, 60_000)
      );
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      stopTimers();
      unsubscribeService?.();
      unsubscribeService = null;
      unsubscribeSsl?.();
      unsubscribeSsl = null;
      fire('disconnect', undefined);
    },
  };

  return client;
}
