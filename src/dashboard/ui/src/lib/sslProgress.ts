/**
 * lib/sslProgress.ts — the vocabulary of a certificate operation.
 *
 * The stage ids and their order come from `core/ssl/progress.js` and
 * API-CONTRACT.md §3.5, so the dashboard, the Hub and the CLI describe one
 * operation the same way. Nothing here invents a stage: a link-domain list is
 * the certificate list plus `domain` and `https`, exactly as §2.8 publishes it.
 */

import { ApiError } from './errors';
import type {
  DeployDomainLink,
  PreflightCheck,
  PreflightResult,
  SslProgressEvent,
} from './types';

export interface StageDefinition {
  /** The contract's stage id, sent verbatim in `ssl:progress`. */
  id: string;
  /** The readable label; the id itself stays the key. */
  label: string;
}

/** The nine stages of §3.5, in the order the server reports them. */
export const SSL_ISSUANCE_STAGES: readonly StageDefinition[] = Object.freeze([
  { id: 'preflight', label: 'Preflight checks' },
  { id: 'account and order', label: 'Account and order' },
  { id: 'challenge ready', label: 'Challenge ready' },
  { id: 'waiting for validation', label: 'Waiting for validation' },
  { id: 'certificate received', label: 'Certificate received' },
  { id: 'files written', label: 'Files written' },
  { id: 'nginx config test', label: 'nginx config test' },
  { id: 'nginx reload', label: 'nginx reload' },
  { id: 'https verified', label: 'HTTPS verified' },
]);

/** A link that issues a certificate: `domain`, the nine stages, then `https`. */
export const LINK_DOMAIN_ISSUE_STAGES: readonly StageDefinition[] = Object.freeze([
  { id: 'domain', label: 'Domain linked' },
  ...SSL_ISSUANCE_STAGES.slice(0, 6),
  { id: 'https', label: 'SSL settings' },
  ...SSL_ISSUANCE_STAGES.slice(6),
]);

/** A link that reuses an existing certificate omits the issuer stages. */
export const LINK_DOMAIN_EXISTING_STAGES: readonly StageDefinition[] = Object.freeze([
  { id: 'domain', label: 'Domain linked' },
  { id: 'https', label: 'SSL settings' },
  { id: 'nginx config test', label: 'nginx config test' },
  { id: 'nginx reload', label: 'nginx reload' },
  { id: 'https verified', label: 'HTTPS verified' },
]);

/** A link with SSL off still tests and reloads nginx; `https` is skipped. */
export const LINK_DOMAIN_NO_SSL_STAGES: readonly StageDefinition[] = LINK_DOMAIN_EXISTING_STAGES;

export function stageLabel(id: string): string {
  return (
    LINK_DOMAIN_ISSUE_STAGES.find((stage) => stage.id === id)?.label ??
    SSL_ISSUANCE_STAGES.find((stage) => stage.id === id)?.label ??
    id
  );
}

/** The contract's id pattern; a client opId the server will accept. */
export const OP_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A client correlation id for one SSL operation.
 *
 * `crypto.randomUUID()` is the source when the page has a secure context
 * (localhost counts); its 128 bits are re-encoded as base64url so the value is
 * 22 characters of `[A-Za-z0-9_-]`, inside the server's 8–64 bound.
 */
export function newSslOpId(): string {
  const subtle = globalThis.crypto;
  if (subtle?.randomUUID) {
    const hex = subtle.randomUUID().replace(/-/g, '');
    const bytes = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return base64Url(bytes);
  }

  const bytes = new Uint8Array(16);
  if (subtle?.getRandomValues) {
    subtle.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return base64Url(bytes);
}

/** One stage's known state, as the socket reported it. */
export interface StageRowState {
  status: 'running' | 'ok' | 'failed' | 'skipped';
  detail?: string;
  /** The server's elapsed time when the frame arrived. */
  elapsedMs?: number;
  /** Local clock at that moment, so the display can keep counting. */
  elapsedAt?: number;
}

export type StageStateMap = Record<string, StageRowState>;

/**
 * Applies one frame to a stage map. A later `ok`/`failed`/`skipped` keeps a
 * running frame's position; a repeat of `running` only refreshes the elapsed
 * time and detail ("waiting for validation" is re-sent with its duration).
 */
export function applyStageEvent(
  current: StageStateMap,
  event: Pick<SslProgressEvent, 'stage' | 'status' | 'detail' | 'elapsedMs'>,
  now = Date.now()
): StageStateMap {
  const previous = current[event.stage];
  if (previous?.status === 'failed' && event.status === 'running') {
    // A stage that failed is not "running again"; keep the failure.
    return current;
  }
  const next: StageRowState = {
    status: event.status,
    detail: event.detail ?? previous?.detail,
    elapsedMs: event.elapsedMs,
    elapsedAt: now,
  };
  return { ...current, [event.stage]: next };
}

const KNOWN_STAGE_IDS = new Set([
  ...SSL_ISSUANCE_STAGES.map((stage) => stage.id),
  'domain',
  'https',
]);

/** True for a stage id we can place in a list, plus the timeout marker. */
export function isKnownStage(id: string | null | undefined): boolean {
  return typeof id === 'string' && (KNOWN_STAGE_IDS.has(id) || id === 'timeout');
}

export interface SslFailureView {
  /** The failed stage, or `timeout` when the five-minute bound fired. */
  stage: string | null;
  /** Let's Encrypt's real error, or the server's own sentence. */
  message: string;
  /** The one-line next step, shown in a warning tip. */
  fix: string | null;
  consequence: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const found = text(value);
    if (found) return found;
  }
  return null;
}

function failureFromObject(value: unknown): SslFailureView | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const inner = record.error;
  if (inner && typeof inner === 'object') {
    const error = inner as Record<string, unknown>;
    return {
      stage: isKnownStage(text(error.stage)) ? text(error.stage) : isKnownStage(text(error.step)) ? text(error.step) : null,
      message:
        firstText(error.cause, error.consequence, record.detail, record.hint) ??
        'No certificate was issued.',
      fix: firstText(error.fix, record.hint),
      consequence: text(error.consequence),
    };
  }

  if (typeof inner === 'string') {
    return {
      stage: null,
      message: firstText(record.detail, inner) ?? inner,
      fix: firstText(record.hint),
      consequence: null,
    };
  }

  if (typeof record.step === 'string' || typeof record.cause === 'string' || typeof record.stage === 'string') {
    return {
      stage: isKnownStage(text(record.stage)) ? text(record.stage) : isKnownStage(text(record.step)) ? text(record.step) : null,
      message: firstText(record.cause, record.consequence, record.detail) ?? 'No certificate was issued.',
      fix: firstText(record.fix, record.hint),
      consequence: text(record.consequence),
    };
  }

  return null;
}

/** Normalises every failure shape an SSL endpoint can answer with. */
export function sslFailureFrom(value: unknown): SslFailureView | null {
  if (value == null) return null;

  if (value instanceof ApiError) {
    const payload = value.payload;
    const object = failureFromObject(payload);
    if (object) return object;
    return {
      stage: null,
      message: firstText(payload.detail, payload.hint, value.message) ?? value.message,
      fix: firstText(payload.hint),
      consequence: null,
    };
  }

  if (typeof value === 'string') {
    return { stage: null, message: value, fix: null, consequence: null };
  }

  return failureFromObject(value);
}

/** The preflight results beside a failure/success, when the server sends them. */
export function preflightFrom(value: unknown): PreflightResult | null {
  let candidate: unknown = null;
  if (value instanceof ApiError) {
    candidate = value.payload.preflight;
  } else if (Array.isArray(value)) {
    candidate = value;
  } else if (value && typeof value === 'object') {
    candidate = (value as Record<string, unknown>).preflight ?? value;
  }

  if (!candidate) return null;

  const wrapper =
    !Array.isArray(candidate) && candidate && typeof candidate === 'object'
      ? (candidate as Record<string, unknown>)
      : {};
  const rawChecks = Array.isArray(candidate)
    ? candidate
    : Array.isArray(wrapper.results)
      ? wrapper.results
      : null;
  if (!rawChecks) return null;

  const results: PreflightCheck[] = [];
  for (const entry of rawChecks) {
    if (!entry || typeof entry !== 'object') continue;
    const check = entry as Record<string, unknown>;
    const id = text(check.id);
    const status = check.status;
    if (!id) continue;
    if (status !== 'ok' && status !== 'warn' && status !== 'fail' && status !== 'skipped') continue;
    results.push({
      id,
      status,
      message: text(check.message) ?? id,
      fix: text(check.fix) ?? undefined,
    });
  }

  if (results.length === 0) return null;
  const failed = results.some((check) => check.status === 'fail');
  return {
    ok: typeof wrapper.ok === 'boolean' ? wrapper.ok : !failed,
    detail: text(wrapper.detail) ?? undefined,
    results,
    proxied: wrapper.proxied === true,
    reachesUs: wrapper.reachesUs === true,
  };
}

/** "DNS record", "IPv4 (A)", … for a check id such as `aaaa:example.com:2606:…`. */
export function preflightCheckLabel(id: string): string {
  const head = id.split(':')[0];
  if (head === 'dns') return 'DNS record';
  if (head === 'a') return 'IPv4 (A record)';
  if (head === 'aaaa') return 'IPv6 (AAAA record)';
  if (head === 'http') return 'HTTP self-check';
  return 'Check';
}

/** The name a check is about, when the id carries one. */
export function preflightCheckTarget(id: string): string | null {
  const parts = id.split(':');
  if (parts.length < 2) return null;
  return parts[1] || null;
}

/** `12s`, `1m 04s` — a stage's elapsed time, never a fake zero. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/**
 * The final stage list a link-domain answer supports.
 *
 * The dashboard's `PUT /api/deployments/:id/domain` is synchronous and emits
 * no `ssl:progress` frames (the Hub command does). Rather than invent stage
 * timings, this maps only what the response actually says: the domain and nginx
 * outcomes are known, the issuer stages are reported as not reported.
 */
export function linkResultStages(
  result: DeployDomainLink,
  stages: readonly StageDefinition[]
): StageStateMap {
  const map: StageStateMap = {};
  const skipped = (detail: string): StageRowState => ({ status: 'skipped', detail });

  for (const stage of stages) {
    if (stage.id === 'domain') map[stage.id] = { status: 'ok', detail: 'nginx serves this name' };
    else if (stage.id === 'https') {
      if (!result.ssl) map[stage.id] = skipped('No certificate was requested');
      else if (result.ssl.ok) map[stage.id] = { status: 'ok', detail: result.ssl.detail };
      else map[stage.id] = { status: 'failed', detail: result.ssl.detail };
    } else if (stage.id === 'nginx config test') {
      map[stage.id] = result.nginxReloaded
        ? { status: 'ok', detail: 'nginx accepted the config' }
        : skipped('nginx was not reloaded');
    } else if (stage.id === 'nginx reload') {
      map[stage.id] = result.nginxReloaded
        ? { status: 'ok', detail: 'nginx reloaded' }
        : { status: 'failed', detail: 'nginx was not reloaded' };
    } else if (stage.id === 'https verified') {
      map[stage.id] = skipped(
        result.ssl?.ok ? 'The certificate was checked by the server' : 'No new certificate to verify'
      );
    } else {
      map[stage.id] = skipped('Not reported for a link that runs in one request');
    }
  }

  return map;
}
