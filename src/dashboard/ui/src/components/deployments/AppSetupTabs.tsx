import { useEffect, useState } from 'react';
import { Download, FolderInput, Globe2, Link2Off, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type { DeployApp, DeployAppDetail, DeploymentsResponse } from '../../lib/types';
import { EZ_JSON_FIELDS, EZ_JSON_PYTHON, buildEzJson } from '../../lib/deployments';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { Checkbox, TextInput } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { InlineAlert } from '../ui/States';
import { useToast } from '../ui/Toast';

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Deleting an app, with the two questions that have no safe default: what
 * about its domain, and what about the folders it writes to. Both boxes start
 * unticked — a domain may be serving something else by now, and persistent
 * data is the part of an app that cannot be created again.
 */
export function DeleteAppModal({
  app,
  onClose,
  onDeleted,
}: {
  app: DeployApp | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [deleteDomain, setDeleteDomain] = useState(false);
  const [purgeData, setPurgeData] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (app) {
      setDeleteDomain(false);
      setPurgeData(false);
    }
  }, [app]);

  const keepsData = Boolean(
    app &&
      (app.hasSharedData ||
        (Array.isArray(app.settings.persist)
          ? app.settings.persist.length > 0
          : Boolean(app.settings.persist)))
  );

  const remove = async () => {
    if (!app || busy) return;
    setBusy(true);
    try {
      const result = await api.deployments.remove(app.id, {
        deleteDomain: deleteDomain && Boolean(app.domain),
        purgeData,
      });
      const kept =
        result.sharedKept && result.sharedPath
          ? `Persistent data was kept in ${result.sharedPath}.`
          : '';
      if (result.warning) toast.warning(`${app.id} deleted`, `${result.warning} ${kept}`.trim());
      else
        toast.success(
          `${app.id} deleted`,
          [result.domainDeleted ? `${app.domain} was removed too.` : '', kept]
            .filter(Boolean)
            .join(' ') || undefined
        );
      onDeleted();
    } catch (error) {
      toast.error(`Could not delete ${app.id}`, errorText(error, 'Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={app !== null}
      onClose={onClose}
      preventClose={busy}
      size="sm"
      title={`Delete ${app?.id ?? ''}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void remove()} loading={busy}>
            Delete app
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-muted">
        <p>
          Its process is stopped and removed from PM2, and every release, log and its deploy key
          are deleted from this server. The repository is not touched.
        </p>
        {app?.dir && <p className="break-all font-mono text-2xs text-faint">{app.dir}</p>}
        {keepsData && app && (
          <div className="space-y-2 rounded-md border border-line bg-inset/40 p-3">
            <div className="text-xs font-medium text-ink">Persistent data</div>
            <p className="text-xs">
              Folders this app writes to are kept by default, so a later app with the same name
              can pick up its database and uploads.
            </p>
            {app.sharedDir && (
              <p className="break-all font-mono text-2xs text-faint">{app.sharedDir}</p>
            )}
            <Checkbox
              label="Also delete the persistent data"
              hint="The shared folders are deleted too and cannot be recovered."
              checked={purgeData}
              onChange={setPurgeData}
            />
          </div>
        )}
        {app?.domain && (
          <Checkbox
            label={
              <>
                Also delete the domain <span className="font-mono text-ink">{app.domain}</span>
              </>
            }
            hint="Its nginx config is removed and the site stops answering. Leave this off to keep the domain."
            checked={deleteDomain}
            onChange={setDeleteDomain}
          />
        )}
      </div>
    </Modal>
  );
}

// ─── Domain and folder ────────────────────────────────────────────────────────

export function DomainFolderTab({
  app,
  meta,
  onChanged,
  onDelete,
}: {
  app: DeployAppDetail;
  meta: DeploymentsResponse;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const toast = useToast();
  const [domain, setDomain] = useState('');
  const [ssl, setSsl] = useState(false);
  const [linking, setLinking] = useState(false);
  const [target, setTarget] = useState('');
  const [moving, setMoving] = useState(false);

  const name = domain.trim().toLowerCase();
  const existing = meta.domains.find((d) => d.name === name);
  const port = app.settings.port ?? null;

  const link = async () => {
    if (!name || linking) return;
    setLinking(true);
    try {
      const result = await api.deployments.linkDomain(app.id, name, ssl && !existing?.ssl);
      const base = result.created
        ? `${result.domain} was created and proxies to port ${result.port}.`
        : `${result.domain} now proxies to port ${result.port}.`;
      if (result.ssl && !result.ssl.ok) toast.warning('Linked, without a certificate', `${base} ${result.ssl.detail}`);
      else if (!result.nginxReloaded) toast.warning('Linked, but nginx was not reloaded', `${base} Reload nginx for it to take effect.`);
      else toast.success('Domain linked', result.ssl?.ok ? `${base} ${result.ssl.detail}` : base);
      setDomain('');
      setSsl(false);
      onChanged();
    } catch (error) {
      toast.error('Could not link the domain', errorText(error, 'Nothing was changed.'));
    } finally {
      setLinking(false);
    }
  };

  const unlink = async () => {
    try {
      await api.deployments.unlinkDomain(app.id);
      toast.success('Link removed', `${app.domain} is still configured; only the link is gone.`);
      onChanged();
    } catch (error) {
      toast.error('Could not remove the link', errorText(error, 'Nothing was changed.'));
    }
  };

  const move = async () => {
    if (!target.trim() || moving) return;
    setMoving(true);
    try {
      const result = await api.deployments.move(app.id, target.trim());
      if (result.warning) toast.warning('Moved', result.warning);
      else toast.success('App moved', `${result.to}${result.restarted ? ' — and started again.' : ''}`);
      setTarget('');
      onChanged();
    } catch (error) {
      toast.error('Could not move the app', errorText(error, 'It is still where it was.'));
    } finally {
      setMoving(false);
    }
  };

  return (
    <div className="space-y-7">
      {/* Domain */}
      <section className="space-y-3">
        <div className="flex items-start gap-2.5">
          <Globe2 className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
          <div>
            <h4 className="text-sm font-semibold text-ink">Domain</h4>
            <p className="mt-0.5 text-xs text-muted">
              Point a domain at this app. nginx proxies it to the app’s port, and a deployment that
              changes the port takes the domain with it.
            </p>
          </div>
        </div>

        {app.domain ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-inset/40 px-3.5 py-2.5">
            <div className="min-w-0">
              <div className="truncate font-mono text-sm text-ink">{app.domain}</div>
              <div className="text-2xs text-faint">
                {port ? `Proxies to port ${port}.` : 'Proxies to the app’s port.'} Edit it on the
                Domains page.
              </div>
            </div>
            <Button
              size="sm"
              icon={<Link2Off className="size-3.5" aria-hidden="true" />}
              onClick={() => void unlink()}
            >
              Remove link
            </Button>
          </div>
        ) : null}

        <div className="space-y-2.5">
          <div>
            <div className="flex flex-wrap items-end gap-2">
              <TextInput
                label={app.domain ? 'Link a different domain' : 'Domain name'}
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="app.example.com"
                list="deploy-domain-options"
                aria-describedby="deploy-domain-hint"
                className="min-w-56 flex-1 font-mono"
                spellCheck={false}
                autoComplete="off"
              />
              <Button variant="primary" onClick={() => void link()} loading={linking} disabled={!name}>
                Link domain
              </Button>
            </div>
            <p id="deploy-domain-hint" className="mt-1.5 text-xs text-faint">
              {!name
                ? 'Type a new name, or pick one of your domains.'
                : existing
                  ? 'This domain exists. It will be re-pointed at this app.'
                  : 'This domain will be created.'}
            </p>
          </div>
          <datalist id="deploy-domain-options">
            {meta.domains.map((d) => (
              <option key={d.name} value={d.name} />
            ))}
          </datalist>
          {name && !existing?.ssl && (
            <Checkbox
              label="Request an SSL certificate"
              hint="Over HTTP-01, so the domain’s DNS must already point at this server. If it cannot be issued the domain still works over HTTP, and you can issue it later from the SSL page."
              checked={ssl}
              onChange={setSsl}
            />
          )}
          {!port && !app.currentRelease && (
            <InlineAlert tone="info">
              The app needs a port first: set one in Edit, or put <code className="font-mono">port</code>{' '}
              in ez.json and deploy once.
            </InlineAlert>
          )}
        </div>
      </section>

      {/* Folder */}
      <section className="space-y-3 border-t border-line pt-6">
        <div className="flex items-start gap-2.5">
          <FolderInput className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-ink">Folder</h4>
            <p className="mt-0.5 text-xs text-muted">
              Where this app’s releases, logs and deploy key live. It stays here even if the
              deployments folder in Settings changes.
            </p>
            <p className="mt-1.5 break-all font-mono text-2xs text-ink">{app.dir ?? '—'}</p>
          </div>
        </div>
        <div>
          <div className="flex flex-wrap items-end gap-2">
            <TextInput
              label="Move to"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={meta.deployDir ?? '/srv/ez_deploys'}
              aria-describedby="deploy-move-hint"
              className="min-w-56 flex-1 font-mono"
              spellCheck={false}
              autoComplete="off"
            />
            <Button
              onClick={() => void move()}
              loading={moving}
              disabled={!target.trim() || Boolean(app.deploying)}
            >
              Move app
            </Button>
          </div>
          <p id="deploy-move-hint" className="mt-1.5 text-xs text-faint">
            {target.trim()
              ? `The app will be in ${target.trim().replace(/[\\/]+$/, '')}/${app.id}`
              : 'A folder on this server. The app goes into a subfolder named after it.'}
          </p>
        </div>
        <p className="text-2xs text-faint">
          The app is stopped, its folder is moved, and it is started again from the new place. To
          another disk this copies every release, and can take a while.
        </p>
      </section>

      {/* Delete */}
      <section className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6">
        <div>
          <h4 className="text-sm font-semibold text-ink">Delete this app</h4>
          <p className="mt-0.5 text-xs text-muted">
            Stops it and removes its folder. You are asked what to do with its domain.
          </p>
        </div>
        <Button
          variant="danger"
          icon={<Trash2 className="size-4" aria-hidden="true" />}
          onClick={onDelete}
          disabled={Boolean(app.deploying)}
        >
          Delete app
        </Button>
      </section>
    </div>
  );
}

// ─── ez.json ──────────────────────────────────────────────────────────────────

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * A guide to ez.json built around THIS app: the file shown is what the app
 * deploys with today, written out, so copying it into the repository changes
 * nothing except where the commands are kept.
 */
export function EzJsonTab({ app, locations }: { app: DeployAppDetail; locations: string[] }) {
  const file = buildEzJson(app.settings);

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-xs text-muted">
        <p>
          <code className="font-mono text-ink">ez.json</code> is an optional file in your repository
          that says how the project is installed, built and started. Keeping it with the code means
          the commands are reviewed and versioned like everything else, and a new server needs no
          setup.
        </p>
        <p>
          <strong className="font-medium text-ink">You do not need one for a Node project</strong> —
          without it, the scripts in <code className="font-mono">package.json</code> are used. You
          do need one for any other language.
        </p>
      </div>

      <ol className="space-y-5">
        <li className="space-y-2">
          <h4 className="text-sm font-medium text-ink">1. Create the file</h4>
          <p className="text-xs text-muted">
            This is what <span className="font-mono">{app.id}</span> deploys with today. Change the
            commands to match your project.
          </p>
          <pre className="overflow-auto rounded-md border border-line bg-canvas p-3.5 font-mono text-2xs leading-relaxed text-ink">
            {file}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton value={file} label="Copy ez.json" withText />
            <Button
              size="sm"
              icon={<Download className="size-3.5" aria-hidden="true" />}
              onClick={() => download('ez.json', file)}
            >
              Download ez.json
            </Button>
          </div>
        </li>

        <li className="space-y-2">
          <h4 className="text-sm font-medium text-ink">2. Put it in the repository</h4>
          <p className="text-xs text-muted">
            At the top of the repository, next to <code className="font-mono">package.json</code>.
            It is looked for in this order:{' '}
            {locations.map((location, index) => (
              <span key={location}>
                <code className="font-mono text-ink">{location}</code>
                {index < locations.length - 1 ? ', ' : '.'}
              </span>
            ))}
          </p>
        </li>

        <li className="space-y-2">
          <h4 className="text-sm font-medium text-ink">3. Commit, push, deploy</h4>
          <p className="text-xs text-muted">
            The next deployment reads it. Its log shows where each value came from —{' '}
            <code className="font-mono">[ez.json]</code>, <code className="font-mono">[package.json]</code>{' '}
            or <code className="font-mono">[override]</code> — so you can see that it was picked up.
          </p>
        </li>
      </ol>

      <div>
        <h4 className="mb-2 text-sm font-medium text-ink">What each field means</h4>
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-left text-2xs">
            <thead className="border-b border-line bg-inset/50 text-faint">
              <tr>
                <th className="px-3 py-2 font-semibold uppercase tracking-wider">Field</th>
                <th className="px-3 py-2 font-semibold uppercase tracking-wider">Meaning</th>
                <th className="px-3 py-2 font-semibold uppercase tracking-wider">If you leave it out</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {EZ_JSON_FIELDS.map((field) => (
                <tr key={field.name}>
                  <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-ink">{field.name}</td>
                  <td className="px-3 py-2 align-top text-muted">{field.meaning}</td>
                  <td className="px-3 py-2 align-top text-muted">{field.without}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-ink">Not a Node project?</h4>
        <p className="text-xs text-muted">
          The commands are run exactly as written, so any language works. A Python app:
        </p>
        <pre className="overflow-auto rounded-md border border-line bg-canvas p-3.5 font-mono text-2xs leading-relaxed text-ink">
          {EZ_JSON_PYTHON}
        </pre>
      </div>

      <InlineAlert tone="info" title="Which one wins">
        A value set on the app (Edit) overrides <code className="font-mono">ez.json</code>, which
        overrides <code className="font-mono">package.json</code>. To let the file decide, leave
        that field empty in Edit. A mistake in the file stops the deployment before anything that
        is running is touched.
      </InlineAlert>
    </div>
  );
}
