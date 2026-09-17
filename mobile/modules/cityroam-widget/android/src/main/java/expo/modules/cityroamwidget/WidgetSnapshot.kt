package expo.modules.cityroamwidget

import org.json.JSONObject

/**
 * Typed view of the flat JSON snapshot the JS side pushes (see widgetSync.ts). Centralizes
 * the field names and the state-string vocabulary in one place so the Kotlin side never
 * hand-parses the schema or switches on raw state strings in more than one spot.
 *
 * The snapshot is a pure reflection of the recorder + BLE session + the app's appearance
 * settings; this model only reads it. It never talks to the board or the JS runtime.
 *
 * Two rendering states share one model:
 *  * Live trip (RIDING/STOPPED/MANUAL) — hero is current speed, stats are the live ride.
 *  * Idle — hero and stats come from the last completed ride, captured at trip-finalize
 *    time (the widget can't reach the backend, so the JS side persists the summary here).
 *    When no ride has ever finished, the provider shows a placeholder instead.
 */
data class WidgetSnapshot(
  val state: WidgetState,
  val tripStartEpochMs: Long,
  val elapsedSec: Long,
  val currentSpeedKmh: Double?,
  // Board telemetry (dp2's running totals), nullable like currentSpeedKmh — null while
  // the board isn't genuinely reporting this session (mobile/lib/widgetSync.ts's
  // boardIsReporting), not just defaulted to 0.
  val distanceKm: Double?,
  val maxSpeedKmh: Double?,
  val batteryPct: Int?,
  val charging: Boolean?,
  val online: Boolean?,
  val mode: String?,
  // Board lifetime odometer (dp12), live-only — null unless the board has genuinely
  // reported this session (see widgetSync.ts's liveOdometerKm / boardIsReporting).
  val odometerKm: Double?,
  // Last completed ride (idle state). hasLastRide gates whether the idle view renders
  // real data or the placeholder.
  val hasLastRide: Boolean,
  val lastRideDistanceKm: Double,
  val lastRideDurationSec: Long,
  val lastRideMaxSpeedKmh: Double,
  val lastRideAvgSpeedKmh: Double,
  val lastRideBatteryUsedPct: Int?,
  val lastRideEndEpochMs: Long,
  val lastRideStopsCount: Int,
  // Backend trip id for the idle tap-through to /trip/<id>; null when the ride never
  // synced (tap falls back to the launcher).
  val lastRideTripId: Long?,
  // Everything below is that specific ride's own saved record (mobile/lib/widgetExtras.ts's
  // fetchAndCacheTripExtras) — GET /trips/<id> + /trips/<id>/by-mode, not live GPS/BLE
  // data. Null per field until that fetch resolves.
  val lastRideOdometerKm: Double?,
  val lastRideWeatherTempC: Double?,
  val lastRideWeatherWindMs: Double?,
  // WMO weather code (mobile/lib/weather.ts's weatherMeta table) — picks the widget's
  // condition icon (sun/cloud/rain/snow/storm) instead of one generic weather glyph.
  val lastRideWeatherCode: Int?,
  val ecoBatteryPct: Double?,
  val rideBatteryPct: Double?,
  val speedBatteryPct: Double?,
  val turboBatteryPct: Double?,
  // Live-state-only hero weather badge — the one genuinely live data point in this
  // model, matching the live-ride widget's own nature. Null while idle (the idle badge
  // uses lastRideWeatherTempC above instead) or before the first fetch lands.
  val weatherTempC: Double?,
  val weatherWindMs: Double?,
  val weatherCode: Int?,
  // Appearance, mirroring the widget's own independent settings (widgetAppearance.ts).
  val accentColor: String,
  val font: String,
  // "accent" | "ink" — see widgetAppearance.ts's WidgetNeedleChoice.
  val needle: String,
  // "matte" | "glass" — see widgetAppearance.ts's WidgetAppearance.containerStyle.
  val containerStyle: String,
) {
  /** True while a trip is live (recording, paused, or manual) — drives the speed/max rows. */
  val isActive: Boolean
    get() = state != WidgetState.IDLE

  /** Elapsed seconds to display, self-advancing from wall-clock while a trip is active so
   * the clock keeps ticking even if the JS process died mid-ride. Mirrors how the recorder
   * derives elapsedSec from tripStartMs. */
  fun elapsedSec(nowMs: Long): Long =
    if (state != WidgetState.IDLE && tripStartEpochMs > 0) (nowMs - tripStartEpochMs) / 1000 else elapsedSec

  companion object {
    /** Field names as produced by widgetSync.ts. Keep in sync with that producer. */
    object Field {
      const val STATE = "state"
      const val TRIP_START_EPOCH_MS = "tripStartEpochMs"
      const val ELAPSED_SEC = "elapsedSec"
      const val CURRENT_SPEED_KMH = "currentSpeedKmh"
      const val DISTANCE_KM = "distanceKm"
      const val MAX_SPEED_KMH = "maxSpeedKmh"
      const val BATTERY_PCT = "batteryPct"
      const val CHARGING = "charging"
      const val ONLINE = "online"
      const val MODE = "mode"
      const val ODOMETER_KM = "odometerKm"
      const val HAS_LAST_RIDE = "hasLastRide"
      const val LAST_RIDE_DISTANCE_KM = "lastRideDistanceKm"
      const val LAST_RIDE_DURATION_SEC = "lastRideDurationSec"
      const val LAST_RIDE_MAX_SPEED_KMH = "lastRideMaxSpeedKmh"
      const val LAST_RIDE_AVG_SPEED_KMH = "lastRideAvgSpeedKmh"
      const val LAST_RIDE_BATTERY_USED_PCT = "lastRideBatteryUsedPct"
      const val LAST_RIDE_END_EPOCH_MS = "lastRideEndEpochMs"
      const val LAST_RIDE_STOPS_COUNT = "lastRideStopsCount"
      const val LAST_RIDE_TRIP_ID = "lastRideTripId"
      const val LAST_RIDE_ODOMETER_KM = "lastRideOdometerKm"
      const val LAST_RIDE_WEATHER_TEMP_C = "lastRideWeatherTempC"
      const val LAST_RIDE_WEATHER_WIND_MS = "lastRideWeatherWindMs"
      const val LAST_RIDE_WEATHER_CODE = "lastRideWeatherCode"
      const val ECO_BATTERY_PCT = "ecoBatteryPct"
      const val RIDE_BATTERY_PCT = "rideBatteryPct"
      const val SPEED_BATTERY_PCT = "speedBatteryPct"
      const val TURBO_BATTERY_PCT = "turboBatteryPct"
      const val WEATHER_TEMP_C = "weatherTempC"
      const val WEATHER_WIND_MS = "weatherWindMs"
      const val WEATHER_CODE = "weatherCode"
      const val ACCENT_COLOR = "accentColor"
      const val FONT = "font"
      const val NEEDLE = "needle"
      const val CONTAINER_STYLE = "containerStyle"
    }

    fun fromJson(json: JSONObject?): WidgetSnapshot {
      if (json == null) return WidgetSnapshot(
        state = WidgetState.IDLE,
        tripStartEpochMs = 0L,
        elapsedSec = 0L,
        currentSpeedKmh = null,
        distanceKm = null,
        maxSpeedKmh = null,
        batteryPct = null,
        charging = null,
        online = null,
        mode = null,
        odometerKm = null,
        hasLastRide = false,
        lastRideDistanceKm = 0.0,
        lastRideDurationSec = 0L,
        lastRideMaxSpeedKmh = 0.0,
        lastRideAvgSpeedKmh = 0.0,
        lastRideBatteryUsedPct = null,
        lastRideEndEpochMs = 0L,
        lastRideStopsCount = 0,
        lastRideTripId = null,
        lastRideOdometerKm = null,
        lastRideWeatherTempC = null,
        lastRideWeatherWindMs = null,
        lastRideWeatherCode = null,
        ecoBatteryPct = null,
        rideBatteryPct = null,
        speedBatteryPct = null,
        turboBatteryPct = null,
        weatherTempC = null,
        weatherWindMs = null,
        weatherCode = null,
        accentColor = "",
        font = "dash",
        needle = "accent",
        containerStyle = "matte",
      )
      return WidgetSnapshot(
        state = WidgetState.fromJson(json.optString(Field.STATE)),
        tripStartEpochMs = json.optLong(Field.TRIP_START_EPOCH_MS, 0L),
        elapsedSec = json.optLong(Field.ELAPSED_SEC, 0L),
        currentSpeedKmh = optDoubleOrNull(json, Field.CURRENT_SPEED_KMH),
        distanceKm = optDoubleOrNull(json, Field.DISTANCE_KM),
        maxSpeedKmh = optDoubleOrNull(json, Field.MAX_SPEED_KMH),
        batteryPct = optIntOrNull(json, Field.BATTERY_PCT),
        charging = if (json.has(Field.CHARGING) && !json.isNull(Field.CHARGING)) json.optBoolean(Field.CHARGING) else null,
        online = if (json.has(Field.ONLINE) && !json.isNull(Field.ONLINE)) json.optBoolean(Field.ONLINE) else null,
        mode = json.optString(Field.MODE, null)?.takeIf { it.isNotBlank() && it != "null" },
        odometerKm = optDoubleOrNull(json, Field.ODOMETER_KM),
        hasLastRide = json.optBoolean(Field.HAS_LAST_RIDE, false),
        lastRideDistanceKm = json.optDouble(Field.LAST_RIDE_DISTANCE_KM, 0.0),
        lastRideDurationSec = json.optLong(Field.LAST_RIDE_DURATION_SEC, 0L),
        lastRideMaxSpeedKmh = json.optDouble(Field.LAST_RIDE_MAX_SPEED_KMH, 0.0),
        lastRideAvgSpeedKmh = json.optDouble(Field.LAST_RIDE_AVG_SPEED_KMH, 0.0),
        lastRideBatteryUsedPct = optIntOrNull(json, Field.LAST_RIDE_BATTERY_USED_PCT),
        lastRideEndEpochMs = json.optLong(Field.LAST_RIDE_END_EPOCH_MS, 0L),
        lastRideStopsCount = json.optInt(Field.LAST_RIDE_STOPS_COUNT, 0),
        lastRideTripId = if (json.has(Field.LAST_RIDE_TRIP_ID) && !json.isNull(Field.LAST_RIDE_TRIP_ID)) json.optLong(Field.LAST_RIDE_TRIP_ID) else null,
        lastRideOdometerKm = optDoubleOrNull(json, Field.LAST_RIDE_ODOMETER_KM),
        lastRideWeatherTempC = optDoubleOrNull(json, Field.LAST_RIDE_WEATHER_TEMP_C),
        lastRideWeatherWindMs = optDoubleOrNull(json, Field.LAST_RIDE_WEATHER_WIND_MS),
        lastRideWeatherCode = optIntOrNull(json, Field.LAST_RIDE_WEATHER_CODE),
        ecoBatteryPct = optDoubleOrNull(json, Field.ECO_BATTERY_PCT),
        rideBatteryPct = optDoubleOrNull(json, Field.RIDE_BATTERY_PCT),
        speedBatteryPct = optDoubleOrNull(json, Field.SPEED_BATTERY_PCT),
        turboBatteryPct = optDoubleOrNull(json, Field.TURBO_BATTERY_PCT),
        weatherTempC = optDoubleOrNull(json, Field.WEATHER_TEMP_C),
        weatherWindMs = optDoubleOrNull(json, Field.WEATHER_WIND_MS),
        weatherCode = optIntOrNull(json, Field.WEATHER_CODE),
        accentColor = json.optString(Field.ACCENT_COLOR, ""),
        font = json.optString(Field.FONT, "dash"),
        needle = json.optString(Field.NEEDLE, "accent"),
        containerStyle = json.optString(Field.CONTAINER_STYLE, "matte"),
      )
    }

    private fun optIntOrNull(json: JSONObject, key: String): Int? =
      if (json.has(key) && !json.isNull(key)) json.optInt(key) else null

    private fun optDoubleOrNull(json: JSONObject, key: String): Double? =
      if (json.has(key) && !json.isNull(key)) json.optDouble(key) else null
  }
}

/** The trip states the widget can render, matching the recorder's TripState vocabulary.
 * Dot/label colour is WidgetRenderer's call now (it draws the whole card), not a resource
 * lookup — labelRes stays since the label text itself is still a real string resource. */
enum class WidgetState(
  val labelRes: Int,
) {
  IDLE(R.string.cityroam_state_idle),
  RIDING(R.string.cityroam_state_recording),
  STOPPED(R.string.cityroam_state_paused),
  MANUAL(R.string.cityroam_state_manual);

  companion object {
    fun fromJson(raw: String): WidgetState = when (raw) {
      "riding" -> RIDING
      "stopped" -> STOPPED
      "manual" -> MANUAL
      else -> IDLE
    }
  }
}
