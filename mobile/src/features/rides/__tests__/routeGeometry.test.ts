import { haversineM, MAX_PLAUSIBLE_KMH, filterRouteSpikes, splitRouteGaps } from '@/features/rides/routeGeometry';

type TestPoint = {
  lat: number;
  lon: number;
  timestampMs: number;
  speedKmh?: number;
  accuracyM?: number | null;
};

const pt = (lat: number, lon: number, timestampMs: number, extra: Partial<TestPoint> = {}): TestPoint => ({
  lat,
  lon,
  timestampMs,
  ...extra,
});

describe('haversineM', () => {
  it('returns 0 for identical points', () => {
    expect(haversineM({ lat: 59.32, lon: 18.07 }, { lat: 59.32, lon: 18.07 })).toBe(0);
  });

  it('is symmetric', () => {
    const a = { lat: 59.32, lon: 18.07 };
    const b = { lat: 59.33, lon: 18.08 };
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 5);
  });

  it('computes a plausible distance for 0.01° of latitude (~1.11 km)', () => {
    const d = haversineM({ lat: 59.32, lon: 18.07 }, { lat: 59.33, lon: 18.07 });
    expect(d).toBeCloseTo(1111.95, 0);
  });
});

describe('filterRouteSpikes', () => {
  it('returns empty and single-point input unchanged', () => {
    expect(filterRouteSpikes([])).toEqual([]);
    const one = [pt(59.32, 18.07, 0)];
    expect(filterRouteSpikes(one)).toEqual(one);
  });

  it('drops a point implying an impossible speed', () => {
    // Third point jumps ~1.1 km in 1s (~4000 km/h) — way past MAX_PLAUSIBLE_KMH.
    const points = [pt(59.32, 18.07, 0), pt(59.32, 18.07, 1000), pt(59.33, 18.07, 2000)];
    const filtered = filterRouteSpikes(points);
    expect(filtered).toHaveLength(2);
    expect(filtered[1].timestampMs).toBe(1000);
  });

  it('keeps plausible points in sequence', () => {
    // ~11 m/s between two 1s-apart points ≈ 40 km/h — plausible.
    const points = [pt(59.32, 18.07, 0), pt(59.3201, 18.07, 1000)];
    expect(filterRouteSpikes(points)).toEqual(points);
  });

  it('drops a point failing the drift heuristic while still under the speed cap', () => {
    // Implied ~80 km/h over 10s (under MAX_PLAUSIBLE_KMH) but 5x the reported 15 km/h
    // — stationary GPS drift, dropped by DRIFT_MULTIPLIER, not the speed cap.
    const points = [pt(59.32, 18.07, 0, { speedKmh: 15 }), pt(59.322, 18.07, 10_000, { speedKmh: 15 })];
    const filtered = filterRouteSpikes(points);
    expect(filtered).toHaveLength(1);
  });

  it('drops degraded fixes by accuracy when reported', () => {
    const points = [
      pt(59.32, 18.07, 0, { accuracyM: 5 }),
      pt(59.3201, 18.07, 1000, { accuracyM: 200 }),
      pt(59.3202, 18.07, 2000, { accuracyM: 5 }),
    ];
    const filtered = filterRouteSpikes(points);
    expect(filtered).toHaveLength(2);
    expect(filtered[1].timestampMs).toBe(2000);
  });
});

describe('splitRouteGaps', () => {
  it('returns [] for no points', () => {
    expect(splitRouteGaps([])).toEqual([]);
  });

  it('bridges a gap that is long but not far — a stop, not a real outage', () => {
    // Each hop is ~111 m (over MIN_SEGMENT_DISTANCE_M) so both sides would survive the
    // short-segment filter if this did split — it doesn't, because 59s < GAP_MS (60s).
    const points = [
      pt(59.32, 18.07, 0),
      pt(59.321, 18.07, 1000),
      pt(59.322, 18.07, 60_000), // 59s gap, ~111m — long-ish but close
      pt(59.323, 18.07, 61_000),
    ];
    const segments = splitRouteGaps(points);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(4);
  });

  it('bridges a gap that is far but not long — covered quickly on the same street', () => {
    const points = [
      pt(59.32, 18.07, 0),
      pt(59.321, 18.07, 1000),
      // ~1.1km in 30s (under GAP_MS) — plausible at speed, not a real outage.
      pt(59.33, 18.07, 31_000),
      pt(59.331, 18.07, 32_000),
    ];
    const segments = splitRouteGaps(points);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(4);
  });

  it('splits a gap that is both long and far — a genuine unobserved stretch', () => {
    const points = [
      pt(59.32, 18.07, 0),
      pt(59.321, 18.07, 1000),
      // ~2.2km over 90s — long enough and far enough that a straight line here
      // would plausibly cut through unrelated terrain.
      pt(59.34, 18.07, 91_000),
      pt(59.341, 18.07, 92_000),
    ];
    const segments = splitRouteGaps(points);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(2);
    expect(segments[1]).toHaveLength(2);
  });

  it("bridges all three of a real ride's gaps (45.0s/361m, 45.0s/203m, 31.0s/218m)", () => {
    // Measured from the production database against the exact rider complaint this
    // fixes: two of these rendered as empty space and one as a straight line, purely
    // because a single time-only threshold happened to land between them. None of
    // the three should ever have been treated as a real outage.
    const metersToLatDegrees = (m: number) => m / 111_000;
    let t = 0;
    let lat = 59.32;
    const points: TestPoint[] = [pt(lat, 18.07, t)];
    for (const [gapS, gapM] of [
      [45.0, 361],
      [45.0, 203],
      [31.0, 218],
    ] as const) {
      t += gapS * 1000;
      lat += metersToLatDegrees(gapM);
      points.push(pt(lat, 18.07, t));
      t += 1000;
      lat += metersToLatDegrees(50);
      points.push(pt(lat, 18.07, t));
    }
    expect(splitRouteGaps(points)).toHaveLength(1);
  });

  it('drops segments shorter than MIN_SEGMENT_DISTANCE_M', () => {
    // Sub-centimetre hops throughout -- neither gap ever clears GAP_DISTANCE_M, so
    // nothing splits at all; the one resulting segment is dropped entirely for being
    // under MIN_SEGMENT_DISTANCE_M regardless of the (long but not far) time gaps.
    const points = [pt(59.32, 18.07, 0), pt(59.3200001, 18.07, 1000), pt(59.3200002, 18.07, 61_000), pt(59.3200003, 18.07, 62_000)];
    expect(splitRouteGaps(points)).toEqual([]);
  });
});

describe('MAX_PLAUSIBLE_KMH', () => {
  it('is the shared 90 km/h ceiling', () => {
    expect(MAX_PLAUSIBLE_KMH).toBe(90);
  });
});
