/**
 * QA regression guards — token store & HTTP client (VC-010, VC-015, VC-034, VC-036).
 *
 * Each test encodes the CORRECT behaviour, so it fails while the defect is present and turns
 * green when the defect is fixed. The bug id is in the test name so a failure points straight at
 * QA/reports/bugs.json and its Jira issue.
 *
 * These are pure/unit tests: no device, no network. The HTTP ones drive the real axios instance
 * through an injected adapter, which is the seam the audit identified as the highest-value one
 * still unexercised.
 */
import type { AxiosRequestConfig } from 'axios';

import { kv, KVKeys } from '../../kv';
import { ensureDeviceKey } from '../../crypto/deviceKey';
import { api, refreshSession } from '../client';
import {
  clearSession,
  hasSession,
  hasValidSession,
  setTokens,
} from '../tokens';

/** Mint a JWT whose `exp` is `offsetSec` from now. Unsigned — only the payload is read locally. */
function jwtWithExp(offsetSec: number): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(
    JSON.stringify({
      account_id: '00000000-0000-4000-8000-0000000000aa',
      device_id: '00000000-0000-4000-8000-0000000000bb',
      iat: now - 10,
      exp: now + offsetSec,
    }),
  ).toString('base64url');
  return `${header}.${claims}.qa-not-a-real-signature`;
}

/** Record every request the axios instance actually emits, and reply with a scripted response. */
interface Captured {
  url: string | undefined;
  method: string | undefined;
  headers: Record<string, unknown>;
  data?: unknown;
}

function installAdapter(
  reply: (
    config: AxiosRequestConfig,
    attempt: number,
  ) => { status: number; data?: unknown; headers?: Record<string, string> },
): { captured: Captured[]; restore: () => void } {
  const captured: Captured[] = [];
  const original = api.defaults.adapter;
  let attempt = 0;

  api.defaults.adapter = (async (config: AxiosRequestConfig) => {
    attempt += 1;
    captured.push({
      url: config.url,
      method: config.method,
      headers: JSON.parse(JSON.stringify(config.headers ?? {})) as Record<
        string,
        unknown
      >,
      data:
        typeof config.data === 'string'
          ? (JSON.parse(config.data) as unknown)
          : config.data,
    });
    const scripted = reply(config, attempt);
    const response = {
      status: scripted.status,
      statusText: String(scripted.status),
      data: scripted.data ?? {
        success: true,
        statusCode: scripted.status,
        message: 'OK',
        data: {},
      },
      headers: scripted.headers ?? {},
      config,
    };
    if (scripted.status >= 400) {
      const err = new Error(
        `Request failed with status code ${scripted.status}`,
      ) as Error & {
        response?: typeof response;
        config?: AxiosRequestConfig;
        isAxiosError?: boolean;
      };
      err.response = response;
      err.config = config;
      err.isAxiosError = true;
      throw err;
    }
    return response;
  }) as NonNullable<typeof api.defaults.adapter>;

  return {
    captured,
    restore: () => {
      if (original === undefined) {
        delete api.defaults.adapter;
      } else {
        api.defaults.adapter = original;
      }
    },
  };
}

beforeEach(() => {
  clearSession();
  kv.delete(KVKeys.accessToken);
  kv.delete(KVKeys.refreshToken);
  kv.delete(KVKeys.cnfJkt);
  kv.delete(KVKeys.devicePrivKey);
});

describe('VC-036 — the cold-start bootstrap must not treat an EXPIRED access token as usable', () => {
  // `hasSession()` itself stays presence-only on purpose: SyncEngine.ts guards its reconnect
  // and 4001-recovery paths with it (e.g. `recoverFromUnauthorized()`), and those must stay
  // true for a token that is merely expired-but-present — that is exactly the case the socket's
  // own 4001 -> refresh -> reconnect self-healing exists to repair. Making `hasSession()` itself
  // expiry-aware would make `connect()`/`onClose()` bail before ever attempting the handshake
  // that triggers that repair, trading a wasted cold-start handshake for realtime stuck
  // disconnected until a force-quit — worse than the bug being fixed. So the fix lives in a
  // narrower function used ONLY by the one caller that must know "is this usable RIGHT NOW":
  // the bootstrap, which must refresh BEFORE opening a socket (useAuth.ts's `useAuthBootstrap`).
  it('hasValidSession() returns false when the stored access token is already past its exp', () => {
    setTokens({
      accountId: 'acct-1',
      deviceId: 'dev-1',
      access: jwtWithExp(-60), // expired a minute ago
      refresh: 'opaque-refresh-token',
    });
    expect(hasValidSession()).toBe(false);
  });

  it('hasValidSession() returns true for a token that is still valid', () => {
    setTokens({
      accountId: 'acct-1',
      deviceId: 'dev-1',
      access: jwtWithExp(600),
      refresh: 'opaque-refresh-token',
    });
    expect(hasValidSession()).toBe(true);
  });

  it('hasValidSession() returns false when there is no session at all', () => {
    expect(hasValidSession()).toBe(false);
  });

  it("hasSession() stays presence-only — an expired token still counts, for SyncEngine's reconnect guards", () => {
    setTokens({
      accountId: 'acct-1',
      deviceId: 'dev-1',
      access: jwtWithExp(-60),
      refresh: 'opaque-refresh-token',
    });
    expect(hasSession()).toBe(true);
  });
});

describe('VC-015 — the refresh request must carry a real cnfJkt device binding', () => {
  it('sends a non-empty cnfJkt thumbprint on POST /auth/token/refresh', async () => {
    // A signed-in device always has a key by the time it can refresh — sign-in itself is either
    // OTP+register (which sends `devicePubkeyBase64`) or device-key login (which needs one to
    // sign the challenge). `ensureDeviceKey()` here just makes that precondition explicit, the
    // same way `setTokens` below makes "a session exists" explicit.
    ensureDeviceKey();
    setTokens({
      accountId: 'acct-1',
      deviceId: 'dev-1',
      access: jwtWithExp(600),
      refresh: 'opaque-refresh-token',
    });

    const sent: unknown[] = [];
    const axios = require('axios') as { post: unknown };
    const originalPost = axios.post;
    (axios as { post: unknown }).post = async (_url: string, body: unknown) => {
      sent.push(body);
      return {
        data: {
          success: true,
          statusCode: 200,
          message: 'OK',
          data: {
            accountId: 'acct-1',
            deviceId: 'dev-1',
            access: jwtWithExp(900),
            refresh: 'next-refresh',
          },
        },
      };
    };

    try {
      await refreshSession();
    } finally {
      (axios as { post: unknown }).post = originalPost;
    }

    expect(sent).toHaveLength(1);
    const body = sent[0] as { refreshToken?: string; cnfJkt?: string };
    expect(body.refreshToken).toBe('opaque-refresh-token');

    // The cnfJkt thumbprint is the ONLY piece of DPoP this backend implements: it binds the
    // refresh token to this device's key. Today no thumbprint is ever computed (deviceKey.ts has
    // no JWK/thumbprint function), so this field is always undefined and a stolen refresh token
    // is redeemable from any device.
    expect(typeof body.cnfJkt).toBe('string');
    expect(body.cnfJkt).not.toBe('');
  });
});

describe('VC-034 — a 429 Retry-After must be clamped, not obeyed unbounded', () => {
  it('does not park a request for a hostile Retry-After', async () => {
    setTokens({
      accountId: 'a',
      deviceId: 'd',
      access: jwtWithExp(600),
      refresh: 'r',
    });

    // A legal, trivially injectable header. `await wait(retryAfter * 1000)` with no ceiling parks
    // the request for 24 hours — and because the wait is OUTSIDE the request, the axios timeout
    // does not apply. A sane client clamps this to a small ceiling.
    const { restore } = installAdapter((_config, attempt) => {
      if (attempt === 1)
        return { status: 429, headers: { 'retry-after': '86400' } };
      return { status: 200 };
    });

    const started = Date.now();
    const MAX_ACCEPTABLE_MS = 15_000;
    try {
      await Promise.race([
        api.get('/health'),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('CLAMP_MISSING')),
            MAX_ACCEPTABLE_MS,
          ),
        ),
      ]);
    } catch (e) {
      const elapsed = Date.now() - started;
      if ((e as Error).message === 'CLAMP_MISSING') {
        throw new Error(
          `Retry-After: 86400 parked the request for at least ${elapsed}ms with no clamp. ` +
            'client.ts:308-312 multiplies the header by 1000 and awaits it with no ceiling, no negative ' +
            'guard and no abort check, and the setTimeout is never cleared.',
        );
      }
      // Any other rejection means the client did NOT sit on the long wait — acceptable.
    } finally {
      restore();
    }
  }, 30_000);
});

describe('VC-010 — sign-out calls must still carry the Authorization header', () => {
  it('sends Authorization on a request issued immediately before a synchronous session clear', async () => {
    setTokens({
      accountId: 'acct-1',
      deviceId: 'dev-1',
      access: jwtWithExp(600),
      refresh: 'opaque-refresh-token',
    });

    const { captured, restore } = installAdapter(() => ({ status: 200 }));
    try {
      // This is exactly authStore.signOut()'s shape: fire the authenticated call, then clear the
      // session synchronously. Axios runs the request interceptor in a MICROTASK (it is not
      // registered with {synchronous:true}), so the interceptor reads the token AFTER clearSession()
      // has deleted it — and the logout / push-endpoint-clear calls go out unauthenticated.
      const inFlight = api.post('/auth/logout', {
        refreshToken: 'opaque-refresh-token',
      });
      clearSession();
      await inFlight;
    } finally {
      restore();
    }

    expect(captured).toHaveLength(1);
    const first = captured[0];
    const auth = first?.headers.Authorization ?? first?.headers.authorization;
    expect(String(auth ?? '')).toMatch(/^Bearer \S+/);
  });
});
