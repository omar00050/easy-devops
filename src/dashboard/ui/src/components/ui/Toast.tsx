import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  title: string;
  description?: ReactNode;
  tone?: ToastTone;
  durationMs?: number;
}

interface ToastItem extends Required<Pick<ToastOptions, 'title' | 'tone'>> {
  id: string;
  description?: ReactNode;
}

export interface ToastApi {
  push: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
  success: (title: string, description?: ReactNode) => string;
  error: (title: string, description?: ReactNode) => string;
  warning: (title: string, description?: ReactNode) => string;
  info: (title: string, description?: ReactNode) => string;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_STYLES: Record<ToastTone, { icon: LucideIcon; iconClass: string }> = {
  success: { icon: CheckCircle2, iconClass: 'text-ok' },
  error: { icon: AlertCircle, iconClass: 'text-bad' },
  warning: { icon: TriangleAlert, iconClass: 'text-warn' },
  info: { icon: Info, iconClass: 'text-info' },
};

const DEFAULT_DURATION = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = (id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  };

  const push = (options: ToastOptions): string => {
    const id = crypto.randomUUID();
    const item: ToastItem = {
      id,
      title: options.title,
      description: options.description,
      tone: options.tone ?? 'info',
    };
    setItems((current) => {
      const next = [...current, item];
      return next.length > 5 ? next.slice(next.length - 5) : next;
    });
    const timer = setTimeout(() => dismiss(id), options.durationMs ?? DEFAULT_DURATION);
    timers.current.set(id, timer);
    return id;
  };

  const api = useMemo<ToastApi>(
    () => ({
      push,
      dismiss,
      success: (title, description) => push({ title, description, tone: 'success' }),
      error: (title, description) => push({ title, description, tone: 'error' }),
      warning: (title, description) => push({ title, description, tone: 'warning' }),
      info: (title, description) => push({ title, description, tone: 'info' }),
    }),
    // push/dismiss only close over refs and setState, both stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => {
    const currentTimers = timers.current;
    return () => {
      for (const timer of currentTimers.values()) clearTimeout(timer);
      currentTimers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-3 bottom-3 z-[70] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[380px]"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map((item) => {
          const { icon: Icon, iconClass } = TONE_STYLES[item.tone];
          return (
            <div
              key={item.id}
              role={item.tone === 'error' ? 'alert' : 'status'}
              className="toast-enter pointer-events-auto flex w-full items-start gap-3 rounded-md border border-line bg-raised px-3.5 py-3 shadow-pop"
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', iconClass)} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink">{item.title}</div>
                {item.description && (
                  <div className="mt-0.5 break-words text-xs text-muted">{item.description}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label="Dismiss notification"
                className="-mr-1 -mt-1 rounded-sm p-1 text-faint transition-colors hover:bg-inset hover:text-ink"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
