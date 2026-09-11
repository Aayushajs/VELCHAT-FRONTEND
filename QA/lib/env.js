/**
 * QA environment resolution + validation (§47).
 *
 * Every value comes from the process environment with a dev-local default, so the suite is
 * reproducible on a laptop and configurable in CI. NOTHING here is a secret and nothing is
 * committed: credentials (Jira token, BrowserStack key) are read from the environment only and
 * are never echoed.
 *
 * Two addressing modes, because the dev Render deployment's edge gateway cannot reach its
 * upstreams (VC-ENV-001):
 *   - `gateway`  : one origin proxies every path (local `:8080`, and production's Caddy).
 *   - `direct`   : per-service origins, selected by longest-prefix path match.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Load `QA/config/qa.env` if present (KEY=VALUE, `#` comments). Real env always wins. */
function loadDotEnv() {
  const file = resolve(import.meta.dirname, '..', 'config', 'qa.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const pick = (name, fallback) => process.env[name] ?? fallback;

/** Longest-prefix service routing for `direct` mode (mirrors the backend gateway table). */
const SERVICE_PREFIXES = [
  ['/ws', 'realtime'],
  ['/realtime', 'realtime'],
  ['/auth', 'identity'],
  ['/.well-known', 'identity'],
  ['/users', 'identity'],
  ['/contacts', 'identity'],
  ['/orgs', 'identity'],
  ['/workspaces', 'identity'],
  ['/teams', 'identity'],
  ['/chat', 'messaging'],
  ['/messages', 'messaging'],
  ['/conversations', 'messaging'],
  ['/polls', 'messaging'],
  ['/channels', 'messaging'],
  ['/groups', 'messaging'],
  ['/communities', 'messaging'],
  ['/presence', 'platform'],
  ['/status', 'platform'],
  ['/notifications', 'platform'],
  ['/feature-flags', 'platform'],
  ['/media', 'content'],
  ['/files', 'content'],
  ['/search', 'content'],
  ['/calls', 'platform'],
  ['/meetings', 'platform'],
];

export const env = {
  /** `gateway` (single origin) or `direct` (per-service origins). */
  mode: pick('QA_MODE', 'gateway'),
  apiBaseUrl: pick('API_BASE_URL', 'http://localhost:8080').replace(/\/+$/, ''),
  wsBaseUrl: pick('WS_BASE_URL', 'ws://localhost:8080/ws'),

  /** Per-service origins used only when `QA_MODE=direct`. */
  services: {
    identity: pick('SVC_IDENTITY_URL', 'https://velchat-identity-service-2aje.onrender.com'),
    messaging: pick('SVC_MESSAGING_URL', 'https://velchat-messaging-service-2aje.onrender.com'),
    realtime: pick('SVC_REALTIME_URL', 'https://velchat-realtime-service-2aje.onrender.com'),
    content: pick('SVC_CONTENT_URL', 'https://velchat-content-service-2aje.onrender.com'),
    platform: pick('SVC_PLATFORM_URL', 'https://velchat-platform-service-2aje.onrender.com'),
  },

  /**
   * Deterministic test identities (§27). Never production numbers. The `+9190000001xx` block is
   * reserved for QA; provisioning goes through the real auth flow, not a seeded DB row.
   */
  users: {
    a: {
      phone: pick('TEST_USER_A_PHONE', '+919000000101'),
      email: pick('TEST_USER_A_EMAIL', 'qa-user-a@velchat.test'),
    },
    b: {
      phone: pick('TEST_USER_B_PHONE', '+919000000102'),
      email: pick('TEST_USER_B_EMAIL', 'qa-user-b@velchat.test'),
    },
    c: {
      phone: pick('TEST_USER_C_PHONE', '+919000000103'),
      email: pick('TEST_USER_C_EMAIL', 'qa-user-c@velchat.test'),
    },
  },

  androidPackage: pick('QA_ANDROID_PACKAGE', 'com.velchat.dev'),
  build: pick('QA_BUILD', 'local-dev'),
  timeoutMs: Number(pick('QA_TIMEOUT_MS', '30000')),
  /** Per-test budget for "an event should have arrived by now" waits. Never an unconditional sleep. */
  eventTimeoutMs: Number(pick('QA_EVENT_TIMEOUT_MS', '10000')),
  evidenceDir: resolve(import.meta.dirname, '..', 'evidence'),
  reportsDir: resolve(import.meta.dirname, '..', 'reports'),
};

/** Resolve the origin that serves `path` under the active addressing mode. */
export function originFor(path) {
  if (env.mode !== 'direct') return env.apiBaseUrl;
  const hit = SERVICE_PREFIXES.filter(
    ([p]) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'),
  ).sort((x, y) => y[0].length - x[0].length)[0];
  return (hit ? env.services[hit[1]] : env.services.identity).replace(/\/+$/, '');
}

/**
 * Fail fast on an invalid environment (§47) — an unreachable backend must be reported as an
 * ENVIRONMENT failure, never as a product bug.
 */
export async function validateEnvironment() {
  const checks = [];
  const probe = async (label, url, expect = [200]) => {
    const started = Date.now();
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(env.timeoutMs) });
      const ok = expect.includes(res.status);
      checks.push({ label, url, status: res.status, ms: Date.now() - started, ok });
      return ok;
    } catch (e) {
      checks.push({
        label,
        url,
        status: 0,
        ms: Date.now() - started,
        ok: false,
        error: String(e.message ?? e),
      });
      return false;
    }
  };

  await probe('api /health', `${originFor('/health')}/health`);
  await probe(
    'identity /.well-known/jwks.json',
    `${originFor('/.well-known')}/.well-known/jwks.json`,
  );
  await probe('messaging /health', `${originFor('/chat')}/health`);
  await probe('platform /health', `${originFor('/notifications')}/health`);
  await probe('content /health', `${originFor('/media')}/health`);
  await probe(
    'realtime /health',
    `${env.wsBaseUrl.replace(/^ws/, 'http').replace(/\/ws\/?$/, '')}/health`,
  );

  const healthy = checks.every((c) => c.ok);
  return { healthy, checks };
}
