package expo.modules.devicepower

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.telephony.TelephonyManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Name is a holdover from when this module also wrapped UsageStatsManager for
// Tuya Cloud status checks; only the unrelated battery-optimization check below
// remains, kept here rather than renamed to avoid a risky native module rename.
class DevicePowerModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("DevicePower")

    // expo-intent-launcher can open the battery-optimization settings screen but has
    // no status check of its own; PowerManager.isIgnoringBatteryOptimizations is the
    // direct Android API for it and needs no extra permission.
    Function("isIgnoringBatteryOptimizations") {
      val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      powerManager.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * Opens the system dialog to exempt THIS app from battery optimization.
     *
     * Built from `context.packageName` — never a literal — because the app was
     * `com.neowara.turbo` before the 3.2.0 rename to `com.neowara.cityroam`, and a
     * hardcoded pre-rename id here (the bug this replaces, previously in
     * `lib/tripRecorder/location.ts` via `expo-intent-launcher`) opened the settings
     * screen for an app that no longer exists — silently a no-op, with the rider never
     * able to grant the exemption every background-start-a-foreground-service path in
     * this app depends on.
     */
    AsyncFunction("requestIgnoreBatteryOptimizations") { promise: Promise ->
      try {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
          data = Uri.parse("package:${context.packageName}")
          // `context` here is always the react context, never an Activity — even with
          // one on screen, launching through it (not `currentActivity`) still requires
          // this flag, or Android throws instead of opening the dialog. Unconditional,
          // not gated on whether an Activity happens to be on hand.
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("REQUEST_FAILED", e.message ?: "Could not open the battery optimization screen.", e)
      }
    }

    // System-wide Battery Saver is a distinct mechanism from the per-app
    // battery-optimization whitelist above — exempting the app from the latter does
    // NOT exempt it from the former, and Battery Saver can still restrict
    // foreground-service location delivery on some OEM builds with no app-level
    // override. isPowerSaveMode() (API 21+) is used instead of the API 28+-only
    // getLocationPowerSaverMode() so this works on every supported Android version.
    Function("isPowerSaveModeOn") {
      val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      powerManager.isPowerSaveMode
    }

    // The OS display-language locale (what expo-localization reads) is a UI
    // preference, not a location — a phone set to English (United States) reports
    // region "US" from a Swedish SIM on a Swedish network, which is exactly wrong
    // for routing a Tuya sign-in to the right regional data centre. The SIM/network
    // country is the actual answer to "where does this account most likely live,"
    // and neither call needs a runtime permission (unlike getLine1Number and similar
    // telephony methods, these two are unprotected on every supported API level).
    // Network country is preferred when registered; SIM country covers Wi-Fi-only /
    // airplane-mode-with-Wi-Fi devices the network call can't answer for.
    Function("networkCountryIso") {
      val telephony = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
      val network = telephony?.networkCountryIso?.uppercase()?.takeIf { it.isNotBlank() }
      val sim = telephony?.simCountryIso?.uppercase()?.takeIf { it.isNotBlank() }
      network ?: sim
    }
  }
}
