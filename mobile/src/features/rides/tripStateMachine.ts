/**
 * Automatic trip detection, pure logic (no native deps, unit-testable). Feed it
 * board wheel-speed (dp2) samples one at a time; it tracks an EMA-smoothed speed
 * and emits state transitions. The board's own wheel-based speed sensor is the
 * source of truth for auto-start — GPS contributes only location, never
 * speed-based trip boundaries.
 * A manual Start/End Trip tap bypasses speed-based auto-start detection entirely
 * (call `beginManual`/`endManual` instead) — the two paths can never double-log the
 * same ride. A BLE disconnect ends both an auto and a manual trip (see
 * checkBleDisconnect) — a lost board is a real "this ride is over" signal regardless
 * of how the trip started.
 *
 * There is no speed-based stop timeout: the board is never offline mid-trip, so a
 * disconnect is always a trip end — BLE disconnect is the *sole* auto-stop signal.
 * The `stopped` state still tracks a stationary board (speed below the stop
 * threshold) purely so the recorder can freeze route recording against GPS jitter
 * while the rider waits at a light; it never ends the trip on its own.
 *
 * There is no recording without the board connected — a disconnect ends and saves
 * the trip immediately, no grace period. `deviceOffline` already reflects the Tuya
 * SDK's own `onStatusChanged` callback (see deviceLink/session.ts), which absorbs
 * transient radio blips before ever reporting offline, so there's no separate
 * debounce to add on top of that.
 */

export type TripState = 'idle' | 'riding' | 'stopped' | 'manual';

export type TripEvent =
  | { type: 'auto_start' }
  | { type: 'auto_end'; reason: 'ble_disconnect' | 'forced'; offlineForMs?: number }
  | { type: 'manual_start' }
  | { type: 'manual_end' };

// Auto-start fires when the board's wheel speed (dp2) clears this threshold while
// connected. 10 km/h is the board's real minimum ride speed — a GPS-based threshold
// would need to run higher to reject GPS jitter, which the board's own wheel sensor
// doesn't have.
const START_SPEED_KMH = 10;
// Long enough to reject a single speed blip, short enough to not feel like lag before a ride is recognized as started.
const START_SUSTAIN_MS = 3_000;
// Below this smoothed speed the board is treated as stationary — the machine reports
// `stopped` so the recorder freezes route recording against GPS jitter. It never ends
// the trip on its own (auto-stop is BLE-disconnect only).
const STOP_SPEED_KMH = 3;
// High enough that smoothed speed catches up to actual speed quickly, keeping perceived start lag low.
const EMA_ALPHA = 0.5;

export class TripStateMachine {
  private state: TripState = 'idle';
  private smoothedSpeedKmh = 0;
  private aboveStartThresholdSinceMs: number | null = null;
  private offlineSinceMs: number | null = null;

  getState(): TripState {
    return this.state;
  }

  /** Returns the machine to a clean 'idle', wiping every accumulator. Called on every
   * path that ends a trip (BLE-disconnect auto_end, forceEnd, endManual) and on
   * cancelAutoStart. Without the smoothed-speed wipe, a ride that auto-ended while
   * moving left smoothedSpeedKmh high (e.g. 25); the next ride's first stationary
   * sample then decayed it to ~12.5 — still above START_SPEED_KMH — so the machine
   * wrongly opened a sustain window (and, with a stale aboveStartThresholdSinceMs from
   * the previous ride, could auto-start on a board that had barely begun to move, or
   * never fire at all). Each ride must start from a clean slate. */
  private resetToIdle(): void {
    this.state = 'idle';
    this.smoothedSpeedKmh = 0;
    this.aboveStartThresholdSinceMs = null;
    this.offlineSinceMs = null;
  }

  getSmoothedSpeedKmh(): number {
    return this.smoothedSpeedKmh;
  }

  /** Reports whether the board is offline right now — shared by the manual and
   * riding/stopped branches, since a lost board is the same "the ride is over"
   * signal in both. No grace period: the very first `deviceOffline` sample ends
   * the trip. `offlineSinceMs` still tracks when the disconnect started so
   * `offlineForMs` is meaningful in the emitted event, even though it's always
   * ~0 by the time this fires. */
  private checkBleDisconnect(deviceOffline: boolean, timestampMs: number): { hit: boolean; offlineForMs?: number } {
    if (!deviceOffline) {
      this.offlineSinceMs = null;
      return { hit: false };
    }
    if (this.offlineSinceMs === null) this.offlineSinceMs = timestampMs;
    const offlineForMs = timestampMs - this.offlineSinceMs;
    this.offlineSinceMs = null;
    return { hit: true, offlineForMs };
  }

  /** Raw board wheel-speed (dp2) sample (km/h; negative/NaN readings are noise from
   * the board and treated as 0). The board's wheel sensor is the source of truth for
   * auto-start — GPS never drives trip boundaries. Auto-stop is BLE-disconnect only:
   * `deviceOffline` feeds checkBleDisconnect, the sole "did the trip end" signal. The
   * `stopped` state below is a display/route-freeze distinction only — it never ends
   * the trip on its own. */
  onSample(rawSpeedKmh: number, timestampMs: number, deviceOffline = false): TripEvent | null {
    const speed = Number.isFinite(rawSpeedKmh) && rawSpeedKmh > 0 ? rawSpeedKmh : 0;
    this.smoothedSpeedKmh = EMA_ALPHA * speed + (1 - EMA_ALPHA) * this.smoothedSpeedKmh;

    if (this.state === 'manual') {
      // Speed-based stop detection doesn't apply to a manual trip (the rider started
      // it deliberately, standing still is expected), but a lost board is still a real
      // "this ride is over" signal — otherwise a manual trip would keep recording
      // indefinitely after the board dies.
      const { hit, offlineForMs } = this.checkBleDisconnect(deviceOffline, timestampMs);
      if (hit) {
        this.resetToIdle();
        return { type: 'auto_end', reason: 'ble_disconnect', offlineForMs };
      }
      return null;
    }

    if (this.state === 'idle') {
      this.offlineSinceMs = null;
      // The board's own wheel speed is ground truth for auto-start — no motion-activity
      // gate, so a false Activity-Recognition "stationary" verdict can't hold a real
      // start back.
      if (this.smoothedSpeedKmh >= START_SPEED_KMH) {
        if (this.aboveStartThresholdSinceMs === null) this.aboveStartThresholdSinceMs = timestampMs;
        if (timestampMs - this.aboveStartThresholdSinceMs >= START_SUSTAIN_MS) {
          this.aboveStartThresholdSinceMs = null;
          this.state = 'riding';
          return { type: 'auto_start' };
        }
      } else {
        this.aboveStartThresholdSinceMs = null;
      }
      return null;
    }

    if (this.state === 'riding' || this.state === 'stopped') {
      // Track riding vs stopped purely so the recorder can freeze route recording
      // against stationary GPS jitter. A stationary board never ends the trip on its
      // own — only a BLE disconnect does.
      this.state = this.smoothedSpeedKmh < STOP_SPEED_KMH ? 'stopped' : 'riding';

      const { hit: bleDisconnectHit, offlineForMs } = this.checkBleDisconnect(deviceOffline, timestampMs);
      if (bleDisconnectHit) {
        this.resetToIdle();
        return { type: 'auto_end', reason: 'ble_disconnect', offlineForMs };
      }
      return null;
    }

    return null;
  }

  beginManual(): TripEvent {
    this.state = 'manual';
    this.smoothedSpeedKmh = 0;
    this.aboveStartThresholdSinceMs = null;
    this.offlineSinceMs = null;
    return { type: 'manual_start' };
  }

  endManual(): TripEvent {
    this.resetToIdle();
    return { type: 'manual_end' };
  }

  /** Force-ends whatever's currently active (auto riding/stopped, or manual) — e.g. the user tapping "End Trip" on an auto-detected ride. */
  forceEnd(): TripEvent {
    const wasManual = this.state === 'manual';
    this.resetToIdle();
    return wasManual ? { type: 'manual_end' } : { type: 'auto_end', reason: 'forced' };
  }

  cancelAutoStart(): void {
    this.resetToIdle();
  }
}

// Two independent floors, OR'd — the old AND-based guard let a multi-minute, zero-distance trip (GPS never got a fix) escape since duration alone cleared it.
export const MIN_TRIP_DISTANCE_KM = 0.1;
export const MIN_TRIP_DURATION_SEC = 10;

/** Minimum-viability guard — silent discard, protects against accidental
 * double-taps and rides that never happened. A manual finish only applies the
 * duration floor (not distance) — tapping "Finish trip" is deliberate confirmation, even for a short/slow ride. */
export function shouldDiscardTrip(distanceKm: number, durationSec: number, wasManual = false): boolean {
  if (wasManual) return durationSec < MIN_TRIP_DURATION_SEC;
  return distanceKm < MIN_TRIP_DISTANCE_KM || durationSec < MIN_TRIP_DURATION_SEC;
}
