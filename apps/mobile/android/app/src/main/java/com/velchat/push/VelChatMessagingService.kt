package com.velchat.push

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * Where a closed app becomes a delivered message (ADR 0008).
 *
 * ## The bug this fixes
 *
 * Receipts used to be WebSocket-only. A recipient whose phone was online but whose app was
 * CLOSED could never acknowledge anything, so the sender sat on one grey tick indefinitely — for
 * a message that HAD reached the device. `onMessageReceived` runs in exactly that situation, with
 * no Activity, no React context and no JS runtime, which is why the acknowledgement is sent from
 * here in Kotlin over `POST /notifications/ack` (authenticated by the push token; see
 * `PushAckClient`).
 *
 * ## Why the ack is synchronous
 *
 * FCM keeps the process alive for the duration of this method — roughly 20 s for a high-priority
 * data message, and every push from this backend is `android.priority: high`. Handing the ack to
 * a background executor and returning would race the process being torn down, which is the
 * failure mode that looks like "it works on my phone, sometimes". Blocking here is what keeps the
 * ack alive.
 *
 * ## Order of work
 *
 * Notify first, then acknowledge. The notification is a local, sub-millisecond operation and it
 * is what the user perceives; the ack is a network round trip. Doing them the other way round
 * would put the radio's wake-up latency in front of the user's notification for no gain.
 */
class VelChatMessagingService : FirebaseMessagingService() {

  override fun onCreate() {
    super.onCreate()
    // On a killed-app wake this is the first VelChat code to run in the process, so the channels
    // may genuinely not exist yet. A notification posted to a missing channel is dropped without
    // a word on API 26+.
    PushNotifications.ensureChannels(this)
  }

  /**
   * FCM issued a new registration token.
   *
   * The old token is dead the moment this fires, so the backend has to be re-pointed or push
   * silently stops working until the next cold start. JS owns that call (it needs the bearer
   * token), so the token is cached for the ack path and JS is told — immediately if it is alive,
   * through the queue if it is not.
   */
  override fun onNewToken(token: String) {
    super.onNewToken(token)
    val store = PushStore(this)
    store.setPushToken(token)
    Log.i(TAG, "registration token rotated")

    if (!PushBridge.emit(this, PushBridge.EVENT_TOKEN, token)) {
      store.enqueueEvent(JSONObject().put("type", "token").put("token", token))
    }
  }

  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    val type = data["type"] ?: return
    val store = PushStore(this)

    when (type) {
      "message" -> handleMessage(store, data)
      "call" -> PushNotifications.showCall(this, data["callId"] ?: return, data["conversationId"])
      else -> Log.i(TAG, "ignoring unknown push type: $type")
    }
  }

  private fun handleMessage(store: PushStore, data: Map<String, String>) {
    val conversationId = data["conversationId"]?.takeIf { it.isNotBlank() } ?: return
    // Log the ARRIVAL, unconditionally.
    //
    // Everything here used to log only on failure, which made the most important question
    // unanswerable from a device log: did the push reach the app at all? Silence meant either
    // "never arrived" or "arrived and worked", and those need completely different fixes. No ids
    // or content — the conversation is hashed and the body is only measured.
    Log.i(
        TAG,
        "push received: conv=${conversationId.hashCode()} seq=${data["seq"]} " +
            "kind=${data["kind"]} previewChars=${data["preview"]?.length ?: 0}",
    )
    // Every FCM data value is a string on the wire, so `seq` arrives as "42". Comparing that
    // against a numeric watermark would never match — parse it once, here.
    val seq = data["seq"]?.toLongOrNull() ?: 0L

    // Suppress ONLY for the conversation the user is actually reading.
    //
    // "The app is resumed" was too broad, and wrong in two directions: someone reading chat A got
    // nothing for a message in chat B, and someone whose socket had quietly died got neither the
    // message nor a notification — which reads as the app being broken rather than offline. The
    // server already skips pushes for a user it believes is online; this is the local, narrower
    // check for the one case a notification would genuinely be noise.
    val onScreen =
        PushBridge.isAppResumed(this) && store.activeConversationId() == conversationId
    if (onScreen) Log.i(TAG, "notification skipped: this chat is on screen")
    if (!onScreen) {
      // Isolated on purpose. The ack below is the ONLY thing that can produce a second tick for
      // a closed app, and it runs after this — so anything that can throw while drawing a
      // notification (an OEM's NotificationManager refusing `activeNotifications`, a resource
      // that resolved differently after an update) must not be allowed to take it down with it.
      // Failing to notify is a visible annoyance; failing to acknowledge is the bug this whole
      // service exists to fix.
      try {
        val shown = PushNotifications.showMessage(
            this,
            store,
            conversationId,
            seq,
            // Present only when the server genuinely holds readable plaintext; absent for an
            // encrypted message or an attachment, and the notification degrades on its own.
            data["preview"],
            data["kind"],
            data["senderId"],
        )
        // False means a deliberate early return — muted, notifications off, or a blocked
        // channel. Indistinguishable from a crash without saying so.
        if (!shown) Log.i(TAG, "notification NOT shown (muted / notifications off / channel)")
      } catch (e: Throwable) {
        Log.w(TAG, "notification post failed: ${e.javaClass.simpleName}")
      }
    }

    // Acknowledge REGARDLESS of whether anything was shown. "The device received it" is true
    // even when the conversation is muted or notifications are switched off, and conflating the
    // two is exactly what strands a sender on one tick after their friend mutes the chat.
    //
    // Blocking on purpose — see the class comment.
    if (seq > 0L) {
      val acked = PushAckClient.ack(store, conversationId, seq, PushAckClient.State.DELIVERED)
      if (!acked) {
        // Not lost: the client re-derives every owed receipt on its next socket connect
        // (`reassertReceipts()`), so this costs latency rather than a permanently stuck tick.
        Log.i(TAG, "delivered ack not accepted; will be re-asserted on next connect")
      }
    }

    // Finally, let a live JS runtime pull the message down now rather than at next foreground.
    val payload =
        Arguments.createMap().apply {
          putString("type", "message")
          putString("conversationId", conversationId)
          data["messageId"]?.let { putString("messageId", it) }
          data["senderId"]?.let { putString("senderId", it) }
          data["kind"]?.let { putString("kind", it) }
          if (seq > 0L) putString("seq", seq.toString())
        }
    PushBridge.emit(this, PushBridge.EVENT_MESSAGE, payload)
  }

  /**
   * FCM dropped messages for this device (too many queued, or the device was offline too long).
   *
   * There is nothing to notify about — the ids are gone — but the app MUST resync, or those
   * messages arrive only when the user happens to open the app. Queued so JS does a cursor sync.
   */
  override fun onDeletedMessages() {
    super.onDeletedMessages()
    Log.i(TAG, "FCM reported dropped messages — requesting a full resync")
    val store = PushStore(this)
    store.enqueueEvent(JSONObject().put("type", "resync"))
    PushBridge.emitPendingEvents(this)
  }

  private companion object {
    private const val TAG = "VelChatPush"
  }
}
