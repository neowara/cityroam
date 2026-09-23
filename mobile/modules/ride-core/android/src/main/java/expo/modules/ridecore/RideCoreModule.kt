package expo.modules.ridecore

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS surface for the native ride journal — read-only from JS's side (the journal is
 * written exclusively by [RideService], off the BLE/GPS callbacks, never from a JS
 * call). See RideService's own doc comment for this module's current scope: a
 * durable, independent capture backstop and, since ADR 0006, the app's
 * route source — not the app's save/upload pipeline, which stays JS-owned.
 */
class RideCoreModule : Module() {
  private val journal by lazy { RideJournal(appContext.reactContext ?: throw IllegalStateException("no context")) }

  override fun definition() = ModuleDefinition {
    Name("RideCore")

    Function("start") {
      appContext.reactContext?.let { RideService.start(it) }
    }

    Function("stop") {
      appContext.reactContext?.let { RideService.stop(it) }
    }

    Function("isRunning") {
      RideService.isRunning()
    }

    Function("hasLocationForeground") {
      RideService.locationForeground
    }

    Function("getStitchWindowMs") {
      RideService.stitchWindowMs
    }

    Function("setStitchWindowMs") { ms: Double ->
      RideService.stitchWindowMs = ms.toLong()
    }

    Function("getActiveRide") {
      journal.activeRide()?.let { rideToMap(it) }
    }

    Function("getRideLastActivityMs") { rideId: Double ->
      journal.lastActivityMs(rideId.toLong())?.toDouble()
    }

    Function("listFinishedRides") {
      journal.listUnuploaded().map { rideToMap(it) }
    }

    Function("getRide") { rideId: Double ->
      journal.getRide(rideId.toLong())?.let { rideToMap(it) }
    }

    Function("getRideSamples") { rideId: Double ->
      val id = rideId.toLong()
      mapOf(
        "gps" to journal.getGpsPoints(id).map {
          mapOf("tMs" to it.tMs, "lat" to it.lat, "lon" to it.lon, "accM" to it.accM, "speedMs" to it.speedMs, "bearing" to it.bearing, "altM" to it.altM)
        },
        "board" to journal.getBoardSamples(id).map {
          mapOf(
            "tMs" to it.tMs,
            "speedKmh" to it.speedKmh,
            "batteryPct" to it.batteryPct,
            "voltageV" to it.voltageV,
            "mode" to it.mode,
            "odoKm" to it.odoKm,
            "rideTimeOnceS" to it.rideTimeOnceS,
            "mileageOnceKm" to it.mileageOnceKm,
          )
        },
        "events" to journal.getEvents(id).map { mapOf("tMs" to it.tMs, "kind" to it.kind, "detail" to it.detail) },
      )
    }

    Function("markRideUploaded") { rideId: Double, backendId: Double? ->
      journal.markUploaded(rideId.toLong(), backendId?.toLong())
    }
  }

  private fun rideToMap(row: RideJournal.RideRow): Map<String, Any?> = mapOf(
    "id" to row.id,
    "startMs" to row.startMs,
    "endMs" to row.endMs,
    "state" to row.state,
    "wasManual" to row.wasManual,
    "odoStartKm" to row.odoStartKm,
    "odoEndKm" to row.odoEndKm,
    "batteryStartPct" to row.batteryStartPct,
    "batteryEndPct" to row.batteryEndPct,
    "distanceKm" to row.distanceKm,
    "maxSpeedKmh" to row.maxSpeedKmh,
    "endReason" to row.endReason,
    "backendId" to row.backendId,
    "devId" to row.devId,
  )
}
