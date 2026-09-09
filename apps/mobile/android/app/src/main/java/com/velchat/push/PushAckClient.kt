package com.velchat.push

import android.os.SystemClock
import android.util.Log
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import kotlin.math.min
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
 * But blocking there is borrowed time, and it MUST be repaid inside a budget. FCM hands an app
 * its messages one at a time on a single background thread, so every second spent in here is a
 * second the NEXT message is not being delivered — and a callback that overruns the window Android
 * allows gets its service torn down, taking the queued messages with it. That is not theoretical:
 * with 8s connect + 8s read over two attempts, one unreachable backend held this method for 33
 * seconds, and the pushes queued behind it were never surfaced at all. The user saw one
 * notification and then silence, on a device where everything was configured correctly.
 *
 * So the whole receipt — every attempt, every retry — lives inside {@link #TOTAL_BUDGET_MS}, and
 * each attempt's timeouts are cut from what is left rather than being fixed. Losing a receipt to
 * that budget costs latency only: the client re-asserts every owed receipt on its next socket
 * connect (`reassertReceipts()`). Losing the notification costs the user the message.
 *
 * Written against `HttpURLConnection` rather than adding an HTTP client — this is one POST with a
 * JSON body, and §M1 keeps the stack locked.
 */
internal object PushAckClient {

  private const val TAG = "VelChatPushAck"

  /**
   * The ceiling on everything this class does for one push, retries included.
   *
   * FCM allows roughly 20 s inside `onMessageReceived` and delivers an app's messages serially,
   * so the budget is set well below that: the remainder is headroom for drawing the notification
   * and for the next message to start on time. It is deliberately not "generous" — a receipt that
   * takes eight seconds has already lost its race with the socket reconnect that would re-assert
   * it anyway.
   */
  private const val TOTAL_BUDGET_MS = 8_000L

  /**
   * Below this there is not enough time left for a connect AND a response, so a further attempt
   * can only burn the budget the next message needs.
   */
  private const val MIN_ATTEMPT_MS = 1_500L

  /**
   * Per-attempt ceilings. The ACTUAL timeouts are cut from the remaining budget (see `post`),
   * because `HttpURLConnection` applies its connect timeout to EACH resolved address — on an
   * IPv6-only mobile network with DNS64 that is two addresses, and a nominal 8 s connect becomes
   * 16 s of real waiting.
   */
  private const val CONNECT_TIMEOUT_MS = 3_000L
  private const val READ_TIMEOUT_MS = 3_000L

  /**
   * One retry, and only when the budget still has room for it. It covers the common case — a
   * radio that was asleep when the push landed and needs a moment to attach — while the budget
   * covers the case that actually cost us notifications: a backend that is simply unreachable.
   */
  private const val ATTEMPTS = 2
  private const val RETRY_DELAY_MS = 500L

  /**
   * How long to stop trying after the network has told us the backend is unreachable.
   *
   * A budget bounds ONE receipt. It does nothing for five messages arriving while the backend is
   * down, which is five times the budget spent blocking the thread that delivers them — and the
   * notifications are what the user is waiting for, not the receipts. So the first failure stands
   * in for the rest: pushes during the cooldown draw instantly and skip the ack entirely.
   *
   * A minute, because the thing on the other side is usually a phone changing networks or a
   * deploy restarting, and both resolve on that order. Nothing is lost by guessing wrong — the
   * client re-asserts every owed receipt on its next socket connect.
   */
  private const val UNREACHABLE_COOLDOWN_MS = 60_000L

  /**
   * When the backend was last found unreachable. Static, so it is shared by every push this
   * process handles, and reset for free when the process dies — which is exactly the moment the
   * assumption behind it stops being safe.
   */
  @Volatile private var unreachableUntil = 0L

  enum class State(val wire: String) {
    DELIVERED("delivered"),
    READ("read")
  }

  /**
   * Send one cumulative receipt. Returns true when the server accepted it.
   *
   * BLOCKS the calling thread — call it from `onMessageReceived` or a `goAsync()` receiver, never
   * from the main thread — for at most {@link #TOTAL_BUDGET_MS}, whatever the network does.
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

    val startedAt = SystemClock.elapsedRealtime()
    if (startedAt < unreachableUntil) {
      Log.i(TAG, "ack skipped: backend was unreachable moments ago (state=${state.wire})")
      return false
    }

    // A wall-clock deadline, not a count of attempts. Attempts are cheap to reason about and
    // useless as a bound: what overran the callback was one attempt against an address that never
    // answered, twice over.
    val deadline = startedAt + TOTAL_BUDGET_MS

    repeat(ATTEMPTS) { attempt ->
      val remaining = deadline - SystemClock.elapsedRealtime()
      if (remaining < MIN_ATTEMPT_MS) {
        // Said out loud. The whole reason this bug survived so long is that a receipt which
        // simply never happened looked identical to one that succeeded.
        Log.i(TAG, "ack abandoned: out of time budget (state=${state.wire})")
        return giveUp()
      }
      when (post("$base/notifications/ack", body, remaining)) {
        Outcome.OK -> {
          unreachableUntil = 0L
          return true
        }
        // 4xx means this request will never succeed: an unknown endpoint, a rotated token, or a
        // conversation this user is no longer in. Retrying only burns the wake window.
        Outcome.PERMANENT -> return false
        Outcome.TRANSIENT -> {
          val left = deadline - SystemClock.elapsedRealtime()
          if (attempt < ATTEMPTS - 1 && left > MIN_ATTEMPT_MS + RETRY_DELAY_MS) {
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
    return giveUp()
  }

  /**
   * Record that the network could not be reached and report failure. Only for network outcomes —
   * a 4xx says the server is right there and answering, so it must not silence the next push's
   * receipt.
   */
  private fun giveUp(): Boolean {
    unreachableUntil = SystemClock.elapsedRealtime() + UNREACHABLE_COOLDOWN_MS
    return false
  }

  private enum class Outcome {
    OK,
    TRANSIENT,
    PERMANENT
  }

  /**
   * One POST, bounded by `remainingMs` — the time left in the caller's budget, split between
   * connecting and reading so that neither can consume the whole of it.
   */
  private fun post(url: String, body: String, remainingMs: Long): Outcome {
    var conn: HttpURLConnection? = null
    return try {
      val parsed = URL(url)
      conn = (parsed.openConnection() as HttpURLConnection)
      // Cleartext is blocked by the app's network policy in release builds; being explicit here
      // makes an accidental http:// base URL fail loudly in review rather than quietly at 3 a.m.
      if (conn !is HttpsURLConnection && !url.startsWith("http://")) return Outcome.PERMANENT
      conn.requestMethod = "POST"
      // Half the remaining budget to reach the server, the rest to hear back. Capped so a large
      // budget cannot resurrect the original problem, and floored so neither is ever zero —
      // `HttpURLConnection` reads 0 as "wait forever", which is the one value we cannot allow.
      val connectMs = min(CONNECT_TIMEOUT_MS, remainingMs / 2).coerceAtLeast(500L)
      val readMs = min(READ_TIMEOUT_MS, remainingMs - connectMs).coerceAtLeast(500L)
      conn.connectTimeout = connectMs.toInt()
      conn.readTimeout = readMs.toInt()
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
