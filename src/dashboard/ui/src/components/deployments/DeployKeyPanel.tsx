import { useState } from 'react';
import { Check, ExternalLink, KeyRound, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { deployKeyAddUrl } from '../../lib/deployments';
import type { DeployKeyGithubResult, DeployKeyTestResult } from '../../lib/types';
import { useConfirm } from '../../hooks/useResource';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { TextInput } from '../ui/Field';
import { InlineAlert } from '../ui/States';
import { useToast } from '../ui/Toast';

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

/**
 * The one deploy-key panel: shown as step 2 of creating an app and again in
 * the app's GitHub tab. It only ever handles the public half; the private key
 * stays on the server.
 */
export function DeployKeyPanel({
  appId,
  repoUrl,
  publicKey: initialPublicKey,
  fingerprint: initialFingerprint,
  createdAt: initialCreatedAt,
  onDisk = false,
  initialError = null,
  onChanged,
}: {
  appId: string;
  repoUrl: string;
  publicKey?: string | null;
  fingerprint?: string | null;
  createdAt?: string | null;
  onDisk?: boolean;
  /** A key could not be generated while the app was created. */
  initialError?: string | null;
  /** Called after a key is generated or replaced, so the app detail can refresh. */
  onChanged?: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [publicKey, setPublicKey] = useState(initialPublicKey ?? null);
  const [fingerprint, setFingerprint] = useState(initialFingerprint ?? null);
  const [createdAt, setCreatedAt] = useState(initialCreatedAt ?? null);
  const [previousFingerprint, setPreviousFingerprint] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(initialError);
  const [regenerating, setRegenerating] = useState(false);

  const [adding, setAdding] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState('');
  const [addResult, setAddResult] = useState<DeployKeyGithubResult | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DeployKeyTestResult | null>(null);

  const addUrl = deployKeyAddUrl(repoUrl);

  const regenerate = async () => {
    if (regenerating) return;
    const sure = await confirm({
      title: 'Replace the deploy key?',
      body: (
        <>
          The old key stops working here at once. GitHub keeps listing the old public key until
          you remove it — using “Add it to GitHub for me” afterwards removes the old key with the
          same title automatically.
        </>
      ),
      confirmLabel: 'Replace the key',
      tone: 'danger',
    });
    if (!sure) return;
    setRegenerating(true);
    try {
      const result = await api.deployments.generateDeployKey(appId);
      setPublicKey(result.publicKey);
      setFingerprint(result.fingerprint);
      setCreatedAt(result.createdAt);
      setPreviousFingerprint(result.previousFingerprint ?? null);
      setKeyError(null);
      setAddResult(null);
      setTestResult(null);
      toast.success('Deploy key replaced', 'Add the new public key to the repository.');
      onChanged?.();
    } catch (error) {
      toast.error('Could not replace the key', errorText(error, 'The old key is unchanged.'));
    } finally {
      setRegenerating(false);
    }
  };

  const addToGithub = async () => {
    if (adding) return;
    setAdding(true);
    setAddResult(null);
    const typed = token.trim();
    try {
      const result = await api.deployments.addDeployKeyToGithub(appId, typed || undefined);
      setAddResult(result);
      if (result.ok) toast.success('Key added to GitHub', 'It is read-only.');
    } catch (error) {
      setAddResult({ ok: false, error: errorText(error, 'GitHub did not accept the key.'), steps: undefined });
    } finally {
      // The token was used once; it is not kept in state, a URL or a log.
      setToken('');
      setAdding(false);
    }
  };

  const test = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.deployments.testDeployKey(appId));
    } catch (error) {
      setTestResult({ ok: false, status: 0, error: errorText(error, 'The test could not run.') });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-line bg-inset/40 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted" aria-hidden="true" />
          <span className="text-sm font-medium text-ink">Deploy key</span>
        </div>
        <Button
          size="sm"
          icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
          onClick={() => void regenerate()}
          loading={regenerating}
        >
          {publicKey || keyError ? 'Regenerate key' : 'Generate key'}
        </Button>
      </div>

      {keyError ? (
        <InlineAlert tone="danger" title="The key was not generated">
          {keyError} Press “Regenerate key” to try again; the app itself was created.
        </InlineAlert>
      ) : null}

      {publicKey ? (
        <>
          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <span className="text-2xs font-medium uppercase tracking-[0.12em] text-faint">
                Public key
              </span>
              <CopyButton value={publicKey} label="Copy public key" withText />
            </div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-canvas p-2.5 font-mono text-2xs text-muted">
              {publicKey}
            </pre>
          </div>

          <p className="break-all font-mono text-2xs text-faint">
            Fingerprint {fingerprint ?? 'not reported'}
            {createdAt ? ` · created ${new Date(createdAt).toLocaleDateString()}` : ''}
          </p>
          {previousFingerprint ? (
            <p className="break-all text-2xs text-warn">
              Replaced {previousFingerprint}. The old key still needs removing on GitHub.
            </p>
          ) : null}
          {!onDisk ? (
            <p className="text-2xs text-warn">
              The private half is not on the server's disk any more; regenerate the key before the
              next deployment.
            </p>
          ) : null}

          <ol className="list-decimal space-y-1 pl-4 text-xs text-muted">
            <li>In the repository: Settings → Deploy keys → Add deploy key.</li>
            <li>Paste the key above. The title is up to you.</li>
            <li>Leave “Allow write access” off — deployments only read.</li>
          </ol>

          {addUrl ? (
            <a
              href={addUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-text underline-offset-2 hover:underline"
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
              Open GitHub&apos;s Add deploy key page
            </a>
          ) : null}

          {addUrl ? (
            <div className="space-y-2 border-t border-line pt-3">
              {!tokenOpen ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ShieldCheck className="size-3.5" aria-hidden="true" />}
                  onClick={() => setTokenOpen(true)}
                  disabled={adding}
                >
                  Add it to GitHub for me
                </Button>
              ) : (
                <div className="space-y-2">
                  <TextInput
                    label="GitHub token"
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    hint="Used once for this request and not stored. It needs Administration: read and write on this repository."
                    placeholder="github_pat_…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setToken('');
                        setTokenOpen(false);
                      }}
                      disabled={adding}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => void addToGithub()} loading={adding}>
                      Add the key
                    </Button>
                  </div>
                </div>
              )}
              {addResult ? (
                <div className="space-y-1.5">
                  {(addResult.steps ?? []).map((step) => (
                    <p
                      key={step.id}
                      className={`flex items-start gap-1.5 text-2xs ${step.ok ? 'text-ok' : 'text-bad'}`}
                    >
                      {step.ok ? (
                        <Check className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                      ) : (
                        <X className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                      )}
                      <span>{step.detail}</span>
                    </p>
                  ))}
                  {addResult.error && (addResult.steps ?? []).length === 0 ? (
                    <InlineAlert tone="danger">{addResult.error}</InlineAlert>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-2xs text-faint">
              Automatic setup works with github.com repositories only; for another host, add the
              key there by hand.
            </p>
          )}

          <div className="space-y-2 border-t border-line pt-3">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void test()}
              loading={testing}
              icon={<ShieldCheck className="size-3.5" aria-hidden="true" />}
            >
              Test connection
            </Button>
            {testResult ? (
              testResult.ok ? (
                <p className="flex items-start gap-1.5 text-2xs text-ok">
                  <Check className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span>{testResult.detail ?? 'The key can read the repository.'}</span>
                </p>
              ) : (
                <p className="flex items-start gap-1.5 text-2xs text-bad">
                  <X className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span>{testResult.error ?? 'The key could not read the repository.'}</span>
                </p>
              )
            ) : null}
          </div>
        </>
      ) : !keyError ? (
        <p className="text-xs text-muted">
          No key yet. Generate one and add its public half to the repository as a read-only deploy
          key. The private half stays on this server and is never shown.
        </p>
      ) : null}
    </div>
  );
}
