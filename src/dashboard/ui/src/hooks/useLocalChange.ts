import { useEffect, useRef } from 'react';
import { useRealtime } from '../app/RealtimeProvider';

/**
 * Reloads a page's data when the Hub changes something underneath it.
 * The local dashboard's own actions already update their own state; this is
 * for changes this browser did not make.
 */
export function useLocalChange(sections: string | string[], callback: () => void): void {
  const { lastChange, changeSeq } = useRealtime();
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!lastChange) return;
    const wanted = Array.isArray(sections) ? sections : [sections];
    if (wanted.includes(lastChange.section)) callbackRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeSeq]);
}
