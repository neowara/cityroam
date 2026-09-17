package expo.modules.boardble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReassemblerTest {
  private val fx = ReferenceFixtures

  @Test
  fun `fragments reassemble to the original encrypted payload`() {
    val reassembler = Reassembler()
    val outcomes = fx.SEND_DPS_FRAGMENTS.map { reassembler.accept(it) }
    assertTrue(outcomes[0] is Reassembler.Outcome.Incomplete)
    assertTrue(outcomes[1] is Reassembler.Outcome.Incomplete)
    val complete = outcomes[2] as Reassembler.Outcome.Complete
    // Rebuilding the payload from the frame builder must equal what the fragments carry.
    val expected = TuyaFrame.buildFrame(
      fx.SEQ, 0, 0x0002, byteArrayOf(3, 1, 1, 1),
      fx.SESSION_KEY_V3_HEX.hexToBytes(), fx.IV, TuyaCrypto.SESSION_FLAG_V3,
    )
    assertArrayEquals(expected, complete.payload)
  }

  @Test
  fun `a retransmitted consumed fragment is ignored`() {
    val reassembler = Reassembler()
    reassembler.accept(fx.SEND_DPS_FRAGMENTS[0])
    reassembler.accept(fx.SEND_DPS_FRAGMENTS[1])
    // Duplicate of fragment 1 after we've moved on to expecting 2.
    assertEquals(Reassembler.Outcome.Incomplete::class, reassembler.accept(fx.SEND_DPS_FRAGMENTS[1])::class)
    val last = reassembler.accept(fx.SEND_DPS_FRAGMENTS[2])
    assertTrue(last is Reassembler.Outcome.Complete)
  }

  @Test
  fun `a missing fragment is malformed and resets the stream`() {
    val reassembler = Reassembler()
    reassembler.accept(fx.SEND_DPS_FRAGMENTS[0])
    reassembler.accept(fx.SEND_DPS_FRAGMENTS[2]) // skips 1
    val outcome = reassembler.accept(fx.SEND_DPS_FRAGMENTS[2])
    assertTrue(outcome is Reassembler.Outcome.Malformed)
    // After the reset, a fresh stream starting at fragment 0 works again.
    reassembler.accept(fx.DEVICE_INFO_V3_FRAGMENTS[0])
    val restarted = reassembler.accept(fx.DEVICE_INFO_V3_FRAGMENTS[1])
    assertTrue(restarted is Reassembler.Outcome.Complete)
  }

  @Test
  fun `an over-long stream is malformed`() {
    // 40 bytes needs three fragments at a 20-byte MTU (17 + 19 + 4 body bytes);
    // padding the last fragment past the declared total must be flagged, not accepted.
    val reassembler = Reassembler()
    val fragments = TuyaFrame.fragment(ByteArray(40) { it.toByte() }, fx.PROTOCOL_VERSION)
    assertEquals(3, fragments.size)
    assertTrue(reassembler.accept(fragments[0]) is Reassembler.Outcome.Incomplete)
    assertTrue(reassembler.accept(fragments[1]) is Reassembler.Outcome.Incomplete)
    val outcome = reassembler.accept(fragments[2] + ByteArray(10))
    assertTrue(outcome is Reassembler.Outcome.Malformed)
  }

  @Test
  fun `a new message mid-stream drops the incomplete one`() {
    val reassembler = Reassembler()
    reassembler.accept(fx.SEND_DPS_FRAGMENTS[0])
    reassembler.accept(fx.SEND_DPS_FRAGMENTS[1])
    // Fragment 0 of the device-info exchange arrives while the DPS message is incomplete.
    val outcome = reassembler.accept(fx.DEVICE_INFO_V3_FRAGMENTS[0])
    assertTrue(outcome is Reassembler.Outcome.Incomplete)
    val restarted = reassembler.accept(fx.DEVICE_INFO_V3_FRAGMENTS[1])
    val complete = restarted as Reassembler.Outcome.Complete
    val expected = TuyaFrame.buildFrame(
      fx.SEQ, 0, 0x0000, ByteArray(0),
      fx.LOGIN_KEY_V3_HEX.hexToBytes(), fx.IV, TuyaCrypto.LOGIN_FLAG_V3,
    )
    assertArrayEquals(expected, complete.payload)
  }

  @Test
  fun `an unreadable fragment header is malformed`() {
    val reassembler = Reassembler()
    val outcome = reassembler.accept(byteArrayOf(0x80.toByte()))
    assertTrue(outcome is Reassembler.Outcome.Malformed)
  }

  @Test
  fun `reset clears partial state`() {
    val reassembler = Reassembler()
    reassembler.accept(fx.SEND_DPS_FRAGMENTS[0])
    reassembler.reset()
    val outcome = reassembler.accept(fx.SEND_DPS_FRAGMENTS[0])
    assertEquals(Reassembler.Outcome.Incomplete::class, outcome::class)
  }
}
