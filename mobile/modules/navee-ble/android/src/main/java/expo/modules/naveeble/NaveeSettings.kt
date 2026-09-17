package expo.modules.naveeble

/**
 * The scooter settings Cityroam can read and change, keyed the way JS addresses them.
 *
 * Each field pairs where the official app reads the value in the `0x70` settings frame
 * (`b4/a.java` case 112) with the frame the official app sends to change it (its
 * settings screens: `AccelerationActivity`, `SpeedLimitActivity`, `MaxSpeedActivity`,
 * `StartupSpeedActivity`, `DeviceLockTimeActivity`, `DeviceMileageUnitActivity`,
 * `DeviceAfterFragment`'s switches). Every write is answered with the same command and a
 * status byte, after which the app re-reads `0x70`.
 *
 * Which fields a given scooter actually has is decided in JS from its product id and
 * from which offsets its `0x70` frame is long enough to contain — this table only says
 * how to talk about each one.
 */
object NaveeSettings {
  // The modes this scooter actually reports, read off its own display while cycling
  // them: there is no "turbo" — walking is the slow push-along mode, drive the fastest.
  const val MODE_DRIVE = 2
  const val MODE_ECO = 3
  const val MODE_WALK = 11

  class Field(val key: String, val statusOffset: Int, val encode: (Int) -> ByteArray)

  private fun single(cmd: Int): (Int) -> ByteArray = { value -> NaveeFrame.write(cmd, byteArrayOf(value.toByte())) }

  private fun params(cmd: Int, sub: Int): (Int) -> ByteArray = { value -> NaveeFrame.write(cmd, byteArrayOf(sub.toByte(), value.toByte())) }

  val FIELDS: List<Field> = listOf(
    Field("rideMode", 1, single(0x58)), // 3 eco, 5 turbo
    Field("locked", 2, single(0x51)), // 0 unlocked, 1 locked
    Field("cruise", 3, single(0x52)),
    Field("taillight", 4, single(0x54)),
    Field("energyRecovery", 5, single(0x53)), // level
    Field("mileageUnit", 7, single(0x55)), // 0 km, 1 mi
    Field("autoHeadlight", 8, single(0x57)),
    Field("tcs", 11, single(0x5F)),
    Field("turnSound", 12, single(0x60)),
    Field("startSpeed", 19, single(0x6A)), // km/h
    Field("speedLimit", 20, single(0x6B)), // km/h | 0x80 when on, 0 when off
    Field("maxSpeed", 25, params(0x6E, 1)), // km/h, options depend on the product id
    Field("autoLockTime", 34, params(0x6F, 2)),
  )

  private val byKey = FIELDS.associateBy { it.key }

  fun field(key: String): Field? = byKey[key]

  /** The command byte a field's write is acknowledged with. */
  fun ackCommand(key: String): Int? = field(key)?.encode?.invoke(0)?.let { it[3].toInt() and 0xFF }
}
