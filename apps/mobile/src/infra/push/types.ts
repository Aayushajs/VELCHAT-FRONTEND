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
  | 'idle'
  | 'unsupported'
  | 'denied'
  | 'registering'
  | 'registered'
  | 'failed';

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
 * Something the user did on a notification while no JS runtime existed.
 *
 * These are queued natively (`PushStore`) and drained by JS, because each one needs the user's
 * real session to finish: a reply goes through the outbox, a mute has to reach
 * `PUT /notifications/prefs`, a read has to clear the local unread badge. Native can send the
 * *receipt* on its own — it has the push token — but not any of this.
 *
 * `resync` is the odd one out: FCM told us it DROPPED messages for this device, so there are no
 * ids to act on and the only correct response is a cursor sync.
 */
export type PushPendingEvent =
  | {
      readonly type: 'reply';
      readonly conversationId: string;
      readonly text: string;
      readonly upToSeq?: number;
      readonly at?: number;
    }
  | {
      readonly type: 'read';
      readonly conversationId: string;
      readonly upToSeq?: number;
    }
  | {
      readonly type: 'mute';
      readonly conversationId: string;
      readonly mutedUntil: number;
    }
  | { readonly type: 'token'; readonly token: string }
  | { readonly type: 'resync' };

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

  /**
   * Mirror what a woken, JS-less process needs in order to authenticate a delivery receipt:
   * the API origin, the device id, and the account it belongs to.
   *
   * This is the seam that makes a closed app able to say "delivered". Native cannot read MMKV
   * (it is initialised from JS) and cannot mint a JWT (refreshing one from native would rotate
   * the refresh family behind this side's back), so JS hands it the one credential that works.
   */
  setCredentials(
    baseUrl: string,
    deviceId: string,
    accountId: string,
  ): Promise<void>;

  /** Sign-out: drop every native trace of the account that is leaving. */
  clearSession(): Promise<void>;

  /**
   * Mirror `conversationId -> display name`, so a notification posted from native can name the
   * chat. The push itself carries ids only (§A19), so without this the title is generic.
   */
  setConversationNames(names: Readonly<Record<string, string>>): Promise<void>;

  /**
   * Mirror `accountId -> display name`, so a GROUP notification can say who sent each line. The
   * push identifies its sender by id only; a name never leaves the device.
   */
  setPersonNames(names: Readonly<Record<string, string>>): Promise<void>;

  /**
   * Mirror accountId -> photo URL, so a notification can show the sender face-first.
   *
   * Only the URL crosses: native downloads and shrinks the picture while the app is alive and
   * caches it as a file. The process that draws a notification has no JS runtime and must do no
   * network work — a photo cannot be allowed to delay the message behind it.
   */
  setPersonAvatars(avatars: Readonly<Record<string, string>>): Promise<void>;

  /**
   * Tell native which chat is on screen, so a push for THAT chat is the only one suppressed.
   * `null` on leaving the chat re-enables notifications for it.
   */
  setActiveConversation(conversationId: string | null): Promise<void>;

  /** Keep the native mute in step with a pref the user set inside the app. 0 clears it. */
  setMuted(conversationId: string, untilMillis: number): Promise<void>;

  /** The user opened this chat — its notification is stale the moment they are looking at it. */
  clearConversationNotification(conversationId: string): Promise<void>;

  /**
   * Native signalled that queued actions are waiting. Carries no data on purpose: draining is
   * always a pull (`takePendingEvents`), so an event cannot be lost in the window between a JS
   * runtime existing and this listener being attached. Returns an unsubscribe.
   */
  onPendingEvents(cb: () => void): () => void;

  /** Drain the queue. The ONLY thing that empties it — callers must handle what they take. */
  takePendingEvents(): Promise<PushPendingEvent[]>;

  /**
   * Is the app exempt from battery optimisation?
   *
   * When it is not, Doze and the OEM power managers may withhold a high-priority data message
   * entirely: FCM reports it delivered, the messaging service never runs, and the user gets
   * neither a notification nor a second tick on the sender's side. Nothing in the app can
   * observe that happening — this is the closest thing to an explanation available, which is
   * why it is surfaced rather than guessed at.
   */
  /**
   * Can a message notification actually be DISPLAYED — app-level and channel-level?
   *
   * The channel half is the one that hides: Android keeps a channel's importance forever once it
   * exists and silently ignores later changes, so a channel that was ever blocked stays blocked
   * while `areNotificationsEnabled()` still answers true. The notification then posts
   * successfully and never appears.
   */
  areMessageNotificationsBlocked(): Promise<boolean>;

  isIgnoringBatteryOptimizations(): Promise<boolean>;

  /** Show the system prompt for that exemption. Resolves false if no screen could be opened. */
  requestIgnoreBatteryOptimizations(): Promise<boolean>;

  /** Open this app's own system settings page (where notifications and battery both live). */
  openAppSettings(): Promise<boolean>;
}

/** The body `POST /notifications/endpoints` expects (backend `RegisterEndpointDto`). */
export interface RegisterEndpointBody {
  readonly deviceId: string;
  readonly userId: string;
  readonly platform: 'ios' | 'android' | 'web';
  readonly token?: string;
  readonly voipToken?: string;
}
