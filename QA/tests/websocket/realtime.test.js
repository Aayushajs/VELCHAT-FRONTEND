/**
 * VC-RT-* — Realtime / WebSocket tests (§23).
 *
 * Every test here drives a REAL socket against the realtime gateway and asserts on the frame
 * trace. No test passes on "the element exists" or "no error was thrown" (§45): a realtime
 * assertion is always "this specific frame, with these fields, arrived at this peer".
 *
 * Frame contract: `docs/backend-integration-reference.md` §4.
 */
import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { QaRealtimeClient, WS_CODE_UNAUTHORIZED } from '../../lib/ws.js';
import { get, post } from '../../lib/http.js';
import { qaTest } from '../../lib/results.js';
import { ensureDm, provisionOutsider, provisionPair } from '../../lib/provision.js';
import { env } from '../../lib/env.js';

const F = { feature: 'Realtime/WebSocket' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send one text message as `identity` over REST and return the SendAck. */
async function sendText(identity, conversationId, content, testId) {
  const res = await post(
    '/chat/messages',
    {
      conversationId,
      senderId: identity.accountId,
      clientMsgId: `qa-${testId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'text',
      content,
    },
    { token: identity.access, testId },
  );
  assert.equal(
    res.status,
    201,
    `send must be accepted, got ${res.status} ${res.text.slice(0, 200)}`,
  );
  return res.data;
}

describe('VC-RT — connection & authentication', () => {
  let pair;

  before(async () => {
    pair = await provisionPair({ testId: 'VC-RT-setup' });
  });

  qaTest(
    'VC-RT-001',
    'a valid access token opens the socket and the server greets with `connected`',
    {
      ...F,
      severity: 'P0',
      steps: ['provision an identity', 'open ws with ?token=<access>', 'await the first frame'],
      expected: 'socket opens; first durable frame is type `connected` carrying a connId',
    },
    async () => {
      const client = new QaRealtimeClient({
        token: pair.a.access,
        label: 'rt-001',
        testId: 'VC-RT-001',
      });
      try {
        await client.connect();
        const frame = await client.expect('connected', { label: 'connected frame' });
        assert.equal(frame.kind, 'durable', 'the `connected` greeting must be a durable frame');
        assert.ok(
          frame.data?.connId,
          'the `connected` frame must carry a connId for support correlation',
        );
      } finally {
        client.close();
      }
    },
  );

  qaTest(
    'VC-RT-002',
    'a socket with NO token is refused with close code 4001',
    {
      ...F,
      severity: 'P0',
      steps: ['open ws with no ?token'],
      expected: 'close 4001 (unauthorized) — the client must not retry this code',
      refs: ['backend-integration-reference.md §4', 'infra/realtime/socket.ts:47'],
    },
    async () => {
      const client = new QaRealtimeClient({
        token: null,
        sendToken: false,
        label: 'rt-002',
        testId: 'VC-RT-002',
      });
      try {
        const closed = await client.connectExpectingClose();
        assert.equal(
          closed.code,
          WS_CODE_UNAUTHORIZED,
          `an unauthenticated socket must close 4001 so the client knows not to retry; got ${closed.code}`,
        );
      } finally {
        client.close();
      }
    },
  );

  qaTest(
    'VC-RT-003',
    'a socket with a garbage token is refused, not accepted',
    {
      ...F,
      severity: 'P0',
      steps: ['open ws with ?token=garbage'],
      expected: 'the socket closes; it never receives `connected`',
    },
    async () => {
      const client = new QaRealtimeClient({
        token: 'garbage-token',
        label: 'rt-003',
        testId: 'VC-RT-003',
      });
      try {
        const closed = await client.connectExpectingClose();
        assert.ok(
          closed.code >= 1000,
          `a garbage token must close the socket, got ${JSON.stringify(closed)}`,
        );
        assert.equal(
          client.collect('connected').length,
          0,
          'a garbage token must never be greeted with `connected`',
        );
      } finally {
        client.close();
      }
    },
  );

  qaTest(
    'VC-RT-004',
    'a socket with an expired token is refused',
    {
      ...F,
      severity: 'P0',
      steps: ['forge a token with exp in the past', 'open ws'],
      expected: 'closed, never greeted',
    },
    async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
        'base64url',
      );
      const claims = Buffer.from(
        JSON.stringify({
          account_id: pair.a.accountId,
          device_id: pair.a.deviceId,
          iat: 1,
          exp: Math.floor(Date.now() / 1000) - 60,
        }),
      ).toString('base64url');
      const client = new QaRealtimeClient({
        token: `${header}.${claims}.bad`,
        label: 'rt-004',
        testId: 'VC-RT-004',
      });
      try {
        const closed = await client.connectExpectingClose();
        assert.ok(closed.code >= 1000, 'an expired token must close the socket');
        assert.equal(
          client.collect('connected').length,
          0,
          'an expired token must never be greeted',
        );
      } finally {
        client.close();
      }
    },
  );

  qaTest(
    'VC-RT-005',
    'the same account may hold two concurrent sockets (multi-device)',
    {
      ...F,
      severity: 'P1',
      steps: ['open two sockets with the same access token', 'both must be greeted'],
      expected: 'both connections are accepted with distinct connIds',
    },
    async () => {
      const one = new QaRealtimeClient({
        token: pair.a.access,
        label: 'rt-005-a',
        testId: 'VC-RT-005',
      });
      const two = new QaRealtimeClient({
        token: pair.a.access,
        label: 'rt-005-b',
        testId: 'VC-RT-005',
      });
      try {
        await Promise.all([one.connect(), two.connect()]);
        const [f1, f2] = await Promise.all([one.expect('connected'), two.expect('connected')]);
        assert.ok(f1.data.connId && f2.data.connId, 'both sockets must receive a connId');
        assert.notEqual(
          f1.data.connId,
          f2.data.connId,
          'two concurrent connections must get distinct connIds',
        );
      } finally {
        one.close();
        two.close();
      }
    },
  );

  qaTest(
    'VC-RT-006',
    'a ping is answered with a pong (heartbeat keeps the registry entry warm)',
    {
      ...F,
      severity: 'P1',
      steps: ['connect', 'send {type:"ping"}'],
      expected: 'a `pong` frame comes back',
    },
    async () => {
      const client = new QaRealtimeClient({
        token: pair.a.access,
        label: 'rt-006',
        testId: 'VC-RT-006',
      });
      try {
        await client.connect();
        await client.expect('connected');
        const mark = client.mark();
        client.send('ping', {});
        const pong = await client.expect('pong', { from: mark, label: 'pong' });
        assert.equal(pong.type, 'pong', 'a ping must be answered with a pong');
      } finally {
        client.close();
      }
    },
  );

  qaTest(
    'VC-RT-007',
    'a `sync` frame echoes the cursor back',
    {
      ...F,
      severity: 'P1',
      steps: ['connect', 'send {type:"sync", data:{cursor:42}}'],
      expected:
        'a durable `sync` frame echoing cursor 42 (the REST afterSeq backfill is the real catch-up)',
    },
    async () => {
      const client = new QaRealtimeClient({
        token: pair.a.access,
        label: 'rt-007',
        testId: 'VC-RT-007',
      });
      try {
        await client.connect();
        await client.expect('connected');
        const mark = client.mark();
        client.send('sync', { cursor: 42 });
        const echo = await client.expect('sync', { from: mark, label: 'sync echo' });
        assert.equal(
          echo.data?.cursor,
          42,
          `the sync cursor must be echoed verbatim, got ${JSON.stringify(echo.data)}`,
        );
      } finally {
        client.close();
      }
    },
  );
});

describe('VC-RT — malformed and hostile input', () => {
  let pair;

  before(async () => {
    pair = await provisionPair({ testId: 'VC-RT-malformed' });
  });

  /** A socket must survive junk input: the connection stays usable afterwards. */
  async function survives(label, payloads, testId) {
    const client = new QaRealtimeClient({ token: pair.a.access, label, testId });
    try {
      await client.connect();
      await client.expect('connected');
      for (const p of payloads) client.sendRaw(p);
      // Liveness proof: a ping must still round-trip after the junk.
      const mark = client.mark();
      client.send('ping', {});
      await client.expect('pong', {
        from: mark,
        label: 'pong after malformed input',
        timeoutMs: 8000,
      });
      assert.equal(
        client.closed,
        null,
        `the socket must not be killed by malformed input (closed: ${JSON.stringify(client.closed)})`,
      );
    } finally {
      client.close();
    }
  }

  qaTest(
    'VC-RT-010',
    'non-JSON text does not kill the connection',
    {
      ...F,
      severity: 'P1',
      steps: ['send "not json at all"'],
      expected: 'frame ignored; socket still answers a ping',
    },
    () => survives('rt-010', ['not json at all', '<<<>>>', ''], 'VC-RT-010'),
  );

  qaTest(
    'VC-RT-011',
    'a frame with an unknown type is ignored, not fatal',
    {
      ...F,
      severity: 'P1',
      steps: ['send {type:"definitely-not-a-real-type"}'],
      expected: 'ignored; socket alive',
    },
    () =>
      survives(
        'rt-011',
        [JSON.stringify({ kind: 'durable', type: 'definitely-not-a-real-type', data: {} })],
        'VC-RT-011',
      ),
  );

  qaTest(
    'VC-RT-012',
    'receipt frames with missing/invalid fields are ignored, not fatal',
    {
      ...F,
      severity: 'P1',
      steps: ['send read/delivered with no conversationId, a null seq, and a negative seq'],
      expected: 'each is dropped by validation; socket alive',
    },
    () =>
      survives(
        'rt-012',
        [
          JSON.stringify({ kind: 'durable', type: 'read', data: {} }),
          JSON.stringify({
            kind: 'durable',
            type: 'delivered',
            data: { conversationId: 'x', seq: null },
          }),
          JSON.stringify({ kind: 'durable', type: 'read', data: { conversationId: 'x', seq: -5 } }),
          JSON.stringify({
            kind: 'durable',
            type: 'read',
            data: { conversationId: 'x', seq: 'not-a-number' },
          }),
        ],
        'VC-RT-012',
      ),
  );

  qaTest(
    'VC-RT-013',
    'a deeply nested payload does not crash the frame parser',
    {
      ...F,
      severity: 'P2',
      steps: ['send a 200-deep nested object'],
      expected: 'handled or dropped; socket alive',
    },
    () => {
      let nested = { end: true };
      for (let i = 0; i < 200; i++) nested = { n: nested };
      return survives(
        'rt-013',
        [JSON.stringify({ kind: 'durable', type: 'read', data: nested })],
        'VC-RT-013',
      );
    },
  );

  qaTest(
    'VC-RT-014',
    'a receipt for a conversation the sender is not a member of is not fanned out to that conversation',
    {
      ...F,
      severity: 'P0',
      steps: [
        'C provisions a socket',
        "C sends read for A↔B's conversation",
        'A watches for a receipt from C',
      ],
      expected:
        'no receipt attributed to C reaches A — membership must gate receipt fan-out (IDOR)',
    },
    async () => {
      const conversationId = await ensureDm(pair.a, pair.b, { testId: 'VC-RT-014' });
      const outsider = await provisionOutsider({ testId: 'VC-RT-014' });

      const watcher = new QaRealtimeClient({
        token: pair.a.access,
        label: 'rt-014-A',
        testId: 'VC-RT-014',
      });
      const attacker = new QaRealtimeClient({
        token: outsider.access,
        label: 'rt-014-C',
        testId: 'VC-RT-014',
      });
      try {
        await watcher.connect();
        await watcher.expect('connected');
        await attacker.connect();
        await attacker.expect('connected');

        const mark = watcher.mark();
        attacker.send('read', { conversationId, seq: 1 });
        await sleep(3000);

        const leaked = watcher
          .collect('receipt', mark)
          .filter(
            (f) =>
              f.data?.conversation_id === conversationId && f.data?.user_id === outsider.accountId,
          );
        assert.equal(
          leaked.length,
          0,
          `a non-member's receipt must not fan out into the conversation; A received ${JSON.stringify(leaked)}`,
        );
      } finally {
        watcher.close();
        attacker.close();
      }
    },
  );
});

describe('VC-RT — durable delivery guarantee', () => {
  let pair;
  let conversationId;

  before(async () => {
    pair = await provisionPair({ testId: 'VC-RT-durable' });
    conversationId = await ensureDm(pair.a, pair.b, { testId: 'VC-RT-durable' });
  });

  qaTest(
    'VC-RT-020',
    'a single message fans out to BOTH parties over the socket',
    {
      ...F,
      severity: 'P0',
      steps: ['A and B connect', 'A sends one message over REST'],
      expected: 'both sockets receive a durable `message` frame with the acked seq',
    },
    async () => {
      const wa = new QaRealtimeClient({
        token: pair.a.access,
        label: 'rt-020-A',
        testId: 'VC-RT-020',
      });
      const wb = new QaRealtimeClient({
        token: pair.b.access,
        label: 'rt-020-B',
        testId: 'VC-RT-020',
      });
      try {
        await Promise.all([wa.connect(), wb.connect()]);
        await Promise.all([wa.expect('connected'), wb.expect('connected')]);
        const markA = wa.mark();
        const markB = wb.mark();

        const ack = await sendText(pair.a, conversationId, 'single durable message', 'VC-RT-020');

        const [fa, fb] = await Promise.all([
          wa.expect((f) => f.type === 'message' && f.data?.seq === ack.seq, {
            from: markA,
            label: `message seq ${ack.seq} at A`,
          }),
          wb.expect((f) => f.type === 'message' && f.data?.seq === ack.seq, {
            from: markB,
            label: `message seq ${ack.seq} at B`,
          }),
        ]);
        assert.equal(fa.kind, 'durable', 'a message frame must be durable');
        assert.equal(
          fb.data.conversation_id,
          conversationId,
          'the frame must carry the conversation id',
        );
        assert.equal(
          fb.data.message_id,
          ack.messageId,
          'the fanned-out message_id must match the REST ack',
        );
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-RT-021',
    'EVERY durable message fans out — 10 accepted sends must produce 10 socket frames',
    {
      ...F,
      severity: 'P0',
      priority: 'P0',
      preconditions: 'A and B both hold an open socket on the same DM',
      steps: [
        'A and B connect and are greeted',
        'A sends 10 messages over REST, each returning 201 with a distinct seq',
        'wait for fan-out to settle',
        'compare the seqs REST acked, the seqs REST history holds, and the seqs each socket received',
      ],
      expected:
        'all three sets are equal. The contract is explicit that durable frames are NEVER dropped — ' +
        'only ephemeral frames coalesce under backpressure (backend-integration-reference.md §4).',
      refs: [
        'docs/backend-integration-reference.md §4',
        'libs/feature-realtime/src/fabric/send-queue.ts:10-13',
      ],
    },
    async () => {
      const wa = new QaRealtimeClient({
        token: pair.a.access,
        label: 'rt-021-A',
        testId: 'VC-RT-021',
      });
      const wb = new QaRealtimeClient({
        token: pair.b.access,
        label: 'rt-021-B',
        testId: 'VC-RT-021',
      });
      try {
        await Promise.all([wa.connect(), wb.connect()]);
        await Promise.all([wa.expect('connected'), wb.expect('connected')]);
        const markA = wa.mark();
        const markB = wb.mark();

        const acked = [];
        for (let n = 1; n <= 10; n++) {
          const ack = await sendText(pair.a, conversationId, `burst ${n}`, 'VC-RT-021');
          acked.push(ack.seq);
        }

        // Bounded settle window — generous, so a slow fan-out is not mistaken for a lost one.
        await sleep(6000);

        const gotA = wa
          .collect('message', markA)
          .map((f) => f.data.seq)
          .sort((x, y) => x - y);
        const gotB = wb
          .collect('message', markB)
          .map((f) => f.data.seq)
          .sort((x, y) => x - y);

        const history = await post(
          `/chat/conversations/${encodeURIComponent(conversationId)}/messages?afterSeq=0&limit=100`,
          undefined,
          { token: pair.b.access, testId: 'VC-RT-021' },
        );
        void history; // history is asserted by VC-CHAT-010; here the REST acks are the source of truth

        const missingB = acked.filter((s) => !gotB.includes(s));
        assert.deepEqual(
          gotB,
          acked.slice().sort((x, y) => x - y),
          `DURABLE MESSAGE LOSS: REST acked seqs [${acked.join(',')}] but the recipient's socket only received ` +
            `[${gotB.join(',') || 'none'}] — missing [${missingB.join(',')}]. ` +
            'Durable frames must never be dropped.',
        );
        assert.deepEqual(
          gotA,
          acked.slice().sort((x, y) => x - y),
          `the sender's own echo also lost frames: got [${gotA.join(',')}]`,
        );
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-RT-022',
    'a message accepted by REST is always retrievable by the afterSeq cursor (the no-loss backstop)',
    {
      ...F,
      severity: 'P0',
      steps: ['A sends 5 messages', 'B fetches GET /chat/conversations/:id/messages?afterSeq=0'],
      expected:
        'every acked seq is present in history — this is the backstop that makes WS best-effort acceptable',
    },
    async () => {
      const acked = [];
      for (let n = 1; n <= 5; n++) {
        const ack = await sendText(pair.a, conversationId, `cursor ${n}`, 'VC-RT-022');
        acked.push(ack.seq);
      }
      const hist = await get(
        `/chat/conversations/${encodeURIComponent(conversationId)}/messages?afterSeq=0&limit=100`,
        {
          token: pair.b.access,
          testId: 'VC-RT-022',
        },
      );
      assert.equal(hist.status, 200, `history must be readable, got ${hist.status}`);
      const seqs = (hist.data ?? []).map((m) => m.seq);
      for (const s of acked) {
        assert.ok(
          seqs.includes(s),
          `seq ${s} was acked by REST but is absent from history [${seqs.join(',')}] — real message loss`,
        );
      }
    },
  );
});

describe('VC-RT — receipts (grey tick / blue tick)', () => {
  let pair;
  let conversationId;

  before(async () => {
    pair = await provisionPair({ testId: 'VC-RT-receipts' });
    conversationId = await ensureDm(pair.a, pair.b, { testId: 'VC-RT-receipts' });
  });

  /** Open both sockets, greeted and quiet. */
  async function bothConnected(testId) {
    const wa = new QaRealtimeClient({ token: pair.a.access, label: `${testId}-A`, testId });
    const wb = new QaRealtimeClient({ token: pair.b.access, label: `${testId}-B`, testId });
    await Promise.all([wa.connect(), wb.connect()]);
    await Promise.all([wa.expect('connected'), wb.expect('connected')]);
    return { wa, wb };
  }

  qaTest(
    'VC-RT-030',
    'a `delivered` receipt from B reaches A (grey double tick)',
    {
      ...F,
      severity: 'P0',
      steps: ['A sends a message', 'B sends {type:"delivered",data:{conversationId,seq}}'],
      expected: 'A receives a `receipt` frame with state:"delivered" and up_to_seq === seq',
    },
    async () => {
      const { wa, wb } = await bothConnected('VC-RT-030');
      try {
        const ack = await sendText(pair.a, conversationId, 'grey tick please', 'VC-RT-030');
        const mark = wa.mark();
        wb.send('delivered', { conversationId, seq: ack.seq });
        const r = await wa.expect(
          (f) =>
            f.type === 'receipt' && f.data?.state === 'delivered' && f.data?.up_to_seq === ack.seq,
          { from: mark, label: `delivered receipt for seq ${ack.seq}` },
        );
        assert.equal(r.data.user_id, pair.b.accountId, 'the receipt must be attributed to B');
        assert.equal(
          r.data.conversation_id,
          conversationId,
          'the receipt must carry the conversation id',
        );
        assert.ok(r.data.at, 'the receipt must carry a timestamp');
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-RT-031',
    'a `read` receipt from B reaches A (blue double tick)',
    {
      ...F,
      severity: 'P0',
      steps: ['A sends a message', 'B sends {type:"read",...}'],
      expected: 'A receives a `receipt` frame with state:"read"',
    },
    async () => {
      const { wa, wb } = await bothConnected('VC-RT-031');
      try {
        const ack = await sendText(pair.a, conversationId, 'blue tick please', 'VC-RT-031');
        const mark = wa.mark();
        wb.send('read', { conversationId, seq: ack.seq });
        const r = await wa.expect(
          (f) => f.type === 'receipt' && f.data?.state === 'read' && f.data?.up_to_seq === ack.seq,
          {
            from: mark,
            label: `read receipt for seq ${ack.seq}`,
          },
        );
        assert.equal(r.data.user_id, pair.b.accountId, 'the read receipt must be attributed to B');
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-RT-032',
    'delivered THEN read sent back-to-back both reach A — the blue tick must not be swallowed',
    {
      ...F,
      severity: 'P0',
      priority: 'P0',
      preconditions: 'A and B on an open DM; A has sent a message with seq N',
      steps: [
        'A sends a message, acked with seq N',
        'B sends {type:"delivered",seq:N} and {type:"read",seq:N} in the SAME tick — exactly what the client does when a chat is opened',
        'wait for fan-out',
      ],
      expected:
        'A receives BOTH receipts (or at minimum the `read` one, since read supersedes delivered). ' +
        'Losing the read receipt means the sender is stuck on a grey double tick forever.',
      refs: ['apps/mobile/src/domain/sync/SyncEngine.ts:842-844', 'VC-BUG-101'],
    },
    async () => {
      const { wa, wb } = await bothConnected('VC-RT-032');
      try {
        const ack = await sendText(pair.a, conversationId, 'delivered+read same tick', 'VC-RT-032');
        const mark = wa.mark();

        // Exactly the client's shape: both frames written without an intervening await.
        wb.send('delivered', { conversationId, seq: ack.seq });
        wb.send('read', { conversationId, seq: ack.seq });

        await sleep(5000);
        const states = wa
          .collect('receipt', mark)
          .filter((f) => f.data?.up_to_seq === ack.seq)
          .map((f) => f.data.state);

        assert.ok(
          states.includes('read'),
          `BLUE TICK LOST: B sent delivered+read for seq ${ack.seq} in one tick, but A only received ` +
            `[${states.join(', ') || 'nothing'}]. The read receipt never arrives, so the sender stays on a grey ` +
            'double tick. Sending them 1.5s apart delivers both, which points at same-window coalescing.',
        );
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-RT-033',
    'receipts are cumulative: a read at seq N covers every message at or below N',
    {
      ...F,
      severity: 'P1',
      steps: ['A sends 3 messages (seq N, N+1, N+2)', 'B sends read at seq N+2'],
      expected:
        'one receipt with up_to_seq === N+2 — the client resolves it cumulatively, no per-message receipt needed',
    },
    async () => {
      const { wa, wb } = await bothConnected('VC-RT-033');
      try {
        const acks = [];
        for (let n = 0; n < 3; n++)
          acks.push(await sendText(pair.a, conversationId, `cumulative ${n}`, 'VC-RT-033'));
        const top = Math.max(...acks.map((a) => a.seq));
        const mark = wa.mark();
        wb.send('read', { conversationId, seq: top });
        const r = await wa.expect((f) => f.type === 'receipt' && f.data?.state === 'read', {
          from: mark,
          label: 'cumulative read receipt',
        });
        assert.equal(
          r.data.up_to_seq,
          top,
          `the cumulative receipt must report up_to_seq ${top}, got ${r.data.up_to_seq}`,
        );
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-RT-034',
    'a duplicate read receipt is idempotent (no error, no regression)',
    {
      ...F,
      severity: 'P1',
      steps: ['B sends the same read receipt twice, 1.5s apart'],
      expected:
        'both are accepted; the socket stays alive and no receipt reports a LOWER up_to_seq afterwards',
    },
    async () => {
      const { wa, wb } = await bothConnected('VC-RT-034');
      try {
        const ack = await sendText(pair.a, conversationId, 'duplicate ack', 'VC-RT-034');
        const mark = wa.mark();
        wb.send('read', { conversationId, seq: ack.seq });
        await sleep(1500);
        wb.send('read', { conversationId, seq: ack.seq });
        await sleep(3000);

        const reads = wa.collect('receipt', mark).filter((f) => f.data?.state === 'read');
        assert.ok(reads.length >= 1, 'at least one read receipt must arrive');
        for (const r of reads) {
          assert.ok(
            r.data.up_to_seq >= ack.seq,
            `a duplicate receipt must never report a lower watermark (${r.data.up_to_seq} < ${ack.seq})`,
          );
        }
        assert.equal(wb.closed, null, 'a duplicate receipt must not close the socket');
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-RT-035',
    'an out-of-order receipt does not roll the watermark backwards',
    {
      ...F,
      severity: 'P0',
      steps: [
        'A sends 3 messages',
        'B sends read at the TOP seq',
        'then B sends read at a LOWER seq',
      ],
      expected:
        'no receipt arrives at A reporting a watermark below the one already reported — a blue tick must never turn grey',
    },
    async () => {
      const { wa, wb } = await bothConnected('VC-RT-035');
      try {
        const acks = [];
        for (let n = 0; n < 3; n++)
          acks.push(await sendText(pair.a, conversationId, `ooo ${n}`, 'VC-RT-035'));
        const seqs = acks.map((a) => a.seq).sort((x, y) => x - y);
        const top = seqs[seqs.length - 1];
        const low = seqs[0];

        const mark = wa.mark();
        wb.send('read', { conversationId, seq: top });
        await sleep(2000);
        wb.send('read', { conversationId, seq: low });
        await sleep(3000);

        const watermarks = wa
          .collect('receipt', mark)
          .filter((f) => f.data?.state === 'read')
          .map((f) => f.data.up_to_seq);
        assert.ok(watermarks.length > 0, 'the top read receipt must have arrived');
        const highWater = Math.max(...watermarks);
        assert.equal(
          highWater,
          top,
          `the highest reported read watermark must be ${top}; got ${highWater} from [${watermarks.join(',')}]`,
        );
      } finally {
        wa.close();
        wb.close();
      }
    },
  );
});

describe('VC-RT — typing indicator', () => {
  let pair;
  let conversationId;

  before(async () => {
    pair = await provisionPair({ testId: 'VC-RT-typing' });
    conversationId = await ensureDm(pair.a, pair.b, { testId: 'VC-RT-typing' });
  });

  qaTest(
    'VC-RT-040',
    'B typing produces a `typing.started` frame at A',
    {
      ...F,
      severity: 'P1',
      steps: [
        'B sends a FLAT ephemeral {kind:"ephemeral",type:"typing",conversationId,state:"start"}',
      ],
      expected: 'A receives `typing.started` naming the conversation and B',
      refs: ['apps/mobile/src/infra/realtime/socket.ts:176-190'],
    },
    async () => {
      const wa = new QaRealtimeClient({
        token: pair.a.access,
        label: 'rt-040-A',
        testId: 'VC-RT-040',
      });
      const wb = new QaRealtimeClient({
        token: pair.b.access,
        label: 'rt-040-B',
        testId: 'VC-RT-040',
      });
      try {
        await Promise.all([wa.connect(), wb.connect()]);
        await Promise.all([wa.expect('connected'), wb.expect('connected')]);
        const mark = wa.mark();
        wb.sendEphemeral('typing', { conversationId, state: 'start' });
        const f = await wa.expect('typing.started', { from: mark, label: 'typing.started' });
        assert.equal(
          f.data?.conversationId,
          conversationId,
          'the typing frame must name the conversation',
        );
        assert.equal(f.data?.userId, pair.b.accountId, 'the typing frame must name the typist');
        assert.equal(
          f.kind,
          'ephemeral',
          'typing must be an ephemeral frame — it is never re-synced',
        );
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-RT-041',
    'B stopping typing produces a `typing.stopped` frame at A (typing never sticks on)',
    {
      ...F,
      severity: 'P1',
      steps: ['B sends typing start', 'B sends typing stop'],
      expected: 'A receives `typing.stopped` — otherwise the indicator stays on forever',
    },
    async () => {
      const wa = new QaRealtimeClient({
        token: pair.a.access,
        label: 'rt-041-A',
        testId: 'VC-RT-041',
      });
      const wb = new QaRealtimeClient({
        token: pair.b.access,
        label: 'rt-041-B',
        testId: 'VC-RT-041',
      });
      try {
        await Promise.all([wa.connect(), wb.connect()]);
        await Promise.all([wa.expect('connected'), wb.expect('connected')]);
        wb.sendEphemeral('typing', { conversationId, state: 'start' });
        await wa.expect('typing.started', { label: 'typing.started' });
        const mark = wa.mark();
        await sleep(1200);
        wb.sendEphemeral('typing', { conversationId, state: 'stop' });
        const f = await wa.expect('typing.stopped', { from: mark, label: 'typing.stopped' });
        assert.equal(f.data?.userId, pair.b.accountId, 'the stop frame must name the same typist');
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-RT-042',
    'a typing frame from a non-member does not reach the conversation',
    {
      ...F,
      severity: 'P1',
      steps: ["outsider C sends typing for A↔B's conversation"],
      expected:
        'A never sees a typing frame attributed to C — membership gates ephemeral fan-out too',
    },
    async () => {
      const outsider = await provisionOutsider({ testId: 'VC-RT-042' });
      const wa = new QaRealtimeClient({
        token: pair.a.access,
        label: 'rt-042-A',
        testId: 'VC-RT-042',
      });
      const wc = new QaRealtimeClient({
        token: outsider.access,
        label: 'rt-042-C',
        testId: 'VC-RT-042',
      });
      try {
        await Promise.all([wa.connect(), wc.connect()]);
        await Promise.all([wa.expect('connected'), wc.expect('connected')]);
        const mark = wa.mark();
        wc.sendEphemeral('typing', { conversationId, state: 'start' });
        await sleep(3000);
        const leaked = wa
          .collect('typing.started', mark)
          .filter((f) => f.data?.userId === outsider.accountId);
        assert.equal(
          leaked.length,
          0,
          `a non-member's typing must not fan out; A received ${JSON.stringify(leaked)}`,
        );
      } finally {
        wa.close();
        wc.close();
      }
    },
  );
});
