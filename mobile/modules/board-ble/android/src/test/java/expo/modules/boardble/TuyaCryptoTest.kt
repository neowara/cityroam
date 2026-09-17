package expo.modules.boardble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TuyaCryptoTest {
  @Test
  fun `login and session key derivation match the reference for both variants`() {
    val fx = ReferenceFixtures
    assertEquals(fx.LOGIN_KEY_V2_HEX, TuyaCrypto.loginKey(fx.LOCAL_KEY, fx.SEC_KEY).toHex())
    assertEquals(
      fx.SESSION_KEY_V2_HEX,
      TuyaCrypto.sessionKey(fx.LOCAL_KEY, fx.SEC_KEY, fx.DEVICE_RANDOM).toHex(),
    )
    // No secKey -> v3 derivation over localKey[:6].
    assertEquals(fx.LOGIN_KEY_V3_HEX, TuyaCrypto.loginKey(fx.LOCAL_KEY, null).toHex())
    assertEquals(
      fx.SESSION_KEY_V3_HEX,
      TuyaCrypto.sessionKey(fx.LOCAL_KEY, null, fx.DEVICE_RANDOM).toHex(),
    )
    assertEquals(fx.LOGIN_KEY_V3_HEX, TuyaCrypto.loginKey(fx.LOCAL_KEY, "").toHex())
  }

  @Test
  fun `security flags follow the derivation variant`() {
    assertEquals(14, TuyaCrypto.loginFlag(ReferenceFixtures.SEC_KEY))
    assertEquals(15, TuyaCrypto.sessionFlag(ReferenceFixtures.SEC_KEY))
    assertEquals(4, TuyaCrypto.loginFlag(null))
    assertEquals(5, TuyaCrypto.sessionFlag(null))
  }

  @Test
  fun `md5 and sha256 against standard vectors`() {
    assertEquals("d41d8cd98f00b204e9800998ecf8427e", TuyaCrypto.md5(ByteArray(0)).toHex())
    assertEquals("900150983cd24fb0d6963f7d28e17f72", TuyaCrypto.md5("abc".toByteArray()).toHex())
    assertEquals(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      TuyaCrypto.sha256("abc".toByteArray()).toHex(),
    )
  }

  @Test
  fun `hmac-sha256 against RFC 4231 test case 2`() {
    val expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    assertEquals(
      expected,
      TuyaCrypto.hmacSha256("Jefe".toByteArray(), "what do ya want for nothing?".toByteArray()).toHex(),
    )
  }

  @Test
  fun `aes-cbc against the NIST SP 800-38A vector and round-trips`() {
    val key = "2b7e151628aed2a6abf7158809cf4f3c".hexToBytes()
    val iv = "000102030405060708090a0b0c0d0e0f".hexToBytes()
    val plaintext = "6bc1bee22e409f96e93d7e117393172a".hexToBytes()
    val ciphertext = TuyaCrypto.aesCbcEncrypt(key, iv, plaintext)
    assertEquals("7649abac8119b246cee98e9b12e9197d", ciphertext.toHex())
    assertArrayEquals(plaintext, TuyaCrypto.aesCbcDecrypt(key, iv, ciphertext))
  }

  @Test
  fun `aes-gcm round-trips and rejects a tampered tag`() {
    val key = "feffe9928665731c6d6a8f9467308308".hexToBytes()
    val nonce = "cafebabefacedbaddecaf888".hexToBytes()
    val plaintext = "d9313225f88406e5a55909c5aff5269a".hexToBytes()
    val sealed = TuyaCrypto.aesGcmEncrypt(key, nonce, plaintext)
    assertEquals(plaintext.size + 16, sealed.size)
    assertArrayEquals(plaintext, TuyaCrypto.aesGcmDecrypt(key, nonce, sealed))
    val tampered = sealed.copyOf().also { it[sealed.size - 1] = (it[sealed.size - 1].toInt() xor 1).toByte() }
    try {
      TuyaCrypto.aesGcmDecrypt(key, nonce, tampered)
      throw AssertionError("Tampered GCM data must not decrypt")
    } catch (expected: Exception) {
      // AEADBadTagException or a wrapped variant — any rejection is the requirement.
    }
  }

  @Test
  fun `rsa pkcs1 encrypts to something the matching private key decrypts`() {
    // A decimal-modulus/exponent public key is exactly what the mobile API's token
    // response carries, so round-trip through one generated that way.
    val keyPair = java.security.KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    val publicKey = keyPair.public as java.security.interfaces.RSAPublicKey
    val ciphertext = TuyaCrypto.rsaPkcs1Encrypt(
      publicKey.modulus.toString(),
      publicKey.publicExponent.toString(),
      "d41d8cd98f00b204e9800998ecf8427e".toByteArray(),
    )
    val cipher = javax.crypto.Cipher.getInstance("RSA/ECB/PKCS1Padding")
    cipher.init(javax.crypto.Cipher.DECRYPT_MODE, keyPair.private)
    assertEquals(
      "d41d8cd98f00b204e9800998ecf8427e",
      String(cipher.doFinal(ciphertext), Charsets.US_ASCII),
    )
    assertTrue(ciphertext.size == 2048 / 8)
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

  private fun String.hexToBytes(): ByteArray =
    chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
