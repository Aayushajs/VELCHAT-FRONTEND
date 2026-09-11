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

/**
 * Milliseconds until the access token expires: 0 when it is already expired or unreadable.
 *
 * Read locally, from the token we already parse for the account id. It exists for the case where
 * finding out the hard way is too expensive: a process woken by a push has one bounded window to
 * send a reply, and spending part of it on a request that is CERTAIN to 401 — then a refresh,
 * then a retry — is how an inline reply ends up sending only once the user opens the app.
 *
 * Unverified, like the account-id read above, and safe for the same reason: it decides only
 * whether to refresh early. A tampered value buys nothing; the server still checks the token.
 */
export function accessTokenExpiresInMs(now: number = Date.now()): number {
  const token = kv.getString(KVKeys.accessToken);
  if (!token) return 0;
  const payload = token.split('.')[1];
  if (!payload) return 0;
  try {
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const exp = (JSON.parse(json) as Record<string, unknown>).exp;
    if (typeof exp !== 'number') return 0;
    return Math.max(0, exp * 1000 - now);
  } catch {
    return 0;
  }
}

/**
 * True when a session both EXISTS and has a currently-valid (non-expired) access token (VC-036).
 *
 * Deliberately separate from `hasSession()`, which stays presence-only on purpose: SyncEngine's
 * reconnect and 4001-recovery guards (`connect()`, `onClose()`, `recoverFromUnauthorized()`) must
 * stay true for a token that is merely expired-but-present — that is exactly the case the
 * socket's own 4001 → refresh → reconnect self-healing exists to repair. If `hasSession()` itself
 * went expiry-aware, those guards would bail BEFORE the handshake that triggers that repair ever
 * runs, trading one wasted cold-start handshake for realtime stuck disconnected until a
 * force-quit — worse than the bug this fixes.
 *
 * This is for the one caller that genuinely needs "is this usable right now, with no round trip
 * to find out": the cold-start bootstrap, which must refresh BEFORE opening a socket rather than
 * let a doomed handshake fail once (`useAuthBootstrap` in `features/auth/hooks/useAuth.ts`).
 */
export function hasValidSession(): boolean {
  return hasSession() && accessTokenExpiresInMs() > 0;
}

// ── session change notification ────────────────────────────────────────────────
/**
 * Listeners for "a session appeared / went away".
 *
 * WHY this exists: `hasSession()` is a synchronous MMKV read, so nothing downstream can
 * LEARN that the user just signed in. The SyncEngine's `connect()` refuses to open a socket
 * without a session and otherwise only re-arms on a network or foreground transition —
 * neither of which happens when the user signs in while the app is already running. Without
 * a notification the app therefore holds NO WebSocket for the rest of that run: no inbound
 * messages, no receipts (so no ticks), no presence, and no post-login restore. Force-quitting
 * appeared to "fix" it only because the session then exists before `start()` runs.
 */
type SessionListener = (hasSession: boolean) => void;
const sessionListeners = new Set<SessionListener>();

/**
 * Observe session establishment/teardown. Returns an unsubscribe (§M7: every long-lived
 * listener is owned and disposable). Fires ONLY on a real transition — see `emitSession`.
 */
export function subscribeSession(fn: SessionListener): () => void {
  sessionListeners.add(fn);
  return () => {
    sessionListeners.delete(fn);
  };
}

/**
 * Announce a transition. A throwing listener must not stop the others: these callbacks drive
 * the socket AND the post-login restore, so one bad subscriber cannot be allowed to leave the
 * app deaf. Iterates a COPY so a listener that unsubscribes during dispatch can't skip a peer.
 */
function emitSession(next: boolean): void {
  for (const fn of [...sessionListeners]) {
    try {
      fn(next);
    } catch {
      // A listener's failure is its own problem — never break the fan-out.
    }
  }
}

/**
 * Identity of the CURRENT session, so a token refresh (which rewrites `accessToken` for the
 * same account) is not mistaken for a new sign-in. Re-running the whole post-login restore on
 * every silent refresh would mean a periodic inbox re-backfill for the entire chat list.
 */
function sessionIdentity(): string | undefined {
  const token = kv.getString(KVKeys.accessToken);
  if (!token) return undefined;
  return kv.getString(KVKeys.accountId) ?? claimFromAccessToken('account_id');
}

export function setTokens(t: SessionTokens): void {
  const before = sessionIdentity();
  kv.set(KVKeys.accessToken, t.access);
  kv.set(KVKeys.refreshToken, t.refresh);
  if (t.cnfJkt !== undefined) kv.set(KVKeys.cnfJkt, t.cnfJkt);
  if (t.accountId !== undefined) kv.set(KVKeys.accountId, t.accountId);
  if (t.deviceId !== undefined) kv.set(KVKeys.deviceId, t.deviceId);
  // A DIFFERENT account (or the first one) is a sign-in; the same account is a refresh.
  if (sessionIdentity() !== before) emitSession(true);
}

export function clearSession(): void {
  const had = Boolean(kv.getString(KVKeys.accessToken));
  kv.delete(KVKeys.accessToken);
  kv.delete(KVKeys.refreshToken);
  kv.delete(KVKeys.cnfJkt);
  kv.delete(KVKeys.accountId);
  kv.delete(KVKeys.deviceId);
  if (had) emitSession(false);
}
