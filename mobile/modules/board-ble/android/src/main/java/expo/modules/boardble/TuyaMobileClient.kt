package expo.modules.boardble

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.TimeZone
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** A failed Tuya mobile API call, with a machine-readable code for the UI. */
class TuyaMobileException(val code: String, message: String) : Exception(message)

/**
 * Tuya mobile API client — the encrypted request flow the Tuya Smart Android app
 * itself uses, implemented over HttpsURLConnection with only javax.crypto primitives
 * (no Tuya SDK, no whitebox crypto). Reference: abovecolin/tuya-mobile (the client
 * Home Assistant depends on); the app-profile constants and signing scheme below were
 * read from that source, not guessed.
 *
 * Sessions (sid/ecode/uid) live in memory for the life of this object only. The
 * password is a parameter of [signIn] and nothing else — never stored, never logged.
 */
class TuyaMobileClient(private val onLog: (message: String) -> Unit = {}) {

  companion object {
    /**
     * The Tuya Smart app's public Android build identifiers. These are not user
     * credentials, but they are version-specific: if Tuya rejects them with a
     * signature/app-key error, a newer app build has rotated them and this one
     * block is all that needs updating.
     */
    private const val APP_ID = "3cxxt3au9x33ytvq3h9j"
    private const val APP_SECRET = "5gdtanjtf38vyxkqh87cjwfcqjhvjjqa"
    private const val CERT_SHA256 = "93219FC273E2200F4ADEE5F7191DC656BA2A2D7B2FF5D24CD55C4B6155001E40"
    private const val APP_KEY = "f3hd7pet4p83kemjdf5wqsa5tavrv579"
    private const val PACKAGE = "com.tuya.smart"
    private const val APP_VERSION = "7.8.6"
    private const val TTID = "international"
    private const val SDK_VERSION = "5.24.0"
    private const val DEVICE_CORE_VERSION = "5.17.0"
    private const val OS_SYSTEM = "15"
    private const val PLATFORM = "y"
    private const val CHANNEL = "sdk"
    private const val APP_RN_VERSION = "5.84"
    private const val ET = "3"

    /** Tried in order until one accepts; the login response's domain overrides afterwards. */
    private val ENDPOINTS = listOf(
      "https://a1.tuyaeu.com/api.json",
      "https://a1.tuyaus.com/api.json",
      "https://a1-sg.iotbing.com/api.json",
      "https://a1.tuyacn.com/api.json",
      "https://a1.tuyain.com/api.json",
    )

    private const val REQUEST_TIMEOUT_MS = 20_000

    /** Only these params take part in the canonical string that gets signed. */
    private val SIGN_KEYS = setOf(
      "a", "appVersion", "chKey", "clientId", "deviceId", "et", "h5", "h5Token",
      "lang", "lat", "lon", "n4h5", "os", "postData", "requestId", "sid", "sp",
      "time", "ttid", "v",
    )

    private val ERROR_CODE_BY_MARKER = listOf(
      listOf("API_NOT_SUPPORTED", "API_NOT_EXIST", "METHOD_NOT_FOUND", "UNKNOWN_ACTION", "UNKNOWN ACTION", "NO SUCH API") to "ENDPOINT_UNSUPPORTED",
      listOf("CAPTCHA") to "CAPTCHA_REQUIRED",
      listOf("MFA", "VERIFYCODE", "VERIFY_CODE") to "MFA_REQUIRED",
      listOf("LOCK", "FROZEN", "TOO MANY") to "ACCOUNT_LOCKED",
      listOf("CLIENT", "SIGN", "APP VERSION", "ILLEGAL APP", "APPKEY") to "PROFILE_REJECTED",
      listOf("PASSWORD", "PASSWD", "INVALID CREDENTIAL", "USER_NOT_EXIST") to "WRONG_CREDENTIALS",
    )
  }

  // Session state — memory only, cleared by signOut().
  private var sid: String? = null
  private var ecode: String? = null
  private var uid: String? = null
  private var mobileUrl: String = ENDPOINTS.first()

  val isSignedIn: Boolean get() = sid != null
  val currentUid: String? get() = uid

  fun signOut() {
    sid = null
    ecode = null
    uid = null
    mobileUrl = ENDPOINTS.first()
  }

  private fun certMsg(): String = "${PACKAGE}_${colonHex(CERT_SHA256)}"

  private fun globalMaterial(): String = "${certMsg()}_${APP_KEY}_$APP_SECRET"

  private fun sign(canonical: String): String =
    hmacSha256Hex(
      MessageDigest.getInstance("SHA-256").digest(globalMaterial().toByteArray(StandardCharsets.UTF_8)),
      canonical,
    )

  /** The per-request AES key is the ASCII of the first 16 hex chars — deliberately not hex-decoded. */
  private fun deriveKey(requestId: String): ByteArray {
    val message = if (ecode.isNullOrEmpty()) globalMaterial() else "${globalMaterial()}_$ecode"
    val digest = hmacSha256Hex(requestId.toByteArray(StandardCharsets.UTF_8), message)
    return digest.take(16).toByteArray(StandardCharsets.US_ASCII)
  }

  private fun channelKey(): String =
    hmacSha256Hex(APP_ID.toByteArray(StandardCharsets.UTF_8), certMsg()).substring(8, 16)

  private fun stableDeviceId(username: String): String =
    sha256Hex("$PACKAGE|$APP_ID|${username.trim()}").take(44)

  /** swapMd5 — the postData stand-in inside the canonical string. */
  private fun swapMd5(value: String): String {
    val d = md5Hex(value)
    return d.substring(8, 16) + d.substring(0, 8) + d.substring(24, 32) + d.substring(16, 24)
  }

  private fun canonicalString(params: Map<String, String>): String =
    params.entries
      .filter { it.key in SIGN_KEYS && it.value.isNotEmpty() }
      .sortedBy { it.key }
      .joinToString("||") { (key, value) ->
        "$key=${if (key == "postData") swapMd5(value) else value}"
      }

  private fun encryptPayload(key: ByteArray, payload: JSONObject): String {
    val nonce = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    val sealed = cipher.doFinal(payload.toString().toByteArray(StandardCharsets.UTF_8))
    return java.util.Base64.getEncoder().encodeToString(nonce + sealed)
  }

  private fun decryptPayload(key: ByteArray, value: String): JSONObject {
    val raw = java.util.Base64.getDecoder().decode(value)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
    val plain = cipher.doFinal(raw.copyOfRange(12, raw.size))
    val unzipped = try {
      java.util.zip.GZIPInputStream(plain.inputStream()).readBytes()
    } catch (e: java.util.zip.ZipException) {
      plain // not gzip
    }
    return JSONObject(String(unzipped, StandardCharsets.UTF_8))
  }

  private fun classifiedError(rawCode: String, rawMessage: String, context: String): TuyaMobileException {
    val marker = "${rawCode}:${rawMessage}".uppercase()
    for ((markers, code) in ERROR_CODE_BY_MARKER) {
      if (markers.any { it in marker }) {
        return TuyaMobileException(code, describeFailure(code, context))
      }
    }
    return TuyaMobileException("API_ERROR", "Tuya $context failed ($rawCode)")
  }

  /** Actionable, user-facing text — onboarding lives or dies on these messages. */
  private fun describeFailure(code: String, context: String): String = when (code) {
    "WRONG_CREDENTIALS" -> "Wrong email or password. Check them in the Tuya Smart app and try again."
    "MFA_REQUIRED" -> "Tuya wants to verify this sign-in (verification code). Sign in once in the Tuya Smart app, then try again here."
    "ACCOUNT_LOCKED" -> "This Tuya account is locked or has too many attempts. Wait a while, then try again."
    "CAPTCHA_REQUIRED" -> "Tuya asked for a captcha. Try again, or sign in once in the Tuya Smart app first."
    "PROFILE_REJECTED" -> "Tuya rejected this version of the app. Update Cityroam to keep signing in with Tuya."
    "ENDPOINT_UNSUPPORTED" -> "Tuya's servers no longer support one of this app's API calls; an app update is needed."
    else -> "Tuya $context failed."
  }

  // -------------------------------------------------------------- request plumbing

  private var stableDeviceIdOfLastSignIn: String? = null

  /** One encrypted API call: build the envelope, POST it, decrypt and unzip the result. */
  private fun callEncrypted(action: String, payload: JSONObject, version: String = "1.0"): JSONObject {
    val requestId = UUID.randomUUID().toString()
    val key = deriveKey(requestId)
    val postData = encryptPayload(key, payload)

    val params = linkedMapOf(
      "a" to action,
      "v" to version,
      "clientId" to APP_ID,
      "os" to "Android",
      "appVersion" to APP_VERSION,
      "channel" to CHANNEL,
      "osSystem" to OS_SYSTEM,
      "sdkVersion" to SDK_VERSION,
      "deviceCoreVersion" to DEVICE_CORE_VERSION,
      "platform" to PLATFORM,
      "timeZoneId" to TimeZone.getDefault().id,
      "cp" to "gzip",
      "nd" to "1",
      "lang" to "en",
      "ttid" to TTID,
      "et" to ET,
      "chKey" to channelKey(),
      "deviceId" to (stableDeviceIdOfLastSignIn ?: ""),
      "time" to (System.currentTimeMillis() / 1000).toString(),
      "requestId" to requestId,
      "appRnVersion" to APP_RN_VERSION,
      "postData" to postData,
    )
    sid?.let { if (it.isNotEmpty()) params["sid"] = it }
    params["sign"] = sign(canonicalString(params))

    val body = params.entries.joinToString("&") {
      "${URLEncoder.encode(it.key, "UTF-8")}=${URLEncoder.encode(it.value, "UTF-8")}"
    }
    val connection = URL(mobileUrl).openConnection() as HttpURLConnection
    val envelope = try {
      connection.requestMethod = "POST"
      connection.connectTimeout = REQUEST_TIMEOUT_MS
      connection.readTimeout = REQUEST_TIMEOUT_MS
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
      connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
      val status = connection.responseCode
      if (status < 200 || status >= 300) {
        throw TuyaMobileException("NETWORK", "Tuya's server answered HTTP $status")
      }
      val text = java.io.BufferedReader(
        java.io.InputStreamReader(connection.inputStream, StandardCharsets.UTF_8),
      ).use { it.readText() }
      JSONObject(text)
    } catch (e: TuyaMobileException) {
      throw e
    } catch (e: java.io.IOException) {
      throw TuyaMobileException(
        "NETWORK",
        "Couldn't reach Tuya's servers. Check your internet connection, then try again.",
      )
    } finally {
      connection.disconnect()
    }

    if (!envelope.has("result")) {
      val rawCode = envelope.optString("errorCode").ifEmpty { envelope.optString("code").ifEmpty { "unknown" } }
      val rawMessage = envelope.optString("errorMsg").ifEmpty { envelope.optString("msg").ifEmpty { "no result" } }
      throw classifiedError(rawCode, rawMessage, action)
    }
    return decryptPayload(key, envelope.getString("result"))
  }

  /** Walks a response tree looking for any object that carries all of `fields`. */
  private fun findObjectWith(value: Any?, fields: Set<String>): JSONObject? {
    when (value) {
      is JSONObject -> {
        if (fields.all { value.has(it) && !value.isNull(it) }) return value
        for (key in value.keys()) {
          findObjectWith(value.opt(key), fields)?.let { return it }
        }
      }
      is org.json.JSONArray -> {
        for (i in 0 until value.length()) {
          findObjectWith(value.opt(i), fields)?.let { return it }
        }
      }
    }
    return null
  }

  private fun requireBusinessOk(value: JSONObject, context: String) {
    if (value.optBoolean("success", true) && !value.has("errorCode")) return
    throw classifiedError(
      value.optString("errorCode").ifEmpty { value.optString("code").ifEmpty { "unknown" } },
      value.optString("errorMsg").ifEmpty { value.optString("msg") },
      context,
    )
  }

  // ------------------------------------------------------------------- the actions

  /**
   * Signs in with the Tuya account that already owns the board. Email only for now —
   * phone-number accounts get a clear message saying so. The password exists only
   * inside this call: it is MD5-hexed, RSA-encrypted with the token response's public
   * key, sent once, and dropped.
   */
  fun signIn(email: String, password: String, countryCode: String): String {
    val trimmedEmail = email.trim()
    if (!trimmedEmail.contains("@")) {
      throw TuyaMobileException(
        "EMAIL_ONLY",
        "Sign in with the email address of your Tuya Smart account. Phone-number accounts aren't supported yet.",
      )
    }

    // Endpoint discovery: try each region until one accepts the token request.
    var lastNetworkError: TuyaMobileException? = null
    var token: JSONObject? = null
    for (endpoint in ENDPOINTS) {
      mobileUrl = endpoint
      try {
        token = callEncrypted(
          "thing.m.user.username.token.get",
          JSONObject().put("countryCode", countryCode).put("username", trimmedEmail).put("isUid", false),
          "2.0",
        )
        break
      } catch (e: TuyaMobileException) {
        if (e.code == "NETWORK") {
          lastNetworkError = e
          continue
        }
        throw e
      }
    }
    if (token == null) {
      throw lastNetworkError
        ?: TuyaMobileException("NETWORK", "Couldn't reach Tuya. Check your connection and region.")
    }
    requireBusinessOk(token, "login token")
    val tokenBody = findObjectWith(token, setOf("publicKey", "exponent", "token"))
      ?: throw TuyaMobileException("PROFILE_REJECTED", "Tuya's sign-in response wasn't understood. Cityroam may need an update.")
    onLog("login token acquired from $mobileUrl")

    // Tuya wants RSA-PKCS1v15 over the ASCII of the password's MD5 hex digest.
    val encryptedPassword = TuyaCrypto.rsaPkcs1Encrypt(
      modulusDecimal = tokenBody.getString("publicKey"),
      exponentDecimal = tokenBody.getString("exponent"),
      data = md5Hex(password).toByteArray(StandardCharsets.US_ASCII),
    ).toHexString()

    val login = callEncrypted(
      "thing.m.user.email.password.login",
      JSONObject()
        .put("countryCode", countryCode)
        .put("email", trimmedEmail)
        .put("passwd", encryptedPassword)
        .put("options", "{\"group\":1,\"mfaCode\":\"\"}")
        .put("token", tokenBody.getString("token"))
        .put("ifencrypt", 1),
      "3.0",
    )
    requireBusinessOk(login, "sign-in")
    val sessionBody = findObjectWith(login, setOf("sid", "ecode", "uid"))
      ?: findObjectWith(login, setOf("sid", "uid"))
      ?: throw TuyaMobileException("API_ERROR", "Tuya's sign-in didn't return a session. Try again.")
    sid = sessionBody.optString("sid").ifEmpty { sessionBody.optString("session") }
    ecode = sessionBody.optString("ecode").ifEmpty { sessionBody.optString("eCode").ifEmpty { sessionBody.optString("encryptCode") } }
    uid = sessionBody.optString("uid").ifEmpty { sessionBody.optString("userId") }
    stableDeviceIdOfLastSignIn = stableDeviceId(trimmedEmail)

    // The login response names the right regional API host for every later call.
    val domain = login.optJSONObject("domain")
    domain?.optString("mobileApiUrl", "")?.takeIf { it.isNotEmpty() }?.let {
      mobileUrl = it.removeSuffix("/") + "/api.json"
    }
    onLog("signed in; session held in memory only")
    return uid ?: ""
  }

  /** The signed-in account's homes → every device in every home. */
  fun listDevices(): List<DeviceInfo> {
    check(sid != null) { "not signed in" }
    val homes = callEncrypted("m.life.home.space.list", JSONObject())
    requireBusinessOk(homes, "home list")
    val homeIds = LinkedHashSet<String>()
    collectFieldValues(homes, listOf("gid", "groupId", "homeId"), homeIds)
    onLog("home list returned ${homeIds.size} home(s)")

    val devices = LinkedHashMap<String, DeviceInfo>()
    for (homeId in homeIds) {
      val response = try {
        callEncrypted("m.life.my.group.device.list", JSONObject().put("gid", homeId), "2.2")
      } catch (e: TuyaMobileException) {
        if (e.code == "ENDPOINT_UNSUPPORTED") continue // a home entry with no device list behind it
        throw e
      }
      requireBusinessOk(response, "device list")
      collectDevices(response, devices)
    }
    onLog("device list returned ${devices.size} device(s)")
    return devices.values.toList()
  }

  /** localKey + secKey for the chosen device — the material the BLE handshake needs. */
  fun fetchKeys(devId: String): DeviceKeys {
    check(sid != null) { "not signed in" }
    val response = callEncrypted("thing.m.device.get", JSONObject().put("devId", devId), "4.1")
    requireBusinessOk(response, "device lookup")
    val device = findObjectWith(response, setOf("localKey"))
      ?: throw TuyaMobileException(
        "NO_DEVICE",
        "Tuya didn't return this board's key material. Make sure the board is still paired in the Tuya Smart app, then try again.",
      )
    val localKey = device.optString("localKey").ifEmpty { device.optString("local_key") }
    if (localKey.length != 16) {
      throw TuyaMobileException("API_ERROR", "Tuya returned a board key Cityroam can't use.")
    }
    val secKey = device.optString("secKey").ifEmpty { device.optString("sec_key") }.ifEmpty { null }
    if (secKey != null && secKey.length != 16) {
      throw TuyaMobileException("API_ERROR", "Tuya returned a security key Cityroam can't use.")
    }
    // Tuya has used several names for this over the years and the response shape is
    // not contractual, so every known spelling is tried and anything unrecognised is
    // reported rather than guessed at.
    val schemaJson = listOf("schema", "schemaExt", "schemaInfo", "dpSchema")
      .firstNotNullOfOrNull { key ->
        when (val value = device.opt(key)) {
          is String -> value.ifEmpty { null }
          is JSONObject -> value.toString()
          is org.json.JSONArray -> value.toString()
          else -> null
        }
      }
    return DeviceKeys(
      devId = device.optString("devId").ifEmpty { device.optString("deviceId").ifEmpty { devId } },
      uuid = device.optString("uuid", "").ifEmpty { null },
      productId = device.optString("productId", "").ifEmpty { device.optString("product_id", "").ifEmpty { null } },
      localKey = localKey,
      secKey = secKey,
      schemaJson = schemaJson,
    )
  }

  private fun collectFieldValues(node: Any?, names: List<String>, into: LinkedHashSet<String>) {
    when (node) {
      is JSONObject -> {
        for (name in names) {
          when (val value = node.opt(name)) {
            is String -> if (value.isNotEmpty()) into.add(value)
            is Number -> into.add(value.toString())
          }
        }
        for (key in node.keys()) collectFieldValues(node.opt(key), names, into)
      }
      is org.json.JSONArray -> for (i in 0 until node.length()) collectFieldValues(node.opt(i), names, into)
    }
  }

  private fun collectDevices(node: Any?, into: LinkedHashMap<String, DeviceInfo>) {
    when (node) {
      is JSONObject -> {
        val devId = node.optString("devId", "").ifEmpty { node.optString("deviceId", "").ifEmpty { node.optString("id", "") } }
        val looksLikeDevice = devId.isNotEmpty() && (node.has("localKey") || node.has("uuid") || node.has("name"))
        if (looksLikeDevice && !into.containsKey(devId)) {
          into[devId] = DeviceInfo(
            devId = devId,
            uuid = node.optString("uuid", "").ifEmpty { null },
            name = node.optString("name", "").ifEmpty { null },
            productId = node.optString("productId", "").ifEmpty { node.optString("product_id", "").ifEmpty { null } },
          )
        }
        for (key in node.keys()) collectDevices(node.opt(key), into)
      }
      is org.json.JSONArray -> for (i in 0 until node.length()) collectDevices(node.opt(i), into)
    }
  }

  data class DeviceInfo(
    val devId: String,
    val uuid: String?,
    val name: String?,
    val productId: String?,
  )

  data class DeviceKeys(
    val devId: String,
    val uuid: String?,
    val productId: String?,
    val localKey: String,
    val secKey: String?,
    /**
     * The board's own datapoint schema as the account reports it, raw, or null.
     *
     * The SDK used to supply this per device; without it the app falls back to a schema
     * compiled into the build, whose ranges have already been wrong once for a real
     * board. Kept as the raw string so the parsing lives in JS next to the code that
     * models a schema, and so an unrecognised shape can be inspected rather than lost.
     */
    val schemaJson: String?,
  )

  private fun ByteArray.toHexString(): String = joinToString("") { "%02x".format(it) }

  private fun md5Hex(value: String): String =
    MessageDigest.getInstance("MD5").digest(value.toByteArray(StandardCharsets.UTF_8)).toHexString()

  private fun sha256Hex(value: String): String =
    MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8)).toHexString()

  private fun hmacSha256Hex(key: ByteArray, message: String): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(message.toByteArray(StandardCharsets.UTF_8)).toHexString()
  }

  private fun colonHex(certHex: String): String =
    certHex.replace(":", "").trim().chunked(2).joinToString(":").uppercase()
}
