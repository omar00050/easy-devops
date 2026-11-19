import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../../lib/api';
import type {
  DeployApp,
  DeployAppCreated,
  DeployAppInput,
  DeployAuthType,
  DeployKeyInfo,
  DeploymentsResponse,
} from '../../lib/types';
import {
  CLUSTER_STATELESS_WARNING,
  checkPersistAddition,
  deployKeyAddUrl,
  envToText,
  fromSettingsDraft,
  isClusterCapable,
  isSshUrl,
  parseEnvText,
  toSettingsDraft,
  validateAppId,
  type SettingsDraft,
} from '../../lib/deployments';
import { validatePort } from '../../lib/validation';
import { Button } from '../ui/Button';
import { Checkbox, FormGrid, Select, Switch, TagInput, TextArea, TextInput } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { InlineAlert } from '../ui/States';
import { useToast } from '../ui/Toast';
import { DeployKeyPanel } from './DeployKeyPanel';

interface Draft {
  id: string;
  repoUrl: string;
  branch: string;
  authType: DeployAuthType;
  token: string;
  generateKey: boolean;
  settings: SettingsDraft;
  envText: string;
  keepReleases: string;
  autoRollback: boolean;
  notifyChannelIds: string[];
}

function emptyDraft(keepDefault: number): Draft {
  return {
    id: '',
    repoUrl: '',
    branch: 'main',
    authType: 'none',
    token: '',
    generateKey: true,
    settings: toSettingsDraft({}),
    envText: '',
    keepReleases: String(keepDefault),
    autoRollback: true,
    notifyChannelIds: [],
  };
}

function draftFrom(app: DeployApp): Draft {
  return {
    id: app.id,
    repoUrl: app.repoUrl,
    branch: app.branch,
    authType: app.authType,
    token: '',
    generateKey: true,
    settings: toSettingsDraft(app.settings, { execMode: app.execMode, instances: app.instances }),
    envText: envToText(app.env),
    keepReleases: String(app.keepReleases),
    autoRollback: app.autoRollback,
    notifyChannelIds: app.notifyChannelIds,
  };
}

/** The key from a create answer: an object, or a public key string from an older server. */
function keyFrom(saved: DeployAppCreated): DeployKeyInfo | null {
  const value = saved.deployKey;
  if (value && typeof value === 'object' && typeof value.publicKey === 'string') return value;
  if (typeof value === 'string' && value) {
    return {
      publicKey: value,
      fingerprint: saved.deployKeyFingerprint ?? '',
      createdAt: saved.deployKeyCreatedAt ?? '',
      addUrl: deployKeyAddUrl(saved.repoUrl),
    };
  }
  return null;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

/** Says whether a value is an override, and offers to drop it back to ez.json. */
function OverrideRow({
  overridden,
  note,
  onClear,
}: {
  overridden: boolean;
  note: ReactNode;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-2xs text-faint">
      <span>{overridden ? <>Override — {note}</> : note}</span>
      {overridden && (
        <button
          type="button"
          onClick={onClear}
          className="rounded-sm font-medium text-accent-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        >
          Use ez.json / default
        </button>
      )}
    </div>
  );
}

/**
 * Create or edit an app.
 *
 * Every command field is optional: left empty, the value comes from the
 * repository's ez.json, and failing that from package.json. The placeholders
 * say so, because "why is this empty" is the first question the form raises.
 */
export function AppFormModal({
  open,
  app,
  meta,
  onClose,
  onSaved,
  onCreated,
  onDeployNow,
  onRefresh,
}: {
  open: boolean;
  /** The app being edited, or null to create one. */
  app: DeployApp | null;
  meta: DeploymentsResponse;
  onClose: () => void;
  /** Save (or a create that has no key step) is done: the modal should close. */
  onSaved: (app: DeployApp, created: boolean) => void;
  /** A create that stays open for its deploy key; refresh the list behind it. */
  onCreated?: (app: DeployApp) => void;
  /** "Deploy now" from the key step: close this modal and show the deployment. */
  onDeployNow?: (appId: string) => void;
  /** A key was generated or replaced on an existing app. */
  onRefresh?: () => void;
}) {
  const toast = useToast();
  const editing = app !== null;
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(meta.limits.keepReleasesDefault));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ app: DeployApp; key: DeployKeyInfo | null; keyError: string | null } | null>(null);
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(app ? draftFrom(app) : emptyDraft(meta.limits.keepReleasesDefault));
    setCreated(null);
    setTouched(false);
    setFormError(null);
    // Reset only when the modal opens or the target changes, not on every
    // background refresh of the list behind it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, app?.id]);

  const set = (patch: Partial<Draft>) => {
    setFormError(null);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const setSettings = (patch: Partial<SettingsDraft>) => {
    setFormError(null);
    setDraft((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  };

  const clearMigrateOverride = () =>
    setSettings({ migrate: '', migrateOff: false, migrateOverride: false });
  const clearExecModeOverride = () =>
    setSettings({ execMode: app?.execMode ?? 'fork', execModeOverride: false });
  const clearInstancesOverride = () =>
    setSettings({
      instances: app?.instances !== undefined ? String(app.instances) : '',
      instancesOverride: false,
    });

  const repoUrl = draft.repoUrl.trim();
  const ssh = isSshUrl(repoUrl);
  const parsedEnv = parseEnvText(draft.envText);
  const keep = Number(draft.keepReleases);

  const errors = {
    id: editing ? null : validateAppId(draft.id.trim()),
    repoUrl: !repoUrl
      ? 'A repository URL is required.'
      : draft.authType === 'token' && ssh
        ? 'Token access needs an https:// URL.'
        : draft.authType === 'deployKey' && !ssh
          ? 'A deploy key needs an SSH URL, like git@github.com:owner/repo.git.'
          : null,
    token:
      draft.authType === 'token' && !draft.token.trim() && !(editing && app?.hasToken)
        ? 'A token is required.'
        : null,
    port: draft.settings.port.trim() ? validatePort(draft.settings.port) : null,
    healthPath:
      draft.settings.healthPath.trim() && !draft.settings.healthPath.trim().startsWith('/')
        ? 'Must start with "/".'
        : null,
    env: parsedEnv.error,
    keepReleases:
      !Number.isInteger(keep) ||
      keep < meta.limits.keepReleasesMin ||
      keep > meta.limits.keepReleasesMax
        ? `A whole number from ${meta.limits.keepReleasesMin} to ${meta.limits.keepReleasesMax}.`
        : null,
    instances: (() => {
      const value = draft.settings.instances.trim();
      if (!value || value === 'max') return null;
      return /^\d+$/.test(value) && Number(value) >= 1
        ? null
        : 'A whole number from 1 to this server’s CPU count, or "max".';
    })(),
  };
  const invalid = Object.values(errors).some(Boolean);

  // The server enforces both rules; these are the form's own hints.
  const clusterAllowed = isClusterCapable(draft.settings.start);
  const clusterBlocked = draft.settings.execMode === 'cluster' && clusterAllowed === false;
  const forkWithInstances =
    draft.settings.execMode === 'fork' && Number(draft.settings.instances) > 1;
  const serverWarnings = (app?.warnings ?? []).filter(
    (warning) =>
      !(draft.settings.execMode === 'cluster' && warning === CLUSTER_STATELESS_WARNING)
  );

  const submit = async () => {
    if (saving) return;
    setTouched(true);
    if (invalid) return;

    const input: DeployAppInput = {
      repoUrl,
      branch: draft.branch.trim() || 'main',
      authType: draft.authType,
      settings: fromSettingsDraft(draft.settings),
      env: parsedEnv.env,
      keepReleases: keep,
      autoRollback: draft.autoRollback,
      notifyChannelIds: draft.notifyChannelIds,
    };
    // Only sent when typed: an empty field keeps the stored token.
    if (draft.token.trim()) input.token = draft.token.trim();
    // The server ignores it for every other auth type, and PUT does not take it.
    if (!editing && draft.authType === 'deployKey') input.generateKey = draft.generateKey;

    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        const saved = await api.deployments.update(app.id, input);
        onSaved(saved, false);
        return;
      }

      const saved = await api.deployments.create({ ...input, id: draft.id.trim() });
      const key = keyFrom(saved);
      if (draft.authType === 'deployKey' && draft.generateKey) {
        // Creating never starts a deployment. The key was made in the same
        // request, so the modal becomes its setup step instead of closing.
        const appView: DeployApp = { ...(saved as DeployApp), deployKey: key?.publicKey ?? null };
        setCreated({ app: appView, key, keyError: key ? null : saved.deployKeyError ?? 'The key was not generated.' });
        onCreated?.(appView);
        return;
      }
      onSaved(saved as DeployApp, true);
    } catch (error) {
      // The server's own words (CPU count, node <file> form, …) stay with the form.
      setFormError(errorText(error, 'Nothing was changed.'));
    } finally {
      setSaving(false);
    }
  };

  const deployNow = async () => {
    if (!created || deploying) return;
    setDeploying(true);
    try {
      await api.deployments.deploy(created.app.id);
      toast.success(`${created.app.id} is deploying`, 'Its log is in the Deployments tab.');
      onDeployNow?.(created.app.id);
    } catch (error) {
      toast.error('Could not start the deployment', errorText(error, 'Nothing was started.'));
    } finally {
      setDeploying(false);
    }
  };

  const show = <K extends keyof typeof errors>(key: K) => (touched ? errors[key] : null);

  if (created) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        preventClose={deploying}
        size="lg"
        title={`${created.app.id} created`}
        description="Add its public key to the repository so deployments can read the code."
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={deploying}>
              Close
            </Button>
            <Button variant="primary" onClick={() => void deployNow()} loading={deploying}>
              Deploy now
            </Button>
          </>
        }
      >
        <DeployKeyPanel
          appId={created.app.id}
          repoUrl={created.app.repoUrl}
          publicKey={created.key?.publicKey ?? null}
          fingerprint={created.key?.fingerprint ?? null}
          createdAt={created.key?.createdAt ?? null}
          onDisk={Boolean(created.key)}
          initialError={created.keyError}
          onChanged={() => onCreated?.(created.app)}
        />
        <p className="mt-3 text-2xs text-faint">
          Closing keeps the app and its key; you can add the key to GitHub later from the app’s
          GitHub tab.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      preventClose={saving}
      size="lg"
      title={editing ? `Edit ${app.id}` : 'New app'}
      description={
        editing
          ? 'Changes apply to the next deployment. The running release is not touched.'
          : 'Where the code lives and how this server may read it. Everything else can be left to the project.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="deploy-app-form" loading={saving}>
            {editing ? 'Save app' : 'Create app'}
          </Button>
        </>
      }
    >
      <form
        id="deploy-app-form"
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
      >
        {formError && (
          <InlineAlert tone="danger" title={editing ? 'The app was not saved' : 'The app was not created'}>
            {formError}
          </InlineAlert>
        )}
        <section className="space-y-4">
          <FormGrid>
            <TextInput
              label="Name"
              value={draft.id}
              onChange={(event) => set({ id: event.target.value.toLowerCase() })}
              disabled={editing}
              error={show('id')}
              hint={
                editing
                  ? 'The name cannot be changed.'
                  : 'Used for its folder and its PM2 process (ez-<name>).'
              }
              placeholder="my-api"
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
            <TextInput
              label="Branch"
              value={draft.branch}
              onChange={(event) => set({ branch: event.target.value })}
              hint="Deployed when no specific commit is named."
              placeholder="main"
              className="font-mono"
              spellCheck={false}
            />
          </FormGrid>
          <TextInput
            label="Repository URL"
            value={draft.repoUrl}
            onChange={(event) => set({ repoUrl: event.target.value })}
            error={show('repoUrl')}
            hint="https://github.com/owner/repo.git, or git@github.com:owner/repo.git for a deploy key."
            placeholder="https://github.com/owner/repo.git"
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
          />
          <Select
            label="Repository access"
            value={draft.authType}
            onChange={(event) => set({ authType: event.target.value as DeployAuthType })}
            hint={
              draft.authType === 'none'
                ? 'For a public repository.'
                : draft.authType === 'deployKey'
                  ? 'An SSH key generated here; you add its public half to the repository. Nothing secret leaves this server.'
                  : 'A personal access token stored on this server and sent only to the repository host.'
            }
          >
            <option value="none">Public — no credentials</option>
            <option value="deployKey">Private — deploy key (SSH)</option>
            <option value="token">Private — access token (HTTPS)</option>
          </Select>

          {draft.authType === 'token' && (
            <TextInput
              label="Access token"
              type="password"
              value={draft.token}
              onChange={(event) => set({ token: event.target.value })}
              error={show('token')}
              hint={
                editing && app.hasToken
                  ? 'A token is stored. Leave this empty to keep it.'
                  : 'Read-only access to this one repository is enough.'
              }
              placeholder={editing && app.hasToken ? '••••••••' : 'github_pat_…'}
              autoComplete="off"
              spellCheck={false}
            />
          )}

          {draft.authType === 'deployKey' && ssh ? (
            editing ? (
              <DeployKeyPanel
                appId={app.id}
                repoUrl={app.repoUrl}
                publicKey={app.deployKey}
                fingerprint={app.deployKeyFingerprint ?? null}
                createdAt={app.deployKeyCreatedAt ?? null}
                onDisk={app.deployKeyOnDisk ?? Boolean(app.deployKey)}
                onChanged={onRefresh}
              />
            ) : (
              <Checkbox
                label="Generate a deploy key for me"
                hint="Made in the same step as the app, without deploying anything. You then add its public half to the repository."
                checked={draft.generateKey}
                onChange={(generateKey) => set({ generateKey })}
              />
            )
          ) : null}
        </section>

        <section className="space-y-4 border-t border-line pt-5">
          <div>
            <h3 className="text-sm font-semibold text-ink">How it runs</h3>
            <p className="mt-0.5 text-xs text-muted">
              All optional. An empty field is read from the repository’s{' '}
              <code className="font-mono">ez.json</code>, and failing that from{' '}
              <code className="font-mono">package.json</code>.
            </p>
          </div>
          {serverWarnings.map((warning) => (
            <InlineAlert key={warning} tone="warning">
              {warning}
            </InlineAlert>
          ))}
          <FormGrid>
            <TextInput
              label="Port"
              optional
              type="number"
              min={1}
              max={65535}
              inputMode="numeric"
              value={draft.settings.port}
              onChange={(event) => setSettings({ port: event.target.value })}
              error={show('port')}
              hint="The port the app listens on. Passed to it as PORT, and used for the health check."
              placeholder="3000"
            />
            <TextInput
              label="Health check path"
              optional
              value={draft.settings.healthPath}
              onChange={(event) => setSettings({ healthPath: event.target.value })}
              error={show('healthPath')}
              hint="Must answer before a deployment counts. Defaults to /."
              placeholder="/healthz"
              className="font-mono"
              spellCheck={false}
            />
          </FormGrid>
          <TextInput
            label="Start command"
            optional
            value={draft.settings.start}
            onChange={(event) => setSettings({ start: event.target.value })}
            hint="The long-running process. Any language: node server.js, python app.py, ./server."
            placeholder="from ez.json, or npm start"
            className="font-mono"
            spellCheck={false}
          />
          <FormGrid>
            <div className="space-y-2">
              <TextInput
                label="Install command"
                optional
                value={draft.settings.install}
                onChange={(event) => setSettings({ install: event.target.value })}
                disabled={draft.settings.skipInstall}
                placeholder="from ez.json, or npm ci"
                className="font-mono"
                spellCheck={false}
              />
              <Checkbox
                label="Skip the install step"
                checked={draft.settings.skipInstall}
                onChange={(checked) => setSettings({ skipInstall: checked })}
              />
            </div>
            <div className="space-y-2">
              <TextInput
                label="Build command"
                optional
                value={draft.settings.build}
                onChange={(event) => setSettings({ build: event.target.value })}
                disabled={draft.settings.skipBuild}
                placeholder="from ez.json, or npm run build"
                className="font-mono"
                spellCheck={false}
              />
              <Checkbox
                label="Skip the build step"
                checked={draft.settings.skipBuild}
                onChange={(checked) => setSettings({ skipBuild: checked })}
              />
            </div>
          </FormGrid>
          <div className="space-y-1">
            <TextInput
              label="Migrate command(s)"
              optional
              value={draft.settings.migrate}
              onChange={(event) =>
                setSettings({ migrate: event.target.value, migrateOff: false, migrateOverride: true })
              }
              hint="Runs after build, before the new release starts. Forward-only: a rollback does not undo a migration."
              placeholder="from ez.json, e.g. npx prisma migrate deploy"
              className="font-mono"
              spellCheck={false}
            />
            <OverrideRow
              overridden={draft.settings.migrateOverride}
              note={
                draft.settings.migrateOverride
                  ? draft.settings.migrateOff
                    ? 'the migrate step is off for this app.'
                    : 'saved on this app instead of ez.json.'
                  : 'No override — read from ez.json (nothing runs when ez.json has no migrate).'
              }
              onClear={clearMigrateOverride}
            />
          </div>
          <FormGrid>
            <Select
              label="Process mode"
              value={draft.settings.execMode}
              onChange={(event) =>
                setSettings({
                  execMode: event.target.value as SettingsDraft['execMode'],
                  execModeOverride: true,
                })
              }
              hint="Cluster runs one worker per instance. It needs a start command of the form node <file>."
            >
              <option value="fork">Fork — one process</option>
              <option value="cluster" disabled={clusterAllowed === false}>
                Cluster — several workers
              </option>
            </Select>
            <TextInput
              label="Instances"
              optional
              value={draft.settings.instances}
              onChange={(event) =>
                setSettings({ instances: event.target.value, instancesOverride: true })
              }
              error={show('instances')}
              hint="A whole number up to this server’s CPU count, or “max”. Leave empty for 1."
              placeholder="1"
            />
          </FormGrid>
          <OverrideRow
            overridden={draft.settings.execModeOverride}
            note={
              draft.settings.execModeOverride
                ? 'the process mode is saved on this app instead of ez.json.'
                : editing
                  ? 'No override — the effective mode comes from ez.json, else the default.'
                  : 'No override yet — fork is the default.'
            }
            onClear={clearExecModeOverride}
          />
          <OverrideRow
            overridden={draft.settings.instancesOverride}
            note={
              draft.settings.instancesOverride
                ? 'the instance count is saved on this app instead of ez.json.'
                : editing
                  ? 'No override — the effective count comes from ez.json, else the default (1).'
                  : 'No override yet — one instance is the default.'
            }
            onClear={clearInstancesOverride}
          />
          {clusterBlocked && (
            <InlineAlert tone="warning">
              Cluster mode needs a start command that runs a JS file directly, such as{' '}
              <code className="font-mono">node dist/index.js</code> — not an npm script or another
              language. Change the start command, or choose Fork.
            </InlineAlert>
          )}
          {draft.settings.execMode === 'cluster' && (
            <InlineAlert tone="warning" title="Cluster mode">
              {CLUSTER_STATELESS_WARNING}
            </InlineAlert>
          )}
          {forkWithInstances && (
            <InlineAlert tone="warning">
              Fork mode starts one process. Several forked copies would all bind the same port —
              choose Cluster for {draft.settings.instances} instances.
            </InlineAlert>
          )}
        </section>

        <section className="space-y-4 border-t border-line pt-5">
          <div>
            <h3 className="text-sm font-semibold text-ink">Persistent data</h3>
            <p className="mt-0.5 text-xs text-muted">
              Each deployment runs from a fresh copy of your code. Files written to at runtime are
              lost on the next deploy — and on rollback. Every path listed here, a folder or a
              single file, lives in a shared location that every deployment and every rollback
              reuses.
            </p>
          </div>
          <TagInput
            label="Folders and files to keep"
            optional
            value={draft.settings.persist}
            onChange={(persist) => setSettings({ persist })}
            normalize={(raw, current) => {
              const result = checkPersistAddition(raw, current);
              return { value: result.path, error: result.error };
            }}
            max={20}
            hint="Add folders your app writes to: uploads, SQLite data, logs — or one file, such as prisma/app.db. Press Enter after each path."
            placeholder="data, uploads, prisma/app.db"
          />
          <div className="space-y-1 text-2xs text-faint">
            <p>
              The first deployment copies the current contents into the shared location; after
              that, the shared copy is what counts — changes to it in the repository are ignored.
              A folder is usually the safer unit: SQLite creates <code className="font-mono">-wal</code> and{' '}
              <code className="font-mono">-shm</code> files next to its database. Left empty, the
              list is read from <code className="font-mono">ez.json</code>.
            </p>
            {editing && app?.sharedDir && (
              <p className="break-all">
                Kept in <span className="font-mono">{app.sharedDir}</span>
              </p>
            )}
          </div>
        </section>

        <section className="space-y-4 border-t border-line pt-5">
          <TextArea
            label="Environment variables"
            optional
            rows={5}
            value={draft.envText}
            onChange={(event) => set({ envText: event.target.value })}
            error={show('env')}
            hint="One NAME=value per line; a pasted .env file works. Stored on this server only, and available to the build and the running app."
            placeholder={'DATABASE_URL=postgres://…\nNODE_ENV=production'}
            className="font-mono"
            spellCheck={false}
          />
        </section>

        <section className="space-y-4 border-t border-line pt-5">
          <Switch
            checked={draft.autoRollback}
            onChange={(checked) => set({ autoRollback: checked })}
            label="Roll back automatically"
            description="If a new release starts but fails its health check, the previous release is started again."
          />
          <FormGrid>
            <TextInput
              label="Releases to keep"
              type="number"
              min={meta.limits.keepReleasesMin}
              max={meta.limits.keepReleasesMax}
              inputMode="numeric"
              value={draft.keepReleases}
              onChange={(event) => set({ keepReleases: event.target.value })}
              error={show('keepReleases')}
              hint="Older ones are deleted. The live release and the one before it are always kept."
            />
          </FormGrid>
          {meta.channels.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-ink">Notify on every deployment</div>
              <div className="space-y-1.5">
                {meta.channels.map((channel) => (
                  <Checkbox
                    key={channel.id}
                    label={`${channel.name} (${channel.type})`}
                    checked={draft.notifyChannelIds.includes(channel.id)}
                    onChange={(checked) =>
                      set({
                        notifyChannelIds: checked
                          ? [...draft.notifyChannelIds, channel.id]
                          : draft.notifyChannelIds.filter((id) => id !== channel.id),
                      })
                    }
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      </form>
    </Modal>
  );
}
