package expo.modules.appupdater

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.nio.charset.StandardCharsets

class Sha256Test {
  @Test
  fun `hashes a file's contents, not its name or path`() {
    val file = File.createTempFile("sha256test", ".bin")
    file.deleteOnExit()
    file.writeBytes("hello world".toByteArray(StandardCharsets.UTF_8))

    // Known SHA-256 of the ASCII string "hello world" (verified: `printf 'hello
    // world' | sha256sum`).
    assertEquals(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      Sha256.hex(file),
    )
  }

  @Test
  fun `an empty file hashes to the well-known empty-input digest`() {
    val file = File.createTempFile("sha256test-empty", ".bin")
    file.deleteOnExit()

    // The well-known SHA-256 digest of zero bytes (verified: `printf '' | sha256sum`).
    assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Sha256.hex(file))
  }

  @Test
  fun `hashing bytes directly matches hashing the same bytes written to a file`() {
    val bytes = "a signing certificate's raw DER bytes, for example".toByteArray(StandardCharsets.UTF_8)
    val file = File.createTempFile("sha256test-bytes", ".bin")
    file.deleteOnExit()
    file.writeBytes(bytes)

    assertEquals(Sha256.hex(file), Sha256.hex(bytes))
  }

  @Test
  fun `a large file hashes correctly across multiple read buffers`() {
    // Bigger than STREAM_BUFFER_BYTES (64 KiB) so the streaming loop actually
    // exercises more than one read() call.
    val file = File.createTempFile("sha256test-large", ".bin")
    file.deleteOnExit()
    val chunk = ByteArray(1024) { (it % 256).toByte() }
    file.outputStream().use { out -> repeat(200) { out.write(chunk) } } // ~200 KiB

    val direct = java.security.MessageDigest.getInstance("SHA-256").let { digest ->
      repeat(200) { digest.update(chunk) }
      digest.digest().joinToString("") { "%02x".format(it) }
    }
    assertEquals(direct, Sha256.hex(file))
  }
}
