import { useRef, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';
import { DEPLOY_PRESETS, presetSteps, type DeployPreset } from '../../lib/deployments';
import type { DeployStep } from '../../lib/types';
import { InlineAlert } from '../ui/States';

export const CUSTOM_PRESET_ID = 'custom';

interface CommandLike {
  run: string;
  kind: string;
  enabled?: boolean;
}

/** "npm ci → npm run build → npm start", from the preset's real commands. */
export function presetSummary(preset: DeployPreset): string {
  const steps = preset.steps.filter((step) => step.enabled !== false).map((step) => step.run);
  return [...steps, preset.start].join(' → ');
}

export function presetLabel(id: string | null): string | null {
  if (!id) return null;
  if (id === CUSTOM_PRESET_ID) return 'Custom';
  return DEPLOY_PRESETS.find((preset) => preset.id === id)?.label ?? null;
}

/** What choosing a card writes into the form. */
export function presetCommands(id: string): { start: string; steps: DeployStep[] } {
  if (id === CUSTOM_PRESET_ID) return { start: '', steps: [] };
  const preset = DEPLOY_PRESETS.find((item) => item.id === id);
  return preset ? { start: preset.start, steps: presetSteps(preset) } : { start: '', steps: [] };
}

export function sameCommands(
  steps: CommandLike[],
  start: string,
  otherSteps: CommandLike[],
  otherStart: string
): boolean {
  if (steps.length !== otherSteps.length) return false;
  if (start.trim() !== otherStart.trim()) return false;
  return steps.every(
    (step, index) =>
      step.run.trim() === otherSteps[index].run.trim() &&
      step.kind === otherSteps[index].kind &&
      (step.enabled !== false) === (otherSteps[index].enabled !== false)
  );
}

/**
 * The preset whose commands match exactly, `custom` when both the steps and the
 * start command are empty, or null when nothing matches.
 */
export function matchPreset(steps: CommandLike[], start: string): string | null {
  for (const preset of DEPLOY_PRESETS) {
    const commands = presetCommands(preset.id);
    if (sameCommands(steps, start, commands.steps, commands.start)) return preset.id;
  }
  return steps.length === 0 ? CUSTOM_PRESET_ID : null;
}

function initials(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

interface CardOption {
  id: string;
  name: string;
  summary: string;
}

/**
 * Preset cards under the Node.js runtime card. A radiogroup with roving
 * tabindex: only the selected card (or the first) is tabbable, arrow keys move
 * and select, Space/Enter selects. Choosing a card is the caller's call: this
 * component never asks, it only reports.
 */
export function PresetCards({
  value,
  modifiedFrom,
  onSelect,
  onReset,
  disabled,
}: {
  /** The selected preset id, `custom`, or null when nothing matches. */
  value: string | null;
  /** The preset name when the commands no longer match it. */
  modifiedFrom: string | null;
  onSelect: (id: string) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());

  const options: CardOption[] = [
    ...DEPLOY_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.label,
      summary: presetSummary(preset),
    })),
    { id: CUSTOM_PRESET_ID, name: 'Custom', summary: 'Start from empty steps' },
  ];

  const tabbableId = value ?? options[0].id;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const current = Math.max(
      0,
      options.findIndex((option) => option.id === value)
    );
    let next: number | null = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      next = (current + 1) % options.length;
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      next = (current - 1 + options.length) % options.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = options.length - 1;
    }
    if (next === null) return;
    event.preventDefault();
    const option = options[next];
    onSelect(option.id);
    cardRefs.current.get(option.id)?.focus();
  };

  return (
    <div className="space-y-3">
      <div
        role="radiogroup"
        aria-label="Preset"
        onKeyDown={onKeyDown}
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
      >
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <button
              key={option.id}
              ref={(node) => {
                if (node) cardRefs.current.set(option.id, node);
                else cardRefs.current.delete(option.id);
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || option.id === tabbableId ? 0 : -1}
              disabled={disabled}
              onClick={() => onSelect(option.id)}
              className={cn(
                'relative flex items-start gap-2.5 rounded-lg border px-3 py-3 text-left transition-colors duration-[var(--ez-motion-fast)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                selected ? 'border-accent bg-accent-soft' : 'border-line bg-raised/40',
                !selected && !disabled && 'hover:border-line-strong hover:bg-raised',
                disabled && 'cursor-not-allowed opacity-60'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md border text-2xs font-semibold',
                  selected
                    ? 'border-accent/40 bg-canvas text-accent-text'
                    : 'border-line bg-canvas text-muted'
                )}
                aria-hidden="true"
              >
                {initials(option.name)}
              </span>
              <span className="min-w-0 flex-1 pr-4">
                <span className="block truncate text-xs font-medium text-ink">{option.name}</span>
                <span className="mt-0.5 block truncate text-2xs text-muted" title={option.summary}>
                  {option.summary}
                </span>
              </span>
              {selected && (
                <span className="absolute right-2 top-2 inline-flex size-4 items-center justify-center rounded-full bg-accent text-accent-ink">
                  <Check className="size-2.5" aria-hidden="true" />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {modifiedFrom && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-faint">
          <span>Modified from {modifiedFrom}</span>
          <button
            type="button"
            onClick={onReset}
            disabled={disabled}
            className="rounded-sm font-medium text-accent-text underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:text-faint disabled:opacity-60"
          >
            Reset to preset
          </button>
        </div>
      )}

      <InlineAlert tone="info">
        Check your project&apos;s real start and build commands before relying on a preset; not
        every project uses the defaults.
      </InlineAlert>
    </div>
  );
}
