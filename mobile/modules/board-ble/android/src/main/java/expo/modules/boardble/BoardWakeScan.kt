package expo.modules.boardble

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.ParcelUuid
import android.util.Log

/**
 * A `PendingIntent`-based BLE scan for the board, registered with the system rather
 * than run in-process — confirmed against developer.android.com's own
 * `BluetoothLeScanner.startScan(List, ScanSettings, PendingIntent)` reference: *"Use
 * this method of scanning if your process is not always running and it should be
 * started when scan results are available."* This is what closes the gap the other two
 * self-heal layers (docs/adr/0005) can't: both of those need the process to already
 * exist (a native `Worker`, a JS `BackgroundTask`) to run at all. This scan survives
 * the process being killed outright, because the system — not this app — holds it, and
 * delivers results via an explicit broadcast to [BoardWakeScanReceiver], which is
 * exempt from the implicit-broadcast manifest-receiver restrictions introduced in
 * Android 8 precisely because it targets a specific component.
 *
 * Deliberately NOT armed/disarmed around every individual connect/disconnect — it
 * stays registered for as long as background reconnection is wanted at all (armed
 * alongside the connection foreground service/the WorkManager self-heal in
 * `startBackgroundReconnect`, disarmed alongside them in `stopBackgroundReconnect`).
 * The board stops advertising once genuinely connected, so an armed scan sitting idle
 * next to a live connection matches nothing and costs nothing extra; toggling
 * registration on every state change would only add churn against Android's own
 * scan-start throttling (~5 scans per 30s) for no benefit. The window this doesn't
 * cover for free is while the board is in range but not yet connected — the board is
 * still advertising then, so this scan can keep matching and re-delivering on nearly
 * every advertisement for as long as that lasts. [BoardWakeScanReceiver] bails out
 * early once any client already exists rather than relying on staying armed being
 * free in that window too.
 *
 * Filtered by the FD50 service UUID only, never by MAC address: the public
 * `ScanFilter.Builder.setDeviceAddress` always assumes a public address type, and the
 * framework classifies a non-public address type in an address filter as requiring
 * `BLUETOOTH_PRIVILEGED` — not available to a normal app (confirmed against the
 * `startScan` reference's own permission block). The receiver matches the MAC itself
 * once a result arrives, same as the foreground scan path in [BoardScanner].
 */
object BoardWakeScan {
  private const val TAG = "BoardBle"

  // Fixed and reused for both start and stop — stopScan(PendingIntent) requires "the
  // PendingIntent that was used to start the scan" (matched by request code + intent
  // filterEquals, not by object identity), so start/arm and stop/disarm must both
  // build from the exact same (context, requestCode, Intent) triple.
  private const val REQUEST_CODE = 0xB1E

  @SuppressLint("MissingPermission") // caller (startBackgroundReconnect) already holds BLUETOOTH_SCAN by the time this runs
  fun arm(context: Context): Boolean {
    if (!hasPermissions(context)) {
      Log.w(TAG, "wake scan not armed — missing BLUETOOTH_SCAN or ACCESS_FINE_LOCATION")
      return false
    }
    val scanner = scanner(context) ?: return false
    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(BoardScanner.SERVICE_FD50)).build()
    // LOW_POWER: this scan is meant to sit registered indefinitely, not to resolve
    // quickly — SCAN_MODE_LOW_LATENCY is for the foreground, time-bounded scan in
    // BoardScanner.findBoard, a different job with a different cost profile.
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_POWER).build()
    // Never null with create=true (FLAG_UPDATE_CURRENT, not FLAG_NO_CREATE) — getBroadcast
    // always returns a token in that mode.
    val status = try {
      scanner.startScan(listOf(filter), settings, pendingIntent(context, create = true)!!)
    } catch (e: SecurityException) {
      Log.w(TAG, "wake scan arm refused", e)
      return false
    }
    if (status != 0) {
      Log.w(TAG, "wake scan arm failed (status $status)")
      return false
    }
    Log.i(TAG, "wake scan armed")
    return true
  }

  @SuppressLint("MissingPermission")
  fun disarm(context: Context) {
    val scanner = scanner(context) ?: return
    val pending = pendingIntent(context, create = false) ?: return
    try {
      scanner.stopScan(pending)
    } catch (e: SecurityException) {
      Log.w(TAG, "wake scan disarm refused", e)
    }
    pending.cancel()
    Log.i(TAG, "wake scan disarmed")
  }

  private fun scanner(context: Context) =
    (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter?.bluetoothLeScanner

  private fun hasPermissions(context: Context): Boolean {
    val scanGranted = context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
    val locationGranted = context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    return scanGranted && locationGranted
  }

  /**
   * `create = false` uses `FLAG_NO_CREATE`, returning null rather than a fresh token if
   * nothing is currently armed — the documented way to check "is a scan registered?"
   * without holding any state of our own (which wouldn't survive the process dying
   * anyway, the exact case this whole mechanism exists for).
   */
  private fun pendingIntent(context: Context, create: Boolean): PendingIntent? {
    val intent = Intent(context, BoardWakeScanReceiver::class.java)
    // FLAG_MUTABLE: required — the framework fills the scan-result extras into this
    // intent at delivery time, which an immutable PendingIntent would silently drop.
    // Legal at API 34+ specifically because the wrapped Intent names an explicit
    // component (BoardWakeScanReceiver::class.java), not because of anything set here.
    val baseFlags = PendingIntent.FLAG_MUTABLE
    val flags = if (create) baseFlags or PendingIntent.FLAG_UPDATE_CURRENT else baseFlags or PendingIntent.FLAG_NO_CREATE
    return PendingIntent.getBroadcast(context, REQUEST_CODE, intent, flags)
  }
}
