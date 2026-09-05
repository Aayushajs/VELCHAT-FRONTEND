/**
 * Chat REST surface (§L6/§L7) — send + history-cursor backfill against chat-service via
 * the gateway (`/chat*`). Two calls only, both cursor/idempotency-safe:
 *   - `sendChatMessage` → POST /chat/messages, idempotent by (conversationId, clientMsgId),
 *     so the outbox worker can retry the SAME clientMsgId forever and never dup a row.
 *   - `fetchMessagesAfter` → GET /chat/conversations/:id/messages?afterSeq= — THE missed-
 *     event sync endpoint. Always ordered by `seq` (never timestamp), per the backend.
 *
 * The backend returns rows in whatever casing the service emits (snake for DB rows, camel
 * for DTOs); we normalise defensively — same pattern as features/user/api/profileShape.ts —
 * so a casing drift never silently yields `undefined` ids/seqs.
 */
import { api } from './client';

/** POST /chat/messages body. `content` is a string (text) or an object (rich/structured). */
export interface SendMessageInput {
  conversationId: string;
  senderId: string;
  /** client-generated idempotency key; the send is idempotent by (conversationId, clientMsgId). */
  clientMsgId: string;
  type?: string;
  content: string | Record<string, unknown>;
  replyTo?: string;
  threadRoot?: string;
  mentions?: string[];
  tenantId?: string;
  encrypted?: boolean;
}

/** SendAck — the server's authoritative id + ordering key for a sent message. */
export interface SendAck {
  messageId: string;
  seq: number;
  serverTs?: number;
}

/**
 * A server message row (history + WS `message` frame `data`). Normalised to camelCase.
 * `seq` is the ordering + identity key. `clientMsgId` is read defensively — the WS
 * `MessageSentPayload` may omit it, in which case own-echo dedup falls back to `seq`.
 */
export interface ServerMessage {
  messageId: string;
  conversationId: string;
  seq: number;
  senderId: string;
  clientMsgId?: string;
  type: string;
  /** plaintext body (enterprise/server-readable); undefined for E2EE/opaque payloads. */
  content?: string;
  serverTs?: number;
  replyToId?: string;
}

// ── defensive readers (snake|camel) ──────────────────────────────────────────
function rec(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function pickStr(
  d: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function pickNum(
  d: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (
      typeof v === 'string' &&
      v.trim() !== '' &&
      Number.isFinite(Number(v))
    ) {
      return Number(v);
    }
  }
  return undefined;
}

/** Like pickNum but also parses ISO 8601 date strings (backend sends `sent_at` as ISO). */
function pickTimestamp(
  d: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
      const ts = Date.parse(v);
      if (Number.isFinite(ts)) return ts;
    }
  }
  return undefined;
}

/**
 * Pull a display string out of a `content` field that may be a string OR an object.
 *
 * `MessageSentPayload.content` is typed `string | Record<string, unknown>`, and the object form is
 * what a structured message (and some clients' text) arrives as. Accepting only the string form
 * meant those frames read as "no body", which sent the engine off to REST to re-fetch a message it
 * had already received in full — an extra round-trip on the receive path for every such message,
 * exactly where latency is most visible.
 */
function pickContent(d: Record<string, unknown>): string | undefined {
  const text = pickStr(d, 'text', 'content_plain', 'contentPlain');
  if (text !== undefined) return text;
  const content = d.content;
  if (typeof content === 'string' && content.length > 0) return content;
  if (content && typeof content === 'object') {
    // Structured body — take the first field that actually carries display text.
    const inner = pickStr(
      content as Record<string, unknown>,
      'text',
      'body',
      'caption',
      'content',
    );
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/** Normalise a SendAck; `seq` is required, missing/NaN → 0 (never a silent undefined key). */
export function normalizeSendAck(raw: unknown): SendAck {
  const d = rec(raw);
  const messageId = pickStr(d, 'messageId', 'message_id', 'id') ?? '';
  const seq = pickNum(d, 'seq') ?? 0;
  const serverTs = pickTimestamp(
    d,
    'serverTs',
    'server_ts',
    'sent_at',
    'sentAt',
  );
  return {
    messageId,
    seq,
    ...(serverTs !== undefined ? { serverTs } : {}),
  };
}

/** Normalise a server message row; returns null when it lacks the ordering key (`seq`). */
export function normalizeServerMessage(raw: unknown): ServerMessage | null {
  const d = rec(raw);
  const seq = pickNum(d, 'seq');
  const conversationId = pickStr(d, 'conversationId', 'conversation_id');
  if (seq === undefined || conversationId === undefined) return null;
  const messageId =
    pickStr(d, 'messageId', 'message_id', 'id') ??
    `srv_${conversationId}_${seq}`;
  const senderId =
    pickStr(
      d,
      'senderId',
      'sender_id',
      'senderAccountId',
      'sender_account_id',
    ) ?? '';
  const clientMsgId = pickStr(d, 'clientMsgId', 'client_msg_id');
  const type = pickStr(d, 'type') ?? 'text';
  const content = pickContent(d);
  const serverTs = pickTimestamp(
    d,
    'serverTs',
    'server_ts',
    'sent_at',
    'sentAt',
  );
  const replyToId = pickStr(
    d,
    'replyToId',
    'reply_to_id',
    'replyTo',
    'reply_to',
  );
  return {
    messageId,
    conversationId,
    seq,
    senderId,
    type,
    ...(clientMsgId !== undefined ? { clientMsgId } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(serverTs !== undefined ? { serverTs } : {}),
    ...(replyToId !== undefined ? { replyToId } : {}),
  };
}

/**
 * Build the wire body, only including OPTIONAL keys when defined
 * (`exactOptionalPropertyTypes` — an explicit `undefined` would serialise to `null`).
 */
function toSendBody(input: SendMessageInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    conversationId: input.conversationId,
    senderId: input.senderId,
    clientMsgId: input.clientMsgId,
    content: input.content,
  };
  if (input.type !== undefined) body.type = input.type;
  if (input.replyTo !== undefined) body.replyTo = input.replyTo;
  if (input.threadRoot !== undefined) body.threadRoot = input.threadRoot;
  if (input.mentions !== undefined) body.mentions = input.mentions;
  if (input.tenantId !== undefined) body.tenantId = input.tenantId;
  if (input.encrypted !== undefined) body.encrypted = input.encrypted;
  return body;
}

/**
 * Send a message (§L6 outbox drain). Idempotent by (conversationId, clientMsgId): a retry
 * of the same clientMsgId returns the SAME `seq`/`messageId`, so a mid-send crash + relaunch
 * never produces a duplicate row. Rejects an `AppError` (the axios layer normalises).
 */
export async function sendChatMessage(
  input: SendMessageInput,
): Promise<SendAck> {
  const res = await api.post('/chat/messages', toSendBody(input));
  return normalizeSendAck(res.data);
}

/**
 * Backfill missed messages for one conversation after `afterSeq` (§L6 reconnect path).
 * THE no-loss backstop behind best-effort WS push. Rows are returned ordered by `seq`
 * ascending (we re-sort defensively; never trust wire order or timestamps).
 */
export async function fetchMessagesAfter(
  conversationId: string,
  afterSeq: number,
  limit = 100,
): Promise<ServerMessage[]> {
  const capped = Math.max(1, Math.min(100, limit));
  const res = await api.get(
    `/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    { params: { afterSeq, limit: capped } },
  );
  const rows: unknown[] = Array.isArray(res.data) ? res.data : [];
  const out: ServerMessage[] = [];
  for (const row of rows) {
    const m = normalizeServerMessage(row);
    if (m) out.push(m);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
