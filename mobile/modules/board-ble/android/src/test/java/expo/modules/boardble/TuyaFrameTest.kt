package expo.modules.boardble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class TuyaFrameTest {
  private val fx = ReferenceFixtures

  @Test
  fun `crc16 modbus matches the known vector and the reference`() {
    assertEquals(0x4B37, TuyaFrame.crc16Modbus("123456789".toByteArray()))
    // Same input through the reference's own _calc_crc16, captured in the fixtures.
    assertEquals(0x94A1, TuyaFrame.crc16Modbus(ByteArray(12) { it.toByte() }))
  }

  @Test
  fun `varint round-trips across the boundary sizes`() {
    for (value in intArrayOf(0, 1, 127, 128, 16383, 16384, 2097151, 2097152)) {
      val packed = TuyaFrame.packVarint(value)
      val (unpacked, end) = TuyaFrame.unpackVarint(packed, 0)
      assertEquals(value, unpacked)
      assertEquals(packed.size, end)
    }
    assertArrayEquals(byteArrayOf(0x7F), TuyaFrame.packVarint(127))
    assertArrayEquals(byteArrayOf(0x80.toByte(), 0x01), TuyaFrame.packVarint(128))
  }

  @Test
  fun `varint rejects overrun input`() {
    try {
      TuyaFrame.unpackVarint(byteArrayOf(0x80.toByte()), 0)
      throw AssertionError("Truncated varint must be rejected")
    } catch (expected: TuyaProtocolException) {
    }
    try {
      TuyaFrame.unpackVarint(byteArrayOf(0x80.toByte(), 0x80.toByte(), 0x80.toByte(), 0x80.toByte(), 0x80.toByte()), 0)
      throw AssertionError("Over-long varint must be rejected")
    } catch (expected: TuyaProtocolException) {
    }
  }

  @Test
  fun `device-info frame matches the reference byte for byte`() {
    val packets = TuyaFrame.buildPackets(
      seqNum = fx.SEQ, responseTo = 0, code = 0x0000, data = ByteArray(0),
      key = fx.LOGIN_KEY_V3_HEX.hexToBytes(), iv = fx.IV,
      securityFlag = TuyaCrypto.LOGIN_FLAG_V3, protocolVersion = fx.PROTOCOL_VERSION,
    )
    assertEquals(fx.DEVICE_INFO_V3_FRAGMENTS.size, packets.size)
    fx.DEVICE_INFO_V3_FRAGMENTS.forEachIndexed { i, expected ->
      assertArrayEquals("fragment $i", expected, packets[i])
    }
  }

  @Test
  fun `device-status frame matches the reference byte for byte`() {
    val packets = TuyaFrame.buildPackets(
      seqNum = fx.SEQ, responseTo = 0, code = 0x0003, data = ByteArray(0),
      key = fx.SESSION_KEY_V3_HEX.hexToBytes(), iv = fx.IV,
      securityFlag = TuyaCrypto.SESSION_FLAG_V3, protocolVersion = fx.PROTOCOL_VERSION,
    )
    assertEquals(fx.DEVICE_STATUS_V3_FRAGMENTS.size, packets.size)
    fx.DEVICE_STATUS_V3_FRAGMENTS.forEachIndexed { i, expected ->
      assertArrayEquals("fragment $i", expected, packets[i])
    }
  }

  @Test
  fun `v2-derivation frames match the reference byte for byte`() {
    // Same exchange with a secKey present: flag 14 and the MD5(localKey + secKey) key.
    val infoPackets = TuyaFrame.buildPackets(
      seqNum = fx.SEQ, responseTo = 0, code = 0x0000, data = ByteArray(0),
      key = fx.LOGIN_KEY_V2_HEX.hexToBytes(), iv = fx.IV,
      securityFlag = TuyaCrypto.LOGIN_FLAG_V2, protocolVersion = fx.PROTOCOL_VERSION,
    )
    fx.DEVICE_INFO_V2_FRAGMENTS.forEachIndexed { i, expected ->
      assertArrayEquals("info fragment $i", expected, infoPackets[i])
    }
    val statusPackets = TuyaFrame.buildPackets(
      seqNum = fx.SEQ, responseTo = 0, code = 0x0003, data = ByteArray(0),
      key = fx.SESSION_KEY_V2_HEX.hexToBytes(), iv = fx.IV,
      securityFlag = TuyaCrypto.SESSION_FLAG_V2, protocolVersion = fx.PROTOCOL_VERSION,
    )
    fx.DEVICE_STATUS_V2_FRAGMENTS.forEachIndexed { i, expected ->
      assertArrayEquals("status fragment $i", expected, statusPackets[i])
    }
  }

  @Test
  fun `dps frame matches the reference byte for byte`() {
    val packets = TuyaFrame.buildPackets(
      seqNum = fx.SEQ, responseTo = 0, code = 0x0002, data = byteArrayOf(3, 1, 1, 1),
      key = fx.SESSION_KEY_V3_HEX.hexToBytes(), iv = fx.IV,
      securityFlag = TuyaCrypto.SESSION_FLAG_V3, protocolVersion = fx.PROTOCOL_VERSION,
    )
    assertEquals(fx.SEND_DPS_FRAGMENTS.size, packets.size)
    fx.SEND_DPS_FRAGMENTS.forEachIndexed { i, expected ->
      assertArrayEquals("fragment $i", expected, packets[i])
    }
  }

  @Test
  fun `pair request carries only the six-byte login key and fits 44 bytes`() {
    val uuid = "f381b1f3675c0751"
    val devId = "eb83eco1wexqxj6a"
    val request = TuyaFrame.buildPairRequest(uuid, fx.LOCAL_KEY, devId)

    assertEquals(TuyaFrame.PAIR_REQUEST_SIZE, request.size)
    assertEquals(uuid, String(request.copyOfRange(0, 16), Charsets.US_ASCII))
    // Six bytes of key, not the whole 16 — the full key would overflow the request.
    assertEquals(fx.LOCAL_KEY.substring(0, 6), String(request.copyOfRange(16, 22), Charsets.US_ASCII))
    assertEquals(devId, String(request.copyOfRange(22, 38), Charsets.US_ASCII))
    assertArrayEquals(ByteArray(6), request.copyOfRange(38, 44))
  }

  @Test(expected = TuyaProtocolException::class)
  fun `pair request rejects fields that overflow the fixed width`() {
    TuyaFrame.buildPairRequest("f381b1f3675c0751", fx.LOCAL_KEY, "e".repeat(40))
  }

  private fun String.hexToBytes(): ByteArray =
    chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
