/**
 * Pure sync/outbox decision logic (§L6) — unit-tested WITHOUT a DB (the SQLite adapter is
 * mocked under Jest, so any getDatabase()-touching code can't run here). These lock in the
 * two contracts the DB writers + engine depend on:
 *   - reconcile branch precedence (client_msg_id → seq → insert),
 *   - full-jitter backoff bounds + injectable determinism (no lockstep reconnects).
 *
 * The queued-vs-permanently-failed verdict itself is NOT decided here (VC-029): that's
 * `sendFailurePolicy.ts`'s `classifySendFailure()`, covered by its own test file.
 */
import { reconcileDecision, backoffMs } from '../syncLogic';

describe('reconcileDecision (§L6 dedup)', () => {
  test('own echo: a matching client_msg_id row → UPDATE (wins over seq)', () => {
    expect(
      reconcileDecision({ hasClientMsgIdRow: true, hasSeqRow: false }),
    ).toBe('update');
    // client_msg_id takes precedence even when a seq row also exists
    expect(
      reconcileDecision({ hasClientMsgIdRow: true, hasSeqRow: true }),
    ).toBe('update');
  });

  test('already hold this (conversation, seq) → SKIP (idempotent replay)', () => {
    expect(
      reconcileDecision({ hasClientMsgIdRow: false, hasSeqRow: true }),
    ).toBe('skip');
  });

  test('brand-new message → INSERT', () => {
    expect(
      reconcileDecision({ hasClientMsgIdRow: false, hasSeqRow: false }),
    ).toBe('insert');
  });
});

describe('backoffMs (§M8/§L4 full-jitter, capped)', () => {
  test('rand=0 → floor is exactly half the (un-jittered) ceiling', () => {
    expect(backoffMs(1, { baseMs: 1000, maxMs: 30000, rand: () => 0 })).toBe(
      500,
    );
    expect(backoffMs(2, { baseMs: 1000, maxMs: 30000, rand: () => 0 })).toBe(
      1000,
    );
    expect(backoffMs(3, { baseMs: 1000, maxMs: 30000, rand: () => 0 })).toBe(
      2000,
    );
  });

  test('deterministic with an injected RNG', () => {
    // attempt 1 ceiling=1000, half=500 → round(500 + 0.5*500) = 750
    expect(backoffMs(1, { baseMs: 1000, maxMs: 30000, rand: () => 0.5 })).toBe(
      750,
    );
  });

  test('exponential growth until the cap, then flat at the cap', () => {
    const opts = { baseMs: 1000, maxMs: 30000, rand: () => 0 } as const;
    expect(backoffMs(1, opts)).toBe(500); // 1000/2
    expect(backoffMs(5, opts)).toBe(8000); // (1000*2^4)/2 = 16000/2
    // 1000*2^9 = 512000 > cap 30000 → ceiling clamps to 30000, half = 15000
    expect(backoffMs(10, opts)).toBe(15000);
    expect(backoffMs(50, opts)).toBe(15000);
  });

  test('attempt <= 1 (incl. 0 / negative) uses the base ceiling, never below half-base', () => {
    expect(backoffMs(0, { baseMs: 1000, rand: () => 0 })).toBe(500);
    expect(backoffMs(-5, { baseMs: 1000, rand: () => 0 })).toBe(500);
  });

  test('property: every sample lands within [ceiling/2, ceiling]', () => {
    const base = 1000;
    const cap = 30000;
    for (let attempt = 1; attempt <= 12; attempt++) {
      const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
      for (let i = 0; i < 50; i++) {
        const v = backoffMs(attempt, { baseMs: base, maxMs: cap });
        expect(v).toBeGreaterThanOrEqual(Math.round(ceiling / 2) - 1);
        expect(v).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  test('honours the maxMs cap regardless of RNG', () => {
    for (let i = 0; i < 100; i++) {
      const v = backoffMs(30, { baseMs: 1000, maxMs: 5000 });
      expect(v).toBeLessThanOrEqual(5000);
      expect(v).toBeGreaterThanOrEqual(2499);
    }
  });
});
