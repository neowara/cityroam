import { integratedDistanceKm } from '@/lib/geo';

describe('integratedDistanceKm', () => {
  it('integrates speed over elapsed time', () => {
    // 18 km/h for 10s = 0.05 km
    expect(integratedDistanceKm(10, 18)).toBeCloseTo(0.05, 5);
  });

  it('returns 0 for a non-positive elapsed time', () => {
    expect(integratedDistanceKm(0, 20)).toBe(0);
    expect(integratedDistanceKm(-3, 20)).toBe(0);
  });

  it('returns 0 below the stationary deadband, even with a real elapsed time', () => {
    // Below TripStateMachine's own ~3 km/h "stopped" threshold — GPS speed jitter
    // while genuinely stationary shouldn't accumulate phantom distance.
    expect(integratedDistanceKm(10, 2.9)).toBe(0);
  });

  it('clamps a sensor-glitch speed to the plausible ceiling', () => {
    // 500 km/h is impossible for this board — clamps to 90 km/h for 1s.
    const clamped = integratedDistanceKm(1, 500);
    expect(clamped).toBeCloseTo(90 / 3600, 5);
  });

  it('clamps a long gap instead of integrating the full elapsed time at the current speed', () => {
    // A 5-minute gap (e.g. GPS loss) at 30 km/h should not book 2.5 km — only the
    // capped MAX_DT_S (10s) worth.
    const fiveMinutes = 5 * 60;
    expect(integratedDistanceKm(fiveMinutes, 30)).toBeCloseTo(30 * (10 / 3600), 5);
  });
});
