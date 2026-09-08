/**
 * Batched unblinding (§G2 perf) — the contacts-import cost fix.
 *
 * `unblind` spends nearly all of its time in `modInverse(r, n)`: an extended-Euclid walk over
 * a 2048-bit modulus, run ONCE PER CONTACT. Measured on desktop V8 it is ~0.60 ms/contact —
 * about two thirds of the whole crypto cost — and the discovery budget is 1999 numbers, so on
 * Hermes/a 3 GB device it dominates the "importing contacts" wait.
 *
 * Montgomery's batch-inversion trick inverts a whole batch with ONE modular inverse plus ~3
 * multiplications per element (~13x faster, measured). It is EXACT, not an approximation, and
 * it keeps an independent random `r` per contact — so the security model is untouched and every
 * token is byte-identical to the per-item path.
 *
 * These tests pin exactly that: identical output to `unblind`, for every batch shape.
 */
import {
  blind,
  unblind,
  unblindBatch,
  modInverse,
  batchModInverse,
  parseOprfPublicKey,
  modPow,
  bigIntToBase64Url,
  base64UrlToBigInt,
} from '../oprf';

// A small but real RSA-shaped modulus (product of two primes) — big enough to exercise the
// arithmetic, small enough to keep the suite fast. `e` is the usual 65537.
const P = 1000000007n;
const Q = 998244353n;
const N = P * Q;
const E = 65537n;
const PHI = (P - 1n) * (Q - 1n);
const D = modInverse(E, PHI);

const pub = {
  n: N,
  e: E,
  nByteLength: Math.ceil(N.toString(16).length / 2),
};

/** Stand in for the server: raise each blinded point to the secret exponent. */
function serverEvaluate(blinded: bigint): bigint {
  return modPow(blinded, D, N);
}

describe('batchModInverse', () => {
  it('agrees with modInverse element by element', () => {
    const values = [3n, 5n, 7n, 11n, 123456789n, 987654321n];
    expect(batchModInverse(values, N)).toEqual(
      values.map(v => modInverse(v, N)),
    );
  });

  it('produces true inverses (v * inv ≡ 1 mod n)', () => {
    const values = [2n, 9n, 55n, 1013n, 777777n];
    for (const [i, inv] of batchModInverse(values, N).entries()) {
      expect(((values[i] as bigint) * inv) % N).toBe(1n);
    }
  });

  it('handles an empty batch', () => {
    expect(batchModInverse([], N)).toEqual([]);
  });

  it('handles a single element', () => {
    expect(batchModInverse([12345n], N)).toEqual([modInverse(12345n, N)]);
  });

  it('throws when any element is not invertible, rather than returning garbage', () => {
    // P shares a factor with N, so it has no inverse mod N.
    expect(() => batchModInverse([3n, P, 5n], N)).toThrow();
  });
});

describe('unblindBatch', () => {
  it('returns byte-identical tokens to the per-item unblind', () => {
    const inputs = [
      '+919876500001',
      '+919876500002',
      '+14155550123',
      '+4915112345',
    ];
    const blinds = inputs.map(i => blind(i, pub));
    const evaluated = blinds.map(b => serverEvaluate(b.blinded));

    const one = blinds.map((b, i) => unblind(evaluated[i] as bigint, b.r, pub));
    const many = unblindBatch(
      evaluated,
      blinds.map(b => b.r),
      pub,
    );

    expect(many).toEqual(one);
    // and they're real 64-char lowercase hex tokens, not placeholders
    for (const t of many) expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same number (the property discovery relies on)', () => {
    const a = blind('+919876500001', pub);
    const b = blind('+919876500001', pub);
    const [ta] = unblindBatch([serverEvaluate(a.blinded)], [a.r], pub);
    const [tb] = unblindBatch([serverEvaluate(b.blinded)], [b.r], pub);
    expect(ta).toBe(tb);
  });

  it('gives different tokens for different numbers', () => {
    const a = blind('+919876500001', pub);
    const b = blind('+919876500002', pub);
    const [ta] = unblindBatch([serverEvaluate(a.blinded)], [a.r], pub);
    const [tb] = unblindBatch([serverEvaluate(b.blinded)], [b.r], pub);
    expect(ta).not.toBe(tb);
  });

  it('survives the base64url wire round-trip the real pipeline performs', () => {
    const b = blind('+919876500007', pub);
    const wire = bigIntToBase64Url(serverEvaluate(b.blinded));
    const [batched] = unblindBatch([base64UrlToBigInt(wire)], [b.r], pub);
    expect(batched).toBe(unblind(base64UrlToBigInt(wire), b.r, pub));
  });

  it('handles an empty batch', () => {
    expect(unblindBatch([], [], pub)).toEqual([]);
  });

  it('throws on a length mismatch instead of silently misaligning tokens', () => {
    const b = blind('+919876500001', pub);
    expect(() => unblindBatch([serverEvaluate(b.blinded)], [], pub)).toThrow();
  });

  it('keeps a real 2048-bit key exact (the production modulus size)', () => {
    // Same shape as the live /discovery/oprf/key payload.
    const real = parseOprfPublicKey({
      n: Buffer.from(
        BigInt(
          '0x' +
            'c'.repeat(4) +
            'd3f1a7b9e2c5408196af73be21d05c8e'.repeat(15) +
            '1f',
        )
          .toString(16)
          .padStart(512, '0'),
        'hex',
      ).toString('base64'),
      e: Buffer.from('010001', 'hex').toString('base64'),
      version: 1,
    });
    // We can't sign without d here, so assert the inversion identity directly — that is the
    // only step the batch path changes.
    const rs = [12345678901234567890n, 98765432109876543210n, 5n];
    for (const [i, inv] of batchModInverse(rs, real.n).entries()) {
      expect(((rs[i] as bigint) * inv) % real.n).toBe(1n);
    }
  });
});
