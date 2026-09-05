/**
 * Private contact discovery — orchestrator (§G2).
 *
 * Finds which of the user's phone contacts are on VelChat WITHOUT the server ever
 * seeing a plaintext number, by driving the RSA blind-signature OPRF:
 *
 *   1. fetch the server key once (`/discovery/oprf/key`)
 *   2. blind the user's own number + every (deduped) contact number  — keep each `r`
 *   3. blind-evaluate in ≤2000 batches (`/evaluate`)                 — server can't unblind
 *   4. unblind → per-number OPRF token
 *   5. register the user's OWN token so others can find them (opt-in)
 *   6. match the contact tokens (`/match`) → { token: accountId }
 *   7. return Map<originalContactPhone, accountId>  (matches only)
 *
 * The blinding factors `r` stay client-side, index-aligned with the blinded points, and
 * are NEVER sent. This is off the render path (an async use-case invoked from a hook /
 * effect, not from render).
 *
 * §M7 ownership: no timers/sockets/listeners — a single async pipeline; all buffers are
 * bounded by the caller's contact-list size (no unbounded cache).
 *
 * PERF (§M0.4): the BigInt math still runs on the JS thread, but it no longer BLOCKS it. The
 * blinding pass is sliced with a macrotask yield between slices (so the longest single block is
 * one slice, not the whole address book), and unblinding inverts the entire batch with ONE
 * modular inverse instead of one per contact (`unblindBatch`; ~13x on that step, measured).
 * A true off-thread offload (JSI/worker) remains a later increment.
 *
 * PRIVACY: never log phone numbers or tokens — only counts.
 */
import { log } from '../../core';
import {
  AppError,
  base64UrlToBigInt,
  bigIntToBase64Url,
  blind,
  getAccountId,
  getPhone,
  getOprfKey,
  oprfEvaluate,
  oprfMatch,
  oprfRegister,
  oprfRegisterEdges,
  mapYielding,
  parseOprfPublicKey,
  toE164,
  unblindBatch,
  OPRF_EVALUATE_BATCH_CAP,
  OPRF_MATCH_BATCH_CAP,
  type BlindResult,
  type OprfPublicKey,
} from '../../infra';

/**
 * Contacts per blinding slice. One blind is a 2048-bit modexp (~0.33 ms on desktop V8, several
 * times that on the reference device), so ~50 keeps a slice near one frame's budget while
 * keeping the yield overhead negligible against the whole pass.
 */
const BLIND_CHUNK_SIZE = 50;
/** base64url encode/decode is far cheaper than a modexp, so slices can be much larger. */
const WIRE_CHUNK_SIZE = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Blind → evaluate (batched) → unblind every input, returning a `phone → token` map.
 * `r` factors are held locally and index-aligned; a length mismatch in the server's
 * `evaluated[]` throws rather than silently misaligning tokens.
 */
async function tokenizeInputs(
  accountId: string,
  inputs: readonly string[],
  pub: OprfPublicKey,
): Promise<Map<string, string>> {
  // Blinding is CHUNKED, not one `.map`. It is a per-contact modular exponentiation over a
  // 2048-bit modulus, and the discovery budget is ~2000 numbers, so running it to completion in
  // one turn froze the JS thread for the whole pass — every frame inside it dropped, which is
  // what the slow "importing contacts" screen actually was. Slicing caps the longest single
  // block at one slice; total CPU is unchanged.
  const blinds: BlindResult[] | null = await mapYielding(
    inputs,
    input => blind(input, pub),
    { size: BLIND_CHUNK_SIZE },
  );
  if (blinds === null) {
    throw new AppError('client', 'discovery: blinding cancelled');
  }
  const blindedWire = await mapYielding(
    blinds,
    b => bigIntToBase64Url(b.blinded),
    { size: WIRE_CHUNK_SIZE },
  );
  if (blindedWire === null) {
    throw new AppError('client', 'discovery: blinding cancelled');
  }

  const evaluatedWire: string[] = [];
  for (const batch of chunk(blindedWire, OPRF_EVALUATE_BATCH_CAP)) {
    const resp = await oprfEvaluate(accountId, batch, pub.version);
    if (resp.evaluated.length !== batch.length) {
      throw new AppError('server', 'discovery: evaluate returned wrong count');
    }
    evaluatedWire.push(...resp.evaluated);
  }
  if (evaluatedWire.length !== inputs.length) {
    throw new AppError('server', 'discovery: evaluate/input length mismatch');
  }

  // Decode off the critical block too, then unblind the WHOLE batch with ONE modular inverse
  // (Montgomery's trick — see `batchModInverse`). Per-contact `modInverse` was ~two thirds of
  // the entire crypto cost; batching it measured ~13x faster and is bit-identical, with each
  // contact keeping its own independent blinding factor.
  const evaluated = await mapYielding(
    evaluatedWire,
    wire => base64UrlToBigInt(wire),
    { size: WIRE_CHUNK_SIZE },
  );
  if (evaluated === null) {
    throw new AppError('client', 'discovery: decode cancelled');
  }
  const tokens = unblindBatch(
    evaluated,
    blinds.map(b => b.r),
    pub,
  );

  const tokenByInput = new Map<string, string>();
  for (const [i, input] of inputs.entries()) {
    const token = tokens[i];
    if (token === undefined) {
      throw new AppError('server', 'discovery: response misaligned');
    }
    tokenByInput.set(input, token);
  }
  return tokenByInput;
}

/**
 * Register ONLY the caller's own number for discovery (opt-in) — so this account becomes
 * findable by contacts WITHOUT waiting for the user to open New Chat. Discovery is opt-in on
 * the backend (a token is stored only when `register` runs), so calling this at login makes
 * every account discoverable. Best-effort + idempotent; safe to call once per account. No-op
 * without an authenticated session or a known own number.
 */
export async function registerSelfForDiscovery(): Promise<void> {
  const accountId = getAccountId();
  const rawPhone = getPhone();
  if (!accountId || !rawPhone) return;
  const myPhoneE164 = toE164(rawPhone) ?? rawPhone;

  const pub = parseOprfPublicKey(await getOprfKey());
  const tokenByInput = await tokenizeInputs(accountId, [myPhoneE164], pub);
  const myToken = tokenByInput.get(myPhoneE164);
  if (myToken !== undefined) {
    await oprfRegister(accountId, myToken, pub.version);
    log.info('discovery: self registered');
  }
}

/**
 * Discover which contacts are on VelChat. Returns a map from the ORIGINAL contact phone
 * (E.164) to the matched accountId — matches only. Also registers the caller's own token
 * (opt-in discoverability). Requires an authenticated session (accountId).
 *
 * @param myPhoneE164        the caller's own normalized number (registered for discovery)
 * @param contactPhonesE164  the caller's contact numbers, normalized E.164
 */
export async function discoverContacts(
  myPhoneE164: string,
  contactPhonesE164: readonly string[],
): Promise<Map<string, string>> {
  const accountId = getAccountId();
  if (!accountId) {
    throw new AppError('auth', 'discovery: no authenticated account');
  }

  // Dedup: one blind/evaluate per distinct number. Own number is folded into the same
  // batch so it costs nothing extra. Contact keys drive the result map.
  const uniqueContacts = [...new Set(contactPhonesE164)];
  const uniqueInputs = [...new Set([myPhoneE164, ...uniqueContacts])];

  log.info('discovery: start', {
    contacts: uniqueContacts.length,
    inputs: uniqueInputs.length,
  });

  const pub = parseOprfPublicKey(await getOprfKey());
  const tokenByInput = await tokenizeInputs(accountId, uniqueInputs, pub);

  // Register the caller's own token so others can find them (opt-in).
  const myToken = tokenByInput.get(myPhoneE164);
  if (myToken !== undefined) {
    await oprfRegister(accountId, myToken, pub.version);
  }

  // Match the contact tokens (batched), building token → accountId.
  const contactTokens = [
    ...new Set(
      uniqueContacts
        .map(phone => tokenByInput.get(phone))
        .filter((t): t is string => t !== undefined),
    ),
  ];
  const matches: Record<string, string> = {};
  for (const batch of chunk(contactTokens, OPRF_MATCH_BATCH_CAP)) {
    Object.assign(matches, await oprfMatch(accountId, batch));
  }

  // Record these contact tokens as edges so that a number which is NOT on VelChat yet flips
  // "on VelChat" LIVE the moment it registers (§contact-sync fan-out). Best-effort, off the
  // result path — a failure never breaks discovery.
  try {
    for (const batch of chunk(contactTokens, OPRF_MATCH_BATCH_CAP)) {
      await oprfRegisterEdges(accountId, batch);
    }
  } catch {
    // non-fatal: matching already succeeded; edges retry on the next discovery
  }

  // Project back onto the original contact phones.
  const result = new Map<string, string>();
  for (const phone of uniqueContacts) {
    const token = tokenByInput.get(phone);
    if (token === undefined) continue;
    const matchedAccount = matches[token];
    if (matchedAccount !== undefined) result.set(phone, matchedAccount);
  }

  log.info('discovery: done', { matched: result.size });
  return result;
}
