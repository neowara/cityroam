import type { TripSummary } from '@/lib/api';

/** Trusts the live BLE mileage_total reading (dp12) directly whenever there is one.
 * Falls back to trip history only when disconnected: the highest odometerEndKm ever
 * seen anchors the estimate, plus any trip distance recorded after it. */
export function estimateLifetimeKm(trips: TripSummary[] | undefined, liveMileageTotalKm: number | null | undefined): number | null {
  if (liveMileageTotalKm != null) return liveMileageTotalKm;

  const withOdometer = (trips ?? []).filter((t): t is TripSummary & { odometerEndKm: number } => t.odometerEndKm != null);
  if (withOdometer.length === 0) return null;

  const anchor = withOdometer.reduce((best, t) => (t.odometerEndKm > best.odometerEndKm ? t : best));
  const anchorEndMs = new Date(anchor.endTime).getTime();
  const sinceAnchor = (trips ?? []).filter((t) => new Date(t.endTime).getTime() > anchorEndMs);
  return anchor.odometerEndKm + sinceAnchor.reduce((sum, t) => sum + t.distanceKm, 0);
}
