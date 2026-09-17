package expo.modules.ridecore

import android.annotation.SuppressLint
import android.content.Context
import android.os.HandlerThread
import android.os.Looper
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * The recording-time location source — `FusedLocationProviderClient` requested
 * directly, delivered on its own `HandlerThread` looper rather than the main/Activity
 * one. That's the actual fix for F1 in the architecture review: expo-location's Android
 * activity-lifecycle listener removes every `watchPositionAsync` request the instant
 * the app backgrounds and re-adds it on foreground return, so it delivers zero fixes
 * while the phone is locked. A request made directly against Fused Location, with
 * nothing tying it to the Activity lifecycle, keeps delivering regardless.
 *
 * No active request exists while idle — this class only runs while a ride is being
 * recorded. Idle-time reconnection/movement detection are separate,
 * system-driven mechanisms, not a location request this class holds open.
 */
class RideLocationManager(context: Context, private val onFix: (RideFix) -> Unit) {
  data class RideFix(val tMs: Long, val lat: Double, val lon: Double, val accM: Float?, val speedMs: Float?, val bearing: Float?, val altM: Double?)

  private val appContext = context.applicationContext
  private val thread = HandlerThread("ride-location").apply { start() }
  private val looper: Looper get() = thread.looper
  private val client: FusedLocationProviderClient by lazy { LocationServices.getFusedLocationProviderClient(appContext) }

  @Volatile private var recording = false

  private val callback = object : LocationCallback() {
    override fun onLocationResult(result: LocationResult) {
      val loc = result.lastLocation ?: return
      onFix(
        RideFix(
          tMs = loc.time,
          lat = loc.latitude,
          lon = loc.longitude,
          accM = if (loc.hasAccuracy()) loc.accuracy else null,
          speedMs = if (loc.hasSpeed()) loc.speed else null,
          bearing = if (loc.hasBearing()) loc.bearing else null,
          altM = if (loc.hasAltitude()) loc.altitude else null,
        )
      )
    }
  }

  /** High-accuracy, ~1.5s cadence — a ride is actually recording, full precision
   * matters and idle-time battery concerns don't apply. Requires
   * ACCESS_FINE_LOCATION (checked by the caller before this is reached). */
  @SuppressLint("MissingPermission")
  fun start() {
    if (recording) return
    recording = true
    val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1_500L)
      .setMinUpdateIntervalMillis(1_000L)
      .setMinUpdateDistanceMeters(0f)
      .setWaitForAccurateLocation(false)
      .setMaxUpdateDelayMillis(0L)
      .build()
    client.requestLocationUpdates(request, callback, looper)
  }

  fun stop() {
    if (!recording) return
    recording = false
    client.removeLocationUpdates(callback)
  }

  fun destroy() {
    stop()
    thread.quitSafely()
  }
}
