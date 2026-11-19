import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Moon,
  ShieldOff,
  Sun,
} from 'lucide-react';
import { BrandMark } from '../components/layout/BrandMark';
import { useAuth } from '../app/AuthProvider';
import { useTheme } from '../app/ThemeProvider';
import { MOCK_ENABLED } from '../lib/api';
import { ApiError } from '../lib/errors';
import type { AuthStatus } from '../lib/types';
import { useDocumentTitle } from '../hooks/useResource';
import { cn } from '../lib/cn';
import { currentYear } from '../lib/format';
import { Button, IconButton } from '../components/ui/Button';
import { TextInput } from '../components/ui/Field';
import { InlineAlert } from '../components/ui/States';

const HIGHLIGHTS = [
  'Domains, certificates and nginx configs in one flow',
  'Live nginx status, health checks and log tails',
  'Processes, notifications and Hub pairing built in',
  'Local-first: no Docker, no cloud account',
];

const SETUP_CODE_EXPIRED =
  'This code has expired. Get a new one with: ezz dashboard setup-code';

/**
 * The API reports null once the outstanding code is no longer usable (past
 * its 24 hours, or burned after too many attempts), while still requiring a
 * code — so null with `setupCodeRequired` means expired, not absent.
 */
function setupCodeExpired(auth: AuthStatus | null): boolean {
  if (auth?.setupCodeRequired !== true) return false;
  return auth.setupCodeExpiresAt === null || auth.setupCodeExpiresAt <= Date.now();
}

function AuthBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark className="h-6" />
      <div>
        <div className="text-sm font-semibold tracking-tight text-ink">Easy DevOps</div>
        {!compact && <div className="text-2xs text-faint">Server control plane</div>}
      </div>
    </div>
  );
}

function AuthLayout({ children }: { children: ReactNode }) {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="relative flex min-h-full flex-col overflow-hidden bg-canvas px-4 py-8 sm:py-12">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute -top-48 left-1/2 h-[420px] w-[760px] -translate-x-1/2 rounded-full bg-accent-soft blur-3xl" />
        <div className="absolute -bottom-56 right-[-120px] h-[380px] w-[520px] rounded-full bg-info-soft blur-3xl" />
      </div>

      <div className="relative my-auto grid w-full max-w-4xl self-center overflow-hidden rounded-xl border border-line bg-surface shadow-card lg:grid-cols-[1.02fr_1fr]">
        <aside className="hidden flex-col justify-between gap-8 border-r border-line bg-raised/40 p-8 lg:flex">
          <AuthBrand />

          <div>
            <h2 className="max-w-sm text-2xl font-semibold leading-snug tracking-tight text-ink">
              nginx, certificates and processes — one calm console.
            </h2>
            <ul className="mt-6 space-y-3">
              {HIGHLIGHTS.map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-sm text-muted">
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
                    <Check className="size-2.5" aria-hidden="true" />
                  </span>
                  {line}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center gap-2 text-2xs text-faint">
            <Lock className="size-3.5" aria-hidden="true" />
            Runs on this server. Nothing leaves it.
          </div>
        </aside>

        <section className="relative p-6 sm:p-8">
          <div className="mb-6 flex items-start justify-between gap-4 lg:justify-end">
            <div className="lg:hidden">
              <AuthBrand compact />
            </div>
            <IconButton
              label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? (
                <Sun className="size-4.5" aria-hidden="true" />
              ) : (
                <Moon className="size-4.5" aria-hidden="true" />
              )}
            </IconButton>
          </div>

          {children}
        </section>
      </div>

      <footer className="relative py-4 text-center text-2xs text-faint">
        © {currentYear()} Easy DevOps · provided by{' '}
        <a
          href="https://devxor.team"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
        >
          DevXor Team
        </a>
      </footer>
    </div>
  );
}

function PasswordToggle({
  show,
  onToggle,
}: {
  show: boolean;
  onToggle: () => void;
}) {
  return (
    <IconButton
      label={show ? 'Hide password' : 'Show password'}
      size="sm"
      onClick={onToggle}
      className="text-faint hover:text-ink"
    >
      {show ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
    </IconButton>
  );
}

function ServerError({
  error,
  cooldown = 0,
}: {
  error: ApiError | null;
  cooldown?: number;
}) {
  if (!error) return null;
  const hint = typeof error.payload.hint === 'string' ? error.payload.hint : undefined;
  const retry = retryAfterSeconds(error);
  const wait = cooldown > 0 ? cooldown : retry;
  return (
    <InlineAlert
      tone="danger"
      title={retry === null ? error.message : 'Too many attempts'}
      className="mb-4"
    >
      {hint ??
        (wait === null
          ? undefined
          : cooldown > 0
            ? `Try again in ${waitLabel(wait)}.`
            : 'You can try again now.')}
    </InlineAlert>
  );
}

/** The wait the server asked for, when this was a rate-limit answer. */
function retryAfterSeconds(error: ApiError | null): number | null {
  if (error?.status !== 429) return null;
  const value = error.payload.retryAfterSeconds;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.ceil(value);
}

function waitLabel(seconds: number): string {
  if (seconds >= 120) return `${Math.ceil(seconds / 60)} minutes`;
  if (seconds >= 60) return '1 minute';
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/** Counts down the server's wait so the form cannot be retried too early. */
function useCooldown(): { remaining: number; start: (error: ApiError | null) => void } {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (remaining <= 0) return;
    const id = window.setTimeout(() => setRemaining((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearTimeout(id);
  }, [remaining]);

  const start = (error: ApiError | null) => {
    const seconds = retryAfterSeconds(error);
    if (seconds !== null) setRemaining(seconds);
  };

  return { remaining, start };
}

function LoginForm() {
  const { login, retryBoot, sessionMessage } = useAuth();
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const cooldown = useCooldown();
  const remaining = cooldown.remaining;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (remaining > 0) return;
    if (!password) {
      setFieldError('Enter your password.');
      return;
    }
    setFieldError(null);
    setError(null);
    setSubmitting(true);
    try {
      await login(password);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.payload.needsSetup) {
        await retryBoot();
        return;
      }
      if (apiError?.status === 409) {
        await retryBoot();
        return;
      }
      if (apiError?.status === 429) cooldown.start(apiError);
      setError(apiError);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-sm">
      <div className="mb-6">
        <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.14em] text-faint">
          Dashboard
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Welcome back</h1>
        <p className="mt-1 text-sm text-muted">Sign in to manage this server.</p>
      </div>

      {sessionMessage && (
        <InlineAlert tone="info" title="You were signed out" className="mb-4">
          {sessionMessage}
        </InlineAlert>
      )}

      <ServerError error={error} cooldown={remaining} />

      <form onSubmit={submit} noValidate>
        <TextInput
          label="Password"
          type={show ? 'text' : 'password'}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (fieldError) setFieldError(null);
          }}
          error={fieldError}
          autoComplete="current-password"
          autoFocus
          trailing={<PasswordToggle show={show} onToggle={() => setShow((value) => !value)} />}
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={submitting}
          disabled={remaining > 0}
          className="mt-5 w-full"
        >
          {remaining > 0 ? `Try again in ${remaining}s` : 'Sign in'}
          {!submitting && remaining === 0 && (
            <ArrowRight className="size-4" aria-hidden="true" />
          )}
        </Button>
      </form>
    </div>
  );
}

function SetupForm() {
  const { auth, setup, retryBoot } = useAuth();
  const minLength = auth?.minPasswordLength ?? 8;
  const canGoPasswordless = auth?.canUseNoPassword === true;
  const needsCode = auth?.setupCodeRequired === true;
  const codeExpired = setupCodeExpired(auth);

  const [choice, setChoice] = useState<'password' | 'none'>('password');
  const [setupCode, setSetupCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<{ code?: string; password?: string; confirm?: string }>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const cooldown = useCooldown();
  const remaining = cooldown.remaining;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (remaining > 0) return;

    const next: typeof errors = {};
    if (needsCode && !setupCode.trim()) next.code = 'Enter the setup code shown by the server.';
    if (choice === 'password') {
      if (password.length < minLength) next.password = `Use at least ${minLength} characters.`;
      if (confirm !== password) next.confirm = 'The two passwords do not match.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setError(null);
    setSubmitting(true);
    try {
      if (choice === 'none') {
        await setup({ mode: 'none' });
      } else {
        const code = setupCode.trim();
        await setup({ password, mode: 'password', ...(code ? { setupCode: code } : {}) });
      }
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.status === 409) {
        await retryBoot();
        return;
      }
      // The expiry timestamp already told us this code cannot work. Show that
      // instead of the server's "not valid" — the next step is a new code,
      // not another guess.
      if (apiError?.status === 400 && setupCodeExpired(auth)) {
        setError(null);
        return;
      }
      if (apiError?.status === 429) cooldown.start(apiError);
      setError(apiError);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-sm">
      <div className="mb-6">
        <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.14em] text-faint">
          First run
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Set up this dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          Choose how Easy DevOps protects itself. You can change this later in Settings.
        </p>
      </div>

      <ServerError error={error} cooldown={remaining} />

      <form onSubmit={submit} noValidate>
        <div
          className={cn('grid gap-2', canGoPasswordless && 'grid-cols-2')}
          role="group"
          aria-label="Authentication method"
        >
          <button
            type="button"
            aria-pressed={choice === 'password'}
            onClick={() => setChoice('password')}
            className={cn(
              'rounded-md border p-3 text-left transition-colors duration-[var(--ez-motion-fast)]',
              choice === 'password'
                ? 'border-accent bg-accent-soft'
                : 'border-line bg-raised hover:border-line-strong hover:bg-inset'
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
              <KeyRound className="size-3.5 text-accent-text" aria-hidden="true" />
              Password
            </span>
            <span className="mt-1 block text-2xs text-muted">
              Required to sign in from any browser.
            </span>
          </button>

          {canGoPasswordless && (
            <button
              type="button"
              aria-pressed={choice === 'none'}
              onClick={() => setChoice('none')}
              className={cn(
                'rounded-md border p-3 text-left transition-colors duration-[var(--ez-motion-fast)]',
                choice === 'none'
                  ? 'border-accent bg-accent-soft'
                  : 'border-line bg-raised hover:border-line-strong hover:bg-inset'
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                <ShieldOff className="size-3.5 text-warn" aria-hidden="true" />
                No password
              </span>
              <span className="mt-1 block text-2xs text-muted">
                Only from this machine, while bound to loopback.
              </span>
            </button>
          )}
        </div>

        {needsCode && codeExpired && (
          <InlineAlert tone="warning" title={SETUP_CODE_EXPIRED} className="mt-4">
            Run that on the server, then reload this page to enter the new code.
          </InlineAlert>
        )}

        {needsCode && (
          <TextInput
            className="mt-4"
            label="Setup code"
            value={setupCode}
            onChange={(event) => {
              setSetupCode(event.target.value);
              if (errors.code) setErrors((current) => ({ ...current, code: undefined }));
            }}
            error={errors.code}
            hint="Printed in the terminal where the dashboard was started."
            autoComplete="one-time-code"
          />
        )}

        {choice === 'password' ? (
          <>
            <TextInput
              className="mt-4"
              label="Password"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                if (errors.password) setErrors((current) => ({ ...current, password: undefined }));
              }}
              error={errors.password}
              hint={`At least ${minLength} characters. Stored as a scrypt hash on this server.`}
              autoComplete="new-password"
              autoFocus={!needsCode}
              trailing={<PasswordToggle show={show} onToggle={() => setShow((value) => !value)} />}
            />
            <TextInput
              className="mt-4"
              label="Confirm password"
              type={show ? 'text' : 'password'}
              value={confirm}
              onChange={(event) => {
                setConfirm(event.target.value);
                if (errors.confirm) setErrors((current) => ({ ...current, confirm: undefined }));
              }}
              error={errors.confirm}
              autoComplete="new-password"
            />
          </>
        ) : (
          <InlineAlert tone="warning" title="The dashboard will have no password" className="mt-4">
            Anyone who can reach {auth?.bindAddress ?? 'this machine'} can manage nginx, domains and
            certificates. Keep the dashboard bound to 127.0.0.1. Adding a password later in Settings
            is recommended if you ever expose it.
          </InlineAlert>
        )}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={submitting}
          disabled={remaining > 0}
          className="mt-5 w-full"
        >
          {remaining > 0
            ? `Try again in ${remaining}s`
            : choice === 'password'
              ? 'Save password and sign in'
              : 'Start without a password'}
          {!submitting && remaining === 0 && (
            <ArrowRight className="size-4" aria-hidden="true" />
          )}
        </Button>
      </form>
    </div>
  );
}

function NoAuthPanel() {
  const { auth, retryBoot } = useAuth();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    await retryBoot();
    setBusy(false);
  };

  return (
    <div className="mx-auto w-full max-w-sm">
      <div className="mb-6">
        <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.14em] text-faint">
          No password
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Open the dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          This dashboard is configured without a password. It only accepts requests from{' '}
          <code className="rounded bg-inset px-1 py-0.5 font-mono text-2xs text-ink">
            {auth?.bindAddress ?? 'this machine'}
          </code>
          .
        </p>
      </div>
      <Button variant="primary" size="lg" loading={busy} onClick={open} className="w-full">
        Continue to dashboard
        {!busy && <ArrowRight className="size-4" aria-hidden="true" />}
      </Button>
    </div>
  );
}

export function AuthPage() {
  const { auth } = useAuth();
  useDocumentTitle(
    auth?.needsSetup
      ? 'Set up this dashboard'
      : auth?.authMode === 'none'
        ? 'Open the dashboard'
        : 'Sign in'
  );

  return (
    <AuthLayout>
      {auth?.needsSetup ? (
        <SetupForm />
      ) : auth?.authMode === 'none' ? (
        <NoAuthPanel />
      ) : (
        <LoginForm />
      )}

      <div className="mx-auto mt-6 w-full max-w-sm border-t border-line pt-4 text-2xs text-faint">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Lock className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              Listening on{' '}
              <code className="rounded bg-inset px-1 py-0.5 font-mono text-2xs text-muted">
                {auth?.bindAddress ?? '…'}
              </code>
            </span>
          </span>
          <span>Easy DevOps</span>
        </div>
        {import.meta.env.DEV && MOCK_ENABLED && (
          <p className="mt-2 leading-relaxed">
            Mock mode: any password works — type{' '}
            <code className="rounded bg-inset px-1 py-0.5 font-mono">wrong</code> three times to
            see the rate-limit wait. Add{' '}
            <code className="rounded bg-inset px-1 py-0.5 font-mono">
              ?mock=login|setup|setupcode|setupcode-expired|none
            </code>{' '}
            to the URL to preview each state.
          </p>
        )}
      </div>
    </AuthLayout>
  );
}

