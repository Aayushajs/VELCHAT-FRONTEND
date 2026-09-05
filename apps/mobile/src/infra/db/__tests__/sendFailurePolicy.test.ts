/**
 * What a failed send MEANS (§L6). This is the difference between WhatsApp behaviour and ours.
 *
 * WhatsApp holds the clock icon indefinitely while it merely cannot reach the server, and shows a
 * red retry marker only when the message itself is unacceptable. Our drain used to treat all eight
 * attempts the same regardless of cause, so ~2 minutes in a tunnel turned every queued message red
 * — and a 429 was classified as "keep draining", which meant one rate-limited burst walked the
 * entire queue, burned an attempt on every message, and painted the whole outbox red in a minute.
 */
import { classifySendFailure } from '../sendFailurePolicy';
import { AppError, type AppErrorKind } from '../../network/errors';

const err = (kind: string): AppError => new AppError(kind as AppErrorKind, 'x');

describe('classifySendFailure', () => {
  describe('reachability problems never make a message fail', () => {
    it.each(['network', 'timeout', 'server'])(
      '%s → retry, keep draining paused',
      kind => {
        const d = classifySendFailure(err(kind), 8);
        expect(d.permanent).toBe(false);
        expect(d.pauseDrain).toBe(true);
      },
    );

    it('stays retryable even past the attempt cap — a tunnel is not a bad message', () => {
      expect(classifySendFailure(err('network'), 99).permanent).toBe(false);
    });

    it('treats an unrecognised throw as transient rather than destroying the message', () => {
      expect(classifySendFailure(new Error('boom'), 99).permanent).toBe(false);
    });
  });

  describe('rate limiting', () => {
    it('pauses the whole drain instead of walking the queue', () => {
      // The old classification kept draining, so ONE 429 burst burned an attempt on every
      // queued message across every conversation.
      const d = classifySendFailure(err('rate_limit'), 1);
      expect(d.pauseDrain).toBe(true);
      expect(d.permanent).toBe(false);
      expect(d.cooldownMs).toBeGreaterThan(0);
    });

    it('honours an explicit Retry-After over the default cooldown', () => {
      const e = new AppError('rate_limit', 'slow down', { retryAfterMs: 9000 });
      expect(classifySendFailure(e, 1).cooldownMs).toBe(9000);
    });
  });

  describe('the message itself is unacceptable', () => {
    it.each(['client', 'auth'])(
      '%s → permanent, surface retry UI immediately',
      kind => {
        const d = classifySendFailure(err(kind), 1);
        expect(d.permanent).toBe(true);
        // No point replaying a rejected payload eight times to reach the same answer.
        expect(d.pauseDrain).toBe(false);
      },
    );

    it('keeps draining the other conversations', () => {
      expect(classifySendFailure(err('client'), 1).pauseDrain).toBe(false);
    });
  });
});
