import { api, type InProgressTripPayload } from '@/lib/api';
import { clearTripCheckpoint, saveTripCheckpoint, type TripCheckpoint } from '@/lib/db';
import { logEvent } from '@/lib/log';
import { resolveTripDeviceId } from '@/features/rides/tripDevice';

/** Best-effort, both layers, never throws — called wherever a checkpoint's job is
 * done. Accepted low-probability race: an already-in-flight periodic upsert could
 * land just after this delete and resurrect a stale row; worst case is one duplicate
 * trip recovered next launch, recoverable via the existing trip-delete UI. */
export async function clearCheckpoints(): Promise<void> {
  clearTripCheckpoint().catch(() => {});
  const deviceId = await resolveTripDeviceId();
  if (deviceId) api.deleteInProgressTrip(deviceId).catch(() => {});
}

/** Backend's wire format uses ISO strings for the two timestamps; everything else
 * (both layers checkpoint the identical set of fields) lines up directly with
 * lib/db.ts's TripCheckpoint. */
export function fromBackendPayload(payload: InProgressTripPayload): TripCheckpoint {
  return {
    deviceId: payload.deviceId,
    tripStartMs: new Date(payload.tripStartTime).getTime(),
    wasManual: payload.wasManual,
    route: payload.route,
    stops: payload.stops,
    modeSamples: payload.modeSamples,
    voltageSamples: payload.voltageSamples,
    boardSpeedSamples: payload.boardSpeedSamples ?? [],
    distanceKm: payload.distanceKm,
    maxSpeedKmh: payload.maxSpeedKmh,
    batteryStartPct: payload.batteryStartPct,
    odometerStartKm: payload.odometerStartKm,
    // The backend's in-progress payload predates the rolling-latest fields, so they
    // default to null here — recovery falls back to board-speed integration when they
    // aren't present (see recoverInterruptedTrip).
    latestOdometerKm: null,
    latestBatteryPct: null,
    lastUpdateMs: new Date(payload.lastUpdateTime).getTime(),
  };
}

/** Durable checkpoint write, both layers. Local storage is primary (survives an
 * OS-killed process) and never waits on the network; the backend upsert is
 * fire-and-forget so a slow/unreachable request can't block a location sample. */
export async function writeCheckpoint(checkpoint: TripCheckpoint): Promise<void> {
  try {
    await saveTripCheckpoint(checkpoint);
  } catch (err) {
    logEvent('trip', 'checkpoint failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // The backend copy is per device; a ride whose device isn't known keeps only the local one.
  if (!checkpoint.deviceId) return;
  api
    .upsertInProgressTrip({
      deviceId: checkpoint.deviceId,
      tripStartTime: new Date(checkpoint.tripStartMs).toISOString(),
      wasManual: checkpoint.wasManual,
      distanceKm: checkpoint.distanceKm,
      maxSpeedKmh: checkpoint.maxSpeedKmh,
      batteryStartPct: checkpoint.batteryStartPct,
      odometerStartKm: checkpoint.odometerStartKm,
      route: checkpoint.route,
      stops: checkpoint.stops,
      modeSamples: checkpoint.modeSamples,
      voltageSamples: checkpoint.voltageSamples,
      boardSpeedSamples: checkpoint.boardSpeedSamples,
      lastUpdateTime: new Date(checkpoint.lastUpdateMs).toISOString(),
    })
    .catch((err) => logEvent('trip', 'backend checkpoint failed', { error: err instanceof Error ? err.message : String(err) }));
}
