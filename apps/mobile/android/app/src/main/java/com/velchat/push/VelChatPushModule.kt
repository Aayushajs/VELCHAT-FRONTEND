package com.velchat.push

import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

/**
 * The JS-facing surface of the push module (ADR 0008). Its typed counterpart is
 * `src/infra/push/nativePush.ts`, authored first per §M23 — keep the two in step.
 *
 * Registered as a legacy `ReactPackage` rather than a codegen TurboModule spec, which the
 * bridgeless interop layer supports and which `react-native-contacts` already relies on in this
 * app. Migrating is mechanical and deliberately deferred (ADR 0008, follow-ups).
 *
 * **Nothing here throws into JS.** Every method resolves — with `false`, `null`, or an empty
 * array — because all of this sits on app-launch paths where a rejected promise from an optional
 * subsystem becomes an unhandled rejection, and in release a red screen the user cannot dismiss.
 * Absent Firebase config, absent Play Services and a revoked permission are all normal states
 * (see `docs/push-setup.md`), not errors.
 */
class VelChatPushModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val store = PushStore(reactContext)

  override fun getName(): String = NAME

  override fun initialize() {
    super.initialize()
    PushBridge.attach(reactContext)
    PushNotifications.ensureChannels(reactContext)
  }

  override fun invalidate() {
    // §M7: every long-lived resource is owned and disposable. The bridge holds a weak reference
    // anyway, but leaving a stale one behind means the next push tries to emit into a dead
    // runtime before falling back.
    PushBridge.detach()
    super.invalidate()
  }

  /**
   * Is there a usable push transport in THIS build on THIS device?
   *
   * False when `google-services.json` was absent at build time — the google-services plugin is
   * applied conditionally so a fresh clone still compiles (ADR 0008 §Decision), and Firebase then
   * has nothing to auto-initialise from. JS treats that as `unsupported`, `pushAvailable` stays
   * false, and the SyncEngine keeps its background socket. That fallback is the design, not a
   * failure.
   */
  @ReactMethod
  fun isSupported(promise: Promise) {
    promise.resolve(
        try {
          FirebaseApp.getApps(reactContext).isNotEmpty()
        } catch (_: Throwable) {
          false
        })
  }

  /**
   * The FCM registration token.
   *
   * Also caches it in {@link PushStore}, and that side effect is the point: the ack path runs in
   * a process with no JS runtime and reads the token from there. Without this write, a device
   * would register with the backend and still be unable to acknowledge anything.
   */
  @ReactMethod
  fun getToken(promise: Promise) {
    try {
      if (FirebaseApp.getApps(reactContext).isEmpty()) {
        promise.resolve(null)
        return
      }
      FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        if (task.isSuccessful) {
          val token = task.result?.takeIf { it.isNotBlank() }
          store.setPushToken(token)
          promise.resolve(token)
        } else {
          // No Play Services, no network on first run, or an unconfigured project. All mean
          // "no push", none mean "crash".
          promise.resolve(null)
        }
      }
    } catch (_: Throwable) {
      promise.resolve(null)
    }
  }

  /** Sign-out. Kills the token at the FCM level so the previous account's pushes cannot land. */
  @ReactMethod
  fun deleteToken(promise: Promise) {
    store.setPushToken(null)
    try {
      if (FirebaseApp.getApps(reactContext).isEmpty()) {
        promise.resolve(null)
        return
      }
      FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener { promise.resolve(null) }
    } catch (_: Throwable) {
      promise.resolve(null)
    }
  }

  /**
   * Mirror what a woken, JS-less process needs in order to authenticate an ack.
   *
   * JS is the only side that knows which base URL it resolved, and the device id lives in MMKV
   * which native cannot read. Called on every launch and after every session change.
   */
  @ReactMethod
  fun setCredentials(baseUrl: String?, deviceId: String?, accountId: String?, promise: Promise) {
    store.setCredentials(baseUrl, deviceId, accountId)
    promise.resolve(null)
  }

  /** Sign-out: drop everything tying this handset to the account that is leaving. */
  @ReactMethod
  fun clearSession(promise: Promise) {
    store.clearSession()
    PushNotifications.cancelAll(reactContext, store)
    promise.resolve(null)
  }

  /**
   * Mirror `conversationId -> display name` so a notification posted from Kotlin can name the
   * chat. The push itself carries ids only, by design (§A19).
   */
  @ReactMethod
  fun setConversationNames(names: ReadableMap, promise: Promise) {
    store.putConversationNames(toStringMap(names))
    promise.resolve(null)
  }

  /**
   * Mirror `accountId -> display name` so a GROUP notification can attribute each line to whoever
   * sent it. The push names its sender by id only, so without this every message in a group would
   * arrive unattributed — the case where knowing who spoke matters most.
   */
  @ReactMethod
  fun setPersonNames(names: ReadableMap, promise: Promise) {
    store.putPersonNames(toStringMap(names))
    promise.resolve(null)
  }

  private fun toStringMap(names: ReadableMap): Map<String, String> {
    val map = HashMap<String, String>()
    val it = names.keySetIterator()
    while (it.hasNextKey()) {
      val key = it.nextKey()
      map[key] = names.getString(key) ?: ""
    }
    return map
  }

  /**
   * Tell native which chat is on screen, so a push for THAT chat is the only one suppressed.
   * Passing null (on leaving the chat) is what re-enables notifications for it.
   */
  @ReactMethod
  fun setActiveConversation(conversationId: String?, promise: Promise) {
    store.setActiveConversation(conversationId?.takeIf { it.isNotBlank() })
    promise.resolve(null)
  }

  /** Keep the native mute in step with the server-side pref the user set inside the app. */
  @ReactMethod
  fun setMuted(conversationId: String, untilMillis: Double, promise: Promise) {
    store.setMuted(conversationId, untilMillis.toLong())
    promise.resolve(null)
  }

  /** Called when the user opens a chat: its notification is stale the moment they are looking. */
  @ReactMethod
  fun clearConversation(conversationId: String, promise: Promise) {
    PushNotifications.cancel(reactContext, store, conversationId)
    promise.resolve(null)
  }

  @ReactMethod
  fun clearNotifications(promise: Promise) {
    PushNotifications.cancelAll(reactContext, store)
    promise.resolve(null)
  }

  /**
   * Drain the actions the user took on notifications while no JS runtime existed.
   *
   * This is the ONLY thing that empties the queue, and that asymmetry is deliberate: native
   * emits a signal but never drains, so an event cannot be lost into the window between a React
   * context existing and `infra/push` attaching its listener. See {@link PushBridge}.
   */
  @ReactMethod
  fun takePendingEvents(promise: Promise) {
    val out: WritableArray = Arguments.createArray()
    try {
      val queue = store.takeEvents()
      for (i in 0 until queue.length()) {
        val event = queue.optJSONObject(i) ?: continue
        out.pushMap(toWritableMap(event))
      }
    } catch (_: Throwable) {
      // A corrupt queue must not stop the app from starting. It is already drained.
    }
    promise.resolve(out)
  }

  /**
   * Are message notifications actually displayable — app-level AND channel-level?
   *
   * The channel half is the one that hides: `areNotificationsEnabled()` answers true while the
   * message channel is blocked, so the notification posts and nothing appears.
   */
  @ReactMethod
  fun areMessageNotificationsBlocked(promise: Promise) {
    promise.resolve(
        try {
          PushNotifications.messagesChannelBlocked(reactContext)
        } catch (_: Throwable) {
          false
        })
  }

  /**
   * Is this app exempt from battery optimisation?
   *
   * When it is not, Doze and the OEM power managers are free to withhold a high-priority data
   * message: FCM reports it delivered, `VelChatMessagingService` never runs, and the user gets
   * neither a notification nor a second tick on the sender's side. Since nothing in the app can
   * observe that happening, the exemption state is the closest thing to an explanation available
   * — so it is reported rather than guessed at.
   */
  @ReactMethod
  fun isIgnoringBatteryOptimizations(promise: Promise) {
    promise.resolve(
        try {
          val pm = reactContext.getSystemService(PowerManager::class.java)
          pm?.isIgnoringBatteryOptimizations(reactContext.packageName) ?: false
        } catch (_: Throwable) {
          false
        })
  }

  /**
   * Open the system prompt asking for that exemption.
   *
   * `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` shows a dialog the user accepts once. It is
   * NOT silent and must be triggered by a deliberate user action; Play forbids nagging. Resolves
   * false when the intent cannot be shown (no activity, or an OEM that removed the screen).
   */
  @ReactMethod
  fun requestIgnoreBatteryOptimizations(promise: Promise) {
    try {
      val pkg = reactContext.packageName
      val pm = reactContext.getSystemService(PowerManager::class.java)
      if (pm?.isIgnoringBatteryOptimizations(pkg) == true) {
        promise.resolve(true)
        return
      }
      val intent =
          Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$pkg")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
      val activity = reactContext.currentActivity
      if (activity != null) activity.startActivity(intent) else reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (_: Throwable) {
      // Some OEM builds remove this screen entirely. Falling back to the app's own settings page
      // is better than a dead button.
      promise.resolve(openAppSettings())
    }
  }

  /** The app's own system settings page — where notifications and battery both live. */
  @ReactMethod
  fun openAppNotificationSettings(promise: Promise) {
    promise.resolve(openAppSettings())
  }

  private fun openAppSettings(): Boolean =
      try {
        val intent =
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
              data = Uri.parse("package:${reactContext.packageName}")
              addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        val activity = reactContext.currentActivity
        if (activity != null) activity.startActivity(intent) else reactContext.startActivity(intent)
        true
      } catch (_: Throwable) {
        false
      }

  /** Required by `NativeEventEmitter`; the emitter is driven from {@link PushBridge}. */
  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) = Unit

  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) = Unit

  /**
   * Flatten one queued event into a `WritableMap`.
   *
   * Numbers are passed through as numbers and everything else as a string, because the JS side
   * parses `upToSeq`/`mutedUntil` numerically and a silently stringified number there would
   * compare unequal to every local watermark.
   */
  private fun toWritableMap(json: JSONObject) =
      Arguments.createMap().apply {
        val keys = json.keys()
        while (keys.hasNext()) {
          val key = keys.next()
          when (val value = json.opt(key)) {
            is Int -> putDouble(key, value.toDouble())
            is Long -> putDouble(key, value.toDouble())
            is Double -> putDouble(key, value)
            is Boolean -> putBoolean(key, value)
            null -> putNull(key)
            else -> putString(key, value.toString())
          }
        }
      }

  internal companion object {
    const val NAME = "VelChatPush"
  }
}
