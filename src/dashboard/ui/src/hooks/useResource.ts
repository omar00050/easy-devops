import { useCallback, useEffect, useRef, useState, type DependencyList, type ReactNode } from 'react';
import { ApiError } from '../lib/errors';

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  /**
   * Re-fetches without flipping `loading`, so a background poll never shows a
   * refresh indicator. For states that legitimately poll for a while (an agent
   * mid-handshake) this is the difference between a live status and a bar that
   * flashes every two seconds.
   */
  reloadSilent: () => void;
  setData: (updater: T | ((current: T | null) => T | null)) => void;
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return new ApiError(0, { error: message });
}

/**
 * Loads one resource, keeping the previous data visible while a reload is in
 * flight so a refresh never blanks the page. Aborts on unmount / dep change.
 */
export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList = [],
  options: { enabled?: boolean } = {}
): Resource<T> {
  const enabled = options.enabled ?? true;
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [nonce, setNonce] = useState(0);
  const silentNext = useRef(false);
  const [state, setState] = useState<{
    data: T | null;
    error: ApiError | null;
    loading: boolean;
  }>({ data: null, error: null, loading: enabled });

  useEffect(() => {
    if (!enabled) {
      silentNext.current = false;
      setState({ data: null, error: null, loading: false });
      return;
    }
    const controller = new AbortController();
    const silent = silentNext.current;
    silentNext.current = false;
    if (!silent) {
      setState((current) => ({ ...current, loading: true, error: null }));
    }

    loaderRef
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ data, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if ((error as Error)?.name === 'AbortError') return;
        setState((current) => ({ ...current, error: toApiError(error), loading: false }));
      });

    return () => controller.abort();
    // The caller controls re-fetching through `deps` and `reload`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const reloadSilent = useCallback(() => {
    silentNext.current = true;
    setNonce((value) => value + 1);
  }, []);

  const setData = useCallback(
    (updater: T | ((current: T | null) => T | null)) => {
      setState((current) => ({
        ...current,
        data:
          typeof updater === 'function'
            ? (updater as (value: T | null) => T | null)(current.data)
            : updater,
      }));
    },
    []
  );

  return { data: state.data, error: state.error, loading: state.loading, reload, reloadSilent, setData };
}

/** Runs `callback` on an interval while enabled, without resetting on re-renders. */
export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => callbackRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
}

/** Refreshes when the tab becomes visible again after being hidden. */
export function useRefreshOnVisible(callback: () => void): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') callbackRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Easy DevOps` : 'Easy DevOps';
  }, [title]);
}

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'accent';
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

let confirmImplementation: ConfirmFn | null = null;

/** Wired by ConfirmProvider; components call `const confirm = useConfirm()`. */
export function setConfirmImplementation(fn: ConfirmFn | null): void {
  confirmImplementation = fn;
}

export function useConfirm(): ConfirmFn {
  return useCallback((options) => {
    if (!confirmImplementation) return Promise.resolve(false);
    return confirmImplementation(options);
  }, []);
}
