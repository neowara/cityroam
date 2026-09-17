package expo.modules.boardble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Parse-side checks: fields round-trip; truncated, over-claiming and bad-CRC input is rejected. */
class TuyaFrameParseTest {
  private val fx = ReferenceFixtures

  private val keys = mapOf(
    TuyaCrypto.LOGIN_FLAG_V3 to fx.LOGIN_KEY_V3_HEX.hexToBytes(),
    TuyaCrypto.SESSION_FLAG_V3 to fx.SESSION_KEY_V3_HEX.hexToBytes(),
  )

  private fun parse(frame: ByteArray) = TuyaFrame.parseFrame(frame) { keys[it] }

  @Test
  fun `parse frame round-trips its fields`() {
    val data = byteArrayOf(3, 1, 1, 1)
    val frame = TuyaFrame.buildFrame(
      0x11223344, 0x00000002, 0x0002, data,
      fx.SESSION_KEY_V3_HEX.hexToBytes(), fx.IV, TuyaCrypto.SESSION_FLAG_V3,
    )
    val parsed = parse(frame)
    assertEquals(TuyaCrypto.SESSION_FLAG_V3, parsed.securityFlag)
    assertEquals(0x11223344, parsed.seqNum)
    assertEquals(0x00000002, parsed.responseTo)
    assertEquals(0x0002, parsed.code)
    assertArrayEquals(data, parsed.data)
  }

  @Test
  fun `a corrupted crc is rejected, not accepted`() {
    val key = fx.SESSION_KEY_V3_HEX.hexToBytes()
    val frame = TuyaFrame.buildFrame(
      fx.SEQ, 0, 0x0003, byteArrayOf(1, 2, 3), key, fx.IV, TuyaCrypto.SESSION_FLAG_V3,
    )
    // Corrupt exactly the CRC bytes in the plaintext, then re-encrypt with the same
    // IV — a deterministic frame whose header is intact but whose CRC no longer matches.
    val iv = frame.copyOfRange(1, 17)
    val plaintext = TuyaCrypto.aesCbcDecrypt(key, iv, frame.copyOfRange(17, frame.size))
    val dataLength = ((plaintext[10].toInt() and 0xFF) shl 8) or (plaintext[11].toInt() and 0xFF)
    plaintext[12 + dataLength] = (plaintext[12 + dataLength].toInt() xor 0x5A).toByte()
    val tampered = frame.copyOfRange(0, 17) + TuyaCrypto.aesCbcEncrypt(key, iv, plaintext)
    try {
      parse(tampered)
      throw AssertionError("Bad CRC must be rejected")
    } catch (expected: TuyaProtocolException) {
      assertTrue(expected.message!!.contains("CRC"))
    }
  }

  @Test
  fun `a frame whose length overclaims is rejected`() {
    val key = fx.SESSION_KEY_V3_HEX.hexToBytes()
    val frame = TuyaFrame.buildFrame(
      fx.SEQ, 0, 0x0003, byteArrayOf(1, 2, 3), key, fx.IV, TuyaCrypto.SESSION_FLAG_V3,
    )
    // Tamper the length field inside the first plaintext block (same IV kept, so the
    // corruption is deterministic) so `length` claims more data than exists.
    val iv = frame.copyOfRange(1, 17)
    val plaintext = TuyaCrypto.aesCbcDecrypt(key, iv, frame.copyOfRange(17, frame.size))
    plaintext[10] = 0x7F
    plaintext[11] = 0xFF.toByte()
    val tampered = frame.copyOfRange(0, 17) + TuyaCrypto.aesCbcEncrypt(key, iv, plaintext)
    try {
      parse(tampered)
      throw AssertionError("Over-claiming length must be rejected")
    } catch (expected: TuyaProtocolException) {
      assertTrue(expected.message!!.contains("claims") || expected.message!!.contains("CRC"))
    }
  }

  @Test
  fun `a truncated payload is rejected`() {
    val key = keys.values.first()
    // flag + IV but only half a ciphertext block.
    val frame = ByteArray(17 + 8) { if (it < 17) 0 else 1 }
    try {
      parse(frame)
      throw AssertionError("Truncated frame must be rejected")
    } catch (expected: TuyaProtocolException) {
    }
  }

  @Test
  fun `an unknown security flag is rejected`() {
    val frame = TuyaFrame.buildFrame(
      fx.SEQ, 0, 0x0003, ByteArray(0),
      fx.SESSION_KEY_V3_HEX.hexToBytes(), fx.IV, 9,
    )
    try {
      parse(frame)
      throw AssertionError("Unknown security flag must be rejected")
    } catch (expected: TuyaProtocolException) {
      assertTrue(expected.message!!.contains("security flag"))
    }
  }

  private fun String.hexToBytes(): ByteArray =
    chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
