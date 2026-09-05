/**
 * Device address-book reader (§G2, §M23). A thin typed wrapper over `react-native-contacts`
 * so features never touch the third-party module directly — they get a small, stable shape
 * ({@link DeviceContact}) and a three-state permission result. Contact discovery reads this,
 * normalizes each number to E.164 ({@link toE164}), and blind-matches it against the VelChat
 * directory — the raw address book NEVER leaves the device in plaintext.
 *
 * Graceful degradation: the JS package can be installed before the native module is linked
 * into the running binary (i.e. before the next `pnpm android`). Importing the JS is safe even
 * then — the library resolves its native handle via `TurboModuleRegistry.get` (returns null,
 * doesn't throw), so a method call is what fails; we catch that and surface a typed
 * "unavailable" so the UI can ask the user to update, instead of crashing the screen.
 *
 * PRIVACY: never log a name, number, or thumbnail — only counts.
 */
import { Platform, PermissionsAndroid } from 'react-native';
// Default import (the library exports `export default { getAll, ... }`) — the interop unwraps
// it correctly. A namespace import would land on `.default` and every method would be undefined.
import Contacts from 'react-native-contacts';
import type { Contact as RNContact } from 'react-native-contacts';

/** A minimal, UI-facing contact: only what the picker + discovery need. */
export interface DeviceContact {
  /** Stable address-book id (dedup / list key). */
  recordId: string;
  /** Best display name (display → given+family → company → first number). */
  name: string;
  /** Raw numbers as saved in the address book (normalized to E.164 by the caller). */
  phones: string[];
  /** Local file path of the contact photo, when present. */
  thumbnailPath?: string;
}

/** Outcome of asking for contacts access. `unavailable` = native module not in this build. */
export type ContactsAccess = 'granted' | 'denied' | 'blocked' | 'unavailable';

/**
 * Ask for contacts permission (contextually — never on launch). Android uses the runtime
 * prompt (`READ_CONTACTS`); `NEVER_ASK_AGAIN` maps to `blocked` so the UI can deep-link to
 * Settings. iOS defers to the library's `requestPermission` (backed by the Info.plist string).
 */
export async function ensureContactsPermission(): Promise<ContactsAccess> {
  if (Platform.OS === 'android') {
    try {
      const res = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
      );
      if (res === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
      if (res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked';
      return 'denied';
    } catch {
      return 'unavailable';
    }
  }
  try {
    const res = await Contacts.requestPermission();
    return res === 'authorized' || res === 'limited' ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * Silently check whether contacts access is already granted — no prompt. Lets the picker
 * show an "Allow access" explainer FIRST (and only prompt on the button) instead of firing
 * the OS dialog on mount. Can't distinguish `blocked` (that needs a request); returns
 * `denied` for any not-granted state.
 */
export async function checkContactsPermission(): Promise<ContactsAccess> {
  if (Platform.OS === 'android') {
    try {
      const granted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
      );
      return granted ? 'granted' : 'denied';
    } catch {
      return 'unavailable';
    }
  }
  try {
    const res = await Contacts.checkPermission();
    return res === 'authorized' || res === 'limited' ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/** Prefer a real display name; fall back through the name parts, then company, then number. */
function pickName(c: RNContact, fallbackNumber: string): string {
  if (c.displayName && c.displayName.trim()) return c.displayName.trim();
  const full = [c.givenName, c.middleName, c.familyName]
    .filter((p): p is string => Boolean(p && p.trim()))
    .join(' ')
    .trim();
  if (full) return full;
  if (c.company && c.company.trim()) return c.company.trim();
  return fallbackNumber;
}

/**
 * Read the whole address book as {@link DeviceContact}s (numbers only — no emails/addresses),
 * dropping entries with no phone number. Throws if the native module isn't linked into this
 * build (caught by the caller → `unavailable`). Requires permission to have been granted.
 */
export async function readDeviceContacts(): Promise<DeviceContact[]> {
  const all = await Contacts.getAll();
  const out: DeviceContact[] = [];
  for (const c of all) {
    // A single malformed record must not take the whole address book down with it. The declared
    // type says `phoneNumbers` is always an array, but the value crosses the bridge from the
    // platform's contacts provider — and a throw here surfaces as "native module unavailable",
    // blanking a screen that had thousands of perfectly good contacts behind it.
    const numbers = Array.isArray(c?.phoneNumbers) ? c.phoneNumbers : [];
    const phones: string[] = [];
    for (const p of numbers) {
      const n = p?.number;
      if (typeof n === 'string' && n.trim()) phones.push(n);
    }
    if (phones.length === 0) continue;
    const dc: DeviceContact = {
      recordId: c.recordID,
      name: pickName(c, phones[0] as string),
      phones,
    };
    if (c.hasThumbnail && c.thumbnailPath) dc.thumbnailPath = c.thumbnailPath;
    out.push(dc);
  }
  return out;
}
