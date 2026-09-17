package expo.modules.appupdater

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ApkChecksTest {
  @Test
  fun `sha256Matches is case-insensitive`() {
    assertTrue(ApkChecks.sha256Matches("AbCd1234", "abcd1234"))
    assertTrue(ApkChecks.sha256Matches("abcd1234", "ABCD1234"))
    assertFalse(ApkChecks.sha256Matches("abcd1234", "abcd0000"))
  }

  @Test
  fun `isNewerVersion requires strictly greater, not equal`() {
    assertTrue(ApkChecks.isNewerVersion(43, 42))
    assertFalse(ApkChecks.isNewerVersion(42, 42))
    assertFalse(ApkChecks.isNewerVersion(41, 42))
  }

  @Test
  fun `signaturesMatch requires an exact set match`() {
    assertTrue(ApkChecks.signaturesMatch(setOf("aa"), setOf("aa")))
    assertFalse(ApkChecks.signaturesMatch(setOf("aa"), setOf("bb")))
    assertFalse(ApkChecks.signaturesMatch(setOf("aa", "bb"), setOf("aa")))
  }

  @Test
  fun `signaturesMatch refuses an empty candidate set even against an empty installed set`() {
    // An empty candidate means the archive was unsigned or unreadable — never a match,
    // not even in the degenerate case where the installed side is also empty (which
    // shouldn't happen for a real installed app, but this must fail closed regardless).
    assertFalse(ApkChecks.signaturesMatch(emptySet(), emptySet()))
  }
}

class InstallStatusMappingTest {
  @Test
  fun `maps every known PackageInstaller status to its documented name`() {
    assertNameFor(0, "SUCCESS")
    assertNameFor(-1, "PENDING_USER_ACTION")
    assertNameFor(1, "FAILURE")
    assertNameFor(2, "BLOCKED")
    assertNameFor(3, "ABORTED")
    assertNameFor(4, "INVALID")
    assertNameFor(5, "CONFLICT")
    assertNameFor(6, "STORAGE")
    assertNameFor(7, "INCOMPATIBLE")
    assertNameFor(8, "TIMEOUT")
  }

  @Test
  fun `an unrecognized status maps to UNKNOWN rather than throwing`() {
    assertNameFor(999, "UNKNOWN")
  }

  private fun assertNameFor(status: Int, expected: String) {
    org.junit.Assert.assertEquals(expected, InstallStatusMapping.nameFor(status))
  }
}
