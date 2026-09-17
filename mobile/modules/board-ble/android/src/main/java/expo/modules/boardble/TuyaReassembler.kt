package expo.modules.boardble

/**
 * Accumulates GATT fragments back into one encrypted payload — the receive-side mirror
 * of [TuyaFrame.fragment]. Holds the partial input state across notifications, exactly
 * like the reference's notification handler.
 */
class Reassembler {
  sealed class Outcome {
    /** A full payload is ready for [TuyaFrame.parseFrame]. */
    data class Complete(val payload: ByteArray) : Outcome()

    /** Waiting for more fragments. */
    object Incomplete : Outcome()

    /** The stream is corrupt; state has already been reset, so the next fragment 0 starts fresh. */
    data class Malformed(val reason: String) : Outcome()
  }

  private var buffer: ByteArray = ByteArray(0)
  private var expectedPacketNum = 0
  private var expectedLength = 0
  private var inProgress = false

  fun reset() {
    buffer = ByteArray(0)
    expectedPacketNum = 0
    expectedLength = 0
    inProgress = false
  }

  fun accept(data: ByteArray): Outcome {
    val packetNum: Int
    val bodyStart: Int
    try {
      val (num, pos) = TuyaFrame.unpackVarint(data, 0)
      packetNum = num
      bodyStart = pos
    } catch (e: TuyaProtocolException) {
      reset()
      return Outcome.Malformed("Fragment header unreadable: ${e.message}")
    }

    if (packetNum < expectedPacketNum && packetNum != 0) {
      // A retransmitted already-consumed fragment — ignore it, the stream is fine.
      return Outcome.Incomplete
    }
    if (packetNum == 0 && inProgress) {
      // A new message started before the previous one completed — drop the partial
      // input and restart, same as the reference's clean-input-on-packet-0 path.
      reset()
    }

    if (packetNum != expectedPacketNum) {
      reset()
      return Outcome.Malformed("Missing fragment $expectedPacketNum, received $packetNum")
    }

    var body = bodyStart
    if (packetNum == 0) {
      val (total, afterTotal) = try {
        TuyaFrame.unpackVarint(data, body)
      } catch (e: TuyaProtocolException) {
        reset()
        return Outcome.Malformed("Total length unreadable: ${e.message}")
      }
      expectedLength = total
      body = afterTotal + 1 // skip the protocol-version byte; key selection uses the security flag
      inProgress = true
    }

    buffer += data.copyOfRange(body, data.size)
    expectedPacketNum++

    if (buffer.size > expectedLength) {
      reset()
      return Outcome.Malformed("Received ${buffer.size} bytes but expected $expectedLength")
    }
    if (buffer.size == expectedLength) {
      val payload = buffer
      reset()
      return Outcome.Complete(payload)
    }
    return Outcome.Incomplete
  }
}
