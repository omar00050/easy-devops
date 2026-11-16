import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime } from '../app/RealtimeProvider';
import type { LogLine } from '../lib/types';

export type LogFile = 'error' | 'access';

export interface LogStream {
  lines: string[];
  paused: boolean;
  missed: number;
  connected: boolean;
  clear: () => void;
  restart: () => void;
  setPaused: (paused: boolean) => void;
}

/**
 * One socket subscription at a time (the server tracks it per connection).
 * Pages that show logs call this; unmounting unsubscribes.
 */
export function useLogStream(
  logFile: LogFile,
  options: { enabled?: boolean; limit?: number } = {}
): LogStream {
  const { client, connected } = useRealtime();
  const enabled = options.enabled ?? true;
  const limit = options.limit ?? 500;

  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPausedState] = useState(false);
  const [missed, setMissed] = useState(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!client || !enabled) return;
    const onLine = (payload: LogLine) => {
      if (payload.logFile !== logFile) return;
      if (pausedRef.current) {
        setMissed((current) => Math.min(current + 1, 999));
        return;
      }
      setLines((current) => {
        const next = [...current, payload.line];
        return next.length > limit ? next.slice(next.length - limit) : next;
      });
    };
    client.on('logs:line', onLine);
    return () => client.off('logs:line', onLine);
  }, [client, enabled, limit, logFile]);

  useEffect(() => {
    setLines([]);
    setMissed(0);
  }, [enabled, logFile]);

  useEffect(() => {
    if (!client || !enabled || !connected) return;
    // The server replays the last 50 lines on every subscribe. Clear first so
    // reconnects replace the tail instead of appending a second copy of it.
    setLines([]);
    setMissed(0);
    client.emit('logs:subscribe', { logFile });
    return () => client.emit('logs:unsubscribe');
  }, [client, connected, enabled, logFile]);

  const clear = useCallback(() => {
    setLines([]);
    setMissed(0);
  }, []);

  const restart = useCallback(() => {
    setLines([]);
    setMissed(0);
    if (!client || !enabled) return;
    client.emit('logs:unsubscribe');
    client.emit('logs:subscribe', { logFile });
  }, [client, enabled, logFile]);

  const setPaused = useCallback((value: boolean) => {
    setPausedState(value);
    if (!value) setMissed(0);
  }, []);

  return { lines, paused, missed, connected, clear, restart, setPaused };
}
