/**
 * Notification preferences (§B10). Verified against the running backend at `D:\Velchat`:
 *
 *   PUT /notifications/prefs
 *     libs/feature-notification/src/notify/notification.controller.ts:20
 *     body: SetPrefsDto — {userId, scopeType, scopeId, level?, mutedUntil?, keywords?, dndSchedule?}
 *     upserted on (user_id, scope_type, scope_id)
 *
 * The server consults this before enqueuing ANY push (`notification.service.onMessageSent` →
 * `decideNotify`), which is what makes a mute actually stop the notification at source rather
 * than merely hide it on the device.
 */
import { api } from '../../../infra';

const PREFS_PATH = '/notifications/prefs';

/**
 * Mute (or unmute) one conversation for this account.
 *
 * `mutedUntil <= now` clears the mute: the DTO treats an omitted `mutedUntil` as "clear", and
 * the repository writes `$5` straight through, so passing null is how an unmute is expressed.
 */
export async function setConversationMute(
  userId: string,
  conversationId: string,
  mutedUntil: number,
): Promise<void> {
  const active = mutedUntil > Date.now();
  await api.put(PREFS_PATH, {
    userId,
    scopeType: 'conversation',
    scopeId: conversationId,
    // `level` is left alone: muting is a time window, and overwriting level to 'none' here
    // would silently discard a user's "mentions only" choice and never restore it.
    ...(active ? { mutedUntil: new Date(mutedUntil).toISOString() } : {}),
  });
}
