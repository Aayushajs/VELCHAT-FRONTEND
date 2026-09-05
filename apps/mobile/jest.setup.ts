/**
 * Global Jest setup (runs after the test framework is installed).
 *
 * Native modules absent under Jest are mocked here. @testing-library/react-native
 * auto-registers its matchers on import (no explicit extend-expect needed).
 */

// react-native-config's native module (RNCConfig) is null under Jest.
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: {
    ENV: 'dev',
    API_BASE_URL: 'http://localhost:8080',
    WS_URL: 'ws://localhost:8080/ws',
  },
}));

// Encrypted MMKV — native module absent under Jest; in-memory stand-in.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, unknown>();
  class MMKV {
    getString(k: string): unknown {
      return store.get(k);
    }
    getBoolean(k: string): unknown {
      return store.get(k);
    }
    getNumber(k: string): unknown {
      return store.get(k);
    }
    set(k: string, v: unknown): void {
      store.set(k, v);
    }
    delete(k: string): void {
      store.delete(k);
    }
    getAllKeys(): string[] {
      return [...store.keys()];
    }
    clearAll(): void {
      store.clear();
    }
  }
  // Reactive hooks used by the profile mirror — a static read is enough for tests.
  const useMMKVString = (k: string): [unknown, (v: unknown) => void] => [
    store.get(k),
    (v: unknown) => store.set(k, v),
  ];
  return { MMKV, useMMKVString };
});

// react-native-image-crop-picker uses a TurboModule that is absent under Jest and
// throws at import; stand it in with a cancelled-picker default.
jest.mock('react-native-image-crop-picker', () => ({
  __esModule: true,
  default: {
    openPicker: jest.fn(() => Promise.reject({ code: 'E_PICKER_CANCELLED' })),
    openCamera: jest.fn(() => Promise.reject({ code: 'E_PICKER_CANCELLED' })),
    openCropper: jest.fn(() =>
      Promise.resolve({ path: '', mime: 'image/jpeg' }),
    ),
    clean: jest.fn(() => Promise.resolve()),
    cleanSingle: jest.fn(() => Promise.resolve()),
  },
}));

// Native BlurView is absent under Jest — stand it in with a plain host component.
jest.mock('@react-native-community/blur', () => ({ BlurView: 'BlurView' }));

// WatermelonDB's native SQLite adapter is absent under Jest — use LokiJS in-memory adapter.
jest.mock('@nozbe/watermelondb/adapters/sqlite', () => {
  const LokiJSAdapter = require('@nozbe/watermelondb/adapters/lokijs').default;
  return jest.fn().mockImplementation(
    (opts: { schema?: unknown; migrations?: unknown }) =>
      new LokiJSAdapter({
        schema: opts?.schema,
        migrations: opts?.migrations,
        useWebWorker: false,
        useIncrementalIndexedDB: false,
      }),
  );
});

// FlashList → a plain host component under Jest (native recycler view absent).
jest.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }));

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(() =>
      Promise.resolve({ isConnected: true, type: 'wifi', details: {} }),
    ),
    addEventListener: jest.fn(() => () => undefined),
  },
}));

jest.mock('react-native-device-info', () => ({
  __esModule: true,
  default: {
    getBatteryLevel: jest.fn(() => Promise.resolve(0.9)),
    isBatteryCharging: jest.fn(() => Promise.resolve(false)),
    getPowerState: jest.fn(() =>
      Promise.resolve({
        batteryLevel: 0.9,
        batteryState: 'unplugged',
        lowPowerMode: false,
      }),
    ),
  },
}));

// No real network in unit/component tests — loaders must fall back gracefully.
(globalThis as { fetch?: unknown }).fetch = jest.fn(() =>
  Promise.reject(new Error('network disabled in tests')),
);

export {};
