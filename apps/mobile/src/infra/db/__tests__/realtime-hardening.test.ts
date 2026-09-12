/**
 * Comprehensive Realtime & Offline Hardening Test Suite (§L6, §M8, §F2)
 *
 * Verifies:
 * 1. Offline outbox queuing (20 messages) & crash recovery (recoverStuckSends)
 * 2. Idempotent retries using stable clientMsgId
 * 3. Message sequence ordering & out-of-order reconciliation (101, 103, 102)
 * 4. Catch-up vs live WebSocket race deduplication
 * 5. Monotonic receipt progression (never downgrade read -> delivered -> sent)
 * 6. Multi-device sync & own-echo reconciliation
 */
import { getDatabase } from '../database';
import {
  sendMessageLocal,
  applyServerMessages,
  applyServerMessage,
  markMessageSent,
  applyReceipt,
  maxSeqForConversation,
} from '../messages';
import {
  enqueueSend,
  claimNextDue,
  markAckd,
  markFailed,
  recoverStuckSends,
  requeueFailed,
  outboxStats,
} from '../outbox';
import { purgeAllLocalChat, upsertConversation } from '../queries';
import { Message } from '../models';

describe('Realtime & Offline-First Hardening Suite', () => {
  const convId = 'conv_test_123';
  const meId = 'user_me_001';

  beforeEach(async () => {
    await purgeAllLocalChat();
    await upsertConversation(convId, {
      type: 'dm',
      name: 'Alice',
      lastMessagePreview: '',
      lastMessageAt: 0,
    });
  });

  describe('1. Offline Outbox Batching & Crash Recovery', () => {
    test('enqueues 20 messages offline and drains in strict FIFO without loss', async () => {
      const clientMsgIds: string[] = [];

      // Send 20 messages offline
      for (let i = 1; i <= 20; i++) {
        const text = `Offline Message ${i}`;
        const clientMsgId = await sendMessageLocal(convId, text, meId);
        expect(clientMsgId).toBeTruthy();
        if (clientMsgId) {
          clientMsgIds.push(clientMsgId);
          await enqueueSend(convId, clientMsgId, {
            conversationId: convId,
            senderId: meId,
            clientMsgId,
            content: text,
          });
        }
      }

      expect(clientMsgIds.length).toBe(20);

      // Verify all 20 exist in local DB as sending
      const db = getDatabase();
      const initialMsgs = await db.get<Message>('messages').query().fetch();
      expect(initialMsgs.length).toBe(20);
      expect(initialMsgs.every(m => m.state === 'sending')).toBe(true);

      const stats = await outboxStats();
      expect(stats.queued).toBe(20);

      // Simulate draining the outbox item by item
      for (let i = 0; i < 20; i++) {
        const item = await claimNextDue(Date.now() + 1000);
        expect(item).not.toBeNull();
        expect(item?.clientMsgId).toBe(clientMsgIds[i]);

        // Single-flight guarantee: while one is sending, claimNextDue returns null for this conv
        const concurrentClaim = await claimNextDue(Date.now() + 1000);
        expect(concurrentClaim).toBeNull();

        // Simulate server ACK
        const serverSeq = i + 1;
        await markMessageSent(item!.clientMsgId, {
          messageId: `srv_msg_${serverSeq}`,
          seq: serverSeq,
          serverTs: Date.now(),
        });
        await markAckd(item!.id);
      }

      // Verify all 20 are now sent with contiguous seqs
      const finalMsgs = await db.get<Message>('messages').query().fetch();
      expect(finalMsgs.length).toBe(20);
      expect(finalMsgs.every(m => m.state === 'sent')).toBe(true);
      expect(
        finalMsgs.map(m => m.seq).sort((a, b) => (a ?? 0) - (b ?? 0)),
      ).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

      const finalStats = await outboxStats();
      expect(finalStats.queued).toBe(0);
    });

    test('recovers stuck in-flight sends after simulated app kill/restart', async () => {
      const clientMsgId = await sendMessageLocal(
        convId,
        'Crash recovery test',
        meId,
      );
      expect(clientMsgId).toBeTruthy();
      await enqueueSend(convId, clientMsgId!, {
        conversationId: convId,
        senderId: meId,
        clientMsgId: clientMsgId!,
        content: 'Crash recovery test',
      });

      // Claim item (flips state to sending)
      const item = await claimNextDue(Date.now() + 1000);
      expect(item).not.toBeNull();

      // App killed here! (item left in sending state)
      // On app restart, recoverStuckSends is invoked
      const recoveredCount = await recoverStuckSends();
      expect(recoveredCount).toBe(1);

      // Queue is now unblocked and item can be claimed again with identical clientMsgId
      const reClaimed = await claimNextDue(Date.now() + 1000);
      expect(reClaimed).not.toBeNull();
      expect(reClaimed?.clientMsgId).toBe(clientMsgId);

      await markMessageSent(reClaimed!.clientMsgId, {
        messageId: 'srv_msg_100',
        seq: 100,
      });
      await markAckd(reClaimed!.id);
    });
  });

  describe('2. Idempotent Retries & Duplicate Prevention', () => {
    test('retrying failed send preserves clientMsgId and produces single local record', async () => {
      const clientMsgId = await sendMessageLocal(
        convId,
        'Network flake message',
        meId,
      );
      await enqueueSend(convId, clientMsgId!, {
        conversationId: convId,
        senderId: meId,
        clientMsgId: clientMsgId!,
        content: 'Network flake message',
      });

      const item = await claimNextDue(Date.now() + 1000);
      expect(item).not.toBeNull();

      // Mark permanently failed — the policy decision (VC-029: attempt count alone never
      // decides this; see sendFailurePolicy.ts), not merely "8 attempts happened".
      await markFailed(item!.id, 'Network error 503', 8, true);

      // Simulate manual retry
      const requeued = await requeueFailed(clientMsgId!);
      expect(requeued).toBe(true);

      const retryItem = await claimNextDue(Date.now() + 1000);
      expect(retryItem?.clientMsgId).toBe(clientMsgId);

      // Server returns ACK
      await markMessageSent(clientMsgId!, {
        messageId: 'srv_msg_200',
        seq: 200,
      });
      await markAckd(retryItem!.id);

      const db = getDatabase();
      const msgs = await db.get<Message>('messages').query().fetch();
      expect(msgs.length).toBe(1);
      expect(msgs[0]!.clientMsgId).toBe(clientMsgId);
      expect(msgs[0]!.seq).toBe(200);
      expect(msgs[0]!.state).toBe('sent');
    });

    test('VC-029: a retryable cause stays queued no matter how many attempts have piled up', async () => {
      // The exact defect: markFailed used to fall back to an attempt-count threshold (8) when
      // `permanent` was omitted, so a message could be auto-failed by attempt count alone —
      // contradicting sendFailurePolicy.ts's own contract that a reachability problem (the
      // phone in a tunnel, say) retries forever and is never the message's fault. `permanent`
      // is now a required, explicit policy decision; passing `false` at a high attempt count
      // must still leave the row queued for another try.
      const clientMsgId = await sendMessageLocal(
        convId,
        'Stuck behind a bad connection',
        meId,
      );
      await enqueueSend(convId, clientMsgId!, {
        conversationId: convId,
        senderId: meId,
        clientMsgId: clientMsgId!,
        content: 'Stuck behind a bad connection',
      });
      const item = await claimNextDue(Date.now() + 1000);
      expect(item).not.toBeNull();

      await markFailed(item!.id, 'Network error 503', 99, false);

      const requeued = await requeueFailed(clientMsgId!);
      // requeueFailed only ever matches state:'failed' rows — false proves this one is NOT
      // failed, i.e. it stayed in the retry queue despite the high attempt count.
      expect(requeued).toBe(false);
      const stats = await outboxStats();
      expect(stats.queued).toBeGreaterThan(0);
    });
  });

  describe('3. Ordering & Out-of-Order Delivery (101, 103, 102)', () => {
    test('handles out-of-order server messages and maintains sequence integrity', async () => {
      const peerId = 'user_peer_002';
      const now = Date.now();

      // Inbound messages arrive out-of-order: 101, then 103, then 102
      await applyServerMessage({
        messageId: 'srv_101',
        conversationId: convId,
        seq: 101,
        senderId: peerId,
        type: 'text',
        content: 'Msg 101',
        serverTs: now + 100,
      });

      await applyServerMessage({
        messageId: 'srv_103',
        conversationId: convId,
        seq: 103,
        senderId: peerId,
        type: 'text',
        content: 'Msg 103',
        serverTs: now + 300,
      });

      await applyServerMessage({
        messageId: 'srv_102',
        conversationId: convId,
        seq: 102,
        senderId: peerId,
        type: 'text',
        content: 'Msg 102',
        serverTs: now + 200,
      });

      const maxSeq = await maxSeqForConversation(convId);
      expect(maxSeq).toBe(103);

      const db = getDatabase();
      const rows = await db.get<Message>('messages').query().fetch();
      expect(rows.length).toBe(3);

      const seqs = rows.map(r => r.seq).sort((a, b) => (a ?? 0) - (b ?? 0));
      expect(seqs).toEqual([101, 102, 103]);
    });
  });

  describe('4. Catch-Up vs Live WebSocket Race', () => {
    test('reconciles simultaneous catch-up and live message arrivals without duplicates', async () => {
      const peerId = 'user_peer_002';

      // Live frame arrives first for seq 50
      await applyServerMessage({
        messageId: 'srv_50',
        conversationId: convId,
        seq: 50,
        senderId: peerId,
        type: 'text',
        content: 'Live Seq 50',
      });

      // Catch-up batch subsequently returns seqs 49, 50, 51
      await applyServerMessages([
        {
          messageId: 'srv_49',
          conversationId: convId,
          seq: 49,
          senderId: peerId,
          type: 'text',
          content: 'Catchup Seq 49',
        },
        {
          messageId: 'srv_50',
          conversationId: convId,
          seq: 50,
          senderId: peerId,
          type: 'text',
          content: 'Catchup Seq 50 (Duplicate)',
        },
        {
          messageId: 'srv_51',
          conversationId: convId,
          seq: 51,
          senderId: peerId,
          type: 'text',
          content: 'Catchup Seq 51',
        },
      ]);

      const db = getDatabase();
      const rows = await db.get<Message>('messages').query().fetch();
      expect(rows.length).toBe(3);

      const seqs = rows.map(r => r.seq).sort((a, b) => (a ?? 0) - (b ?? 0));
      expect(seqs).toEqual([49, 50, 51]);
    });
  });

  describe('5. Receipt Monotonicity (Never Downgrade)', () => {
    test('preserves monotonic state: read -> delivered does NOT downgrade', async () => {
      // Mock account ID
      jest
        .spyOn(require('../../network/tokens'), 'getAccountId')
        .mockReturnValue(meId);

      // Create own sent message
      const clientMsgId = await sendMessageLocal(
        convId,
        'Receipt test message',
        meId,
      );
      await markMessageSent(clientMsgId!, {
        messageId: 'srv_receipt_1',
        seq: 10,
      });

      const db = getDatabase();
      let msg = (await db.get<Message>('messages').query().fetch())[0]!;
      expect(msg.state).toBe('sent');

      // Delivered receipt arrives
      await applyReceipt(convId, 10, 'delivered');
      msg = (await db.get<Message>('messages').query().fetch())[0]!;
      expect(msg.state).toBe('delivered');

      // Read receipt arrives
      await applyReceipt(convId, 10, 'read');
      msg = (await db.get<Message>('messages').query().fetch())[0]!;
      expect(msg.state).toBe('read');

      // Delayed out-of-order delivered receipt arrives -> MUST REMAIN READ
      await applyReceipt(convId, 10, 'delivered');
      msg = (await db.get<Message>('messages').query().fetch())[0]!;
      expect(msg.state).toBe('read');
    });
  });

  describe('6. Multi-Device & Own Echo Reconciliation', () => {
    test('own echo from another device cleans up optimistic duplicate if raced', async () => {
      jest
        .spyOn(require('../../network/tokens'), 'getAccountId')
        .mockReturnValue(meId);

      const clientMsgId = await sendMessageLocal(
        convId,
        'Multi-device message',
        meId,
      );

      // Live echo from server arrives via WebSocket before REST ack returns
      await applyServerMessage({
        messageId: 'srv_md_1',
        conversationId: convId,
        clientMsgId: clientMsgId!,
        seq: 500,
        senderId: meId,
        type: 'text',
        content: 'Multi-device message',
      });

      // Now REST ack returns for the same clientMsgId
      await markMessageSent(clientMsgId!, {
        messageId: 'srv_md_1',
        seq: 500,
      });

      const db = getDatabase();
      const rows = await db.get<Message>('messages').query().fetch();
      expect(rows.length).toBe(1);
      expect(rows[0]!.seq).toBe(500);
      expect(rows[0]!.state).toBe('sent');
    });
  });
});
