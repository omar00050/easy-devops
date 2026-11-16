import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  Plus,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type {
  Certificate,
  CertStatus,
  Domain,
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
  formatDurationMs,
} from '../components/ssl/IssuancePanels';
import { IssueCertificateModal } from '../components/ssl/IssueCertificateModal';

const CERT_STATUS: Record<CertStatus, { label: string; tone: Tone }> = {
  valid: { label: 'Valid', tone: 'ok' },
  expiring: { label: 'Expiring', tone: 'warn' },
  expired: { label: 'Expired', tone: 'bad' },
  error: { label: 'Unreadable', tone: 'bad' },
};

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

export function SslPage() {
  useDocumentTitle('SSL certificates');
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const resource = useResource<Certificate[]>((signal) => api.ssl.list(signal));
  const [params, setParams] = useSearchParams();

  const issueOpen = params.get('new') === '1' || Boolean(params.get('domain'));
  const prefillDomain = params.get('domain') ?? '';
  const domains = useResource<Domain[]>((signal) => api.domains.list(signal), [], {
    enabled: issueOpen,
  });

  const [renewing, setRenewing] = useState<string | null>(null);
  const [renewFailure, setRenewFailure] = useState<{
    domain: string | null;
    error: unknown;
  } | null>(null);
  const [renewAllResults, setRenewAllResults] = useState<RenewAllResult[] | null>(null);

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
      error: list.filter((cert) => cert.status === 'error').length,
    };
  }, [certs]);

  const renewable = useMemo(
    () => (certs ?? []).filter((cert) => cert.daysLeft !== null && cert.daysLeft < 30),
    [certs]
  );

  const attention =
    counts.expiring > 0 || counts.expired > 0 || counts.error > 0;

  const closeIssue = () => setParams({}, { replace: true });
  const openIssue = () => setParams({ new: '1' });

  const renewOne = async (cert: Certificate) => {
    if (renewing) return;
    setRenewing(cert.domain);
    try {
      const result = await api.ssl.renew(cert.domain);
      toast.success(`${cert.domain} renewed`, renewalSummary(result));
      resource.reload();
    } catch (error) {
      setRenewFailure({ domain: cert.domain, error });
    } finally {
      setRenewing(null);
    }
  };

  const renewAll = async () => {
    if (renewing || renewable.length === 0) return;
    const ok = await confirm({
      title: `Renew ${pluralize(renewable.length, 'certificate')}?`,
      body: 'Every certificate expiring within 30 days is renewed one at a time. nginx keeps running unless a challenge has to fall back to standalone mode, which stops it briefly.',
      confirmLabel: 'Renew now',
      tone: 'accent',
    });
    if (!ok) return;

    setRenewing('all');
    try {
      const results = await api.ssl.renewAll();
      setRenewAllResults(results);
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
      setRenewFailure({ domain: null, error });
    } finally {
      setRenewing(null);
    }
  };

  const renewEmailRequired =
    renewFailure?.error instanceof ApiError && renewFailure.error.code === 'email_required';

  return (
    <>
      <PageHeader
        title="SSL certificates"
        description="Let’s Encrypt certificates managed by this installation. Renewals keep nginx running where possible."
        meta={
          certs ? (
            <span className="text-2xs text-faint">
              {pluralize(counts.total, 'certificate')} · {counts.valid} valid
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
              disabled={renewable.length === 0 || renewing !== null}
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
          tone={counts.expired > 0 || counts.error > 0 ? 'danger' : 'warning'}
          title="Certificates need attention"
          className="mb-4"
        >
          {[
            counts.expired > 0 ? `${counts.expired} expired` : null,
            counts.expiring > 0 ? `${counts.expiring} expiring within 30 days` : null,
            counts.error > 0 ? `${counts.error} unreadable` : null,
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
                          {cert.status === 'error' ? (
                            <span>Certificate files are missing or unreadable</span>
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

                    <div className="flex shrink-0 items-center justify-end pl-7 sm:w-24 sm:pl-0">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busyHere}
                        disabled={renewing !== null && !busyHere}
                        onClick={() => renewOne(cert)}
                      >
                        Renew
                      </Button>
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
        open={renewFailure !== null}
        onClose={() => setRenewFailure(null)}
        title={
          renewFailure?.domain ? `${renewFailure.domain} was not renewed` : 'Renewal failed'
        }
        description="The certificate already on disk was not replaced."
        size="md"
        footer={
          <>
            {renewEmailRequired && (
              <Button
                variant="secondary"
                onClick={() => {
                  setRenewFailure(null);
                  navigate('/settings');
                }}
              >
                Open settings
              </Button>
            )}
            <Button variant="primary" onClick={() => setRenewFailure(null)}>
              Close
            </Button>
          </>
        }
      >
        {renewFailure && (
          <IssuanceFailurePanel
            value={renewFailure.error}
            title="The certificate could not be renewed"
          />
        )}
      </Modal>

      <Modal
        open={renewAllResults !== null}
        onClose={() => setRenewAllResults(null)}
        title="Renewal results"
        description={
          renewAllResults
            ? `${renewAllResults.filter((entry) => entry.success).length} of ${renewAllResults.length} certificates renewed.`
            : undefined
        }
        size="lg"
        footer={
          <Button variant="secondary" onClick={() => setRenewAllResults(null)}>
            Close
          </Button>
        }
      >
        {renewAllResults && renewAllResults.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="size-5" aria-hidden="true" />}
            title="Nothing to renew"
            description="No certificate expires within 30 days."
          />
        ) : (
          <ul className="space-y-2.5">
            {(renewAllResults ?? []).map((entry) => (
              <li
                key={entry.domain}
                className="rounded-md border border-line bg-raised/30 px-3.5 py-3"
              >
                <div className="flex items-start gap-2.5">
                  {entry.success ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden="true" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm font-medium text-ink">
                      {entry.domain}
                    </div>
                    {entry.success ? (
                      <>
                        <p className="mt-0.5 text-xs text-muted">{renewalSummary(entry)}</p>
                        {entry.configRegenerated && (
                          <p className="mt-1 text-2xs text-faint">
                            The nginx config was regenerated so it can answer the ACME challenge.
                          </p>
                        )}
                      </>
                    ) : (
                      <div className="mt-2">
                        <IssuanceFailurePanel
                          value={renewFailureValue(entry)}
                          title={`${entry.domain} was not renewed`}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}
