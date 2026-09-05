/**
 * Contact change-detection (§contact-sync design §3). Pure, dependency-free, unit-tested.
 *
 * A per-contact FINGERPRINT captures everything that matters (name + sorted E.164 numbers +
 * photo marker); a contact is "changed" iff its fingerprint differs. A whole-book HASH lets the
 * client answer "did the address book change at all?" in one cheap CPU pass — the common case is
 * "no", so we skip re-discovery (and its rate-limited OPRF calls) entirely.
 *
 * Non-cryptographic (FNV-1a): this only needs to DETECT change, not resist attackers — fast and
 * deterministic across runs. (Privacy hashing is the OPRF layer, not this.)
 */

/** FNV-1a 32-bit → 8-hex-char string. Deterministic, fast, no allocations beyond the result. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface ContactInput {
  recordId: string;
  name: string;
  /** Normalized E.164 numbers for this contact (order-insensitive). */
  e164s: string[];
  /** A stable marker for the photo (path or content hash), if any. */
  thumbnailPath?: string | undefined;
}

/** Stable fingerprint of one contact — changes on rename, number add/remove, or photo change. */
export function contactFingerprint(c: ContactInput): string {
  const key = `${c.name.trim().toLowerCase()}|${[...c.e164s]
    .sort()
    .join(',')}|${c.thumbnailPath ?? ''}`;
  return fnv1a(key);
}

/**
 * Combine already-computed per-contact fingerprints into the whole-book hash.
 *
 * Split out from {@link bookHash} so a caller with a large address book can compute the
 * per-contact fingerprints in yielding chunks (the expensive, linear-in-book-size half) and
 * still fold them with the same function — the sort+join tail is a couple of milliseconds even
 * at a few thousand contacts, so only the map needs slicing.
 */
export function hashFingerprints(fingerprints: readonly string[]): string {
  return fnv1a([...fingerprints].sort().join(','));
}

/** One hash over the whole address book — equal to the last value ⇒ nothing changed, skip the diff. */
export function bookHash(contacts: readonly ContactInput[]): string {
  return hashFingerprints(contacts.map(contactFingerprint));
}

export interface ContactsDiff {
  /** New or modified contacts — only these need (re)discovery. */
  addedOrChanged: ContactInput[];
  /** Record ids present before but gone now — flip is_contact=false locally, no network. */
  removedIds: string[];
}

/**
 * Diff the current address book against the previous fingerprint snapshot (recordId → fingerprint).
 * Pure: the caller owns reading contacts + persisting the new snapshot.
 */
export function diffContacts(
  prevFingerprints: ReadonlyMap<string, string>,
  current: readonly ContactInput[],
): ContactsDiff {
  const currentIds = new Set(current.map(c => c.recordId));
  const addedOrChanged = current.filter(
    c => prevFingerprints.get(c.recordId) !== contactFingerprint(c),
  );
  const removedIds: string[] = [];
  for (const id of prevFingerprints.keys()) {
    if (!currentIds.has(id)) removedIds.push(id);
  }
  return { addedOrChanged, removedIds };
}
