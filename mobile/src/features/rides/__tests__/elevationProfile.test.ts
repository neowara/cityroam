import { buildElevationData, mirrorRouteForRoundTrip, pickTickIndices, totalClimbM } from '@/features/rides/elevationProfile';
import type { RoutePointElevation } from '@/lib/api/rangeEstimate';

function point(lat: number, elevationM: number | null): RoutePointElevation {
  return { lat, lon: -73.0, elevationM };
}

describe('mirrorRouteForRoundTrip', () => {
  it('appends the route reversed, without duplicating the turnaround point', () => {
    const route = [point(40.0, 10), point(40.01, 20), point(40.02, 15)];
    const mirrored = mirrorRouteForRoundTrip(route);
    expect(mirrored.map((p) => p.elevationM)).toEqual([10, 20, 15, 20, 10]);
    expect(mirrored).toHaveLength(2 * route.length - 1);
  });

  it('leaves a too-short route untouched', () => {
    expect(mirrorRouteForRoundTrip([point(40.0, 10)])).toEqual([point(40.0, 10)]);
    expect(mirrorRouteForRoundTrip([])).toEqual([]);
  });
});

describe('totalClimbM', () => {
  it('sums only positive elevation deltas', () => {
    // 10 -> 20 (climb 10) -> 15 (descent, ignored) -> 25 (climb 10)
    const route = [point(40.0, 10), point(40.01, 20), point(40.02, 15), point(40.03, 25)];
    expect(totalClimbM(route)).toBe(20);
  });

  it('skips a gap where elevation lookup failed', () => {
    const route = [point(40.0, 10), point(40.01, null), point(40.02, 25)];
    expect(totalClimbM(route)).toBe(0);
  });

  it('round-trip climb is NOT simply double the one-way climb on an asymmetric route', () => {
    // One-way: 0 -> 10 (climb 10) -> 4 (a net descent overall, one-way climb = 10).
    // Naively doubling would give 20, but the real round-trip profile (there, then
    // back the same way) is 0,10,4,10,0 -- climbs are 10 (0->10) then 6 (4->10) = 16.
    const oneWay = [point(40.0, 0), point(40.01, 10), point(40.02, 4)];
    const roundTrip = mirrorRouteForRoundTrip(oneWay);
    expect(totalClimbM(oneWay)).toBe(10);
    expect(totalClimbM(roundTrip)).toBe(16);
    expect(totalClimbM(roundTrip)).not.toBe(totalClimbM(oneWay) * 2);
  });

  it('round-trip climb DOES equal double the one-way climb when start and end elevation match', () => {
    const symmetric = [point(40.0, 0), point(40.01, 10), point(40.02, 0)];
    const roundTrip = mirrorRouteForRoundTrip(symmetric);
    expect(totalClimbM(roundTrip)).toBe(totalClimbM(symmetric) * 2);
  });
});

describe('pickTickIndices', () => {
  it('returns every index when n is under the cap', () => {
    expect(pickTickIndices(4, 6)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('always includes the first and last index', () => {
    const indices = pickTickIndices(100, 6);
    expect(indices.has(0)).toBe(true);
    expect(indices.has(99)).toBe(true);
    expect(indices.size).toBe(6);
  });
});

describe('buildElevationData', () => {
  it('returns null with fewer than 2 elevation points', () => {
    expect(buildElevationData([point(40.0, 10)])).toBeNull();
    expect(buildElevationData([point(40.0, null), point(40.01, null)])).toBeNull();
  });

  it('drops points with a failed elevation lookup', () => {
    const route = [point(40.0, 10), point(40.01, null), point(40.02, 20)];
    const data = buildElevationData(route)!;
    expect(data.map((d) => d.value)).toEqual([10, 20]);
  });

  it('labels only the tick indices, leaving the rest blank', () => {
    const route = Array.from({ length: 20 }, (_, i) => point(40.0 + i * 0.001, i));
    const data = buildElevationData(route)!;
    const labeled = data.filter((d) => d.label !== '');
    expect(labeled.length).toBeGreaterThan(0);
    expect(data[0].label).not.toBe('');
    expect(data[data.length - 1].label).not.toBe('');
  });
});
