import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../../lib/cn';

const CONTROL =
  'w-full rounded-md border border-line bg-canvas px-3 text-sm text-ink placeholder:text-faint transition-colors duration-[var(--ez-motion-fast)] hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60';

const BAD = 'border-bad/60 hover:border-bad focus:border-bad focus:ring-bad/25';

export function LabelText({
  htmlFor,
  children,
  optional,
}: {
  htmlFor?: string;
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline gap-2 text-xs font-medium text-muted">
      <span>{children}</span>
      {optional && <span className="text-2xs font-normal text-faint">Optional</span>}
    </label>
  );
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1.5 text-xs text-bad" role="alert">
      {children}
    </p>
  );
}

export function FieldHint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1.5 text-xs text-faint">
      {children}
    </p>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  /** Rendered inside the field on the right, e.g. a show-password toggle. */
  trailing?: ReactNode;
}

export function TextInput({
  label,
  hint,
  error,
  optional,
  trailing,
  id: idProp,
  className,
  ...rest
}: TextInputProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className={className}>
      {label && <LabelText htmlFor={id} optional={optional}>{label}</LabelText>}
      <div className="relative">
        <input
          id={id}
          className={cn(CONTROL, 'h-9', Boolean(trailing) && 'pr-10', error && BAD)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          {...rest}
        />
        {trailing && (
          <div className="absolute inset-y-0 right-0 flex items-center pr-1.5">{trailing}</div>
        )}
      </div>
      {error ? <FieldError id={errorId}>{error}</FieldError> : hint ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
    </div>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
}

export function TextArea({
  label,
  hint,
  error,
  optional,
  id: idProp,
  className,
  ...rest
}: TextAreaProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className={className}>
      {label && <LabelText htmlFor={id} optional={optional}>{label}</LabelText>}
      <textarea
        id={id}
        className={cn(CONTROL, 'min-h-24 py-2 leading-relaxed', error && BAD)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...rest}
      />
      {error ? <FieldError id={errorId}>{error}</FieldError> : hint ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
    </div>
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
}

export function Select({
  label,
  hint,
  error,
  optional,
  id: idProp,
  className,
  children,
  ...rest
}: SelectProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className={className}>
      {label && <LabelText htmlFor={id} optional={optional}>{label}</LabelText>}
      <select
        id={id}
        className={cn(CONTROL, 'h-9 cursor-pointer pr-8', error && BAD)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...rest}
      >
        {children}
      </select>
      {error ? <FieldError id={errorId}>{error}</FieldError> : hint ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
    </div>
  );
}

export function Checkbox({
  label,
  hint,
  checked,
  onChange,
  disabled,
  className,
  id: idProp,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-line accent-[var(--ez-accent)]"
      />
      <div className="min-w-0">
        <label htmlFor={id} className={cn('cursor-pointer text-sm text-ink', disabled && 'cursor-not-allowed opacity-60')}>
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
      </div>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <div id={id} className="text-sm text-ink">
          {label}
        </div>
        {description && <div className="mt-0.5 text-xs text-faint">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-pill border transition-colors duration-[var(--ez-motion-fast)] disabled:opacity-50',
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-inset',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
        )}
      >
        <span
          className={cn(
            'inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform duration-[var(--ez-motion-fast)]',
            checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
          )}
        />
      </button>
    </div>
  );
}

export function FormGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-4 sm:grid-cols-2', className)}>{children}</div>;
}
