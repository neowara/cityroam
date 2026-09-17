import type { BoardSpeedSample } from '@/features/rides/tripTypes';

// BOARD = telemetry / PHONE = GPS only. Distance is board-sourced:
// the primary source is the board odometer (dp12, mileageTotalKm) delta captured at
// trip start/end; boardSpeedSamples-integration is only the fallback when the
// odometer delta is unavailable or implausible. GPS distance integration is never
// the source of a trip's distanceKm.

/** Integrates a board wheel-speed (dp2) time series into a distance in km, using the
 * trapezoid rule over each adjacent pair of samples (distance += avgSpeed * dt). A
 * single sample (or empty) yields 0 — there's no time span to integrate over. */
export function integrateBoardSpeedSamples(samples: BoardSpeedSample[]): number {
  let distanceKm = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const dtSec = (cur.timestampMs - prev.timestampMs) / 1000;
    if (!Number.isFinite(dtSec) || dtSec <= 0) continue;
    const avgSpeedKmh = (prev.speedKmh + cur.speedKmh) / 2;
    distanceKm += (avgSpeedKmh * dtSec) / 3600;
  }
  return distanceKm;
}

/** Computes the authoritative trip distance (km) from board sources.
 *
 * Primary: the board odometer delta (end − start) when both readings exist and the
 * delta is plausible (non-negative and finite). Fallback: boardSpeedSamples
 * integration when the odometer delta is unavailable or implausible (e.g. the board
 * was off at start/end, or the odometer reset mid-ride). */
export function computeTripDistanceKm(opts: {
  odometerStartKm: number | null;
  odometerEndKm: number | null;
  boardSpeedSamples: BoardSpeedSample[];
}): number {
  const { odometerStartKm, odometerEndKm, boardSpeedSamples } = opts;
  if (odometerStartKm != null && odometerEndKm != null) {
    const delta = odometerEndKm - odometerStartKm;
    if (Number.isFinite(delta) && delta >= 0) {
      return delta;
    }
  }
  return integrateBoardSpeedSamples(boardSpeedSamples);
}
