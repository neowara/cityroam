package expo.modules.appupdater

/**
 * Pure comparison helpers behind [AppUpdaterModule.verifyApk] — pulled out as plain
 * functions over primitives/collections (not `PackageInfo`/`Signature`, which need a
 * real `PackageManager`) so the actual decision logic is JVM-testable without a device.
 */
object ApkChecks {
  fun sha256Matches(actualHex: String, expectedHex: String): Boolean =
    actualHex.equals(expectedHex, ignoreCase = true)

  fun isNewerVersion(candidateVersionCode: Long, installedVersionCode: Long): Boolean =
    candidateVersionCode > installedVersionCode

  /** Both sides are sets of lowercase-hex SHA-256 cert fingerprints. An empty candidate
   * set (an unsigned or unreadable archive) never matches, even against an empty
   * installed set — there is no real "installed with no signature" case on a device. */
  fun signaturesMatch(candidateCertShas: Set<String>, installedCertShas: Set<String>): Boolean =
    candidateCertShas.isNotEmpty() && candidateCertShas == installedCertShas
}

/**
 * Maps a `PackageInstaller.STATUS_*` int to a short, stable name for JS/logging — a
 * plain Int in, not the `PackageInstaller` class itself, so this stays pure Kotlin with
 * no Android framework dependency and is JVM-testable without a device or Robolectric.
 * Values mirrored below are `PackageInstaller`'s own documented constants (confirmed
 * against the AOSP source) and are part of its public API, so they don't change across
 * API levels.
 */
object InstallStatusMapping {
  const val STATUS_PENDING_USER_ACTION = -1
  const val STATUS_SUCCESS = 0
  private const val STATUS_FAILURE = 1
  private const val STATUS_FAILURE_BLOCKED = 2
  private const val STATUS_FAILURE_ABORTED = 3
  private const val STATUS_FAILURE_INVALID = 4
  private const val STATUS_FAILURE_CONFLICT = 5
  private const val STATUS_FAILURE_STORAGE = 6
  private const val STATUS_FAILURE_INCOMPATIBLE = 7
  private const val STATUS_FAILURE_TIMEOUT = 8

  fun nameFor(status: Int): String = when (status) {
    STATUS_SUCCESS -> "SUCCESS"
    STATUS_PENDING_USER_ACTION -> "PENDING_USER_ACTION"
    STATUS_FAILURE_ABORTED -> "ABORTED"
    STATUS_FAILURE_BLOCKED -> "BLOCKED"
    STATUS_FAILURE_CONFLICT -> "CONFLICT"
    STATUS_FAILURE_INCOMPATIBLE -> "INCOMPATIBLE"
    STATUS_FAILURE_INVALID -> "INVALID"
    STATUS_FAILURE_STORAGE -> "STORAGE"
    STATUS_FAILURE_TIMEOUT -> "TIMEOUT"
    STATUS_FAILURE -> "FAILURE"
    else -> "UNKNOWN"
  }
}
