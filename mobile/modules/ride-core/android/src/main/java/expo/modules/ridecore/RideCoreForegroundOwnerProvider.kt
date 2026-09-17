package expo.modules.ridecore

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import expo.modules.boardble.BoardBleClient

/**
 * Registers [RideService] as [BoardBleClient.ForegroundOwner] the moment this process
 * starts — including a fully headless process with no Activity and no JS/Expo bridge
 * ever booted, which is exactly the case `BoardSelfHealWorker` (a WorkManager job) and
 * `BoardWakeScanReceiver` (a system-delivered broadcast) run in. Both live in the
 * board-ble module, which cannot reference `RideService` directly (`ride-core` depends
 * on `board-ble`, not the other way around — see [BoardBleClient.ForegroundOwner]'s own
 * doc comment for why that rules out a plain cross-module call).
 *
 * A manifest-declared `ContentProvider` is the standard way to get that guarantee
 * without any app-level wiring: the system instantiates every declared provider and
 * calls its `onCreate()` before any other component in that process runs, the same
 * mechanism WorkManager's and Firebase's own auto-init rely on.
 */
class RideCoreForegroundOwnerProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    BoardBleClient.foregroundOwner = object : BoardBleClient.ForegroundOwner {
      override fun start(context: Context) = RideService.start(context)
    }
    return true
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
