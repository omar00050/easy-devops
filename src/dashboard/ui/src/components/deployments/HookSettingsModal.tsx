import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { DeployHook, DeploymentsResponse } from '../../lib/types';
import { validatePort } from '../../lib/validation';
import { Button } from '../ui/Button';
import { FormGrid, Select, Switch, TextInput } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { InlineAlert } from '../ui/States';
import { useToast } from '../ui/Toast';

type Exposure = 'domain' | 'direct' | 'local';

function exposureOf(hook: DeployHook): Exposure {
  if (hook.domain) return 'domain';
  return hook.bind === '0.0.0.0' ? 'direct' : 'local';
}

/**
 * The deploy hook: whether CI may trigger deployments here, and how it is
 * reached.
 *
 * The three ways of exposing it are presented as one choice rather than as a
 * bind address and a domain field, because those two only make sense in three
 * combinations and the fourth (a domain AND every interface) is just a wider
 * door than anyone meant to open.
 */
export function HookSettingsModal({
  open,
  hook,
  domains,
  onClose,
  onSaved,
}: {
  open: boolean;
  hook: DeployHook;
  domains: DeploymentsResponse['domains'];
  onClose: () => void;
  onSaved: (hook: DeployHook) => void;
}) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(hook.enabled);
  const [exposure, setExposure] = useState<Exposure>(exposureOf(hook));
  const [domain, setDomain] = useState(hook.domain ?? '');
  const [port, setPort] = useState(String(hook.port));
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEnabled(hook.enabled);
    setExposure(exposureOf(hook));
    setDomain(hook.domain ?? '');
    setPort(String(hook.port));
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const usable = domains.filter((d) => d.enabled);
  const chosen = usable.find((d) => d.name === domain);
  const portError = validatePort(port);
  const domainError =
    enabled && exposure === 'domain' && !chosen ? 'Choose a domain.' : null;

  const save = async () => {
    if (saving) return;
    setTouched(true);
    if (portError || domainError) return;

    setSaving(true);
    try {
      const saved = await api.deployments.updateHook({
        enabled,
        port: Number(port),
        bind: exposure === 'direct' ? '0.0.0.0' : '127.0.0.1',
        domain: exposure === 'domain' ? domain : null,
      });
      if (saved.nginxReloaded === false) {
        toast.warning(
          'Saved, but nginx was not reloaded',
          'The domain’s config was written. Reload nginx for the deploy hook to be reachable.'
        );
      } else {
        toast.success(
          'Deploy hook saved',
          enabled
            ? `The background service picks it up within ${saved.appliesWithinSeconds ?? 10} seconds.`
            : 'Nothing is listening for deployments now.'
        );
      }
      onSaved(saved);
    } catch (error) {
      const detail =
        error instanceof ApiError && typeof error.payload.detail === 'string'
          ? error.payload.detail
          : null;
      toast.error(
        'Could not save the deploy hook',
        detail ?? (error instanceof Error ? error.message : 'Nothing was changed.')
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      preventClose={saving}
      size="md"
      title="Deploy hook"
      description="Lets a GitHub Action tell this server to deploy. Each app has its own token; the hook can do nothing else."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Switch
          checked={enabled}
          onChange={setEnabled}
          label="Accept deployments from CI"
          description="Off by default. While it is off nothing listens, and apps can only be deployed from this dashboard."
        />

        {enabled && (
          <>
            <Select
              label="How CI reaches it"
              value={exposure}
              onChange={(event) => setExposure(event.target.value as Exposure)}
            >
              <option value="domain">Through one of my domains (recommended)</option>
              <option value="direct">Directly, on its own port</option>
              <option value="local">This machine only</option>
            </Select>

            {exposure === 'domain' && (
              <>
                <Select
                  label="Domain"
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                  error={touched ? domainError : null}
                  hint="One path, /.ez-deploy/, is added to this domain’s nginx config. Nothing else becomes reachable."
                >
                  <option value="">Choose a domain…</option>
                  {usable.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name}
                      {d.ssl ? '' : ' — no SSL'}
                    </option>
                  ))}
                </Select>
                {usable.length === 0 && (
                  <InlineAlert tone="warning">
                    There is no enabled domain yet. Add one on the Domains page, or reach the hook
                    directly.
                  </InlineAlert>
                )}
                {chosen && !chosen.ssl && (
                  <InlineAlert tone="warning" title="This domain has no certificate">
                    The deploy token would travel over plain HTTP. Issue a certificate for it on
                    the SSL page first.
                  </InlineAlert>
                )}
              </>
            )}

            {exposure === 'direct' && (
              <InlineAlert tone="warning" title="Plain HTTP, on every network interface">
                The deploy token is sent unencrypted, and the port has to be opened in your
                firewall. Use a domain with SSL unless this server sits on a private network.
              </InlineAlert>
            )}

            {exposure === 'local' && (
              <InlineAlert tone="info">
                Only programs on this server can call the hook — useful with your own tunnel or
                reverse proxy. GitHub cannot reach it.
              </InlineAlert>
            )}

            <FormGrid>
              <TextInput
                label="Listener port"
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                error={touched ? portError : null}
                hint={
                  exposure === 'direct'
                    ? 'The port CI connects to.'
                    : 'Internal. nginx forwards to it; it is not opened to the network.'
                }
              />
            </FormGrid>
          </>
        )}
      </div>
    </Modal>
  );
}
