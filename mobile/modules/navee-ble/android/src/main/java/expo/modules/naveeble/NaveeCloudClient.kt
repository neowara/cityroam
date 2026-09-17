package expo.modules.naveeble

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Locale

/**
 * The NAVEE account API, used for one thing: learning which account id the scooter is
 * bound to, which is what its Bluetooth auth checks (see [NaveeAuth]). Endpoints and
 * request shapes are the official app's (decompiled `LoginActivity.e0()`,
 * `CheckCodePopup.getImageCaptcha()`, `d4/a.java`'s header interceptor).
 *
 * The session token lives in memory only and is gone after a process restart, exactly
 * like [expo.modules.boardble.TuyaMobileClient]'s — nothing here is needed again once
 * the scooter is paired. The password is a call parameter and never stored.
 */
class NaveeCloudClient {
  companion object {
    private const val TAG = "NaveeCloud"
    private const val BASE_URL = "https://lj.naveetech.com/tundra-api"
    private const val REQUEST_TIMEOUT_MS = 15_000

    /** The API refuses (HTTP 410 / code 410) an app version it considers deprecated.
     * 2.5.0 is what scooterteam's working tools send; bump it here if sign-in starts
     * failing with APP_OUTDATED. */
    private const val APP_VERSION = "2.5.0"
  }

  data class Captcha(val imageBase64: String, val uuid: String)

  @Volatile private var token: String? = null
  @Volatile var userId: Long? = null
    private set

  val isSignedIn: Boolean get() = token != null

  /** The image code the login form needs. `img` may or may not carry a data-URI prefix. */
  fun captcha(): Captcha {
    val data = NaveeCloudResponses.unwrap(request("GET", "/checkCode", null)) as? JSONObject
      ?: throw NaveeCloudException("API_ERROR", "NAVEE returned no verification image.")
    val img = data.optString("img").substringAfter("base64,")
    val uuid = data.optString("uuid")
    if (img.isBlank() || uuid.isBlank()) throw NaveeCloudException("API_ERROR", "NAVEE returned an incomplete verification image.")
    return Captcha(img, uuid)
  }

  fun signIn(email: String, password: String, captchaCode: String, captchaUuid: String): Long {
    val body = JSONObject()
      .put("email", email)
      .put("passwd", password)
      .put("uuid", captchaUuid)
      .put("imgCode", captchaCode)
    val data = NaveeCloudResponses.unwrap(request("POST", "/login", body)) as? JSONObject
      ?: throw NaveeCloudException("API_ERROR", "NAVEE sign-in returned no session.")
    val newToken = data.optString("token").ifBlank { null }
      ?: throw NaveeCloudException("API_ERROR", "NAVEE sign-in returned no token.")
    val id = data.optLong("userId", 0L)
    if (id <= 0L) throw NaveeCloudException("API_ERROR", "NAVEE sign-in returned no account id.")
    token = newToken
    userId = id
    return id
  }

  fun listVehicles(): List<NaveeCloudResponses.Vehicle> {
    if (token == null) throw NaveeCloudException("NOT_SIGNED_IN", "Sign in to NAVEE first.")
    val body = request("GET", "/vehicle/getVehicle", null)
    // The account API's own vehicle list is the one response worth seeing in full when a
    // scooter the rider swears is bound comes back empty — no token or password in it.
    Log.d(TAG, "getVehicle raw response: $body")
    return NaveeCloudResponses.parseVehicles(NaveeCloudResponses.unwrap(body))
  }

  fun signOut() {
    token = null
    userId = null
  }

  private fun request(method: String, path: String, body: JSONObject?): String {
    val connection = URL(BASE_URL + path).openConnection() as HttpURLConnection
    try {
      connection.requestMethod = method
      connection.connectTimeout = REQUEST_TIMEOUT_MS
      connection.readTimeout = REQUEST_TIMEOUT_MS
      connection.setRequestProperty("Accept", "application/json")
      connection.setRequestProperty("platform", "android")
      connection.setRequestProperty("language", Locale.getDefault().language.ifBlank { "en" })
      connection.setRequestProperty("systemVersion", android.os.Build.VERSION.RELEASE ?: "")
      connection.setRequestProperty("model", android.os.Build.MODEL ?: "")
      connection.setRequestProperty("appVersion", APP_VERSION)
      connection.setRequestProperty("Authorization", token ?: "")
      connection.setRequestProperty("area", Locale.getDefault().country)
      if (body != null) {
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        connection.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
      }
      val status = connection.responseCode
      Log.d(TAG, "$method $path -> HTTP $status")
      if (status == 410) throw NaveeCloudException("APP_OUTDATED", "NAVEE rejected this app version. Cityroam needs an update for NAVEE sign-in.")
      val stream = if (status in 200..299) connection.inputStream else connection.errorStream
      val text = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() } ?: ""
      if (status !in 200..299 && text.isBlank()) throw NaveeCloudException("API_ERROR", "NAVEE answered HTTP $status.")
      return text
    } catch (e: NaveeCloudException) {
      throw e
    } catch (e: Exception) {
      throw NaveeCloudException("NETWORK", "Couldn't reach NAVEE: ${e.message ?: e.javaClass.simpleName}")
    } finally {
      connection.disconnect()
    }
  }
}
