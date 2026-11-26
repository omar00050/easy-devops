import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { ApiErrorPayload } from '../../lib/types';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { Modal } from '../ui/Modal';
import { InlineAlert } from '../ui/States';

/** The one command this dialog may run. Nothing else is sent. */
const INSTALL_COMMAND = 'npm i -g pm2';

/**
 * Exactly what the confirmation promises, word for word. The owner's brief
 * requires this sentence, and it is the only place the command's effect is
 * described, so keep it in step with `processesController.installPm2`.
 */
const WHAT_RUNS =
  'Installs standard PM2 for the account running Easy DevOps: npm i -g pm2. ' +
  'Nothing else is created and no app is started.';

type Outcome =
  | { kind: 'installed'; version: string | null; already: boolean }
  | { kind: 'refused'; title: string; message: string; fix: string | null }
  | { kind: 'failed'; output: string; command: string };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function failureOutcome(error: unknown): Outcome | 'already_installed' {
  const payload = error instanceof ApiError ? error.payload : ({} as ApiErrorPayload);
  const message = text(payload.message);
  const fix = text(payload.fix);

  if (error instanceof ApiError && error.status === 409) {
    if (payload.reason === 'already_installed') return 'already_installed';
    return {
      kind: 'refused',
      title: 'Another PM2 install is already running',
      message: message ?? 'Wait for it to finish, then try again.',
      fix,
    };
  }

  if (error instanceof ApiError && error.status === 403) {
    return {
      kind: 'refused',
      title: 'PM2 cannot be installed from here',
      message: message ?? 'This account may not use PM2.',
      fix,
    };
  }

  // 500 install_failed — npm's own output is the useful part.
  return {
    kind: 'failed',
    output: text(payload.output) ?? (error instanceof Error ? error.message : 'The install command failed.'),
    command: text(payload.command) ?? INSTALL_COMMAND,
  };
}

/**
 * The confirmation before `npm i -g pm2` runs.
 *
 * PM2 is never installed silently: this dialog says exactly what runs, starts
 * with Cancel focused, and only the Install button calls
 * `POST /api/pm2/install`. Its answers are shown here rather than in a toast,
 * because a refusal's `message`/`fix` and a failure's output are the whole
 * point of asking.
 */
export function Pm2InstallDialog({
  open,
  onClose,
  onInstalled,
}: {
  open: boolean;
  /** Closing is refused while the install request is in flight. */
  onClose: () => void;
  /** PM2 is usable now: reload the page data behind the dialog. */
  onInstalled: () => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    // Reset on close, so reopening never flashes the previous outcome.
    if (open) return;
    setInstalling(false);
    setOutcome(null);
  }, [open]);

  const install = async () => {
    if (installing) return;
    setInstalling(true);
    setOutcome(null);
    try {
      const result = await api.pm2.install();
      setOutcome({ kind: 'installed', version: result.version ?? null, already: false });
      onInstalled();
    } catch (error) {
      const failure = failureOutcome(error);
      if (failure === 'already_installed') {
        const payload = error instanceof ApiError ? error.payload : {};
        setOutcome({
          kind: 'installed',
          version: text((payload as ApiErrorPayload & { version?: unknown }).version),
          already: true,
        });
        onInstalled();
      } else {
        setOutcome(failure);
      }
    } finally {
      setInstalling(false);
    }
  };

  let title = 'Install PM2';
  let description: string | undefined =
    'PM2 keeps deployed apps running and starts them again after a reboot.';
  if (outcome?.kind === 'installed') {
    title = outcome.already ? 'PM2 was already installed' : 'PM2 installed';
    description = undefined;
  } else if (outcome?.kind === 'refused') {
    title = outcome.title;
    description = undefined;
  } else if (outcome?.kind === 'failed') {
    title = 'PM2 was not installed';
    description = undefined;
  }

  const footer = (() => {
    if (outcome?.kind === 'installed') {
      return (
        <Button variant="primary" onClick={onClose} data-autofocus>
          Done
        </Button>
      );
    }
    if (outcome) {
      return <Button onClick={onClose}>Close</Button>;
    }
    return (
      <>
        <Button variant="secondary" onClick={onClose} disabled={installing} data-autofocus>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void install()} loading={installing}>
          {installing ? 'Installing…' : 'Install'}
        </Button>
      </>
    );
  })();

  return (
    <Modal
      open={open}
      onClose={onClose}
      preventClose={installing}
      size="md"
      title={title}
      description={description}
      footer={footer}
    >
      {!outcome && (
        <>
          <p className="text-sm text-muted">{WHAT_RUNS}</p>
          <div className="mt-3 flex items-center gap-2 rounded-md border border-line bg-inset px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">
              {INSTALL_COMMAND}
            </code>
            <CopyButton value={INSTALL_COMMAND} label="Copy command" />
          </div>
          <p className="mt-3 text-2xs text-faint">
            It uses npm, so npm must be on the PATH of the account running Easy DevOps. Nothing is
            deployed and no existing app is touched.
          </p>
          {installing && (
            <p className="mt-3 text-xs text-muted" role="status">
              Running <code className="font-mono">npm i -g pm2</code> — this can take a minute.
            </p>
          )}
        </>
      )}

      {outcome?.kind === 'installed' && (
        <InlineAlert
          tone="success"
          title={outcome.already ? 'PM2 was already installed' : 'PM2 is installed'}
        >
          {outcome.version
            ? `PM2 ${outcome.version} is ready. Deployed apps are kept running by it.`
            : 'Deployed apps are kept running by PM2.'}
        </InlineAlert>
      )}

      {outcome?.kind === 'refused' && (
        <InlineAlert tone="warning" title={outcome.message}>
          {outcome.fix && <p>{outcome.fix}</p>}
        </InlineAlert>
      )}

      {outcome?.kind === 'failed' && (
        <>
          <InlineAlert tone="danger" title="The install command failed">
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs text-muted">
              {outcome.output}
            </pre>
          </InlineAlert>
          <div className="mt-3 flex items-center gap-2 rounded-md border border-line bg-inset px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">
              {outcome.command}
            </code>
            <CopyButton value={outcome.command} label="Copy command" />
          </div>
          <p className="mt-2 text-2xs text-faint">
            You can run that command yourself on the server, then reopen this page.
          </p>
        </>
      )}
    </Modal>
  );
}
