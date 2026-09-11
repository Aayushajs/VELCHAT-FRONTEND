/**
 * QA HTTP client — deliberately NOT the app's axios client.
 *
 * The point of an API-integration test is to assert the wire contract the app is built against
 * (`docs/backend-integration-reference.md`). Reusing the app's client would hide exactly the
 * envelope/normalisation bugs we are hunting, so this is a thin, honest fetch wrapper that returns
 * the RAW status, headers and body — plus a redacted request/response record for evidence (§32).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env, originFor } from './env.js';

/** Header/body keys whose values must never reach an evidence file or a log line (§24). */
const SECRET_KEYS = /^(authorization|cookie|set-cookie|x-api-key)$/i;
const SECRET_FIELDS = /^(access|refresh|token|otp|password|signature|devicePubkeyBase64|cnfJkt)$/;

export function redact(value, depth = 0) {
  if (depth > 6) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<jwt>')
      .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_FIELDS.test(k) ? '<redacted>' : redact(v, depth + 1);
  }
  return out;
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = SECRET_KEYS.test(k) ? '<redacted>' : v;
  }
  return out;
}

/** Append one redacted request/response record to the API evidence log. */
function recordEvidence(record) {
  const dir = join(env.evidenceDir, 'api');
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(join(dir, `api-${day}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Perform one request. Returns `{ status, ok, headers, body, envelope, data, ms, requestId }`.
 *
 * `envelope` is the parsed backend wrapper `{success,statusCode,message,data,requestId}` when the
 * response has that shape; `data` is its unwrapped payload (what the app's axios layer hands to
 * feature code). Both are exposed so a test can assert on either level.
 */
export async function request(method, path, options = {}) {
  const {
    token,
    body,
    headers = {},
    tenantId,
    accountId,
    raw = false,
    timeoutMs = env.timeoutMs,
    testId,
  } = options;

  const url = path.startsWith('http') ? path : `${originFor(path)}${path}`;
  const finalHeaders = { accept: 'application/json', ...headers };
  if (body !== undefined && !finalHeaders['content-type'])
    finalHeaders['content-type'] = 'application/json';
  if (token) finalHeaders.authorization = `Bearer ${token}`;
  if (tenantId) finalHeaders['x-tenant-id'] = tenantId;
  if (accountId) finalHeaders['x-account-id'] = accountId;

  const started = Date.now();
  let res;
  let text = '';
  let networkError;
  try {
    res = await fetch(url, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    networkError = String(e?.message ?? e);
  }
  const ms = Date.now() - started;

  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  const isEnvelope =
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'success' in parsed &&
    'statusCode' in parsed;

  const result = {
    method,
    path,
    url,
    status: res?.status ?? 0,
    ok: res ? res.ok : false,
    headers: res ? Object.fromEntries(res.headers.entries()) : {},
    body: parsed ?? (text || undefined),
    text,
    envelope: isEnvelope ? parsed : undefined,
    data: isEnvelope ? parsed.data : parsed,
    requestId: isEnvelope ? parsed.requestId : (res?.headers?.get('x-request-id') ?? undefined),
    ms,
    networkError,
  };

  recordEvidence({
    at: new Date().toISOString(),
    testId: testId ?? null,
    method,
    url,
    requestHeaders: redactHeaders(finalHeaders),
    requestBody: body === undefined ? undefined : redact(body),
    status: result.status,
    ms,
    responseBody: redact(result.body),
    networkError,
  });

  return result;
}

export const get = (path, options) => request('GET', path, options);
export const post = (path, body, options) => request('POST', path, { ...options, body });
export const patch = (path, body, options) => request('PATCH', path, { ...options, body });
export const del = (path, body, options) => request('DELETE', path, { ...options, body });

/**
 * Poll `probe` until it returns a truthy value or the budget expires (§45 — never a bare sleep;
 * a wait always has an explicit success condition and a bounded deadline).
 */
export async function waitFor(
  probe,
  { timeoutMs = env.eventTimeoutMs, intervalMs = 250, label = 'condition' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const err = new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
  err.last = last;
  throw err;
}
