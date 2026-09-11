module.exports = {
  preset: '@react-native/jest-preset',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // `*.qa.test.*` belongs to the QA regression project (jest.qa.config.js), not to this gate:
  // those tests encode defects that are still open, so they are expected to fail until fixed.
  // Run them with `pnpm test:qa`. See QA/TEST-STRATEGY.md.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/e2e/',
    '/android/',
    '/ios/',
    '\\.qa\\.test\\.(ts|tsx)$',
  ],
  // pnpm nests deps under node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>.
  // Allow that optional prefix so RN-ecosystem ESM packages are still transformed
  // (default RN pattern assumes a flat node_modules).
  transformIgnorePatterns: [
    'node_modules/(?!(?:.pnpm/[^/]+/node_modules/)?(?:@react-native|react-native|@react-native-community|@react-navigation|@shopify|@noble|zustand|react-native-[^/]+)/)',
  ],
  // @testing-library/react-native auto-registers its Jest matchers on import.
};
