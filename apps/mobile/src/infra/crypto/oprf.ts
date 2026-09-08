/**
 * OPRF private contact discovery — client crypto (§G2).
 *
 * RSA blind-signature OPRF (Chaum-style; cf. RFC 9474). The CLIENT learns
 * `f_d(number) = SHA256( H(number)^d mod n )` WITHOUT the server ever seeing the
 * plaintext number, and the server's secret exponent `d` never reaches the client.
 * Every guess costs one rate-limited round-trip, so the tiny E.164 keyspace can't be
 * enumerated offline (the loophole a plain salted hash can't close).
 *
 * This module is a BIT-EXACT port of the running backend
 * (`D:\Velchat\libs\crypto\src\oprf` — bignum.ts / hash.ts / rsa-oprf.ts). If any step
 * diverges, the client's token ≠ the server's `directToken` and discovery silently
 * returns nothing. Verified against the backend by `__tests__/oprf.test.ts`
 * (round-trip + hard-coded known-answer vectors computed with node:crypto).
 *
 *   client:  blind(number)              -> { blinded, r }   (send `blinded`; keep `r`)
 *   server:  evaluate(blinded, {d,n})    -> evaluated         (blind RSA "sign")
 *   client:  unblind(evaluated, r, key)  -> token (hex)       (= backend directToken)
 *
 * SHA-256 via @noble/hashes (audited, pure-JS). Randomness via @noble `randomBytes`,
 * which wraps the polyfilled `crypto.getRandomValues` (react-native-get-random-values,
 * imported in index.js). Hermes BigInt is native. NO node:crypto, NO new deps.
 */
/* eslint-disable no-bitwise -- BigInt modular arithmetic + byte packing are inherently bitwise */
import { sha256 } from '@noble/hashes/sha256';
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from '@noble/hashes/utils';
import { base64ToBytes, bytesToBase64 } from './base64';

const HASH_LEN = 32; // SHA-256 digest length (bytes)
/** Domain-separation prefix — MUST match backend hash.ts exactly. */
const OPRF_DOMAIN_PREFIX = 'velchat-oprf-v1:';

/** Server public key, decoded from the `/discovery/oprf/key` wire form. */
export interface OprfPublicKey {
  /** RSA modulus. */
  readonly n: bigint;
  /** RSA public exponent (typically 65537). */
  readonly e: bigint;
  /**
   * Byte length of the decoded modulus buffer — the pad width for hash expansion and
   * fixed-width token serialization. Equals the backend's `Math.ceil(bitLength(n)/8)`
   * (a proven identity: an RSA modulus has its high bit set, so its minimal big-endian
   * encoding is exactly `ceil(bitLength/8)` bytes).
   */
  readonly nByteLength: number;
  /** Key rotation version (bump ⇒ old tokens become unverifiable). */
  readonly version: number;
}

/** Output of {@link blind}. `r` is the secret blinding factor — NEVER send it. */
export interface BlindResult {
  readonly blinded: bigint;
  /** Kept client-side only; needed to unblind the server's response. */
  readonly r: bigint;
}

// ── base64url (URL-safe, unpadded) ───────────────────────────────────────────
// Built on the existing standard-base64 helpers (no new dep). `base64ToBytes`
// already accepts the URL-safe alphabet + missing padding, so decode is a straight
// re-use; encode maps +/ → -_ and strips `=` to match Node's `base64url`.

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]+$/g, '');
}

// ── BigInt <-> bytes ─────────────────────────────────────────────────────────

/** Big-endian bytes → BigInt (mirrors backend `bytesToBigInt`; empty ⇒ 0n). */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt('0x' + (bytesToHex(bytes) || '0'));
}

/** Minimal big-endian byte encoding (hex of value, left-padded to even nibbles). */
function bigIntToMinimalBytes(value: bigint): Uint8Array {
  if (value < 0n)
    throw new RangeError('OPRF: negative BigInt cannot be serialized');
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return hexToBytes(hex);
}

/**
 * BigInt → big-endian bytes, LEFT-PADDED to exactly `byteLength` (mirrors backend
 * `bigIntToBytes`). Throws if the value doesn't fit — a silent truncation here would
 * corrupt the token.
 */
export function bigIntToBytes(value: bigint, byteLength: number): Uint8Array {
  const raw = bigIntToMinimalBytes(value);
  if (raw.length > byteLength) {
    throw new RangeError('OPRF: value does not fit in byteLength');
  }
  if (raw.length === byteLength) return raw;
  const out = new Uint8Array(byteLength);
  out.set(raw, byteLength - raw.length);
  return out;
}

/** BigInt → base64url (unpadded, minimal bytes) — the OPRF wire encoding. */
export function bigIntToBase64Url(value: bigint): string {
  return bytesToBase64Url(bigIntToMinimalBytes(value));
}

/** base64url → BigInt. Inverse of {@link bigIntToBase64Url}. */
export function base64UrlToBigInt(s: string): bigint {
  return bytesToBigInt(base64ToBytes(s));
}

// ── modular arithmetic ───────────────────────────────────────────────────────

/** Modular exponentiation (square-and-multiply). Mirrors backend `modPow`. */
export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * Modular inverse of `a` mod `m` via the ITERATIVE extended Euclidean algorithm.
 * Mathematically identical to the backend's recursive `extGcd` (same canonical
 * representative), but iterative to avoid deep recursion on a ~2048-bit modulus on
 * Hermes. Throws if `a` and `m` are not coprime.
 */
export function modInverse(a: bigint, m: bigint): bigint {
  let oldR = ((a % m) + m) % m;
  let r = m;
  let oldS = 1n;
  let s = 0n;
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) {
    throw new Error(
      'OPRF modInverse: value is not invertible mod m (gcd != 1)',
    );
  }
  return ((oldS % m) + m) % m;
}

/**
 * Uniform random BigInt in `[2, max-1]` via rejection sampling (no modulo bias).
 * Sampling width is derived from `max` itself (≥ ~50% acceptance) — mirrors backend
 * `randomBigIntBelow`. `randomBytes` wraps the polyfilled `crypto.getRandomValues`.
 */
export function randomBigIntBelow(max: bigint, byteWidth?: number): bigint {
  // `max.toString(2)` renders a ~2048-CHARACTER string. The contacts pipeline calls this once
  // per contact against the SAME modulus, so recomputing the width was thousands of throwaway
  // 2 KB strings per import. Callers in a loop pass the width in; the fallback keeps the old
  // single-shot behaviour for everyone else.
  const byteLength =
    byteWidth ?? Math.max(1, Math.ceil(max.toString(2).length / 8));
  for (;;) {
    const candidate = bytesToBigInt(randomBytes(byteLength));
    if (candidate >= 2n && candidate < max) return candidate;
  }
}

// ── hash-to-BigInt (MGF1 over SHA-256) ───────────────────────────────────────

/** MGF1 (RFC 8017 §B.2.1): SHA-256(seed ‖ UInt32BE(counter)) chained, truncated. */
export function mgf1(seed: Uint8Array, length: number): Uint8Array {
  const iterations = Math.ceil(length / HASH_LEN);
  const chunks: Uint8Array[] = [];
  for (let counter = 0; counter < iterations; counter++) {
    const c = new Uint8Array(4);
    c[0] = (counter >>> 24) & 0xff;
    c[1] = (counter >>> 16) & 0xff;
    c[2] = (counter >>> 8) & 0xff;
    c[3] = counter & 0xff;
    chunks.push(sha256(concatBytes(seed, c)));
  }
  return concatBytes(...chunks).subarray(0, length);
}

/**
 * Hash an input (normalized E.164 number) to a BigInt uniformly in `[0, n)`.
 * `seed = SHA256( utf8("velchat-oprf-v1:") ‖ utf8(input) )`, expanded via MGF1 to
 * `nByteLength` bytes, reduced mod n. Mirrors backend `hashToBigInt`.
 */
export function hashToBigInt(
  input: string,
  n: bigint,
  nByteLength: number,
): bigint {
  const seed = sha256(
    concatBytes(utf8ToBytes(OPRF_DOMAIN_PREFIX), utf8ToBytes(input)),
  );
  const expanded = mgf1(seed, nByteLength);
  return bytesToBigInt(expanded) % n;
}

// ── OPRF protocol ────────────────────────────────────────────────────────────

/**
 * Decode the `/discovery/oprf/key` wire form into an {@link OprfPublicKey}.
 * `nByteLength` = the byte length of the decoded `n` buffer (the modulus size in
 * bytes) — the pad width used everywhere downstream.
 */
export function parseOprfPublicKey(wire: {
  n: string;
  e: string;
  version: number;
}): OprfPublicKey {
  const nBytes = base64ToBytes(wire.n);
  return {
    n: bytesToBigInt(nBytes),
    e: base64UrlToBigInt(wire.e),
    nByteLength: nBytes.length,
    version: wire.version,
  };
}

/** Client step 1: blind `input` against the server's public `(n, e)`. */
export function blind(
  input: string,
  pub: Pick<OprfPublicKey, 'n' | 'e' | 'nByteLength'>,
): BlindResult {
  const m = hashToBigInt(input, pub.n, pub.nByteLength);
  // The modulus byte length IS the right sampling width (an RSA modulus has its high bit set),
  // so pass it rather than re-deriving it from a binary string on every contact.
  const r = randomBigIntBelow(pub.n, pub.nByteLength);
  const blinded = (m * modPow(r, pub.e, pub.n)) % pub.n;
  return { blinded, r };
}

/**
 * Client step 2: strip the blinding factor and hash to the fixed-size lookup token.
 * `token = SHA256_hex( bigIntToBytes(unblinded mod n, nByteLength) )` — the exact
 * value the server registers as `directToken` (lowercase hex, 64 chars).
 */
export function unblind(
  evaluated: bigint,
  r: bigint,
  pub: Pick<OprfPublicKey, 'n' | 'nByteLength'>,
): string {
  const rInv = modInverse(r, pub.n);
  const unblinded = (evaluated * rInv) % pub.n;
  return bytesToHex(sha256(bigIntToBytes(unblinded % pub.n, pub.nByteLength)));
}

/**
 * Invert every value in one pass (Montgomery's batch-inversion trick).
 *
 * `modInverse` is by far the most expensive step in contact discovery: an extended-Euclid walk
 * over a 2048-bit modulus, previously run ONCE PER CONTACT (~0.60 ms/contact on desktop V8 —
 * roughly two thirds of the entire crypto cost, against a 1999-number discovery budget).
 *
 * The trick: with prefix products p_i = a_0·…·a_(i-1), one inverse of the TOTAL product yields
 * every individual inverse by walking back down, so the whole batch costs ONE modInverse plus
 * ~3 modular multiplications per element (measured ~13x faster overall). This is EXACT — the
 * results are bit-identical to inverting each value on its own — and each element keeps its own
 * independent random blinding factor, so nothing about the OPRF's privacy properties changes.
 *
 * Throws if any element is not invertible (as `modInverse` does), rather than returning values
 * that would silently corrupt every token in the batch.
 */
export function batchModInverse(
  values: readonly bigint[],
  mod: bigint,
): bigint[] {
  const count = values.length;
  if (count === 0) return [];

  // prefix[i] = product of values[0..i-1] (mod), so prefix[0] = 1.
  const prefix: bigint[] = new Array<bigint>(count);
  let running = 1n;
  for (let i = 0; i < count; i += 1) {
    prefix[i] = running;
    running = (running * (values[i] as bigint)) % mod;
  }

  // One inverse for the whole batch. A zero/non-coprime element makes the product
  // non-invertible, so this is also where a bad batch fails loudly.
  let inverseRunning = modInverse(running, mod);

  const out: bigint[] = new Array<bigint>(count);
  for (let i = count - 1; i >= 0; i -= 1) {
    out[i] = (inverseRunning * (prefix[i] as bigint)) % mod;
    inverseRunning = (inverseRunning * (values[i] as bigint)) % mod;
  }
  return out;
}

/**
 * Client step 2, batched: strip the blinding factors from a whole batch and hash each to its
 * lookup token. Index-aligned with `evaluated`/`rs`, and byte-identical to calling
 * {@link unblind} per item — it only replaces the per-item modular inverse with one batched
 * inverse (see {@link batchModInverse}).
 */
export function unblindBatch(
  evaluated: readonly bigint[],
  rs: readonly bigint[],
  pub: Pick<OprfPublicKey, 'n' | 'nByteLength'>,
): string[] {
  if (evaluated.length !== rs.length) {
    throw new RangeError(
      'OPRF unblindBatch: evaluated/blinding-factor length mismatch',
    );
  }
  const inverses = batchModInverse(rs, pub.n);
  return evaluated.map((ev, i) => {
    const unblinded = (ev * (inverses[i] as bigint)) % pub.n;
    return bytesToHex(
      sha256(bigIntToBytes(unblinded % pub.n, pub.nByteLength)),
    );
  });
}
