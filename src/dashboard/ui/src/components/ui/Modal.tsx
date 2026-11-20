import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { IconButton } from './Button';
import { isTopDialog, useDialogStack } from './dialogStack';

const SIZES = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  /** Blocks ESC and backdrop dismissal while a request is in flight. */
  preventClose?: boolean;
  bodyClassName?: string;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  preventClose = false,
  bodyClassName,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  // Only the topmost dialog in the document handles Escape and Tab.
  const { id: dialogId, isTop } = useDialogStack(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Refs keep the focus/keydown effect from re-running (and re-stealing focus)
  // every time the caller re-renders with a new callback identity.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const preventCloseRef = useRef(preventClose);
  preventCloseRef.current = preventClose;

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel;
      first.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      // A confirm or a second modal above this one owns the keyboard.
      if (!isTopDialog(dialogId)) return;
      if (event.key === 'Escape' && !preventCloseRef.current) {
        // A widget inside the dialog can own Escape (a live drag cancels with
        // it) by marking the event handled; the dialog then stays open.
        if (event.defaultPrevented) return;
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        // `inert` content (a collapsed Collapsible) stays in the DOM but must
        // not take the wrap-around focus.
        (element) => element.offsetParent !== null && !element.closest('[inert]')
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [open, dialogId]);

  if (!open) return null;

  return createPortal(
    <div
      className="fade-enter fixed inset-0 z-[60] flex items-end justify-center bg-[var(--ez-overlay)] p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget || !isTop) return;
        if (!preventClose) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={isTop || undefined}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'panel-enter flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl border border-line bg-surface shadow-pop outline-none sm:rounded-xl',
          SIZES[size]
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-sm text-muted">
                {description}
              </p>
            )}
          </div>
          <IconButton
            label="Close"
            size="sm"
            onClick={onClose}
            disabled={preventClose}
            className="-mr-1 -mt-1"
          >
            <X className="size-4" aria-hidden="true" />
          </IconButton>
        </div>

        {children && (
          <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>
            {children}
          </div>
        )}

        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-raised/40 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
