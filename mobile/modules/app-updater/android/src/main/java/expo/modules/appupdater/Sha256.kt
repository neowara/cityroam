package expo.modules.appupdater

import java.io.File
import java.security.MessageDigest

/**
 * Pure JVM SHA-256 helper — no Android framework dependency, so it JVM-unit-tests
 * directly against real temp files with no device/Robolectric needed. Streams rather
 * than reading the whole file into memory: the APK this hashes is tens of megabytes.
 */
object Sha256 {
  private const val STREAM_BUFFER_BYTES = 64 * 1024

  fun hex(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(STREAM_BUFFER_BYTES)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return toHexString(digest.digest())
  }

  /** Hashes and hex-encodes `bytes` directly — used for a signing certificate's raw
   * DER bytes, which are already in memory (unlike the APK file above). */
  fun hex(bytes: ByteArray): String = toHexString(MessageDigest.getInstance("SHA-256").digest(bytes))

  private fun toHexString(digestBytes: ByteArray): String =
    digestBytes.joinToString("") { "%02x".format(it) }
}
