# ADR 0008 — Push notifications: a first-party FCM module, not react-native-firebase

- **Status:** Accepted
- **Date:** 2026-09-05
- **Phase:** Push increment (§M14 / §L12), unblocks the §M13 background contract
- **Deciders:** mobile (native modules)

## Context

`src/infra/push/` was an empty barrel. The product consequences were severe:

1. **A backgrounded app received nothing.** `SyncEngine` has a `pushAvailable` gate
   (`src/domain/sync/SyncEngine.ts`) and `scheduleSuspend()` returns early while it is false —
   deliberately, because "no background WebSocket" (§M13) is only safe *because* push wakes us.
   With no push, the app held a WebSocket all night: a 25 s ping, a watchdog and an outbox timer
   waking a sleeping device for hours. That is exactly the battery budget §R6 forbids.
2. **A user could not be told about a message unless the app was open.**

So push is not a feature increment, it is the precondition for a contract the rest of the client
already assumes.

The backend side already exists and is fully mapped (verified in `D:\Velchat`):

- `POST /notifications/endpoints` — `libs/feature-notification/src/notify/notification.controller.ts:49`
  taking `{deviceId, userId, platform:'web'|'ios'|'android', token?, voipToken?, subscription?}`
  (`notification.dto.ts` `RegisterEndpointDto`), upserted `ON CONFLICT (device_id)`
  (`notification.repository.ts:63`).
- Delivery is **FCM HTTP v1, data-only, `android.priority: 'high'`**
  (`libs/push/src/adapters/fcm.sender.ts`) — there is no `notification` block, on purpose:
  personal/E2EE pushes carry **no content**, only ids
  (`notification.service.ts:50` → `{conversationId, messageId, seq}` for `type:'message'`).

Two facts fall out of that and drive the decision:

- **The transport must be FCM.** The server is already an FCM sender; nothing else would be
  received.
- **The client must render its own notification.** A data-only message never produces a system
  tray entry by itself, and it must be handled in a `FirebaseMessagingService` so it also works
  when the app is killed.

## Decision

**Write a first-party native push module. Add no npm dependency; add one Gradle dependency.**

- `com.google.firebase:firebase-messaging` (Gradle, Android only) — unavoidable, it *is* FCM.
- `android/app/src/main/java/com/velchat/push/` — `VelChatMessagingService` (token refresh +
  data-message handling + notification posting), `VelChatPushModule` (token get/delete, support
  probe), `VelChatPushPackage`, `PushNotifications` (channels), `PushBridge` (emit to JS when a
  React context is alive).
- `src/infra/push/` — the typed TS surface, authored **before** the native code (§M23):
  `types.ts` (contract), `pushState.ts` (pure reducer: permission/token/registration state
  machine + dedup key, unit-tested), `nativePush.ts` (the only file that knows about
  `Platform.OS` or `NativeModules`), `api.ts` (the backend call), `pushService.ts`
  (orchestration + owned subscriptions), `index.ts`.

### Rejected: `@react-native-firebase/app` + `@react-native-firebase/messaging`

The obvious choice, and it was rejected for four concrete reasons, not taste:

1. **It does not actually finish the job.** The backend sends data-only messages. RNFirebase
   surfaces them but does not display them, so shipping it means *also* adding
   `@notifee/react-native` (or writing the same `FirebaseMessagingService` anyway) — two new npm
   dependencies plus a native service, to end up where the first-party module starts.
2. **App-killed delivery still needs native code.** `setBackgroundMessageHandler` spins up a
   headless JS context for every push. On the reference device (3 GB RAM, Android 10, §M0.1)
   that is a JS runtime + Hermes bytecode load per incoming message, at 03:00, to draw a
   notification whose entire content is "New message". Posting it from Kotlin costs no JS
   context at all.
3. **Build fragility without `google-services.json`.** RNFirebase's documented setup applies the
   `com.google.gms.google-services` plugin unconditionally, which **fails the build** when the
   file is absent — and this repo has no Firebase project yet. The first-party module applies
   that plugin (and even its buildscript classpath) only `if (file(...).exists())`, so a fresh
   clone still builds and push simply reports `unsupported`.
4. **Weight.** RNFirebase pulls `firebase-bom` + `firebase-analytics` transitively in a default
   setup and adds a JS layer we would use ~6 methods of. §M1 keeps the stack locked; the
   marginal value here is negative.

### Other alternatives considered

- **`react-native-push-notification`** — unmaintained, legacy-arch only, no New Architecture
  support. Non-starter on RN 0.86 bridgeless.
- **`@notifee/react-native` alone** — display only, no FCM transport. Would still need a
  messaging library. Worth revisiting later for rich notification UI (actions, reply-inline,
  grouping); it composes with this module rather than replacing it.
- **Web Push / VAPID** — the backend supports it (`libs/push/src/adapters/webpush.sender.ts`)
  but it is the *web* client's transport; Android has no Web Push.
- **A self-hosted transport (MQTT/long-poll)** — the only way to avoid Google Play Services, and
  it would mean a persistent background socket, i.e. the exact §M13 violation being fixed.
  Rejected.

## Consequences

- **A Firebase project is now a deployment prerequisite.** Absent `google-services.json` the app
  builds and runs, push reports `unsupported`, `pushAvailable` stays `false`, and the SyncEngine
  keeps its background socket — i.e. today's behaviour, unchanged and un-crashed. See
  `docs/push-setup.md`.
- **Google Play Services dependency on Android.** Devices without it (some China-market ROMs,
  de-Googled builds) get no push and fall back to the background socket automatically, because
  `isSupported()` returns false there. That fallback is a feature, not an oversight.
- **`+~1.6 MB` APK** (firebase-messaging + transitive play-services-basement/tasks). No JS
  bundle growth — the TS surface is ~600 lines and there is no third-party JS.
- **Notification content is "New message".** Not a limitation of this module: the server
  deliberately sends ids only (§A19 privacy). Enriching the notification from the local DB needs
  a bounded headless read and is a follow-up (see below).
- **iOS is authored as a typed `unsupported` stub only.** APNs/PushKit registration and the
  `UNUserNotificationCenter` glue must be written and built on a Mac; `nativePush.ts` is the
  seam it plugs into. **Not built, not tested, not verified here.**

## Follow-ups (explicitly not in this ADR's scope)

- **Bounded background sync on wake** (§M13's "push → bounded sync ≤ 30 s → sleep"). This ADR
  delivers wake + notify; the message itself is fetched by the existing foreground resume
  (`resyncAll`). A WorkManager-bounded catch-up belongs with `infra/background`.
- **VoIP/`voipToken`** — the DTO already accepts it; CallKit/ConnectionService is a separate
  increment.
- **Notification prefs** (`PUT/GET /notifications/prefs`) — server-side mute/DND exists and is
  unused by the client.
- **Codegen TurboModule spec.** The module is registered as a legacy `ReactPackage`, which the
  bridgeless interop layer supports (the same path `react-native-contacts` already uses in this
  app). Migrating to a codegen spec is mechanical and deferred.
