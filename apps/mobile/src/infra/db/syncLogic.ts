/**
 * Pure sync/outbox decision logic (§L6) — NO database, NO React Native, NO I/O. Extracted
 * so the reconcile branch + retry-backoff schedule are unit-testable without a live DB
 * (the Jest env mocks the SQLite adapter, so any `getDatabase()`-touching code can't run in
 * a unit test). The thin DB writers in `outbox.ts` / `messages.ts` call these.
 */

/** What to do with an inbound server message given what we already hold locally. */
export type ReconcileAction = 'update' | 'skip' | 'insert';

/**
 * Reconcile decision (§L6): a server message is dedup'd first by `client_msg_id` (our own
 * echo/ack → UPDATE the optimistic row), then by `(conversation_id, seq)` (already have it →
 * SKIP), else it is new → INSERT. Server `seq` is the ordering + identity key (never ts).
 */
export function reconcileDecision(input: {
  hasClientMsgIdRow: boolean;
  hasSeqRow: boolean;
}): ReconcileAction {
  if (input.hasClientMsgIdRow) return 'update';
  if (input.hasSeqRow) return 'skip';
  return 'insert';
}

export interface BackoffOptions {
  /** first-retry delay before jitter (ms). */
  baseMs?: number;
  /** hard ceiling regardless of attempt (ms). */
  maxMs?: number;
  /** injectable RNG in [0,1) for deterministic tests; defaults to Math.random. */
  rand?: () => number;
}

const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 30000;

/**
 * Exponential backoff with FULL jitter, capped (§M8/§L4 reconnect + §L6 outbox retry).
 * The un-jittered ceiling for `attempt` (1-based) is `min(maxMs, baseMs * 2^(attempt-1))`;
 * the returned delay is uniformly random in `[ceiling/2, ceiling]` so a fleet of clients
 * doesn't reconnect in lockstep. `attempt <= 1` uses the base ceiling.
 */
export function backoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? DEFAULT_BASE_MS;
  const cap = opts.maxMs ?? DEFAULT_MAX_MS;
  const rand = opts.rand ?? Math.random;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const half = exp / 2;
  return Math.round(half + rand() * half);
}
