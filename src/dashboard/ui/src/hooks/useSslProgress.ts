/**
 * hooks/useSslProgress.ts — subscribes to `ssl:progress` for one operation.
 *
 * The contract does not replay the event, so a caller MUST subscribe before it
 * sends the request. The listener attaches on mount and filters every frame by
 * the client's `opId`; one map per domain is kept because renew-all sends every
 * domain's stages with the same opId, and the link-domain request names one.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRealtime } from '../app/RealtimeProvider';
import { applyStageEvent, isKnownStage, type StageStateMap } from '../lib/sslProgress';
import type { SslProgressEvent } from '../lib/types';

export interface SslProgressState {
  /** Stages per domain; a single-domain operation has one key. */
  byDomain: Record<string, StageStateMap>;
  /** True once a frame for this operation has arrived. */
  heard: boolean;
  /** The newest frame's elapsed time, for a live clock before any stage runs. */
  lastElapsedMs: number | null;
  clear: (domain?: string) => void;
}

export function useSslProgress(opId: string | null): SslProgressState {
  const { client } = useRealtime();
  const [byDomain, setByDomain] = useState<Record<string, StageStateMap>>({});
  const [heard, setHeard] = useState(false);
  const [lastElapsedMs, setLastElapsedMs] = useState<number | null>(null);

  useEffect(() => {
    if (!client || !opId) return;

    const handler = (event: SslProgressEvent) => {
      if (!event || event.opId !== opId || typeof event.stage !== 'string') return;
      if (!isKnownStage(event.stage) || event.stage === 'timeout') return;
      setHeard(true);
      setLastElapsedMs(typeof event.elapsedMs === 'number' ? event.elapsedMs : null);
      setByDomain((current) => {
        const domain = typeof event.domain === 'string' ? event.domain : '';
        const stages = current[domain] ?? {};
        return { ...current, [domain]: applyStageEvent(stages, event) };
      });
    };

    client.on('ssl:progress', handler);
    return () => client.off('ssl:progress', handler);
  }, [client, opId]);

  const clear = useCallback((domain?: string) => {
    setByDomain((current) => {
      if (domain === undefined) return {};
      const next = { ...current };
      delete next[domain];
      return next;
    });
    setHeard(false);
    setLastElapsedMs(null);
  }, []);

  return { byDomain, heard, lastElapsedMs, clear };
}
