import { estimateLifetimeKm } from '@/features/rides/odometer';
import type { TripSummary } from '@/lib/api';

// Guards against the live BLE mileage_total reading not being wired, which silently fell through to the trip-history estimate instead.

function makeTrip(overrides: Partial<TripSummary> = {}): TripSummary {
  return {
    id: 1,
    startTime: '2026-08-20T10:00:00Z',
    endTime: '2026-08-20T10:30:00Z',
    distanceKm: 5,
    avgSpeedKmh: 15,
    maxSpeedKmh: 25,
    durationSec: 1800,
    wasManual: false,
    batteryStartPct: null,
    batteryEndPct: null,
    batteryUsedPct: null,
    odometerStartKm: null,
    odometerEndKm: null,
    heartRateAvgBpm: null,
    heartRateMaxBpm: null,
    heartRateStartBpm: null,
    heartRateEndBpm: null,
    restingHeartRateBpm: null,
    heartRateVariabilityMs: null,
    steps: null,
    weightKg: null,
    dominantMode: null,
    modeMixed: false,
    weatherCodes: null,
    feelsLikeC: null,
    windSpeedMs: null,
    ...overrides,
  };
}

describe('estimateLifetimeKm', () => {
  it('trusts a live BLE reading directly, even when it disagrees with trip history', () => {
    const trips = [makeTrip({ endTime: '2026-08-20T10:30:00Z', odometerEndKm: 500, distanceKm: 5 })];
    // Guards against taking max(estimate, live), which could override a live reading with a stale trip-history number.
    expect(estimateLifetimeKm(trips, 571.9)).toBe(571.9);
  });

  it('falls back to the trip-history anchor when there is no live reading (board not connected)', () => {
    const trips = [
      makeTrip({ endTime: '2026-08-20T10:30:00Z', odometerEndKm: 500, distanceKm: 5 }),
      makeTrip({ endTime: '2026-08-20T11:00:00Z', odometerEndKm: null, distanceKm: 3 }),
    ];
    expect(estimateLifetimeKm(trips, null)).toBe(503);
  });

  it('returns null when there is neither a live reading nor any trip odometer history', () => {
    expect(estimateLifetimeKm([], null)).toBeNull();
    expect(estimateLifetimeKm(undefined, undefined)).toBeNull();
  });
});
