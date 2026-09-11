/**
 * Post-verify-002 registry update.
 *
 * Full re-verification against a freshly restarted local backend (fixing an unrelated DB/Redis
 * connection-pool staleness that had nothing to do with any filed defect). Result: every
 * previously filed defect that has an executable covering test reproduced IDENTICALLY. Zero
 * fixes to report. One new defect found (concurrent refresh race).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REGISTRY = resolve(import.meta.dirname, '..', 'reports', 'bugs.json');
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));

// VC-014's testIds included VC-AUTH-024, which verifies the BACKEND's reuse-detection/family-revoke
// behaviour (already known-good) — it does not exercise VC-014's actual claim, which is about the
// CLIENT silently swallowing that revoke signal. Leaving the mapping in place would make a passing
// backend test look like proof the client bug is fixed, which it is not. VC-UNIT-105 was never
// implemented as a runnable test. Correct the mapping so no future run misreports this as fixed.
const vc014 = registry.bugs.find((b) => b.id === 'VC-014');
if (vc014) {
  vc014.testIds = [];
  vc014.notes =
    (vc014.notes ? `${vc014.notes} ` : '') +
    'No automated test currently exercises the client-side claim (device re-login after a family ' +
    "revoke swallows the signal). VC-AUTH-024 was removed from testIds: it verifies the BACKEND's " +
    'revoke-on-reuse behaviour (confirmed working since the first run) but says nothing about the ' +
    'client. Needs an RN-level test or a manual repro to close.';
}

const newFinding = {
  id: 'VC-043',
  title: 'Concurrent refresh-token requests can all succeed — rotation is not race-safe',
  severity: 'P1',
  priority: 'P1',
  status: 'Open',
  layer: 'BACKEND',
  feature: 'Authentication / Tokens',
  component: 'identity-service /auth/token/refresh',
  environment: 'local backend axis6',
  device: 'node-harness',
  os: 'win32-x64',
  frequency: 'Observed 1/1 (3 of 3 concurrent requests succeeded)',
  reproducibility: 'Needs repeat runs to establish a rate, but reproduced on first attempt',
  preconditions: 'A valid, not-yet-rotated refresh token.',
  steps: [
    'Provision an identity and note its refresh token R.',
    'Fire three POST /auth/token/refresh requests with R SIMULTANEOUSLY (Promise.all, no sequencing).',
    'Count how many return a 2xx with a new token set.',
  ],
  expected:
    'At most one request succeeds; rotation must be atomic so the first winner invalidates R for every ' +
    'other in-flight request. Otherwise reuse detection (VC-AUTH-024, confirmed working for a SEQUENTIAL ' +
    'replay) cannot do its job against a concurrent one, and the "whole family revoked on reuse" security ' +
    'property has a race window.',
  actual: 'All 3 of 3 concurrent requests returned a new, distinct token set. None were rejected.',
  user_impact:
    'A refresh token, once briefly exposed (e.g. captured by a MITM despite TLS, or replayed from a ' +
    'compromised client queue), can be redeemed multiple times in the race window before the first ' +
    'rotation commits — defeating the single-use guarantee rotation is meant to provide.',
  suspected_cause:
    'The refresh handler likely reads-then-writes the token record without a compare-and-swap or row lock across concurrent requests for the same token.',
  rootCause: 'Unknown — requires engineering investigation.',
  testIds: ['VC-AUTH-027'],
  evidence: ['QA/reports/results.jsonl'],
  refs: ['docs/backend-integration-reference.md §3'],
  regression: false,
  notes:
    'Found during the 2026-09-11 re-verification pass (run verify-002), not in the original audit.',
};

if (!registry.bugs.some((b) => b.id === newFinding.id)) {
  registry.bugs.push(newFinding);
}
registry.bugs.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
console.log(
  'VC-014 mapping corrected; VC-043 added. Registry now holds',
  registry.bugs.length,
  'bugs.',
);
