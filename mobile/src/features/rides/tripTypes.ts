// accuracyM: GPS fix radius of uncertainty in meters — optional so old trips still type-check; absent/null means "unknown," not "perfect."
export type RoutePoint = { lat: number; lon: number; timestampMs: number; speedKmh: number; accuracyM?: number | null };
export type Stop = { lat: number; lon: number; startTimestampMs: number; durationSec: number };
// batteryPct optional for the same reason as accuracyM above — lets the backend attribute battery usage per-mode for a mixed-mode ride.
export type ModeSample = { timestampMs: number; mode: string; batteryPct?: number | null };
export type VoltageSample = { timestampMs: number; voltage: number };
// Board wheel-speed (dp2) sample — the board is the primary speed source for physics
// (BOARD = telemetry / PHONE = GPS only). Uploaded to the backend as boardSpeedSamples
// and consumed there as the primary speed source for range/efficiency math.
export type BoardSpeedSample = { timestampMs: number; speedKmh: number };

// Mirrors the backend's TripCreate (backend/app/models.py).
// Health Connect fields (heartRate*/steps/weightKg) are nullable: populated from
// the Health Connect integration (lib/healthConnect.ts) when available and permitted,
// null when the user hasn't connected Health Connect or permission is missing.
export type TripCreate = {
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

  route: RoutePoint[];
  stops: Stop[];
  modeSamples: ModeSample[];
  voltageSamples: VoltageSample[];
  // Board wheel-speed (dp2) time series — the board is the primary speed source for
  // physics (BOARD = telemetry / PHONE = GPS only). Capped at 20,000 by the backend.
  boardSpeedSamples: BoardSpeedSample[];

  // Idempotency key, deterministic from the ride's own start time — the live JS save,
  // checkpoint recovery, and native-journal sync paths can each independently finalize
  // the same real ride, and each derives this same value with no coordination between
  // them so the backend recognizes a repeat submission instead of creating a duplicate
  // trip. See app/models/trip.py's clientTripId for the backend half.
  clientTripId: string | null;
};
