import { isLocalTripId, localIdFromTripId, queuedTripToDetail, queuedTripToSummary, tripIdFromLocalId } from '@/features/rides/localTrips';
import type { QueuedTrip } from '@/lib/db';
import type { TripCreate } from '@/features/rides/tripTypes';

function makeQueuedTrip(overrides: Partial<TripCreate> = {}, localId = 7): QueuedTrip {
  const payload: TripCreate = {
    startTime: '2026-09-04T09:50:36.000Z',
    endTime: '2026-09-04T10:08:44.000Z',
    distanceKm: 7.065,
    avgSpeedKmh: 23.4,
    maxSpeedKmh: 31.2,
    durationSec: 1087,
    wasManual: false,
    batteryStartPct: 91,
    batteryEndPct: 86,
    batteryUsedPct: 5,
    odometerStartKm: 500,
    odometerEndKm: 507.065,
    heartRateAvgBpm: null,
    heartRateMaxBpm: null,
    heartRateStartBpm: null,
    heartRateEndBpm: null,
    restingHeartRateBpm: null,
    heartRateVariabilityMs: null,
    steps: null,
    weightKg: null,
    route: [{ lat: 1, lon: 1, timestampMs: 0, speedKmh: 20 }],
    stops: [],
    modeSamples: [
      { timestampMs: 0, mode: 'ride' },
      { timestampMs: 1000, mode: 'ride' },
      { timestampMs: 2000, mode: 'eco' },
    ],
    voltageSamples: [{ timestampMs: 0, voltage: 55.8 }],
    boardSpeedSamples: [],
    clientTripId: null,
    ...overrides,
  };
  return { localId, payload, synced: false, backendId: null, createdAt: '2026-09-04T10:08:44.000Z', lastError: null };
}

describe('localTrips id convention', () => {
  it('negates a localId into a trip id and back, never colliding with a real backend id', () => {
    expect(tripIdFromLocalId(7)).toBe(-7);
    expect(localIdFromTripId(-7)).toBe(7);
    expect(isLocalTripId(-7)).toBe(true);
    expect(isLocalTripId(7)).toBe(false); // a real backend id is always positive
  });
});

describe('queuedTripToDetail', () => {
  it('maps a trip_queue row into the same shape a synced trip has, with a negative id', () => {
    const detail = queuedTripToDetail(makeQueuedTrip());
    expect(detail.id).toBe(-7);
    expect(detail.distanceKm).toBe(7.065);
    expect(detail.route).toHaveLength(1);
    expect(detail.snappedRoute).toBeNull(); // road map-matching is backend-only
    expect(detail.weatherCodes).toBeNull(); // weather lookup is backend-only
  });

  it('picks the mode with the most samples as dominant, and flags mixed when more than one mode appears', () => {
    const detail = queuedTripToDetail(makeQueuedTrip());
    expect(detail.dominantMode).toBe('ride'); // 2 ride samples vs 1 eco
    expect(detail.modeMixed).toBe(true);
  });

  it('reports a single mode as not mixed', () => {
    const detail = queuedTripToDetail(makeQueuedTrip({ modeSamples: [{ timestampMs: 0, mode: 'eco' }] }));
    expect(detail.dominantMode).toBe('eco');
    expect(detail.modeMixed).toBe(false);
  });

  it('reports null/not-mixed for a trip with no mode samples at all', () => {
    const detail = queuedTripToDetail(makeQueuedTrip({ modeSamples: [] }));
    expect(detail.dominantMode).toBeNull();
    expect(detail.modeMixed).toBe(false);
  });
});

describe('queuedTripToSummary', () => {
  it('drops the detail-only route/stops/sample fields but keeps the same id/stats', () => {
    const summary = queuedTripToSummary(makeQueuedTrip());
    expect(summary.id).toBe(-7);
    expect(summary.distanceKm).toBe(7.065);
    expect('route' in summary).toBe(false);
    expect('snappedRoute' in summary).toBe(false);
  });
});
