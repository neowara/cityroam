package expo.modules.cityroamwidget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT
import android.appwidget.AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH
import android.appwidget.AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT
import android.appwidget.AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.SizeF
import android.widget.RemoteViews
import androidx.core.os.BundleCompat
import org.json.JSONObject
import java.util.Locale

/**
 * Renders the Cityroam home-screen widget from the snapshot persisted by the JS side.
 *
 * The widget is a pure reflection of WidgetSnapshotStore's JSON — it never talks to the
 * board or the JS runtime itself. Live updates arrive as pushes: the JS side calls
 * CityroamWidgetModule.updateSnapshot (which writes the JSON and calls refreshAll), and the
 * system calls onUpdate on a coarse cadence (>=30 min) or when the widget is added, which
 * re-renders the same persisted state. Tapping the widget opens the app.
 *
 * The card itself is one bitmap (WidgetRenderer.render), drawn fresh at each instance's
 * real size and dropped into a single ImageView — see cityroam_widget.xml. There is no size
 * bucketing and no per-font layout file: the renderer's layout math and font selection both
 * read straight off the widget's actual dp size and the snapshot's own font/accent/needle,
 * so every size from a 2x1 tile to a 5x5 slab is one continuous layout, not N discrete
 * ones. Dark/light follows the system setting the same way the pre-redesign widget's
 * values-night qualifier did (WidgetRenderer.render reads Configuration directly).
 */
class CityroamWidgetProvider : AppWidgetProvider() {

  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    val snapshot = WidgetSnapshotStore.load(context)
    for (id in appWidgetIds) appWidgetManager.updateAppWidget(id, buildViews(context, appWidgetManager, id, snapshot))
    scheduleSelfRefresh(context)
  }

  override fun onAppWidgetOptionsChanged(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle?) {
    super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions)
    // The user just resized this instance — re-render it at its new size immediately
    // rather than waiting for the next unrelated push (a BLE event, the 60s self-refresh
    // alarm, or the OS's own 30-min onUpdate) to happen to fire.
    appWidgetManager.updateAppWidget(appWidgetId, buildViews(context, appWidgetManager, appWidgetId, WidgetSnapshotStore.load(context)))
  }

  override fun onEnabled(context: Context) {
    // A widget was added — render immediately from whatever state is persisted so a
    // widget added mid-ride shows the live trip without waiting for the next push.
    WidgetSnapshotStore.refreshAll(context)
    scheduleSelfRefresh(context)
  }

  override fun onDisabled(context: Context) {
    // The last widget instance was removed — stop the self-refresh alarm so it doesn't
    // keep waking the provider (and the process) for a widget that no longer exists.
    cancelSelfRefresh(context)
  }

  override fun onReceive(context: Context, intent: Intent) {
    // Self-refresh alarm: re-render the persisted snapshot on a native cadence so the
    // widget isn't frozen on a stale frame until the app reopens or the OS's coarse
    // updatePeriodMillis (30 min) fires. The JS process may be dead here — this only
    // re-renders what's already persisted (the elapsed clock self-advances from
    // tripStartEpochMs), it never reaches for live data.
    if (intent.action == ACTION_REFRESH) {
      WidgetSnapshotStore.refreshAll(context)
      return
    }
    super.onReceive(context, intent)
  }

  companion object {
    private const val TAG = "CityroamWidget"
    private const val ACTION_REFRESH = "expo.modules.cityroamwidget.REFRESH"

    // The app's deep-link scheme (app.json "scheme": "cityroam"). Used to build the
    // cityroam://trip/<id> URI that opens a saved ride's detail screen from the widget.
    private const val APP_SCHEME = "cityroam"

    // How often the widget re-renders its persisted snapshot on its own, independent of the
    // JS process. The OS updatePeriodMillis floor is 30 min — far too coarse for a live
    // speed/elapsed readout — so an AlarmManager keeps the widget fresh on a native cadence
    // even when the app is backgrounded or dead. During an active ride the JS 1s tick already
    // pushes per-second; this alarm is the fallback that keeps the clock advancing and the
    // view re-rendering when no push can fire.
    private const val SELF_REFRESH_INTERVAL_MS = 60_000L

    /** Schedules the repeating self-refresh alarm. Idempotent — re-scheduling replaces the
     * prior alarm, so it's safe to call from onEnabled and onUpdate. */
    private fun scheduleSelfRefresh(context: Context) {
      val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val pi = refreshPendingIntent(context)
      alarm.setRepeating(
        AlarmManager.RTC,
        System.currentTimeMillis() + SELF_REFRESH_INTERVAL_MS,
        SELF_REFRESH_INTERVAL_MS,
        pi,
      )
    }

    private fun cancelSelfRefresh(context: Context) {
      val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      alarm.cancel(refreshPendingIntent(context))
    }

    private fun refreshPendingIntent(context: Context): PendingIntent {
      val intent = Intent(context, CityroamWidgetProvider::class.java).setAction(ACTION_REFRESH)
      return PendingIntent.getBroadcast(context, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Every distinct dp size the launcher is currently showing this instance at. At most
     * two are kept — each is a full rendered bitmap, and an unbounded map is the one way
     * this bitmap-per-size design could blow RemoteViews' transaction memory budget (a
     * launcher rarely supplies more than a couple anyway).
     *
     * API 31+: read straight off OPTION_APPWIDGET_SIZES when the launcher provides it —
     * it can legitimately be null/empty depending on launcher support, in which case this
     * falls through to the portrait/landscape min/max bundle fields every API level since
     * 26 has always carried. */
    private fun sizesFor(appWidgetManager: AppWidgetManager, appWidgetId: Int): List<SizeF> {
      val options = appWidgetManager.getAppWidgetOptions(appWidgetId)
      if (Build.VERSION.SDK_INT >= 31) {
        val sizes = BundleCompat.getParcelableArrayList(options, AppWidgetManager.OPTION_APPWIDGET_SIZES, SizeF::class.java)
        if (!sizes.isNullOrEmpty()) return sizes.take(2)
      }
      val minW = options.getInt(OPTION_APPWIDGET_MIN_WIDTH, 0)
      val maxW = options.getInt(OPTION_APPWIDGET_MAX_WIDTH, 0)
      val minH = options.getInt(OPTION_APPWIDGET_MIN_HEIGHT, 0)
      val maxH = options.getInt(OPTION_APPWIDGET_MAX_HEIGHT, 0)
      // Portrait: narrow width, tall height. Landscape: wide width, short height. Falls
      // back to a reasonable default (the 4x2 drop size) when the host hasn't reported
      // real dimensions yet — e.g. the very first buildViews call for a freshly-added
      // instance, before any options bundle has landed.
      if (minW <= 0 || maxH <= 0) return listOf(SizeF(330f, 220f))
      return listOfNotNull(
        SizeF(minW.toFloat(), maxH.toFloat()),
        if (maxW > 0 && minH > 0) SizeF(maxW.toFloat(), minH.toFloat()) else null,
      )
    }

    /** Builds the RemoteViews for one widget instance at its current size(s). A single size
     * renders directly into the ImageView; more than one uses the
     * RemoteViews(Map<SizeF, RemoteViews>) constructor so the system picks the right one
     * without waking this process again for a same-orientation resize — but that
     * constructor doesn't exist before API 31 (Build.VERSION_CODES.S), and sizesFor's
     * pre-31 fallback path can legitimately return 2 entries (a launcher that populates
     * both the portrait and landscape min/max bundle fields, an ordinary case, not a rare
     * one) — so the multi-size path is additionally gated on SDK level, not just count,
     * or this throws NoSuchMethodError in-process on exactly that combination. */
    fun buildViews(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int, snapshot: JSONObject?): RemoteViews {
      val sizes = sizesFor(appWidgetManager, appWidgetId)
      if (sizes.size <= 1 || Build.VERSION.SDK_INT < 31) {
        val size = sizes.firstOrNull() ?: SizeF(330f, 220f)
        return buildViewsFor(context, snapshot, size.width, size.height)
      }
      return RemoteViews(sizes.associateWith { buildViewsFor(context, snapshot, it.width, it.height) })
    }

    /** Renders one size variant: the bitmap plus the shared tap target and accessibility
     * text, which don't vary by size. */
    private fun buildViewsFor(context: Context, snapshot: JSONObject?, wDp: Float, hDp: Float): RemoteViews {
      val snap = WidgetSnapshot.fromJson(snapshot)
      val views = RemoteViews(context.packageName, R.layout.cityroam_widget)

      // Defensive: nothing here should be able to crash the app process — updateSnapshot
      // runs in-process, so an uncaught exception here would take the whole app down and,
      // because the snapshot is persisted, keep doing so on every cold start until the
      // underlying bad data is cleared. Falls back to an unrendered (invisible) image
      // rather than a half-drawn bitmap — logged, not silent, so this class of failure is
      // actually visible in adb logcat instead of just showing up as "the widget looks
      // wrong" with no trail to follow.
      try {
        val bitmap = WidgetRenderer.render(context, wDp, hDp, toRenderState(context, snap))
        views.setImageViewBitmap(R.id.widget_canvas, bitmap)
        views.setContentDescription(R.id.widget_canvas, contentDescriptionFor(context, snap))
      } catch (t: Throwable) {
        Log.e(TAG, "render failed — leaving the widget's image view empty", t)
      }

      openPendingIntent(context, snap)?.let { views.setOnClickPendingIntent(R.id.widget_root, it) }
      return views
    }

    /** Flattens the typed snapshot into WidgetRenderer's pure drawing input — every
     * formatting decision (elapsed clock text, WMO weather code -> icon kind, "–" for a
     * field the board hasn't reported) lives here, once, shared by every size this
     * instance renders. */
    internal fun toRenderState(context: Context, snap: WidgetSnapshot): WidgetRenderer.RenderState {
      val kind = when {
        snap.isActive -> WidgetRenderer.RenderState.Kind.LIVE
        snap.hasLastRide -> WidgetRenderer.RenderState.Kind.LAST_RIDE
        else -> WidgetRenderer.RenderState.Kind.EMPTY
      }
      val nowMs = System.currentTimeMillis()
      val efficiency = snap.lastRideBatteryUsedPct?.takeIf { snap.lastRideDistanceKm > 0 }
        ?.let { it / snap.lastRideDistanceKm }
      val elapsed = snap.elapsedSec(nowMs)
      // Null (not 0.0) whenever the live distance itself is unknown, or there's not yet
      // enough elapsed time to divide by — a computed "0.0 km/h average" at trip start
      // looked like a real reading of a ride that hasn't produced one yet.
      val avgKmh: Double? = if (kind == WidgetRenderer.RenderState.Kind.LIVE) {
        snap.distanceKm?.takeIf { elapsed > 0 }?.let { it / (elapsed / 3600.0) }
      } else {
        snap.lastRideAvgSpeedKmh
      }
      return WidgetRenderer.RenderState(
        kind = kind,
        accentColor = parseAccent(snap.accentColor),
        font = snap.font,
        needle = snap.needle,
        containerStyle = snap.containerStyle,
        stateLabel = when (kind) {
          WidgetRenderer.RenderState.Kind.LIVE -> context.getString(snap.state.labelRes)
          WidgetRenderer.RenderState.Kind.LAST_RIDE -> context.getString(R.string.cityroam_state_last_ride)
          WidgetRenderer.RenderState.Kind.EMPTY -> context.getString(R.string.cityroam_state_idle)
        },
        meta = when (kind) {
          WidgetRenderer.RenderState.Kind.LIVE -> WidgetRenderer.formatElapsed(elapsed)
          WidgetRenderer.RenderState.Kind.LAST_RIDE -> WidgetRenderer.formatDate(snap.lastRideEndEpochMs)
          WidgetRenderer.RenderState.Kind.EMPTY -> null
        },
        paused = snap.state == WidgetState.STOPPED,
        weatherTempC = if (kind == WidgetRenderer.RenderState.Kind.LIVE) snap.weatherTempC else snap.lastRideWeatherTempC,
        weatherKind = weatherKindFor(if (kind == WidgetRenderer.RenderState.Kind.LIVE) snap.weatherCode else snap.lastRideWeatherCode),
        speedKmh = snap.currentSpeedKmh,
        distanceKm = if (kind == WidgetRenderer.RenderState.Kind.LIVE) snap.distanceKm else snap.lastRideDistanceKm,
        avgKmh = avgKmh,
        maxKmh = if (kind == WidgetRenderer.RenderState.Kind.LIVE) snap.maxSpeedKmh else snap.lastRideMaxSpeedKmh,
        batteryPct = snap.batteryPct,
        charging = snap.charging == true,
        odometerKm = if (kind == WidgetRenderer.RenderState.Kind.LIVE) snap.odometerKm else snap.lastRideOdometerKm,
        durationText = WidgetRenderer.formatDuration(snap.lastRideDurationSec),
        batteryUsedPct = snap.lastRideBatteryUsedPct,
        efficiency = efficiency,
        stops = snap.lastRideStopsCount,
        modeCost = mapOf(
          "eco" to snap.ecoBatteryPct,
          "ride" to snap.rideBatteryPct,
          "speed" to snap.speedBatteryPct,
          "turbo" to snap.turboBatteryPct,
        ),
      )
    }

    /** A short spoken-form summary of the card — the widget is now a single opaque
     * ImageView, so without this a screen reader would announce nothing at all where the
     * old RemoteViews text tree gave it something per field for free. */
    private fun contentDescriptionFor(context: Context, snap: WidgetSnapshot): String {
      if (snap.isActive) {
        val speed = snap.currentSpeedKmh?.let { String.format(Locale.US, "%.1f km/h", it) } ?: "speed unknown"
        val distance = snap.distanceKm?.let { String.format(Locale.US, "%.2f km", it) } ?: "distance unknown"
        return "${context.getString(snap.state.labelRes)}, $speed, $distance"
      }
      if (snap.hasLastRide) {
        return "Last ride ${WidgetRenderer.formatDate(snap.lastRideEndEpochMs)}, " +
          "${String.format(Locale.US, "%.2f km", snap.lastRideDistanceKm)}, ${WidgetRenderer.formatDuration(snap.lastRideDurationSec)}"
      }
      return context.getString(R.string.cityroam_placeholder)
    }

    /** Maps a WMO weather code (mobile/lib/weather.ts's weatherMeta table) to one of the
     * five condition icon kinds WidgetRenderer knows how to draw — mirrors that table's own
     * grouping (clear / cloudy-ish / rain-ish / snow-ish / thunderstorm). Null (no fetch
     * yet) falls back to "cloud" as a neutral placeholder glyph. */
    private fun weatherKindFor(code: Int?): String = when (code) {
      null -> "cloud"
      0 -> "sun"
      in 1..3, 45, 48 -> "cloud"
      in 51..57, in 61..67, 80, 81, 82 -> "rain"
      in 71..77, 85, 86 -> "snow"
      95, 96, 99 -> "storm"
      else -> "cloud"
    }

    /**
     * The widget's tap target. An idle widget showing a synced last ride opens that
     * trip's detail screen; anything else (a live ride, or a ride with no backend id
     * yet) opens the app's launcher activity.
     *
     * Both go through PendingIntent.getActivity rather than a broadcast this provider
     * then services with its own startActivity call. A manifest receiver starting an
     * activity is subject to Android's background-activity-launch restrictions, which
     * OEM builds enforce more tightly than an AOSP emulator image — an activity
     * PendingIntent has no such problem, because the launcher starts it under its own
     * foreground privileges. The deep link is also pinned with setPackage so it resolves
     * to this app rather than whatever else might claim the scheme.
     *
     * The request code varies with the target: PendingIntent identity ignores extras but
     * a stale cached instance would still be reused for a same-shaped intent, so a
     * distinct code per trip (plus FLAG_UPDATE_CURRENT) keeps the tap pointed at the ride
     * currently on screen.
     */
    private fun openPendingIntent(context: Context, snap: WidgetSnapshot): PendingIntent? {
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      val tripId = snap.lastRideTripId
      if (!snap.isActive && tripId != null) {
        val deepLink = Intent(Intent.ACTION_VIEW, Uri.parse("$APP_SCHEME://trip/$tripId")).apply {
          setPackage(context.packageName)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        }
        if (deepLink.resolveActivity(context.packageManager) != null) {
          return PendingIntent.getActivity(context, tripId.toInt(), deepLink, flags)
        }
        Log.w(TAG, "no activity resolves the trip deep link — falling back to the launcher")
      }
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      return PendingIntent.getActivity(context, 0, launch, flags)
    }

    /** Parses the pushed accent hex (e.g. "#f5793a"); falls back to the default accent.
     * Catches Throwable, not just IllegalArgumentException: an empty string (the
     * WidgetSnapshot default before any real snapshot has ever been pushed — e.g. right
     * after the widget is first added, before the JS side's first push lands) makes
     * Color.parseColor throw StringIndexOutOfBoundsException instead, which isn't an
     * IllegalArgumentException and would otherwise escape this function and abort the
     * whole render call in buildViewsFor's try block before anything gets drawn. */
    private fun parseAccent(hex: String): Int =
      try {
        Color.parseColor(hex)
      } catch (_: Throwable) {
        DEFAULT_ACCENT
      }

    // Ember — mirrors mobile/lib/theme.tsx's ACCENT_COLORS.orange, the app-wide default.
    private val DEFAULT_ACCENT = Color.parseColor("#f5793a")
  }
}
