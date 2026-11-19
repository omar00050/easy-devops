import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Switch } from '../ui/Field';

export interface EventToggleItem<Id extends string = string> {
  id: Id;
  label: string;
  description: string;
  enabled: boolean;
}

/**
 * A group of event toggles under one group header. The group checkbox is
 * checked when every event is on, mixed while only some are, and its click
 * switches them all at once.
 */
export function EventToggles<Id extends string>({
  label,
  items,
  onChange,
  onToggleAll,
  disabled,
  children,
}: {
  label: string;
  items: EventToggleItem<Id>[];
  onChange: (id: Id, enabled: boolean) => void;
  onToggleAll: (enabled: boolean) => void;
  disabled?: boolean;
  /** Content for one row, rendered under its switch while the event is on. */
  children?: (item: EventToggleItem<Id>) => ReactNode;
}) {
  const headingId = useId();
  const groupBoxId = useId();
  const boxRef = useRef<HTMLInputElement>(null);

  const all = items.length > 0 && items.every((item) => item.enabled);
  const none = items.every((item) => !item.enabled);

  useEffect(() => {
    if (boxRef.current) boxRef.current.indeterminate = !all && !none;
  }, [all, none]);

  return (
    <div role="group" aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h4 id={headingId} className="text-xs font-medium text-ink">
          {label}
        </h4>
        <label
          htmlFor={groupBoxId}
          className="inline-flex cursor-pointer items-center gap-2 text-2xs text-muted"
        >
          <input
            id={groupBoxId}
            ref={boxRef}
            type="checkbox"
            checked={all}
            disabled={disabled || items.length === 0}
            onChange={() => onToggleAll(!all)}
            className="size-3.5 shrink-0 cursor-pointer rounded border-line accent-[var(--ez-accent)] disabled:cursor-not-allowed"
          />
          <span className="select-none">{all ? 'All on' : none ? 'All off' : 'Mixed'}</span>
        </label>
      </div>

      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.id} className="rounded-md border border-line bg-raised/30 p-3.5">
            <Switch
              checked={item.enabled}
              onChange={(enabled) => onChange(item.id, enabled)}
              label={item.label}
              description={item.description}
              disabled={disabled}
            />
            {item.enabled && children?.(item)}
          </div>
        ))}
      </div>
    </div>
  );
}
