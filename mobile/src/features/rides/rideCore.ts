import RideCoreNative from '@modules/ride-core/src/RideCore';
import { logEvent } from '@/lib/log';

/**
 * Thin wrapper over the native ride-recording service — see RideService.kt's own doc
 * comment for what this is and, importantly, what it is NOT yet: a durable, JS-
 * independent capture backstop (every ride it sees while running is fully recorded in
 * its own SQLite journal regardless of the JS runtime's state), not yet the app's
 * primary save/upload pipeline. `lib/tripRecorder.ts` remains what actually reaches the
 * backend today.
 *
 * Started/stopped alongside background BLE reconnection (see backgroundSelfHeal.ts) —
 * same gating (a board paired, Bluetooth permission granted), since without a board to
 * connect to there is nothing for this service to capture. Never started/stopped in
 * response to board connection or ride state itself once running (ADR 0004's rule).
 */
export function startNativeRideCapture(): void {
  try {
    RideCoreNative.start();
  } catch (err) {
    logEvent('trip', 'RideCore start failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function stopNativeRideCapture(): void {
  try {
    RideCoreNative.stop();
  } catch (err) {
    logEvent('trip', 'RideCore stop failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
