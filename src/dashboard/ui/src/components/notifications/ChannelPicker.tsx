import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/Badge';
import { ChannelTypeBadge, channelTypeLabel } from './ChannelTypeBadge';

/** One channel the picker can offer. `lastTest` is optional: the API may not report it. */
export interface ChannelPickerChannel {
  id: string;
  name: string;
  type: string;
  lastTest?: 'passed' | 'failed' | null;
}

const TEXT_BUTTON =
  'rounded-sm font-medium text-accent-text underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:text-faint disabled:no-underline disabled:opacity-60';

function TestState({ lastTest }: { lastTest?: 'passed' | 'failed' | null }) {
  if (lastTest === 'passed') return <Badge tone="ok">Test passed</Badge>;
  if (lastTest === 'failed') return <Badge tone="bad">Test failed</Badge>;
  // The real API does not report a test state at all; only a known `null`
  // means "not tested yet".
  if (lastTest === null) return <span className="text-2xs text-faint">Not tested</span>;
  return null;
}

/**
 * The one channel picker: a labelled group of selectable channel cards with a
 * count, Select all/Clear, and a search box once the list gets long. It only
 * changes presentation; the ids it reports are the values the callers already
 * send to the API.
 */
export function ChannelPicker({
  channels,
  value,
  onChange,
  disabled,
  disabledIds,
  label,
  emptyHref,
  compact,
}: {
  channels: ChannelPickerChannel[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /** Channels the server does not allow, with the reason to show. */
  disabledIds?: Record<string, string>;
  label: string;
  /** Where "Add a channel" goes, normally the Notifications page. */
  emptyHref: string;
  compact?: boolean;
}) {
  const labelId = useId();
  const searchId = useId();
  const [query, setQuery] = useState('');

  if (channels.length === 0) {
    return (
      <div role="group" aria-labelledby={labelId} className="space-y-2">
        <span id={labelId} className="block text-xs font-medium text-ink">
          {label}
        </span>
        <div className="rounded-md border border-dashed border-line bg-raised/30 px-3 py-4 text-xs text-muted">
          No notification channels yet.{' '}
          <Link
            to={emptyHref}
            className="font-medium text-accent-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            Add a channel
          </Link>
        </div>
      </div>
    );
  }

  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const filtered = needle
    ? channels.filter((channel) => {
        return (
          channel.name.toLowerCase().includes(needle) ||
          channel.type.toLowerCase().includes(needle) ||
          channelTypeLabel(channel.type).toLowerCase().includes(needle)
        );
      })
    : channels;

  const selectable = channels.filter((channel) => !disabledIds?.[channel.id]);
  const selectedCount = channels.filter((channel) => value.includes(channel.id)).length;
  const allSelected = selectable.length > 0 && selectable.every((channel) => value.includes(channel.id));

  const toggle = (id: string, checked: boolean) => {
    onChange(checked ? Array.from(new Set([...value, id])) : value.filter((item) => item !== id));
  };

  const selectAll = () => {
    onChange(Array.from(new Set([...value, ...selectable.map((channel) => channel.id)])));
  };

  return (
    <div role="group" aria-labelledby={labelId} className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span id={labelId} className="text-xs font-medium text-ink">
          {label}
        </span>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs">
          <span className="text-faint" aria-live="polite">
            {selectedCount} of {channels.length} selected
          </span>
          <button
            type="button"
            className={TEXT_BUTTON}
            onClick={selectAll}
            disabled={disabled || allSelected}
          >
            Select all
          </button>
          <button
            type="button"
            className={TEXT_BUTTON}
            onClick={() => onChange([])}
            disabled={disabled || selectedCount === 0}
          >
            Clear
          </button>
        </div>
      </div>

      {channels.length > 6 && (
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // The picker can sit inside a form; Enter must not submit it.
              if (event.key === 'Enter') event.preventDefault();
            }}
            placeholder="Search channels"
            aria-label="Search channels"
            className="h-8 w-full rounded-md border border-line bg-canvas pl-8 pr-3 text-xs text-ink placeholder:text-faint transition-colors duration-[var(--ez-motion-fast)] hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="rounded-md border border-dashed border-line bg-raised/30 px-3 py-3 text-xs text-muted">
          {`No channels match "${trimmed}"`}
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {filtered.map((channel) => {
            const selected = value.includes(channel.id);
            const reason = disabledIds?.[channel.id];
            const isDisabled = disabled || Boolean(reason);
            return (
              <label
                key={channel.id}
                title={reason}
                className={cn(
                  'relative flex min-w-0 cursor-pointer items-start gap-2.5 rounded-md border px-3 text-left transition-colors duration-[var(--ez-motion-fast)]',
                  compact ? 'py-2' : 'py-2.5',
                  selected ? 'border-accent bg-accent-soft' : 'border-line bg-raised/40',
                  !selected && !isDisabled && 'hover:border-line-strong hover:bg-raised',
                  isDisabled && 'cursor-not-allowed opacity-60',
                  'focus-within:outline-none focus-within:ring-2 focus-within:ring-accent/50'
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={selected}
                  disabled={isDisabled}
                  onChange={(event) => toggle(channel.id, event.target.checked)}
                />
                <span className="min-w-0 flex-1 pr-4 pt-0.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-ink">{channel.name}</span>
                    <ChannelTypeBadge type={channel.type} />
                    <TestState lastTest={channel.lastTest} />
                  </span>
                  {reason && <span className="mt-1 block text-2xs text-faint">{reason}</span>}
                </span>
                {selected && (
                  <span className="absolute right-2 top-2 inline-flex size-4 items-center justify-center rounded-full bg-accent text-accent-ink">
                    <Check className="size-2.5" aria-hidden="true" />
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
