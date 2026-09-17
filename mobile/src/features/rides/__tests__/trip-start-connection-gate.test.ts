jest.mock('@/lib/db', () => ({
  getTripCheckpoint: jest.fn().mockResolvedValue(null),
  clearTripCheckpoint: jest.fn().mockResolvedValue(undefined),
  saveTripCheckpoint: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/api', () => ({
  api: { deleteInProgressTrip: jest.fn().mockResolvedValue(undefined), upsertInProgressTrip: jest.fn().mockResolvedValue({ ok: true }) },
}));
jest.mock('@/features/health/healthConnect', () => ({
  fetchVitalsForTrip: jest.fn().mockResolvedValue({}),
  writeExerciseSessionForTrip: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/features/rides/tripSync', () => ({ saveAndSyncTrip: jest.fn().mockResolvedValue({ localId: 1, synced: true }) }));
jest.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6 },
  startLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));
jest.mock('@/features/device/deviceLink', () => ({
  ensureBleConnected: jest.fn(),
  getBleSnapshot: jest.fn().mockResolvedValue({ batteryPct: 80, mileageTotalKm: 500, mode: null, voltageV: null }),
  getBoardUsability: jest.fn().mockReturnValue('unpaired'),
}));

import { saveAndSyncTrip } from '@/features/rides/tripSync';
import { tripRecorder } from '@/features/rides/tripRecorder';

function sample(timestamp: number) {
  return {
    coords: { latitude: 1, longitude: 1, speed: 10, accuracy: 5 },
    timestamp,
  } as unknown as Parameters<typeof tripRecorder.handleLocationSample>[0];
}

describe('trip start connection gate', () => {
  it('blocks manual starts when BLE has not confirmed the device', async () => {
    await expect(tripRecorder.startManual()).resolves.toBe(false);
    expect(tripRecorder.getSnapshot()).toEqual(expect.objectContaining({ state: 'idle', startBlockedReason: 'device-not-connected' }));
    expect(saveAndSyncTrip).not.toHaveBeenCalled();
  });

  it('keeps automatic detection idle when BLE is not confirmed', async () => {
    for (let index = 0; index < 30; index += 1) await tripRecorder.handleLocationSample(sample(index * 1_000));

    expect(tripRecorder.getSnapshot()).toEqual(expect.objectContaining({ state: 'idle', startBlockedReason: 'device-not-connected' }));
    expect(saveAndSyncTrip).not.toHaveBeenCalled();
  });
});
