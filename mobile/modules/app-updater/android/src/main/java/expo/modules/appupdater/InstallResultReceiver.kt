package expo.modules.appupdater

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import androidx.core.content.IntentCompat

/**
 * Receives the outcome of a `PackageInstaller` session committed by
 * [AppUpdaterModule.installApk] — registered as this `PendingIntent`'s target component,
 * not reached through any module instance (see [InstallStatusRegistry]'s own doc
 * comment). `android:exported="false"` is correct here for the same reason
 * `BoardWakeScanReceiver` documents its own: the system delivers this directly, on this
 * app's own behalf, never from another app.
 */
class InstallResultReceiver : BroadcastReceiver() {
  companion object {
    private const val TAG = "AppUpdater"
  }

  override fun onReceive(context: Context, intent: Intent) {
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, InstallStatusMapping.STATUS_PENDING_USER_ACTION - 1)
    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""

    when (status) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirmIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
        } else {
          @Suppress("DEPRECATION")
          intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
        if (confirmIntent != null) {
          try {
            confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(confirmIntent)
          } catch (e: Exception) {
            Log.w(TAG, "could not launch the system install-confirmation screen", e)
          }
        } else {
          Log.w(TAG, "STATUS_PENDING_USER_ACTION with no EXTRA_INTENT to launch")
        }
        InstallStatusRegistry.listener?.invoke(InstallOutcome.PendingUserAction)
      }
      PackageInstaller.STATUS_SUCCESS -> {
        Log.i(TAG, "install session succeeded — process will likely be replaced shortly")
        InstallStatusRegistry.listener?.invoke(InstallOutcome.Success)
      }
      else -> {
        val code = InstallStatusMapping.nameFor(status)
        Log.w(TAG, "install session failed: $code ($message)")
        InstallStatusRegistry.listener?.invoke(InstallOutcome.Failure(code, message))
      }
    }
  }
}
