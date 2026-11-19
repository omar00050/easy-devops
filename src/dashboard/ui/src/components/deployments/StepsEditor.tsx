import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type ScreenReaderInstructions,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DeployStepKind } from '../../lib/types';
import {
  MAX_DEPLOY_STEPS,
  STEP_KINDS,
  stepOrderWarnings,
  type StepDraft,
} from '../../lib/deployments';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/Badge';
import { Button, IconButton } from '../ui/Button';
import { Select, Switch, TextInput } from '../ui/Field';
import { InlineAlert } from '../ui/States';

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'To pick up a step, press Space or Enter. Use the arrow keys to move it, Space or Enter to drop it, Escape to cancel.',
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

function stepName(step: StepDraft): string {
  return step.run.trim() || 'new step';
}

function kindLabel(kind: DeployStepKind): string {
  return STEP_KINDS.find((item) => item.value === kind)?.label ?? kind;
}

/** One row in the sortable list. Only the handle starts a pointer or touch drag. */
function StepRow({
  step,
  index,
  total,
  error,
  disabled,
  reducedMotion,
  registerRow,
  registerHandle,
  onChange,
  onRemove,
  onMove,
}: {
  step: StepDraft;
  index: number;
  total: number;
  error: string | null;
  disabled?: boolean;
  reducedMotion: boolean;
  registerRow: (key: string, node: HTMLLIElement | null) => void;
  registerHandle: (key: string, node: HTMLButtonElement | null) => void;
  onChange: (patch: Partial<StepDraft>) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: step.key, disabled });

  const enabled = step.enabled !== false;
  const name = stepName(step);

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        registerRow(step.key, node);
      }}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: reducedMotion ? undefined : transition,
      }}
      tabIndex={-1}
      className={cn(
        'rounded-md border p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        isDragging
          ? 'border-dashed border-line bg-raised/20'
          : 'border-line bg-raised/40'
      )}
    >
      <div className={cn('flex items-start gap-2', isDragging && 'invisible')}>
        <button
          ref={(node) => {
            setActivatorNodeRef(node);
            registerHandle(step.key, node);
          }}
          type="button"
          aria-label={`Reorder step ${index + 1}: ${name}`}
          title="Drag to reorder"
          disabled={disabled}
          className="mt-2 inline-flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded-sm text-faint transition-colors hover:bg-inset hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:cursor-grabbing disabled:cursor-not-allowed"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>

        <div className="min-w-0 flex-1 space-y-2">
          <div className={cn('flex flex-wrap items-center gap-2', !enabled && 'opacity-60')}>
            <span className="text-2xs font-medium text-faint">Step {index + 1}</span>
            <span className="min-w-0 truncate font-mono text-2xs text-muted">
              {step.run.trim() || 'New step'}
            </span>
            {!enabled && <Badge tone="neutral">Skipped</Badge>}
          </div>

          <div className={cn(!enabled && 'opacity-60')}>
            <TextInput
              aria-label={`Step ${index + 1} command`}
              value={step.run}
              onChange={(event) => onChange({ run: event.target.value })}
              error={error}
              placeholder="npm ci"
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
              disabled={disabled}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
            <Select
              aria-label={`Step ${index + 1} kind`}
              value={step.kind}
              onChange={(event) => onChange({ kind: event.target.value as DeployStepKind })}
              className={cn('w-28 shrink-0', !enabled && 'opacity-60')}
              disabled={disabled}
            >
              {STEP_KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </Select>

            <Switch
              label={enabled ? 'On' : 'Off'}
              ariaLabel={`Step ${index + 1} (${name}) ${enabled ? 'enabled' : 'disabled'}`}
              checked={enabled}
              onChange={(next) => onChange({ enabled: next })}
              disabled={disabled}
              className="min-w-36 flex-1 items-center [&>div>div]:text-xs"
            />

            <div className={cn('flex shrink-0 items-center gap-1', !enabled && 'opacity-60')}>
              <IconButton
                label={`Move step ${index + 1} up`}
                size="sm"
                onClick={() => onMove(index - 1)}
                disabled={disabled || index === 0}
              >
                <ArrowUp className="size-4" aria-hidden="true" />
              </IconButton>
              <IconButton
                label={`Move step ${index + 1} down`}
                size="sm"
                onClick={() => onMove(index + 1)}
                disabled={disabled || index === total - 1}
              >
                <ArrowDown className="size-4" aria-hidden="true" />
              </IconButton>
              <IconButton
                label={`Remove step ${index + 1}`}
                size="sm"
                variant="dangerGhost"
                onClick={onRemove}
                disabled={disabled}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </IconButton>
            </div>
          </div>

          {step.kind === 'migrate' && (
            <p className={cn('text-2xs text-warn', !enabled && 'opacity-60')}>
              Forward-only: a rollback does not undo a migration that has already run.
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

/** The lifted copy that follows the pointer; it never contains form controls. */
function StepPreview({
  step,
  index,
  reducedMotion,
}: {
  step: StepDraft;
  index: number;
  reducedMotion: boolean;
}) {
  const enabled = step.enabled !== false;
  return (
    <div
      className="cursor-grabbing rounded-md border border-line-strong bg-surface p-3 shadow-pop"
      style={{ transform: reducedMotion ? undefined : 'scale(1.02)' }}
    >
      <div className="flex items-start gap-2">
        <span className="mt-2 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-faint">
          <GripVertical className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs font-medium text-faint">Step {index + 1}</span>
            <span className="min-w-0 truncate font-mono text-2xs text-muted">
              {step.run.trim() || 'New step'}
            </span>
            {!enabled && <Badge tone="neutral">Skipped</Badge>}
          </div>
          <div className="truncate rounded-md border border-line bg-canvas px-3 py-1.5 font-mono text-sm text-ink">
            {step.run.trim() || 'npm ci'}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
            <span>{kindLabel(step.kind)}</span>
            <span>{enabled ? 'On' : 'Off'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The ordered steps list: command, kind, on/off, drag handle, keyboard move
 * buttons and Remove. The handle is the only drag activator, so every field in
 * the row stays usable; the labelled move buttons stay the accessible path and
 * focus follows the moved row.
 */
export function StepsEditor({
  steps,
  onChange,
  errors,
  apiWarnings = [],
  disabled,
}: {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  /** One message per row, aligned with `steps`; null when the row is valid. */
  errors?: Array<string | null>;
  /** Order warnings already returned by the API, shown beside the local ones. */
  apiWarnings?: string[];
  disabled?: boolean;
}) {
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [focusHandleKey, setFocusHandleKey] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const reducedMotion = usePrefersReducedMotion();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    if (!focusKey) return;
    rowRefs.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey, steps]);

  // After a drop, the handle (not the row) takes focus back, so Space/Enter
  // picks the step up again.
  useEffect(() => {
    if (!focusHandleKey) return;
    handleRefs.current.get(focusHandleKey)?.focus();
    setFocusHandleKey(null);
  }, [focusHandleKey, steps]);

  // Escape belongs to the drag while one is running: the sensors check
  // `defaultPrevented` nowhere, so the flag only tells the modal to stay open.
  useEffect(() => {
    if (!activeId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeId]);

  const atLimit = steps.length >= MAX_DEPLOY_STEPS;

  const nameOf = (id: string | number) => {
    const step = stepsRef.current.find((item) => item.key === id);
    return step ? stepName(step) : 'this step';
  };
  const positionOf = (id: string | number) => {
    const index = stepsRef.current.findIndex((item) => item.key === id);
    return index === -1 ? 1 : index + 1;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up step ${nameOf(active.id)}. It is in position ${positionOf(active.id)} of ${stepsRef.current.length}.`,
    onDragOver: ({ active, over }) =>
      `Step ${nameOf(active.id)} moved to position ${positionOf(over?.id ?? active.id)} of ${stepsRef.current.length}.`,
    onDragEnd: ({ active, over }) =>
      `Step ${nameOf(active.id)} dropped at position ${positionOf(over?.id ?? active.id)} of ${stepsRef.current.length}.`,
    onDragCancel: ({ active }) =>
      `Reordering cancelled. Step ${nameOf(active.id)} returned to position ${positionOf(active.id)} of ${stepsRef.current.length}.`,
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || from === to) return;
    const next = [...steps];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setFocusKey(moved.key);
    setAnnouncement(`Step ${from + 1} moved to position ${to + 1}.`);
    onChange(next);
  };

  const update = (index: number, patch: Partial<StepDraft>) => {
    onChange(steps.map((step, at) => (at === index ? { ...step, ...patch } : step)));
  };

  const remove = (index: number) => {
    setAnnouncement(`Step ${index + 1} removed.`);
    onChange(steps.filter((_, at) => at !== index));
  };

  const add = () => {
    if (atLimit) return;
    onChange([
      ...steps,
      { key: `step-${Date.now()}-${steps.length}`, run: '', kind: 'custom', enabled: true },
    ]);
  };

  const onDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const from = steps.findIndex((step) => step.key === active.id);
    const to = steps.findIndex((step) => step.key === over.id);
    if (from === -1 || to === -1 || from === to) return;
    setFocusHandleKey(String(active.id));
    setAnnouncement(`Step ${from + 1} moved to position ${to + 1}.`);
    onChange(arrayMove(steps, from, to));
  };

  const onDragCancel = () => setActiveId(null);

  const localWarnings = stepOrderWarnings(steps);
  const warnings = [...localWarnings, ...apiWarnings.filter((warning) => !localWarnings.includes(warning))];
  const activeIndex = steps.findIndex((step) => step.key === activeId);
  const activeStep = activeIndex === -1 ? null : steps[activeIndex];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-xs font-medium text-ink">Steps</div>
        <span className="text-2xs text-faint">
          {steps.length}/{MAX_DEPLOY_STEPS} steps
          {atLimit ? ' — remove one to add another.' : ''}
        </span>
      </div>

      {steps.length === 0 ? (
        <p className="rounded-md border border-dashed border-line bg-raised/30 px-3 py-4 text-xs text-muted">
          No steps. Only the start command runs; nothing is installed, built or migrated.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <SortableContext
            items={steps.map((step) => step.key)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="space-y-2">
              {steps.map((step, index) => (
                <StepRow
                  key={step.key}
                  step={step}
                  index={index}
                  total={steps.length}
                  error={errors?.[index] ?? null}
                  disabled={disabled}
                  reducedMotion={reducedMotion}
                  registerRow={(key, node) => {
                    if (node) rowRefs.current.set(key, node);
                    else rowRefs.current.delete(key);
                  }}
                  registerHandle={(key, node) => {
                    if (node) handleRefs.current.set(key, node);
                    else handleRefs.current.delete(key);
                  }}
                  onChange={(patch) => update(index, patch)}
                  onRemove={() => remove(index)}
                  onMove={(to) => move(index, to)}
                />
              ))}
            </ul>
          </SortableContext>
          {createPortal(
            <DragOverlay dropAnimation={reducedMotion ? null : undefined}>
              {activeStep && (
                <StepPreview step={activeStep} index={activeIndex} reducedMotion={reducedMotion} />
              )}
            </DragOverlay>,
            document.body
          )}
        </DndContext>
      )}

      {warnings.map((warning) => (
        <InlineAlert key={warning} tone="warning">
          {warning}
        </InlineAlert>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          icon={<Plus className="size-3.5" aria-hidden="true" />}
          onClick={add}
          disabled={disabled || atLimit}
          title={atLimit ? `At most ${MAX_DEPLOY_STEPS} steps. Remove one to add another.` : undefined}
        >
          Add step
        </Button>
        {atLimit && (
          <span className="text-2xs text-faint">At most {MAX_DEPLOY_STEPS} steps.</span>
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
