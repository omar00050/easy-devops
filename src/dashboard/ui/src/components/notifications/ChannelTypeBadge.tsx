import { BellRing, Send, Webhook } from 'lucide-react';
import { cn } from '../../lib/cn';

interface ChannelTypeMeta {
  label: string;
  badgeClassName: string;
  icon: typeof Webhook;
}

/**
 * The known channel types and their tokens. The icons are generic (no brand
 * logos), and the colours are the --ez-discord / --ez-telegram pairs.
 */
const CHANNEL_TYPES: Record<string, ChannelTypeMeta> = {
  discord: {
    label: 'Discord',
    badgeClassName: 'bg-discord-soft text-discord',
    icon: Webhook,
  },
  telegram: {
    label: 'Telegram',
    badgeClassName: 'bg-telegram-soft text-telegram',
    icon: Send,
  },
};

const OTHER_TYPE: ChannelTypeMeta = {
  label: 'Channel',
  badgeClassName: 'bg-inset text-muted',
  icon: BellRing,
};

function metaFor(type: string): ChannelTypeMeta {
  const raw = type.trim();
  const known = CHANNEL_TYPES[raw.toLowerCase()];
  if (known) return known;
  return {
    ...OTHER_TYPE,
    label: raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : OTHER_TYPE.label,
  };
}

/** The human name of a channel type, for filters and accessible text. */
export function channelTypeLabel(type: string): string {
  return metaFor(type).label;
}

/**
 * One channel type badge: the generic icon plus "Discord" / "Telegram" / the
 * type's own name on its colour pair. Used by the picker and every channel list.
 */
export function ChannelTypeBadge({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  const meta = metaFor(type);
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-2xs font-medium tracking-wide',
        meta.badgeClassName,
        className
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {meta.label}
    </span>
  );
}
