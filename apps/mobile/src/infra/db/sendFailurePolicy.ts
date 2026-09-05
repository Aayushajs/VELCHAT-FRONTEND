/**
 * What a failed send means (§L6) — pure policy, NO I/O.
 *
 * The distinction that matters to a user is not "how many attempts" but WHY it failed:
 *
 *   - We could not reach the server. The message is fine. WhatsApp keeps the clock icon
 *     indefinitely here, and so do we — a two-minute tunnel must never produce a screen of red
 *     retry markers the user has to tap one by one.
 *   - The server refused THIS message (malformed, forbidden). Replaying it eight times reaches the
 *     same answer eight times, so surface the retry affordance immediately.
 *   - We are rate limited. Nothing is wrong with the message, and the correct response is to stop
 *     the entire drain for a cooldown — not to walk to the next conversation and try again, which
 *     is precisely how one 429 burst used to burn an attempt on every queued message.
 */
import { isAppError, type AppError } from '../network/errors';

export interface SendFailureDecision {
  /** Surface the red "failed — tap to retry" bubble. Reserved for a refusal of THIS message. */
  permanent: boolean;
  /** Stop this drain pass; the self-adjusting timer resumes it. */
  pauseDrain: boolean;
  /** Minimum wait before the next attempt, when the server told us to slow down. */
  cooldownMs: number;
}

/** Default pause when rate limited without a usable `Retry-After`. */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5_000;

/**
 * Decide the fate of a send that threw. `attempts` is the count AFTER this failure; it is
 * deliberately NOT the deciding factor for reachability errors — persistence is not a defect.
 */
export function classifySendFailure(
  error: unknown,
  _attempts: number,
): SendFailureDecision {
  if (!isAppError(error)) {
    // An unrecognised throw is more likely a transient runtime/network edge than proof that the
    // message is bad. Never destroy a user's message on a guess.
    return { permanent: false, pauseDrain: true, cooldownMs: 0 };
  }
  const e = error as AppError & { retryAfterMs?: number };
  switch (e.kind) {
    case 'network':
    case 'timeout':
    case 'server':
      return { permanent: false, pauseDrain: true, cooldownMs: 0 };
    case 'rate_limit':
      return {
        permanent: false,
        pauseDrain: true,
        cooldownMs:
          typeof e.retryAfterMs === 'number' && e.retryAfterMs > 0
            ? e.retryAfterMs
            : DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      };
    case 'canceled':
      return { permanent: false, pauseDrain: true, cooldownMs: 0 };
    default:
      // client / auth / unknown-4xx — the server rejected this specific message.
      return { permanent: true, pauseDrain: false, cooldownMs: 0 };
  }
}
