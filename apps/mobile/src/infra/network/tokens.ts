/**
 * Auth session token store (§M7, §L14). Backed by encrypted MMKV.
 * The device keypair + Keychain-derived MMKV key arrive in MP1; this is the
 * read/write surface the network client and auth feature share.
 */
import { kv, KVKeys } from '../kv';

export interface SessionTokens {
  access: string;
  refresh: string;
  /** device-key thumbprint bound to the refresh token (backend `cnfJkt`). */
  cnfJkt?: string;
  accountId?: string;
  deviceId?: string;
}

export function getAccessToken(): string | undefined {
  return kv.getString(KVKeys.accessToken);
}

export function getRefreshToken(): string | undefined {
  return kv.getString(KVKeys.refreshToken);
}

export function getCnfJkt(): string | undefined {
  return kv.getString(KVKeys.cnfJkt);
}

export function getDeviceId(): string | undefined {
  return kv.getString(KVKeys.deviceId);
}

/**
 * Read one string claim out of the access token WITHOUT verifying it. Safe here because this is
 * our own token and the value is only used to address local rows and to fill a field the server
 * re-checks against the same token — a tampered value can't buy anything, it just gets refused.
 */
function claimFromAccessToken(claim: string): string | undefined {
  const token = kv.getString(KVKeys.accessToken);
  if (!token) return undefined;
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const value = (JSON.parse(json) as Record<string, unknown>)[claim];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The signed-in account id.
 *
 * Falls back to the token's `account_id` claim because the persisted copy is only written when
 * the auth response happened to include it — and a caller with no account id has no safe default.
 * The backend refuses a `senderId` that disagrees with the token, so a placeholder like `'me'`
 * turns every send into a permanent 4xx, renders the user's own messages as incoming, and stops
 * every tick from updating. The claim is the same value the server checks against, so deriving it
 * here makes that whole failure mode unreachable.
 */
export function getAccountId(): string | undefined {
  const stored = kv.getString(KVKeys.accountId);
  if (stored) return stored;
  const fromToken = claimFromAccessToken('account_id');
  if (fromToken) kv.set(KVKeys.accountId, fromToken); // heal it for every later read
  return fromToken;
}

export function getTenantId(): string | undefined {
  return kv.getString(KVKeys.tenantId);
}

/** The signed-in user's own phone number (E.164), captured at sign-in. Used to seed the
 * region for normalizing local-format contacts and as the caller's discovery input. */
export function getPhone(): string | undefined {
  return kv.getString(KVKeys.phone);
}

export function hasSession(): boolean {
  return Boolean(getAccessToken());
}

export function setTokens(t: SessionTokens): void {
  kv.set(KVKeys.accessToken, t.access);
  kv.set(KVKeys.refreshToken, t.refresh);
  if (t.cnfJkt !== undefined) kv.set(KVKeys.cnfJkt, t.cnfJkt);
  if (t.accountId !== undefined) kv.set(KVKeys.accountId, t.accountId);
  if (t.deviceId !== undefined) kv.set(KVKeys.deviceId, t.deviceId);
}

export function clearSession(): void {
  kv.delete(KVKeys.accessToken);
  kv.delete(KVKeys.refreshToken);
  kv.delete(KVKeys.cnfJkt);
  kv.delete(KVKeys.accountId);
  kv.delete(KVKeys.deviceId);
}
