package expo.modules.boardble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import java.util.Calendar
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * SDK-free GATT client for one board: scan → connect → device-info handshake → pair →
 * streamed datapoints, with automatic reconnection.
 *
 * Android allows exactly one GATT operation in flight per connection; everything here
 * is serialized on a single worker thread, and each operation blocks that thread on a
 * latch only its own callback releases (the same serialization the SDK's
 * BleCommandQueue was working around). Datapoints and time requests from the board are
 * answered from the notification path; any write they trigger is posted back onto the
 * worker so it can never interleave with an in-flight operation.
 */
@SuppressLint("MissingPermission") // JS requests BLUETOOTH_CONNECT before constructing
class BoardBleClient(
  private val context: Context,
  val devId: String,
  @Volatile private var localKey: String,
  @Volatile private var secKey: String?,
  private val targetUuid: String?,
  @Volatile private var targetMac: String?,
  @Volatile private var listener: Listener,
  /** `BluetoothDevice.ADDRESS_TYPE_*`, if already known (a prior scan learned it, or
   * this is a reconnect after process restart with it persisted). Null means unknown —
   * `awaitAutoConnect` then falls back to the legacy public-address-only API. */
  @Volatile private var addressType: Int? = null,
) {
  interface Listener {
    /** Human-readable progress line — surfaced through logEvent by the module. */
    fun onStep(message: String)
    fun onConnected()
    fun onDisconnected(willRetry: Boolean)
    fun onDps(dps: Map<String, Any?>)

    /**
     * The board's Bluetooth address (and address type — see BoardScanner.addressTypeOf),
     * the first time a scan reveals it.
     *
     * Tuya's API does not return it, so it is only ever learned by scanning. Until it
     * is stored, every reconnect has to scan on a timer instead of parking an
     * autoConnect — which is both far slower to notice the board returning and
     * dramatically more expensive, since a scan loop wakes the host continuously
     * where a parked autoConnect costs nothing. The address type additionally decides
     * whether that parked autoConnect can use the modern, type-aware reconnect API at
     * all (see awaitAutoConnect's own comment).
     */
    fun onAddressDiscovered(address: String, addressType: Int) {}
  }

  /**
   * What a client is doing right now, exposed to JS so `reconcileConnectionState` can
   * tell a genuine "native says disconnected" from "native is still mid-handshake" —
   * the two used to be indistinguishable from the outside, which is what let a fresh
   * handshake get torn down ~150ms after succeeding. SCANNING/CONNECTING/HANDSHAKING are
   * transient and not safe to reconcile against; CONNECTED and BACKOFF are settled.
   */
  enum class ConnectionPhase { IDLE, SCANNING, CONNECTING, HANDSHAKING, CONNECTED, BACKOFF }

  /**
   * A second, always-on observer of connection/dp events — independent of whichever
   * `Listener` JS currently has adopted (see [adoptListener]). [RideService] (in the
   * ride-core module) registers itself here once, at process start, so ride capture
   * never depends on JS being alive to adopt anything: the dp push that starts a ride
   * or the disconnect that ends one reaches the native ride machine/journal exactly the
   * same whether or not any JS runtime currently owns this client's `listener`.
   */
  interface RideObserver {
    fun onDps(devId: String, dps: Map<String, Any?>)
    fun onConnectionChanged(devId: String, connected: Boolean)
  }

  /**
   * Owns the always-on foreground service that keeps this process alive so a stored
   * board reconnects without the app being reopened. `RideService` (ride-core module)
   * is the real implementation, but this module cannot reference it directly — `ride-
   * core` depends on `board-ble`, not the other way around, so a compile-time reference
   * here would be a circular Gradle module dependency. `RideCoreForegroundOwnerProvider`
   * (a manifest-registered `ContentProvider` in ride-core) sets this the moment the
   * process starts, before any other app component runs — including a fully headless
   * process with no Activity and no JS/Expo bridge ever booted, which is exactly the
   * case the WorkManager self-heal worker and the BLE wake-scan receiver below run in.
   *
   * Start-only: this module never stops the service. It must keep running regardless
   * of board connection state (ADR 0004) — stopping it is the exclusive responsibility
   * of the background-self-heal-disabled path, which stops it directly via RideCore's
   * own JS-exposed function (ride-core can reference RideService without this seam).
   */
  interface ForegroundOwner {
    fun start(context: Context)
  }

  companion object {
    private val TAG = "BoardBle"

    val SERVICE_FD50: UUID = UUID.fromString("0000fd50-0000-1000-8000-00805f9b34fb")
    val SERVICE_A201: UUID = UUID.fromString("0000a201-0000-1000-8000-00805f9b34fb")
    private val WRITE_CHAR_FD50: UUID = UUID.fromString("00000001-0000-1001-8001-00805f9b07d0")
    private val WRITE_CHAR_A201: UUID = UUID.fromString("00002b11-0000-1000-8000-00805f9b34fb")
    private val NOTIFY_CHAR_FD50: UUID = UUID.fromString("00000002-0000-1001-8001-00805f9b07d0")
    private val NOTIFY_CHAR_A201: UUID = UUID.fromString("00002b10-0000-1000-8000-00805f9b34fb")
    private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    // Opcodes (device → phone codes have the high bit set).
    private const val CODE_DEVICE_INFO = 0x0000
    private const val CODE_PAIR = 0x0001
    private const val CODE_SEND_DPS = 0x0002
    private const val CODE_DEVICE_STATUS = 0x0003
    private const val CODE_SEND_DPS_V4 = 0x0027
    private const val CODE_RECEIVE_DP = 0x8001
    private const val CODE_RECEIVE_TIME_DP = 0x8003
    private const val CODE_RECEIVE_SIGN_DP = 0x8004
    private const val CODE_RECEIVE_SIGN_TIME_DP = 0x8005
    private const val CODE_RECEIVE_DP_V4 = 0x8006
    private const val CODE_RECEIVE_TIME_DP_V4 = 0x8007
    private const val CODE_TIME1_REQ = 0x8011
    private const val CODE_TIME2_REQ = 0x8012

    private const val OP_TIMEOUT_MS = 10_000L
    private const val RESPONSE_TIMEOUT_MS = 8_000L
    private const val SCAN_TIMEOUT_MS = 15_000L
    private const val RECONNECT_MIN_MS = 5_000L
    /** Coalesces the "dps changed" log line — see [logDps]'s own comment. */
    private const val DPS_LOG_THROTTLE_MS = 5_000L

    // Liveness check: the board's own link supervision timeout catches a hard
    // power-off, but not a stack that's gone quiet without actually dropping the
    // radio link — this active check catches that case within roughly the same
    // window the rider expects ("stopped responding for 5 seconds = disconnected").
    // No frame of any kind (a push, a response, anything) for this long while
    // connected triggers a status ping; no answer to that within the shorter timeout
    // below closes the link (which then runs the normal reconnect cycle).
    //
    // Two intervals, not one: a parked, connected board's own idle push cadence
    // (dp20, measured live) is ~5s -- the same as the old fixed interval here, so
    // the check raced the board's own scheduled push at the exact moment it fired,
    // producing repeated "no frame" log lines and pings against a board that was
    // never actually unresponsive. A riding board is far chattier (dp2 pushes every
    // few seconds at minimum), so 5s still catches a genuine stall quickly there;
    // idle only needs to notice within a rider-tolerable window, not race the
    // board's own housekeeping cadence.
    private const val LIVENESS_CHECK_INTERVAL_RIDING_MS = 5_000L
    private const val LIVENESS_CHECK_INTERVAL_IDLE_MS = 15_000L
    private const val LIVENESS_PING_TIMEOUT_MS = 2_000L
    // Matches the documented intent: the cap had been left at 30s, so a board that was
    // simply away (overnight, say) kept a 15s scan running every 30s all night.
    private const val RECONNECT_MAX_MS = 300_000L

    /** Effectively "until the board shows up" — the controller does the waiting. */
    private const val AUTO_CONNECT_WAIT_MS = 12L * 60 * 60 * 1000

    /** Every connected client, keyed by devId — the module routes JS calls through this. */
    val activeClients = ConcurrentHashMap<String, BoardBleClient>()

    /** Numbers each client instance for log lines (`client#N`) — the only way a fresh
     * log can show at a glance whether more than one client is fighting over a board. */
    private val nextClientId = AtomicInteger(0)

    /** Process-wide, not per-client: only one board is ever the "active" one for ride
     * capture at a time (this app's own single-live-session model), so a single
     * registration point is simpler than threading a per-devId map through every
     * client construction site. Set once by RideService at process start. */
    @Volatile var rideObserver: RideObserver? = null

    /** Set once by [expo.modules.ridecore.RideCoreForegroundOwnerProvider] at process
     * start — see [ForegroundOwner]'s own doc comment. */
    @Volatile var foregroundOwner: ForegroundOwner? = null

    /** How an idle (not currently connecting) client waits for its board to reappear.
     * `AUTO_CONNECT`: a single parked `connectGatt(autoConnect=true)`, handled entirely
     * by the Bluetooth controller — no host wakeups while waiting. `SCAN_THEN_DIRECT`:
     * the pre-fix behaviour, a timed scan loop with exponential backoff between windows.
     * Process-wide (matches [rideObserver]'s reasoning) and runtime-switchable so an
     * on-device pass (and later the Diagnostics screen) can flip the default without a
     * rebuild. Defaults to AUTO_CONNECT — the fix this was built for is meant to
     * actually run, not sit behind an off switch; if it turns out not to work on real
     * hardware, flip this default (or the Diagnostics toggle) to SCAN_THEN_DIRECT. */
    enum class IdleConnectStrategy { AUTO_CONNECT, SCAN_THEN_DIRECT }
    @Volatile var idleConnectStrategy: IdleConnectStrategy = IdleConnectStrategy.AUTO_CONNECT

    /**
     * Starts a client with no listener attached, for callers with nowhere to send events.
     *
     * Called from processes the system recreated, where there is no React runtime to
     * receive them — the connection itself is the point, and JS picks up the live
     * client through the module when it next runs. Idempotent.
     */
    fun connect(
      context: Context,
      devId: String,
      localKey: String,
      secKey: String?,
      uuid: String?,
      mac: String?,
      addressType: Int? = null,
    ) {
      if (activeClients.containsKey(devId)) return
      Log.i(TAG, "background service is starting its own client for $devId")
      val client = BoardBleClient(
        context, devId, localKey, secKey, uuid, mac,
        object : Listener {
          override fun onStep(message: String) {
            Log.d(TAG, "[service] $message")
          }
          override fun onConnected() {}
          override fun onDisconnected(willRetry: Boolean) {}
          override fun onDps(dps: Map<String, Any?>) {}
        },
        addressType,
      )
      activeClients[devId] = client
      client.start()
    }
  }

  /** This instance's number, for `client#N` log lines. Never reused across an app run. */
  val clientId: Int = nextClientId.incrementAndGet()
  private val clientTag = "client#$clientId"

  private val workerThread = HandlerThread("board-ble-$devId").apply { start() }
  private val worker = Handler(workerThread.looper)

  // Volatile: every binder callback reads it to decide whether it is looking at the
  // current GATT or one to close.
  @Volatile private var gatt: BluetoothGatt? = null
  private var writeChar: BluetoothGattCharacteristic? = null

  @Volatile private var stopped = false
  @Volatile private var handshakeComplete = false

  /** What this client is doing right now — see [ConnectionPhase]. */
  @Volatile var phase: ConnectionPhase = ConnectionPhase.IDLE
    private set

  /** True while `connectCycle()` is actually executing (as opposed to sitting in its
   * scheduled-reconnect wait). [restartNow] uses this to tell "interrupt a backoff" from
   * "a cycle is already running, nudging it again would just queue a second one behind
   * it" — the latter is exactly how a client used to end up racing itself. */
  @Volatile private var cycleRunning = false

  /** Cancels an in-flight scan immediately; set while [scanBlocking] is waiting, cleared
   * once it returns. [stop] invokes this so a stopped client's scan doesn't keep running
   * for up to its own 15s window with nothing left to hand the result to. */
  @Volatile private var scanCancel: (() -> Unit)? = null

  /** Wall-clock (elapsedRealtime) of the last notification frame of any kind received
   * from the board — written from the Binder notification thread, read from the
   * worker's liveness check. See [LIVENESS_CHECK_INTERVAL_RIDING_MS]. */
  @Volatile private var lastFrameAtMs = 0L

  /** Raw dp2 (wheel speed, scale 1) last seen on the live push stream — 0 until the
   * board ever reports moving, and Tuya only re-sends a dp when it changes, so this is
   * genuinely "the last known speed", not "the current speed sampled just now". Used
   * only to pick the liveness check's own interval (see [livenessIntervalMs]); this
   * client has no other reason to track ride state, and deliberately doesn't reach
   * into ride-core/JS to ask "is a ride active" — that would be a real dependency
   * inversion for a low-stakes interval choice. */
  @Volatile private var lastKnownDp2Raw: Int = 0

  /**
   * Rides in the first fragment's header as `version << 4`. Starts at 2, matching the
   * reference — a board that expects 2 ignores a fragment announcing 3 outright, with
   * no error and no notification back. The real value is learned from the device-info
   * response and used for everything after it.
   */
  @Volatile private var protocolVersion = 2

  /**
   * ATT MTU actually granted by the board; 23 is the BLE default until it answers.
   *
   * Frames are chunked to this, not to the 20-byte floor the reference implementation
   * uses. Captured from a working session, this board is written to in one 36-byte ATT
   * write and answers immediately; the identical frame split into 20+17 is silently
   * ignored, so it does not reassemble fragments.
   */
  @Volatile private var negotiatedMtu = 23

  /** Which derivation last worked on this board: true = v2 (secKey), false = v3, null = not yet known. */
  @Volatile private var lastGoodDerivation: Boolean? = null

  private var reconnectAttempt = 0

  // Seq numbers start at 1, as in the reference.
  private var seqNum = 1

  private val reassembler = Reassembler()
  private val pendingOpLatch = AtomicReference<CountDownLatch?>(null)
  @Volatile private var pendingOpStatus: Int = -1

  /** The response frame the worker is currently waiting for (seq + acceptable codes). */
  private val awaitedResponse = AtomicReference<AwaitedResponse?>(null)
  @Volatile private var awaitedResultCode: Int = -1
  @Volatile private var awaitedResultData: ByteArray = ByteArray(0)

  /** Derived during the device-info exchange; null until then. */
  @Volatile private var sessionKey: ByteArray? = null
  @Volatile private var sessionFlag: Int = 0

  private class AwaitedResponse(
    val seq: Int,
    val codes: Set<Int>,
    val latch: CountDownLatch = CountDownLatch(1),
  )

  /** Every step line goes through here: tagged with this client's id (so a fresh log
   * shows at a glance whether more than one client is active for a board) and
   * recorded into [BoardBleDiagnostics] regardless of whether anything is currently
   * listening, so the foreground service's own client (which can run for a long time
   * with nothing but a logcat-only listener attached) is never silent. */
  private fun step(message: String) {
    val tagged = "[$clientTag] $message"
    listener.onStep(tagged)
    BoardBleDiagnostics.record(devId, tagged)
  }

  // --------------------------------------------------------------- GATT callback

  /** The last STATE_CONNECTED/STATE_DISCONNECTED the current GATT reported. The CONNECT
   * op slot is released by both, so a status of 0 alone doesn't say the link came up. */
  @Volatile private var lastConnectionState = BluetoothProfile.STATE_DISCONNECTED

  private val callback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
      if (isStale(g, allowPendingConnect = true)) return
      if (newState == BluetoothProfile.STATE_CONNECTED || newState == BluetoothProfile.STATE_DISCONNECTED) {
        lastConnectionState = newState
        releaseOp(OpKind.CONNECT, status)
      }
      if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        onLinkLost(g)
      }
    }

    override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
      if (isStale(g)) return
      if (status == 0) negotiatedMtu = mtu
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

    // API 33+: notifications carry the value in the callback itself.
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
   *
   * Every connection shares [callback], so a GATT that was replaced without being closed
   * keeps reporting here. Acting on it delivers every notification once per open GATT
   * (which corrupts reassembly) and lets a dead GATT's disconnect tear down the live
   * session. Closing it matters as much as ignoring it: an unclosed `autoConnect` GATT
   * re-opens the link every time the board advertises, and only turning Bluetooth off
   * releases it otherwise. The one legitimate unowned callback is a connect whose
   * `connectGatt` result hasn't been stored in [gatt] yet.
   */
  private fun isStale(g: BluetoothGatt, allowPendingConnect: Boolean = false): Boolean {
    val current = gatt
    val owned = if (current != null) g === current else allowPendingConnect && pendingOpKind == OpKind.CONNECT
    if (owned) return false
    step("closing a superseded GATT connection that was still open")
    try {
      g.close()
    } catch (e: Exception) {
      Log.w(TAG, "closing a superseded gatt failed", e)
    }
    return true
  }

  /**
   * Completes the pending operation, but only from the callback that belongs to it.
   *
   * Every GATT callback used to release the one shared latch, so a late or unsolicited
   * one — an MTU result arriving after its own timeout, a connection-state change —
   * would complete whatever operation happened to be waiting and report its status as
   * that operation's. A descriptor write "succeeding" that way leaves notifications
   * disabled while the code believes it subscribed, which looks exactly like a board
   * that never answers.
   */
  private fun releaseOp(kind: OpKind, status: Int) {
    if (pendingOpKind != kind) {
      Log.d(TAG, "[$clientTag] ignoring $kind callback; waiting on $pendingOpKind")
      return
    }
    pendingOpStatus = status
    pendingOpLatch.getAndSet(null)?.countDown()
  }

  private enum class OpKind { NONE, CONNECT, MTU, DISCOVER, DESCRIPTOR_WRITE, CHAR_WRITE }

  @Volatile private var pendingOpKind: OpKind = OpKind.NONE

  /**
   * Runs one GATT operation: `issue` starts it, and the returned status is whatever
   * the matching callback reported (or a synthetic error on timeout). The latch is
   * installed before issuing so a fast callback can never be missed.
   */
  private fun gattOp(kind: OpKind, tag: String, timeoutMs: Long = OP_TIMEOUT_MS, issue: () -> Unit): Int {
    val latch = CountDownLatch(1)
    pendingOpStatus = -1
    pendingOpKind = kind
    pendingOpLatch.set(latch)
    try {
      issue()
    } catch (e: Throwable) {
      // The GATT can drop between a frame arriving and the answer to it being written,
      // leaving no characteristic to write to. That is an ordinary race on a link that
      // can vanish at any moment, and it must read as a failed operation — this runs on
      // the client's own thread, where a throw takes the whole app down.
      pendingOpLatch.set(null)
      pendingOpKind = OpKind.NONE
      step("$tag could not be issued: ${e.message}")
      return -1
    }
    val done = latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    if (!done) {
      pendingOpLatch.set(null)
      pendingOpKind = OpKind.NONE
      step("$tag timed out after ${timeoutMs}ms")
      return -1
    }
    // Left set, a finished connect would keep marking unowned GATTs as "ours" through
    // the whole backoff that follows (see isStale).
    pendingOpKind = OpKind.NONE
    return pendingOpStatus
  }

  // ------------------------------------------------------------------ public API

  /** Starts the connect-and-hang-on loop. Returns immediately; progress goes to `listener`. */
  fun start() {
    stopped = false
    phase = ConnectionPhase.SCANNING
    postCycle(0L)
  }

  private val reconnectRunnable = Runnable { connectCycle() }
  private val livenessRunnable = Runnable { livenessCheck() }

  /** Queues the connect cycle, replacing any already queued: a second queued cycle runs
   * after the first has connected and opens another GATT on top of the live one. */
  private fun postCycle(delayMs: Long) {
    worker.removeCallbacks(reconnectRunnable)
    worker.postDelayed(reconnectRunnable, delayMs)
  }

  /**
   * Stops everything and forgets this client. No reconnects after this.
   *
   * Every wait this client could be blocked in is unblocked immediately — the pending
   * GATT-op latch, the awaited-response latch, and an in-flight scan — rather than left
   * to expire on its own bound (up to 15s for a scan, up to 12h for a parked
   * autoConnect wait). Without this a "stopped" client kept running its current connect
   * attempt to completion and could open a fresh GATT to the board *after* being told to
   * stop — two independent sessions racing the same peripheral, which is indistinguishable
   * from a board that never answers.
   *
   * The GATT close happens synchronously, on the calling thread, before this returns —
   * not posted to the worker. A caller replacing this client (connectDirect, adopting a
   * fresh session for a devId whose old one is not yet connected) constructs and starts
   * the new one immediately after calling this; if the old GATT were still open when
   * that happens, both would hold a live connection to the same physical board at once.
   * That is exactly what two independent GATT sessions racing for the same peripheral
   * looks like: neither handshake ever gets an answer, because the board is fielding
   * writes from two centrals it can't tell apart. Closing here, not in the worker's
   * queue, is what makes the replacement client's first connect the only one in flight.
   */
  fun stop() {
    stopped = true
    // Value-checked remove: a zombie client calling stop() late must not evict a
    // *different*, newer client that has since taken over this devId's slot in the map.
    activeClients.remove(devId, this)
    phase = ConnectionPhase.IDLE
    worker.removeCallbacksAndMessages(null) // cancels a pending backoff wait
    pendingOpLatch.getAndSet(null)?.countDown() // unblocks a gattOp wait
    awaitedResponse.getAndSet(null)?.latch?.countDown() // unblocks a sendAndAwait wait
    scanCancel?.invoke() // unblocks an in-flight scan
    scanCancel = null
    try {
      gatt?.disconnect()
      gatt?.close()
    } catch (e: Exception) {
      Log.w(TAG, "gatt close failed during stop", e)
    }
    gatt = null
    worker.post { workerThread.quitSafely() }
  }

  /**
   * Cancels a pending backoff and starts a fresh connect cycle on this same instance,
   * without tearing the client down and replacing it — replacing was the other half of
   * a torn-down client whose in-flight connect attempt didn't honour `stopped` used to keep
   * running as a zombie racing the replacement. No-ops if a cycle is already running
   * (nudging it again would just queue a second one behind it), if the board is still
   * connected, or if stopped.
   */
  fun restartNow() {
    if (stopped || cycleRunning) return
    if (handshakeComplete && linkIsUp()) return
    worker.removeCallbacks(livenessRunnable)
    // Only the pending reconnect: a blanket clear would also drop a queued response to
    // the board or a caller's publish, whose promise then never settles.
    reconnectAttempt = 0
    phase = ConnectionPhase.SCANNING
    postCycle(0L)
  }

  /** Updates the key material and/or learned address a running client uses on its next
   * connect attempt — e.g. after `refreshBoardFromAccount` fetches fresh keys, or once a
   * scan learns the board's address. Does not itself trigger a reconnect. */
  fun updateCredentials(localKey: String, secKey: String?, mac: String?, addressType: Int? = null) {
    this.localKey = localKey
    this.secKey = secKey
    if (!mac.isNullOrEmpty()) this.targetMac = mac
    if (addressType != null) this.addressType = addressType
  }

  /** Sends one datapoint and waits for the board's result byte. Runs on the worker. */
  /**
   * Runs work on the client's thread, or reports failure if it cannot.
   *
   * Handler.post returns false once the looper has quit, and a stopped client's thread
   * has. Posting blind meant the callback was simply never invoked — so the promise
   * waiting on it never settled and the rider watched a spinner forever, with no error
   * and nothing in the log. A caller must always get an answer.
   */
  private fun postOrFail(done: (Boolean, String) -> Unit, work: () -> Unit) {
    if (stopped || !worker.post(work)) {
      done(false, "NOT_CONNECTED: this board's session has been shut down")
    }
  }

  fun publishDp(dpId: Int, type: String, value: Any?, done: (success: Boolean, message: String) -> Unit) {
    postOrFail(done) {
      if (!handshakeComplete) {
        done(false, "NOT_CONNECTED: the board is linked but the handshake hasn't finished yet")
        return@postOrFail
      }
      val dp = try {
        dpForWrite(dpId, type, value)
      } catch (e: Exception) {
        done(false, "BAD_VALUE: cannot encode dp$dpId as $type: ${e.message}")
        return@postOrFail
      }
      // A protocol-v4 board only honors the v4 SEND_DPS (0x0027) and drops the legacy v3
      // opcode (0x0002) silently — which is what made every write time out. v4 sends a
      // 0x00 + 4-byte dp-sequence header with two-byte KLV lengths and acks with the
      // sequence echoed and the result byte last; v3 uses no header and one-byte lengths.
      val v4 = protocolVersion >= 4
      val response = if (v4) {
        // The dp sequence is drawn from the same counter that numbers the frame, so it
        // lands one behind the frame's seq, as the reference implementation's does.
        sendAndAwait(CODE_SEND_DPS_V4, TuyaDatapoint.buildV4Send(seqNum++, listOf(dp)), setOf(CODE_SEND_DPS_V4))
      } else {
        sendAndAwait(CODE_SEND_DPS, TuyaDatapoint.encode(listOf(dp)), setOf(CODE_SEND_DPS))
      }
      // A null response is the board never answering (or the write itself failing),
      // which is not the same as the board answering "no". Reporting both as a
      // rejection sent debugging in the wrong direction; a silent board is usually a
      // dropped link or a read-only datapoint, neither of which is a bad value.
      if (response == null) {
        done(false, "NO_RESPONSE: dp$dpId got no answer in ${RESPONSE_TIMEOUT_MS}ms. The link dropped, or the datapoint isn't writable")
        return@postOrFail
      }
      // The v3 ack puts the result in its first byte; the v4 ack echoes the dp sequence
      // first, then the result as its sixth byte.
      val result = (if (v4) response.getOrNull(5) else response.getOrNull(0))?.toInt()
      if (result == null) {
        done(false, "NO_RESPONSE: dp$dpId answered with an empty payload")
        return@postOrFail
      }
      done(result == 0, if (result == 0) "ok" else "REJECTED: the board refused dp$dpId (result $result)")
    }
  }

  /** Asks the board to push its current values now; they arrive through onDps. */
  fun queryDps(done: (success: Boolean, message: String) -> Unit) {
    postOrFail(done) {
      if (!handshakeComplete) {
        done(false, "NOT_CONNECTED: the board is linked but the handshake hasn't finished yet")
        return@postOrFail
      }
      val response = sendAndAwait(CODE_DEVICE_STATUS, ByteArray(0), setOf(CODE_DEVICE_STATUS))
      done(response != null, if (response == null) "NO_RESPONSE: no answer to the status query in ${RESPONSE_TIMEOUT_MS}ms" else "ok")
    }
  }

  // ------------------------------------------------------------------ connection

  /**
   * Waits for the disconnect to actually land before closing.
   *
   * disconnect() is asynchronous; calling close() right behind it — the original shape
   * here — releases the client's resources before the stack has finished tearing the
   * link down, which on recent platform versions leaves a zombie connection handle that
   * makes the *next* connectGatt() to this device fail or hang. gattOp reuses the
   * CONNECT slot: onConnectionStateChange releases it for STATE_DISCONNECTED same as it
   * does for STATE_CONNECTED, so this blocks until that callback actually fires (or
   * gives up after 2s if the link was already gone and nothing will ever call back).
   */
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
    handshakeComplete = false
    lastConnectionState = BluetoothProfile.STATE_DISCONNECTED
    forgetLoggedDps()
    reassembler.reset()
  }

  /**
   * Disables the parked-autoConnect path ([awaitAutoConnect]) until it has an on-device
   * confirmation of its own.
   *
   * Every handshake this app has ever gotten a real response from — including the
   * capture that fixed the device-info payload in the first place — went over this
   * scan-then-direct-connect path (`autoConnect=false`). The autoConnect path below
   * predates that success but was unreachable until today (the stored MAC was always
   * null), and the first time it ever ran against real hardware — three clean,
   * non-overlapping attempts, no concurrent sessions, both key derivations tried — the
   * board never answered the device-info request at all: not a wrong reply, no reply.
   * `autoConnect=true` connections are documented to behave differently enough
   * (connection parameters, controller-level whitelist handling) that this is the
   * leading suspect, but it hasn't been isolated from every other variable yet. Flip
   * this back on only after it has its own "confirmed on hardware" line — that attempt
   * predates the fix above that made `stop()` actually stop an in-flight connect cycle,
   * which was itself capable of producing exactly this symptom (a second, zombie session
   * silently eating the board's replies), so it needs re-testing on the fixed client
   * before it can be trusted — a process-wide runtime switch (not a per-client `val`)
   * so on-device verification, and later the Diagnostics screen, can flip it
   * without a rebuild. Defaults off until that verification lands.
   */
  private fun useAutoConnect(): Boolean = idleConnectStrategy == IdleConnectStrategy.AUTO_CONNECT

  /**
   * Whether the platform still reports a link to the board. [handshakeComplete] alone can
   * outlive it: Bluetooth turning off drops every connection without a disconnect callback.
   */
  private fun linkIsUp(): Boolean {
    val device = gatt?.device ?: return false
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager ?: return false
    return try {
      manager.getConnectionState(device, BluetoothProfile.GATT) == BluetoothProfile.STATE_CONNECTED
    } catch (e: Exception) {
      false
    }
  }

  private fun connectCycle() {
    cycleRunning = true
    try {
      if (stopped) return
      // Starting over a live session would replace its GATT without closing it.
      if (handshakeComplete) {
        if (linkIsUp()) {
          step("already connected; skipping a redundant connect cycle")
          phase = ConnectionPhase.CONNECTED
          return
        }
        endSession("session was still marked connected but its link is gone; closing it")
      }
      // Once the board's address is known, hand the waiting to the Bluetooth controller
      // rather than scanning on a timer. An autoConnect request is parked in the
      // controller and completes the moment the board starts advertising again, so a
      // board switched back on is picked up immediately instead of after whatever the
      // backoff had grown to — and it costs no host wakeups while it waits, which a
      // repeated scan loop very much does.
      if (useAutoConnect() && targetMac != null && awaitAutoConnect()) {
        reconnectAttempt = 0
        return
      }
      phase = ConnectionPhase.SCANNING
      step("scanning for the board…")
      val found = scanBlocking()
      if (found == null) {
        // Also true (and harmless to re-check) when scanBlocking() returned null
        // because stop() cancelled the scan — scheduleReconnect() itself no-ops once
        // stopped, this guard just avoids logging a "not found" line for that case.
        if (!stopped) {
          step("board not found in the ${SCAN_TIMEOUT_MS / 1000}s scan window")
          scheduleReconnect()
        }
        return
      }
      if (stopped) return
      step("found ${found.device.address} (${found.advertisedName ?: "no name"}, rssi ${found.rssi})")
      reconnectDevice = found.device
      // Notified on first-ever discovery, and also if a stored record predates address
      // type capture (an upgrade path) — either way the listener persists it.
      val learnedType = addressType == null && found.addressType != BluetoothDevice.ADDRESS_TYPE_UNKNOWN
      addressType = found.addressType
      if (targetMac == null || learnedType) listener.onAddressDiscovered(found.device.address, found.addressType)
      phase = ConnectionPhase.CONNECTING
      if (connectAndSubscribe(found.device) && handshakeWithBestDerivation()) {
        reconnectAttempt = 0
        return // worker free for publish/query calls; notifications keep flowing
      }
      if (stopped) return
      step("connect cycle failed; will retry")
      disconnectGatt()
      scheduleReconnect()
    } finally {
      cycleRunning = false
    }
  }

  private fun scanBlocking(): BoardScanner.Found? {
    val latch = CountDownLatch(1)
    var found: BoardScanner.Found? = null
    val ok = BoardScanner.findBoard(
      context,
      targetUuid,
      targetMac,
      SCAN_TIMEOUT_MS,
      onFound = { result ->
        found = result
        latch.countDown()
      },
      onProblem = { step(it) },
      onCancelReady = { cancel -> scanCancel = cancel },
    )
    if (!ok) return null
    latch.await(SCAN_TIMEOUT_MS + 2_000, TimeUnit.MILLISECONDS)
    scanCancel = null
    return found
  }

  /**
   * Parks an autoConnect request and blocks this worker until the board turns up.
   *
   * There is no timeout on the wait itself: that is the point, the request simply
   * stands until the board appears. Returns false if the link could not be brought all
   * the way up, letting the caller fall back to a scan.
   */
  private fun awaitAutoConnect(): Boolean {
    val adapter = BoardScanner.adapter(context) ?: return false
    val mac = targetMac!!.replace(":", "").uppercase().chunked(2).joinToString(":")
    val device = try {
      buildRemoteDevice(adapter, mac, addressType)
    } catch (e: IllegalArgumentException) {
      step("stored board address is not a valid MAC")
      return false
    }
    closeLeftoverGatt()
    step("waiting for the board to come into range… (address type ${addressTypeLabel(addressType)})")
    val status = gattOp(OpKind.CONNECT, "auto-connect", AUTO_CONNECT_WAIT_MS) {
      gatt = device.connectGatt(context, true, callback, BluetoothDevice.TRANSPORT_LE)
    }
    if (stopped) return false
    if (status != 0 || gatt == null || lastConnectionState != BluetoothProfile.STATE_CONNECTED) {
      disconnectGatt()
      return false
    }
    step("board came into range")
    reconnectDevice = device
    phase = ConnectionPhase.CONNECTING
    return finishConnect(device) && handshakeWithBestDerivation()
  }

  /**
   * `BluetoothAdapter.getRemoteLeDevice(address, type)` (API 33+) is the type-aware
   * reconnect API — the legacy `getRemoteDevice(address)` silently assumes a public
   * address, which is the leading suspect for why a parked autoConnect never got a
   * device-info reply on hardware the very first time this ran (see USE_AUTOCONNECT's
   * own history). Below API 33, or with no known type, there is no public API that
   * takes a type at all — `getRemoteDevice` is the only option regardless of what the
   * board's real address type is.
   */
  @SuppressLint("MissingPermission") // JS requests BLUETOOTH_CONNECT before this runs
  private fun buildRemoteDevice(adapter: BluetoothAdapter, mac: String, type: Int?): BluetoothDevice {
    if (Build.VERSION.SDK_INT >= 33 && type != null && type != BluetoothDevice.ADDRESS_TYPE_UNKNOWN) {
      return adapter.getRemoteLeDevice(mac, type)
    }
    return adapter.getRemoteDevice(mac)
  }

  private fun addressTypeLabel(type: Int?): String = when (type) {
    BluetoothDevice.ADDRESS_TYPE_PUBLIC -> "public"
    BluetoothDevice.ADDRESS_TYPE_RANDOM -> "random"
    null, BluetoothDevice.ADDRESS_TYPE_UNKNOWN -> "unknown (assuming public)"
    else -> "other ($type)"
  }

  /** A new connectGatt must never overwrite an open [gatt]: the old one would stay
   * registered with the stack, holding the board, with nothing left to close it. */
  private fun closeLeftoverGatt() {
    if (gatt == null) return
    step("closing the previous GATT connection before opening a new one")
    disconnectGatt()
  }

  private fun connectAndSubscribe(device: BluetoothDevice): Boolean {
    closeLeftoverGatt()
    val connectStatus = gattOp(OpKind.CONNECT, "connect") {
      gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
    }
    if (stopped) {
      // Stopped while the connect was in flight — the GATT it just brought up (if any)
      // belongs to nobody now; close it rather than handing it to finishConnect.
      try {
        gatt?.disconnect()
        gatt?.close()
      } catch (e: Exception) {
        Log.w(TAG, "gatt close failed after a stopped connect", e)
      }
      gatt = null
      return false
    }
    if (connectStatus != 0 || gatt == null || lastConnectionState != BluetoothProfile.STATE_CONNECTED) {
      step("connect failed (status $connectStatus)")
      return false
    }
    return finishConnect(device)
  }

  /**
   * Everything after the link is up: MTU, discovery, and the notify subscription.
   * Shared by the scan path and the autoConnect path, which differ only in how they
   * got connected.
   */
  private fun finishConnect(device: BluetoothDevice): Boolean {
    val current = gatt ?: return false
    if (stopped) return false

    // Frames are chunked to whatever this negotiates; the board is written to in one go.
    gattOp(OpKind.MTU, "mtu request") { current.requestMtu(247) }
    if (stopped) return false

    val discoverStatus = gattOp(OpKind.DISCOVER, "service discovery") { current.discoverServices() }
    if (stopped) return false
    if (discoverStatus != 0) {
      step("service discovery failed (status $discoverStatus)")
      return false
    }
    val service = current.getService(BoardScanner.SERVICE_FD50) ?: current.getService(SERVICE_A201)
    if (service == null) {
      step("board exposes neither the FD50 nor the A201 service")
      return false
    }
    // Full GATT dump: picking a plausible-looking service and characteristic pair and
    // getting silence back is indistinguishable from picking the wrong ones, and the
    // board's real layout is the only way to tell those apart.
    for (svc in current.services) {
      step("service ${svc.uuid}")
      for (ch in svc.characteristics) {
        step("  char ${ch.uuid} props 0x%02X".format(ch.properties))
      }
    }

    val isFd50 = service.uuid == BoardScanner.SERVICE_FD50
    val notify = service.getCharacteristic(if (isFd50) NOTIFY_CHAR_FD50 else NOTIFY_CHAR_A201)
    writeChar = service.getCharacteristic(if (isFd50) WRITE_CHAR_FD50 else WRITE_CHAR_A201)
    if (notify == null || writeChar == null) {
      step("board service lacks the expected notify/write characteristics")
      return false
    }

    // Logged because a board that offers only INDICATE, or a write characteristic
    // without WRITE_NO_RESPONSE, fails silently rather than with an error — the
    // properties are the only way to tell that apart from a protocol mismatch.
    step("notify props 0x%02X, write props 0x%02X".format(notify.properties, writeChar!!.properties))

    // Subscribing without writing the CCCD silently yields no notifications.
    current.setCharacteristicNotification(notify, true)
    val cccd = notify.getDescriptor(CCCD)
    if (cccd == null) {
      step("notify characteristic has no CCCD descriptor")
      return false
    }
    // An INDICATE-only characteristic stays silent if asked to notify.
    val indicateOnly = (notify.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY) == 0 &&
      (notify.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0
    cccd.value = if (indicateOnly) {
      BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
    } else {
      BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
    }
    val cccdStatus = gattOp(OpKind.DESCRIPTOR_WRITE, "CCCD write") { current.writeDescriptor(cccd) }
    if (stopped) return false
    if (cccdStatus != 0) {
      step("CCCD write failed (status $cccdStatus)")
      return false
    }
    step("subscribed to notifications")
    return true
  }

  /**
   * Device-info → session key → pair, trying the v3 derivation (localKey only) first
   * and falling back to v2 (localKey + secKey). Whichever the board accepts is
   * remembered so reconnects skip the failing one — that answer also decides whether
   * public users need one key or two.
   */
  private fun handshakeWithBestDerivation(): Boolean {
    val attempts = when (lastGoodDerivation) {
      null -> listOf(false, true)
      else -> listOf(lastGoodDerivation!!, !lastGoodDerivation!!)
    }
    for ((index, useSecKey) in attempts.withIndex()) {
      if (stopped) return false
      phase = ConnectionPhase.HANDSHAKING
      val variant = if (useSecKey) "v2 (localKey + secKey)" else "v3 (localKey only)"
      step("handshake attempt with $variant")
      if (handshakeOnce(useSecKey)) {
        lastGoodDerivation = useSecKey
        step("handshake succeeded with $variant")
        handshakeComplete = true
        phase = ConnectionPhase.CONNECTED
        lastFrameAtMs = SystemClock.elapsedRealtime()
        listener.onConnected()
        rideObserver?.onConnectionChanged(devId, true)
        worker.removeCallbacks(livenessRunnable)
        worker.postDelayed(livenessRunnable, livenessIntervalMs())
        return true
      }
      if (stopped) return false
      // Only reconnect if another attempt is actually coming. Reconnecting after the
      // *last* attempt failed left a fresh, subscribed-but-unused GATT connection open
      // with nothing to close it — this function returned false, and every caller reads
      // that as "not connected, nothing to clean up." connectCycle then fell through to
      // the scan path and opened yet another connection on top of it: the exact
      // two-sessions-to-one-board situation the stop()/onLinkLost fixes above exist to
      // prevent, just recreated one layer up.
      if (index == attempts.lastIndex) break
      // Re-subscribe from scratch before the next attempt — the link state after a
      // failed exchange is not trustworthy.
      disconnectGatt()
      if (stopped) return false
      val device = reconnectDevice ?: return false
      if (!connectAndSubscribe(device)) return false
    }
    if (!stopped) disconnectGatt()
    return false
  }

  /** The device object from the most recent scan, for re-subscribing between attempts. */
  private var reconnectDevice: BluetoothDevice? = null

  private fun handshakeOnce(useSecKey: Boolean): Boolean {
    val keyForLogin = TuyaCrypto.loginKey(localKey, if (useSecKey) secKey else null)
    val flagForLogin = TuyaCrypto.loginFlag(if (useSecKey) secKey else null)

    // The device-info request carries a two-byte payload on this board, and an empty
    // one is dropped without any reply — which is what "the board ignores a perfectly
    // valid frame" turned out to mean. Captured from a working session: with a
    // negotiated MTU of 247 the value sent is 243, i.e. the largest payload the client
    // will accept. The reference implementation sends nothing here, and keeps a
    // hardcoded list of product IDs needing a different device-info exchange; this
    // board is one of those, just not one it knows about.
    val infoRequest = byteArrayOf(
      ((negotiatedMtu - 4) ushr 8).toByte(),
      (negotiatedMtu - 4).toByte(),
    )
    val info = sendAndAwait(CODE_DEVICE_INFO, infoRequest, setOf(CODE_DEVICE_INFO), keyForLogin, flagForLogin)
    if (stopped) return false
    if (info == null) {
      step("no device-info response")
      return false
    }
    if (info.size < 46) {
      step("device-info response too short (${info.size} bytes)")
      return false
    }
    // Byte 2 is the board's actual protocol version; everything after the handshake
    // is framed with it rather than with the conservative starting value.
    protocolVersion = info[2].toInt() and 0xFF
    step("board reports protocol version $protocolVersion")
    // device_random is the 6 bytes at offset 6 of the device-info response.
    val deviceRandom = info.copyOfRange(6, 12)
    sessionKey = TuyaCrypto.sessionKey(localKey, if (useSecKey) secKey else null, deviceRandom)
    sessionFlag = TuyaCrypto.sessionFlag(if (useSecKey) secKey else null)
    step("device-info ok — session key derived")

    val pairResponse = sendAndAwait(CODE_PAIR, buildPairRequest(), setOf(CODE_PAIR))
    if (stopped) return false
    if (pairResponse == null) {
      step("no pair response")
      return false
    }
    val pairResult = pairResponse[0].toInt() and 0xFF
    if (pairResult != 0 && pairResult != 2) {
      step("pair rejected (result $pairResult)")
      return false
    }
    if (pairResult == 2) {
      step("board reports it is already paired (expected — we never unbind)")
    }
    return true
  }

  private fun buildPairRequest(): ByteArray =
    TuyaFrame.buildPairRequest(targetUuid, localKey, devId)

  /** Updates [lastKnownDp2Raw] from a decoded dp push, if this one carries dp2 —
   * Tuya only re-sends a dp when it changes, so a push with no "2" key means the
   * speed hasn't changed, not that it reset to unknown. */
  private fun recordSpeedHint(decoded: Map<String, Any?>) {
    (decoded["2"] as? Number)?.let { lastKnownDp2Raw = it.toInt() }
  }

  /** Riding needs the tighter interval to catch a genuine stall quickly; idle only
   * needs to notice within a rider-tolerable window, not race the board's own ~5s
   * idle push cadence (see [LIVENESS_CHECK_INTERVAL_IDLE_MS]'s own doc comment). */
  private fun livenessIntervalMs(): Long =
    if (lastKnownDp2Raw > 0) LIVENESS_CHECK_INTERVAL_RIDING_MS else LIVENESS_CHECK_INTERVAL_IDLE_MS

  /**
   * Self-rescheduling as long as the handshake stays complete — dies on its own once
   * it isn't (no explicit cancellation needed, see the doc comment where this is first
   * scheduled). Pings the board only when nothing has been heard from it for the full
   * interval; a board that's still chatty needs no extra traffic. A confirmed-lost link
   * (both pings unanswered) closes the GATT, which lets the existing
   * `onConnectionStateChange` → `onLinkLost` → reconnect path take over exactly as it
   * would for any other dropped link.
   *
   * A single missed ping retries once before giving up — a real board's own idle push
   * cadence measured live is close enough to [LIVENESS_CHECK_INTERVAL_IDLE_MS]'s
   * predecessor (the old single fixed interval) that this check could end up racing
   * the board's own scheduled push at the exact moment it fires, and one
   * contention-driven miss isn't proof the link is actually dead. Disconnecting on
   * that alone forced a hard GATT teardown while the board could still be
   * mid-transaction on its own send, which is a plausible way to wedge a cheap BLE
   * peripheral's stack until it's power-cycled — worse than the false disconnect itself.
   */
  private fun livenessCheck() {
    if (stopped || !handshakeComplete) return
    val intervalMs = livenessIntervalMs()
    val idleFor = SystemClock.elapsedRealtime() - lastFrameAtMs
    if (idleFor >= intervalMs) {
      step("liveness: no frame for ${idleFor}ms — pinging the board")
      var response = sendAndAwait(CODE_DEVICE_STATUS, ByteArray(0), setOf(CODE_DEVICE_STATUS), responseTimeoutMs = LIVENESS_PING_TIMEOUT_MS)
      if (response == null && !stopped && handshakeComplete) {
        step("liveness: first ping unanswered — retrying once before giving up")
        response = sendAndAwait(CODE_DEVICE_STATUS, ByteArray(0), setOf(CODE_DEVICE_STATUS), responseTimeoutMs = LIVENESS_PING_TIMEOUT_MS)
      }
      if (response == null && !stopped && handshakeComplete) {
        // Torn down here rather than via disconnect() and its callback: a link the radio
        // already dropped (Bluetooth turned off) never delivers one.
        endSession("liveness: no answer after two attempts — treating the link as lost")
        scheduleReconnect()
        return
      }
    }
    if (!stopped && handshakeComplete) worker.postDelayed(livenessRunnable, livenessIntervalMs())
  }

  /** Ends a session whose link can't be trusted, without waiting on a disconnect callback
   * to do it. The caller decides whether to reconnect. */
  private fun endSession(reason: String) {
    step(reason)
    handshakeComplete = false
    forgetLoggedDps()
    listener.onDisconnected(!stopped)
    rideObserver?.onConnectionChanged(devId, false)
    disconnectGatt()
  }

  private fun scheduleReconnect() {
    if (stopped) return
    phase = ConnectionPhase.BACKOFF
    // 5s → 10s → … capped at 300s.
    val delayMs = minOf(RECONNECT_MIN_MS shl reconnectAttempt.coerceAtMost(7), RECONNECT_MAX_MS)
    reconnectAttempt++
    listener.onDisconnected(true)
    step("reconnecting in ${delayMs / 1000}s")
    postCycle(delayMs)
  }

  /**
   * A mid-session drop used to leave `gatt` pointing at an already-dead connection —
   * this only ever ran handshakeComplete/forgetLoggedDps/onDisconnected and left the
   * close to whichever caller happened to call disconnectGatt() next, which nothing on
   * this path did. The next connect cycle then overwrote `gatt` with a fresh
   * connectGatt() result while the old object, never closed, sat leaking a client slot
   * in the platform's Bluetooth stack — exactly the "reuse without closing" pattern
   * that produces GATT_ERROR 133 on repeated reconnects, and OEM stacks (Samsung's
   * among them) hit this limit well before the platform default. STATE_DISCONNECTED has
   * already been delivered by the time this runs (it's what triggers the call), so
   * closing immediately here is safe — no second disconnect() needed first.
   *
   * Always closes, even for an already-stopped or never-handshaken client — leaving the
   * GATT open here is exactly the same leak regardless of why the link dropped. Only the
   * *reconnect* is conditional on `stopped`.
   *
   * The reconnect is only scheduled when [gatt] is still the lost GATT by the time the
   * posted half runs. Otherwise a connect cycle already owns the cleanup (`disconnectGatt()`
   * produces this same callback, and a drop mid-handshake fails the cycle, which
   * reschedules itself), and a second schedule would queue a cycle over its session.
   */
  private fun onLinkLost(lost: BluetoothGatt) {
    val wasHandshakeComplete = handshakeComplete
    handshakeComplete = false
    if (wasHandshakeComplete) {
      forgetLoggedDps()
      listener.onDisconnected(!stopped)
      // Fed regardless of `stopped` — a genuine link loss ends whatever ride is active
      // even if this client is also being torn down for an unrelated reason (a forget,
      // a device switch) at the same moment.
      rideObserver?.onConnectionChanged(devId, false)
    }
    val posted = worker.post {
      closeQuietly(lost)
      if (gatt !== lost) return@post
      gatt = null
      writeChar = null
      reassembler.reset()
      if (!stopped) scheduleReconnect()
    }
    // A stopped client's thread has quit and drops the post; the close still has to happen.
    if (!posted) closeQuietly(lost)
  }

  private fun closeQuietly(g: BluetoothGatt) {
    try {
      g.close()
    } catch (e: Exception) {
      Log.w(TAG, "gatt close failed after link loss", e)
    }
  }

  // ------------------------------------------------------- protocol send/receive

  /**
   * Sends one frame (fragmented into 20-byte writes) and waits for the board's
   * response to our seq number. `key`/`flag` default to the derived session key.
   */
  private fun sendAndAwait(
    code: Int,
    data: ByteArray,
    expectedCodes: Set<Int>,
    key: ByteArray? = null,
    flag: Int = -1,
    responseTimeoutMs: Long = RESPONSE_TIMEOUT_MS,
  ): ByteArray? {
    if (stopped) return null
    val sendKey = key ?: sessionKey ?: return null
    val sendFlag = if (flag >= 0) flag else sessionFlag
    val seq = seqNum++
    val iv = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }

    val awaited = AwaitedResponse(seq, expectedCodes)
    awaitedResultCode = -1
    awaitedResultData = ByteArray(0)
    awaitedResponse.set(awaited)

    val packets = TuyaFrame.buildPackets(seq, 0, code, data, sendKey, iv, sendFlag, protocolVersion, negotiatedMtu - 3)
    for (packet in packets) {
      val status = gattOp(OpKind.CHAR_WRITE, "write code $code") { writeFragments(packet) }
      if (status != 0) {
        awaitedResponse.set(null)
        step("write for code $code failed (status $status)")
        return null
      }
    }

    val answered = awaited.latch.await(responseTimeoutMs, TimeUnit.MILLISECONDS)
    awaitedResponse.set(null)
    if (!answered) {
      step("no response to code $code within ${responseTimeoutMs}ms")
      return null
    }
    return awaitedResultData
  }

  /** Issues one 20-byte (or smaller) GATT write with the right API-level call shape. */
  private fun writeFragments(packet: ByteArray) {
    val char = writeChar ?: throw IllegalStateException("no write characteristic")
    val current = gatt ?: throw IllegalStateException("not connected")
    // A characteristic that does not advertise WRITE_NO_RESPONSE drops such writes
    // instead of rejecting them, which is indistinguishable from the board ignoring us.
    val writeType = if (char.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) {
      BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
    } else {
      BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
    }
    if (Build.VERSION.SDK_INT >= 33) {
      // The API-33 overload reports refusal by return value; ignoring it leaves the
      // operation waiting on a callback that will never come.
      val result = current.writeCharacteristic(char, packet, writeType)
      if (result != 0) {
        step("write rejected by the stack (code $result)")
        releaseOp(OpKind.CHAR_WRITE, result)
      }
    } else {
      @Suppress("DEPRECATION")
      char.writeType = writeType
      @Suppress("DEPRECATION")
      char.value = packet
      @Suppress("DEPRECATION")
      if (!current.writeCharacteristic(char)) {
        step("write rejected by the stack")
        releaseOp(OpKind.CHAR_WRITE, -1)
      }
    }
  }

  /**
   * Notification path: reassembles fragments, decrypts, and dispatches. Runs on a
   * Binder thread — anything that writes back is posted to the worker.
   */
  private fun onNotification(data: ByteArray) {
    lastFrameAtMs = SystemClock.elapsedRealtime()
    // Raw hex only until the handshake settles. Whether the board answers at all, and
    // with what, is the first thing worth knowing when a handshake fails — but a
    // connected board pushes telemetry several times a second, and logging every frame
    // buried every other event in thousands of unreadable hex lines. Once connected the
    // decoded datapoints below are the useful record.
    if (!handshakeComplete) {
      step("notification ${data.size}B: ${data.joinToString("") { "%02x".format(it) }}")
    }
    when (val outcome = reassembler.accept(data)) {
      is Reassembler.Outcome.Incomplete -> return
      is Reassembler.Outcome.Malformed -> {
        step("malformed notification stream: ${outcome.reason}")
        return
      }
      is Reassembler.Outcome.Complete -> {
        val frame = try {
          TuyaFrame.parseFrame(outcome.payload, ::keyForSecurityFlag)
        } catch (e: TuyaProtocolException) {
          step("frame rejected: ${e.message}")
          return
        }
        dispatchFrame(frame)
      }
    }
  }

  /**
   * The flag byte on the wire names the key the sender used, so the derivation is read
   * off the frame rather than inferred from which handshake attempt is in flight.
   * Guessing it would break the v3-first probe: the board answers a v3 request with a
   * v3-encrypted response, and decrypting that with the v2 key fails, making v3 look
   * unsupported on every board that happens to own a secKey.
   */
  private fun keyForSecurityFlag(flag: Int): ByteArray? = when (flag) {
    TuyaCrypto.LOGIN_FLAG_V3 -> TuyaCrypto.loginKey(localKey, null)
    TuyaCrypto.LOGIN_FLAG_V2 -> secKey?.let { TuyaCrypto.loginKey(localKey, it) }
    TuyaCrypto.SESSION_FLAG_V3, TuyaCrypto.SESSION_FLAG_V2 -> sessionKey
    1 -> authKey
    else -> null
  }

  @Volatile private var authKey: ByteArray? = null

  private fun dispatchFrame(frame: ParsedFrame) {
    // An awaited response is matched first: response_to names the seq we sent.
    val awaiting = awaitedResponse.get()
    if (awaiting != null && frame.responseTo == awaiting.seq && frame.code in awaiting.codes) {
      awaitedResultCode = frame.code
      awaitedResultData = frame.data
      awaiting.latch.countDown()
      if (frame.code == CODE_DEVICE_INFO && frame.data.size >= 46) {
        authKey = frame.data.copyOfRange(14, 46)
      }
      return
    }

    when (frame.code) {
      CODE_RECEIVE_DP -> handleDpPush(frame, TuyaDatapoint.decode(frame.data, 0, 1), null)
      CODE_RECEIVE_TIME_DP -> {
        val (_, pos) = parseTimestamp(frame.data, 0) ?: return
        handleDpPush(frame, TuyaDatapoint.decode(frame.data, pos, 1), null)
      }
      CODE_RECEIVE_SIGN_DP -> {
        if (frame.data.size < 3) return
        val dpSeq = ((frame.data[0].toInt() and 0xFF) shl 8) or (frame.data[1].toInt() and 0xFF)
        val flags = frame.data[2].toInt() and 0xFF
        handleDpPush(
          frame,
          TuyaDatapoint.decode(frame.data, 2, 1),
          byteArrayOf((dpSeq ushr 8).toByte(), dpSeq.toByte(), flags.toByte(), 0),
        )
      }
      CODE_RECEIVE_SIGN_TIME_DP -> {
        if (frame.data.size < 4) return
        val dpSeq = ((frame.data[0].toInt() and 0xFF) shl 8) or (frame.data[1].toInt() and 0xFF)
        val flags = frame.data[2].toInt() and 0xFF
        val (_, pos) = parseTimestamp(frame.data, 3) ?: return
        handleDpPush(
          frame,
          TuyaDatapoint.decode(frame.data, pos, 1),
          byteArrayOf((dpSeq ushr 8).toByte(), dpSeq.toByte(), flags.toByte(), 0),
        )
      }
      CODE_RECEIVE_DP_V4, CODE_RECEIVE_TIME_DP_V4 -> handleV4DpPush(frame)
      CODE_TIME1_REQ -> worker.post { answerTime1(frame) }
      CODE_TIME2_REQ -> worker.post { answerTime2(frame) }
      else -> step("unhandled frame code 0x%04X (response_to ${frame.responseTo})".format(frame.code))
    }
  }

  /** Emits the datapoints and answers the board per the opcode's response shape. */
  private fun handleDpPush(frame: ParsedFrame, dps: List<TuyaDp>, responseData: ByteArray?) {
    val decoded = dpsToJs(dps)
    logDps(decoded)
    recordSpeedHint(decoded)
    listener.onDps(decoded)
    rideObserver?.onDps(devId, decoded)
    worker.post { sendResponseOnly(frame.code, responseData ?: ByteArray(0), frame.seqNum) }
  }

  private fun handleV4DpPush(frame: ParsedFrame) {
    val data = frame.data
    if (data.size < 7 || data[0].toInt() != 0) return
    val sendFlags = data[5].toInt() and 0xFF
    val pos = if (frame.code == CODE_RECEIVE_TIME_DP_V4) parseTimestamp(data, 7)?.second ?: return else 7
    val decoded = dpsToJs(TuyaDatapoint.decode(data, pos, 2))
    logDps(decoded)
    recordSpeedHint(decoded)
    listener.onDps(decoded)
    rideObserver?.onDps(devId, decoded)
    if (sendFlags and 0x80 == 0) {
      val ack = data.copyOfRange(0, 7) + byteArrayOf(0)
      worker.post { sendResponseOnly(frame.code, ack, frame.seqNum) }
    }
  }

  /** Sends a response frame (response_to = the board's seq) without waiting for a reply. */
  private fun sendResponseOnly(code: Int, data: ByteArray, responseTo: Int) {
    val key = sessionKey ?: return
    val seq = seqNum++
    val iv = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
    val packets = TuyaFrame.buildPackets(seq, responseTo, code, data, key, iv, sessionFlag, protocolVersion, negotiatedMtu - 3)
    for (packet in packets) {
      val status = gattOp(OpKind.CHAR_WRITE, "response code $code") { writeFragments(packet) }
      if (status != 0) {
        step("response write for code $code failed (status $status)")
        return
      }
    }
  }

  /** Answers 0x8011: unix millis as ASCII followed by int16 BE of the 15-minute timezone units. */
  private fun answerTime1(request: ParsedFrame) {
    val millis = System.currentTimeMillis()
    val tzUnits = timezoneUnits()
    val payload = millis.toString().toByteArray(Charsets.US_ASCII) +
      byteArrayOf((tzUnits ushr 8).toByte(), tzUnits.toByte())
    sendResponseOnly(CODE_TIME1_REQ, payload, request.seqNum)
  }

  /** Answers 0x8012: 7 packed date/time bytes followed by the same timezone int16. */
  private fun answerTime2(request: ParsedFrame) {
    val cal = Calendar.getInstance()
    val tzUnits = timezoneUnits()
    val payload = byteArrayOf(
      (cal.get(Calendar.YEAR) % 100).toByte(),
      (cal.get(Calendar.MONTH) + 1).toByte(),
      cal.get(Calendar.DAY_OF_MONTH).toByte(),
      cal.get(Calendar.HOUR_OF_DAY).toByte(),
      cal.get(Calendar.MINUTE).toByte(),
      cal.get(Calendar.SECOND).toByte(),
      ((cal.get(Calendar.DAY_OF_WEEK) + 5) % 7).toByte(), // tm_wday: Monday = 0
      (tzUnits ushr 8).toByte(),
      tzUnits.toByte(),
    )
    sendResponseOnly(CODE_TIME2_REQ, payload, request.seqNum)
  }

  /**
   * The wire value is `-timezone_offset_seconds / 36` with the offset measured
   * *west*-positive (Python's `time.timezone` convention) — i.e. the east-positive
   * JVM offset divided by 36: UTC+2 → 200, UTC-5 → -500.
   */
  private fun timezoneUnits(): Int =
    java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 1000 / 36

  /** Timestamp field: type byte 0 = 13 ASCII millis chars, 1 = 4-byte BE seconds. */
  private fun parseTimestamp(data: ByteArray, startPos: Int): Pair<Long, Int>? {
    if (startPos >= data.size) return null
    return when (data[startPos].toInt() and 0xFF) {
      0 -> {
        val end = startPos + 14
        if (end > data.size) return null
        data.copyOfRange(startPos + 1, end).toString(Charsets.US_ASCII).toLongOrNull()?.let { it to end }
      }
      1 -> {
        val end = startPos + 5
        if (end > data.size) return null
        var value = 0L
        for (b in data.copyOfRange(startPos + 1, end)) value = (value shl 8) or (b.toLong() and 0xFF)
        value to end
      }
      else -> null
    }
  }

  /** JS-friendly dp values: bool → boolean, value/enum → number, string → string, raw/bitmap → hex. */
  private fun dpsToJs(dps: List<TuyaDp>): Map<String, Any?> {
    val out = LinkedHashMap<String, Any?>()
    for (dp in dps) {
      out[dp.id.toString()] = when (val v = dp.value) {
        is TuyaDpValue.Raw -> v.bytes.toHex()
        is TuyaDpValue.Bitmap -> v.bytes.toHex()
        is TuyaDpValue.Bool -> v.value
        is TuyaDpValue.Value -> v.value
        is TuyaDpValue.Enum -> v.index
        is TuyaDpValue.Str -> v.value
      }
    }
    return out
  }

  /** Maps a JS-initiated write to a datapoint; the schema decides the type tag. */
  private fun dpForWrite(dpId: Int, type: String, value: Any?): TuyaDp {
    val (dpType, dpValue) = when (type) {
      "bool" -> TuyaDpType.BOOL to TuyaDpValue.Bool(value == true || value == 1 || value == "1")
      "value" -> TuyaDpType.VALUE to TuyaDpValue.Value((value as? Number)?.toInt() ?: value.toString().toInt())
      "enum" -> TuyaDpType.ENUM to TuyaDpValue.Enum((value as? Number)?.toInt() ?: value.toString().toInt())
      "string" -> TuyaDpType.STRING to TuyaDpValue.Str(value.toString())
      "raw" -> TuyaDpType.RAW to TuyaDpValue.Raw((value as? String)?.hexToBytes() ?: ByteArray(0))
      else -> throw IllegalArgumentException("unsupported dp type '$type'")
    }
    return TuyaDp(dpId, dpType, dpValue)
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

  private fun String.hexToBytes(): ByteArray =
    chunked(2).map { it.toInt(16).toByte() }.toByteArray()

  /** "v2" / "v3" once the handshake settled which derivation the board accepts; null before. */
  fun derivationName(): String? = when (lastGoodDerivation) {
    true -> "v2"
    false -> "v3"
    null -> null
  }

  /**
   * The decoded datapoints, which is what a reader of the log actually needs — the raw
   * frame they arrived in is only interesting while the handshake is still failing.
   * Repeats are dropped: the board re-sends unchanged telemetry continuously, and
   * logging that is what made the raw dump unreadable in the first place.
   */
  // Written from the Binder notification thread and cleared from the worker on
  // reconnect, so both sides are synchronized on the map itself.
  private val lastLoggedDps = HashMap<String, Any?>()

  // A connected board pushes telemetry (speed, especially) several times a second, and
  // logging every changed value as it changes produces one log line — and one remote
  // POST via lib/log.ts — per push, for the whole ride. Real values still change this
  // fast; what changes is how often that's WORTH a log line. Coalesced into one line at
  // most every DPS_LOG_THROTTLE_MS, carrying whatever changed since the last flush.
  private val pendingDpsLogLines = LinkedHashMap<String, Any?>()
  @Volatile private var lastDpsLogFlushMs = 0L
  @Volatile private var dpsLogFlushScheduled = false

  private fun logDps(dps: Map<String, Any?>) {
    val changed = synchronized(lastLoggedDps) {
      val diff = dps.filter { (id, value) -> !lastLoggedDps.containsKey(id) || lastLoggedDps[id] != value }
      lastLoggedDps.putAll(diff)
      diff
    }
    if (changed.isEmpty()) return
    val now = SystemClock.elapsedRealtime()
    synchronized(pendingDpsLogLines) {
      pendingDpsLogLines.putAll(changed)
      val elapsed = now - lastDpsLogFlushMs
      if (elapsed >= DPS_LOG_THROTTLE_MS) {
        flushDpsLogLocked()
      } else if (!dpsLogFlushScheduled) {
        dpsLogFlushScheduled = true
        worker.postDelayed({ synchronized(pendingDpsLogLines) { flushDpsLogLocked() } }, DPS_LOG_THROTTLE_MS - elapsed)
      }
    }
  }

  /** Caller must hold the `pendingDpsLogLines` monitor. */
  private fun flushDpsLogLocked() {
    dpsLogFlushScheduled = false
    if (pendingDpsLogLines.isEmpty()) return
    lastDpsLogFlushMs = SystemClock.elapsedRealtime()
    val toLog = LinkedHashMap(pendingDpsLogLines)
    pendingDpsLogLines.clear()
    step("dps ${toLog.entries.joinToString(", ") { "dp${it.key}=${it.value}" }}")
  }

  /** A reconnect should re-log the board's full state, not stay quiet until something
   * differs from whatever the previous session last saw. */
  private fun forgetLoggedDps() {
    synchronized(lastLoggedDps) { lastLoggedDps.clear() }
    synchronized(pendingDpsLogLines) {
      pendingDpsLogLines.clear()
      lastDpsLogFlushMs = 0L
    }
  }

  fun isConnected(): Boolean = handshakeComplete

  /**
   * Re-points a running client at a new listener.
   *
   * A client can be created by either side: the foreground service brings one up from
   * natively stored credentials with do-nothing callbacks, and JS brings one up with
   * callbacks that drive the whole app. Whichever starts first wins the devId, so
   * without this the JS layer could attach to a live connection and never receive a
   * single event — the board would be genuinely connected while the app showed it as
   * searching and every datapoint went to the service's empty callbacks.
   */
  fun adoptListener(next: Listener) {
    listener = next
    // The adopting side missed onConnected if the handshake already finished, and has
    // no other way to learn the current state.
    if (handshakeComplete) {
      next.onStep("[$clientTag] adopted an already-connected session")
      next.onConnected()
    }
  }
}
