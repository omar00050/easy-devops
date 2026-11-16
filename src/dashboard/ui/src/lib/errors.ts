import type { ApiErrorPayload } from './types';

/**
 * One error type for every failed call: the HTTP status, the parsed contract
 * body, and a human message derived from whichever field the endpoint used.
 * Kept separate from api.ts so the mock adapter can throw the same type
 * without importing the real transport.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly payload: ApiErrorPayload;

  constructor(status: number, payload: ApiErrorPayload, message?: string) {
    super(message ?? messageFromPayload(status, payload));
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }

  /** Machine-readable code: `error` when it is a string, else the failed step. */
  get code(): string | undefined {
    const { error } = this.payload;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') return error.step;
    return undefined;
  }

  /** Non-null when the origin guard refused the request (403). */
  get blockedReason(): string | null {
    if (this.status !== 403) return null;
    return this.payload.reason ?? null;
  }
}

function messageFromPayload(status: number, payload: ApiErrorPayload): string {
  const { error } = payload;
  if (typeof error === 'string' && error && error !== 'Forbidden') return error;
  if (error && typeof error === 'object') {
    return error.cause || error.consequence || 'The request failed.';
  }
  if (status === 403) return 'Request blocked by the dashboard.';
  if (status === 401) return 'Your session ended. Please sign in again.';
  if (status === 0) return 'Cannot reach the dashboard.';
  return `Request failed (HTTP ${status}).`;
}
