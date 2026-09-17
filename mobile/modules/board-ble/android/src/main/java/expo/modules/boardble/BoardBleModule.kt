package expo.modules.boardble

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * SDK-free board link. The protocol core (TuyaCrypto/TuyaFrame/TuyaDatapoint) is pure
 * Kotlin and JVM-testable; this module wires the GATT client and (in a later phase)
 * the Tuya mobile API sign-in to JavaScript.
 */
class BoardBleModule : Module() {
  companion object {
    private const val SELF_HEAL_WORK = "board_ble_self_heal"
  }

  /** One mobile-API session per process; signOut() clears it. Never persisted. */
  private val mobileClient = TuyaMobileClient()

  override fun definition() = ModuleDefinition {
    Name("BoardBle")

    // Every name passed to sendEvent must appear here. Expo rejects an undeclared
    // event by throwing, and these are emitted from the BLE worker thread, where an
    // uncaught throw is fatal to the process rather than a failed call.
    Events("onDirectDpUpdate", "onDirectConnectionChanged", "onDirectStep", "onDirectAddressDiscovered")

    // ------------------------------------------------- Tuya mobile API (sign-in)

    AsyncFunction("signIn") { email: String, password: String, countryCode: String, promise: Promise ->
      try {
        val uid = mobileClient.signIn(email, password, countryCode)
        promise.resolve(mapOf("uid" to uid))
      } catch (e: TuyaMobileException) {
        promise.reject(e.code, e.message, null)
      } catch (e: Exception) {
        promise.reject("API_ERROR", e.message ?: "Sign-in failed.", null)
      }
    }

    AsyncFunction("listDevices") { promise: Promise ->
      try {
        promise.resolve(
          mobileClient.listDevices().map {
            mapOf(
              "devId" to it.devId,
              "uuid" to it.uuid,
              "name" to it.name,
              "productId" to it.productId,
            )
          },
        )
      } catch (e: TuyaMobileException) {
        promise.reject(e.code, e.message, null)
      } catch (e: Exception) {
        promise.reject("API_ERROR", e.message ?: "Couldn't list your devices.", null)
      }
    }

    AsyncFunction("fetchKeys") { devId: String, promise: Promise ->
      try {
        val keys = mobileClient.fetchKeys(devId)
        promise.resolve(
          mapOf(
            "devId" to keys.devId,
            "uuid" to keys.uuid,
            "productId" to keys.productId,
            "localKey" to keys.localKey,
            "secKey" to keys.secKey,
            "schemaJson" to keys.schemaJson,
          ),
        )
      } catch (e: TuyaMobileException) {
        promise.reject(e.code, e.message, null)
      } catch (e: Exception) {
        promise.reject("API_ERROR", e.message ?: "Couldn't fetch this board's keys.", null)
      }
    }

    Function("signOut") {
      mobileClient.signOut()
    }

    Function("isSignedInToTuya") {
      mobileClient.isSignedIn
    }

    /** Starts (or keeps) the persistent direct-BLE session for a paired board. */
    Function("connectDirect") { devId: String, uuid: String?, address: String?, localKey: String, secKey: String?, addressType: Int? ->
      val context = appContext.reactContext
        ?: throw CodedException("NO_CONTEXT", "No React context", null)
      val listener = object : BoardBleClient.Listener {
        override fun onStep(message: String) {
          sendEvent("onDirectStep", mapOf("devId" to devId, "message" to message))
        }

        override fun onConnected() {
          sendEvent("onDirectConnectionChanged", mapOf("devId" to devId, "connected" to true))
        }

        override fun onDisconnected(willRetry: Boolean) {
          sendEvent(
            "onDirectConnectionChanged",
            mapOf("devId" to devId, "connected" to false, "willRetry" to willRetry),
          )
        }

        override fun onDps(update: Map<String, Any?>) {
          sendEvent("onDirectDpUpdate", mapOf("devId" to devId, "dps" to update))
        }

        override fun onAddressDiscovered(address: String, addressType: Int) {
          // Both stores: JS owns the credentials the next connect is built from, and
          // the native copy is what a process the system recreated has to work with.
          sendEvent("onDirectAddressDiscovered", mapOf("devId" to devId, "address" to address, "addressType" to addressType))
          BoardCredentialStore.load(context)?.let { stored ->
            // Also fills in the address type on an existing record that predates
            // capturing it (an upgrade path), not just a first-ever discovery.
            if (stored.devId == devId && (stored.mac.isNullOrEmpty() || stored.addressType == null)) {
              BoardCredentialStore.save(context, stored.copy(mac = address, addressType = addressType))
            }
          }
        }
      }

      // The foreground service may already have brought this board up from natively
      // stored credentials, with callbacks that do nothing — or a previous call to this
      // same function already created one. Either way, ADOPT it rather than stopping and
      // replacing it: a replaced client's in-flight connect attempt used to keep running
      // as a zombie racing the new one for the same board — several clients handshaking
      // at once, fighting over one GATT write slot, one of them silently winning the board while
      // JS showed "searching" forever. Not connected doesn't mean stuck: restartNow()
      // below cancels whatever backoff it's sitting in and starts a fresh attempt on the
      // SAME instance, which is the fast-reconnect the old stop-and-replace was trying to
      // achieve, without the zombie.
      BoardBleClient.activeClients[devId]?.let { existing ->
        existing.updateCredentials(localKey, secKey, address, addressType)
        existing.adoptListener(listener)
        if (!existing.isConnected()) existing.restartNow()
        return@Function
      }

      val client = BoardBleClient(context, devId, localKey, secKey, uuid, address, listener, addressType)
      BoardBleClient.activeClients[devId] = client
      client.start()
    }

    /** Interrupts whatever backoff the board's client is currently sitting in and starts
     * a fresh connect attempt on the same instance — the foreground-return reconnect kick
     * (`kickReconnectOnForeground`) uses this instead of tearing the client down, for the
     * same reason `connectDirect` above adopts rather than replaces. No-op if nothing is
     * registered for this devId, if a connect attempt is already in flight, or if the
     * board is still connected. */
    Function("reconnectNow") { devId: String ->
      BoardBleClient.activeClients[devId]?.restartNow()
    }

    /** The client's own view of what it's doing right now (`idle | scanning |
     * connecting | handshaking | connected | backoff`), so JS can reconcile against a
     * real, settled state instead of guessing from a plain connected/not-connected
     * boolean — reconciling while the client is mid-handshake is what tore down a
     * connection ~150ms after it succeeded. Null if nothing is registered. */
    Function("connectionPhase") { devId: String ->
      BoardBleClient.activeClients[devId]?.phase?.name?.lowercase()
    }

    /** The last ~200 step lines across every client this process has run, including the
     * foreground service's own client before JS ever adopted it — see
     * BoardBleDiagnostics's own doc comment. For the debug console / exported
     * diagnostics, not the live event stream. */
    Function("recentDiagnostics") {
      BoardBleDiagnostics.recent()
    }

    /** "auto_connect" | "scan_then_direct" — see BoardBleClient.IdleConnectStrategy's
     * own doc comment. Runtime-switchable for on-device verification (and
     * later the Diagnostics screen), not a rebuild-only constant. */
    Function("getIdleConnectStrategy") {
      BoardBleClient.idleConnectStrategy.name.lowercase()
    }

    Function("setIdleConnectStrategy") { strategy: String ->
      BoardBleClient.idleConnectStrategy = when (strategy) {
        "auto_connect" -> BoardBleClient.Companion.IdleConnectStrategy.AUTO_CONNECT
        else -> BoardBleClient.Companion.IdleConnectStrategy.SCAN_THEN_DIRECT
      }
    }

    /**
     * Keeps the board connected while the app is backgrounded or its process is killed.
     *
     * The key material is handed over here and stored natively because a process the
     * system recreated has no React runtime to read it from secure storage, and without
     * it the self-heal worker can restart the service but has nothing to connect with.
     */
    Function("startBackgroundReconnect") { devId: String, uuid: String?, mac: String?, localKey: String, secKey: String?, addressType: Int? ->
      val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "No React context", null)
      BoardCredentialStore.save(
        context,
        BoardCredentialStore.Credentials(devId, uuid, mac, localKey, secKey, addressType),
      )
      BoardBleClient.foregroundOwner?.start(context)
      // KEEP: calling this again on every launch must not reset the interval's phase.
      WorkManager.getInstance(context).enqueueUniquePeriodicWork(
        SELF_HEAL_WORK,
        ExistingPeriodicWorkPolicy.KEEP,
        PeriodicWorkRequestBuilder<BoardSelfHealWorker>(15, TimeUnit.MINUTES).build(),
      )
      // Third, independent self-heal layer: survives the process being killed outright
      // (the other two need a process to already exist — see BoardWakeScan's own doc
      // comment). Best-effort; a missing permission or a refused scan just means this
      // layer sits out, the other two are unaffected.
      BoardWakeScan.arm(context)
    }

    /**
     * Stops background reconnection scaffolding and forgets the natively stored key
     * material. Deliberately does NOT stop the foreground owner (RideService) itself —
     * that service also now owns ride capture (see BoardBleClient.ForegroundOwner's own
     * doc comment for why the two are one service), and RideService must never stop in
     * response to board connection state (ADR 0004) — only the explicit background-
     * self-heal-disabled path stops it, via RideCore's own JS-exposed stop(). Called from
     * a rider's explicit "Disconnect"/"Forget" as well as that disable path, so stopping
     * the service here would silently cut ride recording out from under an active ride.
     */
    Function("stopBackgroundReconnect") {
      appContext.reactContext?.let { context ->
        WorkManager.getInstance(context).cancelUniqueWork(SELF_HEAL_WORK)
        BoardWakeScan.disarm(context)
        BoardCredentialStore.clear(context)
      }
    }

    Function("disconnectDirect") { devId: String ->
      BoardBleClient.activeClients.remove(devId)?.stop()
    }

    Function("isDirectConnected") { devId: String ->
      BoardBleClient.activeClients[devId]?.isConnected() ?: false
    }

    AsyncFunction("publishDpDirect") { devId: String, dpId: String, type: String, value: Any?, promise: Promise ->
      val client = BoardBleClient.activeClients[devId]
        ?: return@AsyncFunction promise.reject("NO_SESSION", "no Bluetooth session for this board, nothing is connected to it", null)
      client.publishDp(dpId.toInt(), type, value) { ok, message ->
        // The prefix the client puts on a failure is the error code: JS has to tell a
        // dropped link (queue it, apply on reconnect) from a value the board refused
        // (a real error the rider needs to see).
        if (ok) promise.resolve(null) else promise.reject(message.substringBefore(':'), message, null)
      }
    }

    AsyncFunction("queryDpsDirect") { devId: String, promise: Promise ->
      val client = BoardBleClient.activeClients[devId]
        ?: return@AsyncFunction promise.reject("NO_SESSION", "no Bluetooth session for this board, nothing is connected to it", null)
      client.queryDps { ok, message ->
        if (ok) promise.resolve(null) else promise.reject(message.substringBefore(':'), message, null)
      }
    }
  }
}
