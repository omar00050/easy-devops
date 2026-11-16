import { useEffect, useRef, useState } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button, IconButton } from './Button';
import { useToast } from './Toast';

/**
 * Copies without the Clipboard API. The dashboard is regularly opened over
 * plain HTTP on a LAN address, where `navigator.clipboard` does not exist at
 * all, so the legacy selection + execCommand path is the only option there.
 */
function copyWithSelection(value: string): boolean {
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      ranges.push(selection.getRangeAt(index));
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);

  let copied: boolean;
  try {
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
    active?.focus({ preventScroll: true });
  }
  return copied;
}

async function copyText(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Permission denied or the document lost focus: try the legacy path.
    }
  }
  return copyWithSelection(value);
}

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
  const toast = useToast();

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    const copied = await copyText(value);
    setState(copied ? 'copied' : 'failed');
    if (!copied) {
      toast.error(
        'Could not copy',
        'The browser blocked clipboard access. Select the text and copy it manually.'
      );
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1600);
  };

  const icon =
    state === 'copied' ? (
      <Check className="size-3.5 text-ok" aria-hidden="true" />
    ) : state === 'failed' ? (
      <TriangleAlert className="size-3.5 text-bad" aria-hidden="true" />
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
      className={cn(
        state === 'copied' && 'text-ok',
        state === 'failed' && 'text-bad',
        className
      )}
    >
      {icon}
    </IconButton>
  );
}
