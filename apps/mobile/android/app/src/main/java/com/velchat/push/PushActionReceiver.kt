package com.velchat.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput
import org.json.JSONObject

/**
 * The notification's Reply / Mark as read / Mute buttons (ADR 0008).
 *
 * All three complete **without opening the app**, which is the whole point — an action that just
 * launches the activity is a worse version of tapping the notification. That means every one of
 * them has to work in a process with no React context, so the work is split:
 *
 *  - anything the server can be told with the push credential alone (a read receipt) happens
 *    here, natively, over `POST /notifications/ack`;
 *  - anything that needs the user's real session (sending a reply, writing a mute to
 *    `PUT /notifications/prefs`, clearing local unread) is queued in {@link PushStore} and handed
 *    to JS — immediately if a React context is alive, via a headless task if not, and on the next
 *    launch if even that is refused.
 *
 * The queue is what makes this honest: an action never silently does nothing. The worst case is
 * that it completes later than the user expected, and the notification says so.
 */
internal class PushActionReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    val conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID) ?: return
    val seq = intent.getLongExtra(EXTRA_SEQ, 0L)
    val appContext = context.applicationContext
    val store = PushStore(appContext)

    when (action) {
      ACTION_DISMISS -> {
        // Swiped away. Nothing to tell anyone — just stop the count from carrying over into the
        // next notification, which would otherwise say "3 new messages" for a single new one.
        store.clearCount(conversationId)
        return
      }

      ACTION_MUTE -> {
        val until = System.currentTimeMillis() + MUTE_DURATION_MS
        store.setMuted(conversationId, until)
        PushNotifications.cancel(appContext, store, conversationId)
        // The server holds the authoritative pref (`notification_prefs`), and only JS can write
        // it — that call needs the user's bearer token. Until then the native mute stands, so the
        // user gets silence immediately rather than at next launch.
        queueForJs(
            appContext,
            store,
            JSONObject()
                .put("type", "mute")
                .put("conversationId", conversationId)
                .put("mutedUntil", until),
        )
        return
      }

      ACTION_MARK_READ -> {
        PushNotifications.cancel(appContext, store, conversationId)
        // Local unread is JS's to clear (it owns the DB); the RECEIPT is not, and this is the
        // only path that can send it while the app is closed. Both, therefore.
        queueForJs(
            appContext,
            store,
            JSONObject()
                .put("type", "read")
                .put("conversationId", conversationId)
                .put("upToSeq", seq),
        )
        ackInBackground(store, conversationId, seq, PushAckClient.State.READ)
        return
      }

      ACTION_REPLY -> {
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(
                PushNotifications.REPLY_INPUT_KEY)?.toString()?.trim()
        if (text.isNullOrEmpty()) {
          // An empty inline reply is a mis-tap, not an instruction. Leave the notification alone.
          return
        }
        // Append the reply to the thread rather than cancelling: cancelling would make a message
        // that has not left the device yet look sent and gone.
        PushNotifications.showOwnReply(appContext, store, conversationId, text)
        queueForJs(
            appContext,
            store,
            JSONObject()
                .put("type", "reply")
                .put("conversationId", conversationId)
                .put("text", text)
                .put("upToSeq", seq)
                .put("at", System.currentTimeMillis()),
        )
        // Replying is proof of reading. Send the read receipt from here too, so the sender's tick
        // turns blue at the moment of the reply and not when the app is next opened.
        ackInBackground(store, conversationId, seq, PushAckClient.State.READ)
        return
      }
    }
  }

  /**
   * Persist the event, then try to get JS to act on it now.
   *
   * Persist FIRST, unconditionally. Every "act on it now" path can fail — no React context, a
   * background-start restriction, the process killed a moment later — and an action the user
   * pressed must survive all of them.
   */
  private fun queueForJs(context: Context, store: PushStore, event: JSONObject) {
    store.enqueueEvent(event)
    if (PushBridge.emitPendingEvents(context)) return
    try {
      PushHeadlessService.start(context)
    } catch (e: Throwable) {
      // Android's background-service restrictions can refuse this. The event stays queued and
      // JS drains it on the next launch — late, but never lost.
      Log.i(TAG, "headless start refused (${e.javaClass.simpleName}); event stays queued")
    }
  }

  /**
   * A `BroadcastReceiver` is killed the instant `onReceive` returns, so network work needs
   * `goAsync()` to hold the process open. The 10 s budget the system allows is well inside the
   * ack client's own timeouts.
   */
  private fun ackInBackground(
      store: PushStore,
      conversationId: String,
      seq: Long,
      state: PushAckClient.State,
  ) {
    if (seq <= 0L) return
    val result = goAsync()
    Thread {
          try {
            PushAckClient.ack(store, conversationId, seq, state)
          } catch (e: Throwable) {
            Log.w(TAG, "ack threw: ${e.javaClass.simpleName}")
          } finally {
            result.finish()
          }
        }
        .start()
  }

  internal companion object {
    private const val TAG = "VelChatPushAction"

    const val ACTION_REPLY = "com.velchat.push.REPLY"
    const val ACTION_MARK_READ = "com.velchat.push.MARK_READ"
    const val ACTION_MUTE = "com.velchat.push.MUTE"
    const val ACTION_DISMISS = "com.velchat.push.DISMISS"

    const val EXTRA_CONVERSATION_ID = "conversationId"
    const val EXTRA_SEQ = "seq"

    /**
     * One tap on "Mute" mutes for 8 hours — WhatsApp's shortest option, and the only one that is
     * safe to apply without asking. Muting "always" from a single button press is a decision the
     * user cannot see they made; the in-app chat settings offer the longer windows.
     */
    private const val MUTE_DURATION_MS = 8L * 60L * 60L * 1000L

    fun intent(context: Context, action: String, conversationId: String, seq: Long): Intent =
        Intent(context, PushActionReceiver::class.java).apply {
          this.action = action
          // Extras alone do NOT distinguish two PendingIntents — `Intent.filterEquals` ignores
          // them. Uniqueness comes from the per-(conversation, action) request code in
          // `PushNotifications.requestCode`; without it, FLAG_UPDATE_CURRENT would make one
          // conversation's Reply button carry another conversation's id.
          setPackage(context.packageName)
          putExtra(EXTRA_CONVERSATION_ID, conversationId)
          putExtra(EXTRA_SEQ, seq)
        }
  }
}
