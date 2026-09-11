/**
 * QA regression-test project — SEPARATE from the default `pnpm test` gate.
 *
 * Why a second project instead of adding these to the main suite: these tests encode defects that
 * are CURRENTLY PRESENT (see QA/reports/bugs.json). They are expected to fail until each bug is
 * fixed, so putting them in the default suite would leave the repo permanently red and train
 * everyone to ignore it. They run under their own script and their results are recorded by the QA
 * reporting pipeline, where a failure is the intended signal.
 *
 * When a bug is fixed, its test here turns green and becomes the permanent regression guard —
 * at that point move it into the main suite so the default gate protects it.
 *
 *   pnpm --filter @velchat/mobile test:qa
 */
const base = require('./jest.config');

module.exports = {
  ...base,
  displayName: 'qa-regression',
  testMatch: [
    '<rootDir>/src/**/*.qa.test.ts',
    '<rootDir>/src/**/*.qa.test.tsx',
  ],
  testPathIgnorePatterns: ['/node_modules/', '/e2e/', '/android/', '/ios/'],
};
