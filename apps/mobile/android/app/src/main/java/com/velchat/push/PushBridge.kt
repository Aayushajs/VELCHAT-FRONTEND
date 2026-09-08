package com.velchat.push

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.LifecycleState
import java.lang.ref.WeakReference

/**
 * The one-way native → JS channel (ADR 0008).
 *
 * ## The rule this file exists to enforce: native NEVER drains the queue on its own initiative
 *
 * The obvious design — "when a push arrives, read the pending events and emit them to JS" — loses
 * events, and loses them in the least debuggable way. A React context can be alive a whole second
 * before `infra/push` has attached its listener (cold start, or a reload), and an event emitted
 * into that gap is simply gone: `RCTDeviceEventEmitter` has no buffering.
 *
 * So native only ever emits a *signal* ("something is waiting"). JS drains by calling
 * `takePendingEvents()`, which is the only thing that empties {@link PushStore}. A missed signal
 * therefore costs latency — JS also drains on init and on every foreground — and never an event.
 */
internal object PushBridge {

  private const val TAG = "VelChatPushBridge"

  /** Emitted when a push lands while JS is alive. Keep in sync with `nativePush.ts`. */
  const val EVENT_MESSAGE = "velchat.push.message"

  /** Emitted when FCM rotates our registration token. */
  const val EVENT_TOKEN = "velchat.push.token"

  /** Emitted when actions taken from a notification are waiting to be drained. */
  const val EVENT_PENDING = "velchat.push.pending"

  /**
   * Set by {@link VelChatPushModule} while it is initialised. Weak, because the push layer must
   * never be the reason a React context outlives its host — a strong reference here would pin an
   * entire JS runtime from a static field for the life of the process.
   */
  private var contextRef: WeakReference<ReactContext>? = null

  fun attach(reactContext: ReactContext) {
    contextRef = WeakReference(reactContext)
  }

  fun detach() {
    contextRef = null
  }

  /**
   * A React context that can actually receive an event right now.
   *
   * Falls back to the `ReactHost`'s current context so a push that arrives while the app is alive
   * but before our module was constructed still finds a live runtime — without ever CREATING one,
   * which is what the headless path is for.
   */
  private fun liveContext(context: Context): ReactContext? {
    contextRef?.get()?.let { if (it.hasActiveReactInstance()) return it }
    return try {
      val app = context.applicationContext as? ReactApplication ?: return null
      // `reactHost` is nullable in the interop layer: a process started by FCM may have an
      // Application object with no host built yet. That is the normal killed-app case, not a
      // failure — it just means there is no JS to emit to.
      app.reactHost?.currentReactContext?.takeIf { it.hasActiveReactInstance() }
    } catch (e: Throwable) {
      Log.i(TAG, "no react host: ${e.javaClass.simpleName}")
      null
    }
  }

  /** True when JS is alive and was told. False means the caller must fall back (headless/queue). */
  fun emit(context: Context, event: String, payload: Any?): Boolean {
    val reactContext = liveContext(context) ?: return false
    return try {
      reactContext.emitDeviceEvent(event, payload)
      true
    } catch (e: Throwable) {
      // A context that is tearing down can throw between the liveness check and the emit.
      Log.i(TAG, "emit failed: ${e.javaClass.simpleName}")
      false
    }
  }

  /**
   * Tell a live JS runtime that {@link PushStore}'s queue is non-empty. Deliberately carries no
   * data — see the note at the top of this file.
   */
  fun emitPendingEvents(context: Context): Boolean = emit(context, EVENT_PENDING, null)

  fun hasLiveContext(context: Context): Boolean = liveContext(context) != null

  /**
   * Is the user looking at the app right now?
   *
   * Used to decide whether a push deserves a system notification. The server already suppresses
   * pushes for a user it believes is online (`decideNotify` + the `conn:{user}` registry), but
   * that belief can be a socket or two stale, and a notification that fires for the message the
   * user is watching arrive is the single most obviously-broken thing a chat app can do.
   *
   * Reads the React lifecycle rather than adding `androidx.lifecycle-process`: it is the same
   * signal `AppState` gives JS, from a class already on the classpath (§M1).
   */
  fun isAppResumed(context: Context): Boolean =
      try {
        liveContext(context)?.lifecycleState == LifecycleState.RESUMED
      } catch (_: Throwable) {
        false
      }
}
