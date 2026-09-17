package expo.modules.naveeble

/**
 * NAVEE application frames, as the official app builds and reads them (decompiled
 * `b4/a.java`):
 *
 * ```
 * 55 AA flag cmd [len payload…] sum FE FD
 * ```
 *
 * `sum` is the low byte of the sum of every byte before it. A read command carries no
 * length byte at all (`j()`); a write carries one (`k()`/`l()`). Everything the scooter
 * sends has a length, and the first byte inside it is a status (0 = ok).
 *
 * Pure Kotlin, no Android imports, so it runs as a plain JVM unit test.
 */
object NaveeFrame {
  const val HEADER_0 = 0x55
  const val HEADER_1 = 0xAA
  const val FOOTER_0 = 0xFE
  const val FOOTER_1 = 0xFD

  const val CMD_AUTH = 0x30
  const val CMD_AUTH_CHALLENGE = 0x31
  const val CMD_SET_PARAMS = 0x6F
  const val CMD_READ_STATUS = 0x70
  const val CMD_READ_BATTERY = 0x72
  const val CMD_READ_FIRMWARE = 0x73
  const val CMD_READ_SERIAL = 0x74
  const val CMD_READ_DRIVE_HISTORY = 0x76
  const val CMD_HOME_TELEMETRY = 0x90
  const val CMD_DRIVE_TELEMETRY_V0 = 0x91
  const val CMD_DRIVE_TELEMETRY_V1 = 0x92

  /** Sub-command of [CMD_SET_PARAMS] the official app sends right after authenticating. */
  const val PARAM_CLOCK = 0x06

  /** Smallest frame the scooter sends: header, flag, cmd, len, status, sum, footer. */
  private const val MIN_RESPONSE_SIZE = 9

  data class Parsed(val flag: Int, val cmd: Int, val status: Int, val data: ByteArray) {
    override fun equals(other: Any?): Boolean =
      other is Parsed && flag == other.flag && cmd == other.cmd && status == other.status && data.contentEquals(other.data)

    override fun hashCode(): Int = ((flag * 31 + cmd) * 31 + status) * 31 + data.contentHashCode()
  }

  fun checksum(bytes: ByteArray, length: Int = bytes.size): Int {
    var sum = 0
    for (i in 0 until length) sum += bytes[i].toInt() and 0xFF
    return sum and 0xFF
  }

  /** A read command: no length byte, no payload. */
  fun read(cmd: Int, flag: Int = 0): ByteArray =
    seal(byteArrayOf(HEADER_0.toByte(), HEADER_1.toByte(), flag.toByte(), cmd.toByte()))

  /** A command with a payload. */
  fun write(cmd: Int, payload: ByteArray, flag: Int = 0): ByteArray =
    seal(byteArrayOf(HEADER_0.toByte(), HEADER_1.toByte(), flag.toByte(), cmd.toByte(), payload.size.toByte()) + payload)

  /** `0x6F [06, unix seconds as u32 big-endian]` — the clock the app sets after auth. */
  fun setClock(unixSeconds: Long): ByteArray =
    write(
      CMD_SET_PARAMS,
      byteArrayOf(
        PARAM_CLOCK.toByte(),
        (unixSeconds ushr 24).toByte(),
        (unixSeconds ushr 16).toByte(),
        (unixSeconds ushr 8).toByte(),
        unixSeconds.toByte(),
      ),
    )

  private fun seal(body: ByteArray): ByteArray =
    body + byteArrayOf(checksum(body).toByte(), FOOTER_0.toByte(), FOOTER_1.toByte())

  /**
   * The two directions do not agree on what the sum covers, so accept either.
   *
   * Commands the app sends sum every byte from the `55` on, and the scooter accepts
   * them. Everything the scooter sends back sums from the `AA` instead, leaving its
   * checksum exactly `0x55` short of the rule above — consistent across its auth
   * replies, status reads and telemetry pushes. Validating only the app's rule rejects
   * every frame the scooter ever sends.
   */
  private fun checksumMatches(frame: ByteArray): Boolean {
    val end = frame.size - 3
    val stated = u(frame, end)
    val full = checksum(frame, end)
    return stated == full || stated == ((full - HEADER_0) and 0xFF)
  }

  /** Parses exactly one complete frame, or null if it isn't one. */
  fun parse(frame: ByteArray): Parsed? {
    if (frame.size < MIN_RESPONSE_SIZE) return null
    if (u(frame, 0) != HEADER_0 || u(frame, 1) != HEADER_1) return null
    val len = u(frame, 4)
    if (len < 1 || frame.size != len + 8) return null
    if (u(frame, frame.size - 2) != FOOTER_0 || u(frame, frame.size - 1) != FOOTER_1) return null
    if (!checksumMatches(frame)) return null
    return Parsed(
      flag = u(frame, 2),
      cmd = u(frame, 3),
      status = u(frame, 5),
      data = frame.copyOfRange(6, 5 + len),
    )
  }

  fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

  private fun u(bytes: ByteArray, index: Int): Int = bytes[index].toInt() and 0xFF

  /**
   * Joins notifications back into frames. A frame longer than the negotiated MTU arrives
   * split across notifications, and noise before a header is skipped rather than
   * wedging the stream: anything that fails its footer or checksum drops one byte and
   * searches for the next `55 AA`.
   */
  class Reassembler(private val maxBuffered: Int = 1024) {
    private var buffer = ByteArray(0)

    /** Every complete frame now available, plus the raw bytes that were discarded. */
    data class Result(val frames: List<Parsed>, val discarded: Int)

    fun accept(chunk: ByteArray): Result {
      buffer += chunk
      val frames = ArrayList<Parsed>()
      var discarded = 0
      while (true) {
        val start = indexOfHeader()
        if (start < 0) {
          // Keep a trailing 0x55: it may be the first half of a header split across chunks.
          val keep = if (buffer.isNotEmpty() && u(buffer, buffer.size - 1) == HEADER_0) 1 else 0
          discarded += buffer.size - keep
          buffer = buffer.copyOfRange(buffer.size - keep, buffer.size)
          break
        }
        if (start > 0) {
          discarded += start
          buffer = buffer.copyOfRange(start, buffer.size)
        }
        if (buffer.size < 5) break
        val total = u(buffer, 4) + 8
        if (buffer.size < total) {
          if (buffer.size > maxBuffered) {
            discarded += 1
            buffer = buffer.copyOfRange(1, buffer.size)
            continue
          }
          break
        }
        val parsed = parse(buffer.copyOfRange(0, total))
        if (parsed == null) {
          discarded += 1
          buffer = buffer.copyOfRange(1, buffer.size)
          continue
        }
        frames += parsed
        buffer = buffer.copyOfRange(total, buffer.size)
      }
      return Result(frames, discarded)
    }

    fun reset() {
      buffer = ByteArray(0)
    }

    private fun indexOfHeader(): Int {
      for (i in 0 until buffer.size - 1) {
        if (u(buffer, i) == HEADER_0 && u(buffer, i + 1) == HEADER_1) return i
      }
      return -1
    }
  }
}
