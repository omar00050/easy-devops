import { useRef, useState } from 'react';
import { Send, Webhook } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type { ChannelType, NotificationChannel } from '../../lib/types';
import { cn } from '../../lib/cn';
import { useConfirm } from '../../hooks/useResource';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { FieldHint, TextInput } from '../ui/Field';
import { InlineAlert } from '../ui/States';

const TYPES: {
  value: ChannelType;
  label: string;
  description: string;
  icon: typeof Webhook;
}[] = [
  {
    value: 'discord',
    label: 'Discord',
    description: 'Post alerts to a channel through a webhook URL.',
    icon: Webhook,
  },
  {
    value: 'telegram',
    label: 'Telegram',
    description: 'Send alerts through a bot to a chat or group.',
    icon: Send,
  },
];

interface ChannelForm {
  name: string;
  type: ChannelType;
  webhookUrl: string;
  botToken: string;
  chatId: string;
  message: string;
}

function initialForm(channel: NotificationChannel | null): ChannelForm {
  return {
    name: channel?.name ?? '',
    type: channel?.type ?? 'discord',
    webhookUrl: channel?.webhookUrl ?? '',
    botToken: channel?.botToken ?? '',
    chatId: channel?.chatId ?? '',
    message: channel?.message ?? '',
  };
}

function failureText(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = typeof error.payload.detail === 'string' ? error.payload.detail : null;
    if (detail) return detail;
    return error.message;
  }
  return error instanceof Error ? error.message : 'The channel could not be saved.';
}

type FieldErrors = Partial<Record<'name' | 'webhookUrl' | 'botToken' | 'chatId', string>>;

export function ChannelFormModal({
  channel,
  onClose,
  onSaved,
}: {
  channel: NotificationChannel | null;
  onClose: () => void;
  onSaved: (channel: NotificationChannel, created: boolean) => void;
}) {
  const confirm = useConfirm();
  const editing = channel !== null;
  const initial = useRef(initialForm(channel));

  const [form, setForm] = useState<ChannelForm>(initial.current);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = (Object.keys(form) as (keyof ChannelForm)[]).some(
    (key) => form[key] !== initial.current[key]
  );

  const update = <K extends keyof ChannelForm>(key: K, value: ChannelForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setFailure(null);
  };

  const requestClose = () => {
    if (saving) return;
    if (!dirty) {
      onClose();
      return;
    }
    void confirm({
      title: editing ? 'Discard channel changes?' : 'Discard this channel?',
      body: 'Nothing has been sent to the server yet.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      tone: 'danger',
    }).then((ok) => {
      if (ok) onClose();
    });
  };

  const submit = async () => {
    if (saving) return;
    const nextErrors: FieldErrors = {};
    if (!form.name.trim()) nextErrors.name = 'Give the channel a name.';
    if (form.type === 'discord') {
      const url = form.webhookUrl.trim();
      if (!url) nextErrors.webhookUrl = 'A Discord webhook URL is required.';
      else if (!/^https:\/\/\S+$/i.test(url)) {
        nextErrors.webhookUrl = 'Enter an https:// URL without spaces.';
      }
    } else {
      if (!form.botToken.trim()) nextErrors.botToken = 'The bot token is required.';
      if (!form.chatId.trim()) nextErrors.chatId = 'The chat ID is required.';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const body = {
      name: form.name.trim(),
      type: form.type,
      ...(form.type === 'discord'
        ? { webhookUrl: form.webhookUrl.trim(), message: form.message.trim() }
        : { botToken: form.botToken.trim(), chatId: form.chatId.trim() }),
    };

    setSaving(true);
    setFailure(null);
    try {
      const saved = channel
        ? await api.settings.channels.update(channel.id, body)
        : await api.settings.channels.create(body);
      onSaved(saved, !editing);
    } catch (error) {
      setFailure(failureText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={requestClose}
      title={editing ? `Edit ${channel.name}` : 'New notification channel'}
      description={
        editing
          ? 'Change where this channel delivers, or how its messages look.'
          : 'Add a Discord webhook or a Telegram bot. Domains choose their channels per event.'
      }
      preventClose={saving}
      footer={
        <>
          <Button variant="secondary" onClick={requestClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="channel-form" loading={saving}>
            {editing ? 'Save channel' : 'Create channel'}
          </Button>
        </>
      }
    >
      <form
        id="channel-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        {failure && (
          <InlineAlert tone="danger" title="Could not save the channel">
            {failure}
          </InlineAlert>
        )}

        <TextInput
          label="Name"
          value={form.name}
          onChange={(event) => update('name', event.target.value)}
          placeholder="Production Discord"
          error={errors.name}
          autoFocus
        />

        <fieldset disabled={editing || saving}>
          <legend className="mb-1.5 text-xs font-medium text-muted">Type</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {TYPES.map((type) => {
              const selected = form.type === type.value;
              return (
                <label
                  key={type.value}
                  className={cn(
                    'flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors duration-[var(--ez-motion-fast)]',
                    selected
                      ? 'border-accent bg-accent-soft'
                      : 'border-line bg-canvas hover:border-line-strong',
                    (editing || saving) && 'cursor-not-allowed opacity-70'
                  )}
                >
                  <input
                    type="radio"
                    name="channel-type"
                    value={type.value}
                    checked={selected}
                    onChange={() => update('type', type.value)}
                    className="mt-0.5 size-3.5 accent-[var(--ez-accent)]"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                      <type.icon className="size-3.5 text-muted" aria-hidden="true" />
                      {type.label}
                    </span>
                    <span className="mt-0.5 block text-2xs text-faint">{type.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {editing && (
            <FieldHint>The channel type cannot be changed after it is created.</FieldHint>
          )}
        </fieldset>

        {form.type === 'discord' ? (
          <>
            <TextInput
              label="Webhook URL"
              value={form.webhookUrl}
              onChange={(event) => update('webhookUrl', event.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
              error={errors.webhookUrl}
              hint="Create one in Discord under Channel settings → Integrations → Webhooks."
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
            <div>
              <TextInput
                label="Message prefix"
                optional
                value={form.message}
                onChange={(event) => update('message', event.target.value)}
                placeholder="<@&1280907071813976196> or @team"
                hint="Prepended to every alert in this channel."
                spellCheck={false}
              />
              <div className="mt-2 rounded-md border border-info/25 bg-info-soft px-3 py-2 text-2xs text-muted">
                Tip: to ping a Discord role, paste its mention as{' '}
                <code className="rounded bg-inset px-1 py-0.5 font-mono text-[10px] text-ink">
                  &lt;@&amp;RoleId&gt;
                </code>{' '}
                — for example{' '}
                <code className="rounded bg-inset px-1 py-0.5 font-mono text-[10px] text-ink">
                  &lt;@&amp;1280907071813976196&gt;
                </code>
                . The role is mentioned on every alert.
              </div>
            </div>
          </>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput
              label="Bot token"
              value={form.botToken}
              onChange={(event) => update('botToken', event.target.value)}
              placeholder="123456:ABC…"
              error={errors.botToken}
              hint="From @BotFather."
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
            <TextInput
              label="Chat ID"
              value={form.chatId}
              onChange={(event) => update('chatId', event.target.value)}
              placeholder="-1001234567890"
              error={errors.chatId}
              hint="Groups start with a minus sign."
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
      </form>
    </Modal>
  );
}
