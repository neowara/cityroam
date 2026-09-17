package expo.modules.boardble

/**
 * Tuya BLE frame codec: framing, CRC, encryption and 20-byte GATT fragmentation.
 *
 * A frame, before encryption, is:
 *
 *     seq_num(4, BE) | response_to(4, BE) | code(2, BE) | length(2, BE) | data | crc16(2, BE)
 *
 * zero-padded to a multiple of 16, then AES-128-CBC encrypted with a random 16-byte
 * IV. On the wire: security_flag(1) | iv(16) | ciphertext. The security flag selects
 * the key: 4/14 = login key (device-info exchange), 5/15 = session key (everything
 * after), 1 = the device-info response's auth key.
 *
 * Encrypted payloads are split into <=20-byte GATT writes. Each fragment starts with
 * a varint packet number; fragment 0 also carries a varint total length and one byte
 * of protocol_version << 4. [Reassembler] mirrors this.
 */
object TuyaFrame {
  /**
   * Fallback chunk size, used only until an MTU is negotiated. Callers pass the real
   * one: at least one board ignores a frame split across fragments and answers only
   * when the whole thing arrives in a single write.
   */
  const val GATT_MTU = 20

  /** CRC-16/MODBUS: init 0xFFFF, reflected poly 0xA001, over everything before the CRC. */
  fun crc16Modbus(data: ByteArray): Int {
    var crc = 0xFFFF
    for (byte in data) {
      crc = crc xor (byte.toInt() and 0xFF)
      repeat(8) {
        val low = crc and 1
        crc = crc ushr 1
        if (low != 0) crc = crc xor 0xA001
      }
    }
    return crc
  }

  /** 7 bits per byte, high bit set means "more follows" (as in the reference). */
  fun packVarint(value: Int): ByteArray {
    var remaining = value
    val out = ArrayList<Byte>(1)
    while (true) {
      var byte = remaining and 0x7F
      remaining = remaining ushr 7
      if (remaining != 0) byte = byte or 0x80
      out.add(byte.toByte())
      if (remaining == 0) break
    }
    return out.toByteArray()
  }

  /** Returns (value, position after the varint). */
  fun unpackVarint(data: ByteArray, startPos: Int): Pair<Int, Int> {
    var result = 0
    var offset = 0
    while (offset < 5) {
      val pos = startPos + offset
      if (pos >= data.size) {
        throw TuyaProtocolException("Varint runs past the end of the input")
      }
      val byte = data[pos].toInt() and 0xFF
      result = result or ((byte and 0x7F) shl (offset * 7))
      offset++
      if (byte and 0x80 == 0) {
        return result to (startPos + offset)
      }
    }
    throw TuyaProtocolException("Varint longer than 4 bytes")
  }

  /**
   * Builds one encrypted (unfragmented) payload. `iv` is a parameter so tests (and the
   * debug probe) can pin it; production callers generate a fresh random one.
   */
  fun buildFrame(
    seqNum: Int,
    responseTo: Int,
    code: Int,
    data: ByteArray,
    key: ByteArray,
    iv: ByteArray,
    securityFlag: Int,
  ): ByteArray {
    if (iv.size != 16) {
      throw TuyaProtocolException("AES-CBC IV must be 16 bytes")
    }
    val raw = ByteArray(14 + data.size)
    writeUInt32BE(raw, 0, seqNum)
    writeUInt32BE(raw, 4, responseTo)
    writeUInt16BE(raw, 8, code)
    writeUInt16BE(raw, 10, data.size)
    data.copyInto(raw, 12)
    writeUInt16BE(raw, 12 + data.size, crc16Modbus(raw.copyOfRange(0, 12 + data.size)))
    // Zero-padded to a block multiple; the padding sits after the CRC, exactly as the
    // receiver expects it when it re-checks the CRC over everything before it.
    val padded = raw.copyOf(((raw.size + 15) / 16) * 16)
    val ciphertext = TuyaCrypto.aesCbcEncrypt(key, iv, padded)
    return byteArrayOf(securityFlag.toByte()) + iv + ciphertext
  }

  /** Fixed width of the pair request; the fields below are zero-padded out to it. */
  const val PAIR_REQUEST_SIZE = 44

  /**
   * Pair (login) request payload: uuid(ASCII) + the six-byte pairing login key +
   * devId(ASCII), zero-padded to 44 bytes.
   *
   * The key field is the first six bytes of localKey, not the whole thing. With a
   * 16-char uuid and a 16-char devId, a full 16-byte key would overflow the request
   * rather than being padded into it.
   */
  fun buildPairRequest(uuid: String?, localKey: String, devId: String): ByteArray {
    val keyBytes = localKey.toByteArray(Charsets.US_ASCII)
    if (keyBytes.size < 6) {
      throw TuyaProtocolException("localKey must be at least 6 ASCII characters")
    }
    val body = (uuid ?: "").toByteArray(Charsets.US_ASCII) +
      keyBytes.copyOfRange(0, 6) +
      devId.toByteArray(Charsets.US_ASCII)
    if (body.size > PAIR_REQUEST_SIZE) {
      throw TuyaProtocolException("Pair request is ${body.size} bytes, over the $PAIR_REQUEST_SIZE-byte limit")
    }
    return body.copyOf(PAIR_REQUEST_SIZE)
  }

  /** Splits an encrypted payload into GATT-sized fragments. */
  fun fragment(encrypted: ByteArray, protocolVersion: Int, mtu: Int = GATT_MTU): List<ByteArray> {
    val packets = ArrayList<ByteArray>()
    var packetNum = 0
    var pos = 0
    while (pos < encrypted.size) {
      val numBytes = packVarint(packetNum)
      val headerSize = numBytes.size +
        (if (packetNum == 0) packVarint(encrypted.size).size + 1 else 0)
      val chunk = minOf(mtu - headerSize, encrypted.size - pos)
      val packet = ByteArray(headerSize + chunk)
      var offset = 0
      numBytes.copyInto(packet, offset); offset += numBytes.size
      if (packetNum == 0) {
        val total = packVarint(encrypted.size)
        total.copyInto(packet, offset); offset += total.size
        packet[offset] = (protocolVersion shl 4).toByte(); offset += 1
      }
      encrypted.copyInto(packet, offset, pos, pos + chunk)
      packets.add(packet)
      pos += chunk
      packetNum++
    }
    return packets
  }

  fun buildPackets(
    seqNum: Int,
    responseTo: Int,
    code: Int,
    data: ByteArray,
    key: ByteArray,
    iv: ByteArray,
    securityFlag: Int,
    protocolVersion: Int,
    mtu: Int = GATT_MTU,
  ): List<ByteArray> =
    fragment(buildFrame(seqNum, responseTo, code, data, key, iv, securityFlag), protocolVersion, mtu)

  /**
   * Decrypts and verifies a complete reassembled payload. The CRC is checked whenever
   * the frame carries one (anything after `length` bytes of data), matching the
   * reference; frames whose length field claims more data than was received are
   * rejected outright.
   */
  fun parseFrame(reassembled: ByteArray, keyForSecurityFlag: (Int) -> ByteArray?): ParsedFrame {
    // security_flag(1) + iv(16) + at least one full ciphertext block.
    if (reassembled.size < 17 + 16) {
      throw TuyaProtocolException("Frame shorter than flag + IV + one AES block")
    }
    val securityFlag = reassembled[0].toInt() and 0xFF
    val key = keyForSecurityFlag(securityFlag)
      ?: throw TuyaProtocolException("Unknown security flag $securityFlag")
    val iv = reassembled.copyOfRange(1, 17)
    val ciphertext = reassembled.copyOfRange(17, reassembled.size)
    val raw = try {
      TuyaCrypto.aesCbcDecrypt(key, iv, ciphertext)
    } catch (e: Exception) {
      throw TuyaProtocolException("Decryption failed: ${e.message}")
    }
    if (raw.size < 14) {
      throw TuyaProtocolException("Decrypted frame shorter than header + CRC")
    }

    val seqNum = readUInt32BE(raw, 0)
    val responseTo = readUInt32BE(raw, 4)
    val code = readUInt16BE(raw, 8)
    val length = readUInt16BE(raw, 10)
    val dataEnd = 12 + length
    if (raw.size < dataEnd) {
      throw TuyaProtocolException("Frame claims $length bytes of data but only ${raw.size - 12} available")
    }
    if (raw.size > dataEnd) {
      if (raw.size < dataEnd + 2) {
        throw TuyaProtocolException("Frame has no room for its CRC")
      }
      val expected = readUInt16BE(raw, dataEnd)
      val actual = crc16Modbus(raw.copyOfRange(0, dataEnd))
      if (expected != actual) {
        throw TuyaProtocolException("CRC mismatch: frame says 0x%04X, computed 0x%04X".format(expected, actual))
      }
    }
    return ParsedFrame(securityFlag, seqNum, responseTo, code, raw.copyOfRange(12, dataEnd))
  }

  private fun writeUInt32BE(target: ByteArray, offset: Int, value: Int) {
    target[offset] = (value ushr 24).toByte()
    target[offset + 1] = (value ushr 16).toByte()
    target[offset + 2] = (value ushr 8).toByte()
    target[offset + 3] = value.toByte()
  }

  private fun writeUInt16BE(target: ByteArray, offset: Int, value: Int) {
    target[offset] = (value ushr 8).toByte()
    target[offset + 1] = value.toByte()
  }

  private fun readUInt32BE(source: ByteArray, offset: Int): Int =
    ((source[offset].toInt() and 0xFF) shl 24) or
      ((source[offset + 1].toInt() and 0xFF) shl 16) or
      ((source[offset + 2].toInt() and 0xFF) shl 8) or
      (source[offset + 3].toInt() and 0xFF)

  private fun readUInt16BE(source: ByteArray, offset: Int): Int =
    ((source[offset].toInt() and 0xFF) shl 8) or (source[offset + 1].toInt() and 0xFF)
}

data class ParsedFrame(
  val securityFlag: Int,
  val seqNum: Int,
  val responseTo: Int,
  val code: Int,
  val data: ByteArray,
)
