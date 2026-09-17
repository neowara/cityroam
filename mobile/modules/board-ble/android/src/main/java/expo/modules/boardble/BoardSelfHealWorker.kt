package expo.modules.boardble

import android.content.Context
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * Re-asserts the board connection's foreground service (`RideService`, in the
 * ride-core module — see [BoardBleClient.ForegroundOwner]) periodically, entirely in
 * native code.
 *
 * The React runtime can be dead for long stretches: Android kills the process under
 * memory pressure, or an OEM battery manager does. START_STICKY brings the bare service
 * back, but nothing re-primes a connection in the new process, and the user should not
 * have to reopen the app for their board to work.
 *
 * WorkManager is re-scheduled by the OS across process death and reboot, unlike an
 * in-memory timer, so this runs regardless. Starting the service is idempotent, making
 * this a no-op whenever the connection is already healthy.
 */
class BoardSelfHealWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    if (BoardCredentialStore.load(applicationContext) == null) return Result.success()
    try {
      BoardBleClient.foregroundOwner?.start(applicationContext)
    } catch (e: Throwable) {
      // A Worker with no visible UI is not exempt from Android 12+'s restriction on
      // starting a foreground service from the background, and that restriction bites
      // in exactly the scenario this worker exists for. Logged rather than thrown so
      // the worker survives to retry on its next tick — which is not a guarantee it
      // will succeed, since "no visible UI" is usually still true then.
      Log.e("BoardSelfHeal", "could not start the board connection service", e)
    }
    return Result.success()
  }
}
