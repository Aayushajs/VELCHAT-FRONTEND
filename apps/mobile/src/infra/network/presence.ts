/**
 * Presence REST surface (§A15 / §B8, presence-service via the gateway `/presence/*`).
 *
 *   - `getPresence(userId, viewerId?, viewerIsContact?)` → GET /presence/:userId — the owner's
 *     privacy is enforced server-side when a `viewerId` is supplied (a hidden signal collapses to
 *     `offline` / strips `lastSeen`). Response `{ status, emoji?, text?, lastSeen }`.
 *   - `subscribePresence(watcher, targets[])` → POST /presence/subscribe — fan-out targets
 *     subscribers only (§A15.2); call it for the on-screen DM peer when a chat opens.
 *
 * Pure payload parsing (+ the live-frame `normalizePresenceEvent`) lives in `presenceShape.ts`.
 *
 * TWO GAPS this surface has to cover, both verified against the running backend:
 *
 *  1. NOBODY MARKS US ONLINE. `POST /presence/online` is documented as "realtime-gw calls this on
 *     connect", but the realtime gateway never does — it wires no presence client at all, and its
 *     `ping` handler refreshes only its OWN connection registry. Since the client never announced
 *     itself either, `online:{userId}` was never populated for anyone, so every peer looked
 *     offline no matter what they were doing. The client therefore announces its own presence.
 *  2. NO LIVE PUSH. The gateway's FanoutConsumer subscribes to message/receipt/caption only —
 *     never `presence.changed` — so a presence change cannot reach a socket. The REST snapshot is
 *     the only reliable path, and a one-shot read at chat-open goes stale immediately, so callers
 *     must re-read it while the chat is on screen. `normalizePresenceEvent` stays
 *     forward-compatible for when live presence push does land.
 *
 * Server-side TTLs that dictate the cadences (presence.repository.ts): `online:{u}` expires after
 * 30s (so heartbeat faster than that), and `subscribers:{u}` after 300s (so re-subscribe).
 */
import { api } from './client';
import { normalizePresence, type PresenceResult } from './presenceShape';

/**
 * Resolve a peer's rich presence + last-seen. Pass `viewerId` (= me) so the owner's last-seen/online
 * privacy is applied; `viewerIsContact` refines the "contacts-only" mode (defaults to unknown/false).
 */
export async function getPresence(
  userId: string,
  viewerId?: string,
  viewerIsContact?: boolean,
): Promise<PresenceResult> {
  const params: Record<string, string> = {};
  if (viewerId) {
    params.viewerId = viewerId;
    if (viewerIsContact !== undefined) {
      params.viewerIsContact = String(viewerIsContact);
    }
  }
  const res = await api.get(`/presence/${encodeURIComponent(userId)}`, {
    params,
  });
  return normalizePresence(res.data);
}

/** Subscribe `watcher` to the live presence of `targets` (the on-screen contacts / DM peer). */
export async function subscribePresence(
  watcher: string,
  targets: string[],
): Promise<void> {
  await api.post('/presence/subscribe', { watcher, targets });
}

/**
 * Server-side TTL of `online:{userId}` (presence.repository.ts `ONLINE_TTL_SEC`). Announcing
 * online without refreshing inside this window makes us drop offline while still connected.
 */
export const PRESENCE_ONLINE_TTL_MS = 30_000;

/**
 * Announce THIS device as online. Called when our realtime socket opens: the gateway does not do
 * it for us (see the header note), so without this the account is never in `online:{userId}` and
 * every peer sees it as offline.
 */
export async function presenceOnline(
  userId: string,
  deviceId: string,
): Promise<void> {
  await api.post('/presence/online', { userId, deviceId });
}

/**
 * Announce THIS device as offline (socket closed / app suspended / signed out). Also stamps
 * `lastseen:{userId}` server-side once the user's last device goes, which is what makes the
 * peer's "last seen ..." line truthful instead of frozen.
 */
export async function presenceOffline(
  userId: string,
  deviceId: string,
): Promise<void> {
  await api.post('/presence/offline', { userId, deviceId });
}

/** Refresh our online TTL. Must run more often than {@link PRESENCE_ONLINE_TTL_MS}. */
export async function presenceHeartbeat(userId: string): Promise<void> {
  await api.post('/presence/heartbeat', { userId });
}

export { normalizePresenceEvent } from './presenceShape';
export type { PresenceResult, PresenceEvent } from './presenceShape';
