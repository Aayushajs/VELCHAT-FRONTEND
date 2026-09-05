/**
 * Typed network errors (§M7, §L16). Every failed request is normalized to an
 * AppError so features never branch on raw Axios/HTTP shapes.
 */
import axios from 'axios';

export type AppErrorKind =
  | 'network' // no response (offline, DNS, timeout)
  | 'timeout'
  | 'auth' // 401/403 after refresh failed
  | 'rate_limit' // 429
  | 'server' // 5xx
  | 'client' // 4xx (validation, not-found, conflict…)
  | 'canceled'
  | 'unknown';

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly statusCode: number | undefined;
  readonly code: string | undefined; // backend error.code
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  /** `Retry-After` from a 429, in ms. Obeying it is what stops a retry storm from re-earning one. */
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: AppErrorKind,
    message: string,
    opts: {
      statusCode?: number | undefined;
      code?: string | undefined;
      requestId?: string | undefined;
      retryable?: boolean | undefined;
      retryAfterMs?: number | undefined;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.statusCode = opts.statusCode;
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable =
      opts.retryable ??
      (kind === 'network' || kind === 'timeout' || kind === 'server');
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * Plain-English fallback per error kind — used when the server didn't send a friendly
 * message of its own (e.g. a plain-text 429 from the edge, or an opaque 5xx). Never show
 * the raw Axios "Request failed with status code N" to a user.
 */
const FRIENDLY: Record<AppErrorKind, string> = {
  network:
    "Can't reach VelChat right now. Please check your connection and try again.",
  timeout: 'That took too long. Please check your connection and try again.',
  auth: 'Your session has expired. Please sign in again.',
  rate_limit:
    'Too many attempts right now. Please wait a moment and try again.',
  server: 'Something went wrong on our side. Please try again in a moment.',
  client: 'Something went wrong. Please try again.',
  canceled: 'Request canceled',
  unknown: 'Something went wrong. Please try again.',
};

/** Map any thrown value (usually an AxiosError) to a typed AppError with a friendly message. */
export function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (axios.isCancel(error)) {
    return new AppError('canceled', FRIENDLY.canceled, { retryable: false });
  }

  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED') {
      return new AppError('timeout', FRIENDLY.timeout);
    }
    const res = error.response;
    if (!res) {
      return new AppError('network', FRIENDLY.network);
    }
    const body = res.data as
      | { message?: string; error?: { code?: string }; requestId?: string }
      | undefined;
    const statusCode = res.status;
    const requestId =
      body?.requestId ?? (res.headers?.['x-request-id'] as string | undefined);
    const code = body?.error?.code;
    const kind: AppErrorKind =
      statusCode === 401 || statusCode === 403
        ? 'auth'
        : statusCode === 429
          ? 'rate_limit'
          : statusCode >= 500
            ? 'server'
            : 'client';
    // Prefer the backend's OWN message ONLY when it's a real user-facing envelope string
    // (our API writes those, e.g. "That code is wrong or expired"). A plain-text edge body
    // (e.g. "Too Many Requests") or a missing message falls back to the friendly default —
    // never the raw Axios "Request failed with status code N".
    const serverMsg =
      typeof body?.message === 'string' && body.message.trim().length > 0
        ? body.message.trim()
        : undefined;
    // Carry `Retry-After` through so the outbox can wait exactly as long as the server asked
    // instead of guessing — a retry that lands early just re-earns the 429.
    const retryAfterRaw = Number(res.headers?.['retry-after']);
    const retryAfterMs = Number.isFinite(retryAfterRaw)
      ? Math.max(0, retryAfterRaw) * 1000
      : undefined;
    return new AppError(kind, serverMsg ?? FRIENDLY[kind], {
      statusCode,
      code,
      requestId,
      retryAfterMs,
    });
  }

  return new AppError('unknown', FRIENDLY.unknown);
}
