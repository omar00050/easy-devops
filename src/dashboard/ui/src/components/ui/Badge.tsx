import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'info';

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-inset text-muted',
  accent: 'bg-accent-soft text-accent-text',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
};

const DOT_TONES: Record<Tone, string> = {
  neutral: 'bg-faint',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  info: 'bg-info',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  dot = false,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-2xs font-medium tracking-wide',
        BADGE_TONES[tone],
        className
      )}
    >
      {dot && <span className={cn('size-1.5 rounded-full', DOT_TONES[tone])} aria-hidden="true" />}
      {children}
    </span>
  );
}

export function StatusDot({
  tone = 'ok',
  pulse = false,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        DOT_TONES[tone],
        pulse && 'live-dot',
        className
      )}
      aria-hidden="true"
    />
  );
}
