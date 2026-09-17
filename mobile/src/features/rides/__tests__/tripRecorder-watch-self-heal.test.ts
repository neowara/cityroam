jest.mock('@/lib/db', () => ({
  getTripCheckpoint: jest.fn().mockResolvedValue(null),
  clearTripCheckpoint: jest.fn().mockResolvedValue(undefined),
  saveTripCheckpoint: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/api', () => ({
  api: {
    getInProgressTrip: jest.fn().mockResolvedValue(null),
    deleteInProgressTrip: jest.fn().mockResolvedValue(undefined),
    upsertInProgressTrip: jest.fn().mockResolvedValue({ ok: true }),
  },
}));
jest.mock('@/features/health/healthConnect', () => ({
  fetchVitalsForTrip: jest.fn().mockResolvedValue({}),
  writeExerciseSessionForTrip: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/features/rides/tripSync', () => ({
  saveAndSyncTrip: jest.fn().mockResolvedValue({ localId: 1, synced: true }),
}));
jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3, BestForNavigation: 6 },
  startLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  // The misleading case this test pins: the foreground-service task reports itself as
  // still started even though the real data path (the JS watchPositionAsync
  // subscription) has silently died — a self-heal that only checks this signal
  // concludes "nothing to do" and leaves the ride with no further GPS samples.
  hasStartedLocationUpdatesAsync: jest.fn().mockResolvedValue(true),
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));
jest.mock('@/features/device/deviceLink', () => ({
  ensureBleConnected: jest.fn(),
  refreshDeviceStatus: jest.fn().mockResolvedValue(undefined),
  getBleSnapshot: jest.fn().mockResolvedValue({
    online: true,
    speedKmh: null,
    batteryPct: 80,
    mileageTotalKm: 500,
    voltageV: null,
    mode: null,
  }),
  getBoardUsability: jest.fn().mockReturnValue('usable'),
  getPairedDeviceId: jest.fn().mockResolvedValue('dev-1'),
  subscribeBleSession: jest.fn(() => () => {}),
}));

import * as Location from 'expo-location';
import { tripRecorder } from '@/features/rides/tripRecorder';

describe('ensureLocationTrackingAlive — self-heal against a silently dead GPS watch', () => {
  it('forces a fresh watchPositionAsync subscription even when the tier and background task both look fine', async () => {
    const started = await tripRecorder.startManual();
    expect(started).toBe(true);

    const callsAfterStart = (Location.watchPositionAsync as jest.Mock).mock.calls.length;
    expect(callsAfterStart).toBeGreaterThan(0);

    // the old self-heal path only checked hasStartedLocationUpdatesAsync
    // (mocked true above) and setLocationWatchTier's tier-equality no-op (already
    // 'active' from startManual) — both signals say "healthy," so it never actually
    // touched the watch. This call must produce a genuinely new subscription
    // regardless, since that's the only way to recover a JS watch that died without
    // moving either of those two signals.
    await tripRecorder.ensureLocationTrackingAlive();

    expect((Location.watchPositionAsync as jest.Mock).mock.calls.length).toBeGreaterThan(callsAfterStart);

    await tripRecorder.endActive();
  });
});
