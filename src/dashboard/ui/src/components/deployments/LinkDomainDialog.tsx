import { useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { useRealtime } from '../../app/RealtimeProvider';
import { useSslProgress } from '../../hooks/useSslProgress';
import {
  LINK_DOMAIN_EXISTING_STAGES,
  LINK_DOMAIN_ISSUE_STAGES,
  LINK_DOMAIN_NO_SSL_STAGES,
  linkResultStages,
  newSslOpId,
  preflightFrom,
  sslFailureFrom,
} from '../../lib/sslProgress';
import type {
  DeployAppDetail,
  DeployDomainLink,
  DeploySslMode,
  DeploymentsResponse,
  SslSuggestion,
} from '../../lib/types';
import { cn } from '../../lib/cn';
import { Button } from '../ui/Button';
import { Checkbox, Switch, TextInput } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { InlineAlert } from '../ui/States';
import { useToast } from '../ui/Toast';
import { PreflightResult } from '../ssl/PreflightResult';
import { StageList } from '../ssl/StageList';

const NAME_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const WILDCARD_ISSUE_MESSAGE =
  'A new wildcard certificate needs DNS validation, which linking does not do. Issue it from the SSL page, then link with an existing certificate.';

const SSL_OPTIONS: Array<{ mode: DeploySslMode; label: string; hint: string }> = [
  { mode: 'issue', label: "Issue a new Let's Encrypt certificate", hint: 'Over HTTP-01, so the domain must already point here.' },
  { mode: 'existing', label: 'Use an existing certificate', hint: 'A certificate already stored on this server.' },
  { mode: 'none', label: 'No SSL', hint: 'The domain is served over HTTP only.' },
];

/**
 * Linking a domain to an app, with the same choices as the Add-domain form:
 * www, the certificate to use and the HTTP redirect. Issuance is synchronous
 * here — the request answers when Let's Encrypt has finished.
 */
export function LinkDomainDialog({
  open,
  app,
  meta,
  onClose,
  onLinked,
}: {
  open: boolean;
  app: DeployAppDetail;
  meta: DeploymentsResponse;
  onClose: () => void;
  onLinked: () => void;
}) {
  const toast = useToast();
  const { connected } = useRealtime();
  // The id exists before the first render and useSslProgress subscribes on
  // mount, so the first `ssl:progress` frame cannot be missed (it is not
  // replayed). The server echoes this value in the link response.
  const [opId] = useState(() => newSslOpId());
  const progress = useSslProgress(opId);
  const [name, setName] = useState('');
  const [www, setWww] = useState(false);
  const [mode, setMode] = useState<DeploySslMode>('issue');
  const [redirect, setRedirect] = useState(true);
  const [behindCloudflare, setBehindCloudflare] = useState(false);
  const [suggestion, setSuggestion] = useState<SslSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<DeployDomainLink | null>(null);

  const domain = name.trim().toLowerCase();
  const wildcard = domain.startsWith('*.');
  const validName = NAME_RE.test(domain);
  const found = suggestion?.found === true ? suggestion : null;

  // The contract's link-domain stages; which ones exist depends on the SSL
  // choice. The PUT publishes `ssl:progress` with this opId and the linked
  // name, so every frame here belongs to this dialog.
  const stageDefs =
    mode === 'issue'
      ? LINK_DOMAIN_ISSUE_STAGES
      : mode === 'existing'
        ? LINK_DOMAIN_EXISTING_STAGES
        : LINK_DOMAIN_NO_SSL_STAGES;
  const clearProgress = progress.clear;
  const domainStages = progress.byDomain[domain] ?? {};
  const heard = connected && Object.keys(domainStages).length > 0;
  const liveStages = heard ? domainStages : null;
  const finalStages = useMemo(
    () => (result ? linkResultStages(result, stageDefs) : null),
    [result, stageDefs]
  );
  const linkFailure = error != null ? sslFailureFrom(error) : null;
  const linkErrorText =
    linkFailure?.message ??
    (error instanceof Error ? error.message : null) ??
    (error != null ? 'Nothing was changed.' : null);
  const preflight = useMemo(
    () => preflightFrom(error) ?? preflightFrom(result),
    [error, result]
  );

  useEffect(() => {
    if (!open) return;
    setName('');
    setWww(false);
    setMode('issue');
    setRedirect(true);
    setBehindCloudflare(false);
    setSuggestion(null);
    setLinking(false);
    setError(null);
    setResult(null);
    clearProgress();
  }, [open, app.id, clearProgress]);

  // Look up a certificate for the typed name only while "existing" is chosen;
  // typing a name should not send a request on every keystroke. A leading `*.`
  // is accepted: the server looks up the certificate that lists it.
  useEffect(() => {
    if (!open || mode !== 'existing' || !validName) {
      setSuggestion(null);
      setSuggesting(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSuggesting(true);
      api.domains
        .sslSuggestion(domain, controller.signal)
        .then((answer) => {
          if (!controller.signal.aborted) setSuggestion(answer);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSuggestion(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSuggesting(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, mode, domain, validName]);

  const existingUsable =
    found !== null &&
    (!wildcard ||
      [found.certificate.domain, ...found.certificate.names].some(
        (certName) => certName.trim().toLowerCase() === domain
      ));
  const issueBlocked = wildcard && mode === 'issue';
  const needsPort = !app.settings.port && !app.currentRelease;
  const canLink =
    validName &&
    !needsPort &&
    !linking &&
    !issueBlocked &&
    (mode !== 'existing' || existingUsable);

  const link = async () => {
    if (!canLink || linking) return;
    clearProgress();
    setLinking(true);
    setError(null);
    setResult(null);
    try {
      const answer = await api.deployments.linkDomain(app.id, {
        domain,
        www: wildcard ? false : www,
        ssl:
          mode === 'issue'
            ? { mode: 'issue' }
            : mode === 'existing' && found
              ? { mode: 'existing', certName: found.certificate.domain }
              : { mode: 'none' },
        redirect: mode === 'none' ? undefined : redirect,
        behindCloudflare,
        opId,
      });
      setResult(answer);
      onLinked();
      if (answer.ssl && !answer.ssl.ok) {
        // The link stands; only the certificate is missing.
      } else if (!answer.nginxReloaded) {
        toast.warning('Linked, but nginx was not reloaded', 'Reload nginx for it to take effect.');
      } else {
        toast.success('Domain linked', `${answer.domain} now proxies to port ${answer.port}.`);
      }
    } catch (err) {
      setError(err);
    } finally {
      setLinking(false);
    }
  };

  const busyText =
    mode === 'issue' && linking
      ? 'Issuing the certificate, this can take a minute'
      : linking
        ? 'Linking the domain'
        : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      preventClose={linking}
      size="md"
      title={app.domain ? 'Link a different domain' : 'Link a domain'}
      description={`Point a domain at ${app.id}. nginx proxies it to the app’s port.`}
      footer={
        result ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={linking}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void link()} loading={linking} disabled={!canLink}>
              Link domain
            </Button>
          </>
        )
      }
    >
      <div className="space-y-5">
        <TextInput
          label="Domain name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setResult(null);
            setError(null);
            clearProgress();
          }}
          placeholder="app.example.com"
          list="link-domain-options"
          hint={
            !domain
              ? 'Type a new name, or pick one of your domains.'
              : meta.domains.some((d) => d.name === domain)
                ? 'This domain exists. It will be re-pointed at this app.'
                : 'This domain will be created.'
          }
          className="font-mono"
          spellCheck={false}
          autoComplete="off"
          disabled={Boolean(result)}
        />
        <datalist id="link-domain-options">
          {meta.domains.map((d) => (
            <option key={d.name} value={d.name} />
          ))}
        </datalist>

        <Checkbox
          label="Also serve www"
          hint={wildcard ? 'A wildcard already covers the www name.' : `Adds www.${domain || 'example.com'}.`}
          checked={www}
          onChange={setWww}
          disabled={wildcard || Boolean(result)}
        />

        <fieldset disabled={Boolean(result)}>
          <legend className="mb-2 text-xs font-medium text-muted">SSL</legend>
          <div className="space-y-2">
            {SSL_OPTIONS.map((option) => {
              const disabled =
                Boolean(result) ||
                (option.mode === 'issue' && wildcard) ||
                (option.mode === 'existing' && !suggesting && !existingUsable);
              return (
                <label
                  key={option.mode}
                  className={cn(
                    'flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 text-xs',
                    mode === option.mode ? 'border-accent/50 bg-accent-soft/40' : 'border-line hover:border-line-strong',
                    disabled && 'cursor-not-allowed opacity-60'
                  )}
                >
                  <input
                    type="radio"
                    name="link-domain-ssl"
                    value={option.mode}
                    checked={mode === option.mode}
                    disabled={disabled}
                    onChange={() => setMode(option.mode)}
                    className="mt-0.5 accent-[var(--ez-accent)]"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 font-medium text-ink">
                      {option.mode !== 'none' ? <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" /> : null}
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-2xs text-faint">
                      {option.mode === 'existing' && !domain
                        ? 'Type the domain name above first.'
                        : option.mode === 'existing' && suggesting
                          ? 'Looking for a certificate…'
                          : option.mode === 'existing' && validName && !existingUsable
                            ? wildcard
                              ? 'No certificate on this server lists this wildcard name.'
                              : 'No certificate on this server covers this name.'
                            : option.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {wildcard && mode === 'issue' ? (
            <p className="mt-2 text-2xs text-warn">{WILDCARD_ISSUE_MESSAGE}</p>
          ) : null}
          {mode === 'issue' && !wildcard ? (
            <p className="mt-2 text-2xs text-faint">
              If issuance fails the domain still works over HTTP; you can issue the certificate
              later from the SSL page.
            </p>
          ) : null}
        </fieldset>

        {mode === 'existing' && found && existingUsable ? (
          <div className="rounded-md border border-accent/40 bg-accent-soft/30 p-3">
            <div className="text-xs font-medium text-ink">
              {wildcard
                ? `The certificate in ${found.certificate.domain} lists ${domain}`
                : found.match === 'exact'
                  ? `A certificate for ${domain} already exists`
                  : found.match === 'wildcard'
                    ? `A wildcard certificate covers ${domain}`
                    : `The certificate in ${found.certificate.domain} covers ${domain}`}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted">
              <span className="font-mono">{found.certificate.domain}</span>
              <span>
                {found.certificate.daysLeft === null
                  ? 'expiry unknown'
                  : found.certificate.daysLeft <= 0
                    ? 'expired'
                    : `${found.certificate.daysLeft} days left`}
              </span>
            </div>
            {found.certificate.names.length > 1 ? (
              <p className="mt-1 break-all text-2xs text-faint">
                covers {found.certificate.names.join(', ')}
              </p>
            ) : null}
          </div>
        ) : null}

        {mode !== 'none' && !result ? (
          <Switch
            checked={redirect}
            onChange={setRedirect}
            label="Redirect HTTP to HTTPS"
            description="Port 80 requests are sent to the HTTPS address."
            disabled={Boolean(result)}
          />
        ) : null}

        <Checkbox
          label="Behind Cloudflare"
          hint="Only when Cloudflare proxies this domain (the orange cloud). The server then reads the visitor’s address from CF-Connecting-IP."
          checked={behindCloudflare}
          onChange={setBehindCloudflare}
          disabled={Boolean(result)}
        />

        {needsPort && !result ? (
          <InlineAlert tone="info">
            The app needs a port first: set one in Edit, or put <code className="font-mono">port</code>{' '}
            in ez.json and deploy once.
          </InlineAlert>
        ) : null}

        {liveStages ? (
          <StageList
            stages={stageDefs}
            states={liveStages}
            ariaLabel={`Linking stages for ${domain}`}
            failure={linkFailure}
            timedOut={linkFailure?.stage === 'timeout'}
          />
        ) : busyText ? (
          <p className="flex items-start gap-2 text-xs text-muted" aria-live="polite">
            <Loader2 className="spin mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {busyText}.{' '}
              {connected
                ? 'The live stage list appears when the server reports its stages; the result is shown here when it finishes.'
                : 'This finishes in one request; the result appears here.'}
            </span>
          </p>
        ) : null}

        {!liveStages && finalStages ? (
          <StageList
            stages={stageDefs}
            states={finalStages}
            ariaLabel={`Link result stages for ${domain}`}
          />
        ) : null}

        {preflight && <PreflightResult preflight={preflight} />}

        {error && !liveStages && !finalStages ? (
          <InlineAlert tone="danger" title="The domain was not linked">
            {linkErrorText}
          </InlineAlert>
        ) : null}

        {result ? (
          result.ssl && !result.ssl.ok ? (
            <InlineAlert tone="warning" title="Linked, without a certificate">
              {result.domain} now proxies to port {result.port}, but the certificate was not
              issued: {result.ssl.detail} It works over HTTP until you issue the certificate from
              the SSL page.
            </InlineAlert>
          ) : (
            <InlineAlert tone="success" title={result.created ? 'Domain created and linked' : 'Domain linked'}>
              {result.domain} now proxies to port {result.port}.
              {result.ssl?.ok ? ` ${result.ssl.detail}` : ' It is served over HTTP.'}
              {!result.nginxReloaded ? ' nginx was not reloaded yet; reload it for this to take effect.' : ''}
            </InlineAlert>
          )
        ) : null}
      </div>
    </Modal>
  );
}
