# Sync / DB / Realtime QA Audit — defect hunt

Read-only audit. Scope: `apps/mobile/src/infra/db/*`, `apps/mobile/src/domain/sync/**`,
`apps/mobile/src/infra/realtime/socket.ts`, their `__tests__`, plus the live backend at
`D:\Velchat` (`libs/feature-realtime/src/fabric/ws-fabric.ts`, `libs/feature-chat/src/chat/*`)
to settle contract questions rather than guess at them.

Confidence is marked on every finding:
- **[VERIFIED]** — traced end to end in the code (both sides where a contract is involved).
- **[SUSPECTED]** — the code path reads wrong but the interleaving needs a test to prove.

---

## 1. Testable seams (no device, no native module)

Jest here mocks the SQLite adapter and runs WatermelonDB on the Loki adapter, so both pure
helpers and DB writers are unit-testable. Two tiers:

### 1a. Pure — no DB, no RN, no I/O (fastest, highest leverage)

| Symbol | Location | Signature |
|---|---|---|
| `reconcileDecision` | `apps/mobile/src/infra/db/syncLogic.ts:16` | `({hasClientMsgIdRow: boolean, hasSeqRow: boolean}) => 'update'\|'skip'\|'insert'` |
| `backoffMs` | `apps/mobile/src/infra/db/syncLogic.ts:43` | `(attempt: number, opts?: {baseMs?, maxMs?, rand?: () => number}) => number` |
| `nextOutboxRetry` | `apps/mobile/src/infra/db/syncLogic.ts:60` | `(attempts: number, maxAttempts?: number) => {state: 'queued'\|'failed'}` |
| `MAX_SEND_ATTEMPTS` | `apps/mobile/src/infra/db/syncLogic.ts:53` | `const = 8` |
| `shouldProbeGap` | `apps/mobile/src/infra/db/gapDetection.ts:26` | `({localMax, incomingSeq, lastProbedFrom?}) => boolean` |
| `classifySendFailure` | `apps/mobile/src/infra/db/sendFailurePolicy.ts:33` | `(error: unknown, attempts: number) => {permanent, pauseDrain, cooldownMs}` |
| `mergeWatermark` | `apps/mobile/src/infra/db/receiptLedger.ts:49` | `(current: ReceiptWatermarks, patch: {delivered?, read?}) => ReceiptWatermarks` (returns the SAME ref when unchanged) |
| `pendingReceiptFrames` | `apps/mobile/src/infra/db/receiptLedger.ts:74` | `(desired, sent) => ReceiptFrame[]` |
| `parseReceiptFrame` | `apps/mobile/src/infra/db/receiptLedger.ts:121` | `(data: unknown, meId: string\|undefined, opts?: {selfChat?: boolean}) => InboundReceipt\|null` |
| `dmConversationId` | `apps/mobile/src/infra/db/dmId.ts:30` | `(a: string, b: string) => string` (throws on blank) |
| `normalizeSendAck` | `apps/mobile/src/infra/network/chat.ts:137` | `(raw: unknown) => SendAck` — **un-tested today; see D4** |
| `normalizeServerMessage` | `apps/mobile/src/infra/network/chat.ts:156` | `(raw: unknown) => ServerMessage\|null` — **un-tested today** |
| `isTypingActive` | `apps/mobile/src/core/realtimeStore.ts:46` | `(entry, now) => boolean` |
| `normalizePresenceStatus` | `apps/mobile/src/core/realtimeStore.ts:65` | `(raw: string) => PresenceStatus` |

`nextLocalStamp` (`infra/db/messages.ts:79`) and `newClientMsgId` (`infra/db/messages.ts:87`)
are pure-ish but carry **module-level mutable state** (`lastStamp`, `infra/db/messages.ts:84`)
that no `beforeEach` resets — worth a dedicated test file so ordering assertions elsewhere are
not order-dependent.

### 1b. DB writers (Loki adapter; `purgeAllLocalChat()` in `beforeEach`)

| Symbol | Location | Signature |
|---|---|---|
| `applyServerMessages` | `infra/db/messages.ts:182` | `(servers: ServerMessage[]) => Promise<void>` |
| `applyServerMessage` | `infra/db/messages.ts:335` | `(server: ServerMessage) => Promise<void>` |
| `markMessageSent` | `infra/db/messages.ts:344` | `(clientMsgId: string, ack: SendAck) => Promise<void>` |
| `markMessageFailed` | `infra/db/messages.ts:406` | `(clientMsgId: string) => Promise<void>` |
| `markMessageSending` | `infra/db/messages.ts:423` | `(clientMsgId: string) => Promise<void>` |
| `applyReceipt` | `infra/db/messages.ts:458` | `(conversationId, upToSeq: number, state: 'delivered'\|'read') => Promise<void>` |
| `maxSeqForConversation` | `infra/db/messages.ts:439` | `(conversationId) => Promise<number>` |
| `minSeqForConversation` | `infra/db/messages.ts:55` | `(conversationId) => Promise<number>` |
| `sendMessageLocal` | `infra/db/messages.ts:98` | `(conversationId, text, senderId) => Promise<string\|null>` |
| `enqueueOptimisticSend` | `infra/db/outbox.ts:106` | `(conversationId, text, senderId) => Promise<string\|null>` |
| `claimNextDue` | `infra/db/outbox.ts:183` | `(now: number) => Promise<OutboxItem\|null>` |
| `markAckd` | `infra/db/outbox.ts:244` | `(id: string) => Promise<void>` |
| `markFailed` | `infra/db/outbox.ts:261` | `(id, error: string, attempts: number, permanent?: boolean) => Promise<void>` |
| `recoverStuckSends` | `infra/db/outbox.ts:314` | `() => Promise<number>` |
| `requeueFailed` | `infra/db/outbox.ts:343` | `(clientMsgId: string) => Promise<boolean>` |
| `outboxStats` | `infra/db/outbox.ts:368` | `() => Promise<OutboxStats>` |
| `upsertConversation` | `infra/db/queries.ts:168` | `(conversationId, patch: ConversationPatch) => Promise<void>` |
| `clearUnread` | `infra/db/queries.ts:240` | `(conversationId) => Promise<void>` |
| `listConversationIds` | `infra/db/queries.ts:69` | `() => Promise<string[]>` |
| receipt store (MMKV) | `infra/db/receiptStore.ts:48,52,60,72,90,95,113,118,141,156` | `getDesired` / `getSent` / `noteDesired` / `noteSent` / `getPeerWatermark` / `notePeerWatermark` / `markDirty` / `takeDirty` / `reassertReceipts` / `clearAllReceipts` |

### 1c. Engine + transport seams

- `RealtimeSocket` — `infra/realtime/socket.ts:85`. Constructor takes the whole callback bag
  (`RealtimeSocketCallbacks`, `:60`); `connect(token, baseWsUrl)` (`:105`),
  `send(type, data): boolean` (`:152`), `sendEphemeral(type, fields): boolean` (`:171`),
  `close()` (`:184`), `get isActive` (`:97`). Already driven by a fake global `WebSocket` in
  `infra/realtime/__tests__/socket.test.ts` with `jest.useFakeTimers()` — the cheapest place to
  add close-code and watchdog cases.
- `syncEngine` singleton — `domain/sync/SyncEngine.ts:1545`. Public surface usable from a test:
  `start()` `:269`, `stop()` `:325`, `setPushAvailable(b)` `:225`, `setDisplayNameResolver(fn)`
  `:237`, `resyncNow()` `:652`, `reconcilePeerReceipts(id)` `:819`,
  `noteInboundDelivered(id, seq)` `:923`, `setActiveConversation(id|null)` `:933`,
  `flushOutboxNow()` `:1062`, `sendText(...)` `:1210`, `loadOlderMessages(id, page)` `:1237`,
  `markConversationRead(id)` `:1270`, `retrySend(cmid)` `:1286`, `sendTyping(id, state)` `:1300`,
  `activatePresence(id)` `:1461`, `deactivatePresence(id)` `:1495`, `getDiagnostics()` `:1515`.
- The existing harness in `domain/sync/__tests__/failureScenarios.test.ts:22-152` already fakes
  exactly three seams (socket, `fetchMessagesAfter`/`sendChatMessage`/`fetchPeerReceipts`,
  NetInfo) and exposes `mockSockets[].cb` so any inbound frame can be injected, plus
  `drop(code, reason)`. **Every new engine-level test below should extend that file rather than
  build a new harness.**
- `getDiagnostics()` (`:1515`) is the only window onto `draining` / `reconnectAttempts` /
  `outboxTimerActive`. It does **not** expose `authRefreshAttempts`, `outboxCooldownUntil`,
  `suspended`, or `gapProbedFrom`, which is why D8 and D14 below are hard to assert on today.

---

## 2. Defect candidates

### D1 — [VERIFIED] Two concurrent `applyServerMessages` calls duplicate every row in the overlap

- **Where:** `infra/db/messages.ts:202-232` (the dedup reads) vs `:234` (`db.write`).
- **Mechanism:** the dedup snapshot (`existingByClient`, `existingBySeq`, `existingConvs`) is
  fetched **outside** `db.write`. WatermelonDB serialises writers, so two calls that both read
  before either writes each conclude the rows are new and both `prepareCreate` them.
- **The codebase already knows this hazard.** `domain/sync/SyncEngine.ts:192-198` documents it
  verbatim for "load older" and guards it with the `loadingOlder` map
  (`SyncEngine.ts:1242-1249`). **No equivalent guard exists for `backfillConversation`**
  (`SyncEngine.ts:751`), `pageBackfill` (`:767`), `resyncAll` (`:677`) or the content-fill at
  `:957-967`.
- **Reachable interleavings (all real):**
  1. `onConnected` → `void this.resyncAll()` (`SyncEngine.ts:478`) starts paging conversation X;
     a live frame for X with a gap arrives → `onInboundMessage` → `shouldProbeGap` true →
     `await this.backfillConversation(X)` (`SyncEngine.ts:979`). Both issue
     `fetchMessagesAfter(X, sameCursor)` and both apply the same page. **N duplicate bubbles.**
  2. A flapping link: drop + reconnect fires `onConnected` twice; `resyncAll` has **no
     single-flight** (`resyncNow` at `:652` guards only against itself, via `pushResync`).
  3. Push wake: `resyncNow()` (`features/notifications/model/pushRuntime.ts:130`) racing
     `onConnected`'s `resyncAll()`.
  4. Contentless live frame: `applyServerMessage(m)` then `applyServerMessages(filled)`
     (`SyncEngine.ts:963`) racing a concurrent backfill of the same range.
- **Blast radius beyond duplicate messages:** for a conversation with no local row, both calls
  reach `convs.prepareCreate` with `c._raw.id = convId` (`messages.ts:311-312`) → two inserts on
  the same primary key → the second `db.batch` rejects → **the entire second batch of messages is
  lost**, logged only as `resync conversation failed` (`SyncEngine.ts:736`).
- **Existing coverage:** none. `failureScenarios.test.ts:413` ("does not duplicate when a whole
  catch-up is replayed") replays **sequentially**; `:1099` covers `loadOlderMessages` only.
- **Test to write:** hold `mockFetchAfter` on a deferred, fire `resyncNow()` and a gapped
  `onMessage` frame, release both, assert one row per seq.

### D2 — [VERIFIED] A duplicate `client_msg_id` inside one batch throws and discards the whole batch

- **Where:** `infra/db/messages.ts:250-266`, specifically `:257` `row.prepareUpdate(...)`.
- **Mechanism:** `byClientId` (`:222-225`) maps clientMsgId → row. The loop (`:237-290`) never
  records what it has already prepared, so two entries carrying the same `clientMsgId` resolve to
  the **same model** and call `prepareUpdate` twice. WatermelonDB's `Model.prepareUpdate` opens
  with `invariant(!this._preparedState, 'Cannot update a record with pending changes')`
  (verified in `node_modules/.pnpm/@nozbe+watermelondb@0.28.0/.../src/Model/index.js:126-129`),
  so the second call **throws synchronously inside `db.write`**.
- **Consequence:** the rejection propagates to the caller. From `pageBackfill` it is swallowed at
  `SyncEngine.ts:735-737` and the cursor is never advanced (recoverable next resync). From
  `onInboundMessage` it is swallowed at `SyncEngine.ts:1009-1011` (`apply inbound message
  failed`) — **that message, and every other message in the batch, silently never persists**
  until the next reconnect.
- **Reachability:** any server response (history page, or a merged batch) containing the same
  `clientMsgId` twice. The backend's idempotency is `(conversationId, clientMsgId)`
  (`docs/backend-integration-reference.md:75`), enforced by the send path — but nothing in the
  client validates the assumption, and the seq-allocation retry loop in
  `D:\Velchat\libs\feature-chat\src\chat\chat.service.ts:101-102` shows send can retry, so a
  double-insert is not unthinkable.
- **Symmetric hole in the other branch:** `bySeqKey` (`:226-232`) is likewise never updated
  inside the loop, so **two entries with the same `(conversationId, seq)` in one batch produce
  two INSERTed rows** — the classic duplicate. `fetchMessagesAfter`
  (`infra/network/chat.ts:288-305`) sorts but does **not** de-duplicate its input.
- **Existing coverage:** none for either direction.
- **Test to write:** `applyServerMessages([m(50), m(50)])` → expect 1 row;
  `applyServerMessages([{clientMsgId:'x',seq:1},{clientMsgId:'x',seq:2}])` → expect no throw and
  a sane single row.

### D3 — [VERIFIED] `applyReceipt` is a non-atomic read-modify-write → a blue tick can regress to grey

- **Where:** `infra/db/messages.ts:480-489` (the `fetch`) vs `:491-499` (the `db.write`).
- **Mechanism:** monotonicity is enforced **only by the query predicate**
  `Q.where('state', Q.oneOf(behind))` (`:487`), evaluated at fetch time, not at write time. Two
  concurrent calls each fetch, then each write, and the later write wins regardless of strength.
- **Precise interleaving:**
  1. `onInboundReceipt` (`SyncEngine.ts:1036`) → `applyReceipt(conv, 50, 'read')` — fetches rows
     in `{sending,sent,delivered}` with `seq <= 50`, gets row R (state `sent`). Not yet written.
  2. Before that write lands, `reconcilePeerReceipts` (`SyncEngine.ts:827`, fired `void` from
     `features/chat/hooks/useMessages.ts:79` on chat open) or `applyPeerWatermark`
     (`SyncEngine.ts:842`, awaited inside `pageBackfill`) → `applyReceipt(conv, 50, 'delivered')`
     — fetches rows in `{sending,sent}`, also gets R.
  3. Write A commits → `R.state = 'read'`. Write B commits → `R.state = 'delivered'`.
- **Result:** blue ticks fall back to double-grey and stay there until the next
  `reconcilePeerReceipts` happens to run with the opposite ordering.
- **Why the three callers genuinely race:** `onInboundReceipt` is invoked with `void`
  (`SyncEngine.ts:485`), `reconcilePeerReceipts` with `void` from the chat hook, and
  `applyPeerWatermark` from the backfill worker — no shared lock, no queue.
- **Note (sequential is safe):** applied one after another, the state predicate is a correct
  monotonic guard. That is exactly why the existing tests pass and miss this.
- **Existing coverage:** `__tests__/realtime-hardening.test.ts:288-324` and
  `failureScenarios.test.ts:989` both `await` each receipt in turn — **the interleaved case is
  not covered anywhere**.
- **Test to write:** start both `applyReceipt` calls without awaiting, `await Promise.all`,
  assert `state === 'read'`.

### D4 — [VERIFIED] A `SendAck` with a missing/unparseable `seq` stamps `seq = 0` and permanently breaks the message

- **Where:** `infra/network/chat.ts:140` `const seq = pickNum(d, 'seq') ?? 0;` feeding
  `infra/db/messages.ts:373` `m.seq = ack.seq;` (unconditional, no validation).
- **Scenario:** the send succeeds but the ack body is reshaped (envelope not unwrapped, a proxy
  strips the field, `seq` arriving as `null`). `ack.seq = 0`.
- **What happens, each verified against its own guard:**
  - `m.state` flips to `sent` (`:383`) so the user sees a tick — the message *looks* fine.
  - `maxSeqForConversation` filters `Q.where('seq', Q.gt(0))` (`:444`) → the reconnect cursor
    never accounts for it.
  - `applyReceipt` filters `Q.where('seq', Q.gt(0))` (`:485`) → **it can never be ticked again**.
  - `shouldProbeGap` is fed that same `localMax` (`SyncEngine.ts:949`) → gap detection is skewed.
  - the dup-destroy at `:356-361` looks for `seq === 0`, so the WS echo row carrying the real seq
    is **never collapsed** → a permanent duplicate bubble.
- **Existing coverage:** none — `normalizeSendAck` has no test file at all, and no test passes an
  ack without `seq`.
- **Fix shape (not applied):** reject `ack.seq <= 0` in `markMessageSent` and treat it as a
  transport failure so the idempotent retry can get a real seq.

### D5 — [VERIFIED] One 401/403 on the send path turns *every* queued message into a red bubble

- **Where:** `infra/db/sendFailurePolicy.ts:59-61` (`default:` → `permanent: true,
  pauseDrain: false`) + `domain/sync/SyncEngine.ts:1155-1161`.
- **Mechanism:** `infra/network/errors.ts:95-102` maps **401 and 403** to kind `auth`.
  `classifySendFailure` puts `auth` in the "the server rejected this specific message" bucket →
  `permanent: true`. Because `pauseDrain` is `false`, the walk loop at `SyncEngine.ts:1101`
  **continues to the next item**, which hits the same 401, and so on for the whole queue.
- **How a transient 401 reaches the engine:** `infra/network/client.ts:274-291` refreshes once on
  401 and retries; when the refresh itself could not reach the server the interceptor rejects
  with the original `auth` error — and its own comment (`client.ts:286-288`) says *"the session
  is still valid — surface a retryable error and let the user stay signed in."* The outbox policy
  does the opposite. This is the exact overnight-background shape: access token expired, refresh
  endpoint cold/unreachable, first drain on resume marks the entire backlog permanently failed.
- **403 is worse:** the backend fails membership checks closed (`ws-fabric.ts:252-256`:
  *"an unavailable membership service denies"*), so an infra blip is indistinguishable from
  "you are not a member" — and produces red bubbles the user must tap one by one.
- **Existing coverage:** `__tests__/sendFailurePolicy.test.ts:52-60` **asserts**
  `auth → permanent`. The current behaviour is encoded in a test, so this is a policy decision to
  revisit, not a regression. Recommend splitting `auth` by `statusCode` / `AppError.retryable`
  (`infra/network/errors.ts:44-46`) rather than by kind.

### D6 — [VERIFIED] Migration-v3's composite indexes never exist on a fresh install

- **Where:** `infra/db/migrations.ts:46-77` (five `unsafeExecuteSql` `CREATE INDEX` steps) vs
  `infra/db/schema.ts:12` (`version: 3`).
- **Mechanism:** WatermelonDB runs migrations **only** for an existing database at an older
  version. `SQLiteAdapter._init`
  (`node_modules/.pnpm/@nozbe+watermelondb@0.28.0/.../src/adapters/sqlite/index.js:136-152`)
  branches on the native `initialize` result: an empty DB returns `schema_needed` →
  `_setUpWithSchema` (`:199`) → only `_encodedSchema()`. `encodeSchema`
  (`adapters/sqlite/encodeSchema/index.js:22`) emits **one single-column index per `isIndexed`
  column** and nothing else.
- **Consequence:** every **new** user runs without `conversations_list_idx`,
  `messages_window_idx`, `messages_conv_seq_idx`, `messages_receipt_idx` and `outbox_due_idx`.
  Only users who upgraded from v1/v2 have them — i.e. exactly the inverse of what you want. The
  migration's own docstring (`migrations.ts:36-41`) explains that these queries are WatermelonDB
  subscriptions re-run on **every** write to their table, synchronously on the JS thread, so the
  missing indexes land directly on frame time while messages arrive on a 3 GB Android 10 device.
- **Existing coverage:** `__tests__/migrations.test.ts:43-53` asserts the migration **declares**
  the index SQL. It cannot and does not assert a fresh install has it.
- **Fix shape (not applied):** also emit the composite indexes on fresh setup (a post-setup
  `unsafeExecuteSql`, or a WatermelonDB `unsafeSql` schema hook), and test by asserting against
  `sqlite_master` on a freshly-created DB.

### D7 — [VERIFIED] `reassertReceipts()` on every connect emits an unbounded receipt burst the gateway silently drops

- **Where:** `infra/db/receiptStore.ts:141-153` called from `domain/sync/SyncEngine.ts:474`
  (`onConnected`), then `flushReceipts()` at `:477` / `:890-911`.
- **Mechanism:** `reassertReceipts` **deletes every `rcpt.sent.*` key** and marks every
  conversation with a non-zero desired watermark dirty. `flushReceipts` then walks **all** of
  them in one synchronous tick, emitting up to two frames per conversation, with no chunking, no
  pacing and no cap.
- **The wall it hits (verified on the backend):** `ws-fabric.ts:57`
  `DEFAULT_INBOUND_PER_SECOND = 40` and `ws-fabric.ts:165-168` — over budget, the frame is
  **dropped and only warn-logged**, with no signal to the client. `receiptLedger.ts:7-9` states
  the consequence itself: exceeding it *"takes the `read` and `sync` frames down with it."*
- **So on a flaky link with a few hundred conversations, every reconnect self-inflicts the exact
  backpressure the ledger was designed to avoid**, and `noteSent` (`SyncEngine.ts:904`) records
  the dropped frames as sent because `socket.send()` returned true (it only checks `readyState`,
  `socket.ts:152-162`).
- **Aggravating factor:** each `delivered`/`read` frame costs the backend a membership lookup
  (`ws-fabric.ts:204` → `mayAct`), so the burst is expensive on both ends.
- **Existing coverage:** `__tests__/receiptReassert.test.ts` covers the ledger semantics with 1-3
  conversations; nothing tests the flush volume or a per-tick cap.
- **Test to write:** 200 conversations with desired watermarks, one `onConnected`, assert the
  frames emitted in a single tick stay under a documented cap.

### D8 — [VERIFIED] A `sending` outbox row orphaned mid-session wedges its conversation until the app restarts

- **Where:** `infra/db/outbox.ts:368-381` (`outboxStats` queries **only** `state = 'queued'`) +
  `domain/sync/SyncEngine.ts:1183` (`if (stats.queued === 0) return;` — no timer armed) +
  `SyncEngine.ts:275` (`recoverStuckSends` runs **once**, at `start()`).
- **Mechanism:** `claimNextDue` refuses a second item while any row in that conversation is
  `sending` (`outbox.ts:203`, `:212`). If a claimed row is never resolved, nothing re-claims it
  (`recoverStuckSends`'s own docstring at `:304-313` says it must run when nothing is genuinely
  in flight, i.e. only at start), **and** `outboxStats` reports `queued: 0`, so `scheduleOutbox`
  arms no timer. The conversation's queue is dead for the rest of the process.
- **Ways to orphan a row without a process kill:** `markAckd` (`SyncEngine.ts:1138`) or
  `markMessageSent` (`:1137`) throwing is caught by the send-failure `catch` at `:1150`, which
  calls `markFailed`; if **that** throws too, the exception escapes the `for` loop into the outer
  `try`, the `finally` (`:1164-1170`) ends the walk, and the row stays `sending` with no
  recovery path until relaunch.
- **Existing coverage:** `realtime-hardening.test.ts:110-143` covers the restart path only.
  Nothing covers an in-session orphan, and nothing asserts `outboxStats` sees `sending` rows.
- **Fix shape (not applied):** count `sending` in `outboxStats` (or add a lease/`stuckSince`
  reaper) so the self-adjusting timer keeps waking.

### D9 — [VERIFIED] The unread badge climbs, and the read watermark stalls, for messages that arrive via backfill into the open chat

- **Where:** `infra/db/messages.ts:301`
  (`if (b.unread > 0) c.unreadCount = (c.unreadCount ?? 0) + b.unread;`) vs
  `domain/sync/SyncEngine.ts:786-794` (`pageBackfill` calls **only** `noteDelivered`).
- **Mechanism:** the live path handles the active conversation correctly —
  `SyncEngine.ts:1001-1008` calls `noteRead` **and** `clearUnread`. The **REST backfill path does
  neither**: it inserts rows (each bumping `unread_count`), notes `delivered`, and stops.
  `markConversationRead` only fires from `features/chat/hooks/useMessages.ts:70`, whose effect
  deps are `[conversationId, meId, limit]` — mount and window-growth only.
- **User-visible result:** reconnect while sitting in a chat (or a push-triggered `resyncNow`) →
  the badge on the chat you are staring at climbs by the page size, and the **peer's ticks stay
  double-grey** for everything that came in over REST until you navigate away and back.
- **Existing coverage:** `failureScenarios.test.ts:813` ("does not climb on the conversation the
  user is looking at") drives the **live frame** path only. The backfill path is untested.
- **Test to write:** `setActiveConversation(X)`, seed server history, force a reconnect, assert
  `unreadCount === 0` and that a `read` frame was emitted with the backfilled max seq.

### D10 — [VERIFIED] "Load older" dead-ends permanently on a deletion hole wider than one page

- **Where:** `domain/sync/SyncEngine.ts:1251-1263`.
- **Mechanism:** `from = Math.max(0, oldest - 1 - page)` then
  `fetchMessagesAfter(conversationId, from, page)`, then `fresh = older.filter(m => m.seq <
  oldest)` and `if (fresh.length === 0) return false;`. The UI treats `false` as "nothing older
  exists" (`features/chat/hooks/useMessages.ts:55` only grows the window on `true`).
- **Why the hole is real, not hypothetical:** the backend's history query filters
  `deleted: false` (`D:\Velchat\libs\feature-chat\src\chat\chat.repository.ts:130`), so deleted
  messages leave **permanent** seq gaps — which is precisely the premise `gapDetection.ts:10-14`
  is built on. If the window `(oldest - 1 - page, oldest)` contains only deleted messages, the
  page returned starts at or above `oldest`, `fresh` is empty, and the user can never reach the
  history behind the hole.
- **Existing coverage:** `failureScenarios.test.ts:1072` ("walks back page by page with no
  duplicates, no holes") uses contiguous history; `:1093` covers the legitimate end-of-history
  case. The gap case is untested.
- **Fix shape (not applied):** when `fresh` is empty but `older` is non-empty, step `from`
  further back and retry (bounded), instead of reporting end-of-history.

### D11 — [VERIFIED by grep] There is no `event_id` LRU dedup anywhere

- **Mandate (§M8/§L4):** "event_id LRU dedup in MMKV".
- **Reality:** `grep -rn "event_id|eventId|lru|LRU"` across `infra/realtime`, `domain/sync` and
  `infra/db` returns exactly **one hit — a doc comment** (`infra/realtime/socket.ts:7`).
  `handleRaw` (`socket.ts:190-238`) never reads `event_id`; no MMKV LRU exists.
- **Consequence:** message dedup rests entirely on `(conversationId, seq)` in
  `applyServerMessages`, which D1 and D2 show is not airtight. `receipt` and `typing` frames have
  **no dedup at all** — harmless today because both are idempotent, but it means a duplicate
  `receipt` frame re-runs the racy `applyReceipt` (D3), which is not harmless.

### D12 — [VERIFIED absent] Stuck detection (cursor lag > 500 events, or > 30 s in LIVE) is not implemented

- **Mandate:** "cursor lag > 500 events or > 30 s LIVE → targeted resync."
- **Reality:** nothing in `SyncEngine.ts` tracks a server-reported cursor against the local one,
  and no timer exists for a LIVE-state staleness check. The only watchdog is the transport-level
  one in `socket.ts:245-251` (60 s of no inbound frames → close), which detects a **dead socket**,
  not a **healthy socket that is behind**. `socket.ts:209-210` deliberately ignores the server's
  `sync` echo, which is the one frame that could carry a server cursor.
- **Consequence:** a socket that stays open while fan-out silently stops delivering is only
  repaired by a reconnect, a push, or a user-driven gap probe.

### D13 — [VERIFIED] `MAX_SEND_ATTEMPTS` / `nextOutboxRetry` is unreachable from the engine — retries never exhaust

- **Where:** `infra/db/outbox.ts:281-286` — `nextOutboxRetry(attempts)` is consulted **only when
  `permanent === undefined`**. `SyncEngine.ts:1156` always passes an explicit boolean
  (`decision.permanent`), and `classifySendFailure` returns `permanent: false` for every
  transport-ish failure (`sendFailurePolicy.ts:40,47,54,58`), including an unrecognised throw.
- **Consequence:** a message can retry **forever** (capped at 30 s per attempt via `backoffMs`'
  `DEFAULT_MAX_MS`, `syncLogic.ts:35`). That is deliberate per `sendFailurePolicy.ts:5-8`
  ("WhatsApp keeps the clock icon indefinitely") but it means the mandate's "retryable backoff,
  permanent → surface retry UI" threshold **never fires**, and
  `__tests__/syncLogic.test.ts:96-113` is testing dead code.
- **Action:** either delete `MAX_SEND_ATTEMPTS`/`nextOutboxRetry` and its tests, or reintroduce a
  ceiling. Do not leave a tested threshold that production cannot reach.

### D14 — [VERIFIED] Two 4001s kill realtime for the rest of the session, and foreground cannot heal it

- **Where:** `SyncEngine.ts:541-546` (budget check) vs `:460-462` (reset on a successful open)
  and `:413-419` (reset on `onSessionEstablished`).
- **Mechanism:** `authRefreshAttempts` is reset **only** when a socket actually opens or a fresh
  sign-in occurs. Once `>= MAX_AUTH_REFRESH_ATTEMPTS` (2, `:91`), `recoverFromUnauthorized`
  returns immediately and **no reconnect is scheduled**. `onForeground` (`:397-405`) does call
  `connect()`, which will 4001 again and bounce straight back out of the exhausted budget.
- **Consequence:** a device whose refresh is briefly broken (clock skew, a cold auth service
  answering 401 twice) has no realtime — no messages, no ticks, no presence — until force-quit.
  The docstring at `:529-538` describes precisely the failure mode this reintroduces.
- **Existing coverage:** no test injects close code 4001 at all.

### D15 — [VERIFIED] Ordering key is `created_at`, not `seq` — a device clock ahead of the server mis-orders the chat

- **Where:** `infra/db/messages.ts:34` `Q.sortBy('created_at', Q.desc)` and `:381`
  `if (ack.serverTs > m.createdAt) m.createdAt = ack.serverTs;`.
- **Mechanism:** the mandate and `docs/backend-integration-reference.md:75` both say sort by
  `seq`, never timestamp. The window query sorts by `created_at`. For an own send `created_at`
  starts as a **local** `nextLocalStamp()` (`outbox.ts:124`, `:147`) and is only re-stamped to
  `serverTs` **when it moves forward** (a deliberate guard against a skewed *server* clock). With
  the *device* clock hours ahead, the guard keeps the future local stamp, so that message sits
  above every subsequent inbound message (whose `created_at` is the server's `sent_at`,
  `messages.ts:284`) **permanently** — and past a window's worth, the peer's replies fall outside
  the loaded 50 (`messages.ts:16`).
- **Second-order:** `nextLocalStamp`'s `lastStamp` (`messages.ts:84`) is process-local, so a
  backward system-clock jump across a relaunch produces a new message with a **smaller**
  `created_at` than older ones — it renders below them.
- **Existing coverage:** `__tests__/messageOrdering.test.ts:73` covers the never-move-backwards
  guard (the mechanism), not the skew consequence. No test sets a device clock ahead of the
  server.

### D16 — [VERIFIED] Every contentless live frame costs a 100-row REST round-trip

- **Where:** `SyncEngine.ts:957-967` —
  `fetchMessagesAfter(m.conversationId, Math.max(0, m.seq - 1))` with the **default limit of
  100** (`infra/network/chat.ts:291`).
- **Mechanism:** live fan-out frames are metadata-only unless the message is server-readable, so
  for an E2EE conversation `m.content` is always undefined and **every single inbound message**
  triggers a 100-row fetch-and-apply on the receive path. It should ask for `limit: 1`.
- **Compounding:** each of those `applyServerMessages` calls is another racer for D1.

### D17 — [VERIFIED] A `typing.stopped` from any member wipes the whole conversation's typing indicator

- **Where:** `SyncEngine.ts:1323-1326` —
  `if (state === 'stop') { this.clearTyping(conversationId); return; }`, discarding the `userId`
  it just parsed at `:1314-1321`.
- **Mechanism:** the store holds one entry per conversation (`core/realtimeStore.ts:87`
  `ReadonlyMap<string, TypingEntry>`), so in a group B's `stop` erases A's live indicator, and
  `clearTyping` (`:1344-1351`) also cancels A's TTL timer — so it stays gone until A's next
  `typing.started` refresh (up to 5 s of wrong state, `TYPING_TTL_MS`).
- Related, lower: the TTL timer map is keyed by **conversation** (`:210-213`) while the store
  entry carries a **user**, so a second typer replaces the first typer's expiry deadline.

### D18 — [SUSPECTED, low] `client_msg_id` lookups are not scoped by conversation

- **Where:** `infra/db/messages.ts:204` (`Q.where('client_msg_id', Q.oneOf(clientIds))`),
  `:222-224` (map keyed by clientMsgId alone), `:238-241`; and `markMessageSent`'s `:351-353`.
- **Mechanism:** `newClientMsgId()` (`:87-89`) is `m_<base36 ms>_<6 base36 random>`, so a
  collision is very unlikely — but the queries make a cross-conversation match *possible*, and
  the effect would be stamping a foreign `seq` onto a row in another chat (and `markMessageSent`
  picking `mine[0]` arbitrarily). Cheap to close: add `Q.where('conversation_id', ...)`.

### D19 — [VERIFIED, low] `claimNextDue` halts a whole drain pass on one corrupt row

- **Where:** `infra/db/outbox.ts:216-223` — an unparseable payload is destroyed and the function
  returns `null`, which `walkOutbox` reads as "nothing claimable" (`SyncEngine.ts:1126-1129`) and
  breaks the loop, even though other conversations have due items. Self-heals on the next timer
  (`scheduleOutbox` still sees `queued > 0`), so this is a latency defect, not a loss.

### D20 — [VERIFIED, low] `enqueueSend` is dead production code, and the biggest test suite exercises only it

- **Where:** `infra/db/outbox.ts:70-92`. `grep` shows call sites in `infra/db/index.ts:36` /
  `infra/index.ts:88` (re-exports) and `__tests__/realtime-hardening.test.ts` only. Production
  sends go through `enqueueOptimisticSend` (`:106`).
- **Why it matters:** `enqueueSend` stamps `createdAt = Date.now()` (`:86`) while
  `enqueueOptimisticSend` deliberately uses the monotonic `nextLocalStamp()` (`:124`, `:156`) —
  and `claimNextDue`'s head-of-line test compares `createdAt` **by value** (`:212`
  `oldestByConv.get(conv) === o.createdAt`). So the entire 363-line `realtime-hardening.test.ts`
  FIFO/ordering suite validates a path the app does not use, on the tie-prone stamp the app
  deliberately avoids. Either delete `enqueueSend` or point that suite at
  `enqueueOptimisticSend`.

---

## 3. Things I checked and found NOT broken (so nobody "fixes" them)

- **Receipt frame envelope.** `socket.ts:164-170` claims the gateway *"does NOT unwrap a `data`
  envelope for INBOUND frames"*, which would mean `flushReceipts`' nested
  `send(state, {conversationId, seq})` (`SyncEngine.ts:899`) never registers. **That comment is
  stale.** `D:\Velchat\libs\feature-realtime\src\fabric\ws-fabric.ts:176-178` reads
  `const d = msg.data && typeof msg.data === 'object' ? msg.data : msg;` and its own comment says
  it accepts both shapes. Receipts work. Recommend correcting the comment only.
- **The receipts REST route.** `docs/backend-integration-reference.md:79` says "No REST receipt
  endpoint", but `fetchPeerReceipts` (`infra/network/chat.ts:252`) calls
  `GET /chat/conversations/:id/receipts`, which **exists**
  (`D:\Velchat\libs\feature-chat\src\chat\chat.controller.ts:58-71`) and returns exactly the
  camelCase `{userId, state, upToSeq, at}` the client parses
  (`D:\Velchat\libs\feature-chat\src\chat\receipts.repository.ts:15-20, 53-66`). The doc line is
  stale, not the code.
- **`db.batch(array)` in `recoverStuckSends`** (`outbox.ts:324`) — inconsistent with the spread
  form used everywhere else, but valid: `Database.batch` normalises via `fromArrayOrSpread`
  (`.../src/Database/index.js:102-103`).
- **Backfill page size.** `BACKFILL_PAGE = 100` (`SyncEngine.ts:111`) matches the server's clamp
  `Math.min(Math.max(limit, 1), 100)` (`chat.service.ts:106`), so the "a full page means there is
  more" paging rule at `SyncEngine.ts:797` is sound.
- **No client `{type:'sync',cursor}` frame.** `resyncAll` deliberately dropped it
  (`SyncEngine.ts:673-675`) against §4's contract. Confirmed harmless: the gateway only echoes
  the cursor (`ws-fabric.ts:192-197`).
- **`frameKind` labels `delivered`/`read` as durable** (`socket.ts:82`) while §4 classifies
  receipts as ephemeral. The inbound path ignores `kind` entirely (`ws-fabric.ts:180`), so this
  is cosmetic today — but it means the mandate's "backpressure drops only ephemeral" invariant is
  not actually expressible from the client side.
- **Sequential receipt application is monotonic** — see D3's note. The state predicate is a
  correct guard as long as calls do not interleave.
- **Send is never auto-retried by the HTTP layer.** `POST` is excluded from the
  idempotent-replay set (`infra/network/client.ts:299-304`), so retry policy lives solely in the
  outbox. Correct.
- **Migration coverage / no version holes** — `migrations.ts` declares 2 and 3 against
  `schema.version = 3`, and `migrations.test.ts:27-42` guards it. Correct (the gap is D6, which
  is about fresh installs, not the declaration).

---

## 4. Coverage gaps — the brief's list, scored

| Scenario | Covered today? | Nearest existing test | Gap |
|---|---|---|---|
| Duplicate ack (same `clientMsgId` acked twice) | **No** | `realtime-hardening.test.ts:147` acks once after a retry | Call `markMessageSent(cmid, ack)` twice with the same seq, and once with a *different* seq; assert one row, no state regression |
| Out-of-order ack | **No** | — | Ack seq 12 then seq 11 for two sends in one conversation; assert neither row's seq / `created_at` regresses |
| Delayed ack (ack arrives after the WS echo already inserted a row) | Partially | `realtime-hardening.test.ts:328`, `failureScenarios.test.ts:493` | Both drive echo→ack. **Missing:** ack→echo, and echo→ack where the echo carries **no** `clientMsgId` **and** the ack is late enough that the peer's receipt landed first |
| Receipt regression (read, then a late delivered) | Sequential only | `realtime-hardening.test.ts:288`, `failureScenarios.test.ts:989` | **D3**: the interleaved (non-awaited) case is untested and is where the bug lives |
| Cumulative `up_to_seq` | Yes, at both layers | `receiptLedger.test.ts:30`, `failureScenarios.test.ts:907` | Add: `up_to_seq` beyond the local max (rows not yet backfilled) then backfill — `receiptRace.test.ts:50` covers the ack variant, not the backfill variant |
| Reconnect replay dedupe | Sequential only | `failureScenarios.test.ts:381,413` | **D1**: no test runs two applies concurrently; no test replays a batch containing an internal duplicate (**D2**) |
| Gap detection after a missed seq | Pure fn only | `gapDetection.test.ts` (7 cases) | No engine-level test: inject a gapped live frame and assert exactly one `fetchMessagesAfter` probe, that the hole is filled, and that a *second* gapped frame from an unmoved cursor does **not** re-probe |
| Outbox retry / backoff exhaustion | Pure fn only, and **unreachable in production** | `syncLogic.test.ts:96` | **D13**: decide whether a ceiling exists at all; today `classifySendFailure` guarantees it never triggers |
| Restart with a pending outbox | Yes | `realtime-hardening.test.ts:110`, `failureScenarios.test.ts:654,692`, `restart.test.ts` | **Missing (D8):** an *in-session* orphaned `sending` row, and `outboxStats` blindness to it |
| Clock skew / timestamp ordering | Backwards guard only | `messageOrdering.test.ts:43,64,73` | **D15**: no test with the device clock **ahead** of the server; no test of `nextLocalStamp` across a simulated backward clock jump |
| Concurrent send from two devices | Own-echo only | `realtime-hardening.test.ts:328` | No test where device B's message interleaves device A's optimistic send at an adjacent seq, nor where A's own echo arrives while A's send is still in flight |
| WS close 4001 vs 4000 | **No** | `socket.test.ts:69,108` report 4000 from the transport; nothing asserts the engine's branch | Assert: 4001 → refresh + reconnect; 4001 twice → **stays dead** (**D14**, decide if intended); 4000/1001 → jittered backoff reconnect; `lastCloseAt` set once per outage (`SyncEngine.ts:505-507`) |
| Watchdog | Transport only | `socket.test.ts:108` | Covered for "opened socket goes silent". **Missing:** the ping timer actually fires at 25 s; `lastRxAt` refresh on a `pong` prevents a false positive; and there is **no** cursor-lag watchdog to test (**D12**) |

### Additional untested surfaces found while reading

- `normalizeSendAck` and `normalizeServerMessage` (`infra/network/chat.ts:137`, `:156`) have
  **no test file**. They are the entire defence against casing/shape drift, and D4 lives in the
  first one.
- `reconcilePeerReceipts` (`SyncEngine.ts:819`) ordering — the durable store returns rows in
  Mongo order and they are applied in that order. Safe today (D3's note) but undefended by a test.
- `scheduleSuspend` / `setPushAvailable` (`SyncEngine.ts:592`, `:225`) — the §M13 background
  contract has no test: no assertion that the socket is released, that `flushReceipts` runs
  **before** release (`:603`), or that losing push wakes the engine back up.
- `flushReceipts` treating `socket.send() === true` as "the peer knows" (`:903-904`) when the
  gateway may have dropped the frame over budget (D7).
- `getDiagnostics()` does not expose `authRefreshAttempts`, `outboxCooldownUntil`, `suspended` or
  `gapProbedFrom`, which makes D8 and D14 awkward to assert. Consider widening it
  (test-visibility only, no behaviour change).

---

## 5. Suggested test-writing order (highest value first)

1. **D3** — concurrent `applyReceipt`, both states, one conversation. Small, deterministic,
   proves a user-visible tick regression.
2. **D2** — `applyServerMessages` with an internal duplicate (both by seq and by `clientMsgId`).
   Two `expect`s; the `clientMsgId` case currently **throws**.
3. **D4** — `markMessageSent` with `ack.seq = 0`.
4. **D1** — concurrent backfill, via the `failureScenarios.test.ts` harness with a deferred
   `mockFetchAfter`. The most impactful and the most work.
5. **D14 / close codes** — cheap to add to `socket.test.ts` + `failureScenarios.test.ts`
   (`drop(4001, ...)` already exists on the mock).
6. **D9** — unread + read watermark on the backfill path into the active conversation.
7. **D8** — in-session orphaned `sending` row; assert `outboxStats` and that the queue recovers.
8. **D10** — load-older across a deletion hole wider than one page.
9. **D15** — device clock ahead of the server.
10. **D6** — assert a freshly-created DB carries the composite indexes (query `sqlite_master`).
