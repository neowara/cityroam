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
  },
}));
jest.mock('@/features/health/healthConnect', () => ({
  fetchVitalsForTrip: jest.fn().mockResolvedValue({}),
  writeExerciseSessionForTrip: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/features/rides/tripSync', () => ({
  saveAndSyncTrip: jest.fn().mockResolvedValue({ localId: 1, synced: true }),
}));
// GPS-tier escalation (applyGpsTierAction's 'trip_starting' action, awaited BEFORE
// resetTripAccumulators/snapshotAt('start') in handleAutoStartEvent) awaits
// Location.watchPositionAsync -- delayed here to reproduce the real ordering that
// caused this bug: a real ride's start snapshot landed ~54s after the ride's true
// start because this escalation ran to completion first. The fix must get the right
// answer regardless of how slow this is, which is exactly what this delay proves.
jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 4, BestForNavigation: 6 },
  startLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  hasStartedLocationUpdatesAsync: jest.fn().mockResolvedValue(false),
  watchPositionAsync: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve({ remove: jest.fn() }), 3000))),
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));

import type { BoardSnapshot } from '@/lib/api';

function makeSnapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    online: true,
    deviceName: 'Tynee',
    speedKmh: null,
    batteryPct: null,
    remoteBatteryPct: null,
    mileageOnceKm: null,
    mileageTotalKm: null,
    rideTimeOnceSec: null,
    voltageV: null,
    mode: null,
    headlightOn: null,
    cruiseOn: null,
    lockOn: null,
    unit: null,
    ...overrides,
  };
}

let mockSnapshotQueue: BoardSnapshot[] = [];
let mockBleOffline = false;
let mockBleSessionListener: ((s: { dps?: Record<string, unknown> }) => void) | null = null;
jest.mock('@/features/device/deviceLink', () => ({
  ensureBleConnected: jest.fn(),
  refreshDeviceStatus: jest.fn().mockResolvedValue(undefined),
  // Default snapshot inlined -- the mock factory can't reference out-of-scope helpers
  // like makeSnapshot (same constraint tripRecorder-snapshot-retry.test.ts hits).
  getBleSnapshot: jest.fn(() =>
    Promise.resolve(
      mockSnapshotQueue.shift() ?? {
        online: true,
        deviceName: 'Tynee',
        speedKmh: null,
        batteryPct: null,
        remoteBatteryPct: null,
        mileageOnceKm: null,
        mileageTotalKm: null,
        rideTimeOnceSec: null,
        voltageV: null,
        mode: null,
        headlightOn: null,
        cruiseOn: null,
        lockOn: null,
        unit: null,
      },
    ),
  ),
  getBoardUsability: jest.fn(() => (mockBleOffline ? 'offline' : 'usable')),
  onDevicePaired: jest.fn(() => () => {}),
  getPairedDeviceId: jest.fn().mockResolvedValue('dev-1'),
  subscribeBleSession: jest.fn((_devId: string, cb: (s: { dps?: Record<string, unknown> }) => void) => {
    mockBleSessionListener = cb;
    return () => {
      mockBleSessionListener = null;
    };
  }),
}));

import { getBleSnapshot } from '@/features/device/deviceLink';
import { saveAndSyncTrip } from '@/features/rides/tripSync';
import { tripRecorder } from '@/features/rides/tripRecorder';

// dp12 (odometer, scale 1: raw = display x 10) and dp3 (battery, unscaled) — same
// wire shapes RideService.kt and deviceLink both decode.
function pushBoardTelemetry(odometerKm: number, batteryPct: number) {
  mockBleSessionListener?.({ dps: { '12': Math.round(odometerKm * 10), '3': batteryPct } });
}

function pushBoardSpeed(speedKmh: number) {
  mockBleSessionListener?.({ dps: { '2': speedKmh * 10 } });
}

function fakeSample(baseMs: number, offsetMs: number, speedMs: number) {
  return {
    coords: { latitude: 1, longitude: 1, speed: speedMs, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null },
    timestamp: baseMs + offsetMs,
  } as unknown as Parameters<typeof tripRecorder.handleLocationSample>[0];
}

describe('trip start baseline captured from the live BLE stream, not a late snapshot', () => {
  // Real timers throughout (the GPS-tier escalation delay above, plus the 3s
  // auto-start sustain window) -- generous ceiling matching
  // tripRecorder-snapshot-retry.test.ts's own established pattern for this reason.
  jest.setTimeout(20000);

  const t0 = Date.parse('2026-09-01T09:00:00Z');

  beforeAll(async () => {
    tripRecorder.startBleSpeedTracking();
    await new Promise((r) => setTimeout(r, 0));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSnapshotQueue = [];
    mockBleOffline = false;
  });

  it('seeds odometerStartKm/batteryStartPct from the pre-ride dp stream, not the late start snapshot', async () => {
    // The board already reported 857.4km / 97% before the ride ever started -- the
    // real values this ride should be baselined against.
    pushBoardTelemetry(857.4, 97);

    // The 'start' snapshot's own query, once the (mocked, delayed) GPS-tier
    // escalation finally lets it run, returns a DIFFERENT, wrong reading -- what the
    // board would report several seconds INTO the ride, not at its start. The old
    // code accepted this unconditionally; the fix must not.
    mockSnapshotQueue = [makeSnapshot({ mileageTotalKm: 858.0, batteryPct: 90 })];

    const nowSpy = jest.spyOn(Date, 'now');
    let fakeNow = t0;
    nowSpy.mockImplementation(() => fakeNow);
    try {
      pushBoardSpeed(30);
      fakeNow = t0 + 4000;
      pushBoardSpeed(30);
      // Long enough to clear both the mocked 3s GPS-tier-escalation delay and the
      // start snapshot's own query.
      await new Promise((r) => setTimeout(r, 4000));
    } finally {
      nowSpy.mockRestore();
    }

    for (let i = 0; i <= 19; i++) {
      await tripRecorder.handleLocationSample(fakeSample(t0, i * 1000, 30 / 3.6));
    }

    try {
      // The 'start' snapshot did land (it's what makes the retry/telemetry mock
      // meaningful) -- getBleSnapshot's own queued read was consumed.
      expect(getBleSnapshot).toHaveBeenCalled();
    } finally {
      mockBleOffline = true;
      await tripRecorder.handleLocationSample(fakeSample(t0, 20_000, 30 / 3.6));
    }

    const saved = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    expect(saved.odometerStartKm).toBe(857.4);
    expect(saved.batteryStartPct).toBe(97);
  });
});
