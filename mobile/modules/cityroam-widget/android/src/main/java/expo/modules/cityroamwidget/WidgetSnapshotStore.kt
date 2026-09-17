package expo.modules.cityroamwidget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Persists the latest widget snapshot (written by the JS side via
 * CityroamWidgetModule.updateSnapshot) and re-renders every live widget instance from it.
 *
 * The snapshot is a flat JSON object of primitives only — RemoteViews-friendly and
 * readable by CityroamWidgetProvider without waking the JS runtime. It lives in
 * SharedPreferences so it survives process death: a widget added or refreshed while the
 * app process is dead still renders the last-known state instead of going blank.
 */
object WidgetSnapshotStore {
  private const val TAG = "CityroamWidget"
  private const val PREFS = "cityroam_widget_state"
  private const val KEY_SNAPSHOT = "snapshot"

  fun save(context: Context, json: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SNAPSHOT, json).apply()
  }

  fun load(context: Context): JSONObject? {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SNAPSHOT, null) ?: return null
    return try {
      JSONObject(raw)
    } catch (e: Exception) {
      Log.w(TAG, "persisted snapshot is corrupt JSON — treating as absent", e)
      null
    }
  }

  /** Re-renders every live instance of the widget from the persisted snapshot. Logged on
   * failure (adb logcat -s CityroamWidget) — this call runs on every JS push, the 60s native
   * self-refresh alarm, and every OS onUpdate, so a failure here is otherwise invisible:
   * the app process never crashes (AppWidgetManager.updateAppWidget delivers the RemoteViews
   * to the launcher's process asynchronously), and the JS side has no way to observe a
   * launcher-side apply failure at all. */
  fun refreshAll(context: Context) {
    val manager = AppWidgetManager.getInstance(context)
    val ids = manager.getAppWidgetIds(ComponentName(context, CityroamWidgetProvider::class.java))
    if (ids.isEmpty()) return
    // Each instance renders at its own current size (buildViews reads it per id via
    // AppWidgetManager.getAppWidgetOptions) — sizes can differ across instances, so this
    // can no longer build one RemoteViews and fan it out to every id.
    val snapshot = load(context)
    for (id in ids) {
      try {
        manager.updateAppWidget(id, CityroamWidgetProvider.buildViews(context, manager, id, snapshot))
      } catch (t: Throwable) {
        Log.e(TAG, "refreshAll failed to update widget instance $id", t)
      }
    }
  }
}
