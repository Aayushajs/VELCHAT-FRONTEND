/**
 * infra/push — the typed contract, authored BEFORE any native code (§M23).
 *
 * Everything below is platform-agnostic on purpose: `nativePush.ts` is the single file
 * allowed to know whether the token underneath came from FCM (Android) or APNs (iOS).
 */

/**
 * OS notification permission, as the push layer cares about it.
 *
 * Note the Android subtlety: FCM issues a token and delivers data messages REGARDLESS of
 * `POST_NOTIFICATIONS`. So 'denied' does not mean "we cannot be woken" — it means "we cannot
 * tell the user anything when we are". We still treat it as push-unavailable (§M13), because
 * suspending the socket to save battery while the user is told nothing is not a trade worth
 * making.
 */
export type PushPermission = 'granted' | 'denied' | 'unavailable';

/**
 * Where the registration lifecycle currently stands.
 *
 *   idle         nothing attempted yet, or the token/identity changed and must be re-registered
 *   unsupported  no native module, no Firebase config, or no Play Services — permanent for this
 *                install+build. NOT an error: the app degrades to the background socket.
 *   denied       OS notification permission is not granted
 *   registering  a `POST /notifications/endpoints` is in flight
 *   registered   the backend holds this exact (account, device, token) triple
 *   failed       we hold a token but the backend refused/was unreachable; retried on next init
 */
export type PushPhase =
  'idle' | 'unsupported' | 'denied' | 'registering' | 'registered' | 'failed';

/** The whole push state, in one plain object. Pure — see `pushState.ts`. */
export interface PushStatus {
  readonly phase: PushPhase;
  /** The current device token, or null when we hold none. NEVER logged. */
  readonly token: string | null;
  readonly permission: PushPermission;
  /**
   * The `(accountId, deviceId, token)` triple the backend was last told about. This is the
   * DEDUP KEY: it stops every cold start from re-POSTing an unchanged registration, and it
   * guarantees a token rotation or an account switch DOES re-register.
   */
  readonly registeredKey: string | null;
  /** Last failure reason, for diagnostics only. Never contains the token. */
  readonly error: string | null;
}

/** Every transition the push lifecycle can make. */
export type PushEvent =
  | { readonly type: 'unsupported' }
  | { readonly type: 'permission'; readonly permission: PushPermission }
  | { readonly type: 'token'; readonly token: string | null }
  | { readonly type: 'registering' }
  | { readonly type: 'registered'; readonly key: string }
  | { readonly type: 'failed'; readonly error: string }
  | { readonly type: 'unregistered' };

/**
 * A data-only push as it reaches JS. The backend sends ids and NOTHING else for personal
 * content (§A19) — `conversationId`/`messageId`/`seq` for `type:'message'`.
 */
export interface PushMessage {
  readonly type: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly seq?: number;
  /** The raw FCM `data` map, for types this client does not model yet. */
  readonly data: Readonly<Record<string, string>>;
}

/**
 * The per-OS binding. Android is implemented (FCM); iOS is a typed `unsupported` stub until
 * the APNs/PushKit module is authored and built on a Mac (§M2 — never claimed verified here).
 */
export interface NativePushBinding {
  /** Is there a usable push transport on this build+device right now? */
  isSupported(): Promise<boolean>;
  /** The current device token, or null when unsupported / not yet issued. */
  getToken(): Promise<string | null>;
  /** Drop the token so the OS issues a fresh one — used at logout. */
  deleteToken(): Promise<void>;
  /** The OS rotated our token. Returns an unsubscribe (§M7: every listener is owned). */
  onTokenRefresh(cb: (token: string) => void): () => void;
  /** A data message arrived while a JS context was alive. Returns an unsubscribe. */
  onMessage(cb: (message: PushMessage) => void): () => void;
  /** Remove any notifications this app posted (called after a successful catch-up). */
  clearDisplayedNotifications(): Promise<void>;
}

/** The body `POST /notifications/endpoints` expects (backend `RegisterEndpointDto`). */
export interface RegisterEndpointBody {
  readonly deviceId: string;
  readonly userId: string;
  readonly platform: 'ios' | 'android' | 'web';
  readonly token?: string;
  readonly voipToken?: string;
}
