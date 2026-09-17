package expo.modules.naveeble

/**
 * Translates the scooter's telemetry into the datapoint map the rest of the app already
 * speaks (the Tuya dp ids a Tynee board reports — see lib/boardDpLabels.ts and
 * RideService.handleDps). Doing it here, once, is what lets the session layer, trip
 * recorder, native ride journal and widget run on a NAVEE unchanged.
 *
 * Field offsets are the official app's own (decompiled `b4/a.java`, `DeviceHomePageInfo`
 * / `DeviceSubPageInfo`), counted from the first byte after the status byte. The
 * **scales** marked UNVERIFIED are best guesses until a real ride is compared against the
 * scooter's own display — each one is a single constant below.
 */
object NaveeTelemetry {
  // Canonical dp ids (the Tynee board's), and the scale the app decodes them with.
  const val DP_LOCK = "1" // bool, wire polarity inverted: true = unlocked
  const val DP_SPEED = "2" // km/h × 10
  const val DP_BATTERY = "3" // %
  const val DP_TRIP_DISTANCE = "5" // km × 10
  const val DP_TRIP_TIME = "6" // seconds
  const val DP_ODOMETER = "12" // km × 10
  const val DP_RIDE_MODE = "14" // "level_1".."level_4"
  const val DP_VOLTAGE = "20" // V × 10

  // NAVEE-only extras. Nothing in the app reads these by id; they're kept in the dp map
  // so the debug log shows them next to the canonical values during verification.
  const val DP_NAVEE_REMAINING_KM = "navee.remainingKm"
  const val DP_NAVEE_CHARGING = "navee.charging"
  const val DP_NAVEE_WARNING = "navee.warningCode"
  const val DP_NAVEE_DRIVING_MODE = "navee.drivingMode"

  // UNVERIFIED: realTimeSpeed is km/h × 10 per scooterteam's port (the app's dp2 scale).
  private const val SPEED_RAW_PER_DP2 = 1
  // UNVERIFIED: drivingMileage assumed 0.1 km (the app's dp5 scale).
  private const val TRIP_DISTANCE_RAW_PER_DP5 = 1
  // UNVERIFIED: drivingDuration is one byte, so minutes is the only unit that fits a ride.
  private const val TRIP_TIME_SECONDS_PER_RAW = 60
  // totalMileage is already tenths of a km, the same unit as dp12: the scooter reports
  // 3576 for the 357.6 km its own app shows, so it passes through unscaled.
  private const val ODOMETER_DP12_PER_RAW = 1
  // UNVERIFIED: batteryVoltage assumed millivolts (scooterteam), dp20 is V × 10.
  private const val VOLTAGE_MV_PER_DP20 = 100

  /**
   * drivingMode, read off the scooter's own display while cycling its modes: 2 is drive,
   * 3 eco, 11 walking. The 5 the decompiled sources call "turbo" is not a mode this
   * model has — it is accepted and echoed back like any other byte while the scooter
   * carries on in whatever mode it was already in. Anything unrecognised stays unmapped
   * (reported raw under [DP_NAVEE_DRIVING_MODE]) rather than guessed at.
   */
  fun rideModeLevel(drivingMode: Int): String? = when (drivingMode) {
    NaveeSettings.MODE_ECO -> "level_1"
    NaveeSettings.MODE_DRIVE -> "level_2"
    // Walking mode is a push-along assist, not a riding level, so it maps to no dp14
    // rather than being forced onto the canonical scale.
    else -> null
  }

  /** Dps carried by one frame, or null for a frame that isn't telemetry. */
  fun toDps(frame: NaveeFrame.Parsed): Map<String, Any?>? {
    if (frame.status != 0) return null
    return when (frame.cmd) {
      NaveeFrame.CMD_HOME_TELEMETRY -> home(frame.data)
      NaveeFrame.CMD_DRIVE_TELEMETRY_V0 -> driveV0(frame.data)
      NaveeFrame.CMD_DRIVE_TELEMETRY_V1 -> driveV1(frame.data)
      NaveeFrame.CMD_READ_STATUS -> status(frame.data)
      NaveeFrame.CMD_READ_BATTERY -> battery(frame.data)
      else -> null
    }
  }

  /**
   * `0x72`, the only place this scooter reports pack voltage: its `0x90` push stops
   * before the voltage field, so nothing else can fill dp20.
   *
   * The percentage anchors the layout — it matches the battery dp the pushes carry — and
   * the two bytes after it read 36100 mV at 30%, which is a 10S pack a third full. The
   * later bytes (a steady 100, and a plausible pack temperature) stay unmapped until
   * something pins them down.
   */
  fun battery(d: ByteArray): Map<String, Any?>? {
    if (d.size < 4) return null
    val out = LinkedHashMap<String, Any?>()
    out[DP_BATTERY] = u8(d, 1)
    val millivolts = u16le(d, 2)
    if (millivolts > 0) out[DP_VOLTAGE] = millivolts / VOLTAGE_MV_PER_DP20
    return out
  }

  /**
   * `0x90`, pushed continuously while connected.
   *
   * The V40i Pro stops after `remainMileage`, so everything past it is optional: a
   * fixed 8-byte minimum rejected every push this scooter sends, taking the charging
   * and warning dps with it.
   */
  fun home(d: ByteArray): Map<String, Any?>? {
    if (d.size < 7) return null
    val out = LinkedHashMap<String, Any?>()
    out[DP_NAVEE_WARNING] = u8(d, 0)
    val drivingMode = u8(d, 1)
    out[DP_NAVEE_DRIVING_MODE] = drivingMode
    // The raw driving-mode byte, same value the settings screen's rideMode row shows —
    // the settings screen used to only ever learn this from a 0x70 status read (on
    // connect, after a write, or the 30s idle poll), so pressing the scooter's own mode
    // button left it showing a stale value for up to 30s even though the live 0x90 push
    // already knew the new one. Set unconditionally, both DP_RIDE_MODE (below) and this
    // key.
    out["rideMode"] = drivingMode
    // Explicit, not the old `?.let { }` (which left the previous value untouched for an
    // unmapped driving mode): walking (11) has no canonical dp14 equivalent, and the
    // session merge (deviceLink/session.ts) only overwrites a key when this map actually
    // carries it — omitting it here left dp14 (and everything reading it: the FAB's mode
    // button, mode chips) showing the last Eco/Ride value while riding in walking mode.
    out[DP_RIDE_MODE] = rideModeLevel(drivingMode)
    out[DP_BATTERY] = u8(d, 2)
    out[DP_NAVEE_CHARGING] = u8(d, 4) != 0
    out[DP_NAVEE_REMAINING_KM] = u8(d, 6)
    // The app stores lockStatus as (value - 1) and ignores 0 (unknown).
    val lock = if (d.size > 7) u8(d, 7) else 0
    if (lock > 0) out[DP_LOCK] = (lock - 1) == 0
    if (d.size >= 16) {
      val millivolts = u32le(d, 8)
      if (millivolts > 0) out[DP_VOLTAGE] = (millivolts / VOLTAGE_MV_PER_DP20).toInt()
    }
    return out
  }

  /** `0x91`, the older drive page with one-byte fields. */
  fun driveV0(d: ByteArray): Map<String, Any?>? {
    if (d.size < 9) return null
    return linkedMapOf(
      DP_BATTERY to u8(d, 0),
      DP_SPEED to u8(d, 2) * SPEED_RAW_PER_DP2,
      DP_NAVEE_REMAINING_KM to u8(d, 3),
      DP_TRIP_DISTANCE to u8(d, 4) * TRIP_DISTANCE_RAW_PER_DP5,
      DP_TRIP_TIME to u8(d, 5) * TRIP_TIME_SECONDS_PER_RAW,
      DP_ODOMETER to u8(d, 8) * ODOMETER_DP12_PER_RAW,
    )
  }

  /** `0x92`, the drive page with wider fields. */
  fun driveV1(d: ByteArray): Map<String, Any?>? {
    if (d.size < 14) return null
    var odometer = u16le(d, 12).toLong()
    if (d.size >= 18) {
      val wide = u32le(d, 14)
      if (wide > 0) odometer = wide
    }
    return linkedMapOf(
      DP_BATTERY to u8(d, 0),
      DP_SPEED to u16le(d, 2) * SPEED_RAW_PER_DP2,
      DP_NAVEE_REMAINING_KM to u8(d, 4),
      DP_TRIP_DISTANCE to u16le(d, 5) * TRIP_DISTANCE_RAW_PER_DP5,
      DP_TRIP_TIME to u8(d, 7) * TRIP_TIME_SECONDS_PER_RAW,
      DP_ODOMETER to (odometer * ODOMETER_DP12_PER_RAW).toInt(),
    )
  }

  /**
   * `0x70` settings read. Offsets are the official app's `DeviceCarInfo` setters in
   * `b4/a.java` (case 112). Every field the settings screen can show or change is
   * reported under its [NaveeSettings] key, plus the canonical lock/mode dps.
   */
  fun status(d: ByteArray): Map<String, Any?>? {
    if (d.size < 4) return null
    val out = LinkedHashMap<String, Any?>()
    fun put(key: String, index: Int) {
      if (d.size > index) out[key] = u8(d, index)
    }
    val drivingMode = u8(d, 1)
    out[DP_NAVEE_DRIVING_MODE] = drivingMode
    // Explicit null for walking (11) — see home()'s matching comment above.
    out[DP_RIDE_MODE] = rideModeLevel(drivingMode)
    out[DP_LOCK] = u8(d, 2) == 0
    for (field in NaveeSettings.FIELDS) put(field.key, field.statusOffset)
    return out
  }

  private fun u8(d: ByteArray, i: Int): Int = d[i].toInt() and 0xFF

  private fun u16le(d: ByteArray, i: Int): Int = u8(d, i) or (u8(d, i + 1) shl 8)

  private fun u32le(d: ByteArray, i: Int): Long =
    (u8(d, i).toLong()) or (u8(d, i + 1).toLong() shl 8) or (u8(d, i + 2).toLong() shl 16) or (u8(d, i + 3).toLong() shl 24)
}
