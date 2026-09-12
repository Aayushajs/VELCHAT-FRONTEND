/**
 * Minimal, dependency-free base64 <-> bytes (Hermes-safe; no Buffer/btoa reliance).
 * Used to (de)serialize device-key material and challenge nonces.
 */
/* eslint-disable no-bitwise -- byte<->base64 packing is inherently bitwise */
const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

/** Base64url (RFC 4648 §5): `+`/`/` -> `-`/`_`, no padding. Used for JWK members (RFC 8037/7638). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]+$/, '');
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    out += hasB1 ? ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : '=';
    out += hasB2 ? ALPHABET.charAt(b2 & 0x3f) : '=';
  }
  return out;
}

/** Accepts standard OR url-safe base64 (the backend nonce is base64url). */
export function base64ToBytes(input: string): Uint8Array {
  const clean = input
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = LOOKUP[clean.charCodeAt(i)] ?? 0;
    const c1 = LOOKUP[clean.charCodeAt(i + 1)] ?? 0;
    const c2 =
      i + 2 < clean.length ? (LOOKUP[clean.charCodeAt(i + 2)] ?? -1) : -1;
    const c3 =
      i + 3 < clean.length ? (LOOKUP[clean.charCodeAt(i + 3)] ?? -1) : -1;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c3 >= 0) bytes.push(((c2 & 0x03) << 6) | c3);
  }
  return Uint8Array.from(bytes);
}
