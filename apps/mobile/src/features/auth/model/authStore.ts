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
import { clearConversationPeerCache } from '../../chat';
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
    set({ accountId: tokens.accountId, state: 'active' });
  },

  signOut: () => {
    // Best-effort server-side revoke (fire-and-forget) BEFORE we drop the local token.
    const refresh = getRefreshToken();
    if (refresh) void logout(refresh).catch(() => undefined);
    clearSession();
    clearDeviceKey(); // full logout — next sign-in re-provisions via OTP (no silent relogin)
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
    clearConversationPeerCache();
    set({ state: 'signed_out', accountId: null, sessionId: null, phone: null });
  },

  // Refresh failed / token revoked mid-session (the network client already cleared the
  // tokens). Reflect it in the state machine so the navigator can reactively send the user
  // back to sign-in instead of stranding them on a zombie "logged-in" screen. The device
  // key is kept, so a later cold-launch can still silent-relogin if it's still valid.
  sessionExpired: () => {
    set({ state: 'signed_out', accountId: null, sessionId: null });
  },
}));
