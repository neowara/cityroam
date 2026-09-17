package expo.modules.naveeble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import expo.modules.boardble.BoardBleClient
import expo.modules.boardble.BoardBleDiagnostics
import expo.modules.boardble.BoardScanner
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * GATT client for one NAVEE scooter: find → connect → MTU → notify → authenticate →
 * streamed telemetry, with automatic reconnection. Same shape as
 * [expo.modules.boardble.BoardBleClient] on purpose (one worker thread, one GATT
 * operation at a time on a latch only its own callback releases, backoff, liveness,
 * `adoptListener`, a `stop()` that really stops), so the two brands behave the same to
 * everything above them.
 *
 * The connect sequence is the official app's, step for step.
 * Leaving the auth step out is what made the first draft connect and drop in a loop:
 * the scooter drops a central that never authenticates, and anything that reads other
 * characteristics before auth invites a bonding attempt the scooter doesn't expect.
 */
/** The account identity an auth frame is built from; always read and updated together. */
data class AuthIdentity(val accountId: Long, val bindFlag: Int)

@SuppressLint("MissingPermission") // JS requests BLUETOOTH_CONNECT before constructing
class NaveeBleClient(
  private val context: Context,
  val devId: String,
  @Volatile private var authIdentity: AuthIdentity,
  /** The account's identifier for this scooter, printed in its advertisement. */
  private val cloudMac: String?,
  /** The Bluetooth address, once a scan has learned it. */
  @Volatile private var targetAddress: String?,
  @Volatile private var listener: Listener,
  @Volatile private var addressType: Int? = null,
) {
  interface Listener {
    fun onStep(message: String)
    fun onConnected()
    fun onDisconnected(willRetry: Boolean)
    fun onDps(dps: Map<String, Any?>)
    fun onAddressDiscovered(address: String, addressType: Int) {}

    /** Every frame the scooter sends, as hex — for the on-device protocol session. */
    fun onFrame(cmd: Int, status: Int, hex: String) {}

    /** The auth outcome of each connect: `ok`, or the scooter's own refusal status. */
    fun onAuthResult(ok: Boolean, status: Int?, message: String) {}
  }

  enum class ConnectionPhase { IDLE, SCANNING, CONNECTING, HANDSHAKING, CONNECTED, BACKOFF }

  companion object {
    private const val TAG = "NaveeBle"

    val SERVICE: UUID = UUID.fromString("0000d0ff-3c17-d293-8e48-14fe2e4da212")
    // V40i Pro: characteristics share the service's custom base (nRF Connect capture).
    private val WRITE_CUSTOM: UUID = UUID.fromString("0000b002-3c17-d293-8e48-14fe2e4da212")
    private val NOTIFY_CUSTOM: UUID = UUID.fromString("0000b003-3c17-d293-8e48-14fe2e4da212")
    // ST3 Pro (scooterteam): the standard Bluetooth base.
    private val WRITE_STANDARD: UUID = UUID.fromString("0000b002-0000-1000-8000-00805f9b34fb")
    private val NOTIFY_STANDARD: UUID = UUID.fromString("0000b003-0000-1000-8000-00805f9b34fb")
    private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    /** What the official app asks for; not 247. */
    private const val MTU = 148
    /** The official app sleeps 100 ms before subscribing and before authenticating. */
    private const val SETTLE_MS = 100L
    private const val OP_TIMEOUT_MS = 10_000L
    private const val RESPONSE_TIMEOUT_MS = 5_000L
    private const val SCAN_TIMEOUT_MS = 15_000L
    /** Challenge rounds before giving up; the official exchange needs exactly one. */
    private const val MAX_AUTH_ROUNDS = 3
    private const val RECONNECT_MIN_MS = 5_000L
    private const val RECONNECT_MAX_MS = 300_000L
    /** An account the scooter refuses won't become right by retrying fast. */
    private const val AUTH_REJECTED_RETRY_MS = 120_000L
    /** The official app reconnects when no `0x90` has arrived for 7 s. */
    private const val LIVENESS_SILENCE_MS = 7_000L
    private const val LIVENESS_PING_TIMEOUT_MS = 2_000L
    private const val DPS_LOG_THROTTLE_MS = 5_000L

    val activeClients = ConcurrentHashMap<String, NaveeBleClient>()
    private val nextClientId = AtomicInteger(0)

    fun adapter(context: Context): BluetoothAdapter? =
      (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
  }

  val clientId: Int = nextClientId.incrementAndGet()
  private val clientTag = "navee#$clientId"

  private val workerThread = HandlerThread("navee-ble-$devId").apply { start() }
  private val worker = Handler(workerThread.looper)

  @Volatile private var gatt: BluetoothGatt? = null
  private var writeChar: BluetoothGattCharacteristic? = null

  @Volatile private var stopped = false
  @Volatile private var authenticated = false
  @Volatile private var cycleRunning = false
  @Volatile private var scanCancel: (() -> Unit)? = null
  @Volatile private var lastFrameAtMs = 0L
  @Volatile private var linkUpAtMs = 0L
  @Volatile private var lastAuthRejected = false
  private var reconnectAttempt = 0

  @Volatile var phase: ConnectionPhase = ConnectionPhase.IDLE
    private set

  private val reassembler = NaveeFrame.Reassembler()

  // The two self-scheduled jobs, kept so restartNow()/stop() cancel exactly these and
  // never a posted settings write or status read, whose caller is waiting on an answer.
  private val reconnectRunnable = Runnable { connectCycle() }
  private val livenessRunnable = Runnable { livenessCheck() }

  /**
   * Turning Bluetooth off tears links down without an onConnectionStateChange, so a
   * session would otherwise sit "connected" forever; turning it back on is the moment a
   * reconnect can succeed again. RideService does this for board clients only — it
   * can't see this module — so each NAVEE client watches the adapter itself.
   */
  private val bluetoothStateReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
        BluetoothAdapter.STATE_OFF -> worker.post { abandonLink("Bluetooth turned off") }
        BluetoothAdapter.STATE_ON -> {
          step("Bluetooth turned on — reconnecting")
          restartNow()
        }
      }
    }
  }

  private fun step(message: String) {
    val tagged = "[$clientTag] $message"
    Log.d(TAG, tagged)
    listener.onStep(tagged)
    BoardBleDiagnostics.record(devId, tagged)
  }

  // --------------------------------------------------------------- GATT plumbing

  private enum class OpKind { NONE, CONNECT, MTU, DISCOVER, DESCRIPTOR_WRITE, CHAR_WRITE }

  /** The last connection state the current GATT reported. onLinkLost ignores a drop
   * before authentication finishes, so this is how the connect path sees one. */
  @Volatile private var lastConnectionState = BluetoothProfile.STATE_DISCONNECTED

  private val pendingOpLatch = AtomicReference<CountDownLatch?>(null)
  @Volatile private var pendingOpKind = OpKind.NONE
  @Volatile private var pendingOpStatus = -1

  private val callback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
      if (isStale(g, allowPendingConnect = true)) return
      if (newState == BluetoothProfile.STATE_CONNECTED || newState == BluetoothProfile.STATE_DISCONNECTED) {
        lastConnectionState = newState
        releaseOp(OpKind.CONNECT, if (newState == BluetoothProfile.STATE_CONNECTED) status else maxOf(status, 1))
      }
      if (newState == BluetoothProfile.STATE_CONNECTED) linkUpAtMs = SystemClock.elapsedRealtime()
      if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        // Whatever the worker is waiting on will never get its callback now.
        if (pendingOpKind != OpKind.NONE && pendingOpKind != OpKind.CONNECT) {
          pendingOpStatus = -2
          pendingOpLatch.getAndSet(null)?.countDown()
        }
        onLinkLost(g, status)
      }
    }

    override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
      if (isStale(g)) return
      step("mtu $mtu (status $status)")
      releaseOp(OpKind.MTU, status)
    }

    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
      if (isStale(g)) return
      releaseOp(OpKind.DISCOVER, status)
    }

    override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      if (isStale(g)) return
      releaseOp(OpKind.DESCRIPTOR_WRITE, status)
    }

    override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      if (isStale(g)) return
      releaseOp(OpKind.CHAR_WRITE, status)
    }

    override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      if (isStale(g)) return
      onNotification(value)
    }

    @Deprecated("Pre-33 notification path")
    override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT < 33) {
        if (isStale(g)) return
        @Suppress("DEPRECATION")
        onNotification(characteristic.value ?: return)
      }
    }
  }

  /**
   * True, after closing it, when a callback came from a GATT this client no longer holds.
   * Every GATT shares [callback], and an unclosed replaced one keeps reporting here and
   * keeps holding the scooter's link. The one legitimate unowned callback is a connect
   * whose `connectGatt` result isn't stored in [gatt] yet.
   */
  private fun isStale(g: BluetoothGatt, allowPendingConnect: Boolean = false): Boolean {
    val current = gatt
    val owned = if (current != null) g === current else allowPendingConnect && pendingOpKind == OpKind.CONNECT
    if (owned) return false
    step("closing a superseded GATT connection that was still open")
    closeGattQuietly(g)
    return true
  }

  private fun closeGattQuietly(g: BluetoothGatt) {
    try {
      g.close()
    } catch (e: Exception) {
      Log.w(TAG, "gatt close failed", e)
    }
  }

  /** Queues the connect cycle, replacing any already queued: a second queued cycle runs
   * after the first has connected and opens another GATT on top of the live one. */
  private fun postCycle(delayMs: Long) {
    worker.removeCallbacks(reconnectRunnable)
    worker.postDelayed(reconnectRunnable, delayMs)
  }

  /** Completes the waiting operation only from its own kind of callback. */
  private fun releaseOp(kind: OpKind, status: Int) {
    if (pendingOpKind != kind) return
    pendingOpStatus = status
    pendingOpLatch.getAndSet(null)?.countDown()
  }

  private fun gattOp(kind: OpKind, tag: String, timeoutMs: Long = OP_TIMEOUT_MS, issue: () -> Unit): Int {
    val latch = CountDownLatch(1)
    pendingOpStatus = -1
    pendingOpKind = kind
    pendingOpLatch.set(latch)
    try {
      issue()
    } catch (e: Throwable) {
      pendingOpLatch.set(null)
      pendingOpKind = OpKind.NONE
      step("$tag could not be issued: ${e.message}")
      return -1
    }
    if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
      pendingOpLatch.set(null)
      pendingOpKind = OpKind.NONE
      step("$tag timed out after ${timeoutMs}ms")
      return -1
    }
    pendingOpKind = OpKind.NONE
    return pendingOpStatus
  }

  // ------------------------------------------------------------------ public API

  fun start() {
    stopped = false
    phase = ConnectionPhase.CONNECTING
    val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
    if (Build.VERSION.SDK_INT >= 33) {
      context.registerReceiver(bluetoothStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      context.registerReceiver(bluetoothStateReceiver, filter)
    }
    postCycle(0L)
  }

  fun stop() {
    stopped = true
    activeClients.remove(devId, this)
    phase = ConnectionPhase.IDLE
    try {
      context.unregisterReceiver(bluetoothStateReceiver)
    } catch (e: IllegalArgumentException) {
      // Never registered (stopped before start); nothing to undo.
    }
    // Closing the GATT below suppresses the disconnect callback, so the ride machine has
    // to hear about it here or it keeps an active ride on a device nobody is connected to.
    if (authenticated) {
      authenticated = false
      BoardBleClient.rideObserver?.onConnectionChanged(devId, false)
    }
    worker.removeCallbacks(reconnectRunnable)
    worker.removeCallbacks(livenessRunnable)
    pendingOpLatch.getAndSet(null)?.countDown()
    awaited.getAndSet(null)?.latch?.countDown()
    scanCancel?.invoke()
    scanCancel = null
    val current = gatt
    gatt = null
    try {
      current?.disconnect()
      current?.close()
    } catch (e: Exception) {
      Log.w(TAG, "gatt close failed during stop", e)
    }
    worker.post { workerThread.quitSafely() }
  }

  /** No-op while authenticated: a cycle over a live session would open a second GATT on
   * top of it. A session whose link died silently is ended by the liveness check or the
   * Bluetooth-off broadcast first, which is what makes it restartable. */
  fun restartNow() {
    if (stopped || cycleRunning || authenticated) return
    reconnectAttempt = 0
    phase = ConnectionPhase.CONNECTING
    postCycle(0L)
  }

  fun updateCredentials(authIdentity: AuthIdentity, address: String?, addressType: Int?) {
    this.authIdentity = authIdentity
    if (!address.isNullOrEmpty()) targetAddress = address
    if (addressType != null) this.addressType = addressType
    lastAuthRejected = false
  }

  fun isConnected(): Boolean = authenticated

  fun adoptListener(next: Listener) {
    listener = next
    if (authenticated) {
      next.onStep("[$clientTag] adopted an already-connected session")
      next.onConnected()
    }
  }

  /** Asks the scooter for its settings; the answer arrives through onDps. */
  fun queryStatus(done: (Boolean, String) -> Unit) {
    if (stopped || !worker.post {
        if (!authenticated) {
          done(false, "NOT_CONNECTED: the scooter is not authenticated yet")
          return@post
        }
        val ok = writeFrame(NaveeFrame.read(NaveeFrame.CMD_READ_STATUS), "status read")
        // Voltage arrives only in the 0x72 reply, so it has to ride this poll: read once
        // at connect and dp20 would hold that one value for an entire ride.
        if (ok) writeFrame(NaveeFrame.read(NaveeFrame.CMD_READ_BATTERY), "battery read")
        done(ok, if (ok) "ok" else "WRITE_FAILED: couldn't send the status read")
      }
    ) {
      done(false, "NOT_CONNECTED: this scooter's session has been shut down")
    }
  }

  /**
   * Changes one setting ([NaveeSettings] key) and waits for the scooter's acknowledgement,
   * then re-reads the settings frame so the new value arrives through onDps — the
   * official app's own write-then-read pattern.
   */
  fun writeSetting(key: String, value: Int, done: (Boolean, String) -> Unit) {
    val field = NaveeSettings.field(key) ?: run {
      done(false, "UNSUPPORTED: no NAVEE setting called $key")
      return
    }
    if (stopped || !worker.post {
        if (!authenticated) {
          done(false, "NOT_CONNECTED: the scooter is not authenticated yet")
          return@post
        }
        val frame = field.encode(value)
        val ack = sendAndAwait(frame, frame[3].toInt() and 0xFF)
        when {
          ack == null -> done(false, "NO_RESPONSE: $key got no answer in ${RESPONSE_TIMEOUT_MS}ms")
          ack.status != 0 -> done(false, "REJECTED: the scooter refused $key=$value (status ${ack.status})")
          else -> {
            step("setting $key=$value acknowledged")
            done(true, "ok")
          }
        }
        writeFrame(NaveeFrame.read(NaveeFrame.CMD_READ_STATUS), "status read")
      }
    ) {
      done(false, "NOT_CONNECTED: this scooter's session has been shut down")
    }
  }

  // ------------------------------------------------------------------ connection

  private fun connectCycle() {
    cycleRunning = true
    try {
      if (stopped) return
      if (authenticated) {
        step("already connected; skipping a redundant connect cycle")
        phase = ConnectionPhase.CONNECTED
        return
      }
      val device = resolveDevice() ?: run {
        if (!stopped) scheduleReconnect()
        return
      }
      if (stopped) return
      phase = ConnectionPhase.CONNECTING
      if (connectAndAuthenticate(device)) {
        reconnectAttempt = 0
        return
      }
      if (stopped) {
        // stop() can run while connectGatt is still returning; the GATT it hands back
        // belongs to nobody and would keep the scooter's link wanted.
        closeQuietly()
        return
      }
      disconnectGatt()
      scheduleReconnect()
    } finally {
      cycleRunning = false
    }
  }

  /** A known address connects directly (the official app's own path); otherwise scan. */
  private fun resolveDevice(): BluetoothDevice? {
    val adapter = adapter(context) ?: run {
      step("Bluetooth is unavailable")
      return null
    }
    targetAddress?.let { address ->
      return try {
        if (Build.VERSION.SDK_INT >= 33 && addressType != null && addressType != BluetoothDevice.ADDRESS_TYPE_UNKNOWN) {
          adapter.getRemoteLeDevice(address, addressType!!)
        } else {
          adapter.getRemoteDevice(address)
        }
      } catch (e: IllegalArgumentException) {
        step("stored scooter address $address is not valid; scanning instead")
        targetAddress = null
        scanForScooter(adapter)
      }
    }
    return scanForScooter(adapter)
  }

  private fun scanForScooter(adapter: BluetoothAdapter): BluetoothDevice? {
    val scanner = adapter.bluetoothLeScanner ?: run {
      step("Bluetooth scanner unavailable (Bluetooth off?)")
      return null
    }
    phase = ConnectionPhase.SCANNING
    step("scanning for the scooter (cloud MAC ${cloudMac ?: "unknown"})…")
    val latch = CountDownLatch(1)
    val found = AtomicReference<ScanResult?>(null)
    val scanCallback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        val record = result.scanRecord
        val raw = record?.bytes
        val hasCompany = record?.getManufacturerSpecificData(NaveeAdvertisement.COMPANY_ID) != null
        val name = record?.deviceName ?: result.device.name
        if (!NaveeAdvertisement.looksLikeNavee(name, hasCompany)) return
        val advertisedMac = NaveeAdvertisement.cloudMac(raw)
        val matches = cloudMac == null ||
          advertisedMac == cloudMac ||
          NaveeAdvertisement.normalizeMac(result.device.address) == cloudMac
        step(
          "saw ${result.device.address} \"${name ?: ""}\" rssi ${result.rssi} cloudMac $advertisedMac " +
            "pid ${NaveeAdvertisement.productId(raw)} ${if (matches) "(match)" else "(not ours)"}",
        )
        if (matches && found.compareAndSet(null, result)) latch.countDown()
      }

      override fun onScanFailed(errorCode: Int) {
        step("scan failed (error $errorCode)")
        latch.countDown()
      }
    }
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
    try {
      scanner.startScan(null, settings, scanCallback)
    } catch (e: SecurityException) {
      step("scan refused: Bluetooth permission missing")
      return null
    }
    scanCancel = { latch.countDown() }
    latch.await(SCAN_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    scanCancel = null
    try {
      scanner.stopScan(scanCallback)
    } catch (e: Exception) {
      // Bluetooth turned off mid-scan; nothing to stop.
    }
    val result = found.get() ?: run {
      if (!stopped) step("scooter not found in the ${SCAN_TIMEOUT_MS / 1000}s scan window")
      return null
    }
    val type = BoardScanner.addressTypeOf(result.device)
    if (targetAddress == null || addressType == null) {
      targetAddress = result.device.address
      addressType = type
      listener.onAddressDiscovered(result.device.address, type)
    }
    return result.device
  }

  private fun connectAndAuthenticate(device: BluetoothDevice): Boolean {
    // A new connectGatt must never overwrite an open GATT: the old one would stay
    // registered with the stack, holding the scooter, with nothing left to close it.
    if (gatt != null) {
      step("closing the previous GATT connection before opening a new one")
      disconnectGatt()
    }
    step("connecting to ${device.address}")
    lastConnectionState = BluetoothProfile.STATE_DISCONNECTED
    var opened: BluetoothGatt? = null
    val connectStatus = gattOp(OpKind.CONNECT, "connect") {
      opened = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
      gatt = opened
    }
    if (stopped) {
      // stop() may have cleared gatt just before this connect stored its result; the
      // local reference is the only one left that can close it.
      opened?.let { closeGattQuietly(it) }
      return false
    }
    val current = gatt
    if (connectStatus != 0 || current == null) {
      step("connect failed (status $connectStatus)")
      // A stored address that never answers may have rotated; learn it again next time.
      if (connectStatus == -1 && cloudMac != null) targetAddress = null
      return false
    }
    step("link up")

    gattOp(OpKind.MTU, "mtu request") { current.requestMtu(MTU) }
    if (stopped) return false

    val discoverStatus = gattOp(OpKind.DISCOVER, "service discovery") { current.discoverServices() }
    if (stopped) return false
    if (discoverStatus != 0) {
      step("service discovery failed (status $discoverStatus)")
      return false
    }
    for (svc in current.services) {
      step("service ${svc.uuid}")
      for (ch in svc.characteristics) step("  char ${ch.uuid} props 0x%02X".format(ch.properties))
    }
    val service: BluetoothGattService = current.getService(SERVICE) ?: run {
      step("scooter doesn't expose the NAVEE service $SERVICE")
      return false
    }
    val notify = service.getCharacteristic(NOTIFY_CUSTOM) ?: service.getCharacteristic(NOTIFY_STANDARD)
    writeChar = service.getCharacteristic(WRITE_CUSTOM) ?: service.getCharacteristic(WRITE_STANDARD)
    if (notify == null || writeChar == null) {
      step("NAVEE service lacks B002/B003")
      return false
    }
    step("write ${writeChar!!.uuid} props 0x%02X, notify ${notify.uuid} props 0x%02X".format(writeChar!!.properties, notify.properties))

    SystemClock.sleep(SETTLE_MS)
    current.setCharacteristicNotification(notify, true)
    val cccd = notify.getDescriptor(CCCD) ?: run {
      step("B003 has no CCCD")
      return false
    }
    val cccdStatus = gattOp(OpKind.DESCRIPTOR_WRITE, "CCCD write") {
      if (Build.VERSION.SDK_INT >= 33) {
        val code = current.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
        if (code != 0) releaseOp(OpKind.DESCRIPTOR_WRITE, code)
      } else {
        @Suppress("DEPRECATION")
        cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        @Suppress("DEPRECATION")
        if (!current.writeDescriptor(cccd)) releaseOp(OpKind.DESCRIPTOR_WRITE, -1)
      }
    }
    if (stopped) return false
    if (cccdStatus != 0) {
      step("CCCD write failed (status $cccdStatus)")
      return false
    }
    step("subscribed to B003")
    SystemClock.sleep(SETTLE_MS)

    phase = ConnectionPhase.HANDSHAKING
    if (!authenticate()) return false

    authenticated = true
    // A drop before the line above reached onLinkLost while this session didn't count as
    // up yet, which leaves gatt untouched; lastConnectionState is what records it.
    if (gatt !== current || stopped || lastConnectionState != BluetoothProfile.STATE_CONNECTED) {
      authenticated = false
      step("link went away as authentication finished")
      return false
    }
    lastAuthRejected = false
    phase = ConnectionPhase.CONNECTED
    lastFrameAtMs = SystemClock.elapsedRealtime()
    step("authenticated ${SystemClock.elapsedRealtime() - linkUpAtMs}ms after link up")
    listener.onAuthResult(true, 0, "authenticated")
    listener.onConnected()
    BoardBleClient.rideObserver?.onConnectionChanged(devId, true)

    // What the official app does next: set the scooter's clock, then read its settings.
    writeFrame(NaveeFrame.setClock(System.currentTimeMillis() / 1000), "clock")
    writeFrame(NaveeFrame.read(NaveeFrame.CMD_READ_STATUS), "status read")
    // Pack voltage lives only behind 0x72 on this model; the telemetry pushes stop short
    // of it, so without this read dp20 stays empty for the whole session.
    writeFrame(NaveeFrame.read(NaveeFrame.CMD_READ_BATTERY), "battery read")
    worker.removeCallbacks(livenessRunnable)
    worker.postDelayed(livenessRunnable, LIVENESS_SILENCE_MS)
    return true
  }

  private fun authenticate(): Boolean {
    val identity = authIdentity
    if (identity.accountId <= 0L) {
      step("no NAVEE account id stored — sign in to NAVEE to pair this scooter")
      listener.onAuthResult(false, null, "no account id")
      return false
    }
    repeat(MAX_AUTH_ROUNDS) { round ->
      if (stopped) return false
      val keyIndex = NaveeAuth.randomKeyIndex()
      step("auth 0x30 (round ${round + 1}, key $keyIndex, bind flag ${identity.bindFlag})")
      val reply = sendAndAwait(NaveeAuth.authRequest(identity.accountId, identity.bindFlag, keyIndex), NaveeFrame.CMD_AUTH) ?: run {
        step("no 0x30 reply within ${RESPONSE_TIMEOUT_MS}ms")
        listener.onAuthResult(false, null, "no reply")
        return false
      }
      when (val outcome = NaveeAuth.onAuthReply(reply, keyIndex)) {
        is NaveeAuth.Reply.Authenticated -> return true
        is NaveeAuth.Reply.Rejected -> {
          val message = NaveeAuth.describeStatus(outcome.status)
          step("auth rejected: $message")
          lastAuthRejected = true
          listener.onAuthResult(false, outcome.status, message)
          return false
        }
        is NaveeAuth.Reply.Unanswerable -> {
          step("auth challenge unanswerable: ${outcome.reason} (${NaveeFrame.toHex(reply.data)})")
          listener.onAuthResult(false, null, outcome.reason)
          return false
        }
        is NaveeAuth.Reply.Challenge -> {
          step("challenge received, answering 0x31")
          val answer = sendAndAwait(outcome.answer, NaveeFrame.CMD_AUTH_CHALLENGE) ?: run {
            step("no 0x31 reply within ${RESPONSE_TIMEOUT_MS}ms")
            listener.onAuthResult(false, null, "no challenge reply")
            return false
          }
          if (answer.status != 0) {
            val message = "challenge answer refused (status ${answer.status})"
            step(message)
            listener.onAuthResult(false, answer.status, message)
            return false
          }
          SystemClock.sleep(SETTLE_MS)
        }
      }
    }
    step("auth still not settled after $MAX_AUTH_ROUNDS rounds")
    listener.onAuthResult(false, null, "too many rounds")
    return false
  }

  private fun livenessCheck() {
    if (stopped || !authenticated) return
    val silentFor = SystemClock.elapsedRealtime() - lastFrameAtMs
    if (silentFor >= LIVENESS_SILENCE_MS) {
      step("liveness: nothing from the scooter for ${silentFor}ms — asking for status")
      var answered = sendAndAwait(NaveeFrame.read(NaveeFrame.CMD_READ_STATUS), NaveeFrame.CMD_READ_STATUS, LIVENESS_PING_TIMEOUT_MS) != null
      if (!answered && !stopped && authenticated) {
        answered = sendAndAwait(NaveeFrame.read(NaveeFrame.CMD_READ_STATUS), NaveeFrame.CMD_READ_STATUS, LIVENESS_PING_TIMEOUT_MS) != null
      }
      if (!answered && !stopped && authenticated) {
        // Don't wait for a disconnect callback: a link that died without one (Bluetooth
        // toggled, stack reset) never delivers it, and the session would stay "connected".
        abandonLink("liveness: no answer twice")
        return
      }
    }
    if (!stopped && authenticated) worker.postDelayed(livenessRunnable, LIVENESS_SILENCE_MS)
  }

  private fun scheduleReconnect() {
    if (stopped) return
    phase = ConnectionPhase.BACKOFF
    val delayMs = if (lastAuthRejected) {
      AUTH_REJECTED_RETRY_MS
    } else {
      minOf(RECONNECT_MIN_MS shl reconnectAttempt.coerceAtMost(7), RECONNECT_MAX_MS)
    }
    reconnectAttempt++
    listener.onDisconnected(true)
    step("reconnecting in ${delayMs / 1000}s")
    postCycle(delayMs)
  }

  /** Worker thread. Ends the session as lost without relying on any GATT callback. */
  private fun abandonLink(reason: String) {
    // Nothing up and nothing opening: onLinkLost or a failed cycle already handled it,
    // and scheduling again would double the backoff.
    if (stopped || (!authenticated && gatt == null)) return
    val wasAuthenticated = authenticated
    authenticated = false
    step("$reason — treating the link as lost")
    worker.removeCallbacks(livenessRunnable)
    if (wasAuthenticated) BoardBleClient.rideObserver?.onConnectionChanged(devId, false)
    closeQuietly()
    reassembler.reset()
    if (!cycleRunning) scheduleReconnect()
  }

  private fun closeQuietly() {
    try {
      gatt?.disconnect()
      gatt?.close()
    } catch (e: Exception) {
      Log.w(TAG, "gatt close failed", e)
    }
    gatt = null
    writeChar = null
  }

  private fun disconnectGatt() {
    val current = gatt
    if (current != null) {
      gattOp(OpKind.CONNECT, "disconnect", 2_000L) { current.disconnect() }
      try {
        current.close()
      } catch (e: Exception) {
        Log.w(TAG, "gatt close failed", e)
      }
    }
    gatt = null
    writeChar = null
    authenticated = false
    reassembler.reset()
  }

  private fun onLinkLost(g: BluetoothGatt, status: Int) {
    val wasAuthenticated = authenticated
    authenticated = false
    val upFor = if (linkUpAtMs > 0) SystemClock.elapsedRealtime() - linkUpAtMs else -1
    // The line that answers "why does it loop": how long the link lived, in which phase,
    // and whether the scooter (19) or the stack (8 = supervision timeout, 22/133 …) ended it.
    step("link dropped after ${upFor}ms in phase $phase (GATT status $status${if (status == 19) ", scooter closed it" else ""})")
    if (wasAuthenticated) {
      listener.onDisconnected(!stopped)
      BoardBleClient.rideObserver?.onConnectionChanged(devId, false)
    }
    awaited.getAndSet(null)?.latch?.countDown()
    // Only a link that was fully up has nobody waiting on it; a drop mid-handshake is
    // cleaned up by the connect cycle that's blocked on it.
    if (!wasAuthenticated) return
    // The reconnect is only scheduled when [gatt] is still the lost GATT by the time this
    // runs. Otherwise a connect cycle or abandonLink already owns the cleanup, and a second
    // schedule would queue a cycle over whatever session came up since.
    worker.post {
      closeGattQuietly(g)
      if (gatt !== g) return@post
      gatt = null
      writeChar = null
      reassembler.reset()
      if (!stopped) scheduleReconnect()
    }
  }

  // ------------------------------------------------------- frame send / receive

  private class Awaited(val cmd: Int, val latch: CountDownLatch = CountDownLatch(1)) {
    @Volatile var frame: NaveeFrame.Parsed? = null
  }

  private val awaited = AtomicReference<Awaited?>(null)

  private fun writeFrame(frame: ByteArray, tag: String): Boolean {
    val char = writeChar ?: return false
    val current = gatt ?: return false
    // With-response when the characteristic offers it, like the official app's writes
    // and scooterteam's working Python tool.
    val writeType = if (char.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) {
      BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
    } else {
      BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
    }
    step("tx $tag ${NaveeFrame.toHex(frame)}")
    val status = gattOp(OpKind.CHAR_WRITE, "write $tag") {
      if (Build.VERSION.SDK_INT >= 33) {
        val code = current.writeCharacteristic(char, frame, writeType)
        if (code != 0) releaseOp(OpKind.CHAR_WRITE, code)
      } else {
        @Suppress("DEPRECATION")
        char.writeType = writeType
        @Suppress("DEPRECATION")
        char.value = frame
        @Suppress("DEPRECATION")
        if (!current.writeCharacteristic(char)) releaseOp(OpKind.CHAR_WRITE, -1)
      }
    }
    if (status != 0) step("write $tag failed (status $status)")
    return status == 0
  }

  private fun sendAndAwait(frame: ByteArray, replyCmd: Int, timeoutMs: Long = RESPONSE_TIMEOUT_MS): NaveeFrame.Parsed? {
    if (stopped) return null
    val waiting = Awaited(replyCmd)
    awaited.set(waiting)
    if (!writeFrame(frame, "cmd 0x%02X".format(frame[3].toInt() and 0xFF))) {
      awaited.compareAndSet(waiting, null)
      return null
    }
    waiting.latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    awaited.compareAndSet(waiting, null)
    return waiting.frame
  }

  /** Binder thread. Anything that writes back is posted to the worker. */
  private fun onNotification(chunk: ByteArray) {
    lastFrameAtMs = SystemClock.elapsedRealtime()
    val result = reassembler.accept(chunk)
    if (result.discarded > 0) step("discarded ${result.discarded} bytes that weren't a frame (${NaveeFrame.toHex(chunk)})")
    for (frame in result.frames) dispatch(frame)
  }

  private fun dispatch(frame: NaveeFrame.Parsed) {
    val hex = NaveeFrame.toHex(frame.data)
    listener.onFrame(frame.cmd, frame.status, hex)
    val telemetry = frame.cmd == NaveeFrame.CMD_HOME_TELEMETRY ||
      frame.cmd == NaveeFrame.CMD_DRIVE_TELEMETRY_V0 ||
      frame.cmd == NaveeFrame.CMD_DRIVE_TELEMETRY_V1
    // Telemetry is logged decoded (throttled, below); everything else raw, always.
    if (!telemetry || !authenticated) step("rx 0x%02X status %d data %s".format(frame.cmd, frame.status, hex))

    val waiting = awaited.get()
    if (waiting != null && waiting.cmd == frame.cmd) {
      waiting.frame = frame
      waiting.latch.countDown()
    }

    if (!authenticated) return
    val dps = NaveeTelemetry.toDps(frame) ?: return
    logDps(dps)
    listener.onDps(dps)
    BoardBleClient.rideObserver?.onDps(devId, dps)
  }

  // Telemetry arrives several times a second; one log line per push would bury
  // everything else. Changes are coalesced into at most one line per throttle window.
  private val lastLoggedDps = HashMap<String, Any?>()
  private val pendingDpsLog = LinkedHashMap<String, Any?>()
  private var lastDpsLogMs = 0L

  private fun logDps(dps: Map<String, Any?>) {
    val line = synchronized(lastLoggedDps) {
      for ((k, v) in dps) {
        if (!lastLoggedDps.containsKey(k) || lastLoggedDps[k] != v) {
          lastLoggedDps[k] = v
          pendingDpsLog[k] = v
        }
      }
      val now = SystemClock.elapsedRealtime()
      if (pendingDpsLog.isEmpty() || now - lastDpsLogMs < DPS_LOG_THROTTLE_MS) return
      lastDpsLogMs = now
      val text = pendingDpsLog.entries.joinToString(", ") { "${it.key}=${it.value}" }
      pendingDpsLog.clear()
      text
    }
    step("dps $line")
  }
}
