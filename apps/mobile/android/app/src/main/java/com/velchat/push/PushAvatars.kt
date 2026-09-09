package com.velchat.push

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.util.Log
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Sender photos for notifications, cached as files on disk.
 *
 * A notification posted by a JS-less process cannot go and fetch a picture. It is the same
 * constraint that put the delivery receipt on a time budget: FCM hands an app its messages one at
 * a time, so anything slow inside that callback is time the NEXT message spends undelivered. A
 * photo is worth far less than a message.
 *
 * So the work is moved to when it is free. While the app is alive it already mirrors display
 * names into {@link PushStore} whenever the chat list changes; the same call now carries the photo
 * URL, and this downloads it once, shrinks it, and writes it beside the name. The push path then
 * only ever decodes a small local file — no network, no waiting, nothing that can fail slowly.
 *
 * A missing or unreadable photo is not an error anywhere: the notification falls back to the
 * letter avatar it has always drawn.
 */
internal object PushAvatars {

  private const val TAG = "VelChatPushAvatar"
  private const val DIR = "push-avatars"

  /**
   * Notification icons are drawn at roughly 64dp, so 192px covers the densest phone this app
   * targets with room to spare. Anything larger is memory the low-end reference device (§M0.1)
   * pays for at every notification and no one can see.
   */
  private const val TARGET_PX = 192

  /** A photo that does not fit in this was never a photo. Bounds a hostile or wrong URL. */
  private const val MAX_BYTES = 512 * 1024

  private const val CONNECT_TIMEOUT_MS = 5_000
  private const val READ_TIMEOUT_MS = 5_000

  /**
   * One background thread, by design. Avatars are small, rare, and never urgent — a pool would
   * add contention for work the user is not waiting on. The thread is named so it is identifiable
   * in a trace rather than being one more anonymous worker.
   *
   * Typed as `ExecutorService`, deliberately: `newSingleThreadExecutor` returns a delegating
   * wrapper, NOT a `ThreadPoolExecutor`. Casting it to one threw inside this object's static
   * initialiser, and a failed initialiser surfaces later as `NoClassDefFoundError` — which is how
   * a picture took the whole rich notification down with it, actions included, and left the plain
   * fallback in its place.
   */
  private val io: ExecutorService =
      Executors.newSingleThreadExecutor { r -> Thread(r, "velchat-push-avatars") }

  /**
   * Ensure each account's photo is cached, fetching only what changed.
   *
   * Called from JS's name mirror, so it runs on every chat-list change: the URL comparison is
   * what keeps that cheap. Media URLs are signed and rotate, so an unchanged photo can still
   * arrive under a new URL — that costs one re-download, which is the safe direction to be wrong
   * in.
   */
  fun mirror(context: Context, store: PushStore, avatars: Map<String, String>) {
    if (avatars.isEmpty()) return
    val appContext = context.applicationContext
    for ((accountId, url) in avatars) {
      if (accountId.isBlank() || url.isBlank()) continue
      val cachedFile = store.personAvatarFile(accountId)
      if (url == store.personAvatarUrl(accountId) && cachedFile != null && File(cachedFile).exists())
          continue
      try {
        io.execute { fetch(appContext, store, accountId, url) }
      } catch (e: Throwable) {
        // A rejected execution means the app is going away. The photo is a nicety; the next
        // mirror picks it up.
        Log.i(TAG, "avatar fetch not scheduled: ${e.javaClass.simpleName}")
      }
    }
  }

  /**
   * The cached photo, decoded, or null.
   *
   * Called on the push path, so it does the least possible: one decode of a file this class
   * already shrank. Any failure returns null and the notification keeps its letter avatar.
   */
  fun bitmap(path: String?): Bitmap? {
    if (path.isNullOrBlank()) return null
    return try {
      BitmapFactory.decodeFile(path)
    } catch (e: Throwable) {
      Log.i(TAG, "avatar decode failed: ${e.javaClass.simpleName}")
      null
    }
  }

  private fun fetch(context: Context, store: PushStore, accountId: String, url: String) {
    var conn: HttpURLConnection? = null
    try {
      conn = (URL(url).openConnection() as HttpURLConnection)
      conn.connectTimeout = CONNECT_TIMEOUT_MS
      conn.readTimeout = READ_TIMEOUT_MS
      conn.useCaches = false
      val code = conn.responseCode
      if (code !in 200..299) {
        Log.i(TAG, "avatar fetch: HTTP $code")
        return
      }
      val bytes = conn.inputStream.use { readBounded(it) } ?: return
      val decoded = decodeScaled(bytes) ?: return
      // Shaped ONCE, here, and stored ready to draw. The push path must not do image work, and
      // the platform's own masking is not a substitute — see `circleCrop`.
      val bitmap = circleCrop(decoded)
      if (bitmap !== decoded) decoded.recycle()
      val file = writeFile(context, accountId, bitmap)
      bitmap.recycle()
      if (file != null) store.putPersonAvatar(accountId, url, file.absolutePath)
    } catch (e: IOException) {
      Log.i(TAG, "avatar fetch failed: ${e.javaClass.simpleName}")
    } catch (e: Throwable) {
      // A malformed URL, a security policy, an OOM on a hostile image — none of it may take the
      // app down for a picture.
      Log.w(TAG, "avatar fetch error: ${e.javaClass.simpleName}")
    } finally {
      conn?.disconnect()
    }
  }

  /** Read at most {@link #MAX_BYTES}; a larger body is refused rather than truncated. */
  private fun readBounded(input: java.io.InputStream): ByteArray? {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(8 * 1024)
    var total = 0
    while (true) {
      val n = input.read(buf)
      if (n <= 0) break
      total += n
      if (total > MAX_BYTES) {
        Log.i(TAG, "avatar refused: larger than ${MAX_BYTES / 1024}KB")
        return null
      }
      out.write(buf, 0, n)
    }
    return if (total == 0) null else out.toByteArray()
  }

  /**
   * Decode straight to roughly {@link #TARGET_PX}.
   *
   * Two passes: the first reads only the header to learn the real size, the second decodes with
   * an `inSampleSize` chosen from it. Decoding full size and scaling afterwards would allocate
   * the full bitmap first, which is the allocation this is here to avoid.
   */
  private fun decodeScaled(bytes: ByteArray): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val longest = maxOf(bounds.outWidth, bounds.outHeight)
    if (longest <= 0) return null
    var sample = 1
    while (longest / (sample * 2) >= TARGET_PX) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
  }

  /**
   * Centre-crop to a square and mask it into a circle, at {@link #TARGET_PX}.
   *
   * Done here rather than left to the platform. `IconCompat.createWithAdaptiveBitmap` applies the
   * ADAPTIVE-ICON mask, which keeps only the middle ~66% of the image and reserves the rest as a
   * bleed zone for launcher animations — on a portrait photo of a person that reads as the face
   * being cut off, which is precisely what a profile picture must not do. A bitmap that is
   * already round needs no mask, so nothing crops it a second time.
   *
   * A non-square source is cropped from the CENTRE, which is where a face is in every photo
   * anyone chooses as an avatar.
   */
  private fun circleCrop(source: Bitmap): Bitmap {
    val side = minOf(source.width, source.height)
    if (side <= 0) return source
    val size = minOf(side, TARGET_PX)
    val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { isFilterBitmap = true }

    // The square window taken from the source, mapped onto the whole output.
    val left = (source.width - side) / 2
    val top = (source.height - side) / 2
    val src = Rect(left, top, left + side, top + side)
    val dst = Rect(0, 0, size, size)

    // Draw the circle first, then composite the photo INSIDE it. Clipping a path would alias on
    // the edge; SRC_IN gives a clean, anti-aliased boundary at no extra cost.
    val radius = size / 2f
    canvas.drawCircle(radius, radius, radius, paint)
    paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
    canvas.drawBitmap(source, src, dst, paint)
    return out
  }

  private fun writeFile(context: Context, accountId: String, bitmap: Bitmap): File? {
    val dir = File(context.filesDir, DIR)
    if (!dir.exists() && !dir.mkdirs()) return null
    // The account id is a uuid, but it arrives from JS — sanitising it means a surprising value
    // can never become a path.
    val safe = accountId.replace(Regex("[^A-Za-z0-9_-]"), "_")
    val file = File(dir, "$safe.png")
    val tmp = File(dir, "$safe.png.tmp")
    return try {
      tmp.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
      // Renamed into place so a notification can never decode a half-written file.
      if (tmp.renameTo(file)) file else null
    } catch (e: Throwable) {
      Log.i(TAG, "avatar write failed: ${e.javaClass.simpleName}")
      tmp.delete()
      null
    }
  }
}
