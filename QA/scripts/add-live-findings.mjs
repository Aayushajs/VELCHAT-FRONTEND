/**
 * One-off: append the defects confirmed by LIVE reproduction during run-002 to the registry.
 *
 * Kept as a script rather than a hand edit so the registry stays machine-written and the exact
 * wording of each finding is reviewable in git alongside the evidence it cites.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REGISTRY = resolve(import.meta.dirname, '..', 'reports', 'bugs.json');
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));

const findings = [
  {
    id: 'VC-039',
    title:
      'Any authenticated user can READ and WRITE any conversation — no authorization on the chat routes, and conversation ids are derivable offline',
    severity: 'P0',
    priority: 'P0',
    status: 'Open',
    layer: 'BACKEND',
    feature: 'Security / Messaging',
    component: 'messaging-service /chat/* and identity-service /conversations/*',
    environment: 'local backend axis6, gateway :8080',
    device: 'node-harness',
    os: 'win32-x64',
    frequency: 'Always',
    reproducibility: '100%',
    preconditions:
      'One ordinary VelChat account (any account, no special role). The target conversation id, which is COMPUTED rather than guessed.',
    steps: [
      'Provision three accounts A, B and C. A and B open a DM; A sends "TOP SECRET between A and B".',
      'C is not a member of that conversation and holds only its own ordinary token.',
      'C derives the conversation id offline: "dm-" + the first 32 hex chars of sha256("<loAccountId>|<hiAccountId>"). No secret is involved (apps/mobile/src/infra/db/dmId.ts:29-38 is a byte-exact port of the backend).',
      'C calls GET /chat/conversations/<id>/messages?afterSeq=0 with its own token.',
      'C calls GET /conversations/<id> and GET /conversations/<id>/members.',
      'C calls POST /chat/messages for that conversation id with its own token.',
      'B re-reads the conversation.',
    ],
    expected:
      'Every one of those calls returns 403/404 for a non-member. Authentication is not authorization: membership must gate reads, metadata, member enumeration and writes.',
    actual:
      'Measured: (1) C reads the messages — 200, ["TOP SECRET between A and B"]. (2) With NO token the same call is correctly 401, so authentication IS enforced. (3) C reads conversation details — 200. (4) C enumerates the member list — 200, both account ids returned. (5) C WRITES into the DM — 201 with seq 2. (6) B then sees ["TOP SECRET between A and B","C INTRUDED HERE"]. Authorization is absent entirely on these routes.',
    user_impact:
      'Any single registered user can read every private conversation in the system and inject messages that appear to the real members as part of their chat. Because the DM id is sha256 of the sorted account-id pair, no enumeration or guessing is needed — and account ids are themselves obtainable from the member list of any conversation the attacker can already reach, which is all of them. This is a complete breach of message confidentiality and integrity.',
    suspected_cause:
      'The chat and conversation controllers derive the principal from the JWT (which is why impersonation via senderId is correctly rejected — see VC-SEC-021) but never check that principal against the conversation membership projection.',
    rootCause:
      'Confirmed by live reproduction: authentication is enforced (401 without a token) while authorization is not (200/201 for a non-member holding any valid token).',
    testIds: ['VC-SEC-020', 'VC-2DEV-024'],
    evidence: [
      'QA/evidence/api/VC-039_FAIL_2026-09-11_idor-read-write.log',
      'QA/evidence/api/VC-039_repro.mjs',
      'QA/evidence/api/api-2026-09-11.jsonl',
    ],
    refs: [
      'apps/mobile/src/infra/db/dmId.ts:29-38',
      'D:\\Velchat\\libs\\feature-chat\\src\\chat\\chat.controller.ts',
    ],
    regression: false,
    notes:
      'Highest-impact finding of the run. It also leaves E2EE as the only remaining confidentiality control — and E2EE is not implemented yet (the client still sends plaintext `content`), so there is no compensating control today.',
  },
  {
    id: 'VC-040',
    title:
      "A push endpoint can be registered against another account's userId, redirecting their push wake-ups",
    severity: 'P1',
    priority: 'P1',
    status: 'Open',
    layer: 'BACKEND',
    feature: 'Security / Push',
    component: 'platform-service /notifications/endpoints',
    environment: 'local backend axis6',
    device: 'node-harness',
    os: 'win32-x64',
    frequency: 'Always',
    reproducibility: '100%',
    preconditions: 'Two accounts A and B. B holds its own valid token.',
    steps: [
      "B POSTs /notifications/endpoints with its own bearer token and its own deviceId, but userId set to A's accountId and a push token B controls.",
      'Observe the response.',
    ],
    expected:
      "Rejected, or the row is bound to the token's principal (B). The client fills this userId from its own local state (apps/mobile/src/infra/push/api.ts:24-28, pushService.ts:455-460), so the server must never trust it.",
    actual: '201 Created. The endpoint row is accepted with a userId the caller merely asserted.',
    user_impact:
      "B receives A's push wake-ups — conversation ids, message types, and previews for non-E2EE chats. Combined with VC-039 the attacker can then read the referenced messages in full.",
    suspected_cause:
      "The endpoint upserts on device_id and trusts the body's userId rather than binding it to the verified token.",
    rootCause:
      'Confirmed by live reproduction. This upgrades audit finding S7 from a suspicion to a defect.',
    testIds: ['VC-SEC-024'],
    evidence: ['QA/evidence/api/api-2026-09-11.jsonl'],
    refs: [
      'apps/mobile/src/infra/push/api.ts:24-28',
      'apps/mobile/src/features/notifications/api/prefs.ts:23-36',
    ],
    regression: false,
    notes:
      'The same body-trusts-userId pattern appears in the notification prefs API and should be audited with it.',
  },
  {
    id: 'VC-041',
    title: 'POST /chat/messages accepts a conversationId that does not exist',
    severity: 'P1',
    priority: 'P1',
    status: 'Open',
    layer: 'BACKEND',
    feature: 'Messaging / Validation',
    component: 'messaging-service /chat/messages',
    environment: 'local backend axis6',
    device: 'node-harness',
    os: 'win32-x64',
    frequency: 'Always',
    reproducibility: '100%',
    preconditions: 'Any valid token.',
    steps: [
      'POST /chat/messages with conversationId "dm-does-not-exist-0000" and otherwise valid fields.',
    ],
    expected: '4xx — a message cannot belong to a conversation that does not exist.',
    actual:
      '201 Created. The message is persisted against a conversation id with no conversation row and no members.',
    user_impact:
      'Unbounded writes into a table with no owner, and it is the same missing check that makes VC-039 exploitable for writes. Messages accumulate that nobody can read or moderate.',
    suspected_cause: 'No existence or membership validation before the insert.',
    rootCause: 'Confirmed by live reproduction. Same missing check as VC-039.',
    testIds: ['VC-2DEV-024'],
    evidence: ['QA/evidence/api/api-2026-09-11.jsonl'],
    refs: [],
    regression: false,
    notes: 'Fix together with VC-039.',
  },
  {
    id: 'VC-042',
    title: 'POST /chat/messages accepts an empty or whitespace-only message',
    severity: 'P2',
    priority: 'P2',
    status: 'Open',
    layer: 'BACKEND',
    feature: 'Messaging / Validation',
    component: 'messaging-service /chat/messages',
    environment: 'local backend axis6',
    device: 'node-harness',
    os: 'win32-x64',
    frequency: 'Always',
    reproducibility: '100%',
    preconditions: 'A conversation the sender belongs to.',
    steps: ['POST /chat/messages with content "".', 'Repeat with "   " and with "\\n\\n".'],
    expected: '4xx for each — an empty bubble is not a message.',
    actual: '201 Created for all three. Empty messages are persisted and fan out to the recipient.',
    user_impact:
      'Empty bubbles in the conversation, and a trivial way to bump a chat to the top of the inbox with no content.',
    suspected_cause:
      'The content field is validated for type but not for emptiness after trimming.',
    rootCause: 'Confirmed by live reproduction.',
    testIds: ['VC-2DEV-023'],
    evidence: ['QA/evidence/api/api-2026-09-11.jsonl'],
    refs: [],
    regression: false,
    notes:
      'The mobile composer disables send for empty input, so this is only reachable from a non-VelChat client — but it is still an unvalidated write.',
  },
];

const known = new Set(registry.bugs.map((b) => b.id));
let added = 0;
for (const finding of findings) {
  if (known.has(finding.id)) continue;
  registry.bugs.push(finding);
  added += 1;
}
registry.bugs.sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true }));
writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
console.log(`added ${added} finding(s); registry now holds ${registry.bugs.length} bugs`);
