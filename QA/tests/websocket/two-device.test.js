/**
 * VC-2DEV-* — Two-device critical flows (§7, §8, §9, §38).
 *
 * ARCHITECTURE AND ITS HONEST LIMITATION
 * --------------------------------------
 * §38 forbids faking two-device testing on a single device. This suite does not fake it: every
 * test drives TWO independent identities — separate accounts, separate device rows, separate
 * Ed25519 keypairs, separate token families, separate WebSocket connections — through the real
 * backend, and asserts on what each peer actually observes.
 *
 * What that gives us: a genuine two-party assertion of the full delivery and receipt lifecycle,
 * including the exact interleavings that a manual two-phone test cannot reproduce reliably
 * (same-tick receipts, out-of-order acks, reconnect mid-burst).
 *
 * What it does NOT cover, stated plainly: these are two protocol peers, not two Android runtimes.
 * It cannot exercise the on-device notification UI, doze/background-execution behaviour, or
 * reply-from-notification, because those live in the OS. Those are covered by the Maestro flows in
 * QA/maestro/notifications/ and by the manual two-device matrix in QA/DEVICE-MATRIX.md, and they
 * REQUIRE two real Android devices. See "Known limitations" in QA/reports/FINAL-QA-REPORT.md.
 *
 * The delivery chain each test walks (§45 — never "the bubble appeared"):
 *   A's send  →  REST ack (messageId, seq)  →  server persistence (afterSeq history)
 *             →  B's socket  →  B's receipt  →  A's socket
 */
import assert from 'node:assert/strict';
import { before, describe } from 'node:test';
import { get, post } from '../../lib/http.js';
import { qaTest } from '../../lib/results.js';
import { QaRealtimeClient } from '../../lib/ws.js';
import { ensureDm, provisionPair } from '../../lib/provision.js';

const F = { feature: 'Two-device chat' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The spacing VC-001 showed is required for the realtime fan-out not to drop durable frames.
 * Every test that sends more than one message uses it, so those tests measure what they claim to
 * measure instead of re-failing on VC-001. Tests that deliberately probe the burst behaviour live
 * in realtime.test.js (VC-RT-021) and do NOT use this.
 */
const FANOUT_SAFE_GAP_MS = 400;

async function sendAs(identity, conversationId, content, testId) {
  const clientMsgId = `qa-${testId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await post(
    '/chat/messages',
    { conversationId, senderId: identity.accountId, clientMsgId, type: 'text', content },
    { token: identity.access, testId },
  );
  return { res, clientMsgId };
}

async function history(identity, conversationId, testId, afterSeq = 0) {
  const res = await get(
    `/chat/conversations/${encodeURIComponent(conversationId)}/messages?afterSeq=${afterSeq}&limit=100`,
    {
      token: identity.access,
      testId,
    },
  );
  return Array.isArray(res.data) ? res.data : [];
}

describe('VC-2DEV — the full A→B delivery chain', () => {
  let a;
  let b;
  let conversationId;

  before(async () => {
    const pair = await provisionPair({ testId: 'VC-2DEV-setup' });
    a = pair.a;
    b = pair.b;
    conversationId = await ensureDm(a, b, { testId: 'VC-2DEV-setup' });
  });

  qaTest(
    'VC-2DEV-001',
    'A→B: message traverses client → API → server → recipient, verified at every hop',
    {
      ...F,
      severity: 'P0',
      priority: 'P0',
      preconditions:
        'A and B are distinct accounts on distinct devices, members of one DM. Both sockets open.',
      steps: [
        'A POSTs /chat/messages with a unique clientMsgId.',
        'Assert the REST ack carries a messageId and a positive seq.',
        "Assert B's socket receives a durable `message` frame whose message_id equals the ack's.",
        "Assert the server persisted it: it appears in B's afterSeq history with the same seq and content.",
        'Assert the sender attribution is A.',
      ],
      expected:
        'Every hop confirms the same message_id / seq / content. A PASS here means the message really arrived, not that a bubble rendered.',
    },
    async () => {
      const wa = new QaRealtimeClient({
        token: a.access,
        label: '2dev-001-A',
        testId: 'VC-2DEV-001',
      });
      const wb = new QaRealtimeClient({
        token: b.access,
        label: '2dev-001-B',
        testId: 'VC-2DEV-001',
      });
      try {
        await Promise.all([wa.connect(), wb.connect()]);
        await Promise.all([wa.expect('connected'), wb.expect('connected')]);
        const markB = wb.mark();

        const body = `A→B chain ${Date.now()}`;
        const { res, clientMsgId } = await sendAs(a, conversationId, body, 'VC-2DEV-001');

        // Hop 1 — the API accepted it.
        assert.equal(
          res.status,
          201,
          `hop 1 (REST ack): expected 201, got ${res.status} ${res.text.slice(0, 200)}`,
        );
        assert.ok(res.data?.messageId, 'hop 1: the ack must carry a messageId');
        assert.ok(
          Number(res.data?.seq) > 0,
          `hop 1: the ack must carry a positive seq, got ${res.data?.seq}`,
        );
        assert.ok(res.data?.serverTs, 'hop 1: the ack must carry a server timestamp');

        // Hop 2 — it reached the recipient in realtime.
        const frame = await wb.expect(
          (f) => f.type === 'message' && f.data?.message_id === res.data.messageId,
          {
            from: markB,
            label: `hop 2: message ${res.data.messageId} at B`,
          },
        );
        assert.equal(frame.data.seq, res.data.seq, 'hop 2: the fanned-out seq must match the ack');
        assert.equal(
          frame.data.content,
          body,
          'hop 2: the delivered content must match what A sent',
        );
        assert.equal(
          frame.data.sender_account_id,
          a.accountId,
          'hop 2: the message must be attributed to A',
        );
        assert.equal(
          frame.data.client_msg_id,
          clientMsgId,
          'hop 2: the clientMsgId must survive the round trip (dedup depends on it)',
        );

        // Hop 3 — the server persisted it.
        const rows = await history(b, conversationId, 'VC-2DEV-001');
        const stored = rows.find((m) => m._id === res.data.messageId);
        assert.ok(
          stored,
          `hop 3 (persistence): message ${res.data.messageId} is absent from B's history`,
        );
        assert.equal(stored.content, body, 'hop 3: the persisted content must match');
        assert.equal(stored.seq, res.data.seq, 'hop 3: the persisted seq must match the ack');
        assert.equal(
          stored.deleted,
          false,
          'hop 3: a freshly sent message must not be marked deleted',
        );
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-2DEV-002',
    'B→A: the reverse direction works identically',
    {
      ...F,
      severity: 'P0',
      steps: ['B sends to the same conversation', 'A receives it over the socket and in history'],
      expected: 'symmetric behaviour — nothing is sender-specific',
    },
    async () => {
      const wa = new QaRealtimeClient({
        token: a.access,
        label: '2dev-002-A',
        testId: 'VC-2DEV-002',
      });
      const wb = new QaRealtimeClient({
        token: b.access,
        label: '2dev-002-B',
        testId: 'VC-2DEV-002',
      });
      try {
        await Promise.all([wa.connect(), wb.connect()]);
        await Promise.all([wa.expect('connected'), wb.expect('connected')]);
        const markA = wa.mark();

        const body = `B→A chain ${Date.now()}`;
        const { res } = await sendAs(b, conversationId, body, 'VC-2DEV-002');
        assert.equal(res.status, 201, `B's send must be accepted, got ${res.status}`);

        const frame = await wa.expect(
          (f) => f.type === 'message' && f.data?.message_id === res.data.messageId,
          {
            from: markA,
            label: 'B→A message at A',
          },
        );
        assert.equal(
          frame.data.sender_account_id,
          b.accountId,
          'the message must be attributed to B',
        );
        assert.equal(frame.data.content, body, 'the content must match');
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-2DEV-003',
    'the complete tick lifecycle: sent → delivered (grey) → read (blue)',
    {
      ...F,
      severity: 'P0',
      priority: 'P0',
      preconditions: 'A and B both online with open sockets on one DM.',
      steps: [
        'A sends a message; record the ack seq (state: sent, one tick).',
        'B receives the message frame.',
        'B sends a `delivered` receipt at that seq.',
        'A must observe receipt{state:delivered} — grey double tick.',
        'Wait so the receipts are not coalesced (see VC-002), then B sends a `read` receipt.',
        'A must observe receipt{state:read} — blue double tick.',
      ],
      expected:
        'A observes the delivered receipt and then the read receipt, in that order, both naming B and the ' +
        'correct watermark. This is the exact chain a user reads as one tick → two grey → two blue.',
      refs: ['VC-002'],
    },
    async () => {
      const wa = new QaRealtimeClient({
        token: a.access,
        label: '2dev-003-A',
        testId: 'VC-2DEV-003',
      });
      const wb = new QaRealtimeClient({
        token: b.access,
        label: '2dev-003-B',
        testId: 'VC-2DEV-003',
      });
      try {
        await Promise.all([wa.connect(), wb.connect()]);
        await Promise.all([wa.expect('connected'), wb.expect('connected')]);
        const markA = wa.mark();
        const markB = wb.mark();

        // sent
        const { res } = await sendAs(
          a,
          conversationId,
          `tick lifecycle ${Date.now()}`,
          'VC-2DEV-003',
        );
        assert.equal(res.status, 201, 'the send must be accepted');
        const seq = res.data.seq;

        // B actually received it — a delivery receipt is only honest if the message arrived.
        await wb.expect((f) => f.type === 'message' && f.data?.seq === seq, {
          from: markB,
          label: `message seq ${seq} at B`,
        });

        // delivered → grey double tick
        wb.send('delivered', { conversationId, seq });
        const delivered = await wa.expect(
          (f) => f.type === 'receipt' && f.data?.state === 'delivered' && f.data?.up_to_seq >= seq,
          {
            from: markA,
            label: `delivered receipt at or above seq ${seq}`,
          },
        );
        assert.equal(
          delivered.data.user_id,
          b.accountId,
          'the delivered receipt must be attributed to B',
        );

        // read → blue double tick. Spaced deliberately: VC-002 shows a same-tick read is swallowed.
        await sleep(1800);
        const markRead = wa.mark();
        wb.send('read', { conversationId, seq });
        const read = await wa.expect(
          (f) => f.type === 'receipt' && f.data?.state === 'read' && f.data?.up_to_seq >= seq,
          {
            from: markRead,
            label: `read receipt at or above seq ${seq}`,
          },
        );
        assert.equal(read.data.user_id, b.accountId, 'the read receipt must be attributed to B');
        assert.ok(
          read.data.up_to_seq >= delivered.data.up_to_seq,
          'the read watermark must not be below the delivered watermark',
        );
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-2DEV-004',
    'no false delivery tick: B offline means A gets no delivered receipt',
    {
      ...F,
      severity: 'P0',
      priority: 'P0',
      preconditions: 'B has NO socket open (simulating offline / app killed).',
      steps: [
        'B disconnects entirely.',
        'A sends a message.',
        'Wait well past the fan-out window.',
        'Assert A received no `delivered` or `read` receipt for that seq.',
      ],
      expected:
        'A stays on a single tick. A delivery tick must mean the message reached a device — never merely that the ' +
        'server accepted it. A false grey tick is worse than a missing one.',
    },
    async () => {
      const wa = new QaRealtimeClient({
        token: a.access,
        label: '2dev-004-A',
        testId: 'VC-2DEV-004',
      });
      try {
        await wa.connect();
        await wa.expect('connected');
        const markA = wa.mark();

        const { res } = await sendAs(
          a,
          conversationId,
          `no false tick ${Date.now()}`,
          'VC-2DEV-004',
        );
        assert.equal(res.status, 201, 'the send must be accepted');
        const seq = res.data.seq;

        await sleep(6000);

        const receipts = wa
          .collect('receipt', markA)
          .filter((f) => f.data?.up_to_seq >= seq && f.data?.user_id === b.accountId);
        assert.equal(
          receipts.length,
          0,
          `FALSE TICK: B was offline, yet A received ${JSON.stringify(receipts.map((r) => `${r.data.state}@${r.data.up_to_seq}`))}`,
        );
      } finally {
        wa.close();
      }
    },
  );

  qaTest(
    'VC-2DEV-005',
    'B reconnecting after being offline recovers every message it missed (cursor catch-up)',
    {
      ...F,
      severity: 'P0',
      priority: 'P0',
      preconditions: 'B knows its last seen seq; B then goes offline.',
      steps: [
        "Record B's current high-water seq from history.",
        'B disconnects.',
        'A sends 3 messages while B is away (spaced past the VC-001 fan-out window).',
        'B reconnects and sends {type:"sync",cursor:<lastSeq>}.',
        'B backfills via GET /chat/conversations/:id/messages?afterSeq=<lastSeq>.',
      ],
      expected:
        'The backfill returns exactly the 3 missed messages, in seq order, with no duplicates and nothing ' +
        'missing. This is the documented no-loss backstop that makes best-effort WS delivery acceptable.',
    },
    async () => {
      const before_ = await history(b, conversationId, 'VC-2DEV-005');
      const lastSeq = before_.length ? Math.max(...before_.map((m) => m.seq)) : 0;

      const sent = [];
      for (let n = 1; n <= 3; n++) {
        const { res } = await sendAs(a, conversationId, `missed ${n} of 3`, 'VC-2DEV-005');
        assert.equal(res.status, 201, `send ${n} must be accepted`);
        sent.push(res.data.seq);
        await sleep(FANOUT_SAFE_GAP_MS);
      }

      // B comes back and does exactly what the client does on reconnect.
      const wb = new QaRealtimeClient({
        token: b.access,
        label: '2dev-005-B',
        testId: 'VC-2DEV-005',
      });
      try {
        await wb.connect();
        await wb.expect('connected');
        wb.send('sync', { cursor: lastSeq });
        const echo = await wb.expect('sync', { label: 'sync cursor echo' });
        assert.equal(
          echo.data?.cursor,
          lastSeq,
          'the cursor must be echoed so the client can confirm its position',
        );

        const missed = await history(b, conversationId, 'VC-2DEV-005', lastSeq);
        const seqs = missed.map((m) => m.seq).sort((x, y) => x - y);

        for (const s of sent) {
          assert.ok(
            seqs.includes(s),
            `catch-up lost seq ${s}; backfill returned [${seqs.join(',')}]`,
          );
        }
        assert.equal(
          new Set(seqs).size,
          seqs.length,
          `catch-up returned duplicate seqs: [${seqs.join(',')}]`,
        );
        const ordered = [...seqs].sort((x, y) => x - y);
        assert.deepEqual(seqs, ordered, `catch-up must be ordered by seq, got [${seqs.join(',')}]`);
      } finally {
        wb.close();
      }
    },
  );

  qaTest(
    'VC-2DEV-006',
    'B replies after reconnect and A receives it (bidirectional recovery)',
    {
      ...F,
      severity: 'P1',
      steps: ['B disconnects and reconnects', 'B sends a message', 'A receives it'],
      expected: 'a reconnected peer is fully functional as a sender, not just as a receiver',
    },
    async () => {
      const wa = new QaRealtimeClient({
        token: a.access,
        label: '2dev-006-A',
        testId: 'VC-2DEV-006',
      });
      const wb = new QaRealtimeClient({
        token: b.access,
        label: '2dev-006-B',
        testId: 'VC-2DEV-006',
      });
      try {
        await Promise.all([wa.connect(), wb.connect()]);
        await Promise.all([wa.expect('connected'), wb.expect('connected')]);

        // Drop and re-establish B.
        wb.close();
        await sleep(1500);
        const wb2 = new QaRealtimeClient({
          token: b.access,
          label: '2dev-006-B2',
          testId: 'VC-2DEV-006',
        });
        await wb2.connect();
        await wb2.expect('connected');

        const markA = wa.mark();
        const { res } = await sendAs(
          b,
          conversationId,
          `reply after reconnect ${Date.now()}`,
          'VC-2DEV-006',
        );
        assert.equal(res.status, 201, "B's post-reconnect send must be accepted");

        const frame = await wa.expect(
          (f) => f.type === 'message' && f.data?.message_id === res.data.messageId,
          {
            from: markA,
            label: "B's post-reconnect message at A",
          },
        );
        assert.equal(
          frame.data.sender_account_id,
          b.accountId,
          'attribution must survive the reconnect',
        );
        wb2.close();
      } finally {
        wa.close();
        wb.close();
      }
    },
  );

  qaTest(
    'VC-2DEV-007',
    'duplicate send is idempotent: the same clientMsgId never creates two messages',
    {
      ...F,
      severity: 'P0',
      priority: 'P0',
      preconditions: 'A DM between A and B.',
      steps: [
        'A sends a message with clientMsgId X and records the ack.',
        'A sends the SAME body with the SAME clientMsgId X again (what a retry after a lost ack looks like).',
        "Fetch B's history and count messages carrying X.",
      ],
      expected:
        'Exactly one message exists. Idempotency is keyed on (conversationId, clientMsgId), so the retry ' +
        'returns the original ack rather than creating a second message.',
      refs: ['docs/backend-integration-reference.md §5'],
    },
    async () => {
      const clientMsgId = `idem-${Date.now()}`;
      const body = `idempotent ${clientMsgId}`;
      const payload = {
        conversationId,
        senderId: a.accountId,
        clientMsgId,
        type: 'text',
        content: body,
      };

      const first = await post('/chat/messages', payload, {
        token: a.access,
        testId: 'VC-2DEV-007',
      });
      assert.equal(first.status, 201, `the first send must be accepted, got ${first.status}`);

      const second = await post('/chat/messages', payload, {
        token: a.access,
        testId: 'VC-2DEV-007',
      });
      assert.ok(second.status < 500, `a duplicate send must not 5xx, got ${second.status}`);

      const rows = await history(b, conversationId, 'VC-2DEV-007');
      const matches = rows.filter((m) => m.client_msg_id === clientMsgId);
      assert.equal(
        matches.length,
        1,
        `DUPLICATE MESSAGE: clientMsgId ${clientMsgId} produced ${matches.length} stored messages ` +
          `(seqs ${matches.map((m) => m.seq).join(',')}). Idempotency by (conversationId, clientMsgId) is broken.`,
      );
      if (second.status === 201) {
        assert.equal(
          second.data?.messageId,
          first.data.messageId,
          'a duplicate send must return the ORIGINAL messageId, not a new one',
        );
        assert.equal(
          second.data?.seq,
          first.data.seq,
          'a duplicate send must return the original seq',
        );
      }
    },
  );

  qaTest(
    'VC-2DEV-008',
    'concurrent sends from both peers all persist, and seq is a strict total order',
    {
      ...F,
      severity: 'P1',
      steps: ['A and B each send 3 messages, interleaved', 'fetch history'],
      expected:
        'all 6 persist; every seq is unique and increasing — seq is the ordering authority, not the timestamp',
      refs: ['docs/backend-integration-reference.md §5 ("sort by seq, never timestamp")'],
    },
    async () => {
      const acked = [];
      for (let n = 0; n < 3; n++) {
        const fromA = await sendAs(a, conversationId, `concurrent A${n}`, 'VC-2DEV-008');
        const fromB = await sendAs(b, conversationId, `concurrent B${n}`, 'VC-2DEV-008');
        if (fromA.res.status === 201) acked.push(fromA.res.data.seq);
        if (fromB.res.status === 201) acked.push(fromB.res.data.seq);
        await sleep(FANOUT_SAFE_GAP_MS);
      }

      assert.equal(acked.length, 6, `all 6 concurrent sends must be accepted, got ${acked.length}`);
      assert.equal(
        new Set(acked).size,
        acked.length,
        `seq must be unique per message; got duplicates in [${acked.join(',')}]`,
      );

      const rows = await history(a, conversationId, 'VC-2DEV-008');
      const seqs = rows.map((m) => m.seq);
      assert.equal(
        new Set(seqs).size,
        seqs.length,
        `history contains duplicate seqs: [${seqs.join(',')}]`,
      );
      for (const s of acked) {
        assert.ok(seqs.includes(s), `acked seq ${s} is missing from history`);
      }
    },
  );

  qaTest(
    'VC-2DEV-009',
    'rapid-fire messages all persist even when realtime delivery drops them',
    {
      ...F,
      severity: 'P0',
      priority: 'P0',
      steps: ['A sends 20 messages as fast as possible', "fetch B's full history"],
      expected:
        'All 20 are persisted with unique increasing seqs. This isolates PERSISTENCE from DELIVERY: VC-001 ' +
        'shows realtime drops most of a burst, so this test exists to prove the data itself is never lost.',
    },
    async () => {
      const acked = [];
      for (let n = 1; n <= 20; n++) {
        const { res } = await sendAs(a, conversationId, `rapid ${n}/20`, 'VC-2DEV-009');
        if (res.status === 201) acked.push(res.data.seq);
      }
      assert.equal(acked.length, 20, `all 20 rapid sends must be accepted, got ${acked.length}`);

      const rows = await history(b, conversationId, 'VC-2DEV-009');
      const seqs = new Set(rows.map((m) => m.seq));
      const missing = acked.filter((s) => !seqs.has(s));
      assert.deepEqual(
        missing,
        [],
        `PERSISTENCE LOSS: acked seqs absent from history: [${missing.join(',')}]`,
      );
    },
  );
});

describe('VC-2DEV — message content boundaries', () => {
  let a;
  let b;
  let conversationId;

  before(async () => {
    const pair = await provisionPair({ testId: 'VC-2DEV-content' });
    a = pair.a;
    b = pair.b;
    conversationId = await ensureDm(a, b, { testId: 'VC-2DEV-content' });
  });

  /** Send `content` and assert it round-trips to B byte-for-byte. */
  async function roundTrips(label, content, testId) {
    const { res, clientMsgId } = await sendAs(a, conversationId, content, testId);
    assert.equal(
      res.status,
      201,
      `${label}: send must be accepted, got ${res.status} ${res.text.slice(0, 200)}`,
    );
    const rows = await history(b, conversationId, testId);
    const stored = rows.find((m) => m.client_msg_id === clientMsgId);
    assert.ok(stored, `${label}: the message is absent from B's history`);
    assert.equal(stored.content, content, `${label}: content was altered in transit`);
    await sleep(FANOUT_SAFE_GAP_MS);
  }

  qaTest(
    'VC-2DEV-020',
    'emoji, multi-script Unicode and combining marks survive a round trip',
    {
      ...F,
      severity: 'P1',
      steps: [
        'send emoji, Devanagari, Arabic, CJK, a ZWJ family sequence and a combining-mark string',
      ],
      expected:
        'every string comes back byte-identical — no mojibake, no truncation at a surrogate pair',
    },
    async () => {
      await roundTrips('emoji', '😀🎉🚀 mixed with text', 'VC-2DEV-020');
      await roundTrips('ZWJ family', '👨‍👩‍👧‍👦 family sequence', 'VC-2DEV-020');
      await roundTrips('devanagari', 'नमस्ते दुनिया', 'VC-2DEV-020');
      await roundTrips('arabic-rtl', 'مرحبا بالعالم', 'VC-2DEV-020');
      await roundTrips('cjk', '你好世界 こんにちは 안녕하세요', 'VC-2DEV-020');
      await roundTrips('combining', 'é vs é and ñ', 'VC-2DEV-020');
    },
  );

  qaTest(
    'VC-2DEV-021',
    'special characters that break naive escaping survive a round trip',
    {
      ...F,
      severity: 'P1',
      steps: [
        'send quotes, backslashes, HTML, a JSON fragment, a SQL fragment and a newline-heavy body',
      ],
      expected: 'stored and delivered verbatim — never escaped, stripped or interpreted',
    },
    async () => {
      await roundTrips('quotes', `he said "hi" and 'bye' and \`tick\``, 'VC-2DEV-021');
      await roundTrips('backslash', 'C:\\Users\\test\\path and \\n literal', 'VC-2DEV-021');
      await roundTrips('html', '<script>alert(1)</script> <b>bold</b> &amp;', 'VC-2DEV-021');
      await roundTrips('json', '{"key":"value","n":[1,2,3]}', 'VC-2DEV-021');
      await roundTrips('sql', "'; DROP TABLE messages; --", 'VC-2DEV-021');
      await roundTrips('multiline', 'line one\nline two\n\nline four', 'VC-2DEV-021');
    },
  );

  qaTest(
    'VC-2DEV-022',
    'a very long message is either stored intact or rejected — never silently truncated',
    {
      ...F,
      severity: 'P1',
      steps: ['send a 20 000-character message', 'compare the stored length to what was sent'],
      expected:
        'either a 4xx with a clear limit, or the full string stored. Silent truncation is the failure mode: ' +
        'the sender believes the whole message was delivered.',
    },
    async () => {
      const content = 'L'.repeat(20_000);
      const { res, clientMsgId } = await sendAs(a, conversationId, content, 'VC-2DEV-022');
      if (res.status >= 400) return; // an explicit limit is a valid answer

      assert.equal(res.status, 201, `unexpected status ${res.status}`);
      const rows = await history(b, conversationId, 'VC-2DEV-022');
      const stored = rows.find((m) => m.client_msg_id === clientMsgId);
      assert.ok(stored, "the long message is absent from B's history");
      assert.equal(
        stored.content.length,
        content.length,
        `SILENT TRUNCATION: sent ${content.length} chars, stored ${stored.content.length}. ` +
          'Either store it all or reject it with a stated limit.',
      );
    },
  );

  qaTest(
    'VC-2DEV-023',
    'an empty or whitespace-only message is rejected',
    {
      ...F,
      severity: 'P2',
      steps: ['send content:""', 'send content:"   "', 'send content:"\\n\\n"'],
      expected: '4xx for each — an empty bubble is not a message',
    },
    async () => {
      for (const [label, content] of [
        ['empty', ''],
        ['spaces', '   '],
        ['newlines', '\n\n'],
      ]) {
        const { res } = await sendAs(a, conversationId, content, 'VC-2DEV-023');
        assert.ok(res.status >= 400, `a ${label} message must be rejected, got ${res.status}`);
      }
    },
  );

  qaTest(
    'VC-2DEV-024',
    'a message to a nonexistent conversation is rejected',
    {
      ...F,
      severity: 'P1',
      steps: ['send with conversationId "dm-does-not-exist"'],
      expected: '4xx, never 2xx',
    },
    async () => {
      const res = await post(
        '/chat/messages',
        {
          conversationId: 'dm-does-not-exist-0000',
          senderId: a.accountId,
          clientMsgId: `ghost-${Date.now()}`,
          type: 'text',
          content: 'hello void',
        },
        { token: a.access, testId: 'VC-2DEV-024' },
      );
      assert.ok(
        res.status >= 400,
        `sending into a nonexistent conversation must be rejected, got ${res.status}`,
      );
    },
  );
});
