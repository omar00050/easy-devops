import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Download,
  KeyRound,
  RefreshCw,
  Save,
  ServerCog,
  Settings2,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type {
  AuthMode,
  BackupFile,
  PermissionsSetupStatus,
  Settings,
  SettingsUpdate,
} from '../lib/types';
import { cn } from '../lib/cn';
import { formatDate } from '../lib/format';
import { describeService, serviceStateLabel } from '../lib/service';
import { validateEmail, validatePassword, validatePort } from '../lib/validation';
import { useAuth } from '../app/AuthProvider';
import { useService } from '../app/ServiceProvider';
import { useLocalChange } from '../hooks/useLocalChange';
import {
  useConfirm,
  useDocumentTitle,
  useResource,
} from '../hooks/useResource';
import { PageHeader } from '../components/layout/PageHeader';
import { HubPanel } from '../components/settings/HubPanel';
import { Card, CardBody, CardFooter, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, buttonClasses } from '../components/ui/Button';
import { FormGrid, Select, TextInput } from '../components/ui/Field';
import {
  ErrorState,
  InlineAlert,
  PageSkeleton,
  Skeleton,
  Spinner,
} from '../components/ui/States';
import { useToast } from '../components/ui/Toast';

type Tab = 'general' | 'access' | 'hub' | 'backup';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'access', label: 'Access' },
  { id: 'hub', label: 'Hub' },
  { id: 'backup', label: 'Backup' },
];

const BIND_CHOICES: { value: string; label: string }[] = [
  { value: '127.0.0.1', label: 'This machine only (127.0.0.1)' },
  { value: '0.0.0.0', label: 'All interfaces (0.0.0.0)' },
];

function bindLabel(value: string): string {
  if (value === '::1') return 'This machine only (::1)';
  return BIND_CHOICES.find((choice) => choice.value === value)?.label ?? value;
}

interface GeneralDraft {
  port: string;
  nginxDir: string;
  sslDir: string;
  acmeEmail: string;
}

interface AccessDraft {
  bind: string;
  auth: AuthMode;
  password: string;
  confirm: string;
}

function toGeneralDraft(settings: Settings): GeneralDraft {
  return {
    port: String(settings.dashboardPort),
    nginxDir: settings.nginxDir,
    sslDir: settings.sslDir,
    acmeEmail: settings.acmeEmail,
  };
}

function toAccessDraft(settings: Settings): AccessDraft {
  return {
    bind: settings.dashboardBindAddress,
    auth: settings.dashboardAuth,
    password: '',
    confirm: '',
  };
}

function failureText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const detail = typeof error.payload.detail === 'string' ? error.payload.detail : null;
    return detail ?? error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

function accessFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const reason = error.payload.reason;
    if (reason === 'no_auth_requires_loopback') {
      return 'Running without a password requires the dashboard to listen on this machine only.';
    }
    if (reason === 'bind_requires_password') {
      return 'Set a password before opening the dashboard to the network.';
    }
    if (reason === 'no_auth_requires_local_request') {
      return 'Turning the password off is only allowed from this machine itself.';
    }
  }
  return failureText(error, 'The previous access settings are still in force.');
}

export function SettingsPage() {
  useDocumentTitle('Settings');
  const toast = useToast();
  const confirm = useConfirm();
  const { auth } = useAuth();
  const minPasswordLength = auth?.minPasswordLength ?? 8;

  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: Tab = TABS.some((entry) => entry.id === requested)
    ? (requested as Tab)
    : 'general';

  const setTab = (next: Tab) => {
    const nextParams = new URLSearchParams(params);
    if (next === 'general') nextParams.delete('tab');
    else nextParams.set('tab', next);
    setParams(nextParams, { replace: true });
  };

  const settings = useResource<Settings>((signal) => api.settings.get(signal));
  const permissions = useResource<PermissionsSetupStatus>(
    (signal) => api.settings.permissions(signal),
    [],
    { enabled: Boolean(settings.data) && settings.data?.platform !== 'win32' }
  );
  const {
    service,
    error: serviceError,
    reload: reloadService,
  } = useService();
  const serviceView = describeService(service);

  useLocalChange('settings', () => {
    settings.reload();
    permissions.reload();
  });

  // ── Drafts ────────────────────────────────────────────────────────────────

  const [general, setGeneral] = useState<GeneralDraft | null>(null);
  const [access, setAccess] = useState<AccessDraft | null>(null);
  const [generalTouched, setGeneralTouched] = useState(false);
  const [accessTouched, setAccessTouched] = useState(false);
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savingAccess, setSavingAccess] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data && !general) setGeneral(toGeneralDraft(settings.data));
  }, [settings.data, general]);

  useEffect(() => {
    if (settings.data && !access) setAccess(toAccessDraft(settings.data));
  }, [settings.data, access]);

  const portError = general ? validatePort(general.port) : null;
  const emailError = general ? validateEmail(general.acmeEmail) : null;
  const nginxDirError =
    general && !general.nginxDir.trim() ? 'This directory is required.' : null;
  const sslDirError = general && !general.sslDir.trim() ? 'This directory is required.' : null;

  const generalDirty = Boolean(
    general &&
      settings.data &&
      (Number(general.port) !== settings.data.dashboardPort ||
        general.nginxDir !== settings.data.nginxDir ||
        general.sslDir !== settings.data.sslDir ||
        general.acmeEmail !== settings.data.acmeEmail)
  );

  const accessDirty = Boolean(
    access &&
      settings.data &&
      (access.bind !== settings.data.dashboardBindAddress ||
        access.auth !== settings.data.dashboardAuth ||
        access.password !== '')
  );

  const saveGeneral = async () => {
    if (!general || savingGeneral) return;
    setGeneralTouched(true);
    if (portError || emailError || nginxDirError || sslDirError) return;
    setSavingGeneral(true);
    try {
      const result = await api.settings.update({
        dashboardPort: Number(general.port),
        nginxDir: general.nginxDir.trim(),
        sslDir: general.sslDir.trim(),
        acmeEmail: general.acmeEmail.trim(),
      });
      setNeedsRestart(result.needsRestart);
      toast.success(
        'Settings saved',
        result.needsRestart
          ? 'Restart the dashboard for the new port to take effect.'
          : undefined
      );
      settings.reload();
    } catch (error) {
      toast.error(
        'Could not save settings',
        failureText(error, 'The previous settings are still in force.')
      );
    } finally {
      setSavingGeneral(false);
    }
  };

  const saveAccess = async () => {
    if (!access || !settings.data || savingAccess) return;
    setAccessTouched(true);
    setAccessError(null);
    setPasswordError(null);

    if (access.auth === 'none' && access.bind === '0.0.0.0') {
      setAccessError('Running without a password requires the dashboard to listen here only.');
      return;
    }

    if (access.password) {
      const problem =
        validatePassword(access.password, minPasswordLength) ??
        (access.password !== access.confirm ? 'The two passwords do not match.' : null);
      if (problem) {
        setPasswordError(problem);
        return;
      }
    } else if (access.auth === 'password' && !settings.data.hasPassword) {
      setPasswordError('Set a password before requiring a password to sign in.');
      return;
    }

    const nextAuth: AuthMode = access.password ? 'password' : access.auth;

    setSavingAccess(true);
    try {
      const payload: SettingsUpdate = {
        dashboardBindAddress: access.bind,
        dashboardAuth: nextAuth,
      };
      if (access.password) payload.dashboardPassword = access.password;

      const result = await api.settings.update(payload);
      setNeedsRestart(result.needsRestart);
      setAccess((current) =>
        current ? { ...current, auth: result.dashboardAuth, password: '', confirm: '' } : current
      );
      toast.success(
        'Access settings saved',
        result.needsRestart
          ? 'Restart the dashboard for the new listening address to take effect.'
          : undefined
      );
      settings.reload();
    } catch (error) {
      setAccessError(accessFailure(error));
    } finally {
      setSavingAccess(false);
    }
  };

  // ── Linux permissions ─────────────────────────────────────────────────────

  const [sudoPassword, setSudoPassword] = useState('');
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [settingUpPermissions, setSettingUpPermissions] = useState(false);

  const setupPermissions = async () => {
    if (!sudoPassword || settingUpPermissions) return;
    setSettingUpPermissions(true);
    setPermissionError(null);
    try {
      await api.settings.setupPermissions(sudoPassword);
      setSudoPassword('');
      permissions.setData({ configured: true });
      toast.success('Permissions configured', 'nginx and systemctl no longer prompt for a password.');
    } catch (error) {
      setPermissionError(failureText(error, 'The sudoers file was not written.'));
    } finally {
      setSettingUpPermissions(false);
    }
  };

  // ── Backup ────────────────────────────────────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreNote, setRestoreNote] = useState<{
    tone: 'success' | 'danger';
    title: string;
    body: string;
  } | null>(null);

  const exportBackup = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const backup = await api.settings.backup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `easy-devops-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      toast.success('Backup downloaded');
    } catch (error) {
      toast.error(
        'Could not create the backup',
        failureText(error, 'Nothing was downloaded.')
      );
    } finally {
      setExporting(false);
    }
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setRestoreNote(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setRestoreNote({
        tone: 'danger',
        title: 'That file is not valid JSON',
        body: 'Pick the .json file produced by Export backup.',
      });
      event.target.value = '';
      return;
    }

    const candidate = parsed as Partial<BackupFile> | null;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.config !== 'object' ||
      candidate.config === null
    ) {
      setRestoreNote({
        tone: 'danger',
        title: 'That file is not an Easy DevOps backup',
        body: 'A backup always contains a config section and a domains list.',
      });
      event.target.value = '';
      return;
    }

    const ok = await confirm({
      title: 'Restore this backup?',
      body: 'This replaces your current configuration and domain list. Passwords and the listen address stored in the file are ignored.',
      confirmLabel: 'Restore',
      tone: 'danger',
    });
    event.target.value = '';
    if (!ok) return;

    setRestoring(true);
    try {
      await api.settings.restore(parsed as BackupFile);
      const refreshed = await api.settings.get();
      settings.setData(refreshed);
      setGeneral(toGeneralDraft(refreshed));
      setAccess(toAccessDraft(refreshed));
      setGeneralTouched(false);
      setAccessTouched(false);
      setNeedsRestart(false);
      permissions.reload();
      setRestoreNote({
        tone: 'success',
        title: 'Backup restored',
        body: `Configuration from ${formatDate(
          candidate.exportedAt ?? null
        )} is now in force. Reload any other open dashboard tabs to pick it up.`,
      });
      toast.success('Backup restored');
    } catch (error) {
      setRestoreNote({
        tone: 'danger',
        title: 'The restore failed',
        body: failureText(error, 'Nothing was changed.'),
      });
    } finally {
      setRestoring(false);
    }
  };

  // ── Render helpers ────────────────────────────────────────────────────────

  const refreshAll = () => {
    settings.reload();
    permissions.reload();
    if (tab === 'general') reloadService();
  };

  const restartNotice = needsRestart && (
    <InlineAlert tone="info" title="Restart needed">
      The port or listening address changed. It takes effect after the dashboard restarts.
    </InlineAlert>
  );

  const renderGeneral = () => {
    if (settings.error && !settings.data) {
      return (
        <ErrorState
          error={settings.error}
          title="Could not read the settings"
          onRetry={settings.reload}
        />
      );
    }
    if (!settings.data || !general) {
      return (
        <PageSkeleton>
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </PageSkeleton>
      );
    }

    return (
      <div className="space-y-5">
        <Card className="overflow-hidden">
          <div className="h-0.5 w-full bg-accent/50" aria-hidden="true" />
          <CardHeader
            icon={<Settings2 className="size-4" aria-hidden="true" />}
            title="Application configuration"
            description="Where nginx lives, which port the dashboard answers on, and the address Let’s Encrypt knows you by."
          />
          <CardBody className="space-y-5">
            {restartNotice}
            <FormGrid>
              <TextInput
                label="Dashboard port"
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                value={general.port}
                onChange={(event) =>
                  setGeneral({ ...general, port: event.target.value })
                }
                error={generalTouched ? portError : null}
                hint="Takes effect after the dashboard restarts."
              />
              <TextInput
                label="ACME email"
                type="email"
                value={general.acmeEmail}
                onChange={(event) =>
                  setGeneral({ ...general, acmeEmail: event.target.value })
                }
                error={generalTouched ? emailError : null}
                hint="Used when ordering certificates. Usually not shown to anyone."
                placeholder="admin@example.com"
              />
              <TextInput
                label="Nginx directory"
                value={general.nginxDir}
                onChange={(event) =>
                  setGeneral({ ...general, nginxDir: event.target.value })
                }
                error={generalTouched ? nginxDirError : null}
                hint="Where nginx.conf is located."
                className="font-mono"
                spellCheck={false}
              />
              <TextInput
                label="SSL settings directory"
                value={general.sslDir}
                onChange={(event) =>
                  setGeneral({ ...general, sslDir: event.target.value })
                }
                error={generalTouched ? sslDirError : null}
                hint="Default directory for certificates the dashboard manages."
                className="font-mono"
                spellCheck={false}
              />
            </FormGrid>
          </CardBody>
          <CardFooter>
            <span className="text-2xs text-faint">
              {generalDirty ? 'Unsaved changes' : 'All changes saved'}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!generalDirty}
                onClick={() => {
                  setGeneral(toGeneralDraft(settings.data as Settings));
                  setGeneralTouched(false);
                }}
              >
                Revert
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={savingGeneral}
                disabled={!generalDirty}
                icon={<Save className="size-3.5" aria-hidden="true" />}
                onClick={() => void saveGeneral()}
              >
                Save settings
              </Button>
            </div>
          </CardFooter>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            icon={<ServerCog className="size-4" aria-hidden="true" />}
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                Background service
                {serviceView && (
                  <Badge tone={serviceView.running ? 'ok' : 'warn'} dot>
                    {serviceStateLabel(serviceView)}
                  </Badge>
                )}
                {service?.dev && <Badge tone="warn">dev data dir</Badge>}
              </span>
            }
            description="Runs monitoring and notifications without this dashboard open."
            actions={
              <Link to="/processes" className={buttonClasses('secondary', 'sm')}>
                Open Processes
              </Link>
            }
          />
          <CardBody>
            {serviceError && !service ? (
              <InlineAlert tone="warning" title="Could not read the service state">
                {serviceError.message}{' '}
                <button
                  type="button"
                  className="font-medium underline underline-offset-2"
                  onClick={reloadService}
                >
                  Try again
                </button>
              </InlineAlert>
            ) : !service ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted">
                <Spinner />
                Checking the background service…
              </div>
            ) : serviceView ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <div className="text-2xs font-medium uppercase tracking-wider text-faint">
                    Status
                  </div>
                  <div
                    className={cn(
                      'mt-0.5 text-sm font-medium',
                      serviceView.running ? 'text-ok' : 'text-warn'
                    )}
                  >
                    {serviceStateLabel(serviceView)}
                  </div>
                </div>
                <div>
                  <div className="text-2xs font-medium uppercase tracking-wider text-faint">
                    Mode
                  </div>
                  <div className="mt-0.5 text-sm font-medium text-ink" title={serviceView.mechanismDetail}>
                    {serviceView.mechanismLabel}
                  </div>
                </div>
                <div>
                  <div className="text-2xs font-medium uppercase tracking-wider text-faint">
                    Starts
                  </div>
                  <div className="mt-0.5 text-sm font-medium text-ink">{serviceView.startsAtLabel}</div>
                </div>
                <div>
                  <div className="text-2xs font-medium uppercase tracking-wider text-faint">
                    PM2 (your apps)
                  </div>
                  <div className="mt-0.5 text-sm font-medium text-ink">
                    {service.pm2.installed ? service.pm2.version ?? 'Installed' : 'Not installed'}
                  </div>
                </div>
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>
    );
  };

  const renderAccess = () => {
    if (settings.error && !settings.data) {
      return (
        <ErrorState
          error={settings.error}
          title="Could not read the settings"
          onRetry={settings.reload}
        />
      );
    }
    if (!settings.data || !access) {
      return (
        <PageSkeleton>
          <Skeleton className="h-72 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </PageSkeleton>
      );
    }

    const loopbackDraft = access.bind !== '0.0.0.0';
    const canUseNoPassword =
      settings.data.canUseNoPassword || loopbackDraft;
    const livePasswordProblem = access.password
      ? validatePassword(access.password, minPasswordLength) ??
        (access.confirm && access.password !== access.confirm
          ? 'The two passwords do not match.'
          : null)
      : null;
    const shownPasswordError = passwordError ?? (accessTouched ? livePasswordProblem : null);

    return (
      <div className="space-y-5">
        <Card className="overflow-hidden">
          <div className="h-0.5 w-full bg-accent/50" aria-hidden="true" />
          <CardHeader
            icon={<KeyRound className="size-4" aria-hidden="true" />}
            title="Access and authentication"
            description="Who can reach the dashboard, and how they prove who they are."
          />
          <CardBody className="space-y-5">
            {restartNotice}
            {accessError && (
              <InlineAlert tone="danger" title="Could not save access settings">
                {accessError}
              </InlineAlert>
            )}

            <FormGrid>
              <Select
                label="Listen on"
                value={access.bind}
                onChange={(event) => {
                  const bind = event.target.value;
                  setAccess({
                    ...access,
                    bind,
                    auth: bind === '0.0.0.0' ? 'password' : access.auth,
                  });
                }}
                hint={
                  access.auth === 'none'
                    ? 'Locked to this machine while there is no password.'
                    : 'Changing this needs a dashboard restart.'
                }
              >
                {BIND_CHOICES.map((choice) => (
                  <option
                    key={choice.value}
                    value={choice.value}
                    disabled={choice.value === '0.0.0.0' && access.auth === 'none'}
                  >
                    {choice.label}
                  </option>
                ))}
                {!BIND_CHOICES.some((choice) => choice.value === access.bind) && (
                  <option value={access.bind}>{bindLabel(access.bind)}</option>
                )}
              </Select>

              <Select
                label="Authentication"
                value={access.auth}
                onChange={(event) => {
                  const mode = event.target.value as AuthMode;
                  setAccess({
                    ...access,
                    auth: mode,
                    bind: mode === 'none' ? '127.0.0.1' : access.bind,
                  });
                  setPasswordError(null);
                }}
                hint={
                  access.auth === 'none'
                    ? 'No login — reachable from this machine only.'
                    : !settings.data.hasPassword && !access.password
                      ? 'No password set yet — set one below.'
                      : 'A password is required to sign in.'
                }
              >
                <option value="password">Password required</option>
                <option value="none" disabled={!canUseNoPassword}>
                  No password (this machine only)
                </option>
              </Select>
            </FormGrid>

            {access.auth === 'none' && (
              <InlineAlert tone="warning" title="No login">
                Anyone who can reach this machine can open the dashboard. Listening is fixed to
                127.0.0.1 so that is only this machine, not the network.
              </InlineAlert>
            )}

            <div className="max-w-md space-y-4 border-t border-line pt-4">
              <TextInput
                label="New password"
                type="password"
                autoComplete="new-password"
                value={access.password}
                onChange={(event) => {
                  setAccess({ ...access, password: event.target.value });
                  setPasswordError(null);
                }}
                error={shownPasswordError}
                hint={`Leave blank to keep the current password. At least ${minPasswordLength} characters.`}
              />
              <TextInput
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                value={access.confirm}
                onChange={(event) => {
                  setAccess({ ...access, confirm: event.target.value });
                  setPasswordError(null);
                }}
              />
            </div>
          </CardBody>
          <CardFooter>
            <span className="text-2xs text-faint">
              {accessDirty ? 'Unsaved changes' : 'All changes saved'}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!accessDirty}
                onClick={() => {
                  setAccess(toAccessDraft(settings.data as Settings));
                  setAccessTouched(false);
                  setAccessError(null);
                  setPasswordError(null);
                }}
              >
                Revert
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={savingAccess}
                disabled={!accessDirty}
                icon={<Save className="size-3.5" aria-hidden="true" />}
                onClick={() => void saveAccess()}
              >
                Save access
              </Button>
            </div>
          </CardFooter>
        </Card>

        {settings.data.platform !== 'win32' && (
          <Card className="overflow-hidden">
            <div
              className={cn(
                'h-0.5 w-full',
                permissions.data?.configured ? 'bg-ok/60' : 'bg-warn/60'
              )}
              aria-hidden="true"
            />
            <CardHeader
              icon={<ShieldCheck className="size-4" aria-hidden="true" />}
              title="Linux permissions"
              description="Passwordless sudo for nginx and systemctl."
              actions={
                permissions.data ? (
                  <Badge tone={permissions.data.configured ? 'ok' : 'warn'} dot>
                    {permissions.data.configured ? 'Configured' : 'Required'}
                  </Badge>
                ) : undefined
              }
            />
            <CardBody>
              {permissions.error && !permissions.data ? (
                <ErrorState
                  error={permissions.error}
                  title="Could not read the permission state"
                  onRetry={permissions.reload}
                  className="border-0"
                />
              ) : !permissions.data ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted">
                  <Spinner />
                  Checking sudoers…
                </div>
              ) : permissions.data.configured ? (
                <p className="text-sm text-muted">
                  Passwordless sudo is configured. The dashboard can reload nginx and call
                  systemctl without stopping to ask for a password.
                </p>
              ) : (
                <div className="max-w-md space-y-4">
                  <p className="text-sm text-muted">
                    The dashboard needs passwordless sudo to control nginx and systemctl. Enter
                    your sudo password once and it writes the sudoers entry for you.
                  </p>
                  {permissionError && (
                    <InlineAlert tone="danger" title="Permissions were not configured">
                      {permissionError}
                    </InlineAlert>
                  )}
                  <TextInput
                    label="Sudo password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="Enter your sudo password"
                    value={sudoPassword}
                    onChange={(event) => {
                      setSudoPassword(event.target.value);
                      if (permissionError) setPermissionError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void setupPermissions();
                    }}
                  />
                  <Button
                    variant="primary"
                    loading={settingUpPermissions}
                    disabled={!sudoPassword}
                    onClick={() => void setupPermissions()}
                  >
                    Set up permissions
                  </Button>
                </div>
              )}
            </CardBody>
          </Card>
        )}
      </div>
    );
  };

  const renderBackup = () => (
    <Card className="overflow-hidden">
      <div className="h-0.5 w-full bg-accent/50" aria-hidden="true" />
      <CardHeader
        icon={<Download className="size-4" aria-hidden="true" />}
        title="Backup and restore"
        description="Export or restore settings and domains as JSON."
      />
      <CardBody className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium text-ink">Export</h3>
              <p className="mt-0.5 text-xs text-muted">
                Download every setting and domain as one JSON file. Passwords are excluded from
                the export.
              </p>
            </div>
            <Button
              variant="secondary"
              loading={exporting}
              icon={<Download className="size-4" aria-hidden="true" />}
              onClick={() => void exportBackup()}
            >
              Export backup
            </Button>
          </div>

          <div className="space-y-3 border-t border-line pt-5 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
            <div>
              <h3 className="text-sm font-medium text-ink">Restore</h3>
              <p className="mt-0.5 text-xs text-muted">
                Replace the current configuration and domain list with a previously exported
                file. Passwords and the listen address stored in the file are ignored.
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              onChange={(event) => void importBackup(event)}
            />
            <Button
              variant="secondary"
              loading={restoring}
              disabled={exporting}
              icon={<Upload className="size-4" aria-hidden="true" />}
              onClick={() => fileInputRef.current?.click()}
            >
              Choose backup file…
            </Button>
          </div>
        </div>

        {restoreNote && (
          <InlineAlert tone={restoreNote.tone} title={restoreNote.title}>
            {restoreNote.body}
          </InlineAlert>
        )}
      </CardBody>
      <CardFooter>
        <span className="text-2xs text-faint">
          Exported backups never contain the dashboard password.
        </span>
      </CardFooter>
    </Card>
  );

  return (
    <>
      <PageHeader
        title="Settings"
        description="Configuration, access, Hub pairing and backups for this dashboard."
        actions={
          tab !== 'hub' ? (
            <Button
              variant="secondary"
              size="sm"
              loading={settings.loading || permissions.loading}
              icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
              onClick={refreshAll}
            >
              Refresh
            </Button>
          ) : undefined
        }
      />

      <div
        role="tablist"
        aria-label="Settings sections"
        className="mb-5 flex flex-wrap gap-1 rounded-lg border border-line bg-raised/60 p-1"
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`settings-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`settings-panel-${entry.id}`}
            onClick={() => setTab(entry.id)}
            className={cn(
              'rounded-sm border px-3 py-1.5 text-xs font-medium transition-colors duration-[var(--ez-motion-fast)]',
              tab === entry.id
                ? 'border-line bg-surface text-ink shadow-sm'
                : 'border-transparent text-muted hover:text-ink'
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`settings-panel-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
        tabIndex={-1}
        className="outline-none"
      >
        {tab === 'general' && renderGeneral()}
        {tab === 'access' && renderAccess()}
        {tab === 'hub' && <HubPanel />}
        {tab === 'backup' && renderBackup()}
      </div>
    </>
  );
}
