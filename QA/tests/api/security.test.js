/**
 * VC-SEC-* — Safe, non-destructive security validation (§24).
 *
 * Rules this file obeys:
 *   - No destructive attacks, no load/DoS, no data deletion beyond the QA accounts it creates.
 *   - No real secret is ever printed or committed. Forged tokens are built locally.
 *   - Every test states the authorization boundary it is probing, so a PASS is meaningful.
 *
 * The core question throughout: can identity A reach identity B's data, or act as B?
 */
import assert from 'node:assert/strict';
import { before, describe } from 'node:test';
import { del, get, patch, post } from '../../lib/http.js';
import { qaTest } from '../../lib/results.js';
import {
  createDeviceKey,
  ensureDm,
  provisionIdentity,
  provisionOutsider,
  provisionPair,
  signChallenge,
} from '../../lib/provision.js';

const F = { feature: 'Security' };

/**
 * A number never reused inside one process. `POST /auth/register` is rate-limited to 5 attempts
 * per number per hour, so a repeated number turns later tests into 429s that look like defects.
 */
let probeCount = 0;

function freshPhone() {
  probeCount += 1;
  return `+9196${String(Date.now()).slice(-6)}${String(probeCount).padStart(2, '0')}`.slice(0, 14);
}

describe('VC-SEC — authentication boundary', () => {
  const protectedRoutes = [
    ['GET', '/auth/devices'],
    ['GET', '/users/me/conversations'],
    ['GET', '/presence/00000000-0000-4000-8000-000000000000'],
    ['GET', '/notifications/prefs'],
  ];

  for (const [i, [method, path]] of protectedRoutes.entries()) {
    qaTest(
      `VC-SEC-00${i + 1}`,
      `${method} ${path} requires authentication`,
      {
        ...F,
        severity: 'P0',
        steps: [`${method} ${path} with no Authorization header`],
        expected: '401 (or 403) — never 2xx and never a 5xx',
      },
      async () => {
        const res = await get(path, { testId: `VC-SEC-00${i + 1}` });
        assert.ok(
          res.status === 401 || res.status === 403 || res.status === 404,
          `an unauthenticated ${method} ${path} must not be served; got ${res.status} ${res.text.slice(0, 160)}`,
        );
        assert.ok(
          res.status < 500,
          `an unauthenticated call must not produce a 5xx, got ${res.status}`,
        );
      },
    );
  }

  qaTest(
    'VC-SEC-010',
    'an `alg:none` forged JWT is rejected everywhere it is tried',
    {
      ...F,
      severity: 'P0',
      steps: ['forge an unsigned JWT naming a real account', 'use it on every protected route'],
      expected: '401 on every route — signature verification must never be skippable',
    },
    async () => {
      const victim = await provisionOutsider({ testId: 'VC-SEC-010' });
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const claims = Buffer.from(
        JSON.stringify({
          account_id: victim.accountId,
          device_id: victim.deviceId,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString('base64url');
      const forged = `${header}.${claims}.`;

      const failures = [];
      for (const [, path] of protectedRoutes) {
        const res = await get(path, { token: forged, testId: 'VC-SEC-010' });
        if (res.status < 400) failures.push(`${path} → ${res.status}`);
      }
      assert.deepEqual(failures, [], `an alg:none token was ACCEPTED on: ${failures.join(', ')}`);
    },
  );

  qaTest(
    'VC-SEC-011',
    'an access token re-signed with an attacker key is rejected',
    {
      ...F,
      severity: 'P0',
      steps: [
        'take a real token payload',
        'replace the signature with attacker-controlled bytes',
        'call a protected route',
      ],
      expected: '401 — the signature must be verified against the published JWKS',
    },
    async () => {
      const victim = await provisionOutsider({ testId: 'VC-SEC-011' });
      const [h, p] = victim.access.split('.');
      const tampered = `${h}.${p}.${Buffer.from('attacker-controlled-signature').toString('base64url')}`;
      const res = await get('/auth/devices', { token: tampered, testId: 'VC-SEC-011' });
      assert.equal(
        res.status,
        401,
        `a tampered signature must be rejected with 401, got ${res.status}`,
      );
    },
  );

  qaTest(
    'VC-SEC-012',
    'escalating the `role`/`scope` claim in a token does not grant privilege',
    {
      ...F,
      severity: 'P0',
      steps: ['forge a token with role:"admin" and scope:"*"', 'call an admin-shaped route'],
      expected: '401/403 — claims are only trusted after signature verification',
    },
    async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
        'base64url',
      );
      const claims = Buffer.from(
        JSON.stringify({
          account_id: '00000000-0000-4000-8000-000000000000',
          device_id: '00000000-0000-4000-8000-000000000001',
          role: 'admin',
          scope: '*',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString('base64url');
      const res = await post(
        '/discovery/oprf/rotate',
        {},
        { token: `${header}.${claims}.forged`, testId: 'VC-SEC-012' },
      );
      assert.ok(res.status >= 400, `a forged admin claim must not be honoured, got ${res.status}`);
    },
  );
});

describe('VC-SEC — cross-account access (IDOR)', () => {
  let a;
  let b;
  let conversationId;

  before(async () => {
    const pair = await provisionPair({ testId: 'VC-SEC-idor' });
    a = pair.a;
    b = pair.b;
    conversationId = await ensureDm(a, b, { testId: 'VC-SEC-idor' });
  });

  qaTest(
    'VC-SEC-020',
    'an outsider cannot read a conversation they are not a member of',
    {
      ...F,
      severity: 'P0',
      priority: 'P0',
      steps: [
        'A and B exchange a message',
        'outsider C requests the conversation history with a VALID token of its own',
      ],
      expected: 'C receives 403/404 and NO message content',
    },
    async () => {
      await post(
        '/chat/messages',
        {
          conversationId,
          senderId: a.accountId,
          clientMsgId: `sec-020-${Date.now()}`,
          type: 'text',
          content: 'private between A and B',
        },
        { token: a.access, testId: 'VC-SEC-020' },
      );
      const outsider = await provisionIdentity(freshPhone(), {
        label: 'sec-020-C',
        testId: 'VC-SEC-020',
      });

      const res = await get(
        `/chat/conversations/${encodeURIComponent(conversationId)}/messages?afterSeq=0&limit=50`,
        {
          token: outsider.access,
          testId: 'VC-SEC-020',
        },
      );

      const rows = Array.isArray(res.data) ? res.data : [];
      const leaked = rows.filter(
        (m) => typeof m.content === 'string' && m.content.includes('private between A and B'),
      );
      assert.equal(
        leaked.length,
        0,
        `IDOR: a non-member read ${rows.length} message(s) from someone else's DM (status ${res.status}). ` +
          `Leaked content: ${JSON.stringify(leaked.map((m) => m.content)).slice(0, 200)}`,
      );
      assert.ok(
        res.status >= 400 || rows.length === 0,
        `a non-member must be refused; got ${res.status} with ${rows.length} rows`,
      );
    },
  );

  qaTest(
    'VC-SEC-021',
    'a member cannot send a message while impersonating another account',
    {
      ...F,
      severity: 'P0',
      priority: 'P0',
      steps: ["B posts to /chat/messages with senderId set to A's accountId, using B's own token"],
      expected:
        'rejected, OR the stored message is attributed to B — never to A. The principal must come from the JWT.',
      refs: [
        'libs/feature-auth/src/auth/auth.controller.ts:9-12 ("principal binding … defeats IDOR")',
      ],
    },
    async () => {
      const marker = `impersonation-${Date.now()}`;
      const res = await post(
        '/chat/messages',
        {
          conversationId,
          senderId: a.accountId,
          clientMsgId: marker,
          type: 'text',
          content: marker,
        },
        { token: b.access, testId: 'VC-SEC-021' },
      );

      if (res.status >= 400) return; // rejected outright — correct

      const hist = await get(
        `/chat/conversations/${encodeURIComponent(conversationId)}/messages?afterSeq=0&limit=100`,
        {
          token: a.access,
          testId: 'VC-SEC-021',
        },
      );
      const stored = (hist.data ?? []).find(
        (m) => m.client_msg_id === marker || m.content === marker,
      );
      assert.ok(
        stored,
        'the message was accepted but cannot be found in history — inconclusive, investigate',
      );
      assert.equal(
        stored.sender_id,
        b.accountId,
        `IMPERSONATION: B's message was stored with sender_id=${stored.sender_id} (A is ${a.accountId}). ` +
          'The sender must be derived from the verified JWT, not from the request body.',
      );
    },
  );

  qaTest(
    'VC-SEC-022',
    "an account cannot list another account's devices",
    {
      ...F,
      severity: 'P0',
      steps: ["B calls GET /auth/devices?accountId=<A's id> with B's own token"],
      expected: "refused, or returns only B's devices — never A's",
    },
    async () => {
      const res = await get(`/auth/devices?accountId=${encodeURIComponent(a.accountId)}`, {
        token: b.access,
        testId: 'VC-SEC-022',
      });
      if (res.status >= 400) return; // refused — correct
      const rows = Array.isArray(res.data) ? res.data : (res.data?.devices ?? []);
      const leaked = rows.filter((d) => (d.deviceId ?? d.device_id ?? d.id) === a.deviceId);
      assert.equal(
        leaked.length,
        0,
        `IDOR: B enumerated A's device list (${rows.length} rows, including A's device ${a.deviceId}). ` +
          'The accountId query parameter must be ignored in favour of the JWT principal.',
      );
    },
  );

  qaTest(
    'VC-SEC-023',
    "an account cannot read another account's notification preferences",
    {
      ...F,
      severity: 'P1',
      steps: ["B reads prefs with A's id in the query"],
      expected: "refused, or only B's prefs",
    },
    async () => {
      const res = await get(`/notifications/prefs?userId=${encodeURIComponent(a.accountId)}`, {
        token: b.access,
        testId: 'VC-SEC-023',
      });
      assert.ok(res.status < 500, `must not 5xx, got ${res.status}`);
      if (res.status >= 400) return;
      const body = JSON.stringify(res.data ?? {});
      assert.ok(
        !body.includes(a.accountId) || body.includes(b.accountId),
        `possible IDOR: B's prefs read returned data referencing A (${a.accountId}): ${body.slice(0, 200)}`,
      );
    },
  );

  qaTest(
    'VC-SEC-024',
    "a push endpoint cannot be registered against another account's userId",
    {
      ...F,
      severity: 'P1',
      priority: 'P1',
      steps: [
        "B registers a push endpoint with userId = A's accountId, using B's token and B's deviceId",
      ],
      expected:
        "rejected, or the row is bound to B. Otherwise B receives A's push wake-ups — the client sends this " +
        'userId from its own state, so the server must bind it to the token (see VC-SEC-007 in the audit).',
      refs: ['apps/mobile/src/infra/push/api.ts:24-28'],
    },
    async () => {
      const res = await post(
        '/notifications/endpoints',
        {
          deviceId: b.deviceId,
          userId: a.accountId,
          platform: 'android',
          token: `qa-fake-fcm-token-${Date.now()}`,
        },
        { token: b.access, testId: 'VC-SEC-024' },
      );
      assert.ok(res.status < 500, `must not 5xx, got ${res.status} ${res.text.slice(0, 160)}`);
      assert.ok(
        res.status >= 400,
        `SECURITY: registering a push endpoint for another account's userId was accepted (${res.status}). ` +
          'The server must derive userId from the verified token, not the body.',
      );
    },
  );

  qaTest(
    'VC-SEC-025',
    'a non-member cannot add themselves to a conversation',
    {
      ...F,
      severity: 'P0',
      steps: ["outsider C POSTs itself into A↔B's members"],
      expected: 'refused',
    },
    async () => {
      const outsider = await provisionIdentity(freshPhone(), {
        label: 'sec-025-C',
        testId: 'VC-SEC-025',
      });
      const res = await post(
        `/conversations/${encodeURIComponent(conversationId)}/members`,
        { userId: outsider.accountId },
        { token: outsider.access, testId: 'VC-SEC-025' },
      );
      assert.ok(
        res.status >= 400,
        `a non-member must not be able to join a DM; got ${res.status} ${res.text.slice(0, 160)}`,
      );
    },
  );

  qaTest(
    'VC-SEC-026',
    "an outsider cannot delete another user's message",
    {
      ...F,
      severity: 'P0',
      steps: ['A sends a message', 'C attempts DELETE with scope everyone'],
      expected: 'refused',
    },
    async () => {
      const send = await post(
        '/chat/messages',
        {
          conversationId,
          senderId: a.accountId,
          clientMsgId: `sec-026-${Date.now()}`,
          type: 'text',
          content: 'do not delete me',
        },
        { token: a.access, testId: 'VC-SEC-026' },
      );
      const messageId = send.data?.messageId;
      assert.ok(messageId, 'setup: the message must be accepted');
      const outsider = await provisionIdentity(freshPhone(), {
        label: 'sec-026-C',
        testId: 'VC-SEC-026',
      });
      const res = await del(
        `/chat/messages/${encodeURIComponent(messageId)}`,
        { conversationId, actorId: outsider.accountId, scope: 'everyone' },
        { token: outsider.access, testId: 'VC-SEC-026' },
      );
      assert.ok(
        res.status >= 400,
        `a non-member must not delete another user's message; got ${res.status}`,
      );
    },
  );

  qaTest(
    'VC-SEC-027',
    "an outsider cannot edit another user's message",
    {
      ...F,
      severity: 'P0',
      steps: ['A sends a message', 'C attempts PATCH with new content'],
      expected: 'refused',
    },
    async () => {
      const send = await post(
        '/chat/messages',
        {
          conversationId,
          senderId: a.accountId,
          clientMsgId: `sec-027-${Date.now()}`,
          type: 'text',
          content: 'original content',
        },
        { token: a.access, testId: 'VC-SEC-027' },
      );
      const messageId = send.data?.messageId;
      const outsider = await provisionIdentity(freshPhone(), {
        label: 'sec-027-C',
        testId: 'VC-SEC-027',
      });
      const res = await patch(
        `/chat/messages/${encodeURIComponent(messageId)}`,
        { conversationId, editorId: outsider.accountId, content: 'TAMPERED BY OUTSIDER' },
        { token: outsider.access, testId: 'VC-SEC-027' },
      );
      assert.ok(
        res.status >= 400,
        `a non-member must not edit another user's message; got ${res.status}`,
      );
    },
  );
});

describe('VC-SEC — input validation at the identity boundary', () => {
  qaTest(
    'VC-SEC-030',
    'registration must not accept a non-phone string as an identity',
    {
      ...F,
      severity: 'P1',
      priority: 'P1',
      preconditions: 'none — this is an unauthenticated endpoint',
      steps: [
        'POST /auth/register {phone:"not-a-phone", platform:"android", devicePubkeyBase64:<valid>}',
        'complete the Reverse-OTP proof with cli:"not-a-phone"',
        'POST /auth/session',
      ],
      expected:
        "registration is rejected at step 1 with a 4xx. The phone is the account's identity anchor " +
        '(contact discovery and OPRF key off it), so an arbitrary string must never become an account.',
      refs: ['VC-AUTH-003'],
    },
    async () => {
      const device = createDeviceKey();
      const res = await post(
        '/auth/register',
        { phone: 'not-a-phone', platform: 'android', devicePubkeyBase64: device.publicKeyBase64 },
        { testId: 'VC-SEC-030' },
      );
      assert.ok(
        res.status >= 400,
        `a non-phone identity was accepted for registration (${res.status}). ` +
          'Confirmed downstream: the same string provisions a full account with real RS256 tokens.',
      );
    },
  );

  qaTest(
    'VC-SEC-031',
    'an account provisioned with an invalid device key cannot silently lose device-key login',
    {
      ...F,
      severity: 'P1',
      priority: 'P1',
      steps: [
        'POST /auth/register with devicePubkeyBase64:"!!!not-base64!!!"',
        'complete the proof and fetch a session',
        'attempt POST /auth/challenge + /auth/login/device-key for that device',
      ],
      expected:
        'registration is rejected up front. Otherwise the account exists with an unusable device key, and the ' +
        "app's silent re-login path (useAuth.ts:286-291) is permanently broken for that install with no error shown.",
      refs: ['VC-AUTH-004', 'libs/feature-auth/src/auth/auth.service.ts:199'],
    },
    async () => {
      const phone = freshPhone();
      const reg = await post(
        '/auth/register',
        { phone, platform: 'android', devicePubkeyBase64: '!!!not-base64!!!' },
        { testId: 'VC-SEC-031' },
      );
      assert.ok(
        reg.status >= 400,
        `an invalid device public key was accepted at registration (${reg.status}), despite auth.service.ts:199 ` +
          'claiming it fails fast. This provisions an account whose device-key login can never succeed.',
      );
    },
  );

  qaTest(
    'VC-SEC-032',
    'the Reverse-OTP webhook is not an unauthenticated account-provisioning primitive',
    {
      ...F,
      severity: 'P0',
      priority: 'P0',
      preconditions: 'a reachable backend; no credentials of any kind',
      steps: [
        'POST /auth/register for an arbitrary phone (unauthenticated, @Public)',
        'POST /auth/revotp/webhook with a self-asserted proof — no shared secret, no signature, no SIP gateway',
        'POST /auth/session',
      ],
      expected:
        'the webhook requires proof of origin (shared secret, signature, or network policy). As shipped it is ' +
        '@Public with no such check, so anyone who can reach the host mints tokens for any phone number. ' +
        'The code comment at auth.controller.ts:29-30 acknowledges this is a pending platform task.',
      refs: ['libs/feature-auth/src/auth/auth.controller.ts:28-36'],
    },
    async () => {
      const phone = freshPhone();
      const device = createDeviceKey();
      const reg = await post(
        '/auth/register',
        { phone, platform: 'android', devicePubkeyBase64: device.publicKeyBase64 },
        { testId: 'VC-SEC-032' },
      );
      const sessionId = reg.data?.sessionId;
      assert.ok(sessionId, 'setup: registration must start a session');

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
        { testId: 'VC-SEC-032' },
      );
      assert.ok(
        hook.status >= 400,
        `AUTH BYPASS: an unauthenticated, self-asserted Reverse-OTP proof was accepted (${hook.status}). ` +
          'Anyone who can reach this host can provision tokens for an arbitrary phone number.',
      );
    },
  );

  qaTest(
    'VC-SEC-033',
    'an oversized request body is rejected rather than crashing the service',
    {
      ...F,
      severity: 'P2',
      steps: ['POST /auth/register with a ~2 MB phone field'],
      expected: '4xx (413 or 400). Must not 5xx and the service must stay healthy afterwards.',
    },
    async () => {
      const res = await post(
        '/auth/register',
        {
          phone: 'x'.repeat(2 * 1024 * 1024),
          platform: 'android',
          devicePubkeyBase64: createDeviceKey().publicKeyBase64,
        },
        { testId: 'VC-SEC-033', timeoutMs: 45_000 },
      );
      assert.ok(res.status >= 400, `an oversized body must be rejected, got ${res.status}`);
      // Liveness: the service must still answer after the oversized request.
      const health = await get('/health', { testId: 'VC-SEC-033' });
      assert.equal(
        health.status,
        200,
        'the service must remain healthy after an oversized request',
      );
    },
  );

  qaTest(
    'VC-SEC-034',
    'a SQL-injection-shaped identifier is handled as data, not as SQL',
    {
      ...F,
      severity: 'P1',
      steps: ["GET /chat/conversations/' OR 1=1--/messages with a valid token"],
      expected: "4xx/empty — never a 500, never another conversation's rows",
    },
    async () => {
      const id = await provisionOutsider({ testId: 'VC-SEC-034' });
      const evil = encodeURIComponent("' OR 1=1--");
      const res = await get(`/chat/conversations/${evil}/messages?afterSeq=0&limit=10`, {
        token: id.access,
        testId: 'VC-SEC-034',
      });
      assert.ok(
        res.status < 500,
        `an injection-shaped id must not cause a 5xx, got ${res.status} ${res.text.slice(0, 200)}`,
      );
      const rows = Array.isArray(res.data) ? res.data : [];
      assert.equal(
        rows.length,
        0,
        `an injection-shaped id returned ${rows.length} rows — it must never match real data`,
      );
    },
  );

  qaTest(
    'VC-SEC-035',
    'an error response does not leak a stack trace or internal path',
    {
      ...F,
      severity: 'P2',
      steps: ['provoke an error with a malformed body', 'inspect the response body'],
      expected: 'a structured error envelope with no stack frames, file paths, or SQL text',
    },
    async () => {
      const res = await post(
        '/chat/messages',
        { conversationId: 42, senderId: {}, content: [] },
        { testId: 'VC-SEC-035' },
      );
      const body = res.text ?? '';
      for (const leak of [
        'at Object.',
        'node_modules',
        '/libs/',
        'SELECT ',
        'ECONNREFUSED',
        '.ts:',
      ]) {
        assert.ok(
          !body.includes(leak),
          `the error response leaked internals ("${leak}"): ${body.slice(0, 300)}`,
        );
      }
    },
  );
});

describe('VC-SEC — session lifecycle', () => {
  qaTest(
    'VC-SEC-040',
    "a device-key challenge issued for one device cannot be answered by another device's key",
    {
      ...F,
      severity: 'P0',
      steps: [
        'provision A and B',
        "request a challenge for A's deviceId",
        "sign it with B's device key",
        'attempt login',
      ],
      expected: '401 — the signature must verify against the registered key for THAT device',
    },
    async () => {
      const [a, b] = await Promise.all([
        provisionIdentity(freshPhone(), { label: 'sec-040-A', testId: 'VC-SEC-040' }),
        provisionIdentity(freshPhone(), { label: 'sec-040-B', testId: 'VC-SEC-040' }),
      ]);
      const ch = await post('/auth/challenge', { deviceId: a.deviceId }, { testId: 'VC-SEC-040' });
      assert.ok(ch.data?.nonce, 'setup: a challenge must be issued');
      const signature = signChallenge(b.device.privateKey, ch.data.nonce);
      const login = await post(
        '/auth/login/device-key',
        { deviceId: a.deviceId, signature },
        { testId: 'VC-SEC-040' },
      );
      assert.ok(
        login.status >= 400,
        `another device's signature must not log in as A; got ${login.status}`,
      );
      assert.equal(
        login.data?.access,
        undefined,
        "a cross-device signature must never yield A's access token",
      );
    },
  );

  qaTest(
    'VC-SEC-041',
    "logging out one session does not revoke an unrelated account's session",
    {
      ...F,
      severity: 'P1',
      steps: ['provision A and B', 'log out A', 'confirm B can still refresh'],
      expected: "B's session survives — revocation must be scoped to the token family",
    },
    async () => {
      const [a, b] = await Promise.all([
        provisionIdentity(freshPhone(), { label: 'sec-041-A', testId: 'VC-SEC-041' }),
        provisionIdentity(freshPhone(), { label: 'sec-041-B', testId: 'VC-SEC-041' }),
      ]);
      await post(
        '/auth/logout',
        { refreshToken: a.refresh },
        { token: a.access, testId: 'VC-SEC-041' },
      );
      const bRefresh = await post(
        '/auth/token/refresh',
        { refreshToken: b.refresh },
        { testId: 'VC-SEC-041' },
      );
      assert.ok(
        bRefresh.data?.access,
        `B's session must survive A's logout; got ${bRefresh.status}`,
      );
    },
  );

  qaTest(
    'VC-SEC-042',
    'an access token is not accepted as a refresh token (and vice versa)',
    {
      ...F,
      severity: 'P1',
      steps: ['POST /auth/token/refresh with the ACCESS token in the refreshToken field'],
      expected: '4xx — the two token types must not be interchangeable',
    },
    async () => {
      const id = await provisionOutsider({ testId: 'VC-SEC-042' });
      const res = await post(
        '/auth/token/refresh',
        { refreshToken: id.access },
        { testId: 'VC-SEC-042' },
      );
      assert.ok(
        res.status >= 400,
        `an access token must not work as a refresh token, got ${res.status}`,
      );
      assert.equal(
        res.data?.access,
        undefined,
        'no token set may be issued for a type-confused credential',
      );
    },
  );
});
