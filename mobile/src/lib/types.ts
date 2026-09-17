// Wire types mirroring the backend's API response models (FastAPI + SQLModel). These
// are shared by the typed HTTP client (lib/api/) and the pure view/logic modules
// (activityStats, odometer, screens) so the shapes live in exactly one place.

export type TripSummary = {
  id: number;
  startTime: string;
  endTime: string;
  distanceKm: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  durationSec: number;
  wasManual: boolean;
  batteryStartPct: number | null;
  batteryEndPct: number | null;
  batteryUsedPct: number | null;
  odometerStartKm: number | null;
  odometerEndKm: number | null;
  heartRateAvgBpm: number | null;
  heartRateMaxBpm: number | null;
  heartRateStartBpm: number | null;
  heartRateEndBpm: number | null;
  restingHeartRateBpm: number | null;
  heartRateVariabilityMs: number | null;
  steps: number | null;
  weightKg: number | null;
  dominantMode: string | null;
  modeMixed: boolean;
  // One WMO weather_code per distinct condition spanned (e.g. [0, 61] for clear->rainy), via Open-Meteo — null if the trip predates this feature or lookup failed.
  weatherCodes: number[] | null;
  feelsLikeC: number | null;
  windSpeedMs: number | null;
  // The device that recorded the ride; null on trips from before per-device tracking.
  deviceId?: string | null;
};

export type TripDetail = TripSummary & {
  route: { lat: number; lon: number; timestampMs: number; speedKmh: number; accuracyM?: number | null }[];
  stops: { lat: number; lon: number; startTimestampMs: number; durationSec: number }[];
  // batteryPct is optional (same pattern as ModeSample in lib/tripTypes.ts) so old
  // trips recorded before this field existed still type-check — the server only
  // sends it when the per-mode snapshot poll had a battery reading at the time.
  modeSamples: { timestampMs: number; mode: string; batteryPct?: number | null }[];
  voltageSamples: { timestampMs: number; voltage: number }[];
  // Road-matched via self-hosted OSRM — null if matching is disabled/unreachable or the
  // trip is too short to match; callers should fall back to the raw `route` above.
  snappedRoute: { lat: number; lon: number }[] | null;
};

export type DeletedTripSummary = {
  id: number;
  startTime: string;
  distanceKm: number;
  deletedAt: string;
};

// Wire shape for /trips/in-progress — the backend's second durability layer for a
// currently-recording trip (see backend's InProgressTrip model docstring and
// lib/tripRecorder.ts's checkpoint()/recoverInterruptedTrip() for the full story).
export type InProgressTripPayload = {
  tripStartTime: string;
  wasManual: boolean;
  distanceKm: number;
  maxSpeedKmh: number;
  batteryStartPct: number | null;
  odometerStartKm: number | null;
  route: TripDetail['route'];
  stops: TripDetail['stops'];
  modeSamples: TripDetail['modeSamples'];
  voltageSamples: TripDetail['voltageSamples'];
  boardSpeedSamples: { timestampMs: number; speedKmh: number }[];
  lastUpdateTime: string;
};
