package expo.modules.boardble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID

/**
 * Scan for the board with no Tuya code involved, then pick the right device.
 *
 * Matching priority: a Tuya uuid embedded in the 0x07D0 manufacturer record (bytes 6+
 * are the uuid as ASCII) wins, then an exact MAC, then the strongest advertiser. The
 * uuid match is what lets a user with several Tuya boards nearby pick the right one.
 */
object BoardScanner {
  private const val TAG = "BoardBle"

  /** Tuya's Bluetooth SIG company identifier. */
  private const val TUYA_MANUFACTURER_ID = 0x07D0

  val SERVICE_FD50: UUID = UUID.fromString("0000fd50-0000-1000-8000-00805f9b34fb")

  data class Found(
    val device: BluetoothDevice,
    val rssi: Int,
    val advertisedName: String?,
    val tuyaUuid: String?,
    /** `BluetoothDevice.ADDRESS_TYPE_PUBLIC` / `_RANDOM` / `_UNKNOWN` — see
     * [addressTypeOf]'s own comment for how this is obtained and its accuracy. */
    val addressType: Int,
  )

  /**
   * `BluetoothDevice.getAddressType()` is real, public API but only from API 35
   * (confirmed against developer.android.com — there is no androidx shim). Below that,
   * and as a fallback if the call itself fails, this reads the top two bits of the MAC
   * instead: a static random address always has both set (Bluetooth Core Spec, not a
   * documented Android API) — a heuristic, not authoritative, but the only signal
   * available pre-35. Getting this right is what lets a reconnect use
   * `BluetoothAdapter.getRemoteLeDevice(mac, type)` (API 33+) instead of the legacy
   * `getRemoteDevice(mac)`, which silently assumes a public address.
   */
  @SuppressLint("MissingPermission") // JS requests BLUETOOTH_CONNECT before this runs
  fun addressTypeOf(device: BluetoothDevice): Int {
    if (Build.VERSION.SDK_INT >= 35) {
      try {
        return device.addressType
      } catch (e: Exception) {
        // Fall through to the heuristic below.
      }
    }
    return inferAddressTypeFromMac(device.address)
  }

  fun inferAddressTypeFromMac(mac: String?): Int {
    val firstByte = mac?.replace(":", "")?.take(2)?.toIntOrNull(16)
      ?: return BluetoothDevice.ADDRESS_TYPE_UNKNOWN
    return if ((firstByte and 0xC0) == 0xC0) BluetoothDevice.ADDRESS_TYPE_RANDOM else BluetoothDevice.ADDRESS_TYPE_PUBLIC
  }


  /** The Tuya uuid carried in a scan record's 0x07D0 manufacturer data, if any. */
  fun tuyaUuidFromManufacturerData(record: android.bluetooth.le.ScanRecord?): String? {
    val raw = record?.getManufacturerSpecificData(TUYA_MANUFACTURER_ID) ?: return null
    if (raw.size <= 6) return null
    return try {
      String(raw.copyOfRange(6, raw.size), Charsets.US_ASCII)
    } catch (e: Exception) {
      null
    }
  }

  /**
   * Scans for up to `timeoutMs` for devices advertising the FD50 service and calls
   * `onFound` with the best match; `onFound(null)` when nothing matched.
   */
  @SuppressLint("MissingPermission") // JS requests BLUETOOTH_SCAN before reaching here
  fun findBoard(
    context: Context,
    targetUuid: String?,
    targetMac: String?,
    timeoutMs: Long,
    onFound: (Found?) -> Unit,
    onProblem: (String) -> Unit = {},
    /** Handed a cancel lambda the instant the scan actually starts, so a caller that
     * needs to stop waiting early (a client being stopped mid-scan) can end the scan
     * immediately instead of waiting out the rest of `timeoutMs`. Calling it is
     * equivalent to the timeout firing with nothing found; safe to call from any thread. */
    onCancelReady: (() -> Unit) -> Unit = {},
  ): Boolean {
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val scanner = manager?.adapter?.bluetoothLeScanner
    if (scanner == null) {
      // Null specifically when Bluetooth is off, which reads as "board not found".
      onProblem("no Bluetooth scanner available. Is Bluetooth on?")
      // Deliberately no onFound here: returning false already means "this never
      // started, and will never call back". Doing both made callers settle the same
      // promise twice, which throws.
      return false
    }

    val matches = LinkedHashMap<String, Found>()
    val handler = android.os.Handler(Looper.getMainLooper())
    // onFound must run exactly once: an identity match ends the scan early, and the
    // timeout below fires regardless.
    val reported = java.util.concurrent.atomic.AtomicBoolean(false)
    lateinit var callback: ScanCallback

    fun finish(found: Found?) {
      if (!reported.compareAndSet(false, true)) return
      handler.removeCallbacksAndMessages(null)
      try {
        scanner.stopScan(callback)
      } catch (e: SecurityException) {
        // Permission revoked mid-scan; whatever was collected is still valid.
      }
      onFound(found)
    }

    callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        val record = result.scanRecord ?: return
        val advertisesFd50 = record.serviceUuids?.any { it.uuid == SERVICE_FD50 } == true
        val tuyaUuid = tuyaUuidFromManufacturerData(record)
        if (!advertisesFd50 && tuyaUuid == null) return
        val found = Found(result.device, result.rssi, record.deviceName, tuyaUuid, addressTypeOf(result.device))
        matches[result.device.address] = found
        // Waiting out the whole window once the board has already identified itself
        // costs the full timeout on every single connect, and the board is normally
        // seen within the first moment of scanning.
        val identified = (targetUuid != null && found.tuyaUuid == targetUuid) ||
          sameMac(found.device.address, targetMac)
        if (identified) finish(found)
      }

      override fun onScanFailed(errorCode: Int) {
        // Reported to the caller, not just logcat. A refused scan is indistinguishable
        // from an absent board in the app's own log otherwise, and the two have
        // completely different causes.
        val reason = when (errorCode) {
          1 -> "already started"
          2 -> "app registration failed: too many scan clients"
          3 -> "internal error"
          4 -> "feature unsupported"
          5 -> "out of hardware resources"
          6 -> "scanning too often: Android allows about 5 scans per 30s"
          else -> "unknown"
        }
        Log.e(TAG, "scan failed: $errorCode ($reason)")
        onProblem("scan refused by Android: $reason (code $errorCode)")
        finish(null)
      }
    }

    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_FD50)).build()
    try {
      scanner.startScan(
        listOf(filter),
        ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
        callback,
      )
    } catch (e: SecurityException) {
      // Thrown when BLUETOOTH_SCAN has not been granted. As above: report the reason
      // and return false, but do not also call back.
      onProblem("scan blocked: missing Bluetooth permission (${e.message})")
      return false
    }

    onCancelReady { finish(null) }
    handler.postDelayed({
      finish(pick(matches.values.toList(), targetUuid, targetMac))
    }, timeoutMs)
    return true
  }

  /**
   * MAC equality that ignores separators. Android reports `DC:23:52:84:E0:6C` while the
   * value stored alongside the board's keys is unpunctuated, so a literal comparison
   * never matches and the scan falls through to waiting out its whole window. Internal
   * (not private): [BoardWakeScanReceiver] reuses this exact comparison rather than a
   * second, possibly-drifting copy.
   */
  fun sameMac(a: String?, b: String?): Boolean {
    if (a == null || b == null) return false
    return a.replace(":", "").equals(b.replace(":", ""), ignoreCase = true)
  }

  private fun pick(candidates: List<Found>, targetUuid: String?, targetMac: String?): Found? {
    if (candidates.isEmpty()) return null
    if (targetUuid != null) {
      candidates.firstOrNull { it.tuyaUuid == targetUuid }?.let { return it }
    }
    if (targetMac != null) {
      candidates.firstOrNull { sameMac(it.device.address, targetMac) }?.let { return it }
    }
    // No identity match — only safe when there's exactly one board-shaped device nearby.
    return candidates.singleOrNull() ?: candidates.maxByOrNull { it.rssi }
  }

  fun adapter(context: Context): BluetoothAdapter? =
    (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
}
