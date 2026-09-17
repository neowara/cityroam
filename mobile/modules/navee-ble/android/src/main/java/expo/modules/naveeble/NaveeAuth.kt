package expo.modules.naveeble

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

/**
 * The scooter's authentication exchange, ported from the official app (decompiled
 * `b4/a.java` `c()`/`d0()`/`p()` and its `0x30`/`0x31` notify handler):
 *
 * 1. app → `0x30 [keyIndex, bindFlag, id6…, 00]`
 * 2. scooter → `0x30` status 0 with a challenge, or status 0 and nothing else once the
 *    app is already trusted, or a non-zero status (`0x02` = id not recognised)
 * 3. app → `0x31 [challenge encrypted under keys[keyIndex]]`
 * 4. scooter → `0x31` status 0, and the app starts again at step 1
 *
 * The keys are the same five in every install of the official app — there is no
 * per-device secret. What the scooter actually checks is `id6`, which is the NAVEE
 * account id the scooter is bound to.
 */
object NaveeAuth {
  private val KEYS: Array<ByteArray> = arrayOf(
    bytes(0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xAF),
    bytes(0x44, 0x6D, 0x10, 0x72, 0x6D, 0xBE, 0x05, 0xF6, 0x62, 0xDF, 0xAA, 0xF0, 0x13, 0x27, 0x30, 0x3F),
    bytes(0xA2, 0x85, 0xCC, 0xEC, 0x81, 0x4F, 0xE9, 0x61, 0x74, 0x29, 0x95, 0xE8, 0xEB, 0xA9, 0x22, 0x47),
    bytes(0x3F, 0xEE, 0x80, 0xFF, 0x96, 0xDF, 0x5C, 0xF5, 0x42, 0xEA, 0xAC, 0x93, 0x28, 0x1F, 0xE5, 0x29),
    bytes(0x4E, 0xB4, 0xD4, 0x64, 0xD6, 0xEF, 0x53, 0xED, 0x6C, 0xE9, 0x45, 0x58, 0xDE, 0x9A, 0x5E, 0xE3),
  )

  const val KEY_COUNT = 5

  /** Auth status the scooter returns for an id it isn't bound to. */
  const val STATUS_UNKNOWN_ID = 0x02

  private val random = SecureRandom()

  private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

  /** The official app picks a fresh key for every `0x30` it sends. */
  fun randomKeyIndex(): Int = random.nextInt(KEY_COUNT)

  /**
   * `utils/f.java::m(uid, 0x88)`: six bytes, big-endian, with the top byte replaced by
   * a constant whenever it would be zero or negative — which for any real (int) account
   * id is always.
   *
   * The constant is `0x88`, read off the wire: the official app authenticates account
   * 1316801 as `88 00 00 14 17 c1` and the scooter answers status 0, while the same id
   * sent as `86 …` is refused with [STATUS_UNKNOWN_ID]. Trust a capture of the shipping
   * app over a decompilation of some version of it.
   */
  fun idBytes(accountId: Long): ByteArray {
    var top = ((accountId ushr 40) and 0xFF).toInt().toByte()
    if (top <= 0) top = 0x88.toByte()
    return byteArrayOf(
      top,
      (accountId ushr 32).toByte(),
      (accountId ushr 24).toByte(),
      (accountId ushr 16).toByte(),
      (accountId ushr 8).toByte(),
      accountId.toByte(),
    )
  }

  /**
   * `bindFlag` is 1 when authenticating as the owner of a scooter shared with this
   * account (`accountId` is then the owner's `shareUserId`), 0 otherwise.
   */
  fun authRequest(accountId: Long, bindFlag: Int, keyIndex: Int): ByteArray {
    require(keyIndex in 0 until KEY_COUNT) { "key index $keyIndex out of range" }
    val payload = byteArrayOf(keyIndex.toByte(), bindFlag.toByte()) + idBytes(accountId) + byteArrayOf(0)
    return NaveeFrame.write(NaveeFrame.CMD_AUTH, payload)
  }

  sealed class Reply {
    /** Status 0 with no challenge: this session is trusted. */
    object Authenticated : Reply()

    /** Status 0 with a challenge; send [answer] next. */
    class Challenge(val answer: ByteArray) : Reply()

    /** A challenge came back in a shape this port can't answer. */
    class Unanswerable(val reason: String) : Reply()

    /** The scooter refused; [status] is its own code. */
    class Rejected(val status: Int) : Reply()
  }

  /** Interprets the scooter's `0x30` reply for the key index the request named. */
  fun onAuthReply(frame: NaveeFrame.Parsed, keyIndex: Int): Reply {
    if (frame.status != 0) return Reply.Rejected(frame.status)
    val challenge = frame.data
    if (challenge.isEmpty()) return Reply.Authenticated
    val key = KEYS[keyIndex]
    // The app's own split: up to 16 bytes is a bare challenge; longer carries a leading
    // mode byte, 0 meaning XOR and anything else AES.
    val answer = if (challenge.size <= 16) {
      if (challenge.size != 16) return Reply.Unanswerable("challenge is ${challenge.size} bytes, expected 16")
      aesEncrypt(challenge, key)
    } else {
      val body = challenge.copyOfRange(1, challenge.size)
      if (body.size != 16) return Reply.Unanswerable("mode-prefixed challenge body is ${body.size} bytes, expected 16")
      if (challenge[0].toInt() == 0) xor(body, key) else aesEncrypt(body, key)
    }
    return Reply.Challenge(NaveeFrame.write(NaveeFrame.CMD_AUTH_CHALLENGE, answer))
  }

  /**
   * Encrypt, not decrypt: `utils/f.java::f()` initialises its cipher with mode 1
   * (`Cipher.ENCRYPT_MODE`). scooterteam's Kotlin port decrypts here, which is wrong.
   */
  fun aesEncrypt(block: ByteArray, key: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/ECB/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
    return cipher.doFinal(block)
  }

  private fun xor(block: ByteArray, key: ByteArray) = ByteArray(block.size) { (block[it].toInt() xor key[it].toInt()).toByte() }

  /** Human-readable status for logs and error messages. */
  fun describeStatus(status: Int): String = when (status) {
    0 -> "ok"
    STATUS_UNKNOWN_ID -> "the scooter doesn't recognise this account (status 2). It's bound to a different NAVEE account"
    else -> "status $status"
  }
}
