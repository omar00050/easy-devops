import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button, IconButton } from './Button';

export function CopyButton({
  value,
  label = 'Copy',
  withText = false,
  className,
}: {
  value: string;
  label?: string;
  withText?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1600);
  };

  const icon =
    state === 'copied' ? (
      <Check className="size-3.5 text-ok" aria-hidden="true" />
    ) : (
      <Copy className="size-3.5" aria-hidden="true" />
    );
  const text = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label;

  if (withText) {
    return (
      <Button size="sm" variant="secondary" icon={icon} onClick={copy} className={className}>
        <span aria-live="polite">{text}</span>
      </Button>
    );
  }

  return (
    <IconButton
      label={text}
      size="sm"
      variant="ghost"
      onClick={copy}
      className={cn(state === 'copied' && 'text-ok', className)}
    >
      {icon}
    </IconButton>
  );
}
