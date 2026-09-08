/**
 * New Chat → contact → chat screen (§F2, §M0 rule 2).
 *
 * The DM's conversation id is a pure function of the member pair, and `POST /conversations/dm`
 * is idempotent — so nothing about opening the chat ever needed to wait on the network.
 * `startDm` used to await that POST and return only on success, which meant selecting a contact
 * did nothing at all when offline, and nothing when the request merely failed (cold backend,
 * 5xx, timeout): the caller's `catch` showed an error and never navigated.
 *
 * These tests pin the contract that fixes it: the LOCAL row is written and the id returned
 * without any successful network call, while the server row still converges behind the screen
 * (it must — `conversation.created` is what seeds the realtime membership projection that
 * message fan-out depends on).
 */
import { startDm, ensureDmOnServer, clearStartDmCache } from '../startDm';
import { dmConversationId } from '../../../../infra/db/dmId';

const ME = 'acct_me';
const PEER = 'acct_peer';

const mockCreateDm = jest.fn();
const mockUpsert = jest.fn();
const mockGetProfile = jest.fn();
let mockAccountId: string | undefined = ME;

jest.mock('../../../../infra', () => ({
  createDm: (...a: unknown[]) => mockCreateDm(...a),
  upsertConversation: (...a: unknown[]) => mockUpsert(...a),
  getAccountId: () => mockAccountId,
  dmConversationId: (a: string, b: string) =>
    jest.requireActual('../../../../infra/db/dmId').dmConversationId(a, b),
}));

jest.mock('../../../../core', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../user', () => ({
  getProfile: (...a: unknown[]) => mockGetProfile(...a),
}));

/** Let the fire-and-forget background work settle so we can assert on it. */
const settle = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, 0);
  });

beforeEach(() => {
  jest.clearAllMocks();
  clearStartDmCache();
  mockAccountId = ME;
  mockUpsert.mockResolvedValue(undefined);
  mockCreateDm.mockResolvedValue({
    conversationId: dmConversationId(ME, PEER),
    created: true,
  });
  mockGetProfile.mockResolvedValue({ displayName: 'Ada Lovelace' });
});

describe('startDm', () => {
  it('returns the deterministic id — the same one the server would', async () => {
    await expect(startDm(PEER, 'Ada')).resolves.toBe(
      dmConversationId(ME, PEER),
    );
  });

  it('OPENS THE CHAT WHILE OFFLINE — createDm rejecting must not block it', async () => {
    mockCreateDm.mockRejectedValue(new Error('Network request failed'));
    await expect(startDm(PEER, 'Ada')).resolves.toBe(
      dmConversationId(ME, PEER),
    );
    // and the local row the chat screen renders from was still written
    expect(mockUpsert).toHaveBeenCalledWith(dmConversationId(ME, PEER), {
      type: 'dm',
      name: 'Ada',
      peerId: PEER,
    });
  });

  it('does not wait on the server round-trip before resolving', async () => {
    let release = (): void => {};
    mockCreateDm.mockImplementation(
      () =>
        new Promise(res => {
          release = () => res({ conversationId: dmConversationId(ME, PEER) });
        }),
    );
    // Resolves with the POST still in flight — this is the whole point.
    await expect(startDm(PEER, 'Ada')).resolves.toBe(
      dmConversationId(ME, PEER),
    );
    release();
  });

  it('still creates the DM server-side (seeds the fan-out membership projection)', async () => {
    await startDm(PEER, 'Ada');
    await settle();
    expect(mockCreateDm).toHaveBeenCalledWith(ME, PEER);
  });

  it('uses the saved contact name and skips the directory lookup', async () => {
    await startDm(PEER, 'Ada');
    await settle();
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  it('falls back to the peer id, then renames from the directory in the background', async () => {
    await startDm(PEER);
    // Immediately: labelled by the peer id, so the row is never blank.
    expect(mockUpsert).toHaveBeenCalledWith(dmConversationId(ME, PEER), {
      type: 'dm',
      name: PEER,
      peerId: PEER,
    });
    await settle();
    // Then refined once the profile lands.
    expect(mockUpsert).toHaveBeenCalledWith(dmConversationId(ME, PEER), {
      name: 'Ada Lovelace',
    });
  });

  it('survives a failed directory lookup with the peer id as the label', async () => {
    mockGetProfile.mockRejectedValue(new Error('404'));
    await expect(startDm(PEER)).resolves.toBe(dmConversationId(ME, PEER));
    await settle();
  });

  it('works for a contact there has never been a conversation with', async () => {
    // Nothing local, nothing on the server yet — createDm reports a fresh row.
    mockCreateDm.mockResolvedValue({
      conversationId: dmConversationId(ME, PEER),
      created: true,
    });
    await expect(startDm(PEER, 'New Person')).resolves.toBe(
      dmConversationId(ME, PEER),
    );
  });

  it('refuses without a signed-in account', async () => {
    mockAccountId = undefined;
    await expect(startDm(PEER)).rejects.toThrow('Not signed in.');
  });

  it('refuses a blank peer id', async () => {
    await expect(startDm('   ')).rejects.toThrow();
  });
});

describe('ensureDmOnServer', () => {
  it('POSTs once per conversation, not on every chat open', async () => {
    await ensureDmOnServer(ME, PEER);
    await ensureDmOnServer(ME, PEER);
    await ensureDmOnServer(ME, PEER);
    expect(mockCreateDm).toHaveBeenCalledTimes(1);
  });

  it('retries on the next open after a failure (never caches a failed create)', async () => {
    mockCreateDm.mockRejectedValueOnce(new Error('offline'));
    await ensureDmOnServer(ME, PEER);
    expect(mockCreateDm).toHaveBeenCalledTimes(1);
    await ensureDmOnServer(ME, PEER);
    expect(mockCreateDm).toHaveBeenCalledTimes(2);
  });

  it('never throws — it is background convergence, not a user-facing call', async () => {
    mockCreateDm.mockRejectedValue(new Error('boom'));
    await expect(ensureDmOnServer(ME, PEER)).resolves.toBeUndefined();
  });

  it('also stores the row when the server returns an id we did not predict', async () => {
    mockCreateDm.mockResolvedValue({ conversationId: 'dm-server-decided' });
    await ensureDmOnServer(ME, PEER);
    expect(mockUpsert).toHaveBeenCalledWith('dm-server-decided', {
      type: 'dm',
    });
  });

  it('forgets its cache on logout so the next account re-creates its own DMs', async () => {
    await ensureDmOnServer(ME, PEER);
    clearStartDmCache();
    await ensureDmOnServer(ME, PEER);
    expect(mockCreateDm).toHaveBeenCalledTimes(2);
  });
});
