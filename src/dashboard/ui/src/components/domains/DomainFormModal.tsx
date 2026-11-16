import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  ChevronDown,
  Code2,
  Gauge,
  Globe2,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import type {
  DnsChallengePending,
  Domain,
  DomainAdvanced,
  DomainEventType,
  DomainInput,
  DomainNotifications,
  DomainPerformance,
  DomainSecurity,
  DomainSsl,
  IssuanceSuccess,
  NotificationChannel,
  UpstreamType,
} from '../../lib/types';
import {
  validateDomainName,
  validateMaxBodySize,
  validatePort,
  validatePositiveInteger,
} from '../../lib/validation';
import { useConfirm, useResource } from '../../hooks/useResource';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import {
  FieldHint,
  FormGrid,
  Select,
  Switch,
  TextArea,
  TextInput,
} from '../ui/Field';
import { InlineAlert, Skeleton } from '../ui/States';
import { useToast } from '../ui/Toast';

const DEFAULT_GZIP_TYPES =
  'text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript';

export type DomainEditor = { mode: 'create' } | { mode: 'edit'; domain: Domain };

const NOTIFICATION_EVENTS: {
  id: DomainEventType;
  label: string;
  description: string;
}[] = [
  {
    id: 'domain_health',
    label: 'Port / health check',
    description: 'The backend stops answering its health check.',
  },
  {
    id: 'cert_expiry',
    label: 'SSL / certificate expiry',
    description: 'A certificate is expired or close to expiry.',
  },
  {
    id: 'nginx_down',
    label: 'nginx stopped',
    description: 'nginx itself is not serving requests.',
  },
];

const EMPTY_NOTIFICATIONS = (): DomainNotifications => ({
  domain_health: { enabled: true, channelIds: [] },
  cert_expiry: { enabled: true, channelIds: [] },
  nginx_down: { enabled: true, channelIds: [] },
});

function defaults(): DomainInput {
  return {
    name: '',
    port: 3000,
    backendHost: '127.0.0.1',
    upstreamType: 'http',
    www: false,
    wildcard: false,
    enabled: true,
    ssl: {
      enabled: false,
      certPath: '',
      keyPath: '',
      redirect: true,
      hsts: false,
      hstsMaxAge: 31_536_000,
    },
    performance: {
      maxBodySize: '10m',
      readTimeout: 60,
      connectTimeout: 10,
      proxyBuffers: false,
      gzip: true,
      gzipTypes: DEFAULT_GZIP_TYPES,
    },
    security: {
      rateLimit: false,
      rateLimitRate: 10,
      rateLimitBurst: 20,
      securityHeaders: false,
      custom404: false,
      custom50x: false,
    },
    advanced: { accessLog: true, customLocations: '' },
    notifications: EMPTY_NOTIFICATIONS(),
  };
}

function formFromDomain(domain: Domain): DomainInput {
  const notifications = EMPTY_NOTIFICATIONS();
  for (const event of NOTIFICATION_EVENTS) {
    const stored = domain.notifications?.[event.id];
    if (stored) {
      notifications[event.id] = {
        enabled: stored.enabled,
        channelIds: [...(stored.channelIds ?? [])],
      };
    }
  }

  return {
    name: domain.name,
    port: domain.port,
    backendHost: domain.backendHost || '127.0.0.1',
    upstreamType: domain.upstreamType || 'http',
    www: domain.www,
    wildcard: domain.wildcard,
    enabled: domain.enabled,
    ssl: {
      enabled: Boolean(domain.ssl?.enabled),
      certPath: domain.ssl?.certPath ?? '',
      keyPath: domain.ssl?.keyPath ?? '',
      redirect: domain.ssl?.redirect ?? true,
      hsts: domain.ssl?.hsts ?? false,
      hstsMaxAge: domain.ssl?.hstsMaxAge || 31_536_000,
    },
    performance: { ...domain.performance },
    security: { ...domain.security },
    advanced: { ...domain.advanced },
    notifications,
  };
}

const TYPE_LABEL: Record<UpstreamType, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  ws: 'WebSocket',
};

function normalizeName(name: string): string {
  return name.trim().replace(/^\*\./, '');
}

function isDnsPending(
  result: IssuanceSuccess | DnsChallengePending
): result is DnsChallengePending {
  return 'status' in result && result.status === 'waiting_dns';
}

function validateForm(form: DomainInput, isNew: boolean): Record<string, string> {
  const errors: Record<string, string> = {};

  if (isNew) {
    const nameError = validateDomainName(normalizeName(form.name));
    if (nameError) errors['domain-name'] = nameError;
  }
  if (!form.backendHost.trim()) {
    errors['backend-host'] = 'A backend host or URL is required.';
  }
  const backendIsUrl = /^https?:\/\//i.test(form.backendHost.trim());
  if (!backendIsUrl) {
    const portError = validatePort(form.port);
    if (portError) errors['backend-port'] = portError;
  }
  const bodyError = validateMaxBodySize(form.performance.maxBodySize);
  if (bodyError) errors['max-body'] = bodyError;
  const readError = validatePositiveInteger(form.performance.readTimeout, 'Read timeout');
  if (readError) errors['read-timeout'] = readError;
  const connectError = validatePositiveInteger(
    form.performance.connectTimeout,
    'Connect timeout'
  );
  if (connectError) errors['connect-timeout'] = connectError;

  if (form.ssl.enabled && form.ssl.hsts) {
    const hstsError = validatePositiveInteger(form.ssl.hstsMaxAge, 'HSTS max-age');
    if (hstsError) errors['hsts-max-age'] = hstsError;
  }
  if (form.security.rateLimit) {
    const rateError = validatePositiveInteger(form.security.rateLimitRate, 'Rate');
    if (rateError) errors['rate-limit-rate'] = rateError;
    const burstError = validatePositiveInteger(form.security.rateLimitBurst, 'Burst');
    if (burstError) errors['rate-limit-burst'] = burstError;
  }

  return errors;
}

interface CertMissing {
  certPath: string;
  keyPath: string;
  hint: string;
}

interface CertFailure {
  message: string;
  detail?: string;
  hint?: string;
}

function describeCertFailure(error: unknown): CertFailure {
  if (error instanceof ApiError) {
    const payloadError = error.payload.error;
    if (payloadError && typeof payloadError === 'object') {
      const detail = [
        payloadError.step ? `Step: ${payloadError.step}` : '',
        payloadError.cause ? `Cause: ${payloadError.cause}` : '',
        payloadError.consequence ? `Note: ${payloadError.consequence}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        message: 'Certificate creation failed',
        detail: detail || 'The certificate authority did not issue a certificate.',
        hint: 'nginx is left as it was.',
      };
    }
    const hint =
      error.code === 'email_required'
        ? 'Set the ACME email in Settings → General, then try again.'
        : typeof error.payload.hint === 'string'
          ? error.payload.hint
          : undefined;
    const rawDetail =
      typeof error.payload.detail === 'string'
        ? error.payload.detail
        : typeof error.payload.output === 'string'
          ? error.payload.output
          : undefined;
    return { message: 'Certificate creation failed', detail: rawDetail ?? error.message, hint };
  }
  return {
    message: 'Certificate creation failed',
    detail: error instanceof Error ? error.message : 'The request could not be completed.',
  };
}

function FormSection({
  id,
  title,
  description,
  icon: Icon,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-line last:border-b-0">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`section-${id}`}
          onClick={onToggle}
          className="group flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors duration-[var(--ez-motion-fast)] hover:bg-raised/50"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-inset text-muted transition-colors group-hover:text-ink">
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink">{title}</span>
            <span className="mt-0.5 block text-xs text-muted">{description}</span>
          </span>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-faint transition-transform duration-[var(--ez-motion-fast)]',
              open && 'rotate-180'
            )}
            aria-hidden="true"
          />
        </button>
      </h3>
      {open && (
        <div id={`section-${id}`} className="px-5 pb-5 pt-1">
          {children}
        </div>
      )}
    </section>
  );
}

function ChannelChip({
  channel,
  checked,
  onChange,
}: {
  channel: NotificationChannel;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors duration-[var(--ez-motion-fast)]',
        checked
          ? 'border-accent/50 bg-accent-soft/50 text-ink'
          : 'border-line text-muted hover:border-line-strong hover:text-ink'
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3.5 shrink-0 accent-[var(--ez-accent)]"
      />
      <span className="font-medium">{channel.name}</span>
      <span className="text-2xs text-faint">{channel.type}</span>
    </label>
  );
}

const numeric = (value: number): number | '' => (Number.isFinite(value) && value !== 0 ? value : '');

export function DomainFormModal({
  editor,
  onClose,
  onSaved,
}: {
  editor: DomainEditor;
  onClose: () => void;
  onSaved: (domain: Domain) => void;
}) {
  const editing = editor.mode === 'edit' ? editor.domain : null;
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const formId = useId();

  const [form, setForm] = useState<DomainInput>(() =>
    editing ? formFromDomain(editing) : defaults()
  );
  const initial = useRef(JSON.stringify(form));
  const dirty = JSON.stringify(form) !== initial.current;

  const [sections, setSections] = useState<Record<string, boolean>>(() =>
    editing
      ? {
          basic: true,
          ssl: true,
          performance: true,
          security: true,
          advanced: true,
          notifications: true,
        }
      : {
          basic: true,
          ssl: true,
          performance: false,
          security: false,
          advanced: false,
          notifications: false,
        }
  );

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<CertFailure | null>(null);
  const [saving, setSaving] = useState(false);

  const [certMissing, setCertMissing] = useState<CertMissing | null>(null);
  const [certMethod, setCertMethod] = useState<'http' | 'dns'>('http');
  const [certFailure, setCertFailure] = useState<CertFailure | null>(null);
  const [dnsPending, setDnsPending] = useState<DnsChallengePending | null>(null);
  const [certAction, setCertAction] = useState<'issue' | 'confirm' | null>(null);

  const channels = useResource<NotificationChannel[]>(
    (signal) => api.settings.channels.list(signal),
    [],
    { enabled: Boolean(editing) }
  );

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (certMissing && form.wildcard) setCertMethod('dns');
  }, [certMissing, form.wildcard]);

  const backendIsUrl = /^https?:\/\//i.test(form.backendHost.trim());

  function update<K extends keyof DomainInput>(key: K, value: DomainInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  function updateSsl<K extends keyof DomainSsl>(key: K, value: DomainSsl[K]) {
    setForm((current) => ({ ...current, ssl: { ...current.ssl, [key]: value } }));
  }
  function updatePerformance<K extends keyof DomainPerformance>(
    key: K,
    value: DomainPerformance[K]
  ) {
    setForm((current) => ({
      ...current,
      performance: { ...current.performance, [key]: value },
    }));
  }
  function updateSecurity<K extends keyof DomainSecurity>(key: K, value: DomainSecurity[K]) {
    setForm((current) => ({ ...current, security: { ...current.security, [key]: value } }));
  }
  function updateAdvanced<K extends keyof DomainAdvanced>(key: K, value: DomainAdvanced[K]) {
    setForm((current) => ({ ...current, advanced: { ...current.advanced, [key]: value } }));
  }
  function setNotification(
    type: DomainEventType,
    patch: Partial<DomainNotifications[DomainEventType]>
  ) {
    setForm((current) => ({
      ...current,
      notifications: {
        ...current.notifications,
        [type]: { ...current.notifications[type], ...patch },
      },
    }));
  }
  function toggleChannel(type: DomainEventType, channelId: string, checked: boolean) {
    setForm((current) => {
      const routing = current.notifications[type];
      const channelIds = checked
        ? Array.from(new Set([...routing.channelIds, channelId]))
        : routing.channelIds.filter((id) => id !== channelId);
      return {
        ...current,
        notifications: {
          ...current.notifications,
          [type]: { ...routing, channelIds },
        },
      };
    });
  }

  const expandSection = (id: string) =>
    setSections((current) => ({ ...current, [id]: true }));

  const submit = async (overrides?: Partial<DomainInput>) => {
    const payload: DomainInput = {
      ...form,
      ...overrides,
      ssl: { ...form.ssl, ...(overrides?.ssl ?? {}) },
      name: editing ? editing.name : normalizeName(form.name),
    };

    const errors = validateForm(payload, !editing);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setSaveError({ message: 'Check the highlighted fields before saving.' });
      if (errors['domain-name'] || errors['backend-host'] || errors['backend-port']) {
        expandSection('basic');
      }
      if (errors['max-body'] || errors['read-timeout'] || errors['connect-timeout']) {
        expandSection('performance');
      }
      if (errors['rate-limit-rate'] || errors['rate-limit-burst']) {
        expandSection('security');
      }
      if (errors['hsts-max-age']) expandSection('ssl');
      const firstId = Object.keys(errors)[0];
      queueMicrotask(() => document.getElementById(firstId)?.focus());
      return;
    }

    setFieldErrors({});
    setSaveError(null);
    setSaving(true);
    try {
      const saved = editing
        ? await api.domains.update(editing.name, payload)
        : await api.domains.create(payload);
      setCertMissing(null);
      setDnsPending(null);
      setCertFailure(null);
      toast.success(
        editing ? 'Domain saved' : 'Domain created',
        editing
          ? `${saved.name} was updated and its nginx config regenerated.`
          : `${saved.name} is configured; nginx will start serving it on the next reload.`
      );
      onSaved(saved);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.status === 422 && apiError.code === 'cert_missing') {
        setCertMissing({
          certPath:
            typeof apiError.payload.certPath === 'string' ? apiError.payload.certPath : '',
          keyPath: typeof apiError.payload.keyPath === 'string' ? apiError.payload.keyPath : '',
          hint:
            typeof apiError.payload.hint === 'string'
              ? apiError.payload.hint
              : 'The SSL certificate files do not exist at the configured paths.',
        });
        setCertFailure(null);
        setDnsPending(null);
        setSaveError(null);
        setCertMethod(form.wildcard ? 'dns' : 'http');
        expandSection('ssl');
      } else {
        setSaveError({
          message: apiError?.message ?? 'The domain could not be saved.',
          detail:
            typeof apiError?.payload.detail === 'string'
              ? apiError.payload.detail
              : typeof apiError?.payload.output === 'string'
                ? apiError.payload.output
                : undefined,
          hint:
            typeof apiError?.payload.hint === 'string' ? apiError.payload.hint : undefined,
        });
        toast.error('Could not save the domain', apiError?.message ?? undefined);
      }
    } finally {
      setSaving(false);
    }
  };

  const createCertificate = async () => {
    setCertAction('issue');
    setCertFailure(null);
    try {
      const domainName = editing ? editing.name : normalizeName(form.name);
      const result = await api.ssl.create({
        domain: domainName,
        www: form.www,
        validationMethod: certMethod,
      });
      if (isDnsPending(result)) {
        setDnsPending(result);
        return;
      }
      setCertMissing(null);
      setDnsPending(null);
      await submit({
        ssl: { ...form.ssl, enabled: true, certPath: result.certPath, keyPath: result.keyPath },
      });
    } catch (error) {
      setCertFailure(describeCertFailure(error));
    } finally {
      setCertAction(null);
    }
  };

  const confirmDns = async () => {
    if (!dnsPending) return;
    setCertAction('confirm');
    setCertFailure(null);
    try {
      const result = await api.ssl.confirmDns(dnsPending.domain);
      setDnsPending(null);
      setCertMissing(null);
      await submit({
        ssl: { ...form.ssl, enabled: true, certPath: result.certPath, keyPath: result.keyPath },
      });
    } catch (error) {
      setCertFailure(describeCertFailure(error));
      setDnsPending(null);
    } finally {
      setCertAction(null);
    }
  };

  const cancelDns = async () => {
    if (!dnsPending) return;
    setCertAction('confirm');
    try {
      await api.ssl.cancelDns(dnsPending.domain);
      toast.info('DNS challenge cancelled', 'No certificate was requested.');
    } catch {
      toast.warning('Could not cancel the DNS challenge');
    } finally {
      setDnsPending(null);
      setCertAction(null);
    }
  };

  const disableSsl = () => {
    const ssl = { ...form.ssl, enabled: false };
    setForm((current) => ({ ...current, ssl }));
    setCertMissing(null);
    setCertFailure(null);
    setDnsPending(null);
    void submit({ ssl });
  };

  const dismissCertPanel = () => {
    setCertMissing(null);
    setCertFailure(null);
    setDnsPending(null);
  };

  const busy = saving || certAction !== null;

  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirty) return true;
    return confirm({
      title: 'Discard changes?',
      body: 'The changes to this domain have not been saved.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      tone: 'danger',
    });
  };

  const abandonDns = () => {
    if (!dnsPending) return;
    void api.ssl.cancelDns(dnsPending.domain).catch(() => {
      /* the pending challenge expires on its own */
    });
  };

  const requestClose = async () => {
    if (busy) return;
    if (!(await confirmDiscard())) return;
    abandonDns();
    onClose();
  };

  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  const stableClose = useCallback(() => {
    void closeRef.current();
  }, []);

  const goToSettings = async () => {
    if (busy) return;
    if (!(await confirmDiscard())) return;
    abandonDns();
    onClose();
    navigate('/settings');
  };

  return (
    <Modal
      open
      onClose={stableClose}
      title={editing ? `Edit ${editing.name}` : 'New domain'}
      description="Changes are written to nginx, tested, and rolled back automatically if nginx rejects them."
      size="xl"
      preventClose={busy}
      bodyClassName="px-0 py-0"
      footer={
        <>
          <span className="mr-auto hidden text-2xs text-faint sm:block">
            {editing ? 'The domain name cannot change after creation.' : 'The domain is enabled as soon as it is created.'}
          </span>
          <Button variant="ghost" onClick={stableClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={saving}
            disabled={certAction !== null}
          >
            {editing ? 'Save changes' : 'Create domain'}
          </Button>
        </>
      }
    >
      {(saveError || certMissing) && (
        <div className="space-y-3 border-b border-line px-5 py-4">
          {saveError && !certMissing && (
            <InlineAlert tone="danger" title={saveError.message}>
              {saveError.hint && <div>{saveError.hint}</div>}
              {saveError.detail && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs text-muted">
                  {saveError.detail}
                </pre>
              )}
            </InlineAlert>
          )}

          {certMissing && (
            <>
              <InlineAlert
                tone="warning"
                title="SSL certificate not found"
                action={
                  <Button variant="ghost" size="sm" onClick={dismissCertPanel} disabled={busy}>
                    Keep editing
                  </Button>
                }
              >
                <div className="space-y-1">
                  <div className="break-all font-mono text-2xs">
                    {certMissing.certPath || certMissing.keyPath}
                  </div>
                  <div>{certMissing.hint}</div>
                  <div>
                    Issue a certificate now, disable SSL for this domain, or point the paths at
                    files that already exist.
                  </div>
                </div>
              </InlineAlert>

              <div className="rounded-md border border-line bg-raised/40 p-3">
                {dnsPending ? (
                  <div className="space-y-3">
                    <div>
                      <div className="text-sm font-medium text-ink">
                        Add this DNS TXT record, then continue
                      </div>
                      <p className="mt-0.5 text-xs text-muted">
                        {dnsPending.hint ??
                          'The certificate authority checks this record before issuing the certificate.'}
                      </p>
                    </div>
                    <div className="space-y-2 rounded-md border border-line bg-canvas p-3 font-mono text-2xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-sans text-2xs uppercase tracking-wider text-faint">
                            Name
                          </div>
                          <div className="mt-0.5 break-all text-ink">{dnsPending.txtName}</div>
                        </div>
                        <CopyButton value={dnsPending.txtName} label="Copy record name" />
                      </div>
                      <div className="flex items-center justify-between gap-2 border-t border-line pt-2">
                        <div className="min-w-0">
                          <div className="font-sans text-2xs uppercase tracking-wider text-faint">
                            Value
                          </div>
                          <div className="mt-0.5 break-all text-ink">{dnsPending.txtValue}</div>
                        </div>
                        <CopyButton value={dnsPending.txtValue} label="Copy record value" />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        loading={certAction === 'confirm'}
                        onClick={confirmDns}
                      >
                        I added the record, continue
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={cancelDns}
                        disabled={certAction !== null}
                      >
                        Cancel issuance
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {certFailure && (
                      <InlineAlert tone="danger" title={certFailure.message}>
                        {certFailure.hint && <div>{certFailure.hint}</div>}
                        {certFailure.detail && (
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs">
                            {certFailure.detail}
                          </pre>
                        )}
                      </InlineAlert>
                    )}

                    <fieldset>
                      <legend className="mb-2 text-xs font-medium text-muted">
                        Validation method
                      </legend>
                      <div className="flex flex-wrap gap-2">
                        <label
                          className={cn(
                            'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs',
                            certMethod === 'http'
                              ? 'border-accent/50 bg-accent-soft/40'
                              : 'border-line hover:border-line-strong',
                            form.wildcard && 'cursor-not-allowed opacity-50'
                          )}
                        >
                          <input
                            type="radio"
                            name="cert-method"
                            value="http"
                            checked={certMethod === 'http'}
                            disabled={form.wildcard || busy}
                            onChange={() => setCertMethod('http')}
                            className="mt-0.5 accent-[var(--ez-accent)]"
                          />
                          <span>
                            <span className="block font-medium text-ink">HTTP challenge</span>
                            <span className="block text-2xs text-faint">
                              DNS already points here
                            </span>
                          </span>
                        </label>
                        <label
                          className={cn(
                            'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs',
                            certMethod === 'dns'
                              ? 'border-accent/50 bg-accent-soft/40'
                              : 'border-line hover:border-line-strong'
                          )}
                        >
                          <input
                            type="radio"
                            name="cert-method"
                            value="dns"
                            checked={certMethod === 'dns'}
                            disabled={busy}
                            onChange={() => setCertMethod('dns')}
                            className="mt-0.5 accent-[var(--ez-accent)]"
                          />
                          <span>
                            <span className="block font-medium text-ink">DNS challenge</span>
                            <span className="block text-2xs text-faint">Add a TXT record</span>
                          </span>
                        </label>
                      </div>
                      {form.wildcard && (
                        <p className="mt-2 text-2xs text-warn">
                          Wildcard certificates require the DNS challenge.
                        </p>
                      )}
                    </fieldset>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        loading={certAction === 'issue'}
                        onClick={createCertificate}
                        icon={<ShieldCheck className="size-3.5" aria-hidden="true" />}
                      >
                        Create certificate
                      </Button>
                      <Button
                        variant="dangerGhost"
                        size="sm"
                        onClick={disableSsl}
                        disabled={certAction !== null}
                      >
                        Disable SSL and save
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
      >
        <FormSection
          id="basic"
          title="Basic configuration"
          description="What nginx serves and where traffic goes."
          icon={Globe2}
          open={sections.basic ?? false}
          onToggle={() => setSections((c) => ({ ...c, basic: !c.basic }))}
        >
          <FormGrid>
            <TextInput
              id="domain-name"
              className="sm:col-span-2"
              label="Domain name"
              placeholder="api.example.com"
              value={form.name}
              disabled={Boolean(editing)}
              onChange={(event) => update('name', event.target.value)}
              error={fieldErrors['domain-name']}
              hint={
                form.wildcard
                  ? 'Enter the bare domain — the *. prefix is added automatically.'
                  : editing
                    ? 'The domain name cannot be changed after creation.'
                    : undefined
              }
              autoComplete="off"
              spellCheck={false}
            />

            <TextInput
              id="backend-host"
              className="sm:col-span-2"
              label="Backend host or URL"
              placeholder="127.0.0.1 or https://app.vercel.app"
              value={form.backendHost}
              onChange={(event) => update('backendHost', event.target.value)}
              error={fieldErrors['backend-host']}
              hint="A host and port, or a full http(s) URL to proxy to."
              autoComplete="off"
              spellCheck={false}
            />

            <TextInput
              id="backend-port"
              label="Backend port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={numeric(form.port)}
              disabled={backendIsUrl}
              onChange={(event) => update('port', Number(event.target.value))}
              error={fieldErrors['backend-port']}
              hint={backendIsUrl ? 'Taken from the URL.' : undefined}
            />

            <Select
              label="Upstream type"
              value={form.upstreamType}
              onChange={(event) => update('upstreamType', event.target.value as UpstreamType)}
            >
              {(Object.keys(TYPE_LABEL) as UpstreamType[]).map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABEL[type]}
                </option>
              ))}
            </Select>

            <div className="sm:col-span-2 space-y-3 rounded-md border border-line bg-raised/30 p-3.5">
              <Switch
                checked={form.wildcard}
                onChange={(checked) =>
                  setForm((current) => ({
                    ...current,
                    wildcard: checked,
                    www: checked ? false : current.www,
                  }))
                }
                label="Wildcard domain"
                description="Serve *.example.com. Requires a DNS-01 certificate."
              />
              {!form.wildcard && (
                <div className="border-t border-line pt-3">
                  <Switch
                    checked={form.www}
                    onChange={(checked) => update('www', checked)}
                    label="Include www subdomain"
                    description="Adds www.example.com to server_name."
                  />
                </div>
              )}
            </div>
          </FormGrid>
        </FormSection>

        <FormSection
          id="ssl"
          title="SSL"
          description="Serve this domain over HTTPS."
          icon={ShieldCheck}
          open={sections.ssl ?? false}
          onToggle={() => setSections((c) => ({ ...c, ssl: !c.ssl }))}
        >
          <div className="space-y-4">
            {form.ssl.enabled ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextInput
                    label="Certificate path"
                    value={form.ssl.certPath}
                    onChange={(event) => updateSsl('certPath', event.target.value)}
                    placeholder="fullchain.pem"
                    hint="Leave blank to use the dashboard's certificate directory."
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                  <TextInput
                    label="Private key path"
                    value={form.ssl.keyPath}
                    onChange={(event) => updateSsl('keyPath', event.target.value)}
                    placeholder="privkey.pem"
                    hint="Leave blank to use the dashboard's certificate directory."
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-3 rounded-md border border-line bg-raised/30 p-3.5">
                  <Switch
                    checked={form.ssl.redirect}
                    onChange={(checked) => updateSsl('redirect', checked)}
                    label="Redirect HTTP to HTTPS"
                    description="Port 80 requests are sent to the HTTPS address."
                  />
                  <div className="border-t border-line pt-3">
                    <Switch
                      checked={form.ssl.hsts}
                      onChange={(checked) => updateSsl('hsts', checked)}
                      label="Enable HSTS"
                      description="Tells browsers to use HTTPS for this domain only."
                    />
                  </div>
                  {form.ssl.hsts && (
                    <div className="border-t border-line pt-3">
                      <TextInput
                        id="hsts-max-age"
                        label="HSTS max-age"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        value={numeric(form.ssl.hstsMaxAge)}
                        onChange={(event) => updateSsl('hstsMaxAge', Number(event.target.value))}
                        error={fieldErrors['hsts-max-age']}
                        hint="Seconds. 31536000 is one year."
                        className="max-w-56"
                      />
                    </div>
                  )}
                </div>
              </>
            ) : (
              <Switch
                checked={form.ssl.enabled}
                onChange={(checked) => updateSsl('enabled', checked)}
                label="Enable SSL / HTTPS"
                description="Adds a 443 server block with the certificate below."
              />
            )}

            {form.ssl.enabled && (
              <div className="flex items-start gap-2 text-xs text-muted">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden="true" />
                <span>
                  The certificate files must exist before this domain can be saved. If they are
                  missing, you will be offered to issue one.
                </span>
              </div>
            )}
          </div>
        </FormSection>

        <FormSection
          id="performance"
          title="Performance"
          description="Request limits, timeouts and compression."
          icon={Gauge}
          open={sections.performance ?? false}
          onToggle={() => setSections((c) => ({ ...c, performance: !c.performance }))}
        >
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <TextInput
                id="max-body"
                label="Max body size"
                value={form.performance.maxBodySize}
                onChange={(event) => updatePerformance('maxBodySize', event.target.value)}
                error={fieldErrors['max-body']}
                placeholder="10m"
                hint="For uploads: 10m, 512k or 1g."
                autoComplete="off"
              />
              <TextInput
                id="read-timeout"
                label="Read timeout"
                type="number"
                inputMode="numeric"
                min={1}
                value={numeric(form.performance.readTimeout)}
                onChange={(event) => updatePerformance('readTimeout', Number(event.target.value))}
                error={fieldErrors['read-timeout']}
                hint="Seconds."
              />
              <TextInput
                id="connect-timeout"
                label="Connect timeout"
                type="number"
                inputMode="numeric"
                min={1}
                value={numeric(form.performance.connectTimeout)}
                onChange={(event) =>
                  updatePerformance('connectTimeout', Number(event.target.value))
                }
                error={fieldErrors['connect-timeout']}
                hint="Seconds."
              />
            </div>
            <div className="space-y-3 rounded-md border border-line bg-raised/30 p-3.5">
              <Switch
                checked={form.performance.proxyBuffers}
                onChange={(checked) => updatePerformance('proxyBuffers', checked)}
                label="Proxy buffering"
                description="Buffer upstream responses on disk for slow clients."
              />
              <div className="border-t border-line pt-3">
                <Switch
                  checked={form.performance.gzip}
                  onChange={(checked) => updatePerformance('gzip', checked)}
                  label="Gzip compression"
                  description="Compress text responses before sending them."
                />
              </div>
              {form.performance.gzip && (
                <div className="border-t border-line pt-3">
                  <TextArea
                    label="Gzip MIME types"
                    value={form.performance.gzipTypes}
                    onChange={(event) => updatePerformance('gzipTypes', event.target.value)}
                    rows={3}
                    spellCheck={false}
                    className="font-mono"
                  />
                  <FieldHint>Space-separated list of content types.</FieldHint>
                </div>
              )}
            </div>
          </div>
        </FormSection>

        <FormSection
          id="security"
          title="Security"
          description="Rate limiting and response headers."
          icon={Lock}
          open={sections.security ?? false}
          onToggle={() => setSections((c) => ({ ...c, security: !c.security }))}
        >
          <div className="space-y-3 rounded-md border border-line bg-raised/30 p-3.5">
            <Switch
              checked={form.security.rateLimit}
              onChange={(checked) => updateSecurity('rateLimit', checked)}
              label="Rate limiting"
              description="Limit requests per IP address."
            />
            {form.security.rateLimit && (
              <div className="grid gap-4 border-t border-line pt-3 sm:grid-cols-2">
                <TextInput
                  id="rate-limit-rate"
                  label="Requests per second"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={numeric(form.security.rateLimitRate)}
                  onChange={(event) =>
                    updateSecurity('rateLimitRate', Number(event.target.value))
                  }
                  error={fieldErrors['rate-limit-rate']}
                />
                <TextInput
                  id="rate-limit-burst"
                  label="Burst"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={numeric(form.security.rateLimitBurst)}
                  onChange={(event) =>
                    updateSecurity('rateLimitBurst', Number(event.target.value))
                  }
                  error={fieldErrors['rate-limit-burst']}
                  hint="Requests allowed to exceed the rate briefly."
                />
              </div>
            )}
            <div className="border-t border-line pt-3">
              <Switch
                checked={form.security.securityHeaders}
                onChange={(checked) => updateSecurity('securityHeaders', checked)}
                label="Security headers"
                description="Adds X-Frame-Options and X-Content-Type-Options."
              />
            </div>
            <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
              <Switch
                checked={form.security.custom404}
                onChange={(checked) => updateSecurity('custom404', checked)}
                label="Custom 404 form"
                description="Return the dashboard's 404 page."
              />
              <Switch
                checked={form.security.custom50x}
                onChange={(checked) => updateSecurity('custom50x', checked)}
                label="Custom 50x page"
                description="Return the dashboard's error page when the backend fails."
              />
            </div>
          </div>
        </FormSection>

        <FormSection
          id="advanced"
          title="Advanced"
          description="Raw nginx additions for this domain."
          icon={Code2}
          open={sections.advanced ?? false}
          onToggle={() => setSections((c) => ({ ...c, advanced: !c.advanced }))}
        >
          <div className="space-y-4">
            <Switch
              checked={form.advanced.accessLog}
              onChange={(checked) => updateAdvanced('accessLog', checked)}
              label="Domain-specific access log"
              description="Writes this domain's requests to its own log file."
            />
            <TextArea
              label="Custom location blocks"
              value={form.advanced.customLocations}
              onChange={(event) => updateAdvanced('customLocations', event.target.value)}
              rows={6}
              spellCheck={false}
              placeholder={'location /api/v2 {\n    proxy_pass http://localhost:8080;\n}'}
              className="font-mono"
            />
            <FieldHint>
              Appended verbatim inside the server block. nginx tests the result before it is
              kept.
            </FieldHint>
          </div>
        </FormSection>

        {editing && (
          <FormSection
            id="notifications"
            title="Notifications"
            description="Which channels hear about this domain."
            icon={Bell}
            open={sections.notifications ?? false}
            onToggle={() => setSections((c) => ({ ...c, notifications: !c.notifications }))}
          >
            {channels.loading && !channels.data ? (
              <div className="space-y-2">
                <Skeleton className="h-14 rounded-md" />
                <Skeleton className="h-14 rounded-md" />
                <Skeleton className="h-14 rounded-md" />
              </div>
            ) : channels.error && !channels.data ? (
              <InlineAlert
                tone="warning"
                title="Could not load notification channels"
                action={
                  <Button variant="ghost" size="sm" onClick={channels.reload}>
                    Retry
                  </Button>
                }
              >
                {channels.error.message}
              </InlineAlert>
            ) : (channels.data ?? []).length === 0 ? (
              <InlineAlert tone="info" title="No notification channels configured">
                Add a Discord or Telegram channel in Settings first; this domain's alerts are
                recorded either way.
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Settings2 className="size-3.5" aria-hidden="true" />}
                    onClick={goToSettings}
                  >
                    Open settings
                  </Button>
                </div>
              </InlineAlert>
            ) : (
              <div className="space-y-3">
                {NOTIFICATION_EVENTS.map((event) => {
                  const routing = form.notifications[event.id];
                  return (
                    <div
                      key={event.id}
                      className="rounded-md border border-line bg-raised/30 p-3.5"
                    >
                      <Switch
                        checked={routing.enabled}
                        onChange={(checked) => setNotification(event.id, { enabled: checked })}
                        label={event.label}
                        description={event.description}
                      />
                      {routing.enabled && (
                        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
                          {(channels.data ?? []).map((channel) => (
                            <ChannelChip
                              key={channel.id}
                              channel={channel}
                              checked={routing.channelIds.includes(channel.id)}
                              onChange={(checked) =>
                                toggleChannel(event.id, channel.id, checked)
                              }
                            />
                          ))}
                        </div>
                      )}
                      {routing.enabled && routing.channelIds.length === 0 && (
                        <p className="mt-2 text-2xs text-faint">
                          No channels selected — the event is recorded but not delivered.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </FormSection>
        )}
      </form>
    </Modal>
  );
}
