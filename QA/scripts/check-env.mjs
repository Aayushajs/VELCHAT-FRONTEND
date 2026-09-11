#!/usr/bin/env node
/**
 * Environment validation (§47) — run before any test suite. Fails fast and loud if the backend
 * under test is not actually reachable, so a broken environment is never mistaken for a product
 * defect.
 */
import { validateEnvironment, env } from '../lib/env.js';

const { healthy, checks } = await validateEnvironment();

console.log(
  `\nQA environment check — mode=${env.mode}  apiBaseUrl=${env.apiBaseUrl}  wsBaseUrl=${env.wsBaseUrl}\n`,
);
for (const c of checks) {
  const mark = c.ok ? '✓' : '✗';
  console.log(
    `  ${mark} ${c.label.padEnd(32)} ${c.url}  ${c.ok ? `(${c.ms}ms)` : `FAILED: ${c.error ?? `HTTP ${c.status}`}`}`,
  );
}

if (!healthy) {
  console.error(
    '\nEnvironment is NOT healthy. Fix connectivity before running tests — a failure here is',
  );
  console.error('infrastructure, not a product bug (§47).\n');
  process.exit(1);
}

console.log('\nEnvironment OK.\n');
