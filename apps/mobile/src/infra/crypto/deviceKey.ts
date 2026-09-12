/**
 * Device identity keypair (§M15, §L14). Ed25519 via @noble (audited, fast, pure
 * JS). The private key lives in encrypted MMKV for now; a hardware-backed
 * (StrongBox / Secure Enclave), non-exportable native keystore is the MP1
 * hardening target. Requires `react-native-get-random-values` (imported in
 * index.js) for a CSPRNG.
 */
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { kv, KVKeys } from '../kv';
import { bytesToBase64, bytesToBase64Url } from './base64';

// @noble/ed25519 v2 needs a sha512 for the synchronous API.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// SPKI/DER header for an Ed25519 public key (backend registers the SPKI/DER key, base64).
const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function loadPrivateKey(): Uint8Array | null {
  const hex = kv.getString(KVKeys.devicePrivKey);
  return hex ? hexToBytes(hex) : null;
}

export function hasDeviceKey(): boolean {
  return Boolean(kv.getString(KVKeys.devicePrivKey));
}

function publicKeyBase64(priv: Uint8Array): string {
  const raw = ed.getPublicKey(priv); // 32 bytes
  const spki = new Uint8Array(SPKI_PREFIX.length + raw.length);
  spki.set(SPKI_PREFIX);
  spki.set(raw, SPKI_PREFIX.length);
  return bytesToBase64(spki);
}

/** Generate + persist a device keypair if absent; return the SPKI/DER public key (base64). */
export function ensureDeviceKey(): string {
  let priv = loadPrivateKey();
  if (!priv) {
    priv = ed.utils.randomPrivateKey();
    kv.set(KVKeys.devicePrivKey, bytesToHex(priv));
  }
  return publicKeyBase64(priv);
}

/**
 * Sign a challenge nonce with the device key → base64 signature. The backend
 * (device-key.service.ts) verifies over `Buffer.from(nonce)` — the raw base64url
 * STRING bytes, NOT the decoded nonce — so we sign the string's bytes. base64url
 * is ASCII, so each char is exactly one byte (Hermes-safe; no TextEncoder needed).
 */
export function signChallenge(nonce: string): string {
  const priv = loadPrivateKey();
  if (!priv) throw new Error('device key not provisioned');
  const msg = Uint8Array.from(nonce, c => c.charCodeAt(0));
  return bytesToBase64(ed.sign(msg, priv));
}

export function clearDeviceKey(): void {
  kv.delete(KVKeys.devicePrivKey);
}

/**
 * The device key's JWK thumbprint (RFC 7638, over the RFC 8037 OKP encoding of an Ed25519 key) —
 * the `cnfJkt` this backend binds a rotating refresh token to (§3/VC-015). It is deliberately
 * computed from the SAME public key the backend already has on file from registration
 * (`ensureDeviceKey()`'s SPKI/DER value): the thumbprint must match what the server itself would
 * derive from that key, or the binding check can never pass.
 *
 * RFC 7638 requires hashing the UTF-8 bytes of the JWK's REQUIRED members only, in LEXICOGRAPHIC
 * key order, with no insignificant whitespace — for an OKP key (RFC 8037 §2) that member set is
 * exactly `crv`, `kty`, `x`, already alphabetical. `x` is the raw 32-byte public key, base64url —
 * NOT the SPKI/DER wrapper, which is a container format the thumbprint spec knows nothing about.
 *
 * Returns `undefined` if no device key has been provisioned yet — there is nothing to bind.
 */
export function cnfJktThumbprint(): string | undefined {
  const priv = loadPrivateKey();
  if (!priv) return undefined;
  const rawPublicKey = ed.getPublicKey(priv); // 32 bytes — the JWK `x` member, not the SPKI wrapper
  const jwk = `{"crv":"Ed25519","kty":"OKP","x":"${bytesToBase64Url(rawPublicKey)}"}`;
  const digest = sha256(Uint8Array.from(jwk, c => c.charCodeAt(0)));
  return bytesToBase64Url(digest);
}
