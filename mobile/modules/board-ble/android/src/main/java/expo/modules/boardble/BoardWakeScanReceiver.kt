package expo.modules.boardble

import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanResult
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Receives [BoardWakeScan]'s armed scan results — including, per Android's own
 * documented intent for this API, after the app's process has been killed outright.
 * `android:exported="false"` in the manifest is correct and sufficient: this is an
 * explicit broadcast the system sends to this specific component on the app's own
 * behalf, not a public one other apps could trigger.
 */
class BoardWakeScanReceiver : BroadcastReceiver() {
  companion object {
    private const val TAG = "BoardBle"
  }

  override fun onReceive(context: Context, intent: Intent) {
    val errorCode = intent.getIntExtra(BluetoothLeScanner.EXTRA_ERROR_CODE, -1)
    if (errorCode != -1) {
      Log.w(TAG, "wake scan delivered an error ($errorCode)")
      return
    }
    val results: List<ScanResult> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableArrayListExtra(BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT, ScanResult::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableArrayListExtra(BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT)
    } ?: emptyList()
    if (results.isEmpty()) return

    // The app process is alive and already has a client for some board — the wake
    // scan's entire purpose is recovering from a killed process with no client at
    // all, so its job here is already done. Skipping before the credential-store
    // load and MAC comparison below matters: while the board is in range but not yet
    // connected, this receiver can fire on nearly every advertisement, and letting
    // each one do real work is main-thread contention against the foreground
    // scan/connect this receiver has no reason to compete with.
    if (BoardBleClient.activeClients.isNotEmpty()) return

    // The scan itself is filtered by FD50 service UUID only (see BoardWakeScan's own
    // comment on why it can't filter by MAC), so any board-shaped device — not
    // necessarily the rider's own — can trigger this receiver. Match the stored
    // credentials' MAC here, the same comparison BoardScanner's own picker uses, before
    // waking anything. A record with no MAC yet (never learned) falls through to
    // starting anyway, matching the pre-first-connect state the credential store can be
    // in.
    val storedMac = BoardCredentialStore.load(context.applicationContext)?.mac
    val matches = storedMac.isNullOrEmpty() || results.any { BoardScanner.sameMac(it.device.address, storedMac) }
    if (!matches) {
      Log.d(TAG, "wake scan saw a board-shaped device that isn't the paired one — ignoring")
      return
    }

    Log.i(TAG, "wake scan saw the board (${results.size} result(s)) — starting the connection service")
    // goAsync() extends this receiver's lifetime past onReceive() returning, since
    // the foreground owner's start() can throw (caught inside it) and this must not
    // race the process being suspended again the instant onReceive returns.
    val pending = goAsync()
    try {
      BoardBleClient.foregroundOwner?.start(context.applicationContext)
    } catch (e: Throwable) {
      Log.w(TAG, "could not start the connection service from the wake scan", e)
    } finally {
      pending.finish()
    }
  }
}
