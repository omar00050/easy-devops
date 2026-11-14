import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { setConfirmImplementation, type ConfirmOptions } from '../../hooks/useResource';

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const pending = useRef<{ resolve: (value: boolean) => void } | null>(null);

  const show = useCallback((next: ConfirmOptions): Promise<boolean> => {
    pending.current?.resolve(false);
    return new Promise<boolean>((resolve) => {
      pending.current = { resolve };
      setOptions(next);
    });
  }, []);

  useEffect(() => {
    setConfirmImplementation(show);
    return () => setConfirmImplementation(null);
  }, [show]);

  const finish = useCallback((value: boolean) => {
    setOptions(null);
    const current = pending.current;
    pending.current = null;
    current?.resolve(value);
  }, []);

  const danger = options?.tone === 'danger';

  return (
    <>
      {children}
      <Modal
        open={options !== null}
        onClose={() => finish(false)}
        title={options?.title ?? ''}
        size="sm"
        bodyClassName="px-5 py-4"
        footer={
          <>
            <Button variant="ghost" onClick={() => finish(false)} data-autofocus>
              {options?.cancelLabel ?? 'Cancel'}
            </Button>
            <Button variant={danger ? 'danger' : 'primary'} onClick={() => finish(true)}>
              {options?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <div className="text-sm text-muted">{options?.body}</div>
      </Modal>
    </>
  );
}
