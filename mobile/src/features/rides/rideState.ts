import RideCoreNative, { type NativeRide } from '@modules/ride-core/src/RideCore';

import { tripRecorder } from '@/features/rides/tripRecorder';

/**
 * The native journal's open ride row, or null. Returns null rather than throwing when
 * the native module isn't present (a build without ride-core prebuilt) — every caller
 * treats an unreadable journal as "no native ride", never as an error.
 */
export function safeGetActiveRide(): NativeRide | null {
  try {
    return RideCoreNative.getActiveRide() ?? null;
  } catch {
    return null;
  }
}

/**
 * How long an open journal row can go without a single gps/board/event sample before
 * it stops counting as a ride in progress. Well above the 60s stitch window and any
 * plausible telemetry gap (a light, a pocket, a lost fix), far below "forever".
 *
 * The bound exists because nothing in JS can close an open row: only board telemetry
 * drives finishActiveRide, so a process killed mid-ride leaves a row that stays open
 * indefinitely if the board never comes back.
 */
export const RIDE_STALE_AFTER_MS = 15 * 60 * 1000;

/** Why a ride counts as in progress — carries the journal's own numbers so a caller
 * that refuses to act on it can log which signal fired and how old it was. */
export type ActiveRideSignal =
  | { active: false }
  | { active: true; source: 'recorder' }
  | { active: true; source: 'journal'; rideId: number; startMs: number; lastActivityMs: number | null };

/**
 * Whether a ride is genuinely happening right now — the canonical predicate, shared by
 * everything that must not disrupt a ride in progress.
 *
 * Deliberately not `RideCoreNative.isRunning()`: that reports whether the RideService
 * foreground service is alive, and per ADR 0004 the service is started once and never
 * stopped in response to ride state, so it is true for nearly the whole life of the app.
 */
export function activeRideSignal(nowMs: number = Date.now()): ActiveRideSignal {
  if (tripRecorder.isTripActive()) return { active: true, source: 'recorder' };
  const ride = safeGetActiveRide();
  if (!ride) return { active: false };
  const lastActivityMs = safeGetRideLastActivityMs(ride.id);
  // No samples at all falls back to the row's own start — a row opened seconds ago is
  // a real ride that simply hasn't recorded anything yet.
  const lastSignMs = lastActivityMs ?? ride.startMs;
  if (nowMs - lastSignMs > RIDE_STALE_AFTER_MS) return { active: false };
  return { active: true, source: 'journal', rideId: ride.id, startMs: ride.startMs, lastActivityMs };
}

/** `activeRideSignal` for callers that only need the yes/no. */
export function isRideInProgress(nowMs: number = Date.now()): boolean {
  return activeRideSignal(nowMs).active;
}

function safeGetRideLastActivityMs(rideId: number): number | null {
  try {
    return RideCoreNative.getRideLastActivityMs(rideId) ?? null;
  } catch {
    return null;
  }
}
