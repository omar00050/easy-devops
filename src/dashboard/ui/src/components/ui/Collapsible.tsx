import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * The one collapsible section: a header button and a body that opens and
 * closes with a height animation.
 *
 * The height is animated without measuring anything in JS: the wrapper is a
 * grid whose single row goes from `0fr` to `1fr`, and the body child is
 * `min-height: 0; overflow: hidden`, so the row clips the content while the
 * track grows. `prefers-reduced-motion` removes the transition (the global
 * rule in `styles/global.css` and `motion-reduce:transition-none` here).
 *
 * The body stays mounted so form state survives a collapse. Collapsed content
 * is `inert` and `aria-hidden`, so it is neither focusable nor announced.
 *
 * Controlled by design: forms expand a section when validation finds an error
 * in it, so the owner keeps the open state.
 */
export interface CollapsibleProps {
  /** Visible header title. */
  title: ReactNode;
  /** One line under the title, in muted text. */
  description?: ReactNode;
  /** Decorative leading element: an icon tile or a status marker. */
  icon?: ReactNode;
  /** Right-aligned slot before the chevron (a badge, a count). */
  headerExtra?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stable id source for the header/body pair. Defaults to `useId()`. */
  id?: string;
  /** Extra classes on the outer element (borders, radius, background). */
  className?: string;
  /** Extra classes on the header button, normally only padding. */
  headerClassName?: string;
  /** Extra classes inside the body, normally the padding around children. */
  contentClassName?: string;
  children?: ReactNode;
}

export function Collapsible({
  title,
  description,
  icon,
  headerExtra,
  open,
  onOpenChange,
  id,
  className,
  headerClassName,
  contentClassName,
  children,
}: CollapsibleProps) {
  const generated = useId().replace(/:/g, '');
  const contentId = id ? `section-${id}` : `collapsible-${generated}`;
  const headerId = `${contentId}-header`;

  const headerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(open);

  // A section can close while one of its fields has focus (a validation error
  // in another section expands that one instead). `inert` drops the focus, so
  // hand it back to the header instead of losing it to the document body.
  useEffect(() => {
    if (wasOpen.current && !open) {
      const content = contentRef.current;
      const active = document.activeElement;
      if (content && active instanceof HTMLElement && content.contains(active)) {
        headerRef.current?.focus();
      }
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <div className={className}>
      <h3>
        <button
          ref={headerRef}
          type="button"
          id={headerId}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => onOpenChange(!open)}
          className={cn(
            'group flex w-full items-center gap-3 text-left transition-colors duration-[var(--ez-motion-fast)] hover:bg-raised/50',
            headerClassName
          )}
        >
          {icon}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink">{title}</span>
            {description && (
              <span className="mt-0.5 block break-words text-xs text-muted">{description}</span>
            )}
          </span>
          {headerExtra && <span className="shrink-0">{headerExtra}</span>}
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-faint transition-transform duration-[var(--ez-motion-base)] ease-[var(--ez-ease-out)] motion-reduce:transition-none',
              open && 'rotate-180'
            )}
            aria-hidden="true"
          />
        </button>
      </h3>

      <div
        ref={contentRef}
        id={contentId}
        role="region"
        aria-labelledby={headerId}
        aria-hidden={open ? undefined : true}
        inert={!open}
        className={cn(
          'grid transition-[grid-template-rows] duration-[var(--ez-motion-base)] ease-[var(--ez-ease-out)] motion-reduce:transition-none',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className={contentClassName}>{children}</div>
        </div>
      </div>
    </div>
  );
}
