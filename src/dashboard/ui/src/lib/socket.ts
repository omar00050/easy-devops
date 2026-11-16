/**
 * lib/socket.ts — the realtime connection.
 *
 * The handshake carries `X-EZ-Request: 1` as the contract requires, and the
 * session cookie. Transports are deliberately NOT forced to websocket: a
 * browser cannot attach headers to a WebSocket upgrade, so the header only
 * arrives on the initial HTTP polling handshake. Forcing websocket makes the
 * server refuse every connection.
 */

import { io } from 'socket.io-client';
import type { ServerEvents } from './types';

export interface RealtimeClient {
  readonly connected: boolean;
  on<K extends keyof ServerEvents>(event: K, handler: (payload: ServerEvents[K]) => void): void;
  off<K extends keyof ServerEvents>(event: K, handler: (payload: ServerEvents[K]) => void): void;
  emit(event: 'logs:subscribe' | 'logs:unsubscribe', payload?: { logFile: string }): void;
  connect(): void;
  disconnect(): void;
}

export function createRealtimeClient(): RealtimeClient {
  const socket = io({
    withCredentials: true,
    autoConnect: false,
    extraHeaders: { 'X-EZ-Request': '1' },
  });

  return {
    get connected() {
      return socket.connected;
    },
    on(event, handler) {
      socket.on(event as string, handler as (...args: unknown[]) => void);
    },
    off(event, handler) {
      socket.off(event as string, handler as (...args: unknown[]) => void);
    },
    emit(event, payload) {
      if (event === 'logs:subscribe') {
        socket.emit('logs:subscribe', payload ?? { logFile: 'error' });
      } else {
        socket.emit('logs:unsubscribe');
      }
    },
    connect() {
      socket.connect();
    },
    disconnect() {
      socket.disconnect();
    },
  };
}
