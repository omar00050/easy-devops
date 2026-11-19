/**
 * lib/mock/ssl.ts — the simulated `ssl:progress` feed.
 *
 * Shared by the REST mock (`lib/mock/index.ts`, `lib/mock/deployments.ts`) and
 * the mock socket, so issue, renew, renew-all and link-domain all play the
 * same stage ids in the order API-CONTRACT.md §3.5 publishes them. The server
 * does not replay `ssl:progress`; neither does this.
 */

import { ApiError } from '../errors';
import type { PreflightCheck, SslProgressEvent, SslStageStatus } from '../types';

type SslProgressListener = (payload: SslProgressEvent) => void;
const sslProgressListeners = new Set<SslProgressListener>();

export function subscribeMockSslProgress(listener: SslProgressListener): () => void {
  sslProgressListeners.add(listener);
  return () => {
    sslProgressListeners.delete(listener);
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function emitSslProgress(
  opId: string,
  domain: string,
  startedAt: number,
  stage: string,
  status: SslStageStatus,
  detail?: string
): void {
  const payload: SslProgressEvent = {
    opId,
    domain,
    stage,
    status,
    ...(detail ? { detail } : {}),
    elapsedMs: Math.max(0, Date.now() - startedAt),
    at: new Date().toISOString(),
  };
  for (const listener of [...sslProgressListeners]) {
    try {
      listener(payload);
    } catch {
      /* a page that throws must not break the mock operation */
    }
  }
}

export interface MockStageStep {
  stage: string;
  status: SslStageStatus;
  detail?: string;
  wait: number;
}

export const PRELUDE_STEPS: MockStageStep[] = [
  { stage: 'preflight', status: 'running', detail: 'Checking DNS and port 80', wait: 150 },
  { stage: 'preflight', status: 'ok', detail: 'All checks passed', wait: 120 },
  { stage: 'account and order', status: 'running', detail: "Preparing the Let's Encrypt account and order", wait: 180 },
  { stage: 'account and order', status: 'ok', detail: 'ACME account ready', wait: 140 },
];

export const CHALLENGE_STEPS: MockStageStep[] = [
  { stage: 'challenge ready', status: 'running', detail: 'Starting the ACME challenge listener', wait: 160 },
  { stage: 'challenge ready', status: 'ok', detail: 'The challenge token is being served over HTTP', wait: 160 },
  { stage: 'waiting for validation', status: 'running', detail: "Waiting for Let's Encrypt validation", wait: 450 },
  { stage: 'waiting for validation', status: 'running', detail: "Waiting for Let's Encrypt validation (2s)", wait: 450 },
  { stage: 'waiting for validation', status: 'ok', detail: "Let's Encrypt accepted the challenge", wait: 120 },
];

export const TAIL_STEPS: MockStageStep[] = [
  { stage: 'certificate received', status: 'ok', detail: "Certificate received from Let's Encrypt", wait: 120 },
  { stage: 'files written', status: 'running', wait: 140 },
  { stage: 'files written', status: 'ok', detail: 'Certificate and key saved', wait: 140 },
  { stage: 'nginx config test', status: 'running', wait: 140 },
  { stage: 'nginx config test', status: 'ok', detail: 'nginx accepted the configuration', wait: 140 },
  { stage: 'nginx reload', status: 'running', wait: 140 },
  { stage: 'nginx reload', status: 'ok', detail: 'nginx reloaded', wait: 140 },
  { stage: 'https verified', status: 'running', wait: 140 },
  { stage: 'https verified', status: 'ok', detail: 'The served certificate matches the new file', wait: 140 },
];

export async function playMockStages(
  opId: string,
  domain: string,
  startedAt: number,
  steps: MockStageStep[],
  speed = 1
): Promise<void> {
  for (const step of steps) {
    await wait(Math.max(1, Math.round(step.wait * speed)));
    emitSslProgress(opId, domain, startedAt, step.stage, step.status, step.detail);
  }
}

const OP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function mockOpId(value: unknown): string {
  return typeof value === 'string' && OP_ID_RE.test(value)
    ? value
    : `ssl_mock_${Math.random().toString(36).slice(2, 14)}`;
}

export function mockPreflight(name: string, proxied = false): PreflightCheck[] {
  const address = proxied ? '172.67.14.9' : '203.0.113.10';
  return [
    { id: `dns:${name}`, status: 'ok', message: `${name} resolves to ${address}` },
    {
      id: `a:${name}:${address}`,
      status: 'ok',
      message: proxied
        ? `${name} is proxied by Cloudflare (${address})`
        : `${name} points at this server (${address})`,
    },
    {
      id: 'aaaa',
      status: 'skipped',
      message: 'No AAAA record, so IPv6 reachability was not probed',
    },
    {
      id: `http:${name}`,
      status: 'ok',
      message: `http://${name}/ answers this server on port 80`,
    },
  ];
}

export const CLOUDFLARE_REDIRECT =
  "Cloudflare 'Always Use HTTPS' or a redirect sends Let's Encrypt to https";

export function cloudflarePreflightFailure(name: string): PreflightCheck[] {
  return [
    { id: `dns:${name}`, status: 'ok', message: `${name} resolves to 172.67.14.9` },
    {
      id: `a:${name}:172.67.14.9`,
      status: 'ok',
      message: `${name} is proxied by Cloudflare (172.67.14.9)`,
    },
    {
      id: 'aaaa',
      status: 'skipped',
      message: 'No AAAA record, so IPv6 reachability was not probed',
    },
    {
      id: `http:${name}`,
      status: 'fail',
      message: `${CLOUDFLARE_REDIRECT} for ${name} (HTTP 301)`,
      fix:
        `Turn off Cloudflare 'Always Use HTTPS' (or the port-80 redirect) for ${name} ` +
        'so /.well-known/acme-challenge/ stays on HTTP.',
    },
  ];
}

/** The Cloudflare https-redirect example the brief asks the mock to play. */
export function isCloudflareRedirectExample(name: string): boolean {
  return name.startsWith('cf.') || name.includes('cloudflare');
}

export async function failMockPreflight(
  opId: string,
  name: string,
  startedAt: number
): Promise<never> {
  emitSslProgress(opId, name, startedAt, 'preflight', 'running', 'Checking DNS and port 80');
  await wait(620);
  emitSslProgress(opId, name, startedAt, 'preflight', 'failed', `${CLOUDFLARE_REDIRECT} for ${name}`);
  throw new ApiError(500, {
    success: false,
    opId,
    error: {
      step: 'preflight',
      stage: 'preflight',
      cause: `${CLOUDFLARE_REDIRECT} for ${name} (HTTP 301)`,
      consequence: "No certificate was requested, so Let's Encrypt rate limits are untouched.",
      fix:
        `Turn off Cloudflare 'Always Use HTTPS' (or the port-80 redirect) for ${name} ` +
        'so /.well-known/acme-challenge/ stays on HTTP.',
      nginxRunning: true,
      configSaved: false,
    },
    preflight: cloudflarePreflightFailure(name),
  });
}

export interface MockLinkProgress {
  mode: 'issue' | 'existing' | 'none';
  /** Whether the certificate issuance succeeded (mode `issue`). */
  issued: boolean;
  behindCloudflare?: boolean;
}

/**
 * The link-domain stages in §2.8 order: `domain`, the certificate stages for
 * an issue, `https`, then the nginx pair and the verification.
 */
export async function playMockLinkProgress(
  opId: string,
  domain: string,
  { mode, issued, behindCloudflare = false }: MockLinkProgress
): Promise<void> {
  const startedAt = Date.now();
  const step = async (
    stage: string,
    status: SslStageStatus,
    detail?: string,
    duration = 110
  ): Promise<void> => {
    await wait(duration);
    emitSslProgress(opId, domain, startedAt, stage, status, detail);
  };

  await step('domain', 'running', 'Creating the domain and its nginx config', 120);
  await step('domain', 'ok', 'nginx serves this name', 100);

  if (mode === 'issue') {
    await step('preflight', 'running', 'Checking DNS and port 80', 120);
    await step(
      'preflight',
      'ok',
      behindCloudflare ? 'Checks passed with warnings' : 'All checks passed',
      100
    );
    await step('account and order', 'running', "Preparing the Let's Encrypt account and order", 150);
    await step('account and order', 'ok', 'ACME account ready', 100);
    await step('challenge ready', 'running', 'Starting the ACME challenge listener', 140);
    await step('challenge ready', 'ok', 'The challenge token is being served over HTTP', 120);
    await step('waiting for validation', 'running', "Waiting for Let's Encrypt validation", 400);

    if (issued) {
      await step('waiting for validation', 'ok', "Let's Encrypt accepted the challenge", 120);
      await step('certificate received', 'ok', "Certificate received from Let's Encrypt", 100);
      await step('files written', 'running', undefined, 120);
      await step('files written', 'ok', 'Certificate and key saved', 100);
    } else {
      await step(
        'waiting for validation',
        'failed',
        `DNS problem: NXDOMAIN looking up A for ${domain}`,
        120
      );
    }
  }

  if (mode === 'none' || (mode === 'issue' && !issued)) {
    await step('https', 'skipped', 'no certificate was requested', 80);
  } else {
    await step('https', 'running', undefined, 100);
    await step(
      'https',
      'ok',
      mode === 'issue'
        ? 'The domain now uses the new certificate'
        : 'The domain uses the existing certificate',
      100
    );
  }

  await step('nginx config test', 'running', undefined, 110);
  await step('nginx config test', 'ok', 'nginx accepted the configuration', 90);
  await step('nginx reload', 'running', undefined, 110);
  await step('nginx reload', 'ok', 'nginx reloaded', 90);
  await step(
    'https verified',
    'skipped',
    mode === 'none' || !issued
      ? 'no new certificate to verify'
      : behindCloudflare
        ? "served by Cloudflare's edge"
        : 'the served certificate matches the new file',
    60
  );
}
