package expo.modules.boardble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TuyaDatapointTest {
  @Test
  fun `round-trips every type`() {
    val points = listOf(
      TuyaDp(1, TuyaDpType.RAW, TuyaDpValue.Raw(byteArrayOf(0x01, 0x02))),
      TuyaDp(2, TuyaDpType.BOOL, TuyaDpValue.Bool(true)),
      TuyaDp(3, TuyaDpType.VALUE, TuyaDpValue.Value(3298)),
      TuyaDp(4, TuyaDpType.STRING, TuyaDpValue.Str("hello")),
      TuyaDp(5, TuyaDpType.ENUM, TuyaDpValue.Enum(2)),
      TuyaDp(6, TuyaDpType.BITMAP, TuyaDpValue.Bitmap(byteArrayOf(0x0F.toByte()))),
    )
    val encoded = TuyaDatapoint.encode(points)
    val decoded = TuyaDatapoint.decode(encoded)
    assertEquals(points.size, decoded.size)
    for ((original, round) in points.zip(decoded)) {
      assertEquals(original.id, round.id)
      assertEquals(original.type, round.type)
      when (original.value) {
        is TuyaDpValue.Raw -> assertArrayEquals((original.value as TuyaDpValue.Raw).bytes, (round.value as TuyaDpValue.Raw).bytes)
        is TuyaDpValue.Bool -> assertEquals((original.value as TuyaDpValue.Bool).value, (round.value as TuyaDpValue.Bool).value)
        is TuyaDpValue.Value -> assertEquals((original.value as TuyaDpValue.Value).value, (round.value as TuyaDpValue.Value).value)
        is TuyaDpValue.Str -> assertEquals((original.value as TuyaDpValue.Str).value, (round.value as TuyaDpValue.Str).value)
        is TuyaDpValue.Enum -> assertEquals((original.value as TuyaDpValue.Enum).index, (round.value as TuyaDpValue.Enum).index)
        is TuyaDpValue.Bitmap -> assertArrayEquals((original.value as TuyaDpValue.Bitmap).bytes, (round.value as TuyaDpValue.Bitmap).bytes)
      }
    }
  }

  @Test
  fun `encodes the reference dps payload`() {
    // The SEND_DPS fixture frame carries exactly this one-datapoint payload.
    val encoded = TuyaDatapoint.encode(listOf(TuyaDp(3, TuyaDpType.BOOL, TuyaDpValue.Bool(true))))
    assertArrayEquals(byteArrayOf(3, 1, 1, 1), encoded)
  }

  @Test
  fun `decodes a signed 32-bit value`() {
    val decoded = TuyaDatapoint.decode(byteArrayOf(2, 2, 4, 0xFF.toByte(), 0xFF.toByte(), 0xFE.toByte(), 0xDC.toByte()))
    assertEquals(listOf(-292), decoded.map { (it.value as TuyaDpValue.Value).value })
  }

  @Test
  fun `bool is true for any nonzero byte`() {
    val decoded = TuyaDatapoint.decode(byteArrayOf(2, 1, 1, 0x42))
    assertEquals(true, (decoded[0].value as TuyaDpValue.Bool).value)
  }

  @Test
  fun `enum index maps through a schema range`() {
    // dp11's real range on this product: ["km", "mile"].
    val range = listOf("km", "mile")
    val dp = TuyaDp(11, TuyaDpType.ENUM, TuyaDpValue.Enum(1))
    assertEquals("mile", TuyaDatapoint.enumLabel(dp, range))
    assertEquals("km", TuyaDatapoint.enumLabel(TuyaDp(11, TuyaDpType.ENUM, TuyaDpValue.Enum(0)), range))
    assertNull(TuyaDatapoint.enumLabel(TuyaDp(11, TuyaDpType.ENUM, TuyaDpValue.Enum(7)), range))
    assertNull(TuyaDatapoint.enumLabel(TuyaDp(11, TuyaDpType.BOOL, TuyaDpValue.Bool(true)), range))
  }

  @Test
  fun `two-byte length variant round-trips`() {
    val points = listOf(
      TuyaDp(1, TuyaDpType.RAW, TuyaDpValue.Raw(ByteArray(300) { it.toByte() })),
      TuyaDp(2, TuyaDpType.BOOL, TuyaDpValue.Bool(false)),
    )
    val encoded = TuyaDatapoint.encode(points, lengthSize = 2)
    val decoded = TuyaDatapoint.decode(encoded, lengthSize = 2)
    assertEquals(2, decoded.size)
    assertEquals(300, (decoded[0].value as TuyaDpValue.Raw).bytes.size)
  }

  @Test
  fun `over-claiming length is rejected`() {
    // dp2 claims 4 bytes but only 1 follows.
    try {
      TuyaDatapoint.decode(byteArrayOf(2, 1, 4, 1))
      throw AssertionError("Over-claiming KLV length must be rejected")
    } catch (expected: TuyaProtocolException) {
    }
  }

  @Test
  fun `unknown type is rejected`() {
    try {
      TuyaDatapoint.decode(byteArrayOf(2, 6, 1, 1))
      throw AssertionError("Unknown datapoint type must be rejected")
    } catch (expected: TuyaProtocolException) {
      assertTrue(expected.message!!.contains("type"))
    }
  }

  @Test
  fun `enum encodes variable-width by magnitude, as the reference does`() {
    val small = TuyaDatapoint.encode(listOf(TuyaDp(14, TuyaDpType.ENUM, TuyaDpValue.Enum(2))))
    assertArrayEquals(byteArrayOf(14, 4, 1, 2), small)
    val wide = TuyaDatapoint.encode(listOf(TuyaDp(14, TuyaDpType.ENUM, TuyaDpValue.Enum(300))))
    assertArrayEquals(byteArrayOf(14, 4, 2, 0x01, 0x2C), wide)
  }

  @Test
  fun `encodes dp101 direction with a two-byte length for v4 writes`() {
    // v4 value lengths are two bytes: dp101 enum index 1 ("back") is 65 04 00 01 01.
    val encoded = TuyaDatapoint.encode(
      listOf(TuyaDp(101, TuyaDpType.ENUM, TuyaDpValue.Enum(1))),
      lengthSize = 2,
    )
    assertArrayEquals(byteArrayOf(0x65, 4, 0, 1, 1), encoded)
  }

  @Test
  fun `v4 parser rejects the old one-byte-length dp101 write`() {
    // The old write was 65 04 01 01 (one-byte length); read as v4's two-byte length that
    // claims 0x0101 = 257 bytes, which overruns — a v4 board therefore dropped it.
    val old = TuyaDatapoint.encode(listOf(TuyaDp(101, TuyaDpType.ENUM, TuyaDpValue.Enum(1))))
    assertArrayEquals(byteArrayOf(0x65, 4, 1, 1), old)
    val rejected = try {
      TuyaDatapoint.decode(old, lengthSize = 2)
      null
    } catch (expected: TuyaProtocolException) {
      expected
    }
    assertTrue(rejected != null)
  }

  @Test
  fun `builds the v4 SEND_DPS payload as 0x00 + dp sequence + two-byte-length KLV`() {
    val payload = TuyaDatapoint.buildV4Send(
      dpSeq = 7,
      listOf(TuyaDp(101, TuyaDpType.ENUM, TuyaDpValue.Enum(1))),
    )
    // 00 00 00 00 07 is the 0x00 + 4-byte BE dp sequence; 65 04 00 01 01 is dp101.
    assertArrayEquals(byteArrayOf(0, 0, 0, 0, 7, 0x65, 4, 0, 1, 1), payload)
  }
}
