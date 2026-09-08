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
        .remove(KEY_PEOPLE)
        .remove(KEY_LINES)
        .remove(KEY_MUTED)
        .remove(KEY_PENDING)
        .remove(KEY_COUNTS)
        .remove(KEY_ACTIVE_CONVO)
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
  fun conversationName(conversationId: String): String? = readName(KEY_NAMES, conversationId)

  fun putConversationNames(names: Map<String, String>) = putNames(KEY_NAMES, names)

  /**
   * `accountId -> display name`, also mirrored from JS.
   *
   * Separate from the conversation map because a push names its SENDER by id, and in a group the
   * sender is not the conversation. Without this, every message in a group notification would be
   * attributed to nobody — which is precisely the case where knowing who spoke matters most.
   */
  fun personName(accountId: String): String? = readName(KEY_PEOPLE, accountId)

  fun putPersonNames(names: Map<String, String>) = putNames(KEY_PEOPLE, names)

  private fun readName(key: String, id: String): String? =
      readJson(key).optString(id, "").takeIf { it.isNotBlank() }

  private fun putNames(key: String, names: Map<String, String>) {
    if (names.isEmpty()) return
    val merged = readJson(key)
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
    prefs.edit().putString(key, merged.toString()).apply()
  }

  // ── the lines shown inside one conversation's notification ─────────────────

  /**
   * One rendered line in a conversation's notification.
   *
   * `mine` marks a reply the user sent FROM the notification. Keeping it in the thread is what
   * makes an inline reply feel like it went somewhere — without it, the notification silently
   * drops the message the user just typed and looks like it was swallowed.
   */
  data class Line(
      val sender: String?,
      val text: String,
      val at: Long,
      val mine: Boolean = false,
  )

  /**
   * Remember what a conversation's notification is currently showing, so a second message
   * EXPANDS it into a thread instead of replacing the first.
   *
   * This has to be persisted rather than held in memory: each push can arrive in a freshly
   * started process that is torn down again as soon as `onMessageReceived` returns, so an
   * in-memory list would be empty every single time and the notification would never stack.
   *
   * Bounded twice over — {@link MAX_LINES} per conversation and {@link MAX_LINE_CONVOS}
   * conversations — because this is notification state, not a message store (§M "no unbounded
   * caches"). The DB remains the source of truth for everything real.
   */
  fun appendLine(conversationId: String, line: Line): List<Line> {
    val all = readJson(KEY_LINES)
    val existing = all.optJSONArray(conversationId) ?: JSONArray()
    existing.put(
        JSONObject()
            .put("s", line.sender ?: JSONObject.NULL)
            .put("t", line.text)
            .put("at", line.at)
            .put("me", line.mine))
    while (existing.length() > MAX_LINES) existing.remove(0)
    all.put(conversationId, existing)
    while (all.length() > MAX_LINE_CONVOS) {
      val it = all.keys()
      if (!it.hasNext()) break
      val oldest = it.next()
      if (oldest == conversationId) {
        if (!it.hasNext()) break
        all.remove(it.next())
      } else {
        all.remove(oldest)
      }
    }
    prefs.edit().putString(KEY_LINES, all.toString()).apply()
    return toLines(existing)
  }

  fun lines(conversationId: String): List<Line> =
      toLines(readJson(KEY_LINES).optJSONArray(conversationId) ?: JSONArray())

  fun clearLines(conversationId: String) {
    val all = readJson(KEY_LINES)
    if (!all.has(conversationId)) return
    all.remove(conversationId)
    prefs.edit().putString(KEY_LINES, all.toString()).apply()
  }

  private fun toLines(arr: JSONArray): List<Line> {
    val out = ArrayList<Line>(arr.length())
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i) ?: continue
      val text = o.optString("t", "")
      if (text.isBlank()) continue
      out.add(
          Line(
              o.optString("s", "").takeIf { it.isNotBlank() },
              text,
              o.optLong("at", 0L),
              o.optBoolean("me", false),
          ))
    }
    return out
  }

  // ── what the user is looking at ────────────────────────────────────────────

  /**
   * The conversation currently open on screen, mirrored from JS, or null.
   *
   * This is what makes suppression correct. Suppressing on "the app is resumed" alone was wrong
   * in two ways: a user reading chat A got no notification for a message in chat B, and a user
   * whose socket had quietly died got neither the message nor a notification — the app looked
   * simply broken. Suppress only for the chat they are actually reading.
   */
  fun activeConversationId(): String? =
      prefs.getString(KEY_ACTIVE_CONVO, null)?.takeIf { it.isNotBlank() }

  fun setActiveConversation(conversationId: String?) {
    // `commit()`: a push can arrive in the same instant the user opens a chat, and reading a
    // stale value here posts a notification for the conversation already on screen.
    @Suppress("ApplySharedPref")
    prefs.edit().putString(KEY_ACTIVE_CONVO, conversationId).commit()
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

  /**
   * How many conversations currently have a notification of ours on screen.
   *
   * Derived from our OWN counters rather than `NotificationManagerCompat.activeNotifications`,
   * because `notify()` is asynchronous: a read taken immediately after posting routinely does
   * not include the notification just posted, so the group summary was computed from a value
   * that was wrong most of the time — and a stale summary can be the only thing the user sees.
   * These counters are written synchronously by `bumpCount`/`clearCount`, so they cannot race.
   */
  fun countedConversations(): Int {
    val counts = readJson(KEY_COUNTS)
    var n = 0
    val keys = counts.keys()
    while (keys.hasNext()) {
      if (counts.optInt(keys.next(), 0) > 0) n++
    }
    return n
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
    private const val KEY_PEOPLE = "people"
    private const val KEY_LINES = "lines"
    private const val KEY_MUTED = "muted"
    private const val KEY_COUNTS = "counts"
    private const val KEY_PENDING = "pending"
    private const val KEY_ACTIVE_CONVO = "activeConvo"

    private const val MAX_NAMES = 300
    private const val MAX_PENDING = 64

    /** Android collapses a MessagingStyle to the last few lines anyway; keeping more is waste. */
    private const val MAX_LINES = 6
    private const val MAX_LINE_CONVOS = 20
  }
}
