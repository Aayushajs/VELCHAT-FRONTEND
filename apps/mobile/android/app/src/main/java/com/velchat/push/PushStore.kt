package com.velchat.push

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * The push layer's own persistence (ADR 0008).
 *
 * Everything here has to be readable by a process that was started by FCM with **no React
 * context and no JS runtime** — a killed app woken at 03:00 to acknowledge a message. That rules
 * out MMKV (owned by react-native-mmkv, initialised from JS) and WatermelonDB (a JSI database
 * whose schema is JS's business), so the push layer keeps a small, flat, native-owned store and
 * JS mirrors into it the handful of facts native needs.
 *
 * Storage is `MODE_PRIVATE` SharedPreferences: app-private on any non-rooted device, and the same
 * protection domain the Firebase SDK already keeps the registration token in. Deliberately NOT
 * `EncryptedSharedPreferences` — that is another dependency plus a Keystore failure mode on
 * exactly the low-end devices this app targets (§M0.1), to protect a value the FCM SDK stores
 * beside it in the clear anyway.
 *
 * Every accessor is safe to call from any thread; SharedPreferences is internally synchronised
 * and the writes here are small enough that `apply()` is the right trade — except the ack
 * credentials, which use `commit()` because a process killed a millisecond later must not lose
 * the only thing that lets it authenticate.
 */
internal class PushStore(context: Context) {

  private val prefs: SharedPreferences =
      context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  private val appContext: Context = context.applicationContext

  // ── ack credentials ────────────────────────────────────────────────────────

  /**
   * The API origin to POST acks to.
   *
   * JS mirrors the resolved base URL here on every launch, because it is the only side that
   * knows which one it actually chose. The fallback reads the `API_BASE_URL` string resource
   * that `react-native-config` generates per flavor — looked up by NAME rather than through
   * `R.string`, so a build with no env file compiles and simply reports "no base URL" instead of
   * failing to compile.
   */
  fun baseUrl(): String? {
    prefs.getString(KEY_BASE_URL, null)?.takeIf { it.isNotBlank() }?.let { return it.trimEnd('/') }
    return try {
      val id = appContext.resources.getIdentifier("API_BASE_URL", "string", appContext.packageName)
      if (id == 0) null else appContext.getString(id).trim().trimEnd('/').ifBlank { null }
    } catch (_: Throwable) {
      null
    }
  }

  fun deviceId(): String? = prefs.getString(KEY_DEVICE_ID, null)?.takeIf { it.isNotBlank() }

  fun accountId(): String? = prefs.getString(KEY_ACCOUNT_ID, null)?.takeIf { it.isNotBlank() }

  fun pushToken(): String? = prefs.getString(KEY_PUSH_TOKEN, null)?.takeIf { it.isNotBlank() }

  fun setPushToken(token: String?) {
    prefs.edit().putString(KEY_PUSH_TOKEN, token).apply()
  }

  /**
   * Store what a woken process needs to authenticate an ack. `commit()`, not `apply()`: this is
   * written once per launch and losing it costs every delivery receipt until the next launch.
   */
  @Suppress("ApplySharedPref")
  fun setCredentials(baseUrl: String?, deviceId: String?, accountId: String?) {
    prefs
        .edit()
        .putString(KEY_BASE_URL, baseUrl)
        .putString(KEY_DEVICE_ID, deviceId)
        .putString(KEY_ACCOUNT_ID, accountId)
        .commit()
  }

  /** Sign-out: nothing that identifies the previous account may survive into the next session. */
  @Suppress("ApplySharedPref")
  fun clearSession() {
    prefs
        .edit()
        .remove(KEY_DEVICE_ID)
        .remove(KEY_ACCOUNT_ID)
        .remove(KEY_PUSH_TOKEN)
        .remove(KEY_NAMES)
        .remove(KEY_MUTED)
        .remove(KEY_PENDING)
        .remove(KEY_COUNTS)
        .commit()
  }

  // ── conversation display names ─────────────────────────────────────────────

  /**
   * `conversationId -> display name`, mirrored from JS.
   *
   * A push carries ids only (§A19 — the server sends no content, on purpose), so without this a
   * notification could say nothing more useful than "VelChat". Reading the name out of
   * WatermelonDB from Kotlin would be fresher, but it would couple the notification layer to a
   * JS-owned SQLite schema that can migrate without this file noticing — and it would fail
   * silently when it did. A mirrored map is coupled to nothing and degrades to a generic title.
   *
   * Bounded at {@link MAX_NAMES}, newest-wins, because this is a notification nicety and must
   * never grow into a real cache (§M "no unbounded caches").
   */
  fun conversationName(conversationId: String): String? =
      readJson(KEY_NAMES).optString(conversationId, "").takeIf { it.isNotBlank() }

  fun putConversationNames(names: Map<String, String>) {
    if (names.isEmpty()) return
    val merged = readJson(KEY_NAMES)
    for ((id, name) in names) {
      if (id.isBlank()) continue
      if (name.isBlank()) merged.remove(id) else merged.put(id, name)
    }
    // Trim oldest-first. JSONObject preserves insertion order in practice; when it does not, we
    // drop an arbitrary excess entry, which costs a generic notification title and nothing else.
    while (merged.length() > MAX_NAMES) {
      val it = merged.keys()
      if (!it.hasNext()) break
      merged.remove(it.next())
    }
    prefs.edit().putString(KEY_NAMES, merged.toString()).apply()
  }

  // ── mute ───────────────────────────────────────────────────────────────────

  /** `conversationId -> epoch millis until which it is muted`. `Long.MAX_VALUE` = forever. */
  fun isMuted(conversationId: String, now: Long = System.currentTimeMillis()): Boolean {
    val until = readJson(KEY_MUTED).optLong(conversationId, 0L)
    return until > now
  }

  fun setMuted(conversationId: String, untilMillis: Long) {
    val muted = readJson(KEY_MUTED)
    if (untilMillis <= System.currentTimeMillis()) muted.remove(conversationId)
    else muted.put(conversationId, untilMillis)
    prefs.edit().putString(KEY_MUTED, muted.toString()).apply()
  }

  // ── per-conversation notification counters ─────────────────────────────────

  /**
   * How many pushes are currently stacked in one conversation's notification, so it can say
   * "3 new messages" instead of replacing itself with an identical line three times.
   *
   * Reset when the user opens or dismisses the notification, not when the app syncs — the count
   * describes what is on screen, not what is unread.
   */
  fun bumpCount(conversationId: String): Int {
    val counts = readJson(KEY_COUNTS)
    val next = counts.optInt(conversationId, 0) + 1
    counts.put(conversationId, next)
    prefs.edit().putString(KEY_COUNTS, counts.toString()).apply()
    return next
  }

  fun clearCount(conversationId: String) {
    val counts = readJson(KEY_COUNTS)
    counts.remove(conversationId)
    prefs.edit().putString(KEY_COUNTS, counts.toString()).apply()
  }

  fun clearAllCounts() {
    prefs.edit().remove(KEY_COUNTS).apply()
  }

  // ── events owed to JS ──────────────────────────────────────────────────────

  /**
   * Things that happened while no JS runtime existed and that JS still has to act on: a
   * notification tap to navigate to, a mute the server has not been told about, a read receipt
   * whose local unread count still needs clearing.
   *
   * A bounded queue, oldest dropped first. Losing the oldest of 64 queued events is a cosmetic
   * loss; growing without bound in a process that may never start JS again is not.
   */
  fun enqueueEvent(event: JSONObject) {
    val queue = readArray(KEY_PENDING)
    queue.put(event)
    val overflow = queue.length() - MAX_PENDING
    if (overflow > 0) for (i in 0 until overflow) queue.remove(0)
    prefs.edit().putString(KEY_PENDING, queue.toString()).apply()
  }

  /** Drain — callers must succeed at handling these, because they are gone after this returns. */
  fun takeEvents(): JSONArray {
    val queue = readArray(KEY_PENDING)
    if (queue.length() > 0) prefs.edit().remove(KEY_PENDING).apply()
    return queue
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private fun readJson(key: String): JSONObject =
      try {
        JSONObject(prefs.getString(key, "{}") ?: "{}")
      } catch (_: Throwable) {
        // A corrupt entry must not wedge notifications forever — start over.
        JSONObject()
      }

  private fun readArray(key: String): JSONArray =
      try {
        JSONArray(prefs.getString(key, "[]") ?: "[]")
      } catch (_: Throwable) {
        JSONArray()
      }

  internal companion object {
    private const val FILE = "velchat_push"
    private const val KEY_BASE_URL = "baseUrl"
    private const val KEY_DEVICE_ID = "deviceId"
    private const val KEY_ACCOUNT_ID = "accountId"
    private const val KEY_PUSH_TOKEN = "pushToken"
    private const val KEY_NAMES = "names"
    private const val KEY_MUTED = "muted"
    private const val KEY_COUNTS = "counts"
    private const val KEY_PENDING = "pending"

    private const val MAX_NAMES = 300
    private const val MAX_PENDING = 64
  }
}
