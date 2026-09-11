/**
 * Test-result recording (§34, §42, §45).
 *
 * `qaTest()` wraps `node:test`'s `test()` so every case carries its matrix metadata — test id,
 * feature, severity if it fails, the scenario, expected behaviour — and appends a structured record
 * to `QA/reports/results.jsonl`. That append-only log is the single input to the Excel report, the
 * Jira sync, the flaky-test detector and the final report, so a number can never disagree between
 * them.
 *
 * Retry policy (§46): NONE here, deliberately. A deterministic assertion failure is a result, not
 * noise. Infrastructure retries are the orchestrator's job and are recorded as such.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { env } from './env.js';

const RESULTS = join(env.reportsDir, 'results.jsonl');
const RUN_ID = process.env.QA_RUN_ID ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;

mkdirSync(env.reportsDir, { recursive: true });

/** Device/OS/build context stamped onto every record (§32). */
const CONTEXT = {
  runId: RUN_ID,
  build: env.build,
  apiBaseUrl: env.apiBaseUrl,
  mode: env.mode,
  device: process.env.QA_DEVICE ?? 'node-harness',
  os: process.env.QA_OS ?? `${process.platform}-${process.arch}`,
  suite: process.env.QA_SUITE ?? 'unspecified',
};

export function recordResult(record) {
  appendFileSync(
    RESULTS,
    JSON.stringify({ ...CONTEXT, ...record, at: new Date().toISOString() }) + '\n',
    'utf8',
  );
}

/**
 * Declare a QA test case.
 *
 * @param {string} id      matrix id, e.g. `VC-RT-011`
 * @param {string} title   one-line scenario
 * @param {object} meta    `{ feature, severity, priority, steps, expected, preconditions, refs }`
 * @param {(t) => any} fn  the test body
 */
export function qaTest(id, title, meta, fn) {
  const {
    feature = 'unknown',
    severity = 'P2',
    skip = false,
    todo = false,
    timeout = 120_000,
  } = meta ?? {};

  test(`${id} · ${title}`, { skip, todo, timeout }, async (t) => {
    const started = Date.now();
    try {
      const outcome = await fn(t);
      recordResult({
        testId: id,
        title,
        feature,
        status: 'PASS',
        severity: null,
        durationMs: Date.now() - started,
        steps: meta?.steps ?? null,
        expected: meta?.expected ?? null,
        actual: typeof outcome === 'string' ? outcome : (outcome?.actual ?? null),
        refs: meta?.refs ?? null,
      });
    } catch (error) {
      recordResult({
        testId: id,
        title,
        feature,
        status: 'FAIL',
        severity,
        priority: meta?.priority ?? severity,
        durationMs: Date.now() - started,
        steps: meta?.steps ?? null,
        preconditions: meta?.preconditions ?? null,
        expected: meta?.expected ?? null,
        actual: String(error?.message ?? error),
        stack: String(error?.stack ?? '')
          .split('\n')
          .slice(0, 12)
          .join('\n'),
        received: error?.received ?? null,
        refs: meta?.refs ?? null,
      });
      throw error;
    }
  });
}

/** Record a case that could not run because the environment was invalid (§47) — never a bug. */
export function recordBlocked(id, title, meta, reason) {
  recordResult({
    testId: id,
    title,
    feature: meta?.feature ?? 'unknown',
    status: 'BLOCKED',
    severity: null,
    blockedReason: reason,
    expected: meta?.expected ?? null,
    refs: meta?.refs ?? null,
  });
}

/** Every historical record (all runs) — used by the flaky detector and the report. */
export function readAllResults() {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export { RUN_ID, RESULTS };
