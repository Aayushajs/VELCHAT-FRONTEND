/**
 * QA regression guard — env resolution must never let `name` and `apiBaseUrl` disagree (VC-035).
 */
import { resolveAppEnv } from '../env';

describe('VC-035 — a misbuilt binary must not report a safe name while pointing at production', () => {
  it('a fully configured dev build resolves to dev with its own URLs', () => {
    const env = resolveAppEnv(
      'dev',
      'http://localhost:8080',
      'ws://localhost:8080/ws',
    );
    expect(env).toEqual({
      name: 'dev',
      apiBaseUrl: 'http://localhost:8080',
      wsUrl: 'ws://localhost:8080/ws',
    });
  });

  it('stage and prod pass through unchanged when fully configured', () => {
    expect(
      resolveAppEnv('stage', 'https://stage.example', 'wss://stage.example/ws')
        .name,
    ).toBe('stage');
    expect(
      resolveAppEnv('prod', 'https://prod.example', 'wss://prod.example/ws')
        .name,
    ).toBe('prod');
  });

  it('a completely empty Config (react-native-config never linked) falls back to prod for BOTH name and URL — never a mismatch', () => {
    const env = resolveAppEnv(undefined, undefined, undefined);
    expect(env.name).toBe('prod');
    expect(env.apiBaseUrl).toBe('https://velchat.duckdns.org');
    expect(env.wsUrl).toBe('wss://velchat.duckdns.org/ws');
  });

  it('an unrecognised ENV value also falls back to prod, not dev', () => {
    const env = resolveAppEnv('staging-typo', undefined, undefined);
    expect(env.name).toBe('prod');
  });

  it('never returns name:"dev" while apiBaseUrl is the production host', () => {
    // The exact defect: ENV missing but the name fallback used to be 'dev' regardless.
    const env = resolveAppEnv(undefined, undefined, undefined);
    const pointsAtProd = env.apiBaseUrl.includes('duckdns.org');
    expect(pointsAtProd && env.name === 'dev').toBe(false);
  });
});
