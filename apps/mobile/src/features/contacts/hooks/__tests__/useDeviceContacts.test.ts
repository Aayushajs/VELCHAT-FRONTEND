/**
 * The load-path guarantees that the pure model tests cannot reach (§F2/§G2):
 *
 *  1. INSTANT: when a snapshot exists the very first render is already `ready` with rows. The
 *     old effect-based read guaranteed one spinner frame, which on a large address book is the
 *     frame the user actually sees and reports as "load time bahut jyada".
 *  2. CHEAP: a re-run over an unchanged book performs no OPRF round-trip at all, only newly
 *     added numbers are ever re-discovered, and two callers racing (launch prewarm + screen
 *     mount) share ONE pipeline run rather than each burning a rate-limited discovery call.
 *  3. RESILIENT: a failed round-trip over a warm cache keeps the real VelChat/invite split
 *     instead of collapsing the screen into the degraded fallback list.
 *
 * The `infra` barrel is replaced wholesale rather than spied on: requiring the real one pulls in
 * native modules that do not exist under Jest. Phone normalization is the real implementation —
 * the E.164 rules are part of what these paths must get right.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import {
  clearContactsDiscoveryCache,
  prewarmContacts,
  useDeviceContacts,
} from '../useDeviceContacts';

const store: Record<string, string> = {};
const mockReadDeviceContacts = jest.fn();
const mockDiscoverContacts = jest.fn();
const mockGetOprfKey = jest.fn();
const mockCheckPermission = jest.fn();

jest.mock('../../../../infra', () => ({
  checkContactsPermission: () => mockCheckPermission(),
  ensureContactsPermission: () => Promise.resolve('granted'),
  readDeviceContacts: () => mockReadDeviceContacts(),
  getOprfKey: () => mockGetOprfKey(),
  // Required lazily: a jest.mock factory may not close over out-of-scope variables.
  toE164: (raw: string, region?: string) =>
    (
      jest.requireActual('../../../../infra/util/phone') as {
        toE164: (r: string, g?: string) => string | null;
      }
    ).toE164(raw, region),
  regionFromE164: (e164?: string) =>
    (
      jest.requireActual('../../../../infra/util/phone') as {
        regionFromE164: (e?: string) => string | undefined;
      }
    ).regionFromE164(e164),
  getPhone: () => '+919800000000',
  getAccountId: () => 'me',
  OPRF_EVALUATE_BATCH_CAP: 2000,
  KVKeys: { contactsSnapshot: 'contacts.snapshot.v1' },
  kv: {
    getString: (k: string) => store[k],
    set: (k: string, v: string) => {
      store[k] = v;
    },
    delete: (k: string) => {
      delete store[k];
    },
  },
}));

jest.mock('../../../../domain', () => ({
  discoverContacts: (mine: string, numbers: string[]) =>
    mockDiscoverContacts(mine, numbers),
}));

const SNAPSHOT_KEY = 'contacts.snapshot.v1';

interface FakeContact {
  recordId: string;
  name: string;
  phones: string[];
}

const book = (n: number): FakeContact[] =>
  Array.from({ length: n }, (_v, i) => ({
    recordId: `r${i}`,
    name: `Contact ${String(i).padStart(4, '0')}`,
    phones: [`+9198${String(10000000 + i).padStart(8, '0')}`],
  }));

/** Make the persisted snapshot look old so the next run gets past the freshness gate. */
function ageSnapshot(): void {
  const snap = JSON.parse(store[SNAPSHOT_KEY] as string) as { at: number };
  store[SNAPSHOT_KEY] = JSON.stringify({ ...snap, at: 0 });
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  // Also drops the in-memory snapshot, which is what makes these tests order-independent.
  clearContactsDiscoveryCache();
  jest.clearAllMocks();
  mockCheckPermission.mockResolvedValue('granted');
  mockGetOprfKey.mockResolvedValue({ n: 'x', e: 'AQAB', version: 1 });
  mockReadDeviceContacts.mockResolvedValue(book(5));
  mockDiscoverContacts.mockResolvedValue(new Map());
});

describe('useDeviceContacts — first paint', () => {
  it('is ready with rows on the FIRST render when a snapshot exists', () => {
    store[SNAPSHOT_KEY] = JSON.stringify({
      accountId: 'me',
      onVelchat: [
        {
          key: 'a1',
          accountId: 'a1',
          name: 'Amit',
          phoneE164: '+919811111111',
        },
      ],
      invitable: [{ key: 'r2', name: 'Bhavna', phoneE164: '+919822222222' }],
      discoveryFailed: false,
      at: Date.now(),
      bookHash: 'abc',
      pending: 0,
    });

    const { result } = renderHook(() => useDeviceContacts());

    // No waitFor: this must hold on the very first committed render.
    expect(result.current.status).toBe('ready');
    expect(result.current.onVelchat.map(c => c.name)).toEqual(['Amit']);
    expect(result.current.invitable.map(c => c.name)).toEqual(['Bhavna']);
    // Nothing touched the address book to get there.
    expect(mockReadDeviceContacts).not.toHaveBeenCalled();
  });

  it('falls back to the permission check only when there is no snapshot', async () => {
    mockCheckPermission.mockResolvedValue('denied');
    const { result } = renderHook(() => useDeviceContacts());
    expect(result.current.status).toBe('checking');
    await waitFor(() => expect(result.current.status).toBe('needsPermission'));
  });
});

describe('useDeviceContacts — discovery cost', () => {
  it('discovers once, then not again for an unchanged book', async () => {
    mockDiscoverContacts.mockResolvedValue(
      new Map([['+919810000000', 'acc-0']]),
    );

    await act(async () => {
      await prewarmContacts();
    });
    expect(mockDiscoverContacts).toHaveBeenCalledTimes(1);
    // Every number in the book goes out in ONE call (one rate-limited evaluate, not two).
    expect(mockDiscoverContacts.mock.calls[0][1]).toHaveLength(5);

    ageSnapshot();
    clearMemOnly();
    await act(async () => {
      await prewarmContacts();
    });
    expect(mockDiscoverContacts).toHaveBeenCalledTimes(1);
  });

  it('asks only about the NEWLY added contact when the book grows', async () => {
    await act(async () => {
      await prewarmContacts();
    });
    expect(mockDiscoverContacts.mock.calls[0][1]).toHaveLength(5);

    mockReadDeviceContacts.mockResolvedValue([
      ...book(5),
      { recordId: 'new', name: 'Zoya', phones: ['+919899999999'] },
    ]);
    ageSnapshot();
    clearMemOnly();

    await act(async () => {
      await prewarmContacts();
    });
    expect(mockDiscoverContacts).toHaveBeenCalledTimes(2);
    expect(mockDiscoverContacts.mock.calls[1][1]).toEqual(['+919899999999']);
  });

  it('runs the pipeline once when prewarm and the screen race', async () => {
    await act(async () => {
      await Promise.all([
        prewarmContacts(),
        prewarmContacts(),
        prewarmContacts(),
      ]);
    });
    expect(mockReadDeviceContacts).toHaveBeenCalledTimes(1);
    expect(mockDiscoverContacts).toHaveBeenCalledTimes(1);
  });
});

describe('useDeviceContacts — degraded paths', () => {
  it('keeps the matched split when a later discovery call fails', async () => {
    mockDiscoverContacts.mockResolvedValue(
      new Map([['+919810000000', 'acc-0']]),
    );
    await act(async () => {
      await prewarmContacts();
    });

    // A new contact forces a re-run, and that round-trip 429s.
    mockReadDeviceContacts.mockResolvedValue([
      ...book(5),
      { recordId: 'new', name: 'Zoya', phones: ['+919899999999'] },
    ]);
    mockDiscoverContacts.mockRejectedValue(new Error('429'));
    ageSnapshot();
    clearMemOnly();

    const { result } = renderHook(() => useDeviceContacts());
    await act(async () => {
      result.current.reload();
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    // The cache still knows acc-0, so the screen is NOT degraded into the fallback list.
    expect(result.current.discoveryFailed).toBe(false);
    expect(result.current.onVelchat).toHaveLength(1);
    expect(result.current.onVelchat[0]?.accountId).toBe('acc-0');
  });

  it('reports degraded only when nothing at all is known', async () => {
    mockDiscoverContacts.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useDeviceContacts());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.discoveryFailed).toBe(true);
    expect(result.current.invitable).toHaveLength(5);
  });
});

/**
 * Drop only the in-memory snapshot, leaving MMKV intact — the shape of a fresh app launch that
 * still has last session's cache on disk. `clearContactsDiscoveryCache` would also wipe the
 * discovery cache, which is exactly what these tests are measuring.
 */
function clearMemOnly(): void {
  const keep = store['contacts.discovery.v1'];
  const snap = store[SNAPSHOT_KEY];
  clearContactsDiscoveryCache();
  if (keep !== undefined) store['contacts.discovery.v1'] = keep;
  if (snap !== undefined) store[SNAPSHOT_KEY] = snap;
}
