/**
 * Deterministic test-identity provisioning (§27, §38).
 *
 * Provisioning goes through the REAL auth flow — `POST /auth/register` → the Reverse-OTP webhook →
 * `POST /auth/session` — so the tokens a test holds are indistinguishable from a real client's.
 * Nothing is seeded directly into the database and no production credential is used.
 *
 * WHY the webhook is usable as a test seam: `POST /auth/revotp/webhook` is declared `@Public()`
 * with no shared secret or signature check (`libs/feature-auth/src/auth/auth.controller.ts:31-36`).
 * That is itself a reported defect — VC-SEC-009 — and this harness depends on it only because it is
 * currently true. GUARD: refuses to run against a host that is not local/dev, so a production
 * deployment can never be provisioned this way even by accident.
 *
 * If VC-SEC-009 is fixed (as it should be), set `QA_PROVISION_MODE=otp-dev` and run the backend with
 * `OTP_DEV_MODE=true` + `OTP_DEV_PHONE` instead; `provisionViaDevOtp` implements that path.
 */
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { env, originFor } from './env.js';
import { post } from './http.js';

/** Hosts this harness is permitted to provision against. */
const ALLOWED_HOST = /^(https?:\/\/)?(localhost|127\.0\.0\.1|10\.0\.2\.2|\[::1\])(:\d+)?$/i;

function assertProvisionable() {
  const origin = originFor('/auth');
  const host = origin.replace(/^(https?:\/\/)/, '').split('/')[0];
  const allowed = ALLOWED_HOST.test(host) || process.env.QA_ALLOW_REMOTE_PROVISION === 'true';
  if (!allowed) {
    throw new Error(
      `Refusing to provision test identities against "${origin}". ` +
        'The Reverse-OTP webhook seam is for a LOCAL backend only. ' +
        'Set QA_ALLOW_REMOTE_PROVISION=true only for a throwaway dev deployment you own.',
    );
  }
}

/** A QA device identity: an Ed25519 keypair plus the SPKI/DER public key the backend registers. */
export function createDeviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/**
 * Sign a `/auth/challenge` nonce exactly as the app does: the backend verifies over
 * `Buffer.from(nonce)` — the raw base64url STRING bytes, not the decoded nonce
 * (`apps/mobile/src/infra/crypto/deviceKey.ts:50-59`).
 */
export function signChallenge(privateKey, nonce) {
  return edSign(null, Buffer.from(nonce, 'latin1'), privateKey).toString('base64');
}

/**
 * Provision one identity. Returns
 * `{ phone, accountId, deviceId, access, refresh, expiresIn, device, label }`.
 */
export async function provisionIdentity(phone, { label = phone, testId = null } = {}) {
  assertProvisionable();
  const device = createDeviceKey();

  const reg = await post(
    '/auth/register',
    { phone, platform: 'android', devicePubkeyBase64: device.publicKeyBase64 },
    { testId },
  );
  if (reg.status !== 201 && reg.status !== 200) {
    throw new Error(
      `provision(${label}): /auth/register → ${reg.status} ${JSON.stringify(reg.body).slice(0, 300)}`,
    );
  }
  const sessionId = reg.data?.sessionId;
  if (!sessionId) throw new Error(`provision(${label}): no sessionId in register response`);

  const hook = await post(
    '/auth/revotp/webhook',
    {
      sessionId,
      cli: phone,
      path: 'missed-call',
      originationClass: 'mobile',
      attestation: 'genuine',
      riskScore: 1,
      ts: Date.now(),
    },
    { testId },
  );
  if (hook.status !== 200) {
    throw new Error(
      `provision(${label}): webhook → ${hook.status} ${JSON.stringify(hook.body).slice(0, 300)}`,
    );
  }

  const sess = await post('/auth/session', { sessionId }, { testId });
  if (!sess.data?.access) {
    throw new Error(`provision(${label}): /auth/session → ${sess.status} (no access token)`);
  }

  return {
    label,
    phone,
    device,
    accountId: sess.data.accountId,
    deviceId: sess.data.deviceId,
    access: sess.data.access,
    refresh: sess.data.refresh,
    expiresIn: sess.data.expiresIn,
  };
}

/** Alternative path for a backend running with `OTP_DEV_MODE=true` (no webhook seam needed). */
export async function provisionViaDevOtp(
  phone,
  { code = process.env.OTP_DEV_CODE ?? '123456', label = phone } = {},
) {
  const device = createDeviceKey();
  const send = await post('/auth/otp/send', { phone });
  if (send.status >= 400)
    throw new Error(`otp/send → ${send.status} ${JSON.stringify(send.body).slice(0, 200)}`);
  const verify = await post('/auth/otp/verify', {
    phone,
    otp: code,
    platform: 'android',
    devicePubkeyBase64: device.publicKeyBase64,
  });
  if (!verify.data?.access) throw new Error(`otp/verify → ${verify.status} (no access token)`);
  return { label, phone, device, ...verify.data };
}

/**
 * Test phone allocation (§27).
 *
 * `POST /auth/register` is rate-limited to 5 attempts per number per hour, so a suite that
 * re-registers the SAME fixed number in every `before` hook rate-limits itself into BLOCKED
 * results that look like product failures. Identities are therefore:
 *   - **deterministic within a run** — same slot always yields the same number, so evidence and
 *     Jira reports are reproducible and a failure can be re-driven by hand;
 *   - **unique across runs** — the run id seeds the number, so back-to-back runs never collide.
 *
 * Set `QA_STABLE_IDENTITIES=true` to pin the exact `TEST_USER_*_PHONE` values instead (useful when
 * you want the same accounts on a device between manual and automated passes).
 */
const RUN_SEED = (process.env.QA_RUN_ID ?? String(Date.now()))
  .replace(/\D/g, '')
  .slice(-5)
  .padStart(5, '0');

export function phoneForSlot(slot) {
  if (process.env.QA_STABLE_IDENTITIES === 'true') {
    const configured = env.users[slot]?.phone;
    if (configured) return configured;
  }
  const index = { a: '11', b: '22', c: '33' }[slot] ?? '99';
  return `+919${index}${RUN_SEED}${index[0]}`;
}

/**
 * Provision the standard two-device cast (§38). Returns `{ a, b }`.
 *
 * Each identity is a distinct account on a distinct device with its own Ed25519 keypair and its own
 * tokens — a genuine two-party setup, not one session pretending to be two.
 *
 * Memoised for the life of the process: every `before` hook in a suite file shares one pair, so a
 * 20-test file costs 2 registrations instead of 40 (and cannot rate-limit itself).
 */
let pairPromise = null;

export function provisionPair({ testId = null } = {}) {
  pairPromise ??= (async () => {
    const [a, b] = await Promise.all([
      provisionIdentity(phoneForSlot('a'), { label: 'userA', testId }),
      provisionIdentity(phoneForSlot('b'), { label: 'userB', testId }),
    ]);
    return { a, b };
  })();
  return pairPromise;
}

/**
 * Provision a brand-new identity with a number no other test uses — for the "outsider" role in
 * authorization tests, where reusing a cast member would invalidate the assertion.
 */
let outsiderCount = 0;

export function provisionOutsider({ testId = null } = {}) {
  outsiderCount += 1;
  const phone = `+9195${RUN_SEED}${String(outsiderCount).padStart(2, '0')}`;
  return provisionIdentity(phone, { label: `outsider-${outsiderCount}`, testId });
}

/**
 * Create (or reuse) the DM between two identities. Returns the conversation id.
 *
 * WORKAROUND for VC-ENV-002: the edge gateway's route table sends `/conversations/dm` to the
 * GROUP_CHANNEL logical service, which under the local `axis6` profile is not the service that
 * mounts `ChannelsController` — so the gateway answers 404 while identity-service serves it
 * correctly on its own origin. Tests must not be blocked by a routing defect, so we try the
 * gateway first (the path a real client takes) and fall back to the owning service, recording
 * which route worked. The gateway 404 is reported as its own defect by VC-API-020.
 */
export async function ensureDm(userA, userB, { testId = null } = {}) {
  const viaGateway = await post(
    '/conversations/dm',
    { a: userA.accountId, b: userB.accountId },
    { token: userA.access, testId },
  );
  let id = viaGateway.data?.conversationId ?? viaGateway.data?.id ?? viaGateway.data?._id;
  if (id) return id;

  const fallbackOrigin = process.env.SVC_IDENTITY_DIRECT_URL ?? 'http://localhost:3002';
  const viaService = await post(
    `${fallbackOrigin}/conversations/dm`,
    { a: userA.accountId, b: userB.accountId },
    { token: userA.access, testId },
  );
  id = viaService.data?.conversationId ?? viaService.data?.id ?? viaService.data?._id;
  if (!id) {
    throw new Error(
      `ensureDm failed on both routes — gateway ${viaGateway.status} ${JSON.stringify(viaGateway.body).slice(0, 200)}; ` +
        `service ${viaService.status} ${JSON.stringify(viaService.body).slice(0, 200)}`,
    );
  }
  return id;
}

/** True when the gateway itself can create a DM (i.e. VC-ENV-002 is fixed). */
export async function gatewayServesDm(userA, userB, { testId = null } = {}) {
  const res = await post(
    '/conversations/dm',
    { a: userA.accountId, b: userB.accountId },
    { token: userA.access, testId },
  );
  return {
    ok: Boolean(res.data?.conversationId ?? res.data?.id),
    status: res.status,
    body: res.body,
  };
}

/** Refresh an identity's tokens in place (rotating refresh). Returns the new pair. */
export async function refreshTokens(identity, { cnfJkt, testId = null } = {}) {
  const res = await post(
    '/auth/token/refresh',
    cnfJkt ? { refreshToken: identity.refresh, cnfJkt } : { refreshToken: identity.refresh },
    { testId },
  );
  return res;
}
