import { useEffect, useRef, useState } from 'react';
import { Check, Circle, Loader2, PackageCheck, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type { UpdateCheck, UpdatePhase, UpdateRun } from '../../lib/types';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/format';
import { useConfirm, useResource } from '../../hooks/useResource';
import { Card, CardBody, CardFooter, CardHeader } from '../ui/Card';
import { Badge, type Tone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Collapsible } from '../ui/Collapsible';
import { CopyButton } from '../ui/CopyButton';
import {
  ErrorState,
  InlineAlert,
  Skeleton,
  Spinner,
} from '../ui/States';
import { useToast } from '../ui/Toast';

const ACTIVE_PHASES: UpdatePhase[] = ['starting', 'stopping', 'updating', 'restarting'];

const PROGRESS_STEPS: { id: UpdatePhase; label: string }[] = [
  { id: 'starting', label: 'Hand over to the update worker' },
  { id: 'stopping', label: 'Stop the dashboard and the service' },
  { id: 'updating', label: 'Install the new version' },
  { id: 'restarting', label: 'Start the dashboard again' },
];

const PHASE_LABEL: Record<UpdatePhase, string> = {
  starting: 'Starting…',
  stopping: 'Stopping…',
  updating: 'Updating…',
  restarting: 'Restarting…',
  done: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

const PHASE_TONE: Record<UpdatePhase, Tone> = {
  starting: 'warn',
  stopping: 'warn',
  updating: 'warn',
  restarting: 'warn',
  done: 'ok',
  failed: 'bad',
  interrupted: 'warn',
};

function failureText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const detail = typeof error.payload.detail === 'string' ? error.payload.detail : null;
    return detail ?? error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

function isActive(phase: UpdatePhase | undefined): boolean {
  return phase !== undefined && ACTIVE_PHASES.includes(phase);
}

interface ElevationRefusal {
  command: string;
  shell: string | null;
}

/**
 * A 403 `elevation_required` names the command that works instead. Returned
 * as data so the card can show the same note a fresh GET would produce.
 */
function elevationRefusal(error: unknown): ElevationRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 403) return null;
  if (error.payload.error !== 'elevation_required') return null;
  return {
    command:
      typeof error.payload.command === 'string' && error.payload.command
        ? error.payload.command
        : 'ezz update',
    shell: typeof error.payload.shell === 'string' ? error.payload.shell : null,
  };
}

function VersionFacts({ run }: { run: UpdateRun }) {
  const rows: { label: string; value: string }[] = [];
  if (run.serviceInstalled) {
    rows.push({
      label: 'Background service',
      value: run.versionConfirmed
        ? `Running v${run.runningVersion} (reported by the daemon)`
        : `Restarted, reporting ${run.runningVersion ? `v${run.runningVersion}` : 'an unknown version'}`,
    });
  } else {
    rows.push({ label: 'Background service', value: 'Not installed — the package was updated on its own' });
  }
  if (run.refreshedCopy) {
    rows.push({ label: 'Runtime copy', value: 'Refreshed, so the service runs the new code' });
  }
  if (run.dashboardRestarted === false) {
    rows.push({ label: 'Dashboard', value: 'Did not come back automatically — start it from the CLI' });
  } else if (run.dashboardPort) {
    rows.push({ label: 'Dashboard', value: `Running again on port ${run.dashboardPort}` });
  }

  return (
    <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[auto_1fr]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="font-medium uppercase tracking-wider text-faint">{row.label}</dt>
          <dd className="text-muted">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RunResult({ run }: { run: UpdateRun }) {
  const finished = run.finishedAt ? formatDate(new Date(run.finishedAt).toISOString()) : null;

  if (run.phase === 'done') {
    return (
      <div className="space-y-3">
        <InlineAlert tone="success" title={`Updated v${run.from} → v${run.to}`}>
          {finished ? `Finished ${finished}. ` : ''}
          The dashboard runs the new version from now on.
        </InlineAlert>
        <VersionFacts run={run} />
        {run.dashboardRestarted === false && (
          <InlineAlert tone="warning" title="The dashboard did not come back by itself">
            Start it again with <code className="font-mono">ezz --dash</code> in a terminal.
          </InlineAlert>
        )}
      </div>
    );
  }

  if (run.phase === 'interrupted') {
    return (
      <div className="space-y-3">
        <InlineAlert tone="warning" title="The update was interrupted">
          The worker that performs the update stopped reporting
          {run.step ? ` during “${run.step}”` : ''}. Nothing here can say what state the files
          are in — run <code className="font-mono">ezz update</code> in a terminal; it checks the
          source, reinstalls and verifies the service from the beginning.
        </InlineAlert>
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
          onClick={() => window.location.reload()}
        >
          Reload the page
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <InlineAlert tone="danger" title={`The update failed${run.step ? ` (${run.step})` : ''}`}>
        <span className="whitespace-pre-wrap break-words">{run.reason ?? 'No reason was reported.'}</span>
      </InlineAlert>
      {run.rolledBack ? (
        <InlineAlert tone="success" title={`Rolled back to v${run.from}`}>
          {run.restored
            ? 'The background service is running again on the version you had.'
            : 'The service did not come back — start it from Processes.'}
        </InlineAlert>
      ) : run.serviceInstalled ? (
        <InlineAlert tone="warning" title="The service may not be running">
          Start it again from Processes once you have checked the log below.
        </InlineAlert>
      ) : null}
      <VersionFacts run={run} />
    </div>
  );
}

export function UpdatePanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const check = useResource<UpdateCheck>((signal) => api.update.check(signal));

  const [current, setCurrent] = useState<string | null>(null);
  const [run, setRun] = useState<UpdateRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  // A POST refused for elevation tells an older page what the GET now says.
  const [refusedElevation, setRefusedElevation] = useState<ElevationRefusal | null>(null);
  const finalised = useRef<string | null>(null);
  const reloadCheck = check.reload;

  useEffect(() => {
    const data = check.data;
    if (!data) return;
    setCurrent(data.current);
    // A run from a previous visit stays visible until the page is reloaded;
    // only the first load adopts it.
    setRun((existing) => existing ?? data.run);
    // The 403 note is local knowledge; a server that no longer needs elevation
    // (the dashboard was restarted as an administrator) clears it.
    if (data.elevation?.required !== true) setRefusedElevation(null);
  }, [check.data]);

  const running = isActive(run?.phase);

  // While a run is in flight, poll the status file. Between "updating" and
  // "restarting" this process is dead, so failures are expected and mean
  // "catching up", not "something went wrong" — keep asking until it answers.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const status = await api.update.status();
        if (cancelled) return;
        setCatchingUp(false);
        setCurrent(status.current);
        setRun(status.run);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 0) {
          setCatchingUp(true);
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, catchingUp ? 3_000 : 1_500);
    };
    timer = window.setTimeout(poll, 1_200);

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [running, catchingUp]);

  // Once an outcome arrives, the registry check is stale (the dashboard is a
  // new version now). Refreshing it also lets the card say "up to date".
  useEffect(() => {
    if (!run || isActive(run.phase)) return;
    if (finalised.current === run.id) return;
    finalised.current = run.id;
    reloadCheck();
  }, [run, reloadCheck]);

  const start = async () => {
    const latest = check.data?.latest;
    if (!latest || starting) return;

    const ok = await confirm({
      title: `Update to v${latest}?`,
      body: 'The dashboard stops, installs the new version and starts again on this port. This page loses its connection while that happens and comes back by itself — one or two minutes is normal. Do not close the tab.',
      confirmLabel: 'Update now',
      tone: 'accent',
    });
    if (!ok) return;

    setStarting(true);
    try {
      const result = await api.update.start(latest);
      setCatchingUp(false);
      setRun(result.run);
      toast.success('Update started', 'The dashboard will stop for a moment and come back on its own.');
    } catch (error) {
      const refusal = elevationRefusal(error);
      if (refusal) {
        setRefusedElevation(refusal);
        check.reload();
        return;
      }
      toast.error(
        'Could not start the update',
        failureText(error, 'Nothing was changed.')
      );
      check.reload();
    } finally {
      setStarting(false);
    }
  };

  const content = (() => {
    if (check.error && !check.data) {
      return (
        <CardBody>
          <ErrorState
            error={check.error}
            title="Could not check for updates"
            onRetry={check.reload}
            className="border-0"
          />
        </CardBody>
      );
    }
    if (!check.data) {
      return (
        <CardBody className="space-y-3">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-20 rounded-md" />
        </CardBody>
      );
    }

    const { source, latest, reachable, updateAvailable } = check.data;
    const activeRun = running && run;
    const elevation = check.data.elevation;
    const elevationRequired = elevation?.required === true || refusedElevation !== null;
    const elevationCommand = refusedElevation?.command ?? elevation?.command ?? 'ezz update';
    const elevationShell = refusedElevation?.shell ?? elevation?.shell ?? 'Administrator PowerShell';
    const elevationTitle = elevationShell.startsWith('Administrator ')
      ? `Update from an ${elevationShell}`
      : `Update from ${elevationShell}`;
    const needsElevation = elevationRequired && updateAvailable;

    return (
      <CardBody className="space-y-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <div className="text-2xs font-medium uppercase tracking-wider text-faint">Installed</div>
            <div className="mt-0.5 font-mono text-sm font-medium text-ink">
              v{current ?? check.data.current}
            </div>
          </div>
          <div>
            <div className="text-2xs font-medium uppercase tracking-wider text-faint">Latest</div>
            <div className="mt-0.5 font-mono text-sm font-medium text-ink">
              {reachable && latest ? `v${latest}` : '—'}
            </div>
          </div>
          <div className="pt-4">
            {!reachable ? (
              <Badge tone="warn" dot>Registry unreachable</Badge>
            ) : updateAvailable ? (
              <Badge tone="accent" dot>Update available</Badge>
            ) : (
              <Badge tone="ok" dot>Up to date</Badge>
            )}
          </div>
        </div>

        {!source.npmUpdatable && (
          <InlineAlert tone="warning" title="This copy is not managed by npm">
            This installation is {source.reason}. Running{' '}
            <code className="font-mono">npm install -g</code> would install a second copy and leave
            this one running, so updates have to be done by hand:
            <pre className="mt-2 overflow-x-auto rounded-sm bg-inset/70 px-3 py-2 font-mono text-2xs text-ink">
{source.howToUpdate.join('\n')}
            </pre>
          </InlineAlert>
        )}

        {needsElevation && (
          <InlineAlert tone="warning" title={elevationTitle}>
            <p>
              This server runs Easy DevOps as a Windows service in Server mode. Updating replaces
              files only administrators can change, so the dashboard cannot do it.
            </p>
            <div className="mt-2 rounded-md border border-line bg-canvas p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <code className="break-all font-mono text-xs text-ink">{elevationCommand}</code>
                <CopyButton value={elevationCommand} label="Copy command" withText />
              </div>
            </div>
            <p className="mt-2 text-2xs text-faint">
              If you run it from a normal PowerShell, Easy DevOps offers to relaunch itself as
              administrator (one Windows prompt, no password).
            </p>
          </InlineAlert>
        )}

        {activeRun && (
          <div className="space-y-3 rounded-md border border-line bg-raised/40 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Loader2 className="spin size-4 text-accent-text" aria-hidden="true" />
              <span className="text-sm font-medium text-ink">
                Updating v{activeRun.from} → v{activeRun.to}
              </span>
              <Badge tone="warn" dot>{PHASE_LABEL[activeRun.phase]}</Badge>
            </div>
            <ol className="space-y-1.5">
              {PROGRESS_STEPS.map((step) => {
                const currentIndex = PROGRESS_STEPS.findIndex((entry) => entry.id === activeRun.phase);
                const stepIndex = PROGRESS_STEPS.findIndex((entry) => entry.id === step.id);
                const state =
                  stepIndex < currentIndex ? 'done' : stepIndex === currentIndex ? 'current' : 'pending';
                return (
                  <li
                    key={step.id}
                    className={cn(
                      'flex items-center gap-2 text-xs',
                      state === 'pending' ? 'text-faint' : 'text-muted'
                    )}
                  >
                    {state === 'done' ? (
                      <Check className="size-3.5 text-ok" aria-hidden="true" />
                    ) : state === 'current' ? (
                      <Loader2 className="spin size-3.5 text-accent-text" aria-hidden="true" />
                    ) : (
                      <Circle className="size-3.5" aria-hidden="true" />
                    )}
                    {step.label}
                  </li>
                );
              })}
            </ol>
            {catchingUp && (
              <InlineAlert tone="info" title="The dashboard is restarting">
                This page cannot reach it at the moment. It keeps reconnecting and shows the
                result here as soon as the dashboard is back.
              </InlineAlert>
            )}
            {activeRun.logTail.length > 0 && (
              <pre className="max-h-36 overflow-auto rounded-sm bg-inset/70 px-3 py-2 font-mono text-2xs text-muted">
{activeRun.logTail.join('\n')}
              </pre>
            )}
          </div>
        )}

        {run && !running && (
          <div className="space-y-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink">
                {run.phase === 'done'
                  ? `Last update: v${run.from} → v${run.to}`
                  : `Last update attempt (v${run.to})`}
              </span>
              <Badge tone={PHASE_TONE[run.phase]} dot>{PHASE_LABEL[run.phase]}</Badge>
            </div>
            <RunResult run={run} />
            {run.logTail.length > 0 && (
              <Collapsible
                id="update-log"
                title="Update log"
                open={logOpen}
                onOpenChange={setLogOpen}
                headerClassName="py-1"
                contentClassName="pb-1"
              >
                <pre className="mt-2 max-h-48 overflow-auto rounded-sm bg-inset/70 px-3 py-2 font-mono text-2xs text-muted">
{run.logTail.join('\n')}
                </pre>
              </Collapsible>
            )}
          </div>
        )}

        {!activeRun && source.npmUpdatable && (
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            {updateAvailable && latest && !needsElevation ? (
              <Button
                variant="primary"
                loading={starting}
                icon={<PackageCheck className="size-4" aria-hidden="true" />}
                onClick={() => void start()}
              >
                Update to v{latest}
              </Button>
            ) : run?.phase === 'done' ? (
              <Button
                variant="secondary"
                icon={<RefreshCw className="size-4" aria-hidden="true" />}
                onClick={() => window.location.reload()}
              >
                Reload the page
              </Button>
            ) : null}
            <p className="text-xs text-muted">
              The dashboard stops while the update runs and starts again on this port by itself.
            </p>
          </div>
        )}
      </CardBody>
    );
  })();

  return (
    <Card className="overflow-hidden">
      <div className="h-0.5 w-full bg-accent/50" aria-hidden="true" />
      <CardHeader
        icon={<PackageCheck className="size-4" aria-hidden="true" />}
        title="Easy DevOps version"
        description="Update the package this dashboard and its service run on. Nothing is installed unless you ask for it."
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={check.loading}
            disabled={running}
            icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
            onClick={check.reload}
          >
            Check again
          </Button>
        }
      />
      {content}
      {check.loading && check.data && (
        <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-2xs text-faint sm:px-5">
          <Spinner />
          Checking the npm registry…
        </div>
      )}
      <CardFooter>
        <span className="text-2xs text-faint">
          Same flow as <code className="font-mono">ezz update</code> — stop the service, replace the
          package, verify, and roll back if the new version does not come up.
        </span>
      </CardFooter>
    </Card>
  );
}
