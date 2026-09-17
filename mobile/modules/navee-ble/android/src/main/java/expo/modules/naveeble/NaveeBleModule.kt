package expo.modules.naveeble

import android.annotation.SuppressLint
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.Handler
import android.os.Looper
import expo.modules.boardble.BoardBleClient
import expo.modules.boardble.BoardBleDiagnostics
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

/**
 * JS bridge for NAVEE scooters. Deliberately mirrors `BoardBle`'s surface: the same
 * `onDirect*` event names and payloads, and the same connect/reconnect/phase functions,
 * so lib/deviceLink's session layer drives either brand through one code path
 * (lib/deviceLink/transport.ts picks the module). What's NAVEE-only is the account
 * sign-in, settings writes, and the raw-frame/auth events for protocol verification.
 */
@SuppressLint("MissingPermission") // JS requests Bluetooth permission before scanning/connecting
class NaveeBleModule : Module() {
  /** One account session per process, memory only, like BoardBle's Tuya session. */
  private val cloud = NaveeCloudClient()

  /** Network calls must stay off the JS and main threads. */
  private val io = Executors.newSingleThreadExecutor()

  private var pairingScan: ScanCallback? = null
  /** Bumped per scan, so an earlier scan's timer can't end a newer scan early. */
  private var pairingScanGeneration = 0
  private val main = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("NaveeBle")

    Events(
      "onDirectDpUpdate",
      "onDirectConnectionChanged",
      "onDirectStep",
      "onDirectAddressDiscovered",
      "onNaveeFrame",
      "onNaveeAuthResult",
      "onScanResult",
    )

    // ----------------------------------------------------------- account (sign-in)

    AsyncFunction("captcha") { promise: Promise ->
      io.execute {
        try {
          val captcha = cloud.captcha()
          promise.resolve(mapOf("imageBase64" to captcha.imageBase64, "uuid" to captcha.uuid))
        } catch (e: NaveeCloudException) {
          promise.reject(e.code, e.message, null)
        }
      }
    }

    AsyncFunction("signIn") { email: String, password: String, captchaCode: String, captchaUuid: String, promise: Promise ->
      io.execute {
        try {
          val userId = cloud.signIn(email, password, captchaCode, captchaUuid)
          promise.resolve(mapOf("userId" to userId.toDouble()))
        } catch (e: NaveeCloudException) {
          promise.reject(e.code, e.message, null)
        }
      }
    }

    AsyncFunction("listVehicles") { promise: Promise ->
      io.execute {
        try {
          promise.resolve(
            cloud.listVehicles().map {
              mapOf(
                "mac" to it.mac,
                "name" to it.name,
                "carNo" to it.carNo,
                "productId" to it.productId,
                "shareUserId" to it.shareUserId.toDouble(),
              )
            },
          )
        } catch (e: NaveeCloudException) {
          promise.reject(e.code, e.message, null)
        }
      }
    }

    Function("isSignedIn") { cloud.isSignedIn }

    /** The signed-in account's own id, or null. */
    Function("signedInUserId") { cloud.userId?.toDouble() }

    Function("signOut") { cloud.signOut() }

    // ------------------------------------------------------------ pairing scan

    /** Reports nearby NAVEE scooters through onScanResult until the timeout or stopScan. */
    AsyncFunction("scan") { timeoutMs: Int, promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.reject("NO_CONTEXT", "No React context", null)
      val scanner = NaveeBleClient.adapter(context)?.bluetoothLeScanner
        ?: return@AsyncFunction promise.reject("BT_UNAVAILABLE", "Bluetooth is off or unavailable.", null)
      stopPairingScan(context)
      val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
          val record = result.scanRecord
          val hasCompany = record?.getManufacturerSpecificData(NaveeAdvertisement.COMPANY_ID) != null
          val name = record?.deviceName ?: result.device.name
          if (!NaveeAdvertisement.looksLikeNavee(name, hasCompany)) return
          sendEvent(
            "onScanResult",
            mapOf(
              "address" to result.device.address,
              "name" to name,
              "rssi" to result.rssi,
              "cloudMac" to NaveeAdvertisement.cloudMac(record?.bytes),
              "productId" to NaveeAdvertisement.productId(record?.bytes),
              "addressType" to expo.modules.boardble.BoardScanner.addressTypeOf(result.device),
            ),
          )
        }
      }
      try {
        scanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), callback)
      } catch (e: SecurityException) {
        return@AsyncFunction promise.reject("PERMISSION", "Bluetooth permission is needed to scan.", null)
      }
      pairingScan = callback
      val generation = ++pairingScanGeneration
      main.postDelayed({
        if (generation == pairingScanGeneration) stopPairingScan(context)
        promise.resolve(null)
      }, timeoutMs.toLong())
    }

    Function("stopScan") {
      appContext.reactContext?.let { stopPairingScan(it) }
    }

    // -------------------------------------------------------------- session

    /** Starts (or adopts) the persistent session for a paired scooter. Idempotent. */
    Function("connectDirect") { devId: String, cloudMac: String?, address: String?, addressType: Int?, accountId: Double, bindFlag: Int ->
      val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "No React context", null)
      val listener = object : NaveeBleClient.Listener {
        override fun onStep(message: String) = sendEvent("onDirectStep", mapOf("devId" to devId, "message" to message))
        override fun onConnected() = sendEvent("onDirectConnectionChanged", mapOf("devId" to devId, "connected" to true))
        override fun onDisconnected(willRetry: Boolean) =
          sendEvent("onDirectConnectionChanged", mapOf("devId" to devId, "connected" to false, "willRetry" to willRetry))
        override fun onDps(dps: Map<String, Any?>) = sendEvent("onDirectDpUpdate", mapOf("devId" to devId, "dps" to dps))
        override fun onAddressDiscovered(address: String, addressType: Int) =
          sendEvent("onDirectAddressDiscovered", mapOf("devId" to devId, "address" to address, "addressType" to addressType))
        override fun onFrame(cmd: Int, status: Int, hex: String) =
          sendEvent("onNaveeFrame", mapOf("devId" to devId, "cmd" to cmd, "status" to status, "hex" to hex, "at" to System.currentTimeMillis().toDouble()))
        override fun onAuthResult(ok: Boolean, status: Int?, message: String) =
          sendEvent("onNaveeAuthResult", mapOf("devId" to devId, "ok" to ok, "status" to status, "message" to message))
      }

      NaveeBleClient.activeClients[devId]?.let { existing ->
        existing.updateCredentials(AuthIdentity(accountId.toLong(), bindFlag), address, addressType)
        existing.adoptListener(listener)
        if (!existing.isConnected()) existing.restartNow()
        return@Function
      }
      val client = NaveeBleClient(
        context,
        devId,
        AuthIdentity(accountId.toLong(), bindFlag),
        cloudMac?.let { NaveeAdvertisement.normalizeMac(it) },
        address,
        listener,
        addressType,
      )
      NaveeBleClient.activeClients[devId] = client
      client.start()
    }

    Function("reconnectNow") { devId: String ->
      NaveeBleClient.activeClients[devId]?.restartNow()
    }

    Function("connectionPhase") { devId: String ->
      NaveeBleClient.activeClients[devId]?.phase?.name?.lowercase()
    }

    Function("isDirectConnected") { devId: String ->
      NaveeBleClient.activeClients[devId]?.isConnected() ?: false
    }

    Function("disconnectDirect") { devId: String ->
      NaveeBleClient.activeClients.remove(devId)?.stop()
    }

    /** Shared with BoardBle's buffer, so the debug console shows both brands' steps. */
    Function("recentDiagnostics") {
      BoardBleDiagnostics.recent()
    }

    /**
     * Keeps the process alive through RideService, the app's single foreground service —
     * the scooter session lives in this process. Reconnecting after the process itself
     * is killed is Tuya-only for now.
     */
    Function("startBackgroundReconnect") {
      appContext.reactContext?.let { BoardBleClient.foregroundOwner?.start(it) }
    }

    Function("stopBackgroundReconnect") {}

    AsyncFunction("queryDpsDirect") { devId: String, promise: Promise ->
      val client = NaveeBleClient.activeClients[devId]
        ?: return@AsyncFunction promise.reject("NO_SESSION", "no Bluetooth session for this scooter, nothing is connected to it", null)
      client.queryStatus { ok, message -> if (ok) promise.resolve(null) else promise.reject(message.substringBefore(':'), message, null) }
    }

    AsyncFunction("writeSetting") { devId: String, key: String, value: Int, promise: Promise ->
      val client = NaveeBleClient.activeClients[devId]
        ?: return@AsyncFunction promise.reject("NO_SESSION", "no Bluetooth session for this scooter, nothing is connected to it", null)
      client.writeSetting(key, value) { ok, message -> if (ok) promise.resolve(null) else promise.reject(message.substringBefore(':'), message, null) }
    }
  }

  private fun stopPairingScan(context: android.content.Context) {
    val callback = pairingScan ?: return
    pairingScan = null
    try {
      NaveeBleClient.adapter(context)?.bluetoothLeScanner?.stopScan(callback)
    } catch (e: Exception) {
      // Bluetooth turned off mid-scan; nothing left to stop.
    }
  }
}
