/**
 * Token refresh must distinguish "the server said no" from "we could not ask" (§L3, §R2).
 *
 * These are opposite situations that used to collapse into the same `null`:
 *   - the refresh token is revoked/expired  → the session really is over → sign out
 *   - the request timed out / DNS failed / the backend was asleep or 502 → the session is
 *     FINE, we simply could not reach it → keep it and retry later
 *
 * Collapsing them means a sleeping free-tier service, a VM that shuts down at 19:30, or a
 * train tunnel silently destroys a perfectly valid session and drops the user back on the
 * sign-in screen — the "it asks me to log in every time" bug. No messenger does this.
 */
import axios from 'axios';
import { refreshSession } from '../client';
import { setTokens, getRefreshToken, getAccessToken } from '../tokens';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return {
    __esModule: true,
    default: {
      ...actual.default,
      post: jest.fn(),
      create: actual.default.create,
    },
  };
});

const mockedPost = axios.post as unknown as jest.Mock;

/** An axios-shaped rejection: `response` present = the server answered. */
function httpError(status: number): unknown {
  return {
    isAxiosError: true,
    response: { status, data: {}, headers: {} },
    config: {},
    message: `Request failed with status code ${status}`,
  };
}

/** An axios-shaped rejection with NO response: the server was never reached. */
function transportError(code: string): unknown {
  return { isAxiosError: true, code, config: {}, message: code };
}

describe('refreshSession — server refusal vs unreachable server', () => {
  beforeEach(() => {
    mockedPost.mockReset();
    setTokens({ access: 'stale-access', refresh: 'good-refresh' });
  });

  it('returns the new access token when the server refreshes', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { data: { access: 'fresh-access', refresh: 'next-refresh' } },
    });

    const outcome = await refreshSession();

    expect(outcome.status).toBe('ok');
    expect(getAccessToken()).toBe('fresh-access');
    expect(getRefreshToken()).toBe('next-refresh');
  });

  it.each([
    ['timeout', transportError('ECONNABORTED')],
    ['no network', transportError('ERR_NETWORK')],
    ['backend asleep (502)', httpError(502)],
    ['backend overloaded (503)', httpError(503)],
    ['rate limited (429)', httpError(429)],
  ])(
    'keeps the session when the server is unreachable: %s',
    async (_label, err) => {
      mockedPost.mockRejectedValueOnce(err);

      const outcome = await refreshSession();

      expect(outcome.status).toBe('unavailable');
      // The session must survive — this is a network problem, not an auth problem.
      expect(getRefreshToken()).toBe('good-refresh');
    },
  );

  it.each([
    ['unauthorized', httpError(401)],
    ['forbidden', httpError(403)],
    ['revoked/unknown token', httpError(400)],
  ])('reports an authoritative rejection: %s', async (_label, err) => {
    mockedPost.mockRejectedValueOnce(err);

    const outcome = await refreshSession();

    expect(outcome.status).toBe('rejected');
  });

  it('treats a missing refresh token as a rejection (nothing to refresh with)', async () => {
    setTokens({ access: 'a', refresh: '' });
    const outcome = await refreshSession();
    expect(outcome.status).toBe('rejected');
    expect(mockedPost).not.toHaveBeenCalled();
  });
});
