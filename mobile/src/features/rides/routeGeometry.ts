// Shared route-geometry primitives: the point-plausibility filter and gap splitter used
// by route rendering (TripMap, RouteMapThumbnail, RouteThumbnail). MAX_PLAUSIBLE_KMH is
// the single source of the plausible-speed ceiling — geo.ts's distance integration clamps
// to the same value instead of re-defining it.

type TimedPoint = { lat: number; lon: number; timestampMs: number; speedKmh?: number; accuracyM?: number | null };

export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = ((b.lat - a.lat) * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Matches backend/app/services/map_matching.py's _filter_gps_spikes. Speed (not a
// distance-only heuristic) is the only threshold that stays meaningful across both stopped and fast segments.
export const MAX_PLAUSIBLE_KMH = 90;

// Catches GPS drift while stationary: position can wander >1km during a stop while the
// board's Doppler-derived speedKmh stays near 0 — a single-hop speed cap alone misses this.
const DRIFT_MULTIPLIER = 5;
const DRIFT_FLOOR_KMH = 15;

// accuracyM (Android's reported fix radius) rejects degraded fixes outright; 30m is generous against normal urban GPS. Missing accuracyM (older points) is treated as unknown, not bad.
const MAX_ACCURACY_M = 30;

/** Drops GPS points implying an impossible speed from the last KEPT point (not raw
 * neighbors), which is what catches a multi-point bad cluster rather than a single spike. */
export function filterRouteSpikes<T extends TimedPoint>(points: T[]): T[] {
  if (points.length < 2) return points;
  const out: T[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const p = points[i];
    if (p.accuracyM != null && p.accuracyM > MAX_ACCURACY_M) continue;
    const dtS = (p.timestampMs - prev.timestampMs) / 1000;
    if (dtS <= 0) continue;
    const impliedKmh = (haversineM(prev, p) / dtS) * 3.6;
    if (impliedKmh > MAX_PLAUSIBLE_KMH) continue;
    if (p.speedKmh != null && impliedKmh > Math.max(p.speedKmh * DRIFT_MULTIPLIER, DRIFT_FLOOR_KMH)) continue;
    out.push(p);
  }
  return out;
}

// A time-only threshold used to split on ANY gap over this long, including a real
// gap at a red light (0m moved) or a short one on the same street (a couple hundred
// metres) -- both should just connect the dots, not render as a break. Measured
// against three real gaps from the same ride: 45.0s/361m and 45.0s/203m rendered as
// empty space, while a 31.0s/218m gap (under the old 45s threshold) rendered as a
// straight line across the same missing stretch -- the single time-only threshold
// happened to land between them. A break is only real when the path is BOTH long
// unobserved AND far enough that a straight line would plausibly cut through
// unrelated terrain -- checked against those same three gaps below, all bridge.
const GAP_MS = 60_000;
const GAP_DISTANCE_M = 250;

// Tiny leftover segments (2-4 points isolated by gaps) render as stray dots easily mistaken for stop markers — drop segments under this real distance.
const MIN_SEGMENT_DISTANCE_M = 50;

function segmentDistanceM<T extends { lat: number; lon: number }>(segment: T[]): number {
  let total = 0;
  for (let i = 1; i < segment.length; i++) total += haversineM(segment[i - 1], segment[i]);
  return total;
}

/** Splits a route into segments only where a gap is both long (GAP_MS) AND
 * geographically far (GAP_DISTANCE_M) -- a break this real means the path genuinely
 * wasn't observed and a straight line between the two sides would likely cut through
 * unrelated terrain. A gap that's merely long (stopped at a light) or merely far (a
 * few hundred metres on the same street, covered in under a minute) bridges instead,
 * so the renderer draws through it rather than leaving a visible hole. Drops
 * single-point segments (MapLibre throws on a 1-point LineString) and any under
 * MIN_SEGMENT_DISTANCE_M. */
export function splitRouteGaps<T extends TimedPoint>(points: T[]): T[][] {
  if (points.length === 0) return [];
  const segments: T[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const gapMs = points[i].timestampMs - points[i - 1].timestampMs;
    if (gapMs > GAP_MS && haversineM(points[i - 1], points[i]) > GAP_DISTANCE_M) segments.push([]);
    segments[segments.length - 1].push(points[i]);
  }
  return segments.filter((seg) => seg.length >= 2 && segmentDistanceM(seg) >= MIN_SEGMENT_DISTANCE_M);
}

export type DirectionArrowPoint = {
  lon: number;
  lat: number;
  // 0-1 distance-along-route, for coloring an arrow to match wherever the line-gradient
  // is at that point — line-progress (what the line layer's own gradient uses) can only
  // be used in the line-gradient/line-z-offset properties, not in a symbol layer's paint,
  // so matching an arrow's color to the line under it needs each arrow's progress stored
  // as an ordinary feature property instead.
  progress: number;
  // Degrees, ready to pass straight to text-rotate: the '▶' glyph points east at
  // rotation 0 and text-rotate turns it clockwise, so this is (compass bearing - 90).
  rotate: number;
};

// Standard Web Mercator ground resolution formula (meters per pixel at a given
// latitude/zoom) — used to convert the line layer's pixel-based line-offset and the
// old symbol-spacing's pixel spacing into real-world meters, since these arrow points
// are placed in geographic coordinates rather than screen space. Approximate (assumes
// a roughly constant latitude across the route), which is accurate enough at the scale
// of a single ride.
export function metersPerPixelAtLat(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

function destinationPoint(a: { lat: number; lon: number }, bearingDeg: number, distanceM: number): { lat: number; lon: number } {
  const R = 6371000;
  const delta = distanceM / R;
  const theta = (bearingDeg * Math.PI) / 180;
  const phi1 = (a.lat * Math.PI) / 180;
  const lambda1 = (a.lon * Math.PI) / 180;
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 =
    lambda1 + Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
  return { lat: (phi2 * 180) / Math.PI, lon: (lambda2 * 180) / Math.PI };
}

// Intersection of infinite lines p1-p2 and p3-p4 (lon/lat treated as plane Cartesian —
// fine at the scale of a single street). Returns null for parallel/near-parallel lines
// (straight stretches of road, the common case) rather than dividing by ~0.
function lineIntersection(
  p1: { lon: number; lat: number },
  p2: { lon: number; lat: number },
  p3: { lon: number; lat: number },
  p4: { lon: number; lat: number },
): { lon: number; lat: number } | null {
  const denom = (p1.lon - p2.lon) * (p3.lat - p4.lat) - (p1.lat - p2.lat) * (p3.lon - p4.lon);
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((p1.lon - p3.lon) * (p3.lat - p4.lat) - (p1.lat - p3.lat) * (p3.lon - p4.lon)) / denom;
  return { lon: p1.lon + t * (p2.lon - p1.lon), lat: p1.lat + t * (p2.lat - p1.lat) };
}

/** Shifts a polyline sideways by `offsetM` meters, perpendicular to the route's own
 * local direction of travel (positive = right, matching the `line-offset` paint
 * property's convention) — used instead of the native `line-offset` paint property so
 * the rendered line and the direction-arrow points (which need their own real-world
 * positions anyway, see buildDirectionArrowPoints) are guaranteed to coincide exactly:
 * both are derived from this exact same math for the same offsetM, rather than one
 * being the native GPU-side pixel shader offset and the other a separately
 * re-implemented approximation of it, which cannot be guaranteed to agree to the pixel
 * (mismatched zoom timing, interpolation rounding, etc). Implemented by hand rather
 * than via a polyline-offset library: the well-known JS one for this (Turf's
 * line-offset) has a real, unresolved bug that silently collapses some inputs down to
 * little more than their first/last coordinate, and there's no better-maintained
 * alternative in this ecosystem for real-world (meter-based) offsetting.
 * Translates each segment's two endpoints perpendicular to that segment's own bearing,
 * then rejoins consecutive translated segments at their actual intersection point,
 * rather than a per-vertex "shift by the average of its two segment bearings" (this
 * function's first version): averaging bearings doesn't correctly rejoin the offset
 * segments and self-intersects into visible loops/spikes wherever the route curves or
 * has ordinary GPS jitter between closely-spaced points, whereas using the segments'
 * actual intersection avoids that in the normal case. A sharp enough turn (a genuine
 * hairpin tighter than the offset distance) can still fold the offset segments the
 * wrong way — falls back to a plain perpendicular shift for that one vertex when the
 * intersection lands implausibly far from the source points, rather than let a single
 * bad join spike the whole line. */
export function offsetPolylineByMeters(coordinates: [number, number][], offsetM: number): [number, number][] {
  if (coordinates.length < 2 || offsetM === 0) return coordinates;
  const points = coordinates.map(([lon, lat]) => ({ lon, lat }));

  const shiftedSegments = points.slice(0, -1).map((p, i) => {
    const bearing = (bearingToCompass(p, points[i + 1]) + 90) % 360;
    return [destinationPoint(p, bearing, offsetM), destinationPoint(points[i + 1], bearing, offsetM)] as const;
  });

  const result: { lon: number; lat: number }[] = [shiftedSegments[0][0]];
  for (let i = 0; i < shiftedSegments.length; i++) {
    const [, end] = shiftedSegments[i];
    const next = shiftedSegments[i + 1];
    if (!next) {
      result.push(end);
      continue;
    }
    // A join further than this from its own un-joined segment endpoints means the
    // intersection overshot (a standard "miter join" characteristic on a sharp corner —
    // the tighter the turn, the further out the miter point extends, same reason a
    // thick line's mitered corner can spike on a sharp angle in any vector renderer).
    // Bounding it by the two adjacent ORIGINAL segment lengths, not just a multiple of
    // offsetM, matters because an offset-relative-only bound can still exceed a short
    // segment's own length on a sharp real turn between closely-spaced points, letting
    // an ugly spike through despite being "within bounds" by the offset's own scale.
    const segLenBefore = haversineM(points[i], points[i + 1]);
    const segLenAfter = haversineM(points[i + 1], points[i + 2]);
    const maxPlausibleJoinM = Math.min(offsetM * 4, Math.min(segLenBefore, segLenAfter) / 2);
    const joined = lineIntersection(shiftedSegments[i][0], end, next[0], next[1]);
    result.push(joined && haversineM(joined, end) <= maxPlausibleJoinM ? joined : end);
  }
  return result.map((p) => [p.lon, p.lat] as [number, number]);
}

export function polylineLengthM(coordinates: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    total += haversineM({ lon: coordinates[i - 1][0], lat: coordinates[i - 1][1] }, { lon: coordinates[i][0], lat: coordinates[i][1] });
  }
  return total;
}

/** Places points along a route at a fixed real-world spacing, each carrying its own
 * progress/rotate — see DirectionArrowPoint for why generating these ourselves is
 * necessary instead of letting the renderer auto-distribute symbols along the line.
 * `spacingM` should already be converted from the screen-pixel spacing the caller
 * actually wants (via metersPerPixelAtLat) — real-world-meter spacing alone looks
 * wildly too dense zoomed out and too sparse zoomed in, the exact problem
 * `symbol-spacing` (screen pixels) avoided when arrows were placed by the renderer
 * instead of computed here.
 * Pass the already-offset coordinates (see offsetPolylineByMeters), not the raw route —
 * these arrows are meant to sit on top of the rendered line, and interpolating directly
 * along the same offset coordinates the line itself is drawn from is what guarantees
 * that (rather than independently re-deriving an offset that has to be trusted to
 * exactly match the line's).
 * `distanceBeforeM`/`totalRouteDistanceM` let progress be measured across the whole
 * route rather than resetting to 0 at the start of this one segment — needed because a
 * route can be split into several of these calls (one per real GPS gap), but the line
 * layer's own `line-progress` (what its line-gradient paint is keyed on) measures
 * distance across the entire MultiLineString feature, never resetting per part. Each
 * arrow's color has to be computed the same way the line's is, or an arrow past the
 * first segment ends up colored for a much earlier point in the ride than the line
 * beneath it actually represents. */
export function buildDirectionArrowPoints(
  coordinates: [number, number][],
  spacingM: number,
  distanceBeforeM: number,
  totalRouteDistanceM: number,
): DirectionArrowPoint[] {
  if (coordinates.length < 2) return [];
  const points = coordinates.map(([lon, lat]) => ({ lon, lat }));
  const segLengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = haversineM(points[i - 1], points[i]);
    segLengths.push(d);
    total += d;
  }
  if (total === 0) return [];

  const arrows: DirectionArrowPoint[] = [];
  // Starts half a spacing in rather than at 0 so an arrow doesn't land directly on the start marker.
  let nextMark = spacingM / 2;
  let segStart = 0;
  let segIndex = 0;
  while (nextMark < total && segIndex < segLengths.length) {
    const segLen = segLengths[segIndex];
    if (segStart + segLen < nextMark) {
      segStart += segLen;
      segIndex++;
      continue;
    }
    const a = points[segIndex];
    const b = points[segIndex + 1];
    const t = segLen > 0 ? (nextMark - segStart) / segLen : 0;
    const bearing = bearingToCompass(a, b);
    arrows.push({
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
      progress: totalRouteDistanceM > 0 ? (distanceBeforeM + nextMark) / totalRouteDistanceM : 0,
      rotate: (bearing - 90 + 360) % 360,
    });
    nextMark += spacingM;
  }
  return arrows;
}

// 0 = north, clockwise — standard compass bearing from a to b.
function bearingToCompass(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Bounding box for fitting a map view around arbitrary points (route, stops, or a
// single start/destination in the planner). Shared so TripMap and the planner picker
// use the same padding rules — [west, south, east, north] as fitBounds expects.
export function computeBounds(points: { lat: number; lon: number }[]): [number, number, number, number] | null {
  if (points.length === 0) return null;
  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  let minLon = points[0].lon;
  let maxLon = points[0].lon;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  // A single-point or near-zero-area bbox makes fitBounds zoom in absurdly far — pad it.
  const latPad = Math.max((maxLat - minLat) * 0.1, 0.001);
  const lonPad = Math.max((maxLon - minLon) * 0.1, 0.001);
  return [minLon - lonPad, minLat - latPad, maxLon + lonPad, maxLat + latPad];
}
