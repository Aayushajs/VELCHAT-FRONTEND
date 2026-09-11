/**
 * Auth flow hooks — bridge device-key (infra/crypto) + auth API + AuthMachine.
 * Screens (feature-ui) call these; they never touch infra directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ensureDeviceKey,
  isAppError,
  requestNotificationPermission,
  hasNotificationPermission,
  hasDeviceKey,
  signChallenge,
  hasValidSession,
  getRefreshToken,
  refreshAccessToken,
  getDeviceId,
  getAccountId,
  kv,
  KVKeys,
  useKVString,
  type NotificationPermission,
} from '../../../infra';
import {
  register,
  fetchSession,
  sendOtp,
  verifyOtp,
  requestChallenge,
  loginWithDeviceKey,
  getAccountInfo,
} from '../api/authApi';
import { useAuthStore } from '../model/authStore';

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40; // ~2 min

export function useStartPhoneAuth(): {
  start: (phone: string) => Promise<boolean>;
  loading: boolean;
  error: string | null;
} {
  const beginVerify = useAuthStore(s => s.beginVerify);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (phone: string): Promise<boolean> => {
      setLoading(true);
      setError(null);
      try {
        const devicePubkeyBase64 = ensureDeviceKey();
        const { sessionId } = await register(phone, devicePubkeyBase64);
        beginVerify(phone, sessionId);
        return true;
      } catch (e) {
        setError(
          isAppError(e)
            ? e.message
            : 'Could not start sign-in. Please try again.',
        );
        return false;
      } finally {
        setLoading(false);
      }
    },
    [beginVerify],
  );

  return { start, loading, error };
}

export function useSessionPolling(): {
  verified: boolean;
  timedOut: boolean;
  begin: () => void;
  stop: () => void;
} {
  const sessionId = useAuthStore(s => s.sessionId);
  const provision = useAuthStore(s => s.provision);
  const [verified, setVerified] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const begin = useCallback(() => {
    if (!sessionId) return;
    attempts.current = 0;
    setTimedOut(false);
    const tick = async (): Promise<void> => {
      attempts.current += 1;
      try {
        const tokens = await fetchSession(sessionId);
        provision(tokens); // → active
        setVerified(true);
        stop();
      } catch {
        if (attempts.current >= MAX_POLLS) {
          setTimedOut(true);
          stop();
          return;
        }
        timer.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      }
    };
    void tick();
  }, [sessionId, provision, stop]);

  return { verified, timedOut, begin, stop };
}

/**
 * 2Factor SMS/voice OTP flow (§B2 additive) for the in-sheet phone→code experience.
 * `send` requests a code (returning the resend + expiry windows for the UI timers);
 * `verify` checks it AND provisions the session — on a correct code the backend
 * returns real tokens which we persist, so the user stays logged in (no re-OTP next
 * launch). Reports success/failure; the caller advances into the app.
 */
export function useOtpAuth(): {
  send: (
    phone: string,
  ) => Promise<{ ok: boolean; resendAfter: number; expiresIn: number }>;
  verify: (phone: string, code: string) => Promise<boolean>;
  sending: boolean;
  verifying: boolean;
  error: string | null;
  clearError: () => void;
} {
  const provision = useAuthStore(s => s.provision);
  const rememberPhone = useAuthStore(s => s.rememberPhone);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-entrancy guard: OtpInput auto-fires onComplete at full length, and the field stays
  // editable during verify — backspacing + retyping the last digit could fire a second
  // verifyOtp (double provision / racing responses). This blocks a concurrent verify.
  const verifyInFlight = useRef(false);

  const send = useCallback(
    async (
      phone: string,
    ): Promise<{ ok: boolean; resendAfter: number; expiresIn: number }> => {
      setSending(true);
      setError(null);
      try {
        const res = await sendOtp(phone);
        return {
          ok: true,
          resendAfter: res.resendAfter ?? 120,
          expiresIn: res.expiresIn ?? 900,
        };
      } catch (e) {
        setError(
          isAppError(e)
            ? e.message
            : 'Could not send the code. Please try again.',
        );
        return { ok: false, resendAfter: 0, expiresIn: 0 };
      } finally {
        setSending(false);
      }
    },
    [],
  );

  const verify = useCallback(
    async (phone: string, code: string): Promise<boolean> => {
      if (verifyInFlight.current) return false;
      verifyInFlight.current = true;
      setVerifying(true);
      setError(null);
      try {
        const devicePubkeyBase64 = ensureDeviceKey();
        const tokens = await verifyOtp(
          phone,
          code,
          'android',
          devicePubkeyBase64,
        );
        // A verified OTP is not a completed sign-in until the backend's token pair
        // has been durably stored. Never navigate to the app without it: doing so
        // would make the next cold launch fall back to Welcome/Login.
        if (!tokens?.access || !tokens?.refresh) {
          setError("We couldn't finish signing you in. Please try again.");
          return false;
        }
        // Persist the verified number so the Profile page can show it (the active OTP
        // flow, unlike reverse-OTP, otherwise never records it).
        rememberPhone(phone);
        provision(tokens); // → state 'active' (stays logged in next launch)
        return true;
      } catch (e) {
        setError(
          isAppError(e)
            ? e.message
            : 'That code is wrong or expired. Try again.',
        );
        return false;
      } finally {
        setVerifying(false);
        verifyInFlight.current = false;
      }
    },
    [provision, rememberPhone],
  );

  const clearError = useCallback(() => setError(null), []);

  return { send, verify, sending, verifying, error, clearError };
}

/**
 * Notification-permission onboarding step. `request` shows the OS dialog (Android
 * 13+) and resolves with the outcome; onboarding proceeds regardless of the choice.
 * `check` reports whether it's currently GRANTED — the gate uses this so the page
 * keeps appearing while permission is missing/denied, and is skipped once granted.
 */
export function useRequestNotifications(): {
  request: () => Promise<NotificationPermission>;
  check: () => Promise<boolean>;
  busy: boolean;
} {
  const [busy, setBusy] = useState(false);
  const request = useCallback(async (): Promise<NotificationPermission> => {
    setBusy(true);
    try {
      return await requestNotificationPermission();
    } finally {
      setBusy(false);
    }
  }, []);
  const check = useCallback(() => hasNotificationPermission(), []);
  return { request, check, busy };
}

/**
 * Launch bootstrap — decides the starting auth state. A stored session → ready at
 * once. Otherwise, if this device still holds its key + device id, silently
 * re-login via the device-key challenge (§B2.5, NO OTP) and provision fresh tokens;
 * any failure leaves the user signed-out (onboarding). Returns true once decided —
 * the app shows a splash until then, so there's no onboarding→home flicker.
 */
/**
 * Watch the persisted access token: if it vanishes while the machine is still `active`
 * (the network client cleared it after a refresh that couldn't be recovered — a revoked or
 * expired session), flip the machine to `signed_out`. The navigator observes that and
 * reactively resets to sign-in, so a mid-session expiry can't strand the user on a zombie
 * "logged-in" screen. Reactive via the encrypted-MMKV hook — no polling.
 */
export function useSessionWatch(): void {
  const token = useKVString(KVKeys.accessToken);
  const state = useAuthStore(s => s.state);
  const sessionExpired = useAuthStore(s => s.sessionExpired);
  useEffect(() => {
    if (!token && state === 'active') sessionExpired();
  }, [token, state, sessionExpired]);
}

export function useAuthBootstrap(): boolean {
  const [ready, setReady] = useState(false);
  const provision = useAuthStore(s => s.provision);
  const hydrate = useAuthStore(s => s.hydrate);

  useEffect(() => {
    // `hasValidSession()`, not merely "a token exists" (VC-036): an access token that is present
    // but EXPIRED must fall through to the refresh branch below, not hydrate straight away — that
    // used to hand SyncEngine a token the server was certain to reject, costing a guaranteed
    // failed handshake + refresh + reconnect on every cold start after 15 minutes idle.
    if (hasValidSession()) {
      hydrate();
      setReady(true);
      return undefined;
    }
    let active = true;
    const run = async (): Promise<void> => {
      try {
        // The backend issues rotating refresh tokens. Prefer that persisted session
        // before asking the device-key endpoint for a new challenge.
        if (getRefreshToken()) {
          const access = await refreshAccessToken();
          if (access && active) {
            hydrate();
            return;
          }
        }
        const deviceId = getDeviceId();
        if (!hasDeviceKey() || !deviceId) return;
        const { nonce } = await requestChallenge(deviceId);
        const signature = signChallenge(nonce);
        const tokens = await loginWithDeviceKey(deviceId, signature);
        if (active) provision(tokens);
      } catch {
        // stay signed out — onboarding handles a fresh sign-in
      } finally {
        if (active) setReady(true);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [hydrate, provision]);

  return ready;
}

/**
 * Refresh the account snapshot (verified phone/email + created/last-active timestamps)
 * from the backend and mirror it into MMKV so the Profile page shows SERVER truth, not a
 * client guess. Offline-first + graceful: any failure (offline, or the endpoint not
 * deployed yet) is a no-op — the local mirror already rendered. Runs once on mount.
 */
export function useAccountInfo(): void {
  useEffect(() => {
    const accountId = getAccountId();
    if (!accountId) return undefined;
    let active = true;
    getAccountInfo(accountId)
      .then(info => {
        if (!active || !info) return;
        if (info.phone) kv.set(KVKeys.phone, info.phone);
        if (info.email) kv.set(KVKeys.email, info.email);
        // NOTE: do NOT mirror lastActiveAt → loginAt. The backend never bumps
        // accounts.last_active_at (it equals created_at), so it would make "Last login"
        // always equal "Member since". Keep the client-stamped loginAt (set on each
        // provision — actually accurate) until the server updates it on token issue.
        if (info.createdAt) kv.set(KVKeys.memberSince, info.createdAt);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
}
