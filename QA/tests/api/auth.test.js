/**
 * VC-AUTH-* — Authentication API integration tests (§6, §22).
 *
 * These run against a REAL backend and assert the wire contract the mobile client is built
 * against (`docs/backend-integration-reference.md` §3). Nothing is mocked: a PASS here means the
 * server actually behaved, not that a stub did.
 */
import assert from 'node:assert/strict';
import { before, describe } from 'node:test';
import { get, post } from '../../lib/http.js';
import { qaTest } from '../../lib/results.js';
import { createDeviceKey, provisionIdentity, signChallenge } from '../../lib/provision.js';
import { env } from '../../lib/env.js';

const F = { feature: 'Authentication' };

/** A unique QA phone per run, so re-runs never collide on an existing account. */
function freshPhone() {
  const tail = String(Date.now()).slice(-7);
  return `+9190${tail}`;
}

describe('VC-AUTH — registration & session', () => {
  qaTest(
    'VC-AUTH-001',
    'valid registration returns a session id and a positive TTL',
    {
      ...F,
      severity: 'P0',
      steps: ['POST /auth/register {phone, platform:android, devicePubkeyBase64}'],
      expected: '201 with envelope {success:true, data:{sessionId, expiresIn>0}}',
    },
    async () => {
      const device = createDeviceKey();
      const res = await post(
        '/auth/register',
        { phone: freshPhone(), platform: 'android', devicePubkeyBase64: device.publicKeyBase64 },
        { testId: 'VC-AUTH-001' },
      );
      assert.equal(res.status, 201, `expected 201, got ${res.status}: ${res.text.slice(0, 200)}`);
      assert.equal(res.envelope?.success, true, 'response must use the {success,...} envelope');
      assert.ok(
        typeof res.data?.sessionId === 'string' && res.data.sessionId.length > 0,
        'sessionId must be a non-empty string',
      );
      assert.ok(
        Number(res.data?.expiresIn) > 0,
        `expiresIn must be > 0, got ${res.data?.expiresIn}`,
      );
      assert.ok(res.requestId, 'envelope must carry a requestId for support correlation');
    },
  );

  qaTest(
    'VC-AUTH-002',
    'registration with no body is rejected, not accepted',
    {
      ...F,
      severity: 'P1',
      steps: ['POST /auth/register {}'],
      expected: '4xx validation error, never 2xx',
    },
    async () => {
      const res = await post('/auth/register', {}, { testId: 'VC-AUTH-002' });
      assert.ok(
        res.status >= 400 && res.status < 500,
        `expected a 4xx validation error, got ${res.status}`,
      );
    },
  );

  qaTest(
    'VC-AUTH-003',
    'registration rejects a malformed phone number',
    {
      ...F,
      severity: 'P1',
      steps: ['POST /auth/register with phone:"not-a-phone"'],
      expected: '4xx validation error',
    },
    async () => {
      const device = createDeviceKey();
      const res = await post(
        '/auth/register',
        { phone: 'not-a-phone', platform: 'android', devicePubkeyBase64: device.publicKeyBase64 },
        { testId: 'VC-AUTH-003' },
      );
      assert.ok(
        res.status >= 400 && res.status < 500,
        `expected 4xx for a malformed phone, got ${res.status}`,
      );
    },
  );

  qaTest(
    'VC-AUTH-004',
    'registration rejects a non-base64 device public key',
    {
      ...F,
      severity: 'P2',
      steps: ['POST /auth/register with devicePubkeyBase64:"!!!not-base64!!!"'],
      expected: '4xx, never a 500',
    },
    async () => {
      const res = await post(
        '/auth/register',
        { phone: freshPhone(), platform: 'android', devicePubkeyBase64: '!!!not-base64!!!' },
        { testId: 'VC-AUTH-004' },
      );
      assert.ok(res.status >= 400, `expected a rejection, got ${res.status}`);
      assert.ok(res.status < 500, `a malformed key must not produce a 5xx, got ${res.status}`);
    },
  );

  qaTest(
    'VC-AUTH-005',
    'malformed JSON body is rejected with 4xx, not a 500',
    {
      ...F,
      severity: 'P2',
      steps: ['POST /auth/register with body "{not json"'],
      expected: '400-level parse error',
    },
    async () => {
      const res = await post('/auth/register', '{not json', {
        raw: true,
        headers: { 'content-type': 'application/json' },
        testId: 'VC-AUTH-005',
      });
      assert.ok(
        res.status >= 400 && res.status < 500,
        `expected 4xx for malformed JSON, got ${res.status}`,
      );
    },
  );

  qaTest(
    'VC-AUTH-006',
    'a session cannot be fetched for an unknown session id',
    {
      ...F,
      severity: 'P0',
      steps: ['POST /auth/session {sessionId: <random uuid>}'],
      expected: '4xx — never tokens',
    },
    async () => {
      const res = await post(
        '/auth/session',
        { sessionId: '00000000-0000-4000-8000-000000000000' },
        { testId: 'VC-AUTH-006' },
      );
      assert.ok(res.status >= 400, `expected a rejection, got ${res.status}`);
      assert.equal(
        res.data?.access,
        undefined,
        'an unknown session id must never yield an access token',
      );
    },
  );

  qaTest(
    'VC-AUTH-007',
    'full provisioning yields a well-formed token set',
    {
      ...F,
      severity: 'P0',
      steps: ['register', 'reverse-OTP proof', 'POST /auth/session'],
      expected: 'accountId + deviceId + RS256 access JWT + opaque refresh + expiresIn',
    },
    async () => {
      const id = await provisionIdentity(freshPhone(), {
        label: 'auth-007',
        testId: 'VC-AUTH-007',
      });
      assert.ok(id.accountId, 'accountId must be present');
      assert.ok(id.deviceId, 'deviceId must be present');
      assert.ok(Number(id.expiresIn) > 0, 'expiresIn must be positive');

      const [h, p] = id.access.split('.');
      const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      assert.equal(header.alg, 'RS256', `access token must be RS256, got ${header.alg}`);
      assert.equal(
        claims.account_id,
        id.accountId,
        'JWT account_id must match the provisioned accountId',
      );
      assert.equal(
        claims.device_id,
        id.deviceId,
        'JWT device_id must match the provisioned deviceId',
      );
      assert.ok(claims.exp * 1000 > Date.now(), 'access token must not be issued already-expired');
      // §3: access TTL is 15 min. Allow slack but catch an order-of-magnitude drift.
      const ttlSec = claims.exp - claims.iat;
      assert.ok(ttlSec > 60 && ttlSec <= 3600, `access TTL should be ~900s, got ${ttlSec}s`);
      assert.ok(!id.refresh.includes('.'), 'refresh token must be opaque (not a JWT)');
    },
  );

  qaTest(
    'VC-AUTH-008',
    'a provisioned session id is single-use (replay yields no second token set)',
    {
      ...F,
      severity: 'P0',
      steps: ['provision', 'POST /auth/session with the same sessionId again'],
      expected: '4xx — one-time fetch',
    },
    async () => {
      const device = createDeviceKey();
      const phone = freshPhone();
      const reg = await post(
        '/auth/register',
        { phone, platform: 'android', devicePubkeyBase64: device.publicKeyBase64 },
        { testId: 'VC-AUTH-008' },
      );
      const sessionId = reg.data.sessionId;
      await post(
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
        { testId: 'VC-AUTH-008' },
      );
      const first = await post('/auth/session', { sessionId }, { testId: 'VC-AUTH-008' });
      assert.ok(first.data?.access, 'first fetch must succeed');

      const second = await post('/auth/session', { sessionId }, { testId: 'VC-AUTH-008' });
      assert.equal(
        second.data?.access,
        undefined,
        'replaying a consumed sessionId must not return a second token set',
      );
    },
  );
});

describe('VC-AUTH — reverse-OTP anti-spoof rules', () => {
  /** Start a session and return its id, so each rule can be probed independently. */
  async function startSession(phone, testId) {
    const device = createDeviceKey();
    const reg = await post(
      '/auth/register',
      { phone, platform: 'android', devicePubkeyBase64: device.publicKeyBase64 },
      { testId },
    );
    return reg.data.sessionId;
  }

  const base = {
    path: 'missed-call',
    originationClass: 'mobile',
    attestation: 'genuine',
    riskScore: 1,
  };

  qaTest(
    'VC-AUTH-010',
    'webhook rejects a caller-ID that does not match the session phone',
    {
      ...F,
      severity: 'P0',
      steps: ['register phone X', 'webhook with cli = phone Y'],
      expected: '4xx REVOTP_CLI_MATCH',
    },
    async () => {
      const phone = freshPhone();
      const sessionId = await startSession(phone, 'VC-AUTH-010');
      const res = await post(
        '/auth/revotp/webhook',
        { ...base, sessionId, cli: '+919111111111', ts: Date.now() },
        { testId: 'VC-AUTH-010' },
      );
      assert.ok(res.status >= 400, `a mismatched caller-ID must be rejected, got ${res.status}`);
    },
  );

  qaTest(
    'VC-AUTH-011',
    'webhook rejects a non-mobile origination class',
    {
      ...F,
      severity: 'P1',
      steps: ['webhook with originationClass:"voip"'],
      expected: '4xx REVOTP_ORIGINATION',
    },
    async () => {
      const phone = freshPhone();
      const sessionId = await startSession(phone, 'VC-AUTH-011');
      const res = await post(
        '/auth/revotp/webhook',
        { ...base, originationClass: 'voip', sessionId, cli: phone, ts: Date.now() },
        { testId: 'VC-AUTH-011' },
      );
      assert.ok(res.status >= 400, `a VoIP origination must be rejected, got ${res.status}`);
    },
  );

  qaTest(
    'VC-AUTH-012',
    'webhook rejects a failed device attestation',
    {
      ...F,
      severity: 'P1',
      steps: ['webhook with attestation:"spoofed"'],
      expected: '4xx REVOTP_ATTESTATION',
    },
    async () => {
      const phone = freshPhone();
      const sessionId = await startSession(phone, 'VC-AUTH-012');
      const res = await post(
        '/auth/revotp/webhook',
        { ...base, attestation: 'spoofed', sessionId, cli: phone, ts: Date.now() },
        { testId: 'VC-AUTH-012' },
      );
      assert.ok(res.status >= 400, `a failed attestation must be rejected, got ${res.status}`);
    },
  );

  qaTest(
    'VC-AUTH-013',
    'webhook rejects a risk score above threshold',
    { ...F, severity: 'P1', steps: ['webhook with riskScore:99'], expected: '4xx REVOTP_RISK' },
    async () => {
      const phone = freshPhone();
      const sessionId = await startSession(phone, 'VC-AUTH-013');
      const res = await post(
        '/auth/revotp/webhook',
        { ...base, riskScore: 99, sessionId, cli: phone, ts: Date.now() },
        { testId: 'VC-AUTH-013' },
      );
      assert.ok(res.status >= 400, `a high risk score must be rejected, got ${res.status}`);
    },
  );

  qaTest(
    'VC-AUTH-014',
    'webhook rejects a proof timestamped after the verification window',
    {
      ...F,
      severity: 'P1',
      steps: ['webhook with ts = now + 1h'],
      expected: '4xx REVOTP_TIME_WINDOW',
    },
    async () => {
      const phone = freshPhone();
      const sessionId = await startSession(phone, 'VC-AUTH-014');
      const res = await post(
        '/auth/revotp/webhook',
        { ...base, sessionId, cli: phone, ts: Date.now() + 3600_000 },
        { testId: 'VC-AUTH-014' },
      );
      assert.ok(res.status >= 400, `an out-of-window proof must be rejected, got ${res.status}`);
    },
  );

  qaTest(
    'VC-AUTH-015',
    'webhook rejects an unknown session id',
    {
      ...F,
      severity: 'P1',
      steps: ['webhook with a random sessionId'],
      expected: '4xx REVOTP_SESSION',
    },
    async () => {
      const res = await post(
        '/auth/revotp/webhook',
        {
          ...base,
          sessionId: '00000000-0000-4000-8000-000000000001',
          cli: freshPhone(),
          ts: Date.now(),
        },
        { testId: 'VC-AUTH-015' },
      );
      assert.ok(res.status >= 400, `an unknown session must be rejected, got ${res.status}`);
    },
  );
});

describe('VC-AUTH — device-key login & refresh rotation', () => {
  let id;

  before(async () => {
    id = await provisionIdentity(freshPhone(), { label: 'auth-refresh', testId: 'VC-AUTH-020' });
  });

  qaTest(
    'VC-AUTH-020',
    'device-key login: a correctly signed challenge yields tokens',
    {
      ...F,
      severity: 'P0',
      steps: [
        'POST /auth/challenge {deviceId}',
        'sign the nonce with the device key',
        'POST /auth/login/device-key',
      ],
      expected: 'a fresh token set for the same account',
    },
    async () => {
      const ch = await post(
        '/auth/challenge',
        { deviceId: id.deviceId },
        { testId: 'VC-AUTH-020' },
      );
      assert.ok(ch.data?.nonce, `challenge must return a nonce, got ${ch.status}`);
      const signature = signChallenge(id.device.privateKey, ch.data.nonce);
      const login = await post(
        '/auth/login/device-key',
        { deviceId: id.deviceId, signature },
        { testId: 'VC-AUTH-020' },
      );
      assert.ok(
        login.data?.access,
        `device-key login must succeed, got ${login.status} ${login.text.slice(0, 200)}`,
      );
      assert.equal(
        login.data.accountId,
        id.accountId,
        'device-key login must return the same account',
      );
    },
  );

  qaTest(
    'VC-AUTH-021',
    'device-key login rejects a signature from the wrong key',
    {
      ...F,
      severity: 'P0',
      steps: ['challenge', 'sign with a DIFFERENT keypair', 'login'],
      expected: '401 — never tokens',
    },
    async () => {
      const ch = await post(
        '/auth/challenge',
        { deviceId: id.deviceId },
        { testId: 'VC-AUTH-021' },
      );
      const attacker = createDeviceKey();
      const signature = signChallenge(attacker.privateKey, ch.data.nonce);
      const login = await post(
        '/auth/login/device-key',
        { deviceId: id.deviceId, signature },
        { testId: 'VC-AUTH-021' },
      );
      assert.ok(login.status >= 400, `a forged signature must be rejected, got ${login.status}`);
      assert.equal(
        login.data?.access,
        undefined,
        'a forged signature must never yield an access token',
      );
    },
  );

  qaTest(
    'VC-AUTH-022',
    'device-key login rejects a replayed nonce',
    {
      ...F,
      severity: 'P1',
      steps: ['challenge', 'login (ok)', 'login again with the SAME signature'],
      expected: '4xx — nonce is single-use',
    },
    async () => {
      const ch = await post(
        '/auth/challenge',
        { deviceId: id.deviceId },
        { testId: 'VC-AUTH-022' },
      );
      const signature = signChallenge(id.device.privateKey, ch.data.nonce);
      const first = await post(
        '/auth/login/device-key',
        { deviceId: id.deviceId, signature },
        { testId: 'VC-AUTH-022' },
      );
      assert.ok(first.data?.access, 'the first login must succeed');
      const replay = await post(
        '/auth/login/device-key',
        { deviceId: id.deviceId, signature },
        { testId: 'VC-AUTH-022' },
      );
      assert.equal(
        replay.data?.access,
        undefined,
        'a replayed challenge signature must not yield a second token set',
      );
    },
  );

  qaTest(
    'VC-AUTH-023',
    'rotating refresh: a refresh returns a NEW refresh token (rotation is real)',
    {
      ...F,
      severity: 'P0',
      steps: ['POST /auth/token/refresh {refreshToken}'],
      expected: 'new access AND a different refresh token',
    },
    async () => {
      const fresh = await provisionIdentity(freshPhone(), {
        label: 'auth-023',
        testId: 'VC-AUTH-023',
      });
      const res = await post(
        '/auth/token/refresh',
        { refreshToken: fresh.refresh },
        { testId: 'VC-AUTH-023' },
      );
      assert.ok(
        res.data?.access,
        `refresh must succeed, got ${res.status} ${res.text.slice(0, 200)}`,
      );
      assert.ok(res.data?.refresh, 'refresh response must include a refresh token');
      assert.notEqual(
        res.data.refresh,
        fresh.refresh,
        'the refresh token MUST rotate — reuse detection depends on it',
      );
    },
  );

  qaTest(
    'VC-AUTH-024',
    'refresh-token reuse is detected and the family is revoked',
    {
      ...F,
      severity: 'P0',
      steps: ['provision', 'refresh once (token R1 → R2)', 'submit R1 again', 'then try R2'],
      expected: 'the replay is rejected AND R2 is revoked with it (whole-family revoke, §3)',
      refs: ['docs/backend-integration-reference.md:41', 'VC-BUG-003'],
    },
    async () => {
      const fresh = await provisionIdentity(freshPhone(), {
        label: 'auth-024',
        testId: 'VC-AUTH-024',
      });
      const r1 = fresh.refresh;
      const rotate = await post(
        '/auth/token/refresh',
        { refreshToken: r1 },
        { testId: 'VC-AUTH-024' },
      );
      const r2 = rotate.data?.refresh;
      assert.ok(r2, 'the first refresh must succeed');

      const replay = await post(
        '/auth/token/refresh',
        { refreshToken: r1 },
        { testId: 'VC-AUTH-024' },
      );
      assert.ok(
        replay.status >= 400,
        `replaying a rotated refresh token must be rejected, got ${replay.status}`,
      );

      const afterReplay = await post(
        '/auth/token/refresh',
        { refreshToken: r2 },
        { testId: 'VC-AUTH-024' },
      );
      assert.ok(
        afterReplay.status >= 400,
        `reuse detection must revoke the whole family: R2 should be dead after the replay, but it returned ${afterReplay.status}`,
      );
    },
  );

  qaTest(
    'VC-AUTH-025',
    'refresh rejects a garbage token',
    {
      ...F,
      severity: 'P1',
      steps: ['POST /auth/token/refresh {refreshToken:"garbage"}'],
      expected: '4xx, never tokens',
    },
    async () => {
      const res = await post(
        '/auth/token/refresh',
        { refreshToken: 'garbage-not-a-real-token' },
        { testId: 'VC-AUTH-025' },
      );
      assert.ok(res.status >= 400, `expected a rejection, got ${res.status}`);
      assert.equal(
        res.data?.access,
        undefined,
        'a garbage refresh token must never yield an access token',
      );
    },
  );

  qaTest(
    'VC-AUTH-026',
    'logout revokes the refresh token it was given',
    {
      ...F,
      severity: 'P1',
      steps: ['provision', 'POST /auth/logout {refreshToken}', 'try to refresh with it'],
      expected: 'the refresh is dead after logout',
    },
    async () => {
      const fresh = await provisionIdentity(freshPhone(), {
        label: 'auth-026',
        testId: 'VC-AUTH-026',
      });
      const out = await post(
        '/auth/logout',
        { refreshToken: fresh.refresh },
        { token: fresh.access, testId: 'VC-AUTH-026' },
      );
      assert.ok(
        out.status < 400,
        `logout should succeed, got ${out.status} ${out.text.slice(0, 200)}`,
      );
      const after = await post(
        '/auth/token/refresh',
        { refreshToken: fresh.refresh },
        { testId: 'VC-AUTH-026' },
      );
      assert.ok(
        after.status >= 400,
        `a logged-out refresh token must not still work, got ${after.status}`,
      );
    },
  );

  qaTest(
    'VC-AUTH-027',
    'concurrent refreshes of the same token do not both succeed',
    {
      ...F,
      severity: 'P1',
      steps: ['provision', 'fire 3 refreshes of the same token simultaneously'],
      expected:
        'at most one succeeds — otherwise rotation has a race that hands out parallel families',
    },
    async () => {
      const fresh = await provisionIdentity(freshPhone(), {
        label: 'auth-027',
        testId: 'VC-AUTH-027',
      });
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          post('/auth/token/refresh', { refreshToken: fresh.refresh }, { testId: 'VC-AUTH-027' }),
        ),
      );
      const succeeded = results.filter((r) => r.data?.access).length;
      assert.ok(
        succeeded <= 1,
        `at most one concurrent refresh may succeed; ${succeeded} of 3 did`,
      );
    },
  );
});

describe('VC-AUTH — JWKS & token verification surface', () => {
  qaTest(
    'VC-AUTH-030',
    'JWKS is served unwrapped and contains a usable RSA key',
    {
      ...F,
      severity: 'P1',
      steps: ['GET /.well-known/jwks.json'],
      expected: 'a RAW (un-enveloped) JWKS with at least one RSA key carrying n and e',
      refs: ['docs/backend-integration-reference.md §0'],
    },
    async () => {
      const res = await get('/.well-known/jwks.json', { testId: 'VC-AUTH-030' });
      assert.equal(res.status, 200, `JWKS must be reachable, got ${res.status}`);
      assert.equal(
        res.envelope,
        undefined,
        'JWKS is a raw route — it must NOT be wrapped in the response envelope',
      );
      const keys = res.body?.keys;
      assert.ok(Array.isArray(keys) && keys.length > 0, 'JWKS must expose at least one key');
      const rsa = keys.find((k) => k.kty === 'RSA');
      assert.ok(rsa, 'JWKS must expose an RSA key (access tokens are RS256)');
      assert.ok(rsa.n && rsa.e, 'the RSA JWK must carry both modulus (n) and exponent (e)');
    },
  );

  qaTest(
    'VC-AUTH-031',
    'a protected endpoint rejects a request with no Authorization header',
    { ...F, severity: 'P0', steps: ['GET /auth/devices with no token'], expected: '401' },
    async () => {
      const res = await get('/auth/devices', { testId: 'VC-AUTH-031' });
      assert.equal(
        res.status,
        401,
        `an unauthenticated protected call must be 401, got ${res.status}`,
      );
    },
  );

  qaTest(
    'VC-AUTH-032',
    'a protected endpoint rejects a structurally valid but unsigned JWT',
    {
      ...F,
      severity: 'P0',
      steps: ['forge an alg:none JWT with a real-looking account_id', 'GET /auth/devices with it'],
      expected: '401 — signature verification must not be skippable',
    },
    async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const claims = Buffer.from(
        JSON.stringify({
          account_id: '00000000-0000-4000-8000-000000000000',
          device_id: '00000000-0000-4000-8000-000000000001',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString('base64url');
      const forged = `${header}.${claims}.`;
      const res = await get('/auth/devices', { token: forged, testId: 'VC-AUTH-032' });
      assert.equal(
        res.status,
        401,
        `an alg:none forged token must be rejected with 401, got ${res.status}`,
      );
    },
  );

  qaTest(
    'VC-AUTH-033',
    'a protected endpoint rejects an expired access token',
    {
      ...F,
      severity: 'P0',
      steps: ['mint a token with exp in the past', 'GET /auth/devices'],
      expected: '401',
    },
    async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
        'base64url',
      );
      const claims = Buffer.from(
        JSON.stringify({
          account_id: 'x',
          device_id: 'y',
          iat: 1,
          exp: Math.floor(Date.now() / 1000) - 60,
        }),
      ).toString('base64url');
      const res = await get('/auth/devices', {
        token: `${header}.${claims}.fake-signature`,
        testId: 'VC-AUTH-033',
      });
      assert.equal(
        res.status,
        401,
        `an expired token must be rejected with 401, got ${res.status}`,
      );
    },
  );

  qaTest(
    'VC-AUTH-034',
    'an authenticated account can list its own devices',
    {
      ...F,
      severity: 'P1',
      steps: ['provision', 'GET /auth/devices?accountId=<own>'],
      expected: '2xx with at least this device listed',
    },
    async () => {
      const fresh = await provisionIdentity(freshPhone(), {
        label: 'auth-034',
        testId: 'VC-AUTH-034',
      });
      const res = await get(`/auth/devices?accountId=${encodeURIComponent(fresh.accountId)}`, {
        token: fresh.access,
        testId: 'VC-AUTH-034',
      });
      assert.ok(
        res.status < 400,
        `listing own devices must succeed, got ${res.status} ${res.text.slice(0, 200)}`,
      );
      const rows = Array.isArray(res.data) ? res.data : (res.data?.devices ?? []);
      assert.ok(Array.isArray(rows), 'devices must come back as an array');
      assert.ok(
        rows.some((d) => (d.deviceId ?? d.device_id ?? d.id) === fresh.deviceId),
        'the device just provisioned must appear in its own account device list',
      );
    },
  );
});

describe('VC-AUTH — OTP send/verify surface', () => {
  qaTest(
    'VC-AUTH-040',
    'OTP verify rejects a wrong code',
    {
      ...F,
      severity: 'P0',
      steps: ['POST /auth/otp/verify with otp:"000000" for an un-sent phone'],
      expected: '4xx — never tokens',
    },
    async () => {
      const device = createDeviceKey();
      const res = await post(
        '/auth/otp/verify',
        {
          phone: freshPhone(),
          otp: '000000',
          platform: 'android',
          devicePubkeyBase64: device.publicKeyBase64,
        },
        { testId: 'VC-AUTH-040' },
      );
      assert.ok(res.status >= 400, `a wrong OTP must be rejected, got ${res.status}`);
      assert.equal(res.data?.access, undefined, 'a wrong OTP must never yield an access token');
    },
  );

  qaTest(
    'VC-AUTH-041',
    'OTP verify rejects a malformed (non-6-digit) code',
    { ...F, severity: 'P2', steps: ['POST /auth/otp/verify with otp:"12"'], expected: '4xx' },
    async () => {
      const device = createDeviceKey();
      const res = await post(
        '/auth/otp/verify',
        {
          phone: freshPhone(),
          otp: '12',
          platform: 'android',
          devicePubkeyBase64: device.publicKeyBase64,
        },
        { testId: 'VC-AUTH-041' },
      );
      assert.ok(res.status >= 400, `a malformed OTP must be rejected, got ${res.status}`);
    },
  );

  qaTest(
    'VC-AUTH-042',
    'OTP verify rejects an empty code',
    { ...F, severity: 'P2', steps: ['POST /auth/otp/verify with otp:""'], expected: '4xx' },
    async () => {
      const device = createDeviceKey();
      const res = await post(
        '/auth/otp/verify',
        {
          phone: freshPhone(),
          otp: '',
          platform: 'android',
          devicePubkeyBase64: device.publicKeyBase64,
        },
        { testId: 'VC-AUTH-042' },
      );
      assert.ok(res.status >= 400, `an empty OTP must be rejected, got ${res.status}`);
    },
  );
});
