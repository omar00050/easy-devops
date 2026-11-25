import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useService } from '../../app/ServiceProvider';
import { InlineAlert } from '../ui/States';
import { IconButton } from '../ui/Button';

const DISMISS_KEY = 'ez-version-drift-banner-dismissed';

function Command({ children }: { children: string }) {
  return <code className="font-mono text-ink">{children}</code>;
}

/**
 * Windows Server runs the service from its own copy of the package under
 * `C:\ProgramData\easy-devops\runtime`. A plain `npm i -g easy-devops` updates
 * only the CLI, so the service can keep running an older version — including
 * security fixes it never received. Nothing here repairs anything: the command
 * is the action.
 *
 * The state comes from `GET /api/service` (`backgroundService.versionDrift`),
 * which is a file read on the server, so it appears with the rest of the
 * service state and survives a `service:changed` merge.
 */
export function VersionDriftBanner() {
  const { service } = useService();
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  const bg = service?.backgroundService;
  const serviceVersion = bg?.serviceVersion ?? null;
  const cliVersion = bg?.cliVersion ?? null;
  const drifting = bg?.versionDrift === true;

  const signature = useMemo(
    () => (drifting ? `${serviceVersion}|${cliVersion}` : ''),
    [drifting, serviceVersion, cliVersion]
  );

  if (!drifting || !signature || dismissed === signature) return null;

  const dismiss = () => {
    setDismissed(signature);
    try {
      sessionStorage.setItem(DISMISS_KEY, signature);
    } catch {
      /* non-fatal */
    }
  };

  return (
    <div className="fade-enter mb-5">
      <InlineAlert
        tone="warning"
        title="The background service is running an older version"
        action={
          <IconButton label="Dismiss banner" size="sm" onClick={dismiss}>
            <X className="size-3.5" aria-hidden="true" />
          </IconButton>
        }
      >
        {serviceVersion && cliVersion ? (
          <>
            The background service runs v{serviceVersion}, the installed package is v{cliVersion}. Run{' '}
            <Command>ezz service repair</Command> as administrator to update the service.
          </>
        ) : (
          <>
            The background service is running a different package version from the installed CLI. Run{' '}
            <Command>ezz service repair</Command> as administrator to update the service.
          </>
        )}
      </InlineAlert>
    </div>
  );
}
