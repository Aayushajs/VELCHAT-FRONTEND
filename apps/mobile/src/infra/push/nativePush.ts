/**
 * The per-OS push binding (§M2/§M23) — the ONLY file in the push layer that knows about
 * `Platform.OS`, `NativeModules` or an event emitter. Everything above it sees the
 * `NativePushBinding` interface from `types.ts` and nothing else.
 *
 * Android → the first-party `VelChatPush` module over FCM (see
 * `android/app/src/main/java/com/velchat/push/`).
 * iOS     → a typed `unsupported` stub. APNs/PushKit registration must be authored and built
 *           on a Mac; this is the seam it plugs into. NOT built, NOT verified here.
 *
 * Degradation is the point of this file. Three separate things can be missing — the native
 * module (JS installed, app not rebuilt), the Firebase config (`google-services.json` absent),
 * and Play Services (de-Googled ROM) — and all three must produce a calm `unsupported`, never
 * a crash and never a thrown promise on a launch path.
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { log } from '../../core';
import type { NativePushBinding, PushMessage } from './types';

/** Event names emitted by the native side. Keep in sync with `PushBridge.kt`. */
const EVENT_TOKEN = 'velchat.push.token';
const EVENT_MESSAGE = 'velchat.push.message';

interface VelChatPushNativeModule {
  isSupported(): Promise<boolean>;
  getToken(): Promise<string | null>;
  deleteToken(): Promise<void>;
  clearNotifications(): Promise<void>;
  /** Required by NativeEventEmitter; no-ops on the native side. */
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

/**
 * Look the module up defensively. In bridgeless mode an unknown key is `undefined`, but a
 * partially-linked build can also throw on property access — neither may reach a caller.
 */
function lookupModule(): VelChatPushNativeModule | null {
  if (Platform.OS !== 'android') return null;
  try {
    const mod = (NativeModules as Record<string, unknown>).VelChatPush;
    return (mod as VelChatPushNativeModule | undefined) ?? null;
  } catch {
    return null;
  }
}

const nativeModule = lookupModule();

/** One emitter for the module, created lazily and only when the module actually exists. */
let emitter: NativeEventEmitter | null = null;
function getEmitter(): NativeEventEmitter | null {
  if (!nativeModule) return null;
  if (!emitter) {
    emitter = new NativeEventEmitter(
      nativeModule as unknown as ConstructorParameters<
        typeof NativeEventEmitter
      >[0],
    );
  }
  return emitter;
}

/**
 * Normalize an FCM `data` map into a `PushMessage`. Every FCM data value is a STRING on the
 * wire, so `seq` arrives as `"42"` and must be parsed — comparing a string seq against the
 * numeric cursors elsewhere would silently never match.
 */
export function parsePushMessage(raw: unknown): PushMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') data[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean')
      data[k] = String(v);
  }
  const type = data.type;
  if (!type) return null;
  const seq = Number(data.seq);
  // Build up rather than assigning `undefined`: `exactOptionalPropertyTypes` distinguishes an
  // ABSENT optional field from one explicitly set to undefined, and a payload that simply omits
  // a field must produce the former.
  const msg: { -readonly [K in keyof PushMessage]: PushMessage[K] } = {
    type,
    data,
  };
  if (data.conversationId) msg.conversationId = data.conversationId;
  if (data.messageId) msg.messageId = data.messageId;
  if (data.seq !== undefined && Number.isFinite(seq)) msg.seq = seq;
  return msg;
}

/** The binding used when there is no push transport at all (iOS today, or a bare Android build). */
const unsupportedBinding: NativePushBinding = {
  isSupported: () => Promise.resolve(false),
  getToken: () => Promise.resolve(null),
  deleteToken: () => Promise.resolve(),
  onTokenRefresh: () => () => undefined,
  onMessage: () => () => undefined,
  clearDisplayedNotifications: () => Promise.resolve(),
};

const androidBinding = (mod: VelChatPushNativeModule): NativePushBinding => ({
  async isSupported() {
    try {
      return await mod.isSupported();
    } catch {
      return false;
    }
  },

  async getToken() {
    try {
      const token = await mod.getToken();
      return token && token.length > 0 ? token : null;
    } catch (err) {
      // A token request fails on a device with no Play Services, no network on first run, or
      // an unconfigured Firebase project. All are "no push", none are fatal.
      log.info('push: token unavailable', { reason: String(err) });
      return null;
    }
  },

  async deleteToken() {
    try {
      await mod.deleteToken();
    } catch (err) {
      log.info('push: token delete failed', { reason: String(err) });
    }
  },

  onTokenRefresh(cb) {
    const em = getEmitter();
    if (!em) return () => undefined;
    const sub = em.addListener(EVENT_TOKEN, (payload: unknown) => {
      const token =
        typeof payload === 'string'
          ? payload
          : (payload as { token?: string } | null)?.token;
      if (typeof token === 'string' && token.length > 0) cb(token);
    });
    return () => sub.remove();
  },

  onMessage(cb) {
    const em = getEmitter();
    if (!em) return () => undefined;
    const sub = em.addListener(EVENT_MESSAGE, (payload: unknown) => {
      const message = parsePushMessage(payload);
      if (message) cb(message);
    });
    return () => sub.remove();
  },

  async clearDisplayedNotifications() {
    try {
      await mod.clearNotifications();
    } catch {
      // Cosmetic only — never worth surfacing.
    }
  },
});

/** The binding for this OS+build. Resolved once at module load. */
export const nativePush: NativePushBinding = nativeModule
  ? androidBinding(nativeModule)
  : unsupportedBinding;

/** True when a native push module is linked at all (before asking whether it is configured). */
export const hasNativePushModule = nativeModule !== null;
