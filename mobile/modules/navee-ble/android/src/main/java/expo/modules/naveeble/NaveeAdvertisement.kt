package expo.modules.naveeble

/**
 * What a NAVEE scooter's advertisement says about itself, read the way the official
 * app reads it (decompiled `b4/a.java` `r()` and `s()`): straight out of the raw scan
 * record bytes, not through Android's parsed manufacturer data.
 *
 * The "cloud MAC" is the identifier the NAVEE account API stores for the scooter
 * (`Vehicle.mac`). It's printed in the advertisement rather than being the Bluetooth
 * address, which is how a scan result gets matched to a vehicle from the account.
 */
object NaveeAdvertisement {
  /** Manufacturer id seen on a real V40i Pro in nRF Connect. */
  const val COMPANY_ID = 0xF101

  /** Product id: bytes 6–7, little-endian. Null when the record is too short. */
  fun productId(scanRecord: ByteArray?): Int? {
    if (scanRecord == null || scanRecord.size <= 8) return null
    return (scanRecord[6].toInt() and 0xFF) or ((scanRecord[7].toInt() and 0xFF) shl 8)
  }

  /** Cloud MAC: bytes 8–13 reversed, as 12 uppercase hex digits. Null when too short. */
  fun cloudMac(scanRecord: ByteArray?): String? {
    if (scanRecord == null || scanRecord.size <= 14) return null
    return scanRecord.copyOfRange(8, 14).reversedArray().joinToString("") { "%02X".format(it) }
  }

  /** `AA:BB:…` or `aabb…` → `AABB…`, the form the account API uses. */
  fun normalizeMac(mac: String): String = mac.replace(":", "").replace("-", "").uppercase()

  /** `AABB…` → `AA:BB:…`, the form Android's Bluetooth APIs want. */
  fun toBluetoothAddress(mac: String): String = normalizeMac(mac).chunked(2).joinToString(":")

  fun looksLikeNavee(name: String?, hasCompanyData: Boolean): Boolean =
    hasCompanyData || (name != null && (name.contains("NAVEE", ignoreCase = true)))
}
