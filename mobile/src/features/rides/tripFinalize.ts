import { MIN_TRIP_DISTANCE_KM, MIN_TRIP_DURATION_SEC } from '@/features/rides/tripStateMachine';
import type { VitalsResult } from '@/features/health/healthConnect';
import { logEvent } from '@/lib/log';
import type { BoardSpeedSample, ModeSample, RoutePoint, Stop, TripCreate, VoltageSample } from '@/features/rides/tripTypes';

/** Single deep module for end-of-ride finalize behavior, shared by the live-finish
 * path and crash-recovery so the two can't drift. Pure — every side-effecting
 * dependency is injected, nothing is imported directly. */

/** Normalized finalize input — the caller maps its own state (live `this.*` or a
 * recovered checkpoint) into this shape. */
export type FinalizeInput = {
  tripStartMs: number;
  /** The ride's end timestamp — the live path passes the real end, recovery passes
   * checkpoint.lastUpdateMs. */
  endMs: number;
  wasManual: boolean;
  route: RoutePoint[];
  stops: Stop[];
  modeSamples: ModeSample[];
  voltageSamples: VoltageSample[];
  boardSpeedSamples: BoardSpeedSample[];
  distanceKm: number;
  maxSpeedKmh: number;
  batteryStartPct: number | null;
  odometerStartKm: number | null;
  /** null for recovery — no live end-of-trip snapshot was possible. */
  batteryEndPct: number | null;
  /** null for recovery — no live end-of-trip snapshot was possible. */
  odometerEndKm: number | null;
};

/** All side-effecting dependencies, injected by the caller. */
export type FinalizeDeps = {
  fetchVitals: (start: Date, end: Date) => Promise<VitalsResult>;
  writeExerciseSession: (start: Date, end: Date, distanceKm: number, route: RoutePoint[], clientTripId: string) => Promise<void>;
  /** onLocallyQueued fires the instant the trip is durably enqueued locally, before
   * the network sync attempt inside this same call — see tripSync.ts's
   * saveAndSyncTrip for why this needs to be a distinct, earlier notification than
   * notifyTripSaved below rather than folded into one post-hoc call. */
  saveAndSync: (payload: TripCreate, onLocallyQueued?: (localId: number) => void) => Promise<{ localId: number; synced: boolean }>;
  /** The caller wires this to the local clearTripCheckpoint + backend
   * deleteInProgressTrip pair. */
  clearCheckpoints: () => Promise<void>;
  /** The caller wires this to the existing saveListeners/onTripSaved emitter. */
  notifyTripSaved: () => void;
  shouldDiscard: (distanceKm: number, durationSec: number, wasManual?: boolean) => boolean;
};

export type FinalizeResult =
  | { outcome: 'saved'; saved: { localId: number; synced: boolean } }
  | { outcome: 'discarded'; reason: 'too-short' | 'too-far' }
  | { outcome: 'failed'; reason: 'vitals' | 'health-write' | 'sync' };

export async function finalizeTrip(input: FinalizeInput, deps: FinalizeDeps): Promise<FinalizeResult> {
  const {
    tripStartMs,
    endMs,
    wasManual,
    route,
    stops,
    modeSamples,
    voltageSamples,
    boardSpeedSamples,
    distanceKm,
    maxSpeedKmh,
    batteryStartPct,
    odometerStartKm,
    batteryEndPct,
    odometerEndKm,
  } = input;
  const { fetchVitals, writeExerciseSession, saveAndSync, clearCheckpoints, notifyTripSaved, shouldDiscard } = deps;

  const durationSec = Math.max(0, Math.floor((endMs - tripStartMs) / 1000));
  const avgSpeedKmh = durationSec > 0 ? distanceKm / (durationSec / 3600) : 0;

  // 1. Discard guard — MANUAL-AWARE on both paths (fixes the old recovery bug where a
  // manual checkpoint was judged by the auto rule).
  if (shouldDiscard(distanceKm, durationSec, wasManual)) {
    let reason: 'too-short' | 'too-far';
    if (wasManual && durationSec < MIN_TRIP_DURATION_SEC) {
      reason = 'too-short';
    } else if (distanceKm < MIN_TRIP_DISTANCE_KM) {
      reason = 'too-far';
    } else {
      reason = 'too-short';
    }
    logEvent('trip-finalize', 'discarded', { reason, distanceKm, durationSec, wasManual });
    clearCheckpoints();
    return { outcome: 'discarded', reason };
  }

  const start = new Date(tripStartMs);
  // Rounded to the second: the live path and the native ride journal clock the same ride's
  // start a few ms apart and must produce the same key. The backend dedupes trips on it, and
  // Health Connect dedupes the exercise session on it.
  const clientTripId = String(Math.round(tripStartMs / 1000));
  const end = new Date(endMs);

  // 2. Health Connect reads + workout write. A failure here is a real (degraded)
  // outcome, not a save failure — nothing has been persisted yet, so there is nothing
  // to clean up: no checkpoint clear, no notify. fetchVitals/writeExerciseSession are
  // themselves best-effort (they swallow their own errors, see healthConnect.ts) so
  // these catches are belt-and-suspenders — logged distinctly from a real save failure
  // below so "the ride didn't save" is never confused with "Health Connect hiccuped."
  let vitals: VitalsResult;
  try {
    vitals = await fetchVitals(start, end);
  } catch (err) {
    logEvent('trip-finalize', 'failed: vitals fetch threw (unexpected — healthConnect.ts should swallow this)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'failed', reason: 'vitals' };
  }

  try {
    await writeExerciseSession(start, end, distanceKm, route, clientTripId);
  } catch (err) {
    logEvent('trip-finalize', 'failed: health-write threw (unexpected — healthConnect.ts should swallow this)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'failed', reason: 'health-write' };
  }

  // 3. Build the TripCreate payload exactly as the recorder did (see tripRecorder.ts's
  // old inline finalize tails — both live and recovery built the same shape).
  const payload: TripCreate = {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    distanceKm,
    avgSpeedKmh,
    maxSpeedKmh,
    durationSec,
    wasManual,
    batteryStartPct,
    batteryEndPct,
    batteryUsedPct: batteryStartPct !== null && batteryEndPct !== null ? batteryStartPct - batteryEndPct : null,
    odometerStartKm,
    odometerEndKm,
    ...vitals,
    route,
    stops,
    modeSamples,
    voltageSamples,
    boardSpeedSamples,
    clientTripId,
  };

  // 4. Persist (queue-first). saveAndSync only throws when the trip couldn't even be
  // written to the local queue (LocalEnqueueError — see tripSync.ts); a network-only
  // failure is caught inside it and comes back as synced:false, not a throw. So a catch
  // here means the trip isn't durably saved anywhere yet — the checkpoint stays intact
  // (no clear, no notify) as the only remaining path back to it, via recovery.
  let saved: { localId: number; synced: boolean };
  try {
    // notifyTripSaved is deliberately called here too (not just after this resolves
    // below) — the trips list would otherwise only ever see the trip's final state,
    // never the local/offline entry the sync attempt is racing against.
    saved = await saveAndSync(payload, () => notifyTripSaved());
  } catch (err) {
    logEvent('trip-finalize', 'failed: trip not durably saved anywhere — checkpoint kept for recovery', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'failed', reason: 'sync' };
  }

  // 5. Only past the durable persist is the trip safe to stop tracking: clear the
  // checkpoint AFTER the save (consistent with the live-path ordering fix), then
  // notify again so the trips list reflects the final synced/queued state — the
  // earlier notify above (right after local enqueue) already got the local entry
  // showing; this one flips its badge rather than being the trip's first appearance.
  await clearCheckpoints();
  notifyTripSaved();
  return { outcome: 'saved', saved };
}
