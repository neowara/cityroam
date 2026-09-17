package expo.modules.boardble

/**
 * Tuya KLV datapoint codec: id(1) | type(1) | len(1 or 2) | value.
 *
 * Protocol v3 uses a one-byte value length, v4 two bytes. Types: raw 0, bool 1,
 * value 2 (signed 32-bit BE on the wire), string 3, enum 4, bitmap 5. An enum's value
 * is an integer index into the product schema's `range` array — the SDK resolved that
 * index to a label for us; without it the caller maps the index itself.
 */
enum class TuyaDpType(val value: Int) {
  RAW(0),
  BOOL(1),
  VALUE(2),
  STRING(3),
  ENUM(4),
  BITMAP(5);

  companion object {
    fun from(value: Int): TuyaDpType =
      entries.firstOrNull { it.value == value }
        ?: throw TuyaProtocolException("Unknown datapoint type $value")
  }
}

sealed class TuyaDpValue {
  data class Raw(val bytes: ByteArray) : TuyaDpValue()
  data class Bool(val value: Boolean) : TuyaDpValue()
  data class Value(val value: Int) : TuyaDpValue()
  data class Str(val value: String) : TuyaDpValue()
  data class Enum(val index: Int) : TuyaDpValue()
  data class Bitmap(val bytes: ByteArray) : TuyaDpValue()
}

data class TuyaDp(val id: Int, val type: TuyaDpType, val value: TuyaDpValue) {
  /** Index into a schema `range` array, for enum datapoints; null for anything else. */
  fun enumIndex(): Int? = (value as? TuyaDpValue.Enum)?.index
}

object TuyaDatapoint {
  /** Encodes KLV datapoints. Enum values are written 1/2/4 bytes BE by magnitude, as the reference does. */
  fun encode(points: List<TuyaDp>, lengthSize: Int = 1): ByteArray {
    if (lengthSize != 1 && lengthSize != 2) {
      throw TuyaProtocolException("KLV value length width must be 1 or 2 bytes")
    }
    val out = ArrayList<Byte>()
    for (dp in points) {
      val value = encodedValue(dp)
      out.add(dp.id.toByte())
      out.add(dp.type.value.toByte())
      if (value.size > 0xFF && lengthSize == 1) {
        throw TuyaProtocolException("Value for dp${dp.id} too long for one-byte KLV length")
      }
      if (lengthSize == 1) {
        out.add(value.size.toByte())
      } else {
        out.add(((value.size ushr 8) and 0xFF).toByte())
        out.add((value.size and 0xFF).toByte())
      }
      out.addAll(value.map { it.toByte() })
    }
    return out.toByteArray()
  }

  /**
   * Application payload for the protocol-v4 SEND_DPS opcode: a 0x00 + 4-byte
   * big-endian dp-sequence header, then the datapoints with two-byte value lengths.
   */
  fun buildV4Send(dpSeq: Int, points: List<TuyaDp>): ByteArray {
    val out = ByteArray(5)
    out[1] = (dpSeq ushr 24).toByte()
    out[2] = (dpSeq ushr 16).toByte()
    out[3] = (dpSeq ushr 8).toByte()
    out[4] = dpSeq.toByte()
    return out + encode(points, lengthSize = 2)
  }

  /** Decodes KLV datapoints from `startPos`; stops cleanly at the end of the input. */
  fun decode(data: ByteArray, startPos: Int = 0, lengthSize: Int = 1): List<TuyaDp> {
    if (lengthSize != 1 && lengthSize != 2) {
      throw TuyaProtocolException("KLV value length width must be 1 or 2 bytes")
    }
    val headerSize = 2 + lengthSize
    val points = ArrayList<TuyaDp>()
    var pos = startPos
    while (data.size - pos >= headerSize) {
      val id = data[pos].toInt() and 0xFF
      val type = TuyaDpType.from(data[pos + 1].toInt() and 0xFF)
      val len = if (lengthSize == 1) {
        data[pos + 2].toInt() and 0xFF
      } else {
        ((data[pos + 2].toInt() and 0xFF) shl 8) or (data[pos + 3].toInt() and 0xFF)
      }
      pos += headerSize
      val end = pos + len
      if (end > data.size) {
        throw TuyaProtocolException("Datapoint dp$id claims $len bytes but only ${data.size - pos} remain")
      }
      val raw = data.copyOfRange(pos, end)
      val value = when (type) {
        TuyaDpType.RAW, TuyaDpType.BITMAP -> if (type == TuyaDpType.RAW) TuyaDpValue.Raw(raw) else TuyaDpValue.Bitmap(raw)
        TuyaDpType.BOOL -> TuyaDpValue.Bool(raw.fold(0) { acc, b -> acc or (b.toInt() and 0xFF) } != 0)
        TuyaDpType.VALUE, TuyaDpType.ENUM -> {
          if (raw.isEmpty()) throw TuyaProtocolException("Datapoint dp$id has an empty integer value")
          var acc = if (raw[0].toInt() < 0) -1 else 0 // sign-extend from the first byte's high bit
          for (b in raw) acc = (acc shl 8) or (b.toInt() and 0xFF)
          if (type == TuyaDpType.VALUE) TuyaDpValue.Value(acc) else TuyaDpValue.Enum(acc)
        }
        TuyaDpType.STRING -> TuyaDpValue.Str(raw.toString(Charsets.UTF_8))
      }
      points.add(TuyaDp(id, type, value))
      pos = end
    }
    return points
  }

  /** Maps an enum datapoint's index through a schema `range` array; null when out of range. */
  fun enumLabel(dp: TuyaDp, range: List<String>): String? =
    dp.enumIndex()?.let { range.getOrNull(it) }

  private fun encodedValue(dp: TuyaDp): ByteArray = when (val v = dp.value) {
    is TuyaDpValue.Raw -> v.bytes
    is TuyaDpValue.Bitmap -> v.bytes
    is TuyaDpValue.Bool -> byteArrayOf(if (v.value) 1 else 0)
    is TuyaDpValue.Value -> {
      val out = ByteArray(4)
      out[0] = (v.value ushr 24).toByte()
      out[1] = (v.value ushr 16).toByte()
      out[2] = (v.value ushr 8).toByte()
      out[3] = v.value.toByte()
      out
    }
    is TuyaDpValue.Enum -> when {
      v.index > 0xFFFF -> intBytes(v.index)
      v.index > 0xFF -> byteArrayOf((v.index ushr 8).toByte(), v.index.toByte())
      else -> byteArrayOf(v.index.toByte())
    }
    is TuyaDpValue.Str -> v.value.toByteArray(Charsets.UTF_8)
  }

  private fun intBytes(value: Int): ByteArray =
    byteArrayOf((value ushr 24).toByte(), (value ushr 16).toByte(), (value ushr 8).toByte(), value.toByte())
}
