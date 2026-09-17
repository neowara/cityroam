package expo.modules.boardble

import java.math.BigInteger
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.spec.RSAPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Every primitive the SDK-free board link needs, all from javax.crypto/java.security —
 * the point of this module is that nothing native or third-party is required.
 *
 * Key derivation has two variants, selected by whether the device owns a `secKey`:
 *
 * - v2: material = localKey + secKey (ASCII), login flag 14, session flag 15
 * - v3: material = localKey[:6] (ASCII),        login flag 4,  session flag 5
 *
 * loginKey = MD5(material); sessionKey = MD5(material + device_random), where
 * device_random is the 6 bytes at offset 6 of the device-info response. The flags are
 * the first byte on the wire of an encrypted frame and say which key the receiver must
 * decrypt with.
 */
object TuyaCrypto {
  const val LOGIN_FLAG_V2 = 14
  const val SESSION_FLAG_V2 = 15
  const val LOGIN_FLAG_V3 = 4
  const val SESSION_FLAG_V3 = 5

  /** True when key material includes a secKey, which selects the v2 derivation. */
  fun isProtocolV2(secKey: String?): Boolean = !secKey.isNullOrEmpty()

  fun loginFlag(secKey: String?): Int = if (isProtocolV2(secKey)) LOGIN_FLAG_V2 else LOGIN_FLAG_V3

  fun sessionFlag(secKey: String?): Int = if (isProtocolV2(secKey)) SESSION_FLAG_V2 else SESSION_FLAG_V3

  fun derivationMaterial(localKey: String, secKey: String?): ByteArray {
    val ascii = localKey.toByteArray(Charsets.US_ASCII)
    if (isProtocolV2(secKey)) {
      return ascii + (secKey ?: "").toByteArray(Charsets.US_ASCII)
    }
    if (ascii.size < 6) {
      throw TuyaProtocolException("localKey must be at least 6 ASCII characters")
    }
    return ascii.copyOfRange(0, 6)
  }

  fun loginKey(localKey: String, secKey: String?): ByteArray =
    md5(derivationMaterial(localKey, secKey))

  fun sessionKey(localKey: String, secKey: String?, deviceRandom: ByteArray): ByteArray {
    if (deviceRandom.size != 6) {
      throw TuyaProtocolException("deviceRandom must be exactly 6 bytes")
    }
    return md5(derivationMaterial(localKey, secKey) + deviceRandom)
  }

  fun md5(data: ByteArray): ByteArray = digest("MD5", data)

  fun sha256(data: ByteArray): ByteArray = digest("SHA-256", data)

  private fun digest(algorithm: String, data: ByteArray): ByteArray =
    MessageDigest.getInstance(algorithm).run {
      update(data)
      digest()
    }

  fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(data)
  }

  /**
   * AES-128-CBC with no padding — the frame builder zero-pads the plaintext to a
   * 16-byte multiple before calling this, so input must already be a block multiple.
   */
  fun aesCbcEncrypt(key: ByteArray, iv: ByteArray, data: ByteArray): ByteArray {
    if (data.size % 16 != 0) {
      throw TuyaProtocolException("AES-CBC input must be a multiple of 16 bytes")
    }
    return cipher("AES/CBC/NoPadding", Cipher.ENCRYPT_MODE, key, iv).doFinal(data)
  }

  fun aesCbcDecrypt(key: ByteArray, iv: ByteArray, data: ByteArray): ByteArray {
    if (data.size % 16 != 0) {
      throw TuyaProtocolException("AES-CBC input must be a multiple of 16 bytes")
    }
    return cipher("AES/CBC/NoPadding", Cipher.DECRYPT_MODE, key, iv).doFinal(data)
  }

  private fun cipher(transformation: String, mode: Int, key: ByteArray, iv: ByteArray): Cipher {
    val cipher = Cipher.getInstance(transformation)
    cipher.init(mode, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
    return cipher
  }

  /** Returns ciphertext with the 16-byte GCM tag appended, as the Tuya mobile API frames it. */
  fun aesGcmEncrypt(key: ByteArray, nonce: ByteArray, plaintext: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    return cipher.doFinal(plaintext)
  }

  /** Expects ciphertext with the 16-byte GCM tag appended; throws on tag mismatch. */
  fun aesGcmDecrypt(key: ByteArray, nonce: ByteArray, data: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    return cipher.doFinal(data)
  }

  /**
   * RSA-PKCS1v1.5 encryption with a public key given as decimal strings — the Tuya
   * mobile API's token response carries the modulus as `publicKey` and the exponent
   * as `exponent`, both in decimal, and the password digest is encrypted with it.
   */
  fun rsaPkcs1Encrypt(modulusDecimal: String, exponentDecimal: String, data: ByteArray): ByteArray {
    val keyFactory = KeyFactory.getInstance("RSA")
    val publicKey = keyFactory.generatePublic(RSAPublicKeySpec(BigInteger(modulusDecimal), BigInteger(exponentDecimal)))
    val cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding")
    cipher.init(Cipher.ENCRYPT_MODE, publicKey)
    return cipher.doFinal(data)
  }
}
