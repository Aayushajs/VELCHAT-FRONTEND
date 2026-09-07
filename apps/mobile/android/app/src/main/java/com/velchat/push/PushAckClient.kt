package com.velchat.push

import android.util.Log
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

/**
 * The whole reason this native module exists: telling the server that a message reached this
 * device, from a process that has no JS runtime and no usable JWT.
 *
 * `POST /notifications/ack` is authenticated by the registered push token (see the backend's
 * `push-ack.ts` for why a JWT is not an option here — refreshing one from native rotates the
 * refresh family behind the JS side's back and silently signs the user out). The request is
 * deliberately tiny and synchronous: FCM keeps the process alive for the duration of
 * `onMessageReceived`, so blocking there is what KEEPS the ack alive; handing it to a background
 * executor would race the process being killed the moment that method returns.
 *
 * Written against `HttpURLConnection` rather than adding an HTTP client — this is one POST with a
 * JSON body, and §M1 keeps the stack locked.
 */
internal object PushAckClient {

  private const val TAG = "VelChatPushAck"
  private const val CONNECT_TIMEOUT_MS = 8_000
  private const val READ_TIMEOUT_MS = 8_000

  /**
   * A high-priority data message buys roughly 20 s of process time. One retry fits comfortably
   * inside that and covers the common case — a radio that was asleep when the push landed and
   * needs a moment to attach. A second retry would not: it would risk being killed mid-flight,
   * and the client re-asserts every owed receipt on its next socket connect anyway
   * (`reassertReceipts()`), so a dropped ack costs latency, never a permanently stuck tick.
   */
  private const val ATTEMPTS = 2
  private const val RETRY_DELAY_MS = 1_500L

  enum class State(val wire: String) {
    DELIVERED("delivered"),
    READ("read")
  }

  /**
   * Send one cumulative receipt. Returns true when the server accepted it.
   *
   * BLOCKS the calling thread — call it from `onMessageReceived` or a `goAsync()` receiver, never
   * from the main thread.
   */
  fun ack(store: PushStore, conversationId: String, upToSeq: Long, state: State): Boolean {
    if (conversationId.isBlank() || upToSeq <= 0L) return false

    val base = store.baseUrl()
    val deviceId = store.deviceId()
    val token = store.pushToken()
    if (base.isNullOrBlank() || deviceId.isNullOrBlank() || token.isNullOrBlank()) {
      // Not an error: the app has never completed a signed-in launch on this install, so there is
      // nothing to authenticate with. JS will register and the next push will ack.
      Log.i(TAG, "ack skipped: no credentials yet (state=${state.wire})")
      return false
    }

    val body =
        JSONObject()
            .put("deviceId", deviceId)
            .put("pushToken", token)
            .put("conversationId", conversationId)
            .put("upToSeq", upToSeq)
            .put("state", state.wire)
            .toString()

    repeat(ATTEMPTS) { attempt ->
      when (val outcome = post("$base/notifications/ack", body)) {
        Outcome.OK -> return true
        // 4xx means this request will never succeed: an unknown endpoint, a rotated token, or a
        // conversation this user is no longer in. Retrying only burns the wake window.
        Outcome.PERMANENT -> return false
        Outcome.TRANSIENT -> {
          if (attempt < ATTEMPTS - 1) {
            try {
              Thread.sleep(RETRY_DELAY_MS)
            } catch (_: InterruptedException) {
              Thread.currentThread().interrupt()
              return false
            }
          }
          Unit
        }
      }
      Unit
    }
    return false
  }

  private enum class Outcome {
    OK,
    TRANSIENT,
    PERMANENT
  }

  private fun post(url: String, body: String): Outcome {
    var conn: HttpURLConnection? = null
    return try {
      val parsed = URL(url)
      conn = (parsed.openConnection() as HttpURLConnection)
      // Cleartext is blocked by the app's network policy in release builds; being explicit here
      // makes an accidental http:// base URL fail loudly in review rather than quietly at 3 a.m.
      if (conn !is HttpsURLConnection && !url.startsWith("http://")) return Outcome.PERMANENT
      conn.requestMethod = "POST"
      conn.connectTimeout = CONNECT_TIMEOUT_MS
      conn.readTimeout = READ_TIMEOUT_MS
      conn.doOutput = true
      conn.useCaches = false
      conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
      conn.setRequestProperty("Accept", "application/json")
      conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

      val code = conn.responseCode
      // Drain and close so the connection can be pooled rather than leaked.
      (if (code in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes() }

      when {
        code in 200..299 -> Outcome.OK
        code in 400..499 -> {
          Log.i(TAG, "ack refused: HTTP $code")
          Outcome.PERMANENT
        }
        else -> {
          Log.i(TAG, "ack failed: HTTP $code")
          Outcome.TRANSIENT
        }
      }
    } catch (e: IOException) {
      Log.i(TAG, "ack failed: ${e.javaClass.simpleName}")
      Outcome.TRANSIENT
    } catch (e: Throwable) {
      // A malformed base URL, a security policy, anything else — never let a receipt take the
      // notification down with it.
      Log.w(TAG, "ack error: ${e.javaClass.simpleName}")
      Outcome.PERMANENT
    } finally {
      conn?.disconnect()
    }
  }
}
