/**
 * QA regression guard — authStore's forced-logout path (VC-013).
 *
 * Each test encodes the CORRECT behaviour, so it fails while the defect is present and turns
 * green when the defect is fixed. The bug id is in the describe name so a failure points
 * straight at QA/reports/bugs.json and its Jira issue.
 *
 * The cross-feature purge functions (chat DB, receipts, profile/contact/discovery caches, push)
 * are mocked so this stays a fast unit test — the interesting assertion is WHICH functions
 * `sessionExpired()` calls, not what each one does internally (those have their own tests).
 * `kv`/`KVKeys`/`clearSession` are left real (backed by the jest-mocked react-native-mmkv), so
 * the KV-key half of the purge is verified against actual reads/writes, not a mock recording it
 * was "called".
 */
jest.mock('../../../notifications', () => ({
  shutdownPushForSignOut: jest.fn(() => Promise.resolve()),
  startPushRuntime: jest.fn(),
}));
jest.mock('../../../user', () => ({
  clearProfileCache: jest.fn(),
  clearContactAvatarCache: jest.fn(),
}));
jest.mock('../../../contacts', () => ({
  clearContactsDiscoveryCache: jest.fn(),
}));
jest.mock('../../../chat', () => ({
  clearConversationPeerCache: jest.fn(),
  clearStartDmCache: jest.fn(),
}));
jest.mock('../../api/authApi', () => ({
  logout: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../../../infra', () => {
  const actual = jest.requireActual('../../../../infra');
  return {
    ...actual,
    clearDeviceKey: jest.fn(),
    purgeAllLocalChat: jest.fn(() => Promise.resolve()),
    clearAllReceipts: jest.fn(),
  };
});

import { kv, KVKeys, setTokens } from '../../../../infra';
import {
  shutdownPushForSignOut,
  startPushRuntime,
} from '../../../notifications';
import { clearProfileCache, clearContactAvatarCache } from '../../../user';
import { clearContactsDiscoveryCache } from '../../../contacts';
import { clearConversationPeerCache, clearStartDmCache } from '../../../chat';
import { useAuthStore } from '../authStore';
import * as infra from '../../../../infra';

const mocked = {
  clearDeviceKey: infra.clearDeviceKey as jest.Mock,
  purgeAllLocalChat: infra.purgeAllLocalChat as unknown as jest.Mock,
  clearAllReceipts: infra.clearAllReceipts as jest.Mock,
  shutdownPushForSignOut: shutdownPushForSignOut as jest.Mock,
  startPushRuntime: startPushRuntime as jest.Mock,
  clearProfileCache: clearProfileCache as jest.Mock,
  clearContactAvatarCache: clearContactAvatarCache as jest.Mock,
  clearContactsDiscoveryCache: clearContactsDiscoveryCache as jest.Mock,
  clearConversationPeerCache: clearConversationPeerCache as jest.Mock,
  clearStartDmCache: clearStartDmCache as jest.Mock,
};

/** Populate every key + cache a signed-in account leaves behind, exactly like a real session. */
function seedPreviousAccountState(): void {
  setTokens({
    access: 'access-token',
    refresh: 'refresh-token',
    accountId: 'prev-account',
    deviceId: 'prev-device',
  });
  kv.set(KVKeys.phone, '+919876500001');
  kv.set(KVKeys.loginAt, new Date().toISOString());
  kv.set(KVKeys.displayName, 'Previous User');
  kv.set(KVKeys.email, 'previous@example.com');
  kv.set(KVKeys.about, 'about text');
  kv.set(KVKeys.avatarUri, 'file:///prev-avatar.jpg');
  kv.set(KVKeys.avatarUrl, 'https://cdn.example/prev-avatar.jpg');
  kv.set(KVKeys.memberSince, '2026-01-01');
  kv.set(KVKeys.profileComplete, 'true');
  kv.set(KVKeys.contactsSnapshot, '[{"id":"c1"}]');
  kv.set(KVKeys.discoverySelfRegistered, 'true');
  useAuthStore.setState({
    state: 'active',
    accountId: 'prev-account',
    phone: '+919876500001',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.values(KVKeys)) kv.delete(key);
});

describe('VC-013 — a forced session expiry must purge the previous account, not just flip state', () => {
  it('sessionExpired() clears every profile-mirror KV key signOut() clears', () => {
    seedPreviousAccountState();

    useAuthStore.getState().sessionExpired();

    for (const key of [
      KVKeys.phone,
      KVKeys.loginAt,
      KVKeys.displayName,
      KVKeys.email,
      KVKeys.about,
      KVKeys.avatarUri,
      KVKeys.avatarUrl,
      KVKeys.memberSince,
      KVKeys.profileComplete,
      KVKeys.contactsSnapshot,
      KVKeys.discoverySelfRegistered,
    ]) {
      expect(kv.getString(key)).toBeUndefined();
    }
  });

  it('sessionExpired() purges the local chat DB and every per-account cache', () => {
    seedPreviousAccountState();

    useAuthStore.getState().sessionExpired();

    expect(mocked.purgeAllLocalChat).toHaveBeenCalled();
    expect(mocked.clearAllReceipts).toHaveBeenCalled();
    expect(mocked.clearProfileCache).toHaveBeenCalled();
    expect(mocked.clearContactAvatarCache).toHaveBeenCalled();
    expect(mocked.clearContactsDiscoveryCache).toHaveBeenCalled();
    expect(mocked.clearConversationPeerCache).toHaveBeenCalled();
    expect(mocked.clearStartDmCache).toHaveBeenCalled();
  });

  it('sessionExpired() clears the native push registration for this device', () => {
    seedPreviousAccountState();

    useAuthStore.getState().sessionExpired();

    expect(mocked.shutdownPushForSignOut).toHaveBeenCalled();
  });

  it('sessionExpired() does NOT clear the device key — a legitimate transient expiry must still be able to silent-relogin', () => {
    seedPreviousAccountState();

    useAuthStore.getState().sessionExpired();

    expect(mocked.clearDeviceKey).not.toHaveBeenCalled();
  });

  it('resets the in-memory phone field too, not just the persisted key', () => {
    seedPreviousAccountState();

    useAuthStore.getState().sessionExpired();

    expect(useAuthStore.getState().phone).toBeNull();
    expect(useAuthStore.getState().state).toBe('signed_out');
    expect(useAuthStore.getState().accountId).toBeNull();
  });
});

describe('VC-011 — a sign-in after a sign-out (same process) must bring push back', () => {
  it('provision() restarts the push runtime', () => {
    // `startPushRuntime()` only ever ran ONCE, from App.tsx's `[]` mount effect. A sign-out
    // (`shutdownPushForSignOut` -> `stopPushRuntime`) tears down the session-availability and
    // push-message subscriptions and never re-creates them, so a re-login in the same process
    // (no app restart) left push, and the sync engine's `setPushAvailable` wiring, permanently
    // dead: notification replies drained into an empty listener set and quietly vanished.
    // `startPushRuntime()` is idempotent (a no-op if already running), so calling it here is
    // exactly as safe on the app's normal FIRST sign-in (already started by the mount effect)
    // as it is necessary on a re-login.
    useAuthStore.getState().provision({
      accountId: 'new-account',
      deviceId: 'new-device',
      access: 'access-token',
      refresh: 'refresh-token',
      expiresIn: 900,
    });

    expect(mocked.startPushRuntime).toHaveBeenCalled();
  });
});
