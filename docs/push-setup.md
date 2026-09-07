# Push notifications — setup and operations

Implements [ADR 0008](adr/0008-push-notifications-fcm.md). Read that first for *why* this is a
first-party native module rather than `@react-native-firebase/*`.

This document is the operational half: what has to exist for push to work, what happens when it
does not, and how to verify it end to end.

---

## 1. What push is actually for

Two things, and the second is the one that was broken:

1. **Telling the user about a message while the app is closed.** The obvious one.
2. **Telling the SENDER that the message arrived.** Receipts used to be WebSocket-only, so a
   recipient whose phone was online but whose app was closed could never acknowledge anything —
   the sender sat on one grey tick indefinitely, for a message that had reached the device.

(2) is why the messaging service acknowledges from Kotlin over `POST /notifications/ack`
(authenticated by the push token — see `libs/feature-notification/src/notify/push-ack.ts` in the
backend for the threat model). It is also why push cannot be treated as a cosmetic extra: without
it, a core product promise is unimplementable.

There is a third consequence: `SyncEngine.scheduleSuspend()` only drops the background WebSocket
once `pushAvailable` is true (§M13). Until push works, the app holds a socket all night with a
25 s ping — the exact battery cost §R6 forbids.

---

## 2. What has to exist

### 2.1 Firebase project

Project **`velchat-66ac4`**. It needs one Android app registered **per application id**, because
the three flavors install side by side with different ids:

| Flavor  | Application id      | `google-services.json` location             | Status |
| ------- | ------------------- | ------------------------------------------- | ------ |
| `prod`  | `com.velchat`       | `apps/mobile/android/app/src/prod/`         | ✅ present |
| `dev`   | `com.velchat.dev`   | `apps/mobile/android/app/src/dev/`          | ⛔ not registered yet |
| `stage` | `com.velchat.stage` | `apps/mobile/android/app/src/stage/`        | ⛔ not registered yet |

To add the missing two: Firebase console → Project settings → *Your apps* → **Add app** →
Android → enter the application id → download `google-services.json` → drop it in the directory
above. No code change is needed; the Gradle wiring picks it up automatically.

**Until then, `dev` and `stage` still build and run.** They report push as `unsupported`, and the
SyncEngine keeps its background socket. That is deliberate — see §4.

### 2.2 Backend environment

The backend builds an `FcmSender` only when all three of these are set
(`libs/push/src/create-push.ts`); otherwise it falls back to `LogPushSender`, which logs the push
and delivers nothing. There is no error — a misconfigured deployment looks exactly like a working
one from the outside, so **check the boot log for `push: FCM` vs `push: log`**.

```
FCM_PROJECT_ID=velchat-66ac4
FCM_CLIENT_EMAIL=firebase-adminsdk-...@velchat-66ac4.iam.gserviceaccount.com
FCM_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
```

Two things that have bitten this deployment before:

- **No inline comments.** `loadConfig()` strips `\s+#.*$` from every value now
  (`libs/config/src/index.ts`), but a `#` with no preceding whitespace still survives and will
  corrupt the key.
- **The private key contains newlines.** Keep them as literal `\n` escapes on one line, or use
  the platform's multi-line secret input. A key with real line breaks in a `.env` file truncates
  at the first newline and every push fails with an opaque JWT error.

These come from a Firebase **service account** JSON (Project settings → Service accounts →
Generate new private key). That file is a credential: it is never committed, and if it has ever
been pasted into a chat, an issue, or a log, **rotate it** (same screen → delete the old key).

---

## 3. How a message becomes a notification

```
sender ──REST──▶ chat-service ──message.sent──▶ notification-service
                                                    │
                                    decideNotify: recipient offline? muted? DND?
                                                    │ yes → enqueue (ids + preview, never names)
                                                    ▼
                                              OutboxWorker ──FCM HTTP v1──▶ device
                                                                              │
                            ┌─────────────────────────────────────────────────┘
                            ▼
              VelChatMessagingService.onMessageReceived   (Kotlin, NO JS runtime)
                            │
              ┌─────────────┼──────────────────────────────┐
              ▼             ▼                              ▼
     post notification   POST /notifications/ack      emit to JS if alive
     (name from the      (delivered, up_to_seq)       (so it can sync now)
      mirrored map)             │
                                ▼
                        message.delivered ──▶ fanout ──▶ sender sees ✓✓
```

**The payload carries no NAMES** — `{conversationId, messageId, seq, senderId, kind, preview?}`.
Conversation and sender are ids; both are resolved on the device from the display-name maps JS
mirrors into native storage (`PushStore.putConversationNames` / `putPersonNames`, driven off the
chat-list observation). An unknown id falls back to "VelChat" rather than to a wrong name.

**The payload carries a preview where the server can read one.** `preview.ts` decides: a
truncated, single-line body for a textual message whose plaintext the server already stores, and
NOTHING once `ciphertext_ref` is set. So enabling E2EE tightens notifications automatically
rather than needing anyone to remember this. Attachments send only their `kind` (`image`,
`audio`, …) and the client renders a localised label.

> **The trade to be aware of:** a preview transits FCM, so Google can see it. That is the
> difference between this and WhatsApp, and the price of showing the text at all before E2EE
> exists. `messagePreview(m, allowPreview)` takes the flag already, so a per-account "show
> preview" toggle is a wiring change in `notification.service.ts`, not a redesign.

### Notification actions

| Action           | Runs in                       | What it does                                                              |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------- |
| **Reply**        | `PushActionReceiver` + headless JS | Sends a `read` receipt natively, queues the text, boots JS to send it through the outbox |
| **Mark as read** | `PushActionReceiver` (native) | Sends a `read` receipt natively; queues the local badge clear for JS       |
| **Mute**         | `PushActionReceiver` (native) | Mutes 8 h locally at once; queues `PUT /notifications/prefs` for JS        |
| **Tap**          | `MainActivity` deep link      | `velchat://chat/<id>` → the existing `RootNavigator` linking config        |

Reply is the only path that boots a JS runtime, and only because sending needs the user's real
session. An incoming push never does — that is ADR 0008's central point.

---

## 4. What happens when push is NOT configured

Every one of these is a normal state, not an error:

| Situation                                   | `isSupported()` | Result                                             |
| ------------------------------------------- | --------------- | -------------------------------------------------- |
| No `google-services.json` for this flavor    | `false`         | App builds and runs; background socket retained     |
| No Google Play Services (de-Googled ROM)     | token is `null` | Same — falls back automatically                     |
| `POST_NOTIFICATIONS` denied                  | `true`          | `pushAvailable` stays false; socket retained        |
| Backend has no `FCM_*`                       | n/a             | Pushes are logged, not sent; client never wakes     |

The Gradle wiring is what keeps the first row true: the `com.google.gms.google-services` plugin
**fails the build** when its config is missing, so both the buildscript classpath
(`android/build.gradle`) and the plugin application (`android/app/build.gradle`) are guarded by a
file-existence check. Build one flavor per Gradle invocation — the flavor is read from the task
names, the same rule the `ENVFILE` mapping already documents.

---

## 5. Verifying it end to end

Run these in order; each one isolates a different link in the chain.

**0. Is push wired on the server at all?** Ask it directly — this is the check that would have
saved the most time, because a server with no `FCM_*` env sends nothing while every push
"succeeds":

```bash
curl -s https://velchat.duckdns.org/notifications/push-status
# → {"transport":"mobile:fcm,web:none","delivers":true,"canAck":true}
```

`delivers:false` (or `transport:"log"` / `"mobile:none,…"`) means **no phone will ever hear
anything**, whatever the app does. Fix the env in §2.2 and redeploy before looking at the client.
`canAck:false` means device acks cannot be published — the second tick will not arrive.

**1. The build actually included Firebase.**

```bash
ENVFILE=.env.prod ./gradlew assembleProdRelease | grep "VelChat push:"
# → "VelChat push: .../app/src/prod/google-services.json"
# "no google-services.json for flavor 'prod'" means the file is missing or misplaced.
```

**2. The device got a token and registered it.**

```bash
adb logcat -s VelChatPush ReactNativeJS | grep -i push
# → "push registered with backend"
# → "push availability changed {available: true}"
```

**3. The backend is sending, not logging.** Check the service boot log for the push sender it
chose. `LogPushSender` means one of the three `FCM_*` values is missing or malformed.

**4. The closed-app tick — the thing this was built for.**

- Force-stop VelChat on phone B (`adb shell am force-stop com.velchat`), leave its data on.
- Send B a message from phone A.
- B should show a notification within a second or two.
- **A's message should turn ✓✓ (grey double tick) without B being opened.**
- `adb logcat -s VelChatPushAck` on B shows the ack attempt; a failure prints the HTTP status.

If the notification appears but the tick stays single, the ack is being refused — the log line
says whether it was a 4xx (credentials/membership) or a network failure.

**5. The actions.** From the notification on B: type a reply and send it → it appears in the chat
on A. Tap "Mark as read" → A's ticks turn blue. Tap "Mute" → the next message from A produces no
notification on B.

---

## 6. Known gaps

- **iOS is a typed stub.** `nativePush.ts` reports `unsupported` on iOS. APNs/PushKit
  registration and the `UNUserNotificationCenter` glue must be written and built on a Mac. Not
  built, not tested, not verified here.
- **Group sender names.** The name mirror is driven off the chat list, which gives DM peers for
  free but not group members. A group notification therefore attributes lines to the conversation
  rather than to the person; mirroring member profiles is a follow-up.
- **No per-account "show preview" toggle** — the plumbing is there (§3), the preference is not.
- **VoIP push** (`voipToken`) is accepted by the backend DTO and unused; CallKit/ConnectionService
  is a separate increment.
- **The module is a legacy `ReactPackage`**, not a codegen TurboModule spec. The bridgeless
  interop layer supports it (the same path `react-native-contacts` uses here). Migrating is
  mechanical and deferred.
