import { MAX_PLAUSIBLE_KMH } from '@/features/rides/routeGeometry';

/** expo-location reports speed in m/s and uses -1 (iOS) for "unavailable" — normalize both to km/h, 0 when unavailable. */
export function speedMsToKmh(speedMs: number | null | undefined): number {
  if (speedMs == null || speedMs < 0) return 0;
  return speedMs * 3.6;
}

// distance += speed × dt (Doppler-derived speed), not haversine between raw fixes —
// summing position deltas lets GPS multipath/drift directly inflate distance.
// DEADBAND matches TripStateMachine's STOP_SPEED_KMH (stationary jitter shouldn't
// accumulate phantom distance). MAX_KMH is MAX_PLAUSIBLE_KMH from routeGeometry (the
// single source for the plausible-speed ceiling — sensor-glitch cap, not this board's
// real ~30-35 km/h top speed). MAX_DT_S caps how much a gap much bigger than the
// normal ~3s sample interval can integrate at one speed.
export const DISTANCE_INTEGRATION_DEADBAND_KMH = 3;
export const DISTANCE_INTEGRATION_MAX_KMH = MAX_PLAUSIBLE_KMH;
export const DISTANCE_INTEGRATION_MAX_DT_S = 10;

/**
 * Distance covered (km) between two consecutive samples `dtS` seconds apart at
 * `speedKmh`, clamped against sensor glitches (see constants above). `dtS` and
 * `speedKmh` are the raw, unclamped values — clamping happens inside.
 */
export function integratedDistanceKm(dtS: number, speedKmh: number): number {
  if (dtS <= 0) return 0;
  const clampedDtS = Math.min(dtS, DISTANCE_INTEGRATION_MAX_DT_S);
  const clampedKmh = Math.min(speedKmh, DISTANCE_INTEGRATION_MAX_KMH);
  if (clampedKmh < DISTANCE_INTEGRATION_DEADBAND_KMH) return 0;
  return clampedKmh * (clampedDtS / 3600);
}
