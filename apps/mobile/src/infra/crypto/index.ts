/**
 * infra/crypto — libsignal wrapper + keystore (§M15/§L14).
 *
 * Public API barrel. Import this layer only through its index (`eslint-plugin-boundaries`).
 * Dependency rule (§M3): UI → Feature → Domain → Infra. Never the reverse.
 */
export {
  ensureDeviceKey,
  signChallenge,
  hasDeviceKey,
  clearDeviceKey,
} from './deviceKey';
export { bytesToBase64, base64ToBytes } from './base64';
export {
  hashToBigInt,
  blind,
  unblind,
  mgf1,
  parseOprfPublicKey,
  modPow,
  modInverse,
  bytesToBigInt,
  bigIntToBytes,
  bigIntToBase64Url,
  base64UrlToBigInt,
  randomBigIntBelow,
  batchModInverse,
  unblindBatch,
} from './oprf';
export type { OprfPublicKey, BlindResult } from './oprf';
