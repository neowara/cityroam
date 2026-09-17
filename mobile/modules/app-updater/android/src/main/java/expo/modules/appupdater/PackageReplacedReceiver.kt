package expo.modules.appupdater

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import expo.modules.boardble.BoardBleClient
import expo.modules.boardble.BoardCredentialStore
import expo.modules.boardble.BoardSelfHealWorker
import java.util.concurrent.TimeUnit

/**
 * Runs in the **new** version immediately after a self-update installs — `MY_PACKAGE_REPLACED`
 * fires with no Activity on screen and possibly before JS ever starts (see this repo's
 * "Turning on code that has never run" checklist), so every call here is wrapped and
 * permission-checked, never assumed.
 *
 * Also fires on `adb install -r` during development and on every future update, so it
 * must be a harmless no-op whenever there's nothing to re-arm (no board ever paired).
 *
 * WorkManager's own periodic-work registration is Room-DB-backed app-private storage,
 * which an app update does not clear (only an uninstall does), so it should already
 * survive on its own — the re-enqueue below is a defensive, idempotent (`KEEP`) belt on
 * top of that, not the only thing keeping it alive. The BLE wake scan and the board
 * reconnect are different: those live in the Bluetooth stack's own registration, which
 * replacing the package can drop, so they're re-armed unconditionally here by starting
 * the same foreground owner (`RideService`, via [BoardBleClient.foregroundOwner]) the
 * app already uses for every other cold-start-with-no-JS case — its own `onCreate` is
 * what actually re-arms the wake scan and reconnects, this receiver only has to start it.
 */
class PackageReplacedReceiver : BroadcastReceiver() {
  companion object {
    private const val TAG = "AppUpdater"

    // Must match BoardBleModule's own SELF_HEAL_WORK name exactly — re-enqueuing under
    // a different name would leave two periodic jobs registered instead of reaffirming
    // the one that matters.
    private const val SELF_HEAL_WORK = "board_ble_self_heal"

    // The channel expo-notifications creates for every other trip-lifecycle notification
    // in this app (app.json's expo-notifications `defaultChannel`) — reused rather than
    // creating a new one, since by definition this receiver only ever runs on an update,
    // meaning the app (and that channel) already existed before.
    private const val NOTIFICATION_CHANNEL_ID = "trip-lifecycle"
    private const val NOTIFICATION_ID = 9201
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    val appContext = context.applicationContext

    try {
      reArmBoardConnection(appContext)
    } catch (e: Throwable) {
      Log.w(TAG, "could not re-arm board connection after update", e)
    }

    try {
      postUpdatedNotification(appContext)
    } catch (e: Throwable) {
      Log.w(TAG, "could not post the update notification", e)
    }
  }

  private fun reArmBoardConnection(context: Context) {
    // Nothing paired yet — no background layer to re-arm, and starting the foreground
    // service with no board to connect to would just show a notification for nothing.
    if (BoardCredentialStore.load(context) == null) return

    // Same entry point every other no-JS cold start uses; RideService.onCreate() re-arms
    // BoardWakeScan and reconnects to the stored board itself (see its own doc comment).
    BoardBleClient.foregroundOwner?.start(context)

    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
      SELF_HEAL_WORK,
      ExistingPeriodicWorkPolicy.KEEP,
      PeriodicWorkRequestBuilder<BoardSelfHealWorker>(15, TimeUnit.MINUTES).build(),
    )
  }

  private fun postUpdatedNotification(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    // The channel is created by expo-notifications during a normal JS run, not by this
    // native receiver — if it genuinely doesn't exist yet, posting to it would silently
    // no-op on some OEM builds rather than show, so skip rather than create a duplicate
    // channel with different settings than the one the rest of the app already uses.
    if (manager.getNotificationChannel(NOTIFICATION_CHANNEL_ID) == null) return

    val versionName = try {
      context.packageManager.getPackageInfo(context.packageName, 0).versionName
    } catch (e: Exception) {
      null
    }
    val title = if (versionName != null) "Cityroam updated to $versionName" else "Cityroam updated"

    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    val notification = Notification.Builder(context, NOTIFICATION_CHANNEL_ID)
      // A plain system drawable, not an app resource — this module's Gradle project has
      // no link to the app module's R class (same reasoning as RideService's own
      // foreground-notification icon).
      .setSmallIcon(android.R.drawable.stat_sys_download_done)
      .setContentTitle(title)
      .setContentText("Tap to open")
      .setAutoCancel(true)
      .apply { contentIntent?.let(::setContentIntent) }
      .build()

    manager.notify(NOTIFICATION_ID, notification)
  }
}
