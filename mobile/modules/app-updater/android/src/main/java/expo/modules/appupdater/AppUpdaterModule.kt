package expo.modules.appupdater

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Pro self-updater: verifies a downloaded APK against the release it's supposed to be,
 * then installs it over the running app via `PackageInstaller`, with
 * `USER_ACTION_NOT_REQUIRED` where Android 12+ allows a self-update with no confirmation
 * screen. JS (`src/features/updates/appUpdate.ts`) owns resolving the download URL,
 * running the download, and the step-by-step state machine; this module only verifies
 * and installs a file already on disk.
 *
 * Every `AsyncFunction` here runs on `Queues.DEFAULT` (expo-modules-kotlin's own
 * default), i.e. `appContext.modulesQueue` — never the JS/main thread — so `verifyApk`'s
 * file hashing needs no explicit dispatcher of its own.
 */
class AppUpdaterModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("AppUpdater")

    Events("onInstallStatus")

    OnCreate {
      InstallStatusRegistry.listener = { outcome -> emitInstallStatus(outcome) }
    }

    OnDestroy {
      InstallStatusRegistry.listener = null
    }

    Function("canRequestPackageInstalls") {
      context.packageManager.canRequestPackageInstalls()
    }

    /**
     * Opens the per-app "Install unknown apps" toggle. Same `FLAG_ACTIVITY_NEW_TASK`
     * reasoning as `DevicePowerModule.requestIgnoreBatteryOptimizations` — `context`
     * here is always the react context, never an Activity.
     */
    AsyncFunction("openInstallPermissionSettings") { promise: Promise ->
      try {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("REQUEST_FAILED", e.message ?: "Could not open the install-permission screen.", e)
      }
    }

    Function("installedVersionCode") {
      longVersionCodeOf(context.packageManager.getPackageInfo(context.packageName, 0))
    }

    AsyncFunction("verifyApk") { fileUri: String, expectedSha256: String, promise: Promise ->
      promise.resolve(verifyApk(fileUri, expectedSha256))
    }

    AsyncFunction("installApk") { fileUri: String, promise: Promise ->
      try {
        installApk(fileUri)
        promise.resolve(null)
      } catch (e: CodedException) {
        promise.reject(e)
      } catch (e: Exception) {
        promise.reject("INSTALL_FAILED", e.message ?: "Could not start the install session.", e)
      }
    }
  }

  private fun emitInstallStatus(outcome: InstallOutcome) {
    val payload = when (outcome) {
      is InstallOutcome.Success -> mapOf("status" to "success")
      is InstallOutcome.PendingUserAction -> mapOf("status" to "pendingUserAction")
      is InstallOutcome.Failure -> mapOf("status" to "failure", "code" to outcome.code, "message" to outcome.message)
    }
    sendEvent("onInstallStatus", payload)
  }

  // ------------------------------------------------------------------- verifyApk

  private fun verifyApk(fileUri: String, expectedSha256: String): Map<String, Any?> {
    val path = try {
      Uri.parse(fileUri).path ?: return apkCheckFailure("unreadable")
    } catch (e: Exception) {
      return apkCheckFailure("unreadable")
    }
    val file = File(path)
    if (!file.isFile || !file.canRead()) return apkCheckFailure("unreadable")

    val actualSha256 = try {
      Sha256.hex(file)
    } catch (e: Exception) {
      return apkCheckFailure("unreadable")
    }
    if (!ApkChecks.sha256Matches(actualSha256, expectedSha256)) return apkCheckFailure("sha256Mismatch")

    val archiveInfo = try {
      context.packageManager.getPackageArchiveInfo(path, signingCertificatesFlag()) ?: return apkCheckFailure("unreadable")
    } catch (e: Exception) {
      return apkCheckFailure("unreadable")
    }
    if (archiveInfo.packageName != context.packageName) return apkCheckFailure("wrongPackage")

    val installedInfo = try {
      context.packageManager.getPackageInfo(context.packageName, signingCertificatesFlag())
    } catch (e: PackageManager.NameNotFoundException) {
      // Can't happen for the app currently running this code, but fails closed rather
      // than crashing if it somehow ever did.
      return apkCheckFailure("unreadable")
    }

    val candidateVersionCode = longVersionCodeOf(archiveInfo)
    val installedVersionCode = longVersionCodeOf(installedInfo)
    if (!ApkChecks.isNewerVersion(candidateVersionCode, installedVersionCode)) return apkCheckFailure("notNewer")

    val candidateCertShas = certShasOf(archiveInfo)
    val installedCertShas = certShasOf(installedInfo)
    if (!ApkChecks.signaturesMatch(candidateCertShas, installedCertShas)) return apkCheckFailure("signatureMismatch")

    return mapOf(
      "ok" to true,
      "versionName" to (archiveInfo.versionName ?: ""),
      "versionCode" to candidateVersionCode,
    )
  }

  private fun apkCheckFailure(reason: String): Map<String, Any?> = mapOf("ok" to false, "reason" to reason)

  private fun longVersionCodeOf(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()

  // GET_SIGNING_CERTIFICATES is API 28+; GET_SIGNATURES is the deprecated pre-28
  // fallback needed down to this app's minSdk 26. Both return what certShasOf below
  // needs, through different PackageInfo fields.
  private fun signingCertificatesFlag(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      @Suppress("DEPRECATION")
      PackageManager.GET_SIGNATURES
    }

  private fun certShasOf(info: PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      // apkContentsSigners, not signingCertificateHistory — the former is what actually
      // signed this APK's contents; the latter includes past keys from a rotation
      // lineage, which would make a self-update accept an APK signed by an old,
      // rotated-away key.
      info.signingInfo?.apkContentsSigners
    } else {
      @Suppress("DEPRECATION")
      info.signatures
    } ?: return emptySet()
    return signatures.map { Sha256.hex(it.toByteArray()) }.toSet()
  }

  // ------------------------------------------------------------------- installApk

  private fun installApk(fileUri: String) {
    val path = Uri.parse(fileUri).path
      ?: throw CodedException("INVALID_URI", "Not a file:// URI: $fileUri", null)
    val file = File(path)
    if (!file.isFile) throw CodedException("FILE_NOT_FOUND", "No file at $path", null)

    val packageInstaller = context.packageManager.packageInstaller

    // Stale sessions from an earlier attempt (a crash before commit, a previous
    // "Try again") never resolve on their own — abandon everything this app owns before
    // opening a new one rather than accumulating orphaned sessions.
    packageInstaller.mySessions.forEach { info ->
      try {
        packageInstaller.abandonSession(info.sessionId)
      } catch (e: Exception) {
        // Already gone, or already committed — either way, not this call's problem.
      }
    }

    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setAppPackageName(context.packageName)
      setSize(file.length())
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        // Only takes effect when the OS-side conditions in this module's own doc
        // comment (update-owner-or-self, high-enough target SDK, ...) are all met; the
        // session still works and just falls back to STATUS_PENDING_USER_ACTION
        // otherwise, per PackageInstaller's own documented behavior for this flag.
        setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
      }
    }

    val sessionId = packageInstaller.createSession(params)
    val session = try {
      packageInstaller.openSession(sessionId)
    } catch (e: Exception) {
      throw CodedException("SESSION_OPEN_FAILED", e.message ?: "Could not open the install session.", e)
    }

    // session.use{} closes the session once this block returns — safe even right after
    // a successful commit() (confirmed against PackageInstaller.Session's own docs:
    // commit() hands the session off to the system installer, and closing the local
    // Session handle afterward does not abort it). On any exception before commit
    // succeeds, the catch below still abandons explicitly, since use{}'s own close()
    // does not abandon on its own.
    try {
      session.use { s ->
        s.openWrite("base.apk", 0, file.length()).use { out ->
          file.inputStream().use { input -> input.copyTo(out) }
          s.fsync(out)
        }

        val statusReceiverIntent = Intent(context, InstallResultReceiver::class.java).setPackage(context.packageName)
        // FLAG_MUTABLE is required — the system fills the status extras into this
        // intent at delivery time, which an immutable PendingIntent would silently
        // drop. Legal at API 34+ specifically because the wrapped Intent names an
        // explicit component (InstallResultReceiver::class.java), the same reasoning
        // BoardWakeScan documents for its own PendingIntent.
        val statusReceiver = PendingIntent.getBroadcast(
          context,
          sessionId,
          statusReceiverIntent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        s.commit(statusReceiver.intentSender)
      }
    } catch (e: Exception) {
      try {
        session.abandon()
      } catch (abandonError: Exception) {
        // Already closed/committed by the use{} block above — nothing left to abandon.
      }
      throw CodedException("SESSION_FAILED", e.message ?: "Could not write or commit the install session.", e)
    }
  }
}
