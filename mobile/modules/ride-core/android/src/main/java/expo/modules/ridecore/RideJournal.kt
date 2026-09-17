package expo.modules.ridecore

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * The durability layer capture actually depends on — every GPS fix and board sample is
 * written here as it arrives, natively, independent of whether the JS runtime exists.
 * Plain `SQLiteOpenHelper` (no Room/KSP): this module needs exactly four tables and a
 * handful of queries, and framework SQLite needs no extra Gradle/annotation-processor
 * wiring, which matters given nothing here has ever been built against this Expo
 * module's Gradle setup before.
 *
 * WAL mode so a concurrent read (JS asking for a finished ride's samples) never blocks
 * an in-progress write (a new GPS fix landing mid-ride).
 */
class RideJournal(context: Context) : SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {
  companion object {
    private const val DB_NAME = "ride_journal.db"
    private const val DB_VERSION = 1

    // ride.state values.
    const val STATE_OPEN = "open"
    const val STATE_FINISHED = "finished"
    const val STATE_UPLOADED = "uploaded"
  }

  override fun onConfigure(db: SQLiteDatabase) {
    super.onConfigure(db)
    db.enableWriteAheadLogging()
  }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      """
      CREATE TABLE rides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER,
        state TEXT NOT NULL,
        was_manual INTEGER NOT NULL DEFAULT 0,
        odo_start_km REAL,
        odo_end_km REAL,
        battery_start_pct REAL,
        battery_end_pct REAL,
        distance_km REAL,
        max_speed_kmh REAL,
        end_reason TEXT,
        stitch_until_ms INTEGER,
        backend_id INTEGER
      )
      """.trimIndent()
    )
    db.execSQL(
      "CREATE TABLE gps (id INTEGER PRIMARY KEY AUTOINCREMENT, ride_id INTEGER NOT NULL, " +
        "t_ms INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, acc_m REAL, " +
        "speed_ms REAL, bearing REAL, alt_m REAL)"
    )
    db.execSQL(
      "CREATE TABLE board (id INTEGER PRIMARY KEY AUTOINCREMENT, ride_id INTEGER NOT NULL, " +
        "t_ms INTEGER NOT NULL, speed_kmh REAL, battery_pct REAL, voltage_v REAL, mode TEXT, " +
        "odo_km REAL, ride_time_once_s INTEGER, mileage_once_km REAL)"
    )
    db.execSQL(
      "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ride_id INTEGER NOT NULL, " +
        "t_ms INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT)"
    )
    db.execSQL("CREATE INDEX idx_gps_ride ON gps(ride_id)")
    db.execSQL("CREATE INDEX idx_board_ride ON board(ride_id)")
    db.execSQL("CREATE INDEX idx_events_ride ON events(ride_id)")
    db.execSQL("CREATE INDEX idx_rides_state ON rides(state)")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    // No installed build has ever shipped a version 1 schema change yet — nothing to
    // migrate. A future bump should write a real migration instead of dropping.
    db.execSQL("DROP TABLE IF EXISTS rides")
    db.execSQL("DROP TABLE IF EXISTS gps")
    db.execSQL("DROP TABLE IF EXISTS board")
    db.execSQL("DROP TABLE IF EXISTS events")
    onCreate(db)
  }

  data class RideRow(
    val id: Long,
    val startMs: Long,
    val endMs: Long?,
    val state: String,
    val wasManual: Boolean,
    val odoStartKm: Double?,
    val odoEndKm: Double?,
    val batteryStartPct: Double?,
    val batteryEndPct: Double?,
    val distanceKm: Double?,
    val maxSpeedKmh: Double?,
    val endReason: String?,
    val stitchUntilMs: Long?,
    val backendId: Long?,
  )

  data class GpsPoint(val tMs: Long, val lat: Double, val lon: Double, val accM: Double?, val speedMs: Double?, val bearing: Double?, val altM: Double?)
  data class BoardSample(val tMs: Long, val speedKmh: Double?, val batteryPct: Double?, val voltageV: Double?, val mode: String?, val odoKm: Double?, val rideTimeOnceS: Long?, val mileageOnceKm: Double?)
  data class EventRow(val tMs: Long, val kind: String, val detail: String?)

  /** Starts a new open ride. */
  fun openRide(startMs: Long, wasManual: Boolean, odoStartKm: Double?, batteryStartPct: Double?): Long {
    val values = ContentValues().apply {
      put("start_ms", startMs)
      put("state", STATE_OPEN)
      put("was_manual", if (wasManual) 1 else 0)
      odoStartKm?.let { put("odo_start_km", it) }
      batteryStartPct?.let { put("battery_start_pct", it) }
    }
    return writableDatabase.insert("rides", null, values)
  }

  /** The single currently-open ride, if any — there is only ever at most one. */
  fun activeRide(): RideRow? =
    query("SELECT * FROM rides WHERE state = ? ORDER BY id DESC LIMIT 1", arrayOf(STATE_OPEN)) { rideFromCursor(it) }.firstOrNull()

  /** The most recently finished (not yet re-opened) ride — checked for stitching when
   * a new auto-start happens shortly after a disconnect-caused end. */
  fun lastFinishedRide(): RideRow? =
    query("SELECT * FROM rides WHERE state = ? ORDER BY id DESC LIMIT 1", arrayOf(STATE_FINISHED)) { rideFromCursor(it) }.firstOrNull()

  fun getRide(rideId: Long): RideRow? =
    query("SELECT * FROM rides WHERE id = ?", arrayOf(rideId.toString())) { rideFromCursor(it) }.firstOrNull()

  fun listUnuploaded(): List<RideRow> =
    query("SELECT * FROM rides WHERE state = ? ORDER BY id ASC", arrayOf(STATE_FINISHED)) { rideFromCursor(it) }

  fun markUploaded(rideId: Long, backendId: Long?) {
    val values = ContentValues().apply {
      put("state", STATE_UPLOADED)
      if (backendId != null) put("backend_id", backendId)
    }
    writableDatabase.update("rides", values, "id = ?", arrayOf(rideId.toString()))
  }

  /** Ends the ride: records end time/reason/distance/max speed/end telemetry, and
   * (for a board_off end) how long it stays re-openable for stitching. */
  fun finishRide(
    rideId: Long,
    endMs: Long,
    endReason: String,
    distanceKm: Double,
    maxSpeedKmh: Double,
    odoEndKm: Double?,
    batteryEndPct: Double?,
    stitchWindowMs: Long,
  ) {
    val values = ContentValues().apply {
      put("end_ms", endMs)
      put("state", STATE_FINISHED)
      put("end_reason", endReason)
      put("distance_km", distanceKm)
      put("max_speed_kmh", maxSpeedKmh)
      odoEndKm?.let { put("odo_end_km", it) }
      batteryEndPct?.let { put("battery_end_pct", it) }
      if (endReason == "board_off" && stitchWindowMs > 0) put("stitch_until_ms", endMs + stitchWindowMs)
    }
    writableDatabase.update("rides", values, "id = ?", arrayOf(rideId.toString()))
  }

  /** Re-opens a just-finished ride for a reconnect proven to be the same session (the
   * board's own trip counters never reset) — clears the finished markers so it reads
   * as 'open' again, continuing to accumulate instead of starting a second ride. */
  fun reopenRide(rideId: Long) {
    val values = ContentValues().apply {
      put("state", STATE_OPEN)
      putNull("end_ms")
      putNull("end_reason")
      putNull("stitch_until_ms")
    }
    writableDatabase.update("rides", values, "id = ?", arrayOf(rideId.toString()))
  }

  fun appendGps(rideId: Long, tMs: Long, lat: Double, lon: Double, accM: Double?, speedMs: Double?, bearing: Double?, altM: Double?) {
    val values = ContentValues().apply {
      put("ride_id", rideId)
      put("t_ms", tMs)
      put("lat", lat)
      put("lon", lon)
      accM?.let { put("acc_m", it) }
      speedMs?.let { put("speed_ms", it) }
      bearing?.let { put("bearing", it) }
      altM?.let { put("alt_m", it) }
    }
    writableDatabase.insert("gps", null, values)
  }

  fun appendBoard(rideId: Long, tMs: Long, speedKmh: Double?, batteryPct: Double?, voltageV: Double?, mode: String?, odoKm: Double?, rideTimeOnceS: Long?, mileageOnceKm: Double?) {
    val values = ContentValues().apply {
      put("ride_id", rideId)
      put("t_ms", tMs)
      speedKmh?.let { put("speed_kmh", it) }
      batteryPct?.let { put("battery_pct", it) }
      voltageV?.let { put("voltage_v", it) }
      mode?.let { put("mode", it) }
      odoKm?.let { put("odo_km", it) }
      rideTimeOnceS?.let { put("ride_time_once_s", it) }
      mileageOnceKm?.let { put("mileage_once_km", it) }
    }
    writableDatabase.insert("board", null, values)
  }

  fun appendEvent(rideId: Long, tMs: Long, kind: String, detail: String? = null) {
    val values = ContentValues().apply {
      put("ride_id", rideId)
      put("t_ms", tMs)
      put("kind", kind)
      detail?.let { put("detail", it) }
    }
    writableDatabase.insert("events", null, values)
  }

  fun getGpsPoints(rideId: Long): List<GpsPoint> =
    query("SELECT * FROM gps WHERE ride_id = ? ORDER BY t_ms ASC", arrayOf(rideId.toString())) {
      GpsPoint(
        tMs = it.getLong(it.getColumnIndexOrThrow("t_ms")),
        lat = it.getDouble(it.getColumnIndexOrThrow("lat")),
        lon = it.getDouble(it.getColumnIndexOrThrow("lon")),
        accM = it.getDoubleOrNull("acc_m"),
        speedMs = it.getDoubleOrNull("speed_ms"),
        bearing = it.getDoubleOrNull("bearing"),
        altM = it.getDoubleOrNull("alt_m"),
      )
    }

  fun getBoardSamples(rideId: Long): List<BoardSample> =
    query("SELECT * FROM board WHERE ride_id = ? ORDER BY t_ms ASC", arrayOf(rideId.toString())) {
      BoardSample(
        tMs = it.getLong(it.getColumnIndexOrThrow("t_ms")),
        speedKmh = it.getDoubleOrNull("speed_kmh"),
        batteryPct = it.getDoubleOrNull("battery_pct"),
        voltageV = it.getDoubleOrNull("voltage_v"),
        mode = it.getStringOrNull("mode"),
        odoKm = it.getDoubleOrNull("odo_km"),
        rideTimeOnceS = it.getLongOrNull("ride_time_once_s"),
        mileageOnceKm = it.getDoubleOrNull("mileage_once_km"),
      )
    }

  fun getEvents(rideId: Long): List<EventRow> =
    query("SELECT * FROM events WHERE ride_id = ? ORDER BY t_ms ASC", arrayOf(rideId.toString())) {
      EventRow(
        tMs = it.getLong(it.getColumnIndexOrThrow("t_ms")),
        kind = it.getString(it.getColumnIndexOrThrow("kind")),
        detail = it.getStringOrNull("detail"),
      )
    }

  /** The latest board sample recorded for this ride (dp5/dp6 continuity check —
   * the caller reads ride_time_once_s / mileage_once_km off it). Null if the ride has
   * no board samples yet. */
  fun latestBoardSample(rideId: Long): BoardSample? =
    query("SELECT * FROM board WHERE ride_id = ? ORDER BY t_ms DESC LIMIT 1", arrayOf(rideId.toString())) {
      BoardSample(
        tMs = it.getLong(it.getColumnIndexOrThrow("t_ms")),
        speedKmh = it.getDoubleOrNull("speed_kmh"),
        batteryPct = it.getDoubleOrNull("battery_pct"),
        voltageV = it.getDoubleOrNull("voltage_v"),
        mode = it.getStringOrNull("mode"),
        odoKm = it.getDoubleOrNull("odo_km"),
        rideTimeOnceS = it.getLongOrNull("ride_time_once_s"),
        mileageOnceKm = it.getDoubleOrNull("mileage_once_km"),
      )
    }.firstOrNull()

  private fun rideFromCursor(c: Cursor): RideRow = RideRow(
    id = c.getLong(c.getColumnIndexOrThrow("id")),
    startMs = c.getLong(c.getColumnIndexOrThrow("start_ms")),
    endMs = c.getLongOrNull("end_ms"),
    state = c.getString(c.getColumnIndexOrThrow("state")),
    wasManual = c.getInt(c.getColumnIndexOrThrow("was_manual")) != 0,
    odoStartKm = c.getDoubleOrNull("odo_start_km"),
    odoEndKm = c.getDoubleOrNull("odo_end_km"),
    batteryStartPct = c.getDoubleOrNull("battery_start_pct"),
    batteryEndPct = c.getDoubleOrNull("battery_end_pct"),
    distanceKm = c.getDoubleOrNull("distance_km"),
    maxSpeedKmh = c.getDoubleOrNull("max_speed_kmh"),
    endReason = c.getStringOrNull("end_reason"),
    stitchUntilMs = c.getLongOrNull("stitch_until_ms"),
    backendId = c.getLongOrNull("backend_id"),
  )

  private fun <T> query(sql: String, args: Array<String>, map: (Cursor) -> T): List<T> {
    val out = ArrayList<T>()
    readableDatabase.rawQuery(sql, args).use { c ->
      while (c.moveToNext()) out.add(map(c))
    }
    return out
  }
}

private fun Cursor.getDoubleOrNull(column: String): Double? {
  val idx = getColumnIndex(column)
  return if (idx < 0 || isNull(idx)) null else getDouble(idx)
}

private fun Cursor.getLongOrNull(column: String): Long? {
  val idx = getColumnIndex(column)
  return if (idx < 0 || isNull(idx)) null else getLong(idx)
}

private fun Cursor.getStringOrNull(column: String): String? {
  val idx = getColumnIndex(column)
  return if (idx < 0 || isNull(idx)) null else getString(idx)
}
