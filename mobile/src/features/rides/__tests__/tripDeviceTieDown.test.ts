// Every trip, and the in-progress copy of a ride, belongs to exactly one device. A trip
// saved before its device is known waits in the local queue until it can be assigned,
// rather than reaching the backend without one.
const mockQueue: { localId: number; payload: Record<string, unknown> }[] = [];
jest.mock('@/lib/db', () => ({
  enqueueTrip: jest.fn(async () => 1),
  getUnsyncedTrips: jest.fn(async () => mockQueue),
  markSynced: jest.fn().mockResolvedValue(undefined),
  markSyncFailed: jest.fn().mockResolvedValue(undefined),
  setQueuedTripDeviceId: jest.fn().mockResolvedValue(undefined),
  saveTripCheckpoint: jest.fn().mockResolvedValue(undefined),
  clearTripCheckpoint: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/api', () => ({
  api: {
    createTrip: jest.fn(async () => ({ id: 500 })),
    upsertInProgressTrip: jest.fn().mockResolvedValue({ ok: true }),
    deleteInProgressTrip: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn() }));
jest.mock('@/features/widget/widgetLastRide', () => ({ backfillLastRideTripId: jest.fn().mockResolvedValue(undefined) }));
const mockActiveDevice = { id: null as string | null };
jest.mock('@/features/rides/tripDevice', () => ({ resolveTripDeviceId: jest.fn(async () => mockActiveDevice.id) }));

import { api } from '@/lib/api';
import { setQueuedTripDeviceId } from '@/lib/db';
import { saveAndSyncTrip, syncUnsyncedTrips } from '@/features/rides/tripSync';
import { writeCheckpoint } from '@/features/rides/tripRecorder/checkpoints';
import type { TripCreate } from '@/features/rides/tripTypes';
import type { TripCheckpoint } from '@/lib/db';

const trip = { startTime: '2026-09-23T08:00:00Z', endTime: '2026-09-23T08:20:00Z', distanceKm: 5 } as TripCreate;

const checkpoint: TripCheckpoint = {
  tripStartMs: 0,
  wasManual: false,
  route: [],
  stops: [],
  modeSamples: [],
  voltageSamples: [],
  boardSpeedSamples: [],
  distanceKm: 1,
  maxSpeedKmh: 20,
  batteryStartPct: 90,
  odometerStartKm: 800,
  latestOdometerKm: null,
  latestBatteryPct: null,
  lastUpdateMs: 1000,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQueue.length = 0;
  mockActiveDevice.id = null;
});

describe('trips are tied to a device', () => {
  it('holds a trip with no device in the queue instead of uploading it', async () => {
    const result = await saveAndSyncTrip({ ...trip, deviceId: null });
    expect(result).toEqual({ localId: 1, synced: false });
    expect(api.createTrip).not.toHaveBeenCalled();
  });

  it('uploads a trip that has its device straight away', async () => {
    await saveAndSyncTrip({ ...trip, deviceId: 'board-1' });
    expect(api.createTrip).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'board-1' }));
  });

  it('assigns the active device to a held trip on the next sync, then uploads it', async () => {
    mockQueue.push({ localId: 7, payload: { ...trip } });
    mockActiveDevice.id = 'board-1';
    await syncUnsyncedTrips();
    expect(setQueuedTripDeviceId).toHaveBeenCalledWith(7, 'board-1');
    expect(api.createTrip).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'board-1' }));
  });

  it('keeps a held trip queued while there is still no device', async () => {
    mockQueue.push({ localId: 7, payload: { ...trip } });
    await syncUnsyncedTrips();
    expect(api.createTrip).not.toHaveBeenCalled();
  });

  it('sends the in-progress backup under its device, and never without one', async () => {
    await writeCheckpoint({ ...checkpoint, deviceId: 'board-1' });
    expect(api.upsertInProgressTrip).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'board-1' }));

    (api.upsertInProgressTrip as jest.Mock).mockClear();
    await writeCheckpoint({ ...checkpoint, deviceId: null });
    expect(api.upsertInProgressTrip).not.toHaveBeenCalled();
  });
});
