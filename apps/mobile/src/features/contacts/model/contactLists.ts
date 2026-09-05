/**
 * New-Chat list construction (§F2/§G2). Pure, unit-tested.
 *
 * WHY this is its own module: the split into "on VelChat" (alphabetical, tap → DM) and "invite"
 * is the part of the screen the user notices when it goes wrong — a real VelChat user showing up
 * under Invite, or the same person listed twice because their number is saved under two names.
 * Extracted from the loading hook so the dedup and ordering rules are pinned by tests instead of
 * living inside an async pipeline that only runs on a real device with a real address book.
 *
 * Behaviour here is a faithful move of what the hook already did — this module changes WHERE the
 * rules live, not what they are.
 *
 * PRIVACY: never log a name or a number — only counts.
 */
import { toE164, type DeviceContact } from '../../../infra';
import type { CountryCode } from 'libphonenumber-js';

/** A contact confirmed on VelChat — tapping it starts (or resumes) the DM. */
export interface VelchatContact {
  key: string;
  accountId: string;
  name: string;
  phoneE164: string;
  thumbnailPath?: string;
}

/** A contact NOT on VelChat — offered for an invite (share sheet). */
export interface InviteContact {
  key: string;
  name: string;
  phoneE164: string;
  thumbnailPath?: string;
}

/** One address-book entry with its numbers normalized and de-duplicated. */
export interface NormalizedContact {
  recordId: string;
  name: string;
  /** Distinct E.164 numbers for this contact, in address-book order. */
  e164s: string[];
  thumbnailPath?: string | undefined;
}

/**
 * Normalize ONE device contact. Returns `undefined` when no number parses — those entries can
 * never match and can never be invited, so they are dropped rather than carried through the
 * whole pipeline. Shaped as a single-item function so the caller can drive it in chunks and
 * keep the JS thread free (see {@link ../model/chunk}).
 */
export function normalizeContact(
  c: DeviceContact,
  region: CountryCode | undefined,
): NormalizedContact | undefined {
  const e164s: string[] = [];
  const seen = new Set<string>();
  for (const raw of c.phones) {
    const n = toE164(raw, region);
    if (n === null || seen.has(n)) continue;
    seen.add(n);
    e164s.push(n);
  }
  if (e164s.length === 0) return undefined;
  const out: NormalizedContact = { recordId: c.recordId, name: c.name, e164s };
  if (c.thumbnailPath !== undefined) out.thumbnailPath = c.thumbnailPath;
  return out;
}

/** Every distinct number in the book, in stable book order (the OPRF work list). */
export function uniqueNumbers(
  contacts: readonly NormalizedContact[],
  exclude?: string | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of contacts) {
    for (const n of c.e164s) {
      if (n === exclude || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

export interface ContactLists {
  onVelchat: VelchatContact[];
  invitable: InviteContact[];
}

export interface BuildListsOptions {
  /** The signed-in account — excluded from the list (you are not your own contact). */
  myAccountId?: string | undefined;
  /** The signed-in number — excluded so "me" never appears as an invite row. */
  myPhoneE164?: string | undefined;
}

/**
 * Split the normalized book into the two rendered sections.
 *
 * Dedup rules, both of which exist because address books really are this messy:
 *  - one row per matched ACCOUNT (the same person saved twice under two names collapses);
 *  - one invite row per NUMBER (the same number saved under two names collapses).
 *
 * Both sections are alphabetical by name. An empty `matches` map is a legitimate input — it
 * simply means nothing is known to be on VelChat yet, and every contact falls to invite.
 */
export function buildContactLists(
  contacts: readonly NormalizedContact[],
  matches: ReadonlyMap<string, string>,
  opts: BuildListsOptions = {},
): ContactLists {
  const { myAccountId, myPhoneE164 } = opts;
  const onVelchat: VelchatContact[] = [];
  const invitable: InviteContact[] = [];
  const usedAccounts = new Set<string>();
  const usedInvitePhones = new Set<string>();

  for (const c of contacts) {
    let acc: string | undefined;
    let phone: string | undefined;
    for (const n of c.e164s) {
      const m = matches.get(n);
      if (m !== undefined) {
        acc = m;
        phone = n;
        break;
      }
    }

    if (acc !== undefined && phone !== undefined) {
      if (acc === myAccountId) continue;
      if (usedAccounts.has(acc)) continue;
      usedAccounts.add(acc);
      const row: VelchatContact = {
        key: acc,
        accountId: acc,
        name: c.name,
        phoneE164: phone,
      };
      if (c.thumbnailPath) row.thumbnailPath = c.thumbnailPath;
      onVelchat.push(row);
      continue;
    }

    const first = c.e164s[0];
    if (first === undefined || first === myPhoneE164) continue;
    if (usedInvitePhones.has(first)) continue;
    usedInvitePhones.add(first);
    const row: InviteContact = {
      key: c.recordId,
      name: c.name,
      phoneE164: first,
    };
    if (c.thumbnailPath) row.thumbnailPath = c.thumbnailPath;
    invitable.push(row);
  }

  onVelchat.sort((a, b) => a.name.localeCompare(b.name));
  invitable.sort((a, b) => a.name.localeCompare(b.name));
  return { onVelchat, invitable };
}
