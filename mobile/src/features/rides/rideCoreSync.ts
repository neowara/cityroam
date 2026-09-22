import RideCoreNative, { type NativeRide, type NativeRideSamples } from '@modules/ride-core/src/RideCore';
import { logEvent } from '@/lib/log';
import { fetchVitalsForTrip, writeExerciseSessionForTrip } from '@/features/health/healthConnect';
import { resolveEnumLabel } from '@/features/device/boardDpSchema';
import { decodeMode } from '@/lib/mode';
import { finalizeTrip, type FinalizeInput } from '@/features/rides/tripFinalize';
import { clearCheckpoints } from '@/features/rides/tripRecorder/checkpoints';
import { hasQueuedTripNear } from '@/lib/db';
import { BOARD_SPEED_SAMPLE_MIN_INTERVAL_MS } from '@/features/rides/tripRecorder/tripRecord';
import { saveAndSyncTrip } from '@/features/rides/tripSync';
import { buildFinalizeSummaryPayload, notifyTripLifecycle } from '@/features/rides/tripNotifications';
import { shouldDiscardTrip } from '@/features/rides/tripStateMachine';
import type { BoardSpeedSample, ModeSample, RoutePoint, VoltageSample } from '@/features/rides/tripTypes';

/**
 * Bridges the native ride journal into two roles:
 *
 * 1. `syncNativeRides` is a finished-ride finalizer — turns a ride `RideService` fully
 *    captured (even with the JS runtime dead the whole time) into an actual saved
 *    trip, for rides the live JS path never saw at all (the process was killed before
 *    `tripRecorder.ts`'s own finalize ever ran). Reuses `tripFinalize.ts`'s discard
 *    guard and payload shape, and `saveAndSyncTrip`'s existing offline-first queue
 *    (docs/adr/0001) — a ride is durable in local SQLite the instant it's enqueued,
 *    and uploads whenever the backend is reachable, which is why this never needs to
 *    run *urgently*: called on app foreground/start, same cadence as
 *    `syncUnsyncedTrips`, not from any background timer. This is the only thing in
 *    this file that ever writes to the native journal (`markRideUploaded`).
 * 2. `getNativeTripData` is what `tripRecorder.ts`'s own live finalize/recovery
 *    paths call to source a trip's route, mode, and voltage samples from the native
 *    journal instead of the JS capture path — RideService/RideMachine
 *    still auto-start/stop independently of the JS state machine, board telemetry's
 *    odometer/battery/speed and the live UI are untouched. Deliberately read-only:
 *    it must NOT mark the matched ride uploaded. RideMachine's own reconnect-stitch
 *    logic (RideService.kt's findStitchCandidateLocked) only reopens a ride that's
 *    still in the 'finished' state — marking it 'uploaded' the instant the live path
 *    saves it would make a same-second BLE reconnect (well within the stitch window)
 *    silently open a new native ride instead of continuing this one. B1-c's
 *    clientTripId is what keeps `syncNativeRides` from creating a duplicate Trip if it
 *    later processes the same ride this path already saved.
 */

function toRoutePoint(g: NativeRideSamples['gps'][number]): RoutePoint {
  return {
    lat: g.lat,
    lon: g.lon,
    timestampMs: g.tMs,
    speedKmh: g.speedMs != null ? g.speedMs * 3.6 : 0,
    accuracyM: g.accM,
  };
}

/** Keeps only samples at least `intervalMs` apart, in the order given -- the native
 * journal writes a board row on every BLE push (its job is durability, not upload
 * size), so the derived mode/voltage/board-speed series below are thinned back down to
 * the same floor the JS capture path already applies to its own board-speed series
 * (BOARD_SPEED_SAMPLE_MIN_INTERVAL_MS) before they ever reach the backend or a chart.
 * Assumes `samples` is already ordered by timestamp (the journal's own
 * `ORDER BY t_ms ASC`), which every NativeRideSamples['board'] read already is. */
function thinByInterval<T extends { timestampMs: number }>(samples: T[], intervalMs: number): T[] {
  const out: T[] = [];
  let lastKeptAtMs = -Infinity;
  for (const s of samples) {
    if (s.timestampMs - lastKeptAtMs >= intervalMs) {
      out.push(s);
      lastKeptAtMs = s.timestampMs;
    }
  }
  return out;
}

function toModeSamples(board: NativeRideSamples['board']): ModeSample[] {
  // The journal stores dp14 exactly as the board sent it -- a bare enum INDEX ("2"),
  // not the "level_N" label. Only the live JS path resolves that index, via
  // deviceLink/session.ts's resolveEnumDps; the native service has no access to the
  // schema (it's JS-side only) and is deliberately a raw durability record. So resolve
  // the index here, on the way out, before decoding to the app's own mode names --
  // skipping this shipped a bug where every chip, breakdown and legend rendered a
  // bare "2" (or nothing at all, since "2" matches no known mode).
  return thinByInterval(
    board
      .filter((b) => b.mode != null)
      .map((b) => ({
        timestampMs: b.tMs,
        mode: decodeMode(resolveEnumLabel(RIDE_MODE_DP_ID, b.mode as string)),
        batteryPct: b.batteryPct,
      })),
    BOARD_SPEED_SAMPLE_MIN_INTERVAL_MS,
  );
}

function toVoltageSamples(board: NativeRideSamples['board']): VoltageSample[] {
  return thinByInterval(
    board.filter((b) => b.voltageV != null).map((b) => ({ timestampMs: b.tMs, voltage: b.voltageV as number })),
    BOARD_SPEED_SAMPLE_MIN_INTERVAL_MS,
  );
}

function toBoardSpeedSamples(board: NativeRideSamples['board']): BoardSpeedSample[] {
  return thinByInterval(
    board.filter((b) => b.speedKmh != null).map((b) => ({ timestampMs: b.tMs, speedKmh: b.speedKmh as number })),
    BOARD_SPEED_SAMPLE_MIN_INTERVAL_MS,
  );
}

function buildFinalizeInput(ride: NativeRide, samples: NativeRideSamples): FinalizeInput {
  return {
    tripStartMs: ride.startMs,
    endMs: ride.endMs ?? ride.startMs,
    wasManual: ride.wasManual,
    route: samples.gps.map(toRoutePoint),
    // The native journal doesn't yet track pause/stop markers separately from the
    // route itself — a real, disclosed gap, not an oversight. An empty list here is
    // the same shape a ride with no detected stops already produces today.
    stops: [],
    modeSamples: toModeSamples(samples.board),
    voltageSamples: toVoltageSamples(samples.board),
    boardSpeedSamples: toBoardSpeedSamples(samples.board),
    distanceKm: ride.distanceKm ?? 0,
    maxSpeedKmh: ride.maxSpeedKmh ?? 0,
    batteryStartPct: ride.batteryStartPct,
    odometerStartKm: ride.odoStartKm,
    batteryEndPct: ride.batteryEndPct,
    odometerEndKm: ride.odoEndKm,
  };
}

// dp14 (ride mode) — the one enum datapoint the journal carries, so the one that needs
// its raw wire index resolved back to a label on read (see toModeSamples).
const RIDE_MODE_DP_ID = '14';

// RideService's RideMachine and the JS TripStateMachine both react to the same board
// dp2 signal, but through independently-implemented auto-start thresholds — their
// exact start moments can differ by a couple of seconds even for the same real ride.
// Generous relative to the ~2ms clock skew B1-c's clientTripId already tolerates
// (same process clock there; this matches across two independent state machines).
const NATIVE_RIDE_MATCH_TOLERANCE_MS = 15_000;

/** The native journal's own ride row for a live JS trip, matched by start time since
 * no shared id exists between the two independently-started state machines. Checks
 * the currently-open ride first (the common case: this trip is still running, or
 * just ended, and RideService hasn't auto-stopped yet either), then finished-but-
 * unuploaded rides. Returns null (never throws) if the native module is unavailable
 * or nothing matches closely enough. */
function findNativeRideForTrip(tripStartMs: number): NativeRide | null {
  try {
    const candidates: NativeRide[] = [];
    const active = RideCoreNative.getActiveRide();
    if (active) candidates.push(active);
    candidates.push(...RideCoreNative.listFinishedRides());
    let best: NativeRide | null = null;
    let bestDeltaMs = Infinity;
    for (const ride of candidates) {
      const deltaMs = Math.abs(ride.startMs - tripStartMs);
      if (deltaMs < bestDeltaMs) {
        bestDeltaMs = deltaMs;
        best = ride;
      }
    }
    return best && bestDeltaMs <= NATIVE_RIDE_MATCH_TOLERANCE_MS ? best : null;
  } catch {
    // Native module absent (a build without ride-core prebuilt) — no match.
    return null;
  }
}

export type NativeTripData = {
  route: RoutePoint[];
  modeSamples: ModeSample[];
  voltageSamples: VoltageSample[];
  nativeRideId: number;
};

/**
 * Route, mode, and voltage samples for a live/recovered JS trip, sourced from the
 * native ride journal instead of the JS capture path —
 * `RideLocationManager` owns its own `FusedLocationProviderClient` on a dedicated
 * thread, independent of the Activity lifecycle, where the JS `watchPositionAsync`
 * subscription has real, measured gaps (45s+, twice, on one production ride).
 * `RideService`'s dp handler writes mode (dp14) and voltage (dp20) into the journal
 * on every BLE push, unconditionally — the JS equivalent (`TripRecord.snapshotAt`)
 * only runs from the 'start'/'end' snapshots and a 1s ticker that Android suspends
 * the moment the phone screen locks, so a real locked-phone ride can capture zero
 * mode/voltage samples all the way through (confirmed: a real ride's own 'start'
 * snapshot took 28 minutes to resolve, well past the point of being useful, and no
 * periodic tick ever ran in between). Board telemetry's odometer/battery/speed and
 * auto-start/stop/the live UI are unaffected — the route array, plus mode and
 * voltage, are all this replaces.
 *
 * Returns null (never throws) when no native ride matches closely enough or the
 * module is unavailable, so callers fall back to their own JS-collected data rather
 * than ever saving a trip with no route/samples at all.
 */
export function getNativeTripData(tripStartMs: number): NativeTripData | null {
  const ride = findNativeRideForTrip(tripStartMs);
  if (!ride) return null;
  try {
    const samples = RideCoreNative.getRideSamples(ride.id);
    return {
      route: samples.gps.map(toRoutePoint),
      modeSamples: toModeSamples(samples.board),
      voltageSamples: toVoltageSamples(samples.board),
      nativeRideId: ride.id,
    };
  } catch (err) {
    logEvent('trip', 'getRideSamples failed for the matched native ride', {
      nativeRideId: ride.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// A concurrent call joins the in-flight run instead of listing the same finished rides
// again. app/_layout.tsx calls this from its mount effect AND from
// useAppForegroundEffect (which also fires once on mount per its own contract), so two
// calls a few ms apart both listed the same ride before either marked it uploaded —
// as one native ride saved 4 times, and (since writeExerciseSessionForTrip
// has no dedupe key of its own) written into Health Connect 4 times too.
let syncInFlight: Promise<{ attempted: number; saved: number }> | null = null;

/** Finalizes every ride RideService has recorded but not yet uploaded. Safe to call
 * repeatedly/concurrently — each ride is only marked uploaded once its own save
 * actually lands, so a ride whose finalize throws simply stays 'finished' for the next
 * call to retry, the same recovery contract `recoverInterruptedTrip` already has for
 * the JS capture path. */
export function syncNativeRides(): Promise<{ attempted: number; saved: number }> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSyncNativeRides().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function runSyncNativeRides(): Promise<{ attempted: number; saved: number }> {
  let rides: NativeRide[];
  try {
    rides = RideCoreNative.listFinishedRides();
  } catch {
    // Native module absent (a build without ride-core prebuilt) — nothing to sync.
    return { attempted: 0, saved: 0 };
  }
  let saved = 0;
  for (const ride of rides) {
    try {
      // The live path usually saved this ride already. It leaves the native ride open to
      // stitch a quick reconnect, so the journal can't tell; the local queue can.
      // A failed lookup falls through to a normal save; the backend still dedupes.
      if (await hasQueuedTripNear(String(Math.round(ride.startMs / 1000))).catch(() => false)) {
        RideCoreNative.markRideUploaded(ride.id, null);
        logEvent('trip', 'native ride already saved by the live path', { rideId: ride.id });
        continue;
      }
      const samples = RideCoreNative.getRideSamples(ride.id);
      const input = buildFinalizeInput(ride, samples);
      const durationSec = Math.max(0, Math.floor((input.endMs - input.tripStartMs) / 1000));

      const outcome = await finalizeTrip(input, {
        fetchVitals: fetchVitalsForTrip,
        writeExerciseSession: writeExerciseSessionForTrip,
        saveAndSync: saveAndSyncTrip,
        // The native ride's own journal row is the durability record, not the JS
        // checkpoint table — nothing to clear there, but finalizeTrip's contract
        // still calls this at the same points the JS path does.
        clearCheckpoints,
        notifyTripSaved: () => {},
        shouldDiscard: shouldDiscardTrip,
      });

      if (outcome.outcome === 'saved') {
        RideCoreNative.markRideUploaded(ride.id, null);
        saved++;
        logEvent('trip', 'native ride saved', {
          rideId: ride.id,
          localId: outcome.saved.localId,
          durationSec,
          distanceKm: input.distanceKm,
        });
        // The live path posts this for rides it saved itself; a ride only the native
        // service captured gets it here, when it is finally saved. Gated on background.
        notifyTripLifecycle(
          'finalize-summary',
          buildFinalizeSummaryPayload({
            distanceKm: input.distanceKm,
            durationSec,
            maxSpeedKmh: input.maxSpeedKmh,
            batteryStartPct: input.batteryStartPct,
            batteryEndPct: input.batteryEndPct,
            dominantMode: null,
            localId: outcome.saved.localId,
          }),
        ).catch(() => {});
      } else if (outcome.outcome === 'discarded') {
        RideCoreNative.markRideUploaded(ride.id, null);
        logEvent('trip', 'native ride discarded (misclick guard)', { rideId: ride.id, reason: outcome.reason });
      } else {
        logEvent('trip', 'native ride finalize failed — left for the next sync pass', { rideId: ride.id, reason: outcome.reason });
      }
    } catch (err) {
      logEvent('trip', 'native ride sync threw', { rideId: ride.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { attempted: rides.length, saved };
}
