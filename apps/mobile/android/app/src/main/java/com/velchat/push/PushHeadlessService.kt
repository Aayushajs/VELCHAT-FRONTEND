package com.velchat.push

import android.content.Context
import android.content.Intent
import android.util.Log
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
      try {
        app.startService(Intent(app, PushHeadlessService::class.java))
      } catch (e: Throwable) {
        // Android 8+ refuses background service starts outside the temporary allowlist that a
        // notification interaction grants. The caller has already persisted the event, so the
        // worst case is that JS drains it on the next launch.
        Log.i(TAG, "startService refused: ${e.javaClass.simpleName}")
        throw e
      }
    }
  }
}
