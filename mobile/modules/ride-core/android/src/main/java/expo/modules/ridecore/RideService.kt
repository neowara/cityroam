package expo.modules.ridecore

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import expo.modules.boardble.BoardBleClient
import expo.modules.boardble.BoardCredentialStore
import expo.modules.boardble.BoardWakeScan
import kotlin.math.max

/**
 * The native ride-recording service — owns the board's dp stream (via
 * [BoardBleClient.RideObserver], registered process-wide so capture happens whether or
 * not JS is alive to adopt anything), a recording-time GPS request
 * ([RideLocationManager]), the ride state machine ([RideMachine]), and the durable
 * journal ([RideJournal]) everything above is written into as it happens.
 *
 * SCOPE NOTE for whoever picks this up next: this service is a genuine, independent,
 * durable capture path — every ride it sees is fully recorded in `ride_journal.db`
 * regardless of the JS runtime's state. It does **not** replace `lib/tripRecorder.ts`
 * as the app's save/upload pipeline — that JS path still owns auto-start/stop, board
 * telemetry, the live UI, and finalize/upload. What it IS now (following a real
 * on-device comparison — see docs/adr/0006) is the app's route
 * source: `lib/rideCoreSync.ts`'s `getNativeRouteForTrip` reads `getRideSamples` for
 * whichever ride matches the JS trip currently finalizing, and its GPS points become
 * the saved trip's route in place of the JS watch's own (falling back to the JS one
 * only when no native ride matches). `markRideUploaded` still exists for
 * `syncNativeRides`'s separate job: fully finalizing a ride the JS side never even
 * saw (the process was killed before its own finalize ran).
 *
 * Never stopped/started in response to board connection or ride state (ADR 0004's
 * rule) — started once, from a visible moment (app foreground, board paired), and left
 * running for the process's lifetime. Only the location *request* and the wake lock
 * follow ride state.
 *
 * Also owns board-connection upkeep formerly split into its own `BoardConnectionService`
 * (board-ble module): bringing up a `BoardBleClient` for the stored board in a process
 * the system recreated, and nudging every active client the instant Bluetooth comes
 * back on. The two were always one concern — already started/stopped together behind
 * identical gating in `backgroundSelfHeal.ts` — split only because a service in one
 * Gradle module can't directly start a service in another, which is also why this one
 * is reached from board-ble via [BoardBleClient.ForegroundOwner] rather than a plain
 * import.
 */
class RideService : Service() {
  companion object {
    private const val TAG = "RideCore"
    private const val CHANNEL_ID = "ride_recording"
    private const val NOTIFICATION_ID = 2001
    private const val WAKE_LOCK_TAG = "cityroam:ride"
    // Re-acquired on every board sample while riding; if samples stop for this long
    // (the process died, or something wedged), the wake lock is let go rather than
    // held forever.
    private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L
    // Dp5/dp6 continuity window for stitching a reconnect back into the ride it
    // interrupted, rather than starting a new one — see findStitchCandidate. Runtime-
    // adjustable (0 disables) from the Diagnostics screen; a plain
    // var here in the meantime.
    @Volatile var stitchWindowMs: Long = 60_000L

    @Volatile private var running = false

    // True only while this service is actually in the foreground with the location type.
    // `running` flips as soon as a start is requested and stays false after a sticky
    // restart in a new process, so it can't answer that question.
    @Volatile var locationForeground = false
      private set

    fun start(context: Context) {
      if (running) return
      val intent = Intent(context, RideService::class.java)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        running = true
      } catch (e: Throwable) {
        Log.w(TAG, "could not start RideService", e)
      }
    }

    fun stop(context: Context) {
      if (!running) return
      running = false
      context.stopService(Intent(context, RideService::class.java))
    }

    fun isRunning(): Boolean = running
  }

  private lateinit var journal: RideJournal
  private lateinit var locationManager: RideLocationManager
  private val machine = RideMachine()
  private var wakeLock: PowerManager.WakeLock? = null

  // Written from the BLE client's own worker thread (handleDps/handleConnectionChanged)
  // and read from onGpsFix on RideLocationManager's separate HandlerThread, plus the
  // main thread during onCreate — guarded by [stateLock] rather than @Volatile since
  // several of these are read-then-written together as one logical step (e.g.
  // findStitchCandidate reading four of them to decide whether to reopen a ride).
  private val stateLock = Any()
  private var activeRideId: Long? = null
  private var activeDevId: String? = null
  private var connectedDevId: String? = null

  // Rolling latest telemetry, updated from every dp push regardless of ride state —
  // used both as the ride's start/end values and as the stitch-continuity check.
  private var lastOdometerKm: Double? = null
  private var lastBatteryPct: Double? = null
  private var lastMileageOnceKm: Double? = null
  private var lastRideTimeOnceS: Long? = null
  // dp14 (ride mode) is a delta push: the board only re-sends it when the mode
  // changes, so a per-push raw read is null on almost every frame. Carried forward the
  // same way as the telemetry above, since a mode change that arrives before the ride
  // opens (its own activeRideId set) would otherwise leave every board row for that
  // ride with a null mode -- a genuine, observed failure mode, not a hypothetical.
  private var lastMode: String? = null
  private var maxSpeedSeenKmh: Double = 0.0

  private val rideObserver = object : BoardBleClient.RideObserver {
    override fun onDps(devId: String, dps: Map<String, Any?>) = handleDps(devId, dps)
    override fun onConnectionChanged(devId: String, connected: Boolean) = handleConnectionChanged(devId, connected)
  }

  /**
   * Bluetooth turning off drops every link with no `onConnectionStateChange` callback
   * to say why (the radio itself is gone, not just this one connection) — without this,
   * a client sits out its exponential backoff exactly like it would for a board that's
   * simply away, even though the real cause resolved the instant Bluetooth came back on.
   * Nudging every active client the moment it does removes that wait entirely.
   */
  private val bluetoothStateReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
      if (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1) != BluetoothAdapter.STATE_ON) return
      Log.i(TAG, "Bluetooth turned back on — nudging every active client")
      BoardBleClient.activeClients.values.forEach { it.restartNow() }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    journal = RideJournal(applicationContext)
    locationManager = RideLocationManager(applicationContext) { fix -> onGpsFix(fix) }
    createNotificationChannel()
    // Android 13+ requires an explicit exported/not-exported flag for a context-
    // registered receiver; the plain platform constant needs no androidx dependency.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(bluetoothStateReceiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED), Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      registerReceiver(bluetoothStateReceiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
    }
    if (!enterForeground()) return
    BoardBleClient.rideObserver = rideObserver
    ensureClient()
    // A ride already open in the journal (the process was killed mid-ride) picks back
    // up rather than being silently abandoned — the machine itself starts IDLE, but the
    // journal row and telemetry rolling values are what actually matter for resuming.
    journal.activeRide()?.let { row ->
      synchronized(stateLock) {
        activeRideId = row.id
        lastOdometerKm = row.odoStartKm
        lastBatteryPct = row.batteryStartPct
      }
      locationManager.start()
      acquireWakeLock()
    }
    Log.i(TAG, "RideService started")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!enterForeground()) return START_NOT_STICKY
    BoardBleClient.rideObserver = rideObserver
    ensureClient()
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    locationForeground = false
    if (BoardBleClient.rideObserver === rideObserver) BoardBleClient.rideObserver = null
    try {
      unregisterReceiver(bluetoothStateReceiver)
    } catch (e: Exception) {
      Log.w(TAG, "bluetoothStateReceiver already unregistered", e)
    }
    locationManager.destroy()
    releaseWakeLock()
    Log.i(TAG, "RideService stopped")
    super.onDestroy()
  }

  /**
   * Brings up a client for the stored board if one is not already running. On a process
   * the system recreated, [BoardBleClient.activeClients] is empty and the JS layer may
   * never run, so the natively stored credentials are the only way back to a connection.
   */
  private fun ensureClient() {
    val credentials = BoardCredentialStore.load(applicationContext) ?: return
    // Re-armed here too, not just from JS's startBackgroundReconnect — a reboot drops
    // the system's scan registration (undocumented either way; assume it does), and
    // this service restarting is the first native-side chance to re-request it.
    // Idempotent: re-arming an already-armed scan just updates the same registration.
    BoardWakeScan.arm(applicationContext)
    if (BoardBleClient.activeClients.containsKey(credentials.devId)) return
    try {
      BoardBleClient.connect(
        applicationContext,
        credentials.devId,
        credentials.localKey,
        credentials.secKey,
        credentials.uuid,
        credentials.mac,
        credentials.addressType,
      )
    } catch (e: Throwable) {
      // Expected while the board is simply off; the next service start retries.
      Log.d(TAG, "could not start the board client", e)
    }
  }

  /**
   * The `types` bitmask is computed at runtime, not assumed from the manifest: a
   * `connectedDevice` type requires BLUETOOTH_CONNECT already granted, and `location`
   * cannot be started from the background without ACCESS_BACKGROUND_LOCATION — a
   * refusal here must fail soft (lose native capture for this run), never crash launch.
   */
  private fun enterForeground(): Boolean = try {
    var types = 0
    if (checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
    }
    if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED ||
      checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED
    ) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && types != 0) {
      // The 3-arg overload (API 29+) is a plain platform Service method — no androidx
      // dependency needed.
      startForeground(NOTIFICATION_ID, buildNotification(), types)
    } else {
      startForeground(NOTIFICATION_ID, buildNotification())
    }
    locationForeground = (types and ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) != 0
    true
  } catch (e: Throwable) {
    Log.w(TAG, "foreground start refused; native ride capture stays off for this run", e)
    running = false
    locationForeground = false
    stopSelf()
    false
  }

  // ------------------------------------------------------------- BLE-driven capture

  private fun handleConnectionChanged(devId: String, connected: Boolean) {
    synchronized(stateLock) { connectedDevId = if (connected) devId else null }
    if (connected) {
      updateNotification()
      return
    }
    val event = machine.onDisconnect() ?: run { updateNotification(); return }
    if (event is RideMachine.Event.AutoEnd) finishActiveRide(System.currentTimeMillis(), event.reason)
    updateNotification()
  }

  private fun handleDps(devId: String, dps: Map<String, Any?>) {
    val now = System.currentTimeMillis()
    var rideId: Long?
    var speedKmh: Double?
    synchronized(stateLock) {
      (dps["12"] as? Number)?.let { lastOdometerKm = it.toDouble() / 10.0 }
      (dps["3"] as? Number)?.let { lastBatteryPct = it.toDouble() }
      (dps["5"] as? Number)?.let { lastMileageOnceKm = it.toDouble() / 10.0 }
      (dps["6"] as? Number)?.let { lastRideTimeOnceS = it.toLong() }
      (dps["14"] as? Any)?.let { lastMode = it.toString() }

      rideId = activeRideId
      speedKmh = (dps["2"] as? Number)?.toDouble()?.div(10.0)
      if (rideId != null) {
        val voltageV = (dps["20"] as? Number)?.toDouble()?.div(10.0)
        journal.appendBoard(rideId, now, speedKmh, lastBatteryPct, voltageV, lastMode, lastOdometerKm, lastRideTimeOnceS, lastMileageOnceKm)
        if (speedKmh != null) maxSpeedSeenKmh = max(maxSpeedSeenKmh, speedKmh!!)
      }
    }

    val rawSpeed = speedKmh ?: return
    val event = machine.onSample(rawSpeed, now) ?: run { updateNotification(); return }
    if (event is RideMachine.Event.AutoStart) startOrStitchRide(devId, now)
    updateNotification()
  }

  private fun startOrStitchRide(devId: String, nowMs: Long) {
    synchronized(stateLock) {
      activeDevId = devId
      val stitchCandidate = findStitchCandidateLocked(nowMs)
      activeRideId = if (stitchCandidate != null) {
        journal.reopenRide(stitchCandidate.id)
        journal.appendEvent(stitchCandidate.id, nowMs, "stitched", "reconnected within ${stitchWindowMs}ms, dp5/dp6 continuous")
        maxSpeedSeenKmh = stitchCandidate.maxSpeedKmh ?: 0.0
        stitchCandidate.id
      } else {
        maxSpeedSeenKmh = 0.0
        journal.openRide(nowMs, wasManual = false, odoStartKm = lastOdometerKm, batteryStartPct = lastBatteryPct)
      }
    }
    acquireWakeLock()
    locationManager.start()
  }

  /** Caller must hold [stateLock] — reads four fields together as one decision. */
  private fun findStitchCandidateLocked(nowMs: Long): RideJournal.RideRow? {
    if (stitchWindowMs <= 0) return null
    val last = journal.lastFinishedRide() ?: return null
    if (last.endReason != "board_off") return null
    val until = last.stitchUntilMs ?: return null
    if (nowMs > until) return null
    val prev = journal.latestBoardSample(last.id) ?: return null
    val prevRideTime = prev.rideTimeOnceS ?: return null
    val prevMileage = prev.mileageOnceKm ?: return null
    val curRideTime = lastRideTimeOnceS ?: return null
    val curMileage = lastMileageOnceKm ?: return null
    // Genuinely the same session only if the board's own counters never went backward
    // (a power-cycle resets them; a link blip never touches them).
    return if (curRideTime >= prevRideTime && curMileage >= prevMileage) last else null
  }

  private fun finishActiveRide(endMs: Long, reason: String) {
    var distanceKm = 0.0
    var maxSpeed = 0.0
    var odometerKm: Double? = null
    var batteryPct: Double? = null
    val rideId: Long = synchronized(stateLock) {
      val id = activeRideId ?: return
      activeRideId = null
      val ride = journal.getRide(id)
      distanceKm = if (ride?.odoStartKm != null && lastOdometerKm != null) {
        max(0.0, lastOdometerKm!! - ride.odoStartKm)
      } else {
        0.0
      }
      maxSpeed = maxSpeedSeenKmh
      odometerKm = lastOdometerKm
      batteryPct = lastBatteryPct
      id
    }
    locationManager.stop()
    releaseWakeLock()
    journal.finishRide(rideId, endMs, reason, distanceKm, maxSpeed, odometerKm, batteryPct, stitchWindowMs)
    journal.appendEvent(rideId, endMs, "link_lost")
    // No "ride saved" notification here: the JS finalize path is still the
    // rider-facing save and already posts its own, and firing both here would
    // duplicate it for every ride.
  }

  // ------------------------------------------------------------------- GPS capture

  private fun onGpsFix(fix: RideLocationManager.RideFix) {
    val rideId = synchronized(stateLock) { activeRideId } ?: return
    journal.appendGps(rideId, fix.tMs, fix.lat, fix.lon, fix.accM?.toDouble(), fix.speedMs?.toDouble(), fix.bearing?.toDouble(), fix.altM)
  }

  // --------------------------------------------------------------- wake lock + notif

  private fun acquireWakeLock() {
    val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
    val lock = wakeLock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).also { it.setReferenceCounted(false); wakeLock = it }
    lock.acquire(WAKE_LOCK_TIMEOUT_MS)
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      val channel = NotificationChannel(CHANNEL_ID, "Connection & ride status", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while Cityroam stays connected to your board and while it records a ride. Required by Android."
        setShowBadge(false)
      }
      manager.createNotificationChannel(channel)
      // The old board-ble module's own foreground service (merged into this one) used
      // a separate channel — deleting it here (idempotent if already gone, or never
      // created on this install) keeps it from lingering forever as a dead entry in the
      // rider's notification settings.
      manager.deleteNotificationChannel("board_ble_connection")
    }
  }

  private fun updateNotification() {
    try {
      val manager = getSystemService(NotificationManager::class.java)
      manager.notify(NOTIFICATION_ID, buildNotification())
    } catch (e: Throwable) {
      Log.w(TAG, "notification update failed", e)
    }
  }

  private fun buildNotification(): Notification {
    val contentIntent = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE)
    // Title stays constant across states (matches Maps/Strava/Spotify) — the state
    // lives in the text instead, so the notification never appears to change identity.
    // Wording avoids "board"/"scooter" entirely: this native service has no way to read
    // the JS-side per-product-family noun (see deviceNounFor in deviceConnectionNotifications.ts).
    val text = when {
      activeRideId != null -> "Recording your ride · %.1f km".format(lastOdometerKmSinceRideStart())
      connectedDevId != null -> "Connected. Watching for rides."
      else -> "Watching for your ride"
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setContentTitle("Cityroam")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.ic_menu_compass)
      .setOngoing(true)
      .setContentIntent(contentIntent)
      .build()
  }

  private fun lastOdometerKmSinceRideStart(): Double {
    val ride = activeRideId?.let { journal.getRide(it) } ?: return 0.0
    val start = ride.odoStartKm ?: return 0.0
    val current = lastOdometerKm ?: return 0.0
    return max(0.0, current - start)
  }
}
