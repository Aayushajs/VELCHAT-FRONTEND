/**
 * "My photo changed" has to reach the caches that are already showing the old one (§M0 rule 7).
 *
 * A profile photo is read through several independent caches — the profile response cache, the
 * resolved-avatar cache in RAM and on disk, and the peer photo denormalised onto each
 * conversation row. The WRITE path (upload → PUT avatarMediaId) told none of them, so after a
 * successful change every surface kept serving its cached copy until its own TTL expired or the
 * process died. That is exactly "it only updates after I close and reopen the app", and the same
 * staleness applies to a PEER changing their photo.
 *
 * One announcement, many listeners: whoever caches a profile subscribes and drops that account.
 */
import {
  publishProfileChanged,
  subscribeProfileChanged,
} from '../profileEvents';

describe('profileChanged', () => {
  it('tells every subscriber which account changed', () => {
    const a = jest.fn();
    const b = jest.fn();
    const offA = subscribeProfileChanged(a);
    const offB = subscribeProfileChanged(b);

    publishProfileChanged('acc_1');

    expect(a).toHaveBeenCalledWith('acc_1');
    expect(b).toHaveBeenCalledWith('acc_1');
    offA();
    offB();
  });

  it('stops delivering after unsubscribe (§M7: every listener is disposable)', () => {
    const fn = jest.fn();
    const off = subscribeProfileChanged(fn);
    off();

    publishProfileChanged('acc_1');

    expect(fn).not.toHaveBeenCalled();
  });

  it('ignores an empty account id rather than invalidating everything', () => {
    const fn = jest.fn();
    const off = subscribeProfileChanged(fn);

    publishProfileChanged('');

    expect(fn).not.toHaveBeenCalled();
    off();
  });

  it('one throwing subscriber cannot stop the others', () => {
    // These callbacks purge caches. If the first one to throw stopped the fan-out, the rest
    // would keep serving the stale photo — the very bug this exists to prevent.
    const boom = jest.fn(() => {
      throw new Error('cache purge failed');
    });
    const after = jest.fn();
    const offBoom = subscribeProfileChanged(boom);
    const offAfter = subscribeProfileChanged(after);

    expect(() => publishProfileChanged('acc_1')).not.toThrow();
    expect(after).toHaveBeenCalledWith('acc_1');
    offBoom();
    offAfter();
  });

  it('survives a subscriber that unsubscribes during dispatch', () => {
    const second = jest.fn();
    let offSecond = (): void => undefined;
    const offFirst = subscribeProfileChanged(() => {
      offSecond();
    });
    offSecond = subscribeProfileChanged(second);

    expect(() => publishProfileChanged('acc_1')).not.toThrow();
    offFirst();
    offSecond();
  });
});
