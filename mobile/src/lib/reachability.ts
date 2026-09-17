// The destination-planner verdict domain — turns one mode's raw reachability
// numbers into the plain-language answer the issue asks for ("yes, doable" / "cutting it
// close" / "not enough charge") instead of a bare percentage. Pure + unit-tested.

import type { DestinationModeResult } from '@/lib/api/rangeEstimate';

export type ReachabilityVerdict = 'doable' | 'cutting-close' | 'not-enough' | 'unknown';

// Round-trip arrival pct below this is "cutting it close": you'll make it there, but
// the way back lands you at/near empty. Tuned to the backend's coarse batteryPct
// granularity (whole-percent Tuya readings) — a figure this small is a real risk.
export const ROUND_TRIP_MARGIN_PCT = 15;

/** Map a single mode's destination result to a verdict:
 * - unknown: no battery reading (board not connected / no SOC) — can't judge.
 * - not-enough: can't even reach the destination one-way.
 * - cutting-close: one-way is doable but the round trip is tight (arrives below the
 *   margin, or there's nothing left to get back) — only weighed when `roundTrip` is
 *   true (default); a one-way-only plan only cares whether you get there at all.
 * - doable: the trip (one-way, or one-way + round trip when roundTrip is true) lands
 *   comfortably above the margin. */
export function reachabilityVerdict(mode: DestinationModeResult, roundTrip: boolean = true): ReachabilityVerdict {
  const arrival = mode.estimatedArrivalBatteryPct;
  const roundTripArrival = mode.estimatedRoundTripArrivalBatteryPct;
  if (mode.reachable == null || arrival == null) return 'unknown';
  if (mode.reachable === false || arrival < 0) return 'not-enough';
  if (!roundTrip) return 'doable';
  if (roundTripArrival == null || roundTripArrival < ROUND_TRIP_MARGIN_PCT) return 'cutting-close';
  return 'doable';
}

export const VERDICT_META: Record<ReachabilityVerdict, { label: string; color: string; description: string }> = {
  doable: { label: 'Doable', color: '#22a55a', description: 'You can get there and back with margin to spare.' },
  'cutting-close': { label: 'Cutting it close', color: '#f5793a', description: "You'll make it there, but the way back is tight." },
  'not-enough': { label: 'Not enough charge', color: '#e5484d', description: "You won't make it there on the current charge." },
  unknown: { label: 'Unknown', color: '#8B93A1', description: 'Connect over Bluetooth to get a battery reading.' },
};
