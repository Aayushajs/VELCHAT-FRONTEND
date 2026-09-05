/**
 * Device-contacts picker for New Chat (§F2/§G2) — the WhatsApp model: read the phone's own
 * address book, normalize every number to E.164, and blind-match it against the VelChat
 * directory (OPRF) to split contacts into "on VelChat" (tap → DM) and "invite".
 *
 * INSTANT BY CONSTRUCTION. The screen never waits on this pipeline:
 *  - the cached snapshot is read SYNCHRONOUSLY in the state initializer, so the very first
 *    render already has rows (an effect-based read costs a guaranteed spinner frame, which on
 *    a big book is the frame the user actually sees);
 *  - every long pass over the book runs in yielding chunks, so no single JS block can drop a
 *    frame — the list stays scrollable while discovery finishes behind it;
 *  - discovery is INCREMENTAL: a per-number cache means a re-run only pays for numbers it has
 *    never resolved. On a settled book that is zero numbers and zero round-trips.
 *
 * Measured motivation (2000-contact book, 2667 unique numbers, desktop V8 — the reference
 * device is several times slower): E.164 normalization ≈ 70 ms, fingerprinting ≈ 5 ms, OPRF
 * blind ≈ 1.55 s, OPRF unblind ≈ 3.47 s. The OPRF pair is the entire problem, and it used to be
 * re-paid in full whenever a single contact changed.
 *
 * Own state machine (§M20.3): checking → needsPermission → loading → ready, plus blocked /
 * unavailable. Runs are single-flight and guarded by a monotonic sequence. No plaintext number
 * is ever sent — the OPRF pipeline blinds each one client-side.
 *
 * PRIVACY: never log a name or number — only counts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InteractionManager } from 'react-native';
import {
  checkContactsPermission,
  ensureContactsPermission,
  readDeviceContacts,
  toE164,
  regionFromE164,
  getPhone,
  getAccountId,
  getOprfKey,
  kv,
  KVKeys,
  OPRF_EVALUATE_BATCH_CAP,
  type DeviceContact,
} from '../../../infra';
import { discoverContacts } from '../../../domain';
import { contactFingerprint, hashFingerprints } from '../model/fingerprint';
import { mapChunked } from '../model/chunk';
import {
  buildContactLists,
  normalizeContact,
  uniqueNumbers,
  type InviteContact,
  type NormalizedContact,
  type VelchatContact,
} from '../model/contactLists';
import {
  countPending,
  emptyDiscoveryCache,
  mergeDiscovered,
  parseDiscoveryCache,
  pruneCache,
  resolveKnown,
  selectPending,
  type DiscoveryCache,
} from '../model/discoveryCache';

export type { VelchatContact, InviteContact };

export type DeviceContactsStatus =
  | 'checking'
  | 'needsPermission'
  | 'blocked'
  | 'unavailable'
  | 'loading'
  | 'ready';

export interface UseDeviceContacts {
  status: DeviceContactsStatus;
  onVelchat: VelchatContact[];
  invitable: InviteContact[];
  /** True when we read the address book but couldn't check VelChat membership (backend down
   * or no own number) AND have no cached matches to fall back on. The contacts still show —
   * the UI resolves each one on tap instead. */
  discoveryFailed: boolean;
  /** The signed-in account id (for the "Message yourself" self-chat row), or undefined. */
  self: string | undefined;
  /** Ask for permission (prompts) then load — wired to the "Allow access" button. */
  request: () => void;
  /** Re-run discovery (permission already granted) — wired to pull-to-refresh / retry. */
  reload: () => void;
}

/**
 * Numbers handed to ONE discovery call. `discoverContacts` folds the caller's own number into
 * the same batch, so `cap - 1` keeps every run at exactly one `/evaluate` and one `/match`
 * round-trip. That matters twice over: the backend allows only 5 evaluate calls per hour per
 * account, and a full batch is already a ~900 KB request body — spending two of them per run on
 * a spotty connection is how a refresh turns into a 429 and a degraded list.
 *
 * SILENT CAP, deliberately made non-lossy: a book with more unresolved numbers than this is not
 * truncated any more. The overflow stays pending in the discovery cache and the NEXT run picks
 * up where this one stopped (see `selectPending`), with a follow-up run scheduled immediately
 * rather than waiting for the staleness timer.
 */
const DISCOVERY_BUDGET = OPRF_EVALUATE_BATCH_CAP - 1;

// Contacts rarely change mid-session, so keep the cache warm for a while — re-opening New Chat
// serves the cached list and the rate-limited OPRF discovery re-runs at most once per window.
const CACHE_TTL_MS = 30 * 60_000;

// Re-run the pipeline even when the book is unchanged at most this often, to catch contacts who
// JOINED VelChat since the last discovery (the live path for that is the server fan-out; this is
// the slow fallback). A changed book always re-runs immediately.
const FORCE_REDISCOVER_MS = 6 * 60 * 60_000;

/**
 * Delay before a resumed run for a book too large for one batch. Long enough that the user is
 * done interacting with the screen that triggered it, short enough that a 5000-number book
 * settles within a session rather than over days.
 */
const RESUME_DELAY_MS = 20_000;

/**
 * The discovery cache lives under its own MMKV key rather than inside the snapshot: the snapshot
 * is parsed on EVERY mount to paint the list, and folding a few thousand number→account entries
 * into it would double that parse for data the render path never reads.
 *
 * Not in `KVKeys` for the same reason the receipt/avatar caches are not: it is feature-owned
 * state with its own lifecycle. Sign-out must call {@link clearContactsDiscoveryCache}.
 */
const DISCOVERY_CACHE_KEY = 'contacts.discovery.v1';

interface Snapshot {
  accountId: string | undefined;
  onVelchat: VelchatContact[];
  invitable: InviteContact[];
  discoveryFailed: boolean;
  at: number;
  /** Hash of the address book at the last discovery — unchanged ⇒ reuse matches (no OPRF). */
  bookHash?: string;
  /** Numbers still awaiting a round-trip when this snapshot was written (0 = fully resolved). */
  pending?: number;
}

// In-memory (session) + MMKV (across restarts) cache, keyed by account so switching users never
// shows the previous account's contacts.
let memSnapshot: Snapshot | null = null;

function persist(s: Snapshot): void {
  memSnapshot = s;
  try {
    kv.set(KVKeys.contactsSnapshot, JSON.stringify(s));
  } catch {
    // best-effort cache; a serialization failure just means the next open re-discovers.
  }
}

function readCache(accountId: string | undefined): Snapshot | null {
  if (memSnapshot && memSnapshot.accountId === accountId) return memSnapshot;
  try {
    const raw = kv.getString(KVKeys.contactsSnapshot);
    if (!raw) return null;
    const s = JSON.parse(raw) as Snapshot;
    if (s.accountId !== accountId || !Array.isArray(s.onVelchat)) return null;
    memSnapshot = s;
    return s;
  } catch {
    return null;
  }
}

/**
 * Load the persisted cache under whatever key version it was written with. The version is
 * re-verified against the server before any round-trip; reading it optimistically first means an
 * OFFLINE open still resolves every number it resolved last time, instead of falling back to the
 * degraded "we can't tell who's on VelChat" list.
 */
function readDiscoveryCacheAnyVersion(
  accountId: string | undefined,
): DiscoveryCache {
  try {
    const raw = kv.getString(DISCOVERY_CACHE_KEY);
    if (!raw) return emptyDiscoveryCache(accountId, -1);
    const stored = JSON.parse(raw) as Partial<DiscoveryCache>;
    return parseDiscoveryCache(
      raw,
      accountId,
      typeof stored.version === 'number' ? stored.version : -1,
    );
  } catch {
    return emptyDiscoveryCache(accountId, -1);
  }
}

function persistDiscoveryCache(cache: DiscoveryCache): void {
  try {
    kv.set(DISCOVERY_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // best-effort; losing it costs one re-discovery, never correctness.
  }
}

/**
 * Drop this account's remembered discovery outcomes. MUST be called on sign-out — the cache maps
 * E.164 numbers to accountIds and would otherwise outlive the account that built it.
 */
export function clearContactsDiscoveryCache(): void {
  memSnapshot = null;
  try {
    kv.delete(DISCOVERY_CACHE_KEY);
  } catch {
    // nothing to do if the store is unavailable
  }
}

/** Result of one pipeline run, plus how much work it deliberately deferred. */
interface RunResult {
  snapshot: Snapshot;
  /** Numbers still unresolved after this run — >0 means schedule a resume. */
  pending: number;
}

/**
 * The core load (permission assumed granted): read the address book, normalize, discover only
 * what is not already known, and build the two lists.
 *
 * Returns null if the native module isn't in this build yet, or if `isCancelled` fired — the
 * caller must treat null as "no result", never as "empty book".
 */
async function computeContacts(
  isCancelled: () => boolean,
): Promise<RunResult | null> {
  const rawOwn = getPhone();
  const myPhoneE164 = rawOwn ? (toE164(rawOwn) ?? rawOwn) : undefined;
  const region = regionFromE164(myPhoneE164);
  const myAccount = getAccountId();

  let raw: DeviceContact[];
  try {
    raw = await readDeviceContacts();
  } catch {
    return null; // native module not linked yet
  }
  if (isCancelled()) return null;

  // Pass 1 — E.164 normalization, chunked. Linear in the book and the first thing that used to
  // block: ~70 ms desktop / several hundred ms on the reference device for 2000 contacts.
  const contacts = await mapChunked(raw, c => normalizeContact(c, region), {
    isCancelled,
  });
  if (contacts === null) return null;

  // Pass 2 — fingerprints, chunked for the same reason, then folded synchronously (the sort+join
  // tail is ~1 ms even at a few thousand contacts).
  const fingerprints = await mapChunked(
    contacts,
    (c: NormalizedContact) =>
      contactFingerprint({
        recordId: c.recordId,
        name: c.name,
        e164s: c.e164s,
        thumbnailPath: c.thumbnailPath,
      }),
    { isCancelled },
  );
  if (fingerprints === null) return null;
  const currentHash = hashFingerprints(fingerprints);

  // Unchanged book + a recent, fully-resolved snapshot ⇒ nothing to do at all. This is the
  // steady-state path and it costs no crypto and no network.
  const prior = readCache(myAccount);
  if (
    prior &&
    prior.bookHash === currentHash &&
    !prior.discoveryFailed &&
    !prior.pending &&
    Date.now() - prior.at < FORCE_REDISCOVER_MS
  ) {
    return { snapshot: { ...prior, at: Date.now() }, pending: 0 };
  }

  const numbers = uniqueNumbers(contacts, myPhoneE164);

  // No own number ⇒ no OPRF input ⇒ we can only offer invites. Nothing to cache either.
  if (!myPhoneE164) {
    const lists = buildContactLists(contacts, new Map(), {
      myAccountId: myAccount,
    });
    return {
      snapshot: {
        accountId: myAccount,
        ...lists,
        discoveryFailed: true,
        at: Date.now(),
        bookHash: currentHash,
        pending: 0,
      },
      pending: 0,
    };
  }

  // Discovery is best-effort in BOTH halves — the key fetch and the round-trip can each fail
  // (offline, 429, backend down). Neither failure may discard what we already know: an offline
  // New Chat with a warm cache is a CORRECT screen, and collapsing it into the degraded fallback
  // list is the "sahi se aa bhi nahi raha" the user is reporting.
  let cache = readDiscoveryCacheAnyVersion(myAccount);
  let fresh = new Map<string, string>();
  let roundTripFailed = false;

  try {
    // The server's key version invalidates every cached token when it rotates, so confirm it
    // before trusting the cache. Only reached when the book actually changed — the unchanged-book
    // shortcut above returns without any network at all.
    const version = (await getOprfKey()).version;
    if (isCancelled()) return null;
    if (cache.version !== version) {
      cache = emptyDiscoveryCache(myAccount, version);
    }

    const attempted = selectPending(
      cache,
      numbers,
      DISCOVERY_BUDGET,
      Date.now(),
    );
    if (attempted.length > 0) {
      fresh = await discoverContacts(myPhoneE164, attempted);
      if (isCancelled()) return null;
      cache = mergeDiscovered(cache, attempted, fresh, Date.now());
      cache = pruneCache(cache, new Set(numbers), Date.now());
      persistDiscoveryCache(cache);
    }
  } catch {
    // Keep `cache` exactly as it was — unverified version and all. Serving a slightly stale map
    // beats serving nothing, and the next successful run re-verifies it.
    roundTripFailed = true;
  }

  const known = resolveKnown(cache, numbers, Date.now());
  for (const [n, acc] of fresh) known.set(n, acc);
  const pending = countPending(cache, numbers, Date.now());

  // Degraded ONLY when we have nothing to show for the directory. With a warm cache a transient
  // 429 no longer collapses the whole VelChat section into the fallback list.
  const discoveryFailed = roundTripFailed && known.size === 0;

  const lists = buildContactLists(contacts, known, {
    myAccountId: myAccount,
    myPhoneE164,
  });

  return {
    snapshot: {
      accountId: myAccount,
      ...lists,
      discoveryFailed,
      at: Date.now(),
      // A run that could not complete its round-trip must not stamp the book as "discovered at
      // this hash", or the unchanged-book shortcut above would lock the degraded result in.
      ...(roundTripFailed ? {} : { bookHash: currentHash }),
      pending,
    },
    pending,
  };
}

// ── single-flight ────────────────────────────────────────────────────────────
// `prewarmContacts` (app launch) and the screen's own load can fire within the same second.
// Letting both run means two address-book reads and two OPRF round-trips against a 5-per-hour
// budget, for one answer. One shared in-flight promise; late callers await the same run.
let inFlight: Promise<RunResult | null> | null = null;

function runPipeline(isCancelled: () => boolean): Promise<RunResult | null> {
  if (inFlight) return inFlight;
  const p = computeContacts(isCancelled).finally(() => {
    if (inFlight === p) inFlight = null;
  });
  inFlight = p;
  return p;
}

// A book larger than one discovery batch resolves over successive runs. One timer, owned and
// replaced (§M7) — never a growing pile of pending resumes.
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleResume(pending: number): void {
  if (pending <= 0 || resumeTimer !== null) return;
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    void (async () => {
      const res = await runPipeline(() => false).catch(() => null);
      if (!res) return;
      persist(res.snapshot);
      scheduleResume(res.pending);
    })();
  }, RESUME_DELAY_MS);
}

/**
 * Warm the contacts cache at app launch (background, best-effort) so New Chat is instant. No-op
 * unless contacts permission is already granted and the cache is stale — never prompts, never
 * throws, never re-hits the rate-limited discovery within the TTL.
 *
 * Deferred behind `runAfterInteractions`: this used to run the full pipeline — bridge read,
 * normalization, and on a cold cache seconds of OPRF math — inside the cold-start window, which
 * is the §R4 ≤2.0 s budget's worst enemy on exactly the phones that have the biggest address
 * books. Nothing here is needed before the first screen is interactive.
 */
export async function prewarmContacts(): Promise<void> {
  try {
    if ((await checkContactsPermission()) !== 'granted') return;
    const cached = readCache(getAccountId());
    if (cached && !cached.pending && Date.now() - cached.at < CACHE_TTL_MS) {
      return;
    }
    await new Promise<void>(resolve => {
      InteractionManager.runAfterInteractions(() => resolve());
    });
    const res = await runPipeline(() => false);
    if (!res) return;
    const snap = res.snapshot;
    if (!snap.discoveryFailed || !cached || cached.discoveryFailed) {
      persist(snap);
    }
    scheduleResume(res.pending);
  } catch {
    // best-effort warmup
  }
}

export function useDeviceContacts(): UseDeviceContacts {
  // Read the snapshot DURING the first render, not in an effect. An effect-based read paints a
  // spinner frame first and only then the list; on a 2000-contact book that flash is the whole
  // "it doesn't come up properly" complaint.
  const initial = useMemo(() => readCache(getAccountId()), []);

  const [status, setStatus] = useState<DeviceContactsStatus>(
    initial ? 'ready' : 'checking',
  );
  const [onVelchat, setOnVelchat] = useState<VelchatContact[]>(
    initial?.onVelchat ?? [],
  );
  const [invitable, setInvitable] = useState<InviteContact[]>(
    initial?.invitable ?? [],
  );
  const [discoveryFailed, setDiscoveryFailed] = useState(
    initial?.discoveryFailed ?? false,
  );
  const self = useMemo(() => getAccountId(), []);

  const aliveRef = useRef(true);
  const seqRef = useRef(0);

  const apply = useCallback((s: Snapshot): void => {
    setOnVelchat(s.onVelchat);
    setInvitable(s.invitable);
    setDiscoveryFailed(s.discoveryFailed);
    setStatus('ready');
  }, []);

  // `silent` = a background refresh over a shown cache: don't flip to the spinner, and never
  // downgrade a good (matched) list to a degraded one on a transient backend blip.
  const runLoad = useCallback(
    async (silent: boolean): Promise<void> => {
      const seq = ++seqRef.current;
      const stale = (): boolean => !aliveRef.current || seq !== seqRef.current;
      const settle = (fn: () => void): void => {
        if (!stale()) fn();
      };
      if (!silent) settle(() => setStatus('loading'));

      // A silent refresh is invisible work behind a painted list — hold it until the screen has
      // settled so it can never compete with the open transition.
      if (silent) {
        await new Promise<void>(resolve => {
          InteractionManager.runAfterInteractions(() => resolve());
        });
        if (stale()) return;
      }

      const res = await runPipeline(stale);
      if (!res) {
        // A cancelled run must not be reported as a missing native module.
        if (!silent && !stale()) setStatus('unavailable');
        return;
      }
      settle(() => {
        if (
          silent &&
          res.snapshot.discoveryFailed &&
          memSnapshot &&
          !memSnapshot.discoveryFailed
        ) {
          return;
        }
        apply(res.snapshot);
        persist(res.snapshot);
      });
      scheduleResume(res.pending);
    },
    [apply],
  );

  const request = useCallback((): void => {
    void (async () => {
      const access = await ensureContactsPermission();
      if (!aliveRef.current) return;
      if (access === 'granted') void runLoad(false);
      else if (access === 'blocked') setStatus('blocked');
      else if (access === 'unavailable') setStatus('unavailable');
      else setStatus('needsPermission');
    })();
  }, [runLoad]);

  const reload = useCallback((): void => {
    void runLoad(false);
  }, [runLoad]);

  useEffect(() => {
    aliveRef.current = true;

    // The cached list is already on screen (state initializer). Refresh silently if it is stale
    // or still has numbers awaiting discovery.
    if (initial) {
      if (initial.pending || Date.now() - initial.at > CACHE_TTL_MS) {
        void runLoad(true);
      }
      return () => {
        aliveRef.current = false;
      };
    }

    // First ever open: silently check permission (no prompt). Load if granted, else explain.
    void (async () => {
      const access = await checkContactsPermission();
      if (!aliveRef.current) return;
      if (access === 'granted') void runLoad(false);
      else if (access === 'unavailable') setStatus('unavailable');
      else setStatus('needsPermission');
    })();
    return () => {
      aliveRef.current = false;
    };
  }, [initial, runLoad]);

  return {
    status,
    onVelchat,
    invitable,
    discoveryFailed,
    self,
    request,
    reload,
  };
}
