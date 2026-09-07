package com.velchat.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import com.velchat.MainActivity
import com.velchat.R

/**
 * Posting and clearing VelChat notifications from Kotlin (ADR 0008).
 *
 * Kotlin, not JS, because the case that matters is a KILLED app: the app must show the
 * notification and it must ack delivery, and spinning up a Hermes runtime per push to draw a
 * two-line notification is exactly the 03:00 battery cost §R6 forbids on a 3 GB device (§M0.1).
 *
 * ## What the notification can and cannot say
 *
 * The push carries the message body only when the server genuinely holds readable plaintext —
 * the backend's `preview.ts` owns that rule and drops the preview the moment a message is
 * encrypted, so this file must degrade gracefully to "New message" rather than assume a body.
 *
 * NAMES are never sent. The push identifies the conversation and the sender by ID, and both are
 * resolved from the maps JS mirrors into {@link PushStore} — so a display name never leaves the
 * device, and an unknown id costs a generic title instead of a wrong one.
 *
 * ## The three actions
 *
 * Reply, Mark as read and Mute all complete WITHOUT opening the app, because a notification
 * action that just launches the app is a worse version of tapping the notification.
 * {@link PushActionReceiver} handles them.
 */
internal object PushNotifications {

  const val CHANNEL_MESSAGES = "velchat.messages.v1"
  const val CHANNEL_CALLS = "velchat.calls.v1"

  /** Bundling key. Android auto-bundles from 4 notifications; the explicit group + summary
   *  makes the collapsed state say "5 new messages" instead of listing five identical lines. */
  private const val GROUP_MESSAGES = "velchat.group.messages"

  /** Reserved so a conversation's own id can never collide with the summary. */
  private const val SUMMARY_ID = 1

  /** `RemoteInput` result key — read back by {@link PushActionReceiver}. */
  const val REPLY_INPUT_KEY = "velchat.reply.text"

  // ── channels ───────────────────────────────────────────────────────────────

  /**
   * Idempotent. Called from `VelChatMessagingService.onCreate` as well as from JS init, because
   * on a killed-app wake the service is the FIRST thing that runs and a notification posted to a
   * channel that does not exist is silently dropped on API 26+.
   */
  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return

    val messages =
        NotificationChannel(
                CHANNEL_MESSAGES,
                context.getString(R.string.push_channel_messages_name),
                NotificationManager.IMPORTANCE_HIGH,
            )
            .apply {
              description = context.getString(R.string.push_channel_messages_desc)
              enableVibration(true)
              enableLights(true)
              setShowBadge(true)
            }

    val calls =
        NotificationChannel(
                CHANNEL_CALLS,
                context.getString(R.string.push_channel_calls_name),
                NotificationManager.IMPORTANCE_HIGH,
            )
            .apply {
              description = context.getString(R.string.push_channel_calls_desc)
              enableVibration(true)
              setShowBadge(false)
            }

    manager.createNotificationChannel(messages)
    manager.createNotificationChannel(calls)
  }

  // ── posting ────────────────────────────────────────────────────────────────

  /**
   * Post (or update) the notification for one conversation.
   *
   * Returns false when nothing was shown — a muted conversation, a revoked
   * `POST_NOTIFICATIONS`, or a channel the user turned off. The caller still acks delivery in
   * that case: "the device received it" is true regardless of whether the user was told, and
   * conflating the two is what leaves a sender on one tick after the recipient mutes a chat.
   */
  fun showMessage(
      context: Context,
      store: PushStore,
      conversationId: String,
      seq: Long,
      /** The message body, when the server was able to send one. See the backend's `preview.ts`. */
      preview: String?,
      /** Message type — `text`, `image`, … Used to describe a message that has no body. */
      kind: String?,
      /** The SENDER's account id. In a group this is not the conversation. */
      senderId: String?,
  ): Boolean {
    if (conversationId.isBlank()) return false
    if (store.isMuted(conversationId)) return false
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false

    ensureChannels(context)

    val count = store.bumpCount(conversationId)
    val conversationName =
        store.conversationName(conversationId) ?: context.getString(R.string.app_name)
    val senderName = senderId?.let { store.personName(it) }
    // A DM's conversation name IS the other person, so prefixing there would read "Aayush:
    // Aayush". A group's differs, and that is exactly when attribution matters. Deriving it this
    // way avoids mirroring a separate is-group flag that could disagree with the names.
    val isGroup = senderName != null && senderName != conversationName

    val body = preview?.takeIf { it.isNotBlank() } ?: describeKind(context, kind)
    val lines =
        store.appendLine(
            conversationId,
            PushStore.Line(senderName ?: conversationName, body, System.currentTimeMillis()),
        )

    val id = notificationId(conversationId)
    val builder =
        NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(context.getColor(R.color.push_accent))
            .setStyle(messagingStyle(context, conversationName, isGroup, lines))
            // Set as well as styled: the lock screen, Wear, and some launchers read these
            // directly and show nothing at all if only the style is populated.
            .setContentTitle(conversationName)
            .setContentText(if (isGroup && lines.size == 1) "${senderName}: $body" else body)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setNumber(count)
            .setGroup(GROUP_MESSAGES)
            .setContentIntent(openConversationIntent(context, conversationId, id))
            .setDeleteIntent(dismissIntent(context, conversationId, id))
            .addAction(replyAction(context, conversationId, seq, id))
            .addAction(markReadAction(context, conversationId, seq, id))
            .addAction(muteAction(context, conversationId, id))

    postSafely(context, id, builder.build())
    postSummary(context, store)
    return true
  }

  /**
   * Render the conversation as a thread.
   *
   * `MessagingStyle` is what gives a chat notification its native shape — per-sender attribution,
   * the inline-reply affordance wired to the right place, and correct collapsing on the lock
   * screen and Wear. Building the same thing out of `InboxStyle` looks close and behaves worse.
   */
  private fun messagingStyle(
      context: Context,
      conversationName: String,
      isGroup: Boolean,
      lines: List<PushStore.Line>,
  ): NotificationCompat.MessagingStyle {
    val me = Person.Builder().setName(context.getString(R.string.push_you)).setKey("me").build()
    val style = NotificationCompat.MessagingStyle(me).setGroupConversation(isGroup)
    if (isGroup) style.conversationTitle = conversationName
    for (line in lines) {
      // A reply the user sent from the notification is attributed to THEM, so the thread reads
      // as a conversation rather than as the peer quoting the user back at themselves.
      val person =
          if (line.mine) me
          else {
            val name = line.sender ?: conversationName
            Person.Builder().setName(name).setKey(name).build()
          }
      style.addMessage(line.text, line.at, person)
    }
    return style
  }

  /**
   * What to say about a message with no readable body — an attachment, or an encrypted one.
   *
   * Localised HERE rather than sent by the server: the payload carries the type (`image`,
   * `audio`, …) precisely so the label can be in the user's language instead of the server's.
   */
  private fun describeKind(context: Context, kind: String?): String =
      when (kind) {
        "image" -> context.getString(R.string.push_kind_image)
        "video" -> context.getString(R.string.push_kind_video)
        "audio" -> context.getString(R.string.push_kind_audio)
        "file" -> context.getString(R.string.push_kind_file)
        "location" -> context.getString(R.string.push_kind_location)
        "contact" -> context.getString(R.string.push_kind_contact)
        "poll" -> context.getString(R.string.push_kind_poll)
        else -> context.getString(R.string.push_new_message)
      }

  /** An incoming call: its own channel, no reply/mute, and it must not be bundled away. */
  fun showCall(context: Context, callId: String, conversationId: String?) {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    ensureChannels(context)
    val id = notificationId("call:$callId")
    val notification =
        NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(context.getColor(R.color.push_accent))
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(context.getString(R.string.push_incoming_call))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setAutoCancel(true)
            .setContentIntent(openConversationIntent(context, conversationId, id))
            .build()
    postSafely(context, id, notification)
  }

  /**
   * Show a reply the user just typed into the notification, inside the same thread.
   *
   * The real confirmation is the message appearing in the chat; this only has to stop the
   * notification looking like the reply was swallowed while the send is still in flight.
   */
  fun showOwnReply(context: Context, store: PushStore, conversationId: String, text: String) {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    val conversationName =
        store.conversationName(conversationId) ?: context.getString(R.string.app_name)
    // Append rather than replace: the reply belongs in the thread the user was reading, and
    // cancelling the notification instead would make a message that has not left the device yet
    // look like it was sent and gone.
    val lines =
        store.appendLine(
            conversationId,
            PushStore.Line(null, text, System.currentTimeMillis(), mine = true),
        )
    val isGroup = lines.any { !it.mine && it.sender != null && it.sender != conversationName }

    val id = notificationId(conversationId)
    val notification =
        NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(context.getColor(R.color.push_accent))
            .setStyle(messagingStyle(context, conversationName, isGroup, lines))
            .setContentTitle(conversationName)
            .setContentText(text)
            .setSubText(context.getString(R.string.push_reply_sending))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            // LOW and alert-once: the user is standing right there having just typed it. Buzzing
            // the phone to confirm their own action is noise.
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setGroup(GROUP_MESSAGES)
            .setContentIntent(openConversationIntent(context, conversationId, id))
            .setDeleteIntent(dismissIntent(context, conversationId, id))
            .build()
    postSafely(context, id, notification)
  }

  /**
   * The group summary. Recomputed from the per-conversation counts rather than incremented, so a
   * dismissed or opened conversation removes its contribution instead of leaving the collapsed
   * total permanently too high.
   */
  private fun postSummary(context: Context, store: PushStore) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return // pre-N has no bundling
    val active = groupedCount(context) ?: return
    if (active <= 1) {
      // A single conversation reads better on its own than under a summary.
      NotificationManagerCompat.from(context).cancel(SUMMARY_ID)
      return
    }
    val total = active
    val summary =
        NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(context.getColor(R.color.push_accent))
            .setContentTitle(context.getString(R.string.push_summary_title))
            .setContentText(
                context.resources.getQuantityString(R.plurals.push_summary_text, total, total))
            .setGroup(GROUP_MESSAGES)
            .setGroupSummary(true)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .build()
    postSafely(context, SUMMARY_ID, summary)
  }

  // ── clearing ───────────────────────────────────────────────────────────────

  fun cancel(context: Context, store: PushStore, conversationId: String) {
    if (conversationId.isBlank()) return
    store.clearCount(conversationId)
    // Drop the thread too. Without this, opening a chat and then receiving one new message would
    // rebuild the notification with every line the user had already read.
    store.clearLines(conversationId)
    val nm = NotificationManagerCompat.from(context)
    nm.cancel(notificationId(conversationId))
    // The summary must go too once it is the last thing left, or it strands as an empty group.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      if (groupedCount(context) == 0) nm.cancel(SUMMARY_ID)
    }
  }

  /**
   * How many per-conversation notifications this app currently has posted in the message group,
   * or null when the system will not say.
   *
   * `getActiveNotifications()` reaches into the NotificationManager service, and several OEM
   * builds throw from it rather than returning empty. Both callers are on paths that must not
   * fail — one runs before the delivery ack in a killed-app wake, the other from a notification
   * action — so "cannot tell" is answered with null and the summary is simply left alone.
   */
  private fun groupedCount(context: Context): Int? =
      try {
        NotificationManagerCompat.from(context).activeNotifications.count {
          it.id != SUMMARY_ID && it.notification.group == GROUP_MESSAGES
        }
      } catch (_: Throwable) {
        null
      }

  fun cancelAll(context: Context, store: PushStore) {
    store.clearAllCounts()
    NotificationManagerCompat.from(context).cancelAll()
  }

  /**
   * A stable, positive notification id per conversation, so the same chat updates its
   * notification instead of stacking a new one per message.
   *
   * `hashCode()` can be negative or collide with the reserved summary id — both are handled
   * explicitly rather than left to chance, because a collision would make one conversation's
   * notification silently overwrite another's.
   */
  fun notificationId(key: String): Int {
    val h = key.hashCode()
    val positive = if (h == Int.MIN_VALUE) 0 else if (h < 0) -h else h
    return if (positive <= SUMMARY_ID) positive + SUMMARY_ID + 1 else positive
  }

  private fun postSafely(context: Context, id: Int, notification: Notification) {
    try {
      NotificationManagerCompat.from(context).notify(id, notification)
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS revoked between the check above and here. Nothing to do, and
      // certainly nothing worth crashing a background wake over.
    }
  }

  // ── intents ────────────────────────────────────────────────────────────────

  /**
   * Distinct request codes per (conversation, action). Without this, `PendingIntent` treats two
   * actions on the same notification as the same intent and the second silently reuses the
   * first's extras — i.e. "Mute" would mark as read.
   */
  private fun requestCode(base: Int, action: Int): Int = (base % 0x0FFFFFFF) * 8 + action

  private fun openConversationIntent(
      context: Context,
      conversationId: String?,
      base: Int
  ): PendingIntent {
    // Routed through the app's existing `velchat://` deep-link config (RootNavigator's
    // `linking.screens.Chat = 'chat/:conversationId'`) rather than a bespoke extra, so tapping a
    // notification and following a link land on exactly the same navigation path.
    val intent =
        if (conversationId.isNullOrBlank()) {
          Intent(context, MainActivity::class.java)
        } else {
          Intent(Intent.ACTION_VIEW, Uri.parse("velchat://chat/$conversationId")).apply {
            setPackage(context.packageName)
            setClass(context, MainActivity::class.java)
          }
        }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    if (!conversationId.isNullOrBlank()) {
      intent.putExtra(PushActionReceiver.EXTRA_CONVERSATION_ID, conversationId)
    }
    return PendingIntent.getActivity(
        context, requestCode(base, ACTION_OPEN), intent, immutableFlags())
  }

  private fun dismissIntent(context: Context, conversationId: String, base: Int): PendingIntent =
      PendingIntent.getBroadcast(
          context,
          requestCode(base, ACTION_DISMISS),
          PushActionReceiver.intent(context, PushActionReceiver.ACTION_DISMISS, conversationId, 0L),
          immutableFlags(),
      )

  private fun replyAction(
      context: Context,
      conversationId: String,
      seq: Long,
      base: Int
  ): NotificationCompat.Action {
    val remoteInput =
        RemoteInput.Builder(REPLY_INPUT_KEY)
            .setLabel(context.getString(R.string.push_action_reply_hint))
            .build()
    // MUTABLE is mandatory here and only here: the system WRITES the typed text into this
    // PendingIntent. An immutable one silently arrives with no RemoteInput results, which looks
    // exactly like the user sending an empty reply.
    val pending =
        PendingIntent.getBroadcast(
            context,
            requestCode(base, ACTION_REPLY),
            PushActionReceiver.intent(
                context, PushActionReceiver.ACTION_REPLY, conversationId, seq),
            mutableFlags(),
        )
    return NotificationCompat.Action.Builder(
            R.drawable.ic_notification, context.getString(R.string.push_action_reply), pending)
        .addRemoteInput(remoteInput)
        .setAllowGeneratedReplies(true)
        .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
        .setShowsUserInterface(false)
        .build()
  }

  private fun markReadAction(
      context: Context,
      conversationId: String,
      seq: Long,
      base: Int
  ): NotificationCompat.Action =
      NotificationCompat.Action.Builder(
              R.drawable.ic_notification,
              context.getString(R.string.push_action_mark_read),
              PendingIntent.getBroadcast(
                  context,
                  requestCode(base, ACTION_MARK_READ),
                  PushActionReceiver.intent(
                      context, PushActionReceiver.ACTION_MARK_READ, conversationId, seq),
                  immutableFlags(),
              ),
          )
          .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
          .setShowsUserInterface(false)
          .build()

  private fun muteAction(
      context: Context,
      conversationId: String,
      base: Int
  ): NotificationCompat.Action =
      NotificationCompat.Action.Builder(
              R.drawable.ic_notification,
              context.getString(R.string.push_action_mute),
              PendingIntent.getBroadcast(
                  context,
                  requestCode(base, ACTION_MUTE),
                  PushActionReceiver.intent(
                      context, PushActionReceiver.ACTION_MUTE, conversationId, 0L),
                  immutableFlags(),
              ),
          )
          .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MUTE)
          .setShowsUserInterface(false)
          .build()

  private fun immutableFlags(): Int =
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

  private fun mutableFlags(): Int =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }

  private const val ACTION_OPEN = 0
  private const val ACTION_REPLY = 1
  private const val ACTION_MARK_READ = 2
  private const val ACTION_MUTE = 3
  private const val ACTION_DISMISS = 4
}
