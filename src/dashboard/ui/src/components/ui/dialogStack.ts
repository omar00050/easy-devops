import { useEffect, useId, useState } from 'react';

/**
 * One document-wide stack of the dialogs that are open, in opening order.
 *
 * `Modal` and the confirm provider's dialog both register here (the confirm
 * *is* a `Modal`), so only the topmost dialog answers Escape and traps Tab.
 * Without this, a confirm opened above a modal loses Escape to the modal's
 * `document` listener, which closes the modal and unmounts the confirm.
 *
 * The stack is module state, not React state: the listeners exist only so the
 * components re-render when their "am I topmost" answer changes (`aria-modal`
 * belongs on the topmost dialog only).
 */
const stack: string[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Reads the live stack, for event handlers where state could be a frame stale. */
export function isTopDialog(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/**
 * Registers a dialog in the shared stack while `open` is true.
 *
 * Returns a stable `id` and `isTop`, which is false for every dialog that has
 * another one above it.
 */
export function useDialogStack(open: boolean): { id: string; isTop: boolean } {
  const id = useId();
  const [isTop, setIsTop] = useState(() => isTopDialog(id));

  useEffect(() => {
    const listener = () => setIsTop(isTopDialog(id));
    listeners.add(listener);
    // Sync in case the stack already changed between render and this effect.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, [id]);

  useEffect(() => {
    if (!open) return;

    stack.push(id);
    emit();

    return () => {
      const at = stack.lastIndexOf(id);
      if (at !== -1) stack.splice(at, 1);
      emit();
    };
  }, [open, id]);

  return { id, isTop };
}
