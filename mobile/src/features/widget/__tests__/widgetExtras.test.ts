// Verifies the id-scoped caching in widgetExtras.ts: fetchAndCacheTripExtras/getTripExtras is
// what stops a stale ride's odometer/weather/mode-cost data from being misread as belonging to
// whichever ride the widget is currently showing.

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { TripByMode } from '@/lib/api/trips';
import type { TripDetail } from '@/lib/types';

const mockGetTrip = jest.fn<Promise<TripDetail>, [number]>();
const mockGetTripByMode = jest.fn<Promise<TripByMode>, [number]>();

jest.mock('@/lib/api', () => ({
  api: {
    getTrip: (id: number) => mockGetTrip(id),
    getTripByMode: (id: number) => mockGetTripByMode(id),
  },
}));

import { fetchAndCacheTripExtras, getTripExtras } from '@/features/widget/widgetExtras';

function tripDetail(overrides: Partial<TripDetail> = {}): TripDetail {
  return {
    id: 1,
    startTime: '2026-08-01T10:00:00.000Z',
    endTime: '2026-08-01T10:30:00.000Z',
    distanceKm: 12.4,
    avgSpeedKmh: 24.8,
    maxSpeedKmh: 41,
    durationSec: 1800,
    wasManual: false,
    batteryStartPct: 100,
    batteryEndPct: 82,
    batteryUsedPct: 18,
    odometerStartKm: null,
    odometerEndKm: 120.5,
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
    weatherCodes: [3],
    feelsLikeC: 18.2,
    windSpeedMs: 4.1,
    route: [],
    stops: [],
    modeSamples: [],
    voltageSamples: [],
    snappedRoute: null,
    ...overrides,
  };
}

function tripByMode(overrides: Partial<TripByMode> = {}): TripByMode {
  return {
    actualMode: 'ride',
    actualBatteryUsedPct: 18,
    modes: {
      eco: { estimatedBatteryUsedPct: 12, estimatedEnergyWh: null, avgSpeedKmh: null, sampleTripCount: 1 },
      ride: { estimatedBatteryUsedPct: 18, estimatedEnergyWh: null, avgSpeedKmh: null, sampleTripCount: 1 },
      speed: { estimatedBatteryUsedPct: 24, estimatedEnergyWh: null, avgSpeedKmh: null, sampleTripCount: 1 },
      turbo: { estimatedBatteryUsedPct: 30, estimatedEnergyWh: null, avgSpeedKmh: null, sampleTripCount: 1 },
    },
    ...overrides,
  };
}

describe('fetchAndCacheTripExtras / getTripExtras', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockGetTrip.mockReset();
    mockGetTripByMode.mockReset();
  });

  it('returns the empty shape for a trip id that has never been fetched', () => {
    expect(getTripExtras(123)).toEqual({ cost: {}, odometerKm: null, weatherTempC: null, weatherWindMs: null, weatherCode: null });
  });

  it('returns the empty shape for null', () => {
    expect(getTripExtras(null)).toEqual({ cost: {}, odometerKm: null, weatherTempC: null, weatherWindMs: null, weatherCode: null });
  });

  it('fetches and caches odometer/weather/mode-cost keyed to the trip id', async () => {
    mockGetTrip.mockResolvedValue(tripDetail({ id: 1 }));
    mockGetTripByMode.mockResolvedValue(tripByMode());

    await fetchAndCacheTripExtras(1);

    expect(getTripExtras(1)).toEqual({
      cost: { eco: 12, ride: 18, speed: 24, turbo: 30 },
      odometerKm: 120.5,
      weatherTempC: 18.2,
      weatherWindMs: 4.1,
      weatherCode: 3,
    });
  });

  it("does not leak a newer ride's data onto an older ride's id", async () => {
    mockGetTrip.mockResolvedValue(tripDetail({ id: 2, odometerEndKm: 200 }));
    mockGetTripByMode.mockResolvedValue(tripByMode());

    await fetchAndCacheTripExtras(2);

    // A stale caller still asking about ride 1 must not see ride 2's numbers.
    expect(getTripExtras(1)).toEqual({ cost: {}, odometerKm: null, weatherTempC: null, weatherWindMs: null, weatherCode: null });
    expect(getTripExtras(2).odometerKm).toBe(200);
  });

  it('is a no-op (does not re-fetch) when already cached for that trip id', async () => {
    mockGetTrip.mockResolvedValue(tripDetail({ id: 1 }));
    mockGetTripByMode.mockResolvedValue(tripByMode());

    await fetchAndCacheTripExtras(1);
    await fetchAndCacheTripExtras(1);

    expect(mockGetTrip).toHaveBeenCalledTimes(1);
    expect(mockGetTripByMode).toHaveBeenCalledTimes(1);
  });

  it('leaves the cache empty (not crashing) when the fetch fails', async () => {
    mockGetTrip.mockRejectedValue(new Error('network error'));
    mockGetTripByMode.mockResolvedValue(tripByMode());

    await expect(fetchAndCacheTripExtras(5)).resolves.toBeUndefined();
    expect(getTripExtras(5)).toEqual({ cost: {}, odometerKm: null, weatherTempC: null, weatherWindMs: null, weatherCode: null });
  });

  it('falls back to null weatherCode when the trip has no sampled weather codes', async () => {
    mockGetTrip.mockResolvedValue(tripDetail({ id: 9, weatherCodes: null }));
    mockGetTripByMode.mockResolvedValue(tripByMode());

    await fetchAndCacheTripExtras(9);

    expect(getTripExtras(9).weatherCode).toBeNull();
  });
});
