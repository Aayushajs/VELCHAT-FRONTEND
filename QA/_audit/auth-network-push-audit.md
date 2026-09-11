# QA Audit — Auth, Tokens, HTTP Client, Push/Notifications

Read-only audit. No production code was modified. Every item below was traced through the actual
code path ("VERIFIED") unless explicitly marked as needing confirmation.

The **full reproducible detail** for each defect (steps, expected, actual, evidence, severity, Jira
mapping) lives in the canonical registry `QA/reports/bugs.json`, which drives the Excel report, Jira
sync, and the final QA report. This file is the narrative index.

## Defect index

| ID | Severity | Title | Anchor |
|---|---|---|---|
| VC-BUG-001 | P1 | Sign-out's authenticated calls ship with no `Authorization` header | `features/auth/model/authStore.ts:79-89` |
| VC-BUG-002 | P0 | Sign-out → sign-in in one process destroys every notification action | `app/App.tsx:133-136`, `pushRuntime.ts:148-159` |
| VC-BUG-003 | P1 | Rotating-refresh replay is structurally inevitable → family revoke | `infra/network/client.ts:160-197` |
| VC-BUG-004 | P1 | `cnfJkt` DPoP binding is dead code — refresh token bound to nothing | `client.ts:167,184-185`, `tokens.ts:172` |
| VC-BUG-005 | P2 | `Retry-After` honored with an unbounded, uncancellable sleep | `client.ts:308-312` |
| VC-BUG-006 | P0 | Android ≤ 12 reports notifications granted when off → socket dropped | `infra/native/notifications.ts:21-23` |
| VC-BUG-007 | P1 | No duplicate-notification suppression (FCM is at-least-once) | `PushNotifications.kt:200-240` |
| VC-BUG-008 | P1 | Native pending-event queue is a lock-free read-modify-write | `PushStore.kt:394-407` |
| VC-BUG-009 | P2 | `runQueuedPushActions` runs actions concurrently while claiming to serialize | `pushRuntime.ts:301-305` |
| VC-BUG-010 | P0 | `clearSession()` is not a teardown — previous account's data survives | `tokens.ts:179-187` |
| VC-BUG-011 | P2 | A misbuilt binary reports `env:'dev'` while talking to production | `core/config/env.ts:20-31` |
| VC-BUG-012 | P3 | 429 on `sendOtp` discards the server's `Retry-After` | `features/auth/hooks/useAuth.ts:150-165` |
| VC-BUG-013 | P2 | Cold start after >15 min opens the WebSocket with an expired token | `useAuth.ts:269-273` |
| VC-BUG-014 | P3 | Mute collapse keeps the longest mute, not the latest | `pendingEvents.ts:141-146` |
| VC-BUG-015 | P2 | `pushService`'s four native subscriptions are never released (§M7) | `pushService.ts:96-100,561-573` |
| VC-BUG-016 | P3 | `inflight` is written and never read — stale mechanism | `pushRuntime.ts:77,94-95` |
| VC-BUG-017 | P3 | `usePushBlocker` sets state after unmount | `usePushBlocker.ts:55-61` |
| VC-BUG-018 | P3 | `useSessionPolling` can provision a session after its screen is gone | `useAuth.ts:94-110` |
| VC-BUG-019 | P2 | `initPush()` single-flight can swallow a sign-in that lands mid-flight | `pushService.ts:476-478` |
| VC-BUG-020 | P2 | `cancelAll` leaves message plaintext on disk | `PushNotifications.kt:533-536` |

## Security findings

| ID | Severity | Title | Anchor |
|---|---|---|---|
| VC-SEC-001 | P0 | MMKV "encryption" key is a hardcoded bundle constant — and holds the Ed25519 device private key | `infra/kv/mmkv.ts:10-16`, `deviceKey.ts:44` |
| VC-SEC-002 | P1 | No certificate pinning anywhere (JS or native) | repo-wide; `android/app/src/main/res/xml/` absent |
| VC-SEC-003 | P2 | `PushAckClient` condition reads as a guard but permits cleartext | `PushAckClient.kt:203` |
| VC-SEC-004 | P1 | Message plaintext + the user's own replies persist in plaintext SharedPreferences | `PushStore.kt:28-31,248-273,394-400` |
| VC-SEC-005 | P2 | Access token travels in the WebSocket query string | `infra/realtime/socket.ts:104-108` |
| VC-SEC-006 | P3 | Redaction cannot recognize an opaque refresh token | `core/logger/redact.ts:13-19` |
| VC-SEC-007 | P1 | Client asserts its own `userId` in the push-registration body — needs server-side binding check | `infra/push/api.ts:24-28` |
| VC-SEC-008 | P2 | Threat-model controls absent: no FLAG_SECURE, Play Integrity, clipboard clear, root signal | repo-wide (§A1/§D4) |

## Verified SAFE (checked adversarially, found correct)

These were actively probed and the code is right — recorded so the next audit does not re-litigate:

- **Native never refreshes a JWT.** `PushAckClient.kt:16-19`, `PushHeadlessService.kt:22-25` call out
  the family-rotation hazard and authenticate the ack with `deviceId + pushToken`. No native/JS race.
- **Single-flight 401 refresh is correct.** `client.ts:200-207` + `__didAuthRetry`
  (`client.ts:276,280`) collapse concurrent 401s into one round-trip, one auth retry per config.
- **Non-idempotent POSTs are excluded from retry** (`client.ts:298-313`) — OTP send/verify,
  `createDm`, OPRF are correctly never replayed.
- **The access token is not logged.** `redact.ts:13-19` censors by key and scrubs
  JWT/Bearer/email/phone patterns from free-form values. Dev console traces (`client.ts:91-119`) are
  `__DEV__`-gated and log `config.url` only.
- **`PushActionReceiver` is `exported="false"`** (`AndroidManifest.xml:75-77`) — no other app can
  broadcast a forged `com.velchat.push.REPLY`. Release sets `usesCleartextTraffic="false"`.
- **Push registration lease is correct.** `registrationKey` includes
  `accountId|deviceId|token|baseUrl`, percent-encoded (`pushState.ts:47-49`); `mirrorCredentials()`
  runs before the lease short-circuit (`pushService.ts:443-450`); the 7-day TTL heals a server prune.
- **No client-side-only authorization decisions.** `getPushBlocker` re-asks the OS rather than
  trusting cache (`pushService.ts:593-600`). `isMuted` (`PushStore.kt:326-329`) suppresses a
  notification locally — a display choice, not an authorization one.

## Testable seams (no device required)

| Seam | Signature | Tests today |
|---|---|---|
| `infra/network/errors.ts:73` | `normalizeError(error: unknown): AppError` | **none** |
| `infra/network/errors.ts:17,50` | `class AppError` (`retryable` :44-47, `retryAfterMs` :43); `isAppError` | none |
| `infra/network/tokens.ts:98` | `accessTokenExpiresInMs(now = Date.now()): number` | **none** |
| `infra/network/tokens.ts:65` | `getAccountId(): string \| undefined` | `accountId.test.ts` |
| `infra/network/tokens.ts:135,168,179` | `subscribeSession` / `setTokens` / `clearSession` | `sessionEvents.test.ts` |
| `infra/network/client.ts:200,214` | `refreshSession()` / `refreshAccessToken()` | `refreshOutcome.test.ts` (mocks `axios.post`) |
| `infra/push/pushState.ts:32,53,120,132` | `registrationKey` / `reducePush` / `isPushAvailable` / `shouldRegister` | well covered |
| `infra/push/pendingEvents.ts:30,110` | `parsePendingEvent` / `collapsePendingEvents` | covered |
| `infra/push/nativePush.ts:92` | `parsePushMessage(raw: unknown): PushMessage \| null` | **none** |
| `core/logger/redact.ts:21,29` | `scrubString` / `redact` | none in scope |
| `infra/push/pushService.ts:648` | `__resetPushForTests()` | **no test file for pushService at all** |
| `features/notifications/model/pushRuntime.ts:107,148,165,276` | runtime start/stop/shutdown/runQueued | `pushRuntime.test.ts` |
| `features/auth/model/authStore.ts:47` | `useAuthStore` (Zustand) | **none** |

**Interceptor-level seam (nothing exists today):** set `api.defaults.adapter = fn` and you can drive
flight-mode rejection (`client.ts:228-236`), header assembly (`:237-242`), envelope unwrapping
(`:249-266`), the 401 single-flight retry (`:274-291`), the 429 path (`:308-313`), the idempotency
gate (`:298-304`), and 5xx backoff (`:315-328`) — all without a device. This is the single highest
-value seam still unexercised.

**Not unit-testable without a device:** all Kotlin. **No JVM/Robolectric test source set exists** —
`android/app/src` contains only `main`. `PushStore` and `PushAckClient.post`'s budget arithmetic are
plain-JVM-testable and worth a `test/` source set.

## Coverage gaps (no test today)

- **`client.ts` has no test file at all.** `refreshOutcome.test.ts` mocks `axios.post` and never
  exercises the instance. Untested: 401 single-flight retry; two concurrent 401s sharing one refresh;
  `__didAuthRetry`; `clearSession()` on `rejected` vs survival on `unavailable` *through the
  interceptor*; 429 `Retry-After` honoring and the missing clamp; the idempotency gate; `MAX_RETRIES`
  worst-case latency; flight-mode fast-fail; envelope unwrapping (incl. `success` with no `data`);
  header assembly.
- **`errors.ts` — no tests.** cancel, `ECONNABORTED`, no-response, 401/403→`auth`, 429→`rate_limit`,
  5xx→`server`, plain-text body → `FRIENDLY`, `retryAfterMs` parsing, `requestId` body vs header.
- **Token store — partial.** `accessTokenExpiresInMs` has zero tests. `hasSession()` returning true
  for an expired token is untested — the root of VC-BUG-013. `clearSession()` completeness untested.
- **`authStore.ts` — no tests.** `signOut()` ordering (VC-BUG-001), purge completeness,
  `sessionExpired()` vs `signOut()` parity, `provision()` key writes.
- **Auth hooks — no tests.** `useAuthBootstrap`'s three branches + `active` guard; `useOtpAuth`'s
  re-entrancy guard; the missing-token guard; the 429 path; `useSessionPolling`'s post-unmount
  provision.
- **`pushService.ts` — no test file** despite `__resetPushForTests` existing for exactly this.
  Untested: the registration lease (hit / expiry / base-URL change / account change); `initPush`
  idempotence and the mid-flight-login swallow; `askForNotificationsOnce` recording before the
  prompt; `refreshPermission`'s re-grant→re-register rule; `unregisterPush` step ordering;
  `drainPendingEvents` single-flight; **a drain with zero listeners** (VC-BUG-002).
- **`nativePush.parsePushMessage` — no tests.**
- **`pushRuntime.ts` — good coverage, three gaps.** (a) serialization of multiple queued actions —
  the current test at `:215` cannot fail for the reason it claims (VC-BUG-009); (b) `refreshIfExpiring`
  returning `rejected` — `mockRefreshSession` always resolves `'ok'`, so a wake window with a dead
  session is untested; (c) restart-after-`stopPushRuntime`.
- **`redact.ts` / `logger.ts` — no tests in scope.** No assertion that a token, phone number or
  message body cannot reach a sink — the enforcement point for two MOPS-1 reject criteria.
- **All Kotlin — no test source set.** Worth adding: `PushStore` queue atomicity (VC-BUG-008),
  `trimOldest` bounds, `appendLine`'s `MAX_LINE_CONVOS` self-eviction branch (`:260-270`),
  `PushAckClient` budget arithmetic, `showMessage`'s missing dedup guard (VC-BUG-007).
