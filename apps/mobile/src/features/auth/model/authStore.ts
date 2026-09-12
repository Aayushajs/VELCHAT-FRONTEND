/**
 * AuthMachine (§R1) as a Zustand store: signed_out | onboarding | verifying |
 * provisioning | active | locked | recovering. Persistent bits (tokens, account,
 * phone) live in encrypted MMKV; this store is the in-memory reflection + actions.
 */
import { create } from 'zustand';
import {
  hasSession,
  setTokens,
  clearSession,
  clearDeviceKey,
  getRefreshToken,
  purgeAllLocalChat,
  clearAllReceipts,
  kv,
  KVKeys,
} from '../../../infra';
import { clearProfileCache, clearContactAvatarCache } from '../../user';
import { clearContactsDiscoveryCache } from '../../contacts';
import { clearConversationPeerCache, clearStartDmCache } from '../../chat';
import { shutdownPushForSignOut, startPushRuntime } from '../../notifications';
import { logout } from '../api/authApi';
import type { Tokens } from '../api/authApi';

export type AuthState =
  | 'signed_out'
  | 'onboarding'
  | 'verifying'
  | 'provisioning'
  | 'active'
  | 'locked'
  | 'recovering';

interface AuthStore {
  readonly state: AuthState;
  readonly phone: string | null;
  readonly sessionId: string | null;
  readonly accountId: string | null;
  hydrate: () => void;
  beginVerify: (phone: string, sessionId: string) => void;
  rememberPhone: (phone: string) => void;
  provision: (tokens: Tokens) => void;
  signOut: () => void;
  sessionExpired: () => void;
}

/**
 * Every LOCAL data purge that must happen when this device stops representing an account —
 * shared between a user-initiated sign-out and a server-forced session expiry (VC-013). A forced
 * expiry used to only flip the state machine, leaving the chat DB, profile mirror, phone number,
 * contact graph and receipts in place for whichever account signs in next on this device.
 *
 * Deliberately EXCLUDES two things that differ by caller and are applied by them instead:
 *   - the best-effort server-side `/auth/logout` call — pointless here, since a session that
 *     just got authoritatively rejected has nothing left to revoke;
 *   - `clearDeviceKey()` — a forced expiry keeps the device key so a later cold launch can still
 *     silently re-provision if the session was merely stale, not genuinely over. Only a
 *     user-initiated sign-out demands a fresh OTP.
 */
function purgeAccountData(): void {
  void shutdownPushForSignOut().catch(() => undefined);
  clearSession();
  kv.delete(KVKeys.phone);
  kv.delete(KVKeys.loginAt);
  // Drop the mirrored profile so the next account never sees the previous one.
  // MUST include every profile-mirror key — a miss leaks the prior user's data (e.g.
  // `avatarUrl` fell through to the header/Settings on the next sign-in).
  kv.delete(KVKeys.displayName);
  kv.delete(KVKeys.email);
  kv.delete(KVKeys.about);
  kv.delete(KVKeys.avatarUri);
  kv.delete(KVKeys.avatarUrl);
  kv.delete(KVKeys.memberSince);
  kv.delete(KVKeys.profileComplete);
  // Wipe every other-account-specific cache so the NEXT sign-in starts clean and never sees
  // this account's data: the New-Chat contacts snapshot, the discovery-registered marker, and
  // — critically — the local chat DB (conversations/messages/outbox), which is NOT keyed by
  // account and would otherwise carry over verbatim.
  kv.delete(KVKeys.contactsSnapshot);
  kv.delete(KVKeys.discoverySelfRegistered);
  void purgeAllLocalChat().catch(() => undefined);
  // Caches keyed by the PREVIOUS account's ids. These live outside the fixed key list — some
  // are in-memory Maps, some are dynamically-keyed MMKV entries (`rcpt.*.<conversationId>`,
  // `avatar.<accountId>`) — so no amount of `kv.delete(KVKeys.x)` reaches them, and leaving
  // them behind hands the next sign-in this account's receipts, avatars and peer mappings.
  clearAllReceipts();
  clearProfileCache();
  clearContactAvatarCache();
  // Number -> accountId map built by OPRF discovery. Feature-owned, dynamically keyed, and
  // full of the PREVIOUS account contact graph - it must not survive into the next sign-in.
  clearContactsDiscoveryCache();
  clearConversationPeerCache();
  // "this DM already exists server-side" knowledge is per-account too — the next sign-in
  // must re-create/re-seed its own DMs rather than assume this account's were enough.
  clearStartDmCache();
}

export const useAuthStore = create<AuthStore>(set => ({
  state: hasSession() ? 'active' : 'signed_out',
  phone: kv.getString(KVKeys.phone) ?? null,
  sessionId: null,
  accountId: kv.getString(KVKeys.accountId) ?? null,

  hydrate: () => set({ state: hasSession() ? 'active' : 'signed_out' }),

  beginVerify: (phone, sessionId) => {
    kv.set(KVKeys.phone, phone);
    set({ phone, sessionId, state: 'verifying' });
  },

  rememberPhone: phone => {
    kv.set(KVKeys.phone, phone);
    set({ phone });
  },

  provision: tokens => {
    setTokens({
      access: tokens.access,
      refresh: tokens.refresh,
      accountId: tokens.accountId,
      deviceId: tokens.deviceId,
    });
    kv.set(KVKeys.accountId, tokens.accountId);
    kv.set(KVKeys.deviceId, tokens.deviceId);
    // Stamp the sign-in time so the Profile page can show "last login".
    kv.set(KVKeys.loginAt, new Date().toISOString());
    // App.tsx's mount effect starts the push runtime exactly ONCE for the life of the process.
    // A sign-out tears it down (`shutdownPushForSignOut`); without this, a re-login later in the
    // same process — no app restart — never brings it back, silently losing every notification
    // action from then on (VC-011). `startPushRuntime()` is idempotent, so this is a harmless
    // no-op on the app's normal first sign-in, which the mount effect already started.
    startPushRuntime();
    set({ accountId: tokens.accountId, state: 'active' });
  },

  signOut: () => {
    // Best-effort server-side revoke (fire-and-forget) BEFORE we drop the local token.
    const refresh = getRefreshToken();
    if (refresh) void logout(refresh).catch(() => undefined);
    purgeAccountData();
    clearDeviceKey(); // full logout — next sign-in re-provisions via OTP (no silent relogin)
    set({ state: 'signed_out', accountId: null, sessionId: null, phone: null });
  },

  // Refresh failed / token revoked mid-session (the network client already cleared the
  // tokens). Reflect it in the state machine so the navigator can reactively send the user
  // back to sign-in instead of stranding them on a zombie "logged-in" screen — and purge this
  // account's data exactly like a sign-out (VC-013), so the NEXT sign-in on this device (which
  // may be a different phone number entirely) never inherits it. The device key is kept, so a
  // later cold-launch can still silent-relogin if the session was merely stale.
  sessionExpired: () => {
    purgeAccountData();
    set({ state: 'signed_out', accountId: null, sessionId: null, phone: null });
  },
}));
