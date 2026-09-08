/**
 * Why push cannot reach this user, and a one-tap way to fix it.
 *
 * WhatsApp does exactly this, and for the same reason: on Android an app can be *correctly
 * configured* and still receive nothing, because Doze or an OEM power manager refuses to start
 * it for a data message. FCM reports the push delivered; the app never runs. There is no error
 * to log and no callback to observe — the only honest thing an app can do is tell the user which
 * switch is off and take them to it.
 *
 * It also costs the SENDER their second tick, which is why this is not a cosmetic nag: a service
 * that never starts cannot acknowledge delivery, so the other person is left on one grey tick
 * for a message that reached the handset.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import {
  getPushBlocker,
  resolvePushBlocker,
  type PushBlocker,
} from '../../../infra';
import { kv } from '../../../infra';

/**
 * Dismissals are remembered for a week, not forever.
 *
 * Forever would mean a user who dismissed once never learns why their messages are silent
 * months later. Re-asking on every launch would be the nag Play penalises. A week is long
 * enough to be respectful and short enough that a real problem resurfaces.
 */
const KV_DISMISSED_UNTIL = 'push.blocker.dismissedUntil';
const DISMISS_FOR_MS = 7 * 24 * 60 * 60 * 1000;

function dismissedNow(): boolean {
  const until = Number(kv.getString(KV_DISMISSED_UNTIL) ?? '0');
  return Number.isFinite(until) && until > Date.now();
}

export interface PushBlockerState {
  /** The blocker worth showing the user, or null when there is nothing to say. */
  blocker: PushBlocker | null;
  /** Open the relevant system screen. Safe to call from an onPress. */
  fix: () => void;
  /** Hide it for a week. */
  dismiss: () => void;
}

export function usePushBlocker(): PushBlockerState {
  const [blocker, setBlocker] = useState<PushBlocker | null>(null);

  const check = useCallback(() => {
    if (dismissedNow()) {
      setBlocker(null);
      return;
    }
    void getPushBlocker()
      .then(b => {
        // `unsupported` is not actionable — a build with no Firebase config, or a device with no
        // Play Services. Telling the user to change a setting would be a lie.
        setBlocker(b === 'unsupported' ? null : b);
      })
      .catch(() => setBlocker(null));
  }, []);

  useEffect(() => {
    check();
    // Re-check on every foreground: the whole point is that the user goes to Settings, changes
    // the switch, and comes back. Without this the banner would still be there.
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') check();
    });
    return () => sub.remove();
  }, [check]);

  const fix = useCallback(() => {
    if (!blocker) return;
    void resolvePushBlocker(blocker).finally(() => {
      // Do not clear it optimistically — the user may cancel the dialog. The foreground
      // re-check above is what removes the banner, and only once it is genuinely fixed.
    });
  }, [blocker]);

  const dismiss = useCallback(() => {
    kv.set(KV_DISMISSED_UNTIL, String(Date.now() + DISMISS_FOR_MS));
    setBlocker(null);
  }, []);

  return { blocker, fix, dismiss };
}
