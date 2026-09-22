// Verifies the widget's last-ride cache: the mapping from a backend trip summary onto the
// widget's idle-view shape (used to backfill the cache for users who upgraded after the
// widget shipped), and that captureLastRide persists + notifies listeners.

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  backfillLastRideTripId,
  captureLastRide,
  getLastRide,
  lastRideFromTrip,
  onLastRideCaptured,
  reconcileLastRideWithBackend,
  refreshLastRideAfterDelete,
} from '@/features/widget/widgetLastRide';
import type { TripDetail, TripSummary } from '@/lib/types';

const mockListTrips = jest.fn();
const mockGetTrip = jest.fn();

jest.mock('@/features/rides/tripDevice', () => ({ resolveTripDeviceId: jest.fn().mockResolvedValue('dev-1') }));
jest.mock('@/lib/api/trips', () => {
  const actual = jest.requireActual('@/lib/api/trips');
  return {
    ...actual,
    tripsApi: {
      ...actual.tripsApi,
      listTrips: (...args: unknown[]) => mockListTrips(...args),
      getTrip: (...args: unknown[]) => mockGetTrip(...args),
    },
  };
});

const LAST_RIDE_KEY = 'turbo.widget.lastRide';

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
    route: [
      { lat: 59.33, lon: 18.06, timestampMs: 0, speedKmh: 0 },
      { lat: 59.34, lon: 18.07, timestampMs: 1000, speedKmh: 20 },
      { lat: 59.35, lon: 18.08, timestampMs: 2000, speedKmh: 30 },
    ],
    stops: [],
    modeSamples: [],
    voltageSamples: [],
    snappedRoute: null,
    ...overrides,
  };
}

describe('lastRideFromTrip', () => {
  it('maps a backend trip detail onto the widget last-ride shape', () => {
    const trip = tripDetail();
    expect(lastRideFromTrip(trip)).toEqual({
      // Backfilled from the backend, not captured at local finalize time — no local
      // queue row to match against later (see backfillLastRideTripId).
      localId: null,
      distanceKm: 12.4,
      durationSec: 1800,
      maxSpeedKmh: 41,
      avgSpeedKmh: 24.8,
      batteryUsedPct: 18,
      endEpochMs: Date.parse('2026-08-01T10:30:00.000Z'),
      stopsCount: 0,
      tripId: 1,
    });
  });

  it('carries a null batteryUsedPct through when the trip has none', () => {
    const trip = tripDetail({ batteryUsedPct: null });
    expect(lastRideFromTrip(trip).batteryUsedPct).toBeNull();
  });
});

describe('captureLastRide', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('persists the summary and notifies captured listeners', async () => {
    const listener = jest.fn();
    const unsubscribe = onLastRideCaptured(listener);

    const summary = lastRideFromTrip(tripDetail());
    await captureLastRide(summary);

    expect(getLastRide()).toEqual(summary);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await AsyncStorage.getItem(LAST_RIDE_KEY)) ?? '')).toEqual(summary);

    unsubscribe();
  });
});

describe('backfillLastRideTripId', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('fills in the trip id once a matching local ride syncs later', async () => {
    const summary = { ...lastRideFromTrip(tripDetail()), localId: 42, tripId: null };
    await captureLastRide(summary);

    const listener = jest.fn();
    const unsubscribe = onLastRideCaptured(listener);
    await backfillLastRideTripId(42, 999);
    unsubscribe();

    expect(getLastRide()?.tripId).toBe(999);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await AsyncStorage.getItem(LAST_RIDE_KEY)) ?? '{}').tripId).toBe(999);
  });

  it('is a no-op when the synced ride is not the currently-cached last ride', async () => {
    const summary = { ...lastRideFromTrip(tripDetail()), localId: 42, tripId: null };
    await captureLastRide(summary);

    await backfillLastRideTripId(7, 999);

    expect(getLastRide()?.tripId).toBeNull();
  });
});

function tripSummary(overrides: Partial<TripSummary> = {}): TripSummary {
  const {
    route: _route,
    stops: _stops,
    modeSamples: _modeSamples,
    voltageSamples: _voltageSamples,
    snappedRoute: _snappedRoute,
    ...summary
  } = tripDetail();
  return { ...summary, ...overrides };
}

describe('refreshLastRideAfterDelete', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockListTrips.mockReset();
    mockGetTrip.mockReset();
  });

  it('is a no-op when the deleted trip is not the cached last ride', async () => {
    await captureLastRide(lastRideFromTrip(tripDetail({ id: 1 })));

    await refreshLastRideAfterDelete(999);

    expect(mockListTrips).not.toHaveBeenCalled();
    expect(getLastRide()?.tripId).toBe(1);
  });

  it('adopts the new most recent backend trip when the cached ride was just deleted', async () => {
    await captureLastRide(lastRideFromTrip(tripDetail({ id: 1, endTime: '2026-08-01T10:30:00.000Z' })));

    mockListTrips.mockResolvedValue([
      tripSummary({ id: 2, endTime: '2026-07-20T09:00:00.000Z' }),
      tripSummary({ id: 3, endTime: '2026-07-28T09:00:00.000Z' }),
    ]);
    mockGetTrip.mockResolvedValue(tripDetail({ id: 3, endTime: '2026-07-28T09:00:00.000Z', distanceKm: 5 }));

    await refreshLastRideAfterDelete(1);

    expect(mockGetTrip).toHaveBeenCalledWith(3);
    expect(getLastRide()?.tripId).toBe(3);
    expect(getLastRide()?.distanceKm).toBe(5);
  });

  it('clears the cache when no trips remain after the deletion', async () => {
    await captureLastRide(lastRideFromTrip(tripDetail({ id: 1 })));
    mockGetTrip.mockReset();

    mockListTrips.mockResolvedValue([]);

    await refreshLastRideAfterDelete(1);

    expect(mockGetTrip).not.toHaveBeenCalled();
    expect(getLastRide()).toBeNull();
    expect(await AsyncStorage.getItem(LAST_RIDE_KEY)).toBeNull();
  });
});

describe('reconcileLastRideWithBackend', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockListTrips.mockReset();
    mockGetTrip.mockReset();
  });

  it('is a no-op when the cached ride has no tripId yet', async () => {
    await captureLastRide({ ...lastRideFromTrip(tripDetail()), localId: 42, tripId: null });
    mockGetTrip.mockReset();

    await reconcileLastRideWithBackend();

    expect(mockGetTrip).not.toHaveBeenCalled();
  });

  it("re-adopts the backend's own figures for a confirmed-existing trip, not just its id", async () => {
    // Real bug this guards: a duplicate save can get silently deduped into an earlier
    // trip's row (clientTripId), leaving the locally-captured summary (distance/
    // duration/etc.) not matching what the backend actually stored under that trip id.
    // Confirming the trip merely exists isn't enough — the cached numbers themselves
    // must come from the backend, the source of truth, not the local finalize guess.
    await captureLastRide({ ...lastRideFromTrip(tripDetail({ id: 1, distanceKm: 7.3, durationSec: 1484 })), localId: 42 });
    mockGetTrip.mockReset();
    mockGetTrip.mockResolvedValue(tripDetail({ id: 1, distanceKm: 3.5, durationSec: 530 }));

    await reconcileLastRideWithBackend();

    expect(mockListTrips).not.toHaveBeenCalled();
    expect(getLastRide()?.tripId).toBe(1);
    expect(getLastRide()?.distanceKm).toBe(3.5);
    expect(getLastRide()?.durationSec).toBe(530);
    // localId is preserved from the existing cache (lastRideFromTrip itself has no
    // local queue row to draw one from), not wiped out by the re-adoption.
    expect(getLastRide()?.localId).toBe(42);
  });

  it('adopts the new most recent trip when the cached one 404s (deleted out-of-band)', async () => {
    await captureLastRide(lastRideFromTrip(tripDetail({ id: 1 })));
    mockGetTrip.mockReset();
    mockGetTrip.mockImplementation((id: number) =>
      id === 1
        ? Promise.reject(new Error('404 Not Found: {"detail":"Trip not found"}'))
        : Promise.resolve(tripDetail({ id, distanceKm: 7 })),
    );
    mockListTrips.mockResolvedValue([tripSummary({ id: 2, endTime: '2026-08-05T00:00:00.000Z' })]);

    await reconcileLastRideWithBackend();

    expect(getLastRide()?.tripId).toBe(2);
    expect(getLastRide()?.distanceKm).toBe(7);
  });

  it('leaves the cache untouched on a non-404 failure (offline, transient error)', async () => {
    await captureLastRide(lastRideFromTrip(tripDetail({ id: 1 })));
    mockGetTrip.mockReset();
    mockGetTrip.mockRejectedValue(new Error('Network request failed'));

    await reconcileLastRideWithBackend();

    expect(mockListTrips).not.toHaveBeenCalled();
    expect(getLastRide()?.tripId).toBe(1);
  });
});
