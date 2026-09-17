package expo.modules.naveeble

import org.json.JSONArray
import org.json.JSONObject

class NaveeCloudException(val code: String, message: String) : Exception(message)

/** The account API's response shapes, kept free of Android imports so they run as JVM tests. */
object NaveeCloudResponses {
  data class Vehicle(
    /** The account's identifier for the scooter — also printed in its advertisement. */
    val mac: String,
    val name: String?,
    val carNo: String?,
    val productId: String?,
    /** Non-zero when the scooter is shared with this account; it's then the owner's id. */
    val shareUserId: Long,
  )

  /** Splits `{code, msg, data}`; throws on anything but code 200. */
  fun unwrap(body: String): Any? {
    val json = try {
      JSONObject(body)
    } catch (e: Exception) {
      throw NaveeCloudException("API_ERROR", "NAVEE returned something that isn't JSON.")
    }
    val code = json.optInt("code", -1)
    val msg = json.optString("msg").ifBlank { "NAVEE returned code $code." }
    when (code) {
      200 -> return if (json.isNull("data")) null else json.get("data")
      401 -> throw NaveeCloudException("NOT_SIGNED_IN", "Your NAVEE session expired. Sign in again.")
      410 -> throw NaveeCloudException("APP_OUTDATED", "NAVEE rejected this app version. Cityroam needs an update for NAVEE sign-in.")
      else -> throw NaveeCloudException("API_ERROR", msg)
    }
  }

  fun parseVehicles(data: Any?): List<Vehicle> {
    val array = data as? JSONArray ?: return emptyList()
    val out = ArrayList<Vehicle>()
    for (i in 0 until array.length()) {
      val v = array.optJSONObject(i) ?: continue
      val mac = v.optString("mac").takeIf { it.isNotBlank() } ?: continue
      val model = v.optJSONObject("model")
      out += Vehicle(
        mac = NaveeAdvertisement.normalizeMac(mac),
        name = v.optString("vehicleName").ifBlank { null } ?: model?.optString("name")?.ifBlank { null },
        carNo = v.optString("carNo").ifBlank { null },
        productId = model?.optString("pid")?.ifBlank { null },
        shareUserId = v.optLong("shareUserId", 0L),
      )
    }
    return out
  }
}
