import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useRealtime } from '../app/RealtimeProvider';
import { useSslProgress } from '../hooks/useSslProgress';
import {
  SSL_ISSUANCE_STAGES,
  newSslOpId,
  preflightFrom,
  sslFailureFrom,
} from '../lib/sslProgress';
import type {
  Certificate,
  CertConfigReference,
  CertStatus,
  Domain,
  IssuanceSuccess,
  RenewAllResult,
} from '../lib/types';
import { formatDate, formatDaysLeft, pluralize } from '../lib/format';
import { cn } from '../lib/cn';
import {
  useConfirm,
  useDocumentTitle,
  useRefreshOnVisible,
  useResource,
} from '../hooks/useResource';
import { useLocalChange } from '../hooks/useLocalChange';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge, StatusDot, type Tone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import {
  EmptyState,
  ErrorState,
  InlineAlert,
  PageSkeleton,
  Skeleton,
} from '../components/ui/States';
import { useToast } from '../components/ui/Toast';
import {
  IssuanceFailurePanel,
  IssuanceSuccessPanel,
  formatDurationMs,
} from '../components/ssl/IssuancePanels';
import { IssueCertificateModal } from '../components/ssl/IssueCertificateModal';
import { PreflightResult } from '../components/ssl/PreflightResult';
import { StageList } from '../components/ssl/StageList';

const CERT_STATUS: Record<CertStatus, { label: string; tone: Tone }> = {
  valid: { label: 'Valid', tone: 'ok' },
  expiring: { label: 'Expiring', tone: 'warn' },
  expired: { label: 'Expired', tone: 'bad' },
  not_issued: { label: 'Not issued yet', tone: 'neutral' },
  unreadable: { label: 'Unreadable', tone: 'bad' },
  // A backend older than contract 2.16.0 reported "unreadable" as "error".
  error: { label: 'Unreadable', tone: 'bad' },
};

function isUnreadable(status: CertStatus): boolean {
  return status === 'unreadable' || status === 'error';
}

function daysTone(days: number | null): string {
  if (days === null) return 'text-faint';
  if (days < 0) return 'text-bad';
  if (days < 30) return 'text-warn';
  return 'text-ink';
}

function renewalSummary(result: {
  summary?: string;
  fellBack?: boolean;
  nginxDownMs?: number;
  staging?: boolean;
}): string {
  const parts: string[] = [];
  if (result.summary) parts.push(result.summary);
  if (result.fellBack) {
    parts.push(`nginx was stopped for ${formatDurationMs(result.nginxDownMs)} while the challenge ran.`);
  }
  if (result.staging) parts.push('This is a staging certificate that browsers will not trust.');
  return parts.join(' ') || 'The certificate was renewed.';
}

function renewFailureValue(entry: RenewAllResult): unknown {
  if (entry.error && typeof entry.error === 'object') return entry.error;
  if (typeof entry.error === 'string') {
    return { step: entry.error, cause: entry.detail };
  }
  return entry.detail ?? 'No certificate was issued.';
}

/** The socket fallback every live stage list shares. */
function BusyLine({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-md border border-line bg-raised/40 px-3 py-2.5 text-xs text-muted"
    >
      <Loader2 className="spin mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="break-words">{children}</span>
    </p>
  );
}

interface RenewRun {
  domain: string;
  done: boolean;
  result?: IssuanceSuccess;
  error?: unknown;
}

interface RenewAllRun {
  domains: string[];
  done: boolean;
  results: RenewAllResult[] | null;
  error?: unknown;
}

export function SslPage() {
  useDocumentTitle('SSL certificates');
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { connected } = useRealtime();
  const resource = useResource<Certificate[]>((signal) => api.ssl.list(signal));
  const [params, setParams] = useSearchParams();

  // One id for the page's own renew/renew-all operations. It is created before
  // the subscription below, and `ssl:progress` is never replayed, so the
  // listener is already attached when a request starts.
  const [opId] = useState(() => newSslOpId());
  const progress = useSslProgress(opId);

  const issueOpen = params.get('new') === '1' || Boolean(params.get('domain'));
  const prefillDomain = params.get('domain') ?? '';
  const domains = useResource<Domain[]>((signal) => api.domains.list(signal), [], {
    enabled: issueOpen,
  });

  const [renewing, setRenewing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [renewRun, setRenewRun] = useState<RenewRun | null>(null);
  const [renewAllRun, setRenewAllRun] = useState<RenewAllRun | null>(null);
  const [collapsedRows, setCollapsedRows] = useState<Record<string, boolean>>({});
  const [blockedDelete, setBlockedDelete] = useState<{
    domain: string;
    directory: string | null;
    references: CertConfigReference[];
  } | null>(null);

  useRefreshOnVisible(resource.reload);
  useLocalChange(['ssl', 'domains'], resource.reload);

  const certs = resource.data;
  const counts = useMemo(() => {
    const list = certs ?? [];
    return {
      total: list.length,
      valid: list.filter((cert) => cert.status === 'valid').length,
      expiring: list.filter(
        (cert) => cert.status === 'expiring' || (cert.daysLeft !== null && cert.daysLeft >= 0 && cert.daysLeft < 30)
      ).length,
      expired: list.filter(
        (cert) => cert.status === 'expired' || (cert.daysLeft !== null && cert.daysLeft < 0)
      ).length,
      unreadable: list.filter((cert) => isUnreadable(cert.status)).length,
      notIssued: list.filter((cert) => cert.status === 'not_issued').length,
    };
  }, [certs]);

  const renewable = useMemo(
    () => (certs ?? []).filter((cert) => cert.daysLeft !== null && cert.daysLeft < 30),
    [certs]
  );

  const attention = counts.expiring > 0 || counts.expired > 0 || counts.unreadable > 0;

  const closeIssue = () => setParams({}, { replace: true });
  const openIssue = () => setParams({ new: '1' });
  const openIssueFor = (domain: string) => setParams({ domain });

  const stagesFor = (domain: string) => progress.byDomain[domain] ?? {};
  const heardFor = (domain: string) =>
    connected && Object.keys(progress.byDomain[domain] ?? {}).length > 0;

  const renewOne = async (cert: Certificate) => {
    if (renewing || removing) return;
    progress.clear(cert.domain);
    setRenewing(cert.domain);
    setRenewRun({ domain: cert.domain, done: false });
    try {
      const result = await api.ssl.renew(cert.domain, opId);
      setRenewRun({ domain: cert.domain, done: true, result });
      toast.success(`${cert.domain} renewed`, renewalSummary(result));
      resource.reload();
    } catch (error) {
      setRenewRun({ domain: cert.domain, done: true, error });
    } finally {
      setRenewing(null);
    }
  };

  const removeOne = async (cert: Certificate) => {
    if (renewing || removing) return;
    const ok = await confirm({
      title: `Delete the certificate for ${cert.domain}?`,
      body: 'Its files are removed from disk and this cannot be undone. The deletion is refused if any nginx configuration still references the certificate.',
      confirmLabel: 'Delete certificate',
      tone: 'danger',
    });
    if (!ok) return;

    setRemoving(cert.domain);
    try {
      const result = await api.ssl.remove(cert.domain);
      toast.success(`${cert.domain} deleted`, `Removed ${result.directory}.`);
      resource.reload();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'cert_in_use') {
        setBlockedDelete({
          domain: cert.domain,
          directory: typeof error.payload.directory === 'string' ? error.payload.directory : null,
          references: Array.isArray(error.payload.references) ? error.payload.references : [],
        });
      } else {
        const detail =
          error instanceof ApiError && typeof error.payload.detail === 'string'
            ? error.payload.detail
            : error instanceof Error
              ? error.message
              : undefined;
        toast.error(`Could not delete ${cert.domain}`, detail);
      }
    } finally {
      setRemoving(null);
    }
  };

  const renewAll = async () => {
    if (renewing || removing || renewable.length === 0) return;
    const ok = await confirm({
      title: `Renew ${pluralize(renewable.length, 'certificate')}?`,
      body: 'Every certificate expiring within 30 days is renewed one at a time. nginx keeps running unless a challenge has to fall back to standalone mode, which stops it briefly.',
      confirmLabel: 'Renew now',
      tone: 'accent',
    });
    if (!ok) return;

    const targets = renewable.map((cert) => cert.domain);
    progress.clear();
    setCollapsedRows({});
    setRenewing('all');
    setRenewAllRun({ domains: targets, done: false, results: null });
    try {
      const results = await api.ssl.renewAll(opId);
      setRenewAllRun({ domains: targets, done: true, results });
      const failed = results.filter((entry) => !entry.success).length;
      if (results.length === 0) {
        toast.info('Nothing to renew', 'No certificate expires within 30 days.');
      } else if (failed === 0) {
        toast.success(
          `${pluralize(results.length, 'certificate')} renewed`,
          'The new certificates are already on disk.'
        );
      } else {
        toast.warning(
          'Some certificates were not renewed',
          `${results.length - failed} renewed, ${failed} failed.`
        );
      }
      resource.reload();
    } catch (error) {
      setRenewAllRun({ domains: targets, done: true, results: null, error });
    } finally {
      setRenewing(null);
    }
  };

  const renewRunFailure = renewRun?.error ? sslFailureFrom(renewRun.error) : null;
  const renewRunPreflight = renewRun?.error
    ? preflightFrom(renewRun.error)
    : renewRun?.result
      ? preflightFrom(renewRun.result)
      : null;
  const renewEmailRequired =
    renewRun?.error instanceof ApiError && renewRun.error.code === 'email_required';

  const renewAllDomains = renewAllRun
    ? Array.from(
        new Set([
          ...renewAllRun.domains,
          ...(renewAllRun.results ?? []).map((entry) => entry.domain),
        ])
      )
    : [];

  return (
    <>
      <PageHeader
        title="SSL certificates"
        description="Let’s Encrypt certificates managed by this installation. Renewals keep nginx running where possible."
        meta={
          certs ? (
            <span className="text-2xs text-faint">
              {pluralize(counts.total, 'certificate')} · {counts.valid} valid
              {counts.notIssued > 0 ? ` · ${counts.notIssued} not issued` : ''}
            </span>
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              loading={resource.loading}
              icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
              onClick={resource.reload}
            >
              Refresh
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={renewable.length === 0 || renewing !== null || removing !== null}
              loading={renewing === 'all'}
              onClick={renewAll}
            >
              Renew expiring
              {renewable.length > 0 ? ` (${renewable.length})` : ''}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="size-3.5" aria-hidden="true" />}
              onClick={openIssue}
            >
              New certificate
            </Button>
          </>
        }
      />

      {attention && (
        <InlineAlert
          tone={counts.expired > 0 || counts.unreadable > 0 ? 'danger' : 'warning'}
          title="Certificates need attention"
          className="mb-4"
        >
          {[
            counts.expired > 0 ? `${counts.expired} expired` : null,
            counts.expiring > 0 ? `${counts.expiring} expiring within 30 days` : null,
            counts.unreadable > 0 ? `${counts.unreadable} unreadable` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          . Renewing uses the same domain; an unreadable certificate is replaced by a freshly
          issued one.
        </InlineAlert>
      )}

      {resource.error && !certs ? (
        <ErrorState error={resource.error} onRetry={resource.reload} />
      ) : !certs ? (
        <PageSkeleton>
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-[280px] rounded-lg" />
        </PageSkeleton>
      ) : certs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShieldCheck className="size-5" aria-hidden="true" />}
            title="No certificates yet"
            description="Issue a Let’s Encrypt certificate for a domain, then point the domain’s SSL settings at its files."
            action={
              <Button
                variant="primary"
                size="sm"
                icon={<Plus className="size-3.5" aria-hidden="true" />}
                onClick={openIssue}
              >
                Issue a certificate
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {resource.error && (
            <div className="rounded-md border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-xs text-muted">
              Showing the last known list. {resource.error.message}{' '}
              <button
                type="button"
                className="font-medium text-ink underline-offset-2 hover:underline"
                onClick={resource.reload}
              >
                Try again
              </button>
            </div>
          )}

          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {certs.map((cert) => {
                const status = CERT_STATUS[cert.status] ?? {
                  label: cert.status,
                  tone: 'neutral' as Tone,
                };
                const busyHere = renewing === cert.domain;
                const unreadable = isUnreadable(cert.status);
                const notIssued = cert.status === 'not_issued';
                return (
                  <li
                    key={cert.domain}
                    className="flex flex-col gap-2.5 px-4 py-3 transition-colors duration-[var(--ez-motion-fast)] hover:bg-raised/40 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <StatusDot
                        tone={status.tone}
                        pulse={cert.status === 'valid'}
                        className="mt-1.5"
                      />
                      <div className="min-w-0">
                        <div className="truncate font-mono text-sm font-semibold text-ink">
                          {cert.domain}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
                          {unreadable ? (
                            <span>Certificate files are unreadable</span>
                          ) : notIssued ? (
                            <span>No certificate has been issued for this domain yet</span>
                          ) : (
                            <>
                              <span>Expires {formatDate(cert.expiry)}</span>
                              <span className="text-faint" aria-hidden="true">
                                ·
                              </span>
                              <span
                                className={cn('font-mono font-medium', daysTone(cert.daysLeft))}
                              >
                                {cert.daysLeft !== null
                                  ? cert.daysLeft < 0
                                    ? `${Math.abs(cert.daysLeft)}d overdue`
                                    : `${cert.daysLeft}d`
                                  : formatDaysLeft(cert.daysLeft)}
                              </span>
                              {cert.autoRenew && cert.autoRenew !== 'off' && (
                                <>
                                  <span className="text-faint" aria-hidden="true">
                                    ·
                                  </span>
                                  <span
                                    title={
                                      cert.autoRenew === 'auto'
                                        ? 'The background service renews this certificate on its own.'
                                        : cert.autoRenew === 'manual'
                                          ? 'DNS-validated (wildcard) certificates need a TXT record added by hand, so they are not renewed automatically.'
                                          : 'No enabled domain serves this certificate, so it is not renewed automatically.'
                                    }
                                    className={cert.autoRenew === 'manual' ? 'text-warn' : undefined}
                                  >
                                    {cert.autoRenew === 'auto'
                                      ? `Auto-renews ${cert.autoRenewDays ?? 7}d before expiry`
                                      : cert.autoRenew === 'manual'
                                        ? 'Manual renewal (DNS)'
                                        : 'Not in use'}
                                  </span>
                                </>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 pl-7 sm:w-28 sm:shrink-0 sm:pl-0">
                      <Badge tone={status.tone} dot>
                        {status.label}
                      </Badge>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 pl-7 sm:pl-0">
                      {notIssued ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={renewing !== null || removing !== null}
                          onClick={() => openIssueFor(cert.domain)}
                        >
                          Issue
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={busyHere}
                          disabled={renewing !== null || removing !== null}
                          onClick={() => renewOne(cert)}
                        >
                          Renew
                        </Button>
                      )}
                      {unreadable && (
                        <Button
                          variant="dangerGhost"
                          size="sm"
                          icon={<Trash2 className="size-3.5" aria-hidden="true" />}
                          loading={removing === cert.domain}
                          disabled={renewing !== null || removing !== null}
                          onClick={() => removeOne(cert)}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      )}

      {issueOpen && (
        <IssueCertificateModal
          key={prefillDomain || 'new'}
          domains={domains.data ?? []}
          initialDomain={prefillDomain}
          onClose={closeIssue}
          onIssued={() => resource.reload()}
        />
      )}

      <Modal
        open={renewRun !== null}
        onClose={() => setRenewRun(null)}
        title={
          renewRun
            ? renewRun.done && renewRun.error
              ? `${renewRun.domain} was not renewed`
              : renewRun.done
                ? `${renewRun.domain} renewed`
                : `Renewing ${renewRun.domain}`
            : 'Renewing'
        }
        description={
          renewRun?.done && renewRun.error
            ? 'The certificate already on disk was not replaced.'
            : undefined
        }
        size="md"
        preventClose={Boolean(renewRun && !renewRun.done)}
        footer={
          <>
            {renewEmailRequired && (
              <Button
                variant="secondary"
                onClick={() => {
                  setRenewRun(null);
                  navigate('/settings');
                }}
              >
                Open settings
              </Button>
            )}
            <Button
              variant="primary"
              disabled={Boolean(renewRun && !renewRun.done)}
              onClick={() => setRenewRun(null)}
            >
              Close
            </Button>
          </>
        }
      >
        {renewRun && (
          <div className="space-y-3">
            {heardFor(renewRun.domain) ? (
              <StageList
                stages={SSL_ISSUANCE_STAGES}
                states={stagesFor(renewRun.domain)}
                ariaLabel={`Renewal stages for ${renewRun.domain}`}
                failure={renewRunFailure}
                timedOut={renewRunFailure?.stage === 'timeout'}
              />
            ) : renewRun.done ? null : (
              <BusyLine>
                Renewing <span className="font-mono text-ink">{renewRun.domain}</span>. The live
                stage list needs the dashboard’s connection; the result appears here when it
                finishes.
              </BusyLine>
            )}

            {renewRunPreflight && <PreflightResult preflight={renewRunPreflight} />}

            {renewRun.done &&
              (renewRun.error ? (
                !heardFor(renewRun.domain) && (
                  <IssuanceFailurePanel
                    value={renewRun.error}
                    title="The certificate could not be renewed"
                  />
                )
              ) : (
                renewRun.result && (
                  <IssuanceSuccessPanel result={renewRun.result} title="Certificate renewed" />
                )
              ))}
          </div>
        )}
      </Modal>

      <Modal
        open={renewAllRun !== null}
        onClose={() => setRenewAllRun(null)}
        title={renewAllRun?.done ? 'Renewal results' : 'Renewing expiring certificates'}
        description={
          renewAllRun
            ? renewAllRun.results
              ? `${renewAllRun.results.filter((entry) => entry.success).length} of ${renewAllRun.results.length} certificates renewed.`
              : `${pluralize(renewAllRun.domains.length, 'certificate')} queued, one at a time.`
            : undefined
        }
        size="lg"
        preventClose={Boolean(renewAllRun && !renewAllRun.done)}
        footer={
          <Button
            variant="secondary"
            disabled={Boolean(renewAllRun && !renewAllRun.done)}
            onClick={() => setRenewAllRun(null)}
          >
            Close
          </Button>
        }
      >
        {renewAllRun && renewAllRun.done && renewAllRun.results?.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="size-5" aria-hidden="true" />}
            title="Nothing to renew"
            description="No certificate expires within 30 days."
          />
        ) : (
          <ul className="space-y-2.5">
            {renewAllDomains.map((domain) => {
              const entry = renewAllRun?.results?.find((item) => item.domain === domain) ?? null;
              const domainStages = stagesFor(domain);
              const heard = heardFor(domain);
              const running = connected && Object.values(domainStages).some((state) => state.status === 'running');
              const busy = Boolean(renewAllRun && !renewAllRun.done && !entry && !running);
              const failure = entry && !entry.success ? sslFailureFrom(entry) : null;
              const preflight = entry ? preflightFrom(entry) : null;
              const expanded = !collapsedRows[domain];
              const summary = entry
                ? entry.success
                  ? renewalSummary(entry)
                  : failure?.message ?? 'Not renewed'
                : running
                  ? 'Renewing…'
                  : busy
                    ? 'Waiting for its turn'
                    : 'Not started';

              return (
                <li
                  key={domain}
                  className="rounded-md border border-line bg-raised/30 px-3.5 py-3"
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() =>
                      setCollapsedRows((current) => ({ ...current, [domain]: !current[domain] }))
                    }
                    className="flex w-full items-start gap-2.5 text-left"
                  >
                    <span className="mt-0.5 shrink-0">
                      {entry ? (
                        entry.success ? (
                          <CheckCircle2 className="size-4 text-ok" aria-hidden="true" />
                        ) : (
                          <XCircle className="size-4 text-bad" aria-hidden="true" />
                        )
                      ) : running ? (
                        <Loader2 className="spin size-4 text-accent-text" aria-hidden="true" />
                      ) : (
                        <StatusDot tone="neutral" className="mt-1.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="truncate font-mono text-sm font-medium text-ink">
                          {domain}
                        </span>
                        {entry && (
                          <Badge tone={entry.success ? 'ok' : 'bad'}>
                            {entry.success ? 'Renewed' : 'Failed'}
                          </Badge>
                        )}
                      </span>
                      <span className="mt-0.5 block break-words text-xs text-muted">
                        {summary}
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        'mt-0.5 size-4 shrink-0 text-faint transition-transform duration-[var(--ez-motion-fast)]',
                        expanded && 'rotate-180'
                      )}
                      aria-hidden="true"
                    />
                  </button>

                  {expanded && (
                    <div className="mt-2.5 border-t border-line pt-2.5">
                      {heard ? (
                        <StageList
                          stages={SSL_ISSUANCE_STAGES}
                          states={domainStages}
                          ariaLabel={`Renewal stages for ${domain}`}
                          failure={failure}
                          timedOut={failure?.stage === 'timeout'}
                        />
                      ) : entry ? (
                        entry.success ? (
                          <p className="text-xs text-muted">{renewalSummary(entry)}</p>
                        ) : null
                      ) : renewAllRun && !renewAllRun.done ? (
                        <BusyLine>
                          Renewing <span className="font-mono text-ink">{domain}</span>. The live
                          stage list needs the dashboard’s connection.
                        </BusyLine>
                      ) : null}

                      {preflight && <PreflightResult preflight={preflight} className="mt-2.5" />}

                      {entry && !entry.success && !heard && (
                        <div className="mt-2.5">
                          <IssuanceFailurePanel
                            value={renewFailureValue(entry)}
                            title={`${entry.domain} was not renewed`}
                          />
                        </div>
                      )}

                      {entry?.success && entry.configRegenerated && (
                        <p className="mt-2 text-2xs text-faint">
                          The nginx config was regenerated so it can answer the ACME challenge.
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {renewAllRun?.error != null && (
          <div className="mt-3">
            <IssuanceFailurePanel value={renewAllRun.error} title="The renewal run failed" />
          </div>
        )}
      </Modal>

      <Modal
        open={blockedDelete !== null}
        onClose={() => setBlockedDelete(null)}
        title={
          blockedDelete
            ? `${blockedDelete.domain} is still referenced`
            : 'Certificate is still referenced'
        }
        description="Nothing was deleted. At least one nginx configuration file still points at this certificate."
        size="md"
        footer={
          <Button variant="secondary" onClick={() => setBlockedDelete(null)}>
            Close
          </Button>
        }
      >
        {blockedDelete && (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              Disable SSL on the domain that uses this certificate — or remove the matching
              lines — then try deleting it again.
            </p>
            {blockedDelete.directory && (
              <p className="break-all font-mono text-2xs text-faint">
                {blockedDelete.directory}
              </p>
            )}
            {blockedDelete.references.length > 0 && (
              <ul className="space-y-2">
                {blockedDelete.references.map((reference) => (
                  <li
                    key={`${reference.file}:${reference.line}`}
                    className="rounded-md border border-line bg-raised/30 px-3 py-2"
                  >
                    <div className="break-all font-mono text-2xs font-medium text-ink">
                      {reference.file}:{reference.line}
                    </div>
                    <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-2xs text-muted">
                      {reference.text}
                    </pre>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
