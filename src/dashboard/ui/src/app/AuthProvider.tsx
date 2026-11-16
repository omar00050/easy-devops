import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, onApiForbidden, onApiUnauthorized } from '../lib/api';
import { ApiError } from '../lib/errors';
import type { AuthMode, AuthStatus } from '../lib/types';

export type AuthPhase = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

export interface SetupInput {
  password?: string;
  mode?: AuthMode;
  setupCode?: string;
}

interface AuthContextValue {
  phase: AuthPhase;
  /** Last known GET /api/auth payload. Kept through sign-out so the login screen knows the mode. */
  auth: AuthStatus | null;
  bootError: ApiError | null;
  /** Set when a protected call answered 401; shown on the login screen. */
  sessionMessage: string | null;
  /** Set when the origin guard answered 403; shown as a banner, never a redirect. */
  blocked: ApiError | null;
  login: (password: string) => Promise<void>;
  setup: (input: SetupInput) => Promise<void>;
  logout: () => Promise<void>;
  retryBoot: () => Promise<void>;
  dismissBlocked: () => void;
  reportUnauthorized: (message?: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : 'Cannot reach the dashboard.';
  return new ApiError(0, { error: message });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>('loading');
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [bootError, setBootError] = useState<ApiError | null>(null);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<ApiError | null>(null);

  const phaseRef = useRef<AuthPhase>('loading');
  phaseRef.current = phase;

  const applyAuth = useCallback((next: AuthStatus) => {
    setAuth(next);
    setBootError(null);
    setPhase(next.authenticated ? 'authenticated' : 'unauthenticated');
  }, []);

  const retryBoot = useCallback(async () => {
    setPhase('loading');
    try {
      applyAuth(await api.auth.status());
    } catch (error) {
      setBootError(toApiError(error));
      setPhase('error');
    }
  }, [applyAuth]);

  useEffect(() => {
    void retryBoot();
  }, [retryBoot]);

  const reportUnauthorized = useCallback((message?: string) => {
    setSessionMessage(message ?? 'Your session ended. Please sign in again.');
    setBlocked(null);
    setAuth((current) => (current ? { ...current, authenticated: false } : current));
    setPhase('unauthenticated');
  }, []);

  useEffect(() => {
    const offUnauthorized = onApiUnauthorized((message) => {
      // A 401 while this tab was signed in is a session end. A 401 while the
      // login screen is showing (stale background call) must not overwrite the
      // message the user is already reading.
      if (phaseRef.current === 'authenticated') reportUnauthorized(message);
    });
    const offForbidden = onApiForbidden((error) => setBlocked(error));
    return () => {
      offUnauthorized();
      offForbidden();
    };
  }, [reportUnauthorized]);

  /** Login/setup succeeded: trust it even if the follow-up status read fails. */
  const becomeAuthenticated = useCallback(async () => {
    try {
      applyAuth(await api.auth.status());
    } catch {
      setAuth((current) => (current ? { ...current, authenticated: true } : current));
      setPhase('authenticated');
    }
    setSessionMessage(null);
    setBlocked(null);
  }, [applyAuth]);

  const login = useCallback(
    async (password: string) => {
      await api.auth.login(password);
      await becomeAuthenticated();
    },
    [becomeAuthenticated]
  );

  const setup = useCallback(
    async (input: SetupInput) => {
      await api.auth.setup(input);
      await becomeAuthenticated();
    },
    [becomeAuthenticated]
  );

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      // The session is going away either way; a failed logout must not strand
      // the user on a dashboard that no longer has a valid session.
    }
    setAuth((current) => (current ? { ...current, authenticated: false } : current));
    setSessionMessage(null);
    setBlocked(null);
    setPhase('unauthenticated');
  }, []);

  const dismissBlocked = useCallback(() => setBlocked(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      phase,
      auth,
      bootError,
      sessionMessage,
      blocked,
      login,
      setup,
      logout,
      retryBoot,
      dismissBlocked,
      reportUnauthorized,
    }),
    [
      phase,
      auth,
      bootError,
      sessionMessage,
      blocked,
      login,
      setup,
      logout,
      retryBoot,
      dismissBlocked,
      reportUnauthorized,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
