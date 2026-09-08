/**
 * User directory API (§B3, backend user-service /users). Thin typed wrappers over
 * the shared axios client — the response envelope is unwrapped by the interceptor.
 */
import { api } from '../../../infra';
import { normalizeProfile, type Profile } from './profileShape';
import { subscribeProfileChanged } from '../../../core';

export { normalizeProfile };
export type { Profile };

// Short-lived profile cache + in-flight dedup. The New-Chat DP fetches + inbox backfill + startDm
// all resolve the same peer profiles; without this they'd fire many duplicate GET /profile calls
// (and trip the edge rate limit → 429). Keyed by userId, 5-min TTL, in-memory (session).
// BOUNDED (§M0 rule 7): a TTL alone never removes anything, so a long session browsing the
// directory grew this map without limit. Profiles are also another account's data — logout
// must call `clearProfileCache()`.
// Whoever caches a profile must hear when it changes; otherwise a successful photo change keeps
// serving the old one until this TTL happens to expire.
subscribeProfileChanged(accountId => {
  profileCache.delete(accountId);
});

const PROFILE_TTL_MS = 5 * 60_000;
const PROFILE_CACHE_CAP = 200;
const profileCache = new Map<string, { at: number; profile: Profile }>();
const profileInFlight = new Map<string, Promise<Profile>>();

// In-flight requests started before a logout must not repopulate a cleared cache.
let generation = 0;

/** Insert as most-recently-used (Map keeps insertion order) and evict the oldest over cap. */
function cacheProfile(userId: string, profile: Profile): void {
  profileCache.delete(userId);
  profileCache.set(userId, { at: Date.now(), profile });
  while (profileCache.size > PROFILE_CACHE_CAP) {
    const oldest: string | undefined = profileCache.keys().next().value;
    if (oldest === undefined) break;
    profileCache.delete(oldest);
  }
}

/** Drop every cached profile. MUST be called on logout — these belong to that account. */
export function clearProfileCache(): void {
  generation += 1;
  profileCache.clear();
  profileInFlight.clear();
}

export async function getProfile(userId: string): Promise<Profile> {
  const cached = profileCache.get(userId);
  if (cached) {
    if (Date.now() - cached.at < PROFILE_TTL_MS) return cached.profile;
    profileCache.delete(userId); // expired: drop it rather than let it sit forever
  }
  const inFlight = profileInFlight.get(userId);
  if (inFlight) return inFlight;

  const gen = generation;
  const p = api
    .get(`/users/${userId}/profile`)
    .then(res => {
      const profile = normalizeProfile(res.data);
      if (gen === generation) cacheProfile(userId, profile);
      return profile;
    })
    .finally(() => profileInFlight.delete(userId));
  profileInFlight.set(userId, p);
  return p;
}

/**
 * Attach/confirm the account's verified email (§B2.1, auth-service). @gmail.com only for now;
 * the server enforces global uniqueness and throws 409 ("already in use") which the axios layer
 * surfaces as an AppError. accountId is taken from the token server-side (not sent).
 */
export async function setAccountEmail(
  email: string,
): Promise<{ email: string }> {
  const res = await api.post('/auth/email', { email });
  return res.data as { email: string };
}

export async function updateProfile(
  userId: string,
  patch: Partial<Profile>,
): Promise<Profile> {
  const res = await api.put(`/users/${userId}/profile`, patch);
  const profile = normalizeProfile(res.data);
  cacheProfile(userId, profile); // keep the cache fresh, don't serve stale
  return profile;
}

// ── Media (avatar) upload (§B11): init → single multipart PUT ──
export interface InitUploadResult {
  mediaId: string;
  uploadPath: string;
}

/** Reserve a media id + upload path for the owner's new blob. */
export async function initUpload(
  ownerId: string,
  mime: string,
): Promise<InitUploadResult> {
  const res = await api.post('/media/uploads', { ownerId, mime });
  return res.data as InitUploadResult;
}

/** PUT the picked image bytes (multipart) to the reserved path. */
export async function uploadMediaFile(
  uploadPath: string,
  file: { uri: string; name: string; type: string },
): Promise<void> {
  const form = new FormData();
  // RN FormData accepts a { uri, name, type } part — cast past the DOM Blob type.
  form.append('file', {
    uri: file.uri,
    name: file.name,
    type: file.type,
  } as unknown as Blob);
  // Let React Native's networking set `multipart/form-data; boundary=…`. Forcing a
  // boundary-less Content-Type (or the axios JSON default) leaves the server unable to
  // delimit the parts → the upload fails to parse. `transformRequest` keeps the FormData
  // untouched by axios. (Verify on-device against the media-service multipart parser.)
  await api.put(uploadPath, form, {
    headers: { 'Content-Type': null },
    transformRequest: data => data,
  });
}

/**
 * Resolve a stored mediaId to a short-lived signed URL for display (§B11). Used to show
 * the avatar on a fresh install where the local picked uri is gone — the server copy
 * (avatarMediaId on the profile) is fetched on demand.
 */
export async function getMediaUrl(
  mediaId: string,
  ttl = 600,
): Promise<{ url: string; mime: string }> {
  const res = await api.get(`/media/${mediaId}/url`, { params: { ttl } });
  return res.data as { url: string; mime: string };
}
