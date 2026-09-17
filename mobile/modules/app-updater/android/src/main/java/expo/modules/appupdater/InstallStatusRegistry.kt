package expo.modules.appupdater

/** What [InstallResultReceiver] delivers once `PackageInstaller` reports an outcome. */
sealed class InstallOutcome {
  object Success : InstallOutcome()
  object PendingUserAction : InstallOutcome()
  data class Failure(val code: String, val message: String) : InstallOutcome()
}

/**
 * Process-wide handoff from [InstallResultReceiver] to [AppUpdaterModule] — the receiver
 * is instantiated fresh by the system on delivery, with no reference to any live module
 * instance, so it can't call `sendEvent` directly. Mirrors
 * `BoardBleClient.RideObserver`'s own reasoning for the same shape. `@Volatile` since
 * delivery can race module (re)creation.
 */
object InstallStatusRegistry {
  @Volatile var listener: ((InstallOutcome) -> Unit)? = null
}
