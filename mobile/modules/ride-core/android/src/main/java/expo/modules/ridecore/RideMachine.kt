package expo.modules.ridecore

/**
 * Pure, JVM-testable ride state machine — the native counterpart of
 * `lib/tripStateMachine.ts`, simplified by one real rule change: there is no grace
 * period on disconnect. The board going offline ends the ride immediately (no
 * `reconnecting`/`stopped`-timeout state to track), matching the rider's own stated
 * rule: "if the device turns off, instantly end recording and auto save." A brief
 * link blip (not a genuine power-off) is handled one layer up, in [RideJournal] —
 * by re-opening the just-finished ride if the board's own trip counters (dp5/dp6)
 * prove it never actually reset, not by delaying the end/save here.
 *
 * The board's own wheel speed (dp2) is the sole driver of auto-start — GPS never
 * drives a ride's boundaries (PHONE = GPS only, DEVICE = telemetry).
 */
class RideMachine {
  enum class State { IDLE, RIDING, STOPPED, MANUAL }

  sealed class Event {
    object AutoStart : Event()
    /** `reason`: "board_off" (a live ride's board disconnected) or "forced" (a manual
     * force-end, e.g. the rider tapped "Finish trip"). */
    data class AutoEnd(val reason: String) : Event()
    object ManualStart : Event()
    object ManualEnd : Event()
  }

  companion object {
    // Mirrors tripStateMachine.ts's own constants exactly — same thresholds, same feel.
    const val START_SPEED_KMH = 10.0
    const val START_SUSTAIN_MS = 3_000L
    const val STOP_SPEED_KMH = 3.0
    const val EMA_ALPHA = 0.5
  }

  private var state = State.IDLE
  private var smoothedSpeedKmh = 0.0
  private var aboveStartThresholdSinceMs: Long? = null

  fun getState(): State = state

  private fun resetToIdle() {
    state = State.IDLE
    smoothedSpeedKmh = 0.0
    aboveStartThresholdSinceMs = null
  }

  /**
   * Board wheel-speed (dp2) sample in km/h — call on every push while connected.
   * Negative/non-finite readings are board noise, treated as 0 (matches
   * tripStateMachine.ts). Returns [Event.AutoStart] the moment a sustained-above-
   * threshold window completes; null otherwise. Manual rides ignore speed entirely
   * (the rider started it deliberately; standing still is expected).
   */
  fun onSample(rawSpeedKmh: Double, nowMs: Long): Event? {
    val speed = if (rawSpeedKmh.isFinite() && rawSpeedKmh > 0) rawSpeedKmh else 0.0
    smoothedSpeedKmh = EMA_ALPHA * speed + (1 - EMA_ALPHA) * smoothedSpeedKmh

    if (state == State.MANUAL) return null

    if (state == State.IDLE) {
      if (smoothedSpeedKmh >= START_SPEED_KMH) {
        val since = aboveStartThresholdSinceMs ?: nowMs.also { aboveStartThresholdSinceMs = it }
        if (nowMs - since >= START_SUSTAIN_MS) {
          aboveStartThresholdSinceMs = null
          state = State.RIDING
          return Event.AutoStart
        }
      } else {
        aboveStartThresholdSinceMs = null
      }
      return null
    }

    // RIDING / STOPPED: track for the route-freeze display distinction only — a
    // stationary board never ends the ride on its own, only a disconnect does.
    state = if (smoothedSpeedKmh < STOP_SPEED_KMH) State.STOPPED else State.RIDING
    return null
  }

  /**
   * The board disconnected — the sole auto-stop signal, with no grace period. Returns
   * null if idle (nothing to end).
   */
  fun onDisconnect(): Event? {
    if (state == State.IDLE) return null
    resetToIdle()
    return Event.AutoEnd("board_off")
  }

  fun beginManual(): Event {
    state = State.MANUAL
    smoothedSpeedKmh = 0.0
    aboveStartThresholdSinceMs = null
    return Event.ManualStart
  }

  /** Force-ends whatever's active — e.g. a manual "Finish trip" tap, or a manual ride
   * being superseded by a fresh auto-detected one. */
  fun forceEnd(): Event {
    val wasManual = state == State.MANUAL
    resetToIdle()
    return if (wasManual) Event.ManualEnd else Event.AutoEnd("forced")
  }

  fun isStopped(): Boolean = state == State.STOPPED
}
