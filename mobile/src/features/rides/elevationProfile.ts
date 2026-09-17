// Elevation-profile helpers for the trip planner — pure functions split out
// of app/(tabs)/planner.tsx so the round-trip climb math (the trickiest bit: it's NOT
// just double the one-way climb) gets real unit coverage.

import { CHART_AXIS_TICK_COUNT, formatAxisDistance } from '@/lib/chartAxis';
import { haversineM } from '@/features/rides/routeGeometry';
import type { RoutePointElevation } from '@/lib/api/rangeEstimate';

/** Appends the same route mirrored/reversed (minus the duplicate turnaround point) so
 * a round-trip elevation profile reads as "there, then back the same way" -- the
 * physical path back is identical, so the same elevation samples apply, just in
 * reverse order. */
export function mirrorRouteForRoundTrip(route: RoutePointElevation[]): RoutePointElevation[] {
  if (route.length < 2) return route;
  return [...route, ...[...route].slice(0, -1).reverse()];
}

/** Sum of positive elevation gains along the route — the mode-independent climb figure.
 * Passing a round-trip-mirrored route (mirrorRouteForRoundTrip) in gives the *actual*
 * round-trip gain (every one-way descent becomes a climb on the way back, and vice
 * versa), not just double the one-way climb — those are only equal when the route
 * starts and ends at the same elevation. */
export function totalClimbM(route: RoutePointElevation[]): number {
  let climb = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1].elevationM;
    const b = route[i].elevationM;
    if (a == null || b == null) continue;
    if (b > a) climb += b - a;
  }
  return climb;
}

type ElevationPoint = { lat: number; lon: number; elevationM: number };

function hasElevation(p: RoutePointElevation): p is ElevationPoint {
  return p.elevationM != null;
}

/** Evenly-spaced tick indices into an n-length series, always including the first and
 * last -- same shape as the backend's own route-decimation helper
 * (destination_range.py's _sample_indices), just for chart labels instead of payload size. */
export function pickTickIndices(n: number, count: number): Set<number> {
  if (n <= count) return new Set(Array.from({ length: n }, (_, i) => i));
  const step = (n - 1) / (count - 1);
  return new Set(Array.from({ length: count }, (_, i) => Math.round(i * step)));
}

// Hard cap on how many points the chart itself ever renders. The chart is sized to the
// card's width, so every extra point buys less than a pixel of spacing: a 200-point
// one-way route (or ~400 after round-trip mirroring) squeezes into the same few hundred
// pixels as 30 would, just noisier and far more expensive to draw. 30 points is still
// visually smooth for a line this size.
export const MAX_CHART_POINTS = 30;

/** x-axis = cumulative distance along the route (km), y = elevation (m). null elevations
 * (backend's Open-Meteo lookup failed) are dropped — the chart reads as a flat profile.
 * `route` may already be the round-trip-mirrored sequence (mirrorRouteForRoundTrip) —
 * this function itself is direction-agnostic. Decimates to MAX_CHART_POINTS *before*
 * computing distances/labels, not after, so the labeled tick indices always land on
 * points that actually survive into the rendered chart. */
export function buildElevationData(route: RoutePointElevation[]): { value: number; label: string }[] | null {
  const withElevation = route.filter(hasElevation);
  if (withElevation.length < 2) return null;
  const displayIndices = Array.from(pickTickIndices(withElevation.length, MAX_CHART_POINTS)).sort((a, b) => a - b);
  const pts = displayIndices.map((i) => withElevation[i]);
  const kms = [0];
  for (let i = 1; i < pts.length; i++) kms.push(kms[i - 1] + haversineM(pts[i - 1], pts[i]) / 1000);
  const tickIndices = pickTickIndices(pts.length, CHART_AXIS_TICK_COUNT);
  const totalKm = kms[kms.length - 1];
  return pts.map((p, i) => ({
    value: p.elevationM,
    label: tickIndices.has(i) ? formatAxisDistance(kms[i], totalKm) : '',
  }));
}
