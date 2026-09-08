/**
 * The backend surface for push registration — ONE real endpoint, verified against the running
 * backend at `D:\Velchat`:
 *
 *   POST /notifications/endpoints
 *     libs/feature-notification/src/notify/notification.controller.ts:49
 *     body: RegisterEndpointDto  (notification.dto.ts) — {deviceId, userId, platform, token?,
 *           voipToken?, subscription?}
 *     storage: UPSERT ON CONFLICT (device_id)  (notification.repository.ts:63)
 *
 * The upsert is why a duplicate POST is harmless, and why re-registering after an account switch
 * correctly re-points the row at the new `user_id`.
 *
 * NOTE (backend gap): there is **no DELETE**. The controller exposes only `PUT/GET
 * /notifications/prefs` and this `POST`. Un-registering is therefore emulated by re-POSTing the
 * same device with the token omitted, which NULLs `push_endpoints.token`.
 */
import { api } from '../network';
import type { RegisterEndpointBody } from './types';

const ENDPOINTS_PATH = '/notifications/endpoints';

/** Register (or re-point) this device's push endpoint. Idempotent server-side. */
export async function registerPushEndpoint(
  body: RegisterEndpointBody,
): Promise<void> {
  await api.post(ENDPOINTS_PATH, body);
}

/**
 * Best-effort un-registration at logout: the same upsert with NO token, which clears the stored
 * token for this `device_id` so the previous account's pushes cannot land on this handset.
 *
 * This is a workaround for a missing DELETE, not a designed API — see the note above. It must be
 * called while the access token is still valid (i.e. BEFORE `clearSession()`).
 */
export async function clearPushEndpoint(
  deviceId: string,
  userId: string,
  platform: RegisterEndpointBody['platform'],
): Promise<void> {
  await api.post(ENDPOINTS_PATH, { deviceId, userId, platform });
}
