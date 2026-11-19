import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useRealtime } from '../../app/RealtimeProvider';
import { useSslProgress } from '../../hooks/useSslProgress';
import {
  SSL_ISSUANCE_STAGES,
  newSslOpId,
  preflightFrom,
  sslFailureFrom,
} from '../../lib/sslProgress';
import type { DnsChallengePending, Domain, IssuanceSuccess } from '../../lib/types';
import { validateDomainName, validateEmail } from '../../lib/validation';
import { cn } from '../../lib/cn';
import { useConfirm } from '../../hooks/useResource';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { Checkbox, TextInput } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { InlineAlert } from '../ui/States';
import { useToast } from '../ui/Toast';
import { IssuanceFailurePanel, IssuanceSuccessPanel } from './IssuancePanels';
import { PreflightResult } from './PreflightResult';
import { StageList } from './StageList';

type Phase = 'form' | 'dns' | 'success';

const KNOWN_DOMAINS_ID = 'ssl-known-domains';

function isDnsPending(
  result: IssuanceSuccess | DnsChallengePending
): result is DnsChallengePending {
  return 'status' in result && result.status === 'waiting_dns';
}

function DnsMismatchAlert({ error }: { error: ApiError }) {
  const found = Array.isArray(error.payload.found)
    ? error.payload.found.filter((value): value is string => typeof value === 'string')
    : [];
  const hint =
    typeof error.payload.hint === 'string' ? error.payload.hint : error.message;

  return (
    <InlineAlert tone="warning" title="The TXT record was not found yet">
      <p>{hint}</p>
      {found.length > 0 && (
        <p className="mt-1.5 break-all">
          Records currently visible:{' '}
          <span className="font-mono text-ink">{found.join(' · ')}</span>
        </p>
      )}
    </InlineAlert>
  );
}

export function IssueCertificateModal({
  domains,
  initialDomain = '',
  onClose,
  onIssued,
}: {
  domains: Domain[];
  initialDomain?: string;
  onClose: () => void;
  onIssued: (result: IssuanceSuccess, domain: string) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { connected } = useRealtime();

  // The id exists before the first render, and useSslProgress subscribes on
  // mount, so the `ssl:progress` frames cannot be missed: the contract does not
  // replay them.
  const [opId] = useState(() => newSslOpId());
  const progress = useSslProgress(opId);

  const [domain, setDomain] = useState(initialDomain);
  const [email, setEmail] = useState('');
  const [www, setWww] = useState(false);
  const [method, setMethod] = useState<'http' | 'dns'>('http');
  const [phase, setPhase] = useState<Phase>('form');
  const [fieldErrors, setFieldErrors] = useState<{ domain?: string; email?: string }>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [issuing, setIssuing] = useState(false);
  const [dnsPending, setDnsPending] = useState<DnsChallengePending | null>(null);
  const [dnsConfirming, setDnsConfirming] = useState(false);
  const [dnsMismatch, setDnsMismatch] = useState<ApiError | null>(null);
  const [issued, setIssued] = useState<{ result: IssuanceSuccess; domain: string } | null>(
    null
  );
  /** The name the current operation is about; the form may be edited after a failure. */
  const [activeDomain, setActiveDomain] = useState('');

  const wildcard = domain.trim().startsWith('*.');

  const stages = activeDomain ? progress.byDomain[activeDomain] ?? {} : {};
  const failureView = sslFailureFrom(failure);
  const preflight = preflightFrom(failure);
  const successPreflight = issued ? preflightFrom(issued.result) : null;
  const showStages = connected && progress.heard && activeDomain !== '';
  const liveStages = showStages ? stages : {};

  useEffect(() => {
    if (!wildcard) return;
    setMethod('dns');
    setWww(false);
  }, [wildcard]);

  const dirty =
    domain.trim() !== initialDomain || email.trim() !== '' || www || method !== 'http';

  const issue = async () => {
    const errors: { domain?: string; email?: string } = {};
    const domainError = validateDomainName(domain.trim());
    if (domainError) errors.domain = domainError;
    const emailError = validateEmail(email.trim());
    if (emailError) errors.email = emailError;
    if (errors.domain || errors.email) {
      setFieldErrors(errors);
      queueMicrotask(() =>
        document.getElementById(errors.domain ? 'ssl-domain' : 'ssl-email')?.focus()
      );
      return;
    }

    setFieldErrors({});
    setFailure(null);
    setDnsMismatch(null);
    setIssuing(true);
    const target = domain.trim();
    setActiveDomain(target);
    progress.clear();
    try {
      const result = await api.ssl.create({
        domain: target,
        www: wildcard ? false : www,
        validationMethod: wildcard ? 'dns' : method,
        email: email.trim() || undefined,
        opId,
      });
      if (isDnsPending(result)) {
        setDnsPending(result);
        setPhase('dns');
        return;
      }
      setIssued({ result, domain: target });
      setPhase('success');
      onIssued(result, target);
    } catch (error) {
      setFailure(error);
    } finally {
      setIssuing(false);
    }
  };

  const confirmDns = async () => {
    if (!dnsPending) return;
    setDnsMismatch(null);
    setDnsConfirming(true);
    try {
      const result = await api.ssl.confirmDns(dnsPending.domain);
      const target = dnsPending.domain;
      setDnsPending(null);
      setIssued({ result, domain: target });
      setPhase('success');
      onIssued(result, target);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === 'dns_not_propagated' || error.code === 'dns_lookup_failed')
      ) {
        setDnsMismatch(error);
      } else {
        setDnsPending(null);
        setPhase('form');
        setFailure(error);
      }
    } finally {
      setDnsConfirming(false);
    }
  };

  const cancelDns = async () => {
    if (!dnsPending) return;
    setDnsConfirming(true);
    try {
      await api.ssl.cancelDns(dnsPending.domain);
      toast.info('DNS challenge cancelled', 'No certificate was issued.');
    } catch {
      toast.warning(
        'Could not cancel the DNS challenge',
        'It will expire on its own after ten minutes.'
      );
    } finally {
      setDnsPending(null);
      setDnsMismatch(null);
      setActiveDomain('');
      progress.clear();
      setPhase('form');
      setDnsConfirming(false);
    }
  };

  const resetForm = () => {
    setDomain('');
    setEmail('');
    setWww(false);
    setMethod('http');
    setFieldErrors({});
    setFailure(null);
    setDnsMismatch(null);
    setIssued(null);
    setActiveDomain('');
    progress.clear();
    setPhase('form');
  };

  const busy = issuing || dnsConfirming;

  const requestClose = async () => {
    if (busy) return;
    if (phase === 'dns' && dnsPending) {
      const ok = await confirm({
        title: 'Cancel the pending DNS challenge?',
        body: `No certificate will be issued for ${dnsPending.domain}. The TXT record can be removed afterwards.`,
        confirmLabel: 'Cancel challenge',
        cancelLabel: 'Keep waiting',
        tone: 'danger',
      });
      if (!ok) return;
      void api.ssl.cancelDns(dnsPending.domain).catch(() => {
        /* the pending challenge expires on its own */
      });
      onClose();
      return;
    }
    if (phase === 'form' && dirty) {
      const ok = await confirm({
        title: 'Discard this certificate request?',
        body: 'The form has not been submitted, so nothing has been issued.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        tone: 'danger',
      });
      if (!ok) return;
    }
    onClose();
  };

  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  const stableClose = useCallback(() => {
    void closeRef.current();
  }, []);

  const emailRequired = failure instanceof ApiError && failure.code === 'email_required';

  const title =
    phase === 'success' ? 'Certificate issued' : phase === 'dns' ? 'DNS validation' : 'New certificate';

  return (
    <Modal
      open
      onClose={stableClose}
      title={title}
      description={
        phase === 'form'
          ? 'Let’s Encrypt issues 90-day certificates. nginx keeps running unless the HTTP challenge has to fall back to standalone mode.'
          : undefined
      }
      size="lg"
      preventClose={busy}
      footer={
        phase === 'form' ? (
          <>
            <Button variant="ghost" onClick={stableClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={issuing}
              icon={<ShieldCheck className="size-3.5" aria-hidden="true" />}
              onClick={issue}
            >
              Issue certificate
            </Button>
          </>
        ) : phase === 'dns' ? (
          <>
            <Button variant="ghost" onClick={cancelDns} disabled={busy}>
              Cancel challenge
            </Button>
            <Button variant="primary" loading={dnsConfirming} onClick={confirmDns}>
              I’ve added the record
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={resetForm}>
              Issue another
            </Button>
            <Button variant="primary" onClick={stableClose}>
              Done
            </Button>
          </>
        )
      }
    >
      {phase === 'form' && (
        <div className="space-y-4">
          {activeDomain && (issuing || failure != null) && (
            <div className="space-y-2.5">
              {showStages ? (
                <StageList
                  stages={SSL_ISSUANCE_STAGES}
                  states={liveStages}
                  ariaLabel={`Certificate stages for ${activeDomain}`}
                  failure={failure != null ? failureView : null}
                  timedOut={failureView?.stage === 'timeout'}
                />
              ) : issuing ? (
                <p
                  role="status"
                  className="flex items-start gap-2 rounded-md border border-line bg-raised/40 px-3 py-2.5 text-xs text-muted"
                >
                  <Loader2 className="spin mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span className="break-words">
                    Issuing the certificate for{' '}
                    <span className="font-mono text-ink">{activeDomain}</span>. The live stage
                    list needs the dashboard’s connection; the result appears here when it
                    finishes.
                  </span>
                </p>
              ) : null}
              {preflight && <PreflightResult preflight={preflight} />}
            </div>
          )}

          {failure != null && (
            <div className="space-y-2">
              {!(showStages && failureView) && <IssuanceFailurePanel value={failure} />}
              {emailRequired && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onClose();
                    navigate('/settings');
                  }}
                >
                  Open settings
                </Button>
              )}
            </div>
          )}

          <TextInput
            id="ssl-domain"
            label="Domain name"
            placeholder="example.com"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            error={fieldErrors.domain}
            hint="An A or AAAA record for this name must point at this server for an HTTP challenge."
            list={KNOWN_DOMAINS_ID}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <datalist id={KNOWN_DOMAINS_ID}>
            {domains.map((entry) => (
              <option key={entry.name} value={entry.name} />
            ))}
          </datalist>

          <TextInput
            id="ssl-email"
            label="ACME email"
            optional
            type="email"
            placeholder="admin@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={fieldErrors.email}
            hint="Used by Let’s Encrypt for expiry notices. Falls back to the email saved in Settings."
            autoComplete="email"
            disabled={busy}
          />

          {wildcard && (
            <InlineAlert tone="info" title="Wildcard certificate">
              Wildcard names like <span className="font-mono">*.example.com</span> can only be
              validated with a DNS TXT record, so the DNS challenge is selected.
            </InlineAlert>
          )}

          <fieldset className="rounded-md border border-line p-3.5" disabled={busy}>
            <legend className="px-1 text-xs font-medium text-muted">Challenge method</legend>
            <div className="mt-1 space-y-2">
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border px-3.5 py-3 transition-colors',
                  method === 'http' && !wildcard
                    ? 'border-accent/60 bg-accent-soft'
                    : 'border-line hover:border-line-strong',
                  (wildcard || busy) && 'cursor-not-allowed opacity-60'
                )}
              >
                <input
                  type="radio"
                  name="ssl-method"
                  value="http"
                  checked={method === 'http' && !wildcard}
                  disabled={wildcard || busy}
                  onChange={() => setMethod('http')}
                  className="mt-0.5 size-4 accent-[var(--ez-accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink">HTTP challenge</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    nginx answers the ACME challenge on port 80, so it can keep running.
                  </span>
                </span>
              </label>

              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border px-3.5 py-3 transition-colors',
                  method === 'dns'
                    ? 'border-accent/60 bg-accent-soft'
                    : 'border-line hover:border-line-strong',
                  busy && 'cursor-not-allowed opacity-60'
                )}
              >
                <input
                  type="radio"
                  name="ssl-method"
                  value="dns"
                  checked={method === 'dns'}
                  disabled={busy}
                  onChange={() => setMethod('dns')}
                  className="mt-0.5 size-4 accent-[var(--ez-accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink">DNS challenge</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    You add a TXT record at your DNS provider. Works for names that do not
                    point at this server yet.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <Checkbox
            checked={www && !wildcard}
            onChange={setWww}
            disabled={wildcard || busy}
            label={
              domain.trim()
                ? `Also cover www.${domain.trim().replace(/^\*\./, '')}`
                : 'Also cover the www subdomain'
            }
            hint={
              wildcard
                ? 'A wildcard certificate already covers every subdomain.'
                : 'Both names are added to the same certificate.'
            }
          />
        </div>
      )}

      {phase === 'dns' && dnsPending && (
        <div className="space-y-4">
          {showStages && (
            <StageList
              stages={SSL_ISSUANCE_STAGES}
              states={liveStages}
              ariaLabel={`Certificate stages for ${activeDomain || dnsPending.domain}`}
            />
          )}
          <InlineAlert tone="warning" title="Add this DNS TXT record">
            Create the record at your DNS provider, then confirm. The challenge waits up to ten
            minutes; nothing is written to nginx while it waits.
          </InlineAlert>

          <dl className="space-y-2.5 rounded-md border border-line bg-raised/40 p-3.5">
            <div className="flex items-start gap-2">
              <dt className="w-16 shrink-0 pt-0.5 text-2xs text-faint">Name</dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-xs text-ink">
                {dnsPending.txtName}
              </dd>
              <CopyButton value={dnsPending.txtName} label="Copy record name" />
            </div>
            <div className="flex items-start gap-2 border-t border-line pt-2.5">
              <dt className="w-16 shrink-0 pt-0.5 text-2xs text-faint">Value</dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-xs text-ink">
                {dnsPending.txtValue}
              </dd>
              <CopyButton value={dnsPending.txtValue} label="Copy record value" />
            </div>
          </dl>

          <p className="text-xs text-faint">
            DNS changes can take a few minutes to propagate. Confirming checks that the value is
            publicly visible before Let’s Encrypt does.
          </p>

          {dnsMismatch && <DnsMismatchAlert error={dnsMismatch} />}
        </div>
      )}

      {phase === 'success' && issued && (
        <div className="space-y-4">
          {showStages && (
            <StageList
              stages={SSL_ISSUANCE_STAGES}
              states={liveStages}
              ariaLabel={`Certificate stages for ${issued.domain}`}
            />
          )}
          <IssuanceSuccessPanel result={issued.result} title={`Certificate issued for ${issued.domain}`} />
          {successPreflight && <PreflightResult preflight={successPreflight} />}
          <div className="flex items-start gap-2 text-xs text-muted">
            <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden="true" />
            <p>
              The files are on disk. To serve them, edit a domain, enable SSL and use these
              paths.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-line bg-raised/40 px-3.5 py-2.5 text-xs text-muted">
            <KeyRound className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
            Rename or move these files only after updating the domain config; nginx reads them
            by path.
          </div>
        </div>
      )}
    </Modal>
  );
}
