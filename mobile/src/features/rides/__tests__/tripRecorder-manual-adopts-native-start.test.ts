jest.mock('@/lib/db', () => ({
  getBackendIdForLocal: jest.fn().mockResolvedValue(null),
  getTripCheckpoint: jest.fn().mockResolvedValue(null),
  clearTripCheckpoint: jest.fn().mockResolvedValue(undefined),
  saveTripCheckpoint: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/api', () => ({
  api: {
    getInProgressTrip: jest.fn().mockResolvedValue(null),
    deleteInProgressTrip: jest.fn().mockResolvedValue(undefined),
    upsertInProgressTrip: jest.fn().mockResolvedValue({ ok: true }),
    snapshot: jest.fn().mockResolvedValue({ batteryPct: 80, mileageTotalKm: 500, mode: null, voltageV: null }),
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
  Accuracy: { BestForNavigation: 6 },
  startLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  hasStartedLocationUpdatesAsync: jest.fn().mockResolvedValue(false),
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));
jest.mock('@/features/device/deviceLink', () => ({
  ensureBleConnected: jest.fn(),
  refreshDeviceStatus: jest.fn().mockResolvedValue(undefined),
  getBleSnapshot: jest.fn().mockResolvedValue({
    online: true,
    deviceName: 'NAVEE',
    speedKmh: null,
    batteryPct: 80,
    remoteBatteryPct: null,
    mileageOnceKm: null,
    mileageTotalKm: 500,
    rideTimeOnceSec: null,
    voltageV: null,
    mode: null,
    headlightOn: null,
    cruiseOn: null,
    lockOn: null,
    unit: null,
  }),
  getBoardUsability: jest.fn(() => 'usable'),
  onDevicePaired: jest.fn(() => () => {}),
  getPairedDeviceId: jest.fn().mockResolvedValue('navee-AABBCCDDEEFF'),
  subscribeBleSession: jest.fn(() => () => {}),
}));

import RideCoreNative, { type NativeRide } from '@modules/ride-core/src/RideCore';
import { tripRecorder } from '@/features/rides/tripRecorder';

function makeRide(overrides: Partial<NativeRide> = {}): NativeRide {
  return {
    id: 1,
    startMs: 0,
    endMs: null,
    state: 'open',
    wasManual: false,
    odoStartKm: 500,
    odoEndKm: null,
    batteryStartPct: 80,
    batteryEndPct: null,
    distanceKm: null,
    maxSpeedKmh: null,
    endReason: null,
    backendId: null,
    ...overrides,
  };
}

// Real bug this guards: RideService (native) auto-starts independently of this JS
// state machine. A manual tap that lands well after that native auto-start (a rider
// working around a stuck/blocked JS auto-start, or — before the startBleSpeedTracking
// fix — one that never armed at all) used to stamp the manual trip with "now" as its
// own start time. The two save paths then computed different clientTripId keys for
// the SAME ride, and a 150s gap is well past both the backend's exact-key match and
// its 90s start/end proximity dedupe — as two saved trips for one ride.
describe("manual start adopts an already-open native ride's start time", () => {
  const t0 = Date.parse('2026-09-13T12:45:18Z');

  afterEach(async () => {
    jest.restoreAllMocks();
    // Ends whatever this test started, so the module-singleton recorder starts the
    // next test from 'idle'.
    if (tripRecorder.getSnapshot().state !== 'idle') await tripRecorder.endActive();
  });

  it('uses the native ride\'s startMs, not "now", when one is already open', async () => {
    const nativeStartMs = t0 - 150_000;
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(makeRide({ startMs: nativeStartMs }));
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);

    try {
      await tripRecorder.startManual();
    } finally {
      nowSpy.mockRestore();
    }

    expect(tripRecorder.getSnapshot().tripStartEpochMs).toBe(nativeStartMs);
  });

  it('falls back to "now" when no native ride is open', async () => {
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(null);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);

    try {
      await tripRecorder.startManual();
    } finally {
      nowSpy.mockRestore();
    }

    expect(tripRecorder.getSnapshot().tripStartEpochMs).toBe(t0);
  });
});
