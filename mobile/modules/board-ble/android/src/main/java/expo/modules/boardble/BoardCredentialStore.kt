package expo.modules.boardble

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The board's key material, held natively so background reconnection survives process
 * death.
 *
 * The keys normally live in expo-secure-store on the JS side, which is unreachable from
 * a Worker that WorkManager spun up in a fresh process with no React runtime. Without a
 * native copy the self-heal path can restart the service but has nothing to connect
 * with, which is the exact scenario it exists for.
 *
 * Encrypted at rest with an AES key held in the Android Keystore, so the plaintext never
 * touches SharedPreferences. App-private storage would already keep it away from other
 * apps; this additionally keeps it out of device backups and off-device copies of the
 * data directory.
 */
object BoardCredentialStore {
  private const val PREFS = "board_ble_credentials"
  private const val KEY_ALIAS = "board_ble_credential_key"
  private const val ENABLED = "enabled"
  private const val PAYLOAD = "payload"
  private const val GCM_TAG_BITS = 128
  private const val NONCE_BYTES = 12

  data class Credentials(
    val devId: String,
    val uuid: String?,
    val mac: String?,
    val localKey: String,
    val secKey: String?,
    /** `BluetoothDevice.ADDRESS_TYPE_*` — null on a record written before this field
     * existed, or if the type was never learned. See BoardScanner.addressTypeOf. */
    val addressType: Int? = null,
  )

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun secretKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build()
    )
    return generator.generateKey()
  }

  /** Stores the material and marks background reconnection as wanted. */
  fun save(context: Context, credentials: Credentials) {
    // Tab-separated rather than JSON: the fields are fixed and none may contain a tab,
    // and it keeps a parser off the path that has to work in a freshly spawned process.
    val plain = listOf(
      credentials.devId,
      credentials.uuid ?: "",
      credentials.mac ?: "",
      credentials.localKey,
      credentials.secKey ?: "",
      credentials.addressType?.toString() ?: "",
    ).joinToString("\t")

    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
    prefs(context).edit()
      .putString(PAYLOAD, Base64.encodeToString(sealed, Base64.NO_WRAP))
      .putBoolean(ENABLED, true)
      .apply()
  }

  /** Null when nothing is stored, reconnection is disabled, or the material is unreadable. */
  fun load(context: Context): Credentials? {
    val store = prefs(context)
    if (!store.getBoolean(ENABLED, false)) return null
    val encoded = store.getString(PAYLOAD, null) ?: return null
    return try {
      val sealed = Base64.decode(encoded, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(
        Cipher.DECRYPT_MODE,
        secretKey(),
        GCMParameterSpec(GCM_TAG_BITS, sealed, 0, NONCE_BYTES),
      )
      val parts = String(
        cipher.doFinal(sealed, NONCE_BYTES, sealed.size - NONCE_BYTES),
        Charsets.UTF_8,
      ).split("\t")
      if (parts.size < 5 || parts[0].isEmpty() || parts[3].isEmpty()) return null
      Credentials(
        devId = parts[0],
        uuid = parts[1].ifEmpty { null },
        mac = parts[2].ifEmpty { null },
        localKey = parts[3],
        secKey = parts[4].ifEmpty { null },
        // getOrNull: a record written before this field existed has only 5 parts.
        addressType = parts.getOrNull(5)?.toIntOrNull(),
      )
    } catch (e: Exception) {
      // A Keystore key can be invalidated (device credential removed, app data
      // migrated), which is not recoverable and not worth crashing over — the next
      // sign-in rewrites it.
      null
    }
  }

  /** Forgets the material and disables background reconnection. */
  fun clear(context: Context) {
    prefs(context).edit().remove(PAYLOAD).putBoolean(ENABLED, false).apply()
  }
}
