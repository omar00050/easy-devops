import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type {
  DeployApp,
  DeployAppInput,
  DeployAuthType,
  DeploymentsResponse,
} from '../../lib/types';
import {
  checkPersistAddition,
  envToText,
  fromSettingsDraft,
  isSshUrl,
  parseEnvText,
  toSettingsDraft,
  validateAppId,
  type SettingsDraft,
} from '../../lib/deployments';
import { validatePort } from '../../lib/validation';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { Checkbox, FormGrid, Select, Switch, TagInput, TextArea, TextInput } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { InlineAlert } from '../ui/States';
import { useToast } from '../ui/Toast';

interface Draft {
  id: string;
  repoUrl: string;
  branch: string;
  authType: DeployAuthType;
  token: string;
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
    settings: toSettingsDraft(app.settings),
    envText: envToText(app.env),
    keepReleases: String(app.keepReleases),
    autoRollback: app.autoRollback,
    notifyChannelIds: app.notifyChannelIds,
  };
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
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
}: {
  open: boolean;
  /** The app being edited, or null to create one. */
  app: DeployApp | null;
  meta: DeploymentsResponse;
  onClose: () => void;
  onSaved: (app: DeployApp, created: boolean) => void;
}) {
  const toast = useToast();
  const editing = app !== null;
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(meta.limits.keepReleasesDefault));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deployKey, setDeployKey] = useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(app ? draftFrom(app) : emptyDraft(meta.limits.keepReleasesDefault));
    setDeployKey(app?.deployKey ?? null);
    setTouched(false);
    // Reset only when the modal opens or the target changes, not on every
    // background refresh of the list behind it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, app?.id]);

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setSettings = (patch: Partial<SettingsDraft>) =>
    setDraft((current) => ({ ...current, settings: { ...current.settings, ...patch } }));

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
  };
  const invalid = Object.values(errors).some(Boolean);

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

    setSaving(true);
    try {
      const saved = editing
        ? await api.deployments.update(app.id, input)
        : await api.deployments.create({ ...input, id: draft.id.trim() });
      onSaved(saved, !editing);
    } catch (error) {
      toast.error(
        editing ? 'Could not save the app' : 'Could not create the app',
        errorText(error, 'Nothing was changed.')
      );
    } finally {
      setSaving(false);
    }
  };

  const generateKey = async () => {
    if (!app || generatingKey) return;
    setGeneratingKey(true);
    try {
      const result = await api.deployments.generateDeployKey(app.id);
      setDeployKey(result.publicKey);
      toast.success('Deploy key generated', 'Add the public key to the repository, read-only.');
    } catch (error) {
      toast.error('Could not generate the key', errorText(error, 'Try again.'));
    } finally {
      setGeneratingKey(false);
    }
  };

  const show = <K extends keyof typeof errors>(key: K) => (touched ? errors[key] : null);

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

          {draft.authType === 'deployKey' &&
            (editing ? (
              <div className="rounded-md border border-line bg-inset/50 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium text-ink">Deploy key</div>
                  <Button
                    size="sm"
                    icon={<KeyRound className="size-3.5" aria-hidden="true" />}
                    onClick={() => void generateKey()}
                    loading={generatingKey}
                  >
                    {deployKey ? 'Generate a new key' : 'Generate key'}
                  </Button>
                </div>
                {deployKey ? (
                  <>
                    <pre className="mt-2.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-canvas p-2.5 font-mono text-2xs text-muted">
                      {deployKey}
                    </pre>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-2xs text-faint">
                        Add it under the repository’s Settings → Deploy keys. Leave “Allow write
                        access” off.
                      </p>
                      <CopyButton value={deployKey} label="Copy public key" withText />
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-2xs text-faint">
                    No key yet. The private half stays on this server and is never shown.
                  </p>
                )}
              </div>
            ) : (
              <InlineAlert tone="info">
                Create the app first; the key is generated from its settings afterwards.
              </InlineAlert>
            ))}
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
            hint="Add folders your app writes to: uploads, SQLite data, logs — or one file, such as prisma/hub.db. Press Enter after each path."
            placeholder="data, uploads, prisma/hub.db"
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
