import type { QueuedTrip } from '@/lib/db';
import type { TripDetail, TripSummary } from '@/lib/types';

/** How a locally-queued (not yet uploaded) trip is represented alongside real backend
 * trips throughout the app: same `TripSummary`/`TripDetail` shape, `id` set to the
 * negation of its `trip_queue.localId` — real backend ids are always positive
 * (Postgres serial), so this can never collide. Every id-keyed screen (rides list,
 * activity list, the dashboard's last-ride card, trip/[id].tsx, the widget's tap-
 * through) already works unchanged: `id < 0` is the one thing that means "not backed
 * up yet," everywhere. */

export function isLocalTripId(id: number): boolean {
  return id < 0;
}

export function localIdFromTripId(id: number): number {
  return -id;
}

export function tripIdFromLocalId(localId: number): number {
  return -localId;
}

/** Rides don't get logged one mode at a time — pick whichever mode has the most
 * samples as "dominant," same intent as the backend's own computation, just derived
 * client-side since a locally-queued trip has never been through the backend. */
function computeDominantMode(modeSamples: { mode: string }[]): { dominantMode: string | null; modeMixed: boolean } {
  const counts = new Map<string, number>();
  for (const s of modeSamples) counts.set(s.mode, (counts.get(s.mode) ?? 0) + 1);
  if (counts.size === 0) return { dominantMode: null, modeMixed: false };
  const [dominantMode] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { dominantMode, modeMixed: counts.size > 1 };
}

/** Maps a trip_queue row into the same TripDetail shape a synced backend trip has.
 * Everything the backend would otherwise compute (weather, elevation, road-matched
 * route) simply isn't available yet — null/empty until the trip is uploaded. */
export function queuedTripToDetail(queued: QueuedTrip): TripDetail {
  const { payload } = queued;
  const { dominantMode, modeMixed } = computeDominantMode(payload.modeSamples);
  return {
    id: tripIdFromLocalId(queued.localId),
    startTime: payload.startTime,
    endTime: payload.endTime,
    distanceKm: payload.distanceKm,
    avgSpeedKmh: payload.avgSpeedKmh,
    maxSpeedKmh: payload.maxSpeedKmh,
    durationSec: payload.durationSec,
    wasManual: payload.wasManual,
    batteryStartPct: payload.batteryStartPct,
    batteryEndPct: payload.batteryEndPct,
    batteryUsedPct: payload.batteryUsedPct,
    odometerStartKm: payload.odometerStartKm,
    odometerEndKm: payload.odometerEndKm,
    heartRateAvgBpm: payload.heartRateAvgBpm,
    heartRateMaxBpm: payload.heartRateMaxBpm,
    heartRateStartBpm: payload.heartRateStartBpm,
    heartRateEndBpm: payload.heartRateEndBpm,
    restingHeartRateBpm: payload.restingHeartRateBpm,
    heartRateVariabilityMs: payload.heartRateVariabilityMs,
    steps: payload.steps,
    weightKg: payload.weightKg,
    dominantMode,
    modeMixed,
    weatherCodes: null,
    feelsLikeC: null,
    windSpeedMs: null,
    route: payload.route,
    stops: payload.stops,
    modeSamples: payload.modeSamples,
    voltageSamples: payload.voltageSamples,
    // Road map-matching only happens server-side (self-hosted OSRM) — nothing to show
    // until this trip's been uploaded; every consumer already falls back to the raw
    // route when snappedRoute is null (predates this — same case as matching being
    // disabled/unreachable for a synced trip).
    snappedRoute: null,
  };
}

export function queuedTripToSummary(queued: QueuedTrip): TripSummary {
  const {
    route: _route,
    stops: _stops,
    modeSamples: _modeSamples,
    voltageSamples: _voltageSamples,
    snappedRoute: _snappedRoute,
    ...summary
  } = queuedTripToDetail(queued);
  return summary;
}
