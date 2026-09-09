package com.velchat.push

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.ServiceCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Boots a JS runtime **only when the user has actually asked for something** (ADR 0008).
 *
 * ADR 0008 rejected `setBackgroundMessageHandler` precisely because it spins up Hermes for every
 * incoming push — a JS context per message, at 03:00, on a 3 GB device, to draw a notification
 * whose entire content is "New message". Nothing here contradicts that: an incoming push is still
 * handled entirely in Kotlin.
 *
 * This service exists for the opposite case. Replying from the notification, or muting a chat,
 * needs the user's real session — the reply goes through the outbox and its retry policy, the
 * mute has to reach `PUT /notifications/prefs` with a bearer token — and native cannot
 * manufacture either (refreshing a JWT from native rotates the refresh family behind the JS
 * side's back). A deliberate tap is a fine reason to spend a JS context; a message arriving is
 * not. That is the whole distinction.
 *
 * The task is bounded at {@link TIMEOUT_MS} so a stuck runtime cannot hold a wakelock — §M13's
 * "wake → bounded work → sleep" contract, applied to the one path that wakes JS.
 */
internal class PushHeadlessService : HeadlessJsTaskService() {

  /**
   * Become a foreground service immediately, then do the work.
   *
   * Android 8+ refuses a background service start outside a short allowlist, and a notification
   * action only grants that allowlist for a few seconds. Reply a minute after the push arrives —
   * or on an OEM build with tighter rules — and the start was refused: the event stayed queued and
   * left on the next app launch, which is exactly the "I replied and nothing sent" the reply
   * button exists to prevent.
   *
   * A foreground start is allowed in that situation, and the platform's `shortService` type is
   * meant for precisely this: brief work the user just asked for. The notification is MIN
   * importance and disappears when the task completes.
   *
   * `startForeground` MUST be called within a few seconds of `startForegroundService` or the
   * system kills the process, so it happens here, before anything else.
   */
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // A partial wakelock for the life of the task, held by React Native and released when the
    // task finishes.
    //
    // Being a foreground service is not enough on its own. Measured on a ColorOS device: the
    // service went foreground with the `shortService` type and was stopped 187 ms later, while
    // the reply's HTTP send was still in flight — it completed 600 ms after that only because the
    // process had not been reaped yet. That is luck, not a design. The wakelock keeps the CPU
    // awake for the work regardless of what happens to the service's foreground status, which is
    // the difference between "usually sends" and "sends".
    //
    // Bounded by the same TIMEOUT_MS as the task, and released by RN when the task ends, so §M13's
    // no-leaked-wakelock rule holds.
    HeadlessJsTaskService.acquireWakeLockNow(this)
    try {
      val notification = PushNotifications.workingNotification(this)
      if (Build.VERSION.SDK_INT >= 34) {
        ServiceCompat.startForeground(
            this,
            FOREGROUND_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE,
        )
      } else {
        startForeground(FOREGROUND_ID, notification)
      }
    } catch (e: Throwable) {
      // Not fatal on its own: if the service was started in the background (the old path) it is
      // still a running service and the task still runs. Only a start that REQUIRED the promotion
      // is lost, and the event is persisted either way.
      Log.i(TAG, "foreground promotion failed: ${e.javaClass.simpleName}")
    }
    return super.onStartCommand(intent, flags, startId)
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
      HeadlessJsTaskConfig(
          TASK_KEY,
          Arguments.createMap(),
          TIMEOUT_MS,
          // Allowed in the foreground too: the alternative is a silently-dropped task on the
          // exact path a developer tests first (app open, tap Reply).
          true,
      )

  internal companion object {
    private const val TAG = "VelChatPushHeadless"

    /** Registered from `index.js` via `AppRegistry.registerHeadlessTask`. */
    const val TASK_KEY = "VelChatPushTask"

    private const val TIMEOUT_MS = 30_000L

    /** Its own id, so the working notification can never replace a conversation's. */
    private const val FOREGROUND_ID = 2

    /**
     * Start the task, taking a wakelock FIRST.
     *
     * `HeadlessJsTaskService` documents this explicitly for the broadcast-receiver case: without
     * it the device can fall asleep between `onReceive` returning and the service starting, and
     * the reply is delivered whenever the phone next happens to wake — which reads to the user as
     * "the reply never sent".
     */
    fun start(context: Context) {
      val app = context.applicationContext
      acquireWakeLockNow(app)
      val intent = Intent(app, PushHeadlessService::class.java)
      // FOREGROUND first. A plain background start is refused outside the few seconds of
      // allowlist a notification interaction grants, and that refusal is what left replies
      // sitting in the queue until the next launch. A foreground start is permitted there, and
      // `onStartCommand` promotes immediately so the platform's deadline is met.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        try {
          app.startForegroundService(intent)
          return
        } catch (e: Throwable) {
          Log.i(TAG, "startForegroundService refused: ${e.javaClass.simpleName}; trying plain")
        }
      }
      try {
        app.startService(intent)
      } catch (e: Throwable) {
        // The caller has already persisted the event, so the worst case is that JS drains it on
        // the next launch — late, but never lost.
        Log.i(TAG, "startService refused: ${e.javaClass.simpleName}")
        throw e
      }
    }
  }
}
