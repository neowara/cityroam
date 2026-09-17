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
  Accuracy: { Balanced: 3, BestForNavigation: 6 },
  startLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  hasStartedLocationUpdatesAsync: jest.fn().mockResolvedValue(false),
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));

// A fresh install (or any launch with nothing paired yet — a real production case: a
// release-signed build replacing a debug-signed one forces an uninstall first, wiping
// the paired device record) had no devId for startBleSpeedTracking to subscribe to at
// call time, and nothing ever retried once the rider paired their device later in the
// same process — the board-speed stream (the sole auto-start driver) never reached the
// state machine for the rest of that run. Confirmed live: a native ride auto-started
// with dpPushCount: 0 on the JS side, forcing a manual start. This suite drives that
// exact sequence: nothing paired at startBleSpeedTracking-time, a pairing event fires
// later, and the board's dp2 stream must reach the state machine after that.
let mockPairedDeviceId: string | null = null;
let mockDevicePairedListener: (() => void) | null = null;
let mockBleSessionListener: ((s: { dps?: Record<string, unknown> }) => void) | null = null;
let mockMileageTotalKm = 500;
let mockBleOffline = false;

jest.mock('@/features/device/deviceLink', () => ({
  ensureBleConnected: jest.fn(),
  refreshDeviceStatus: jest.fn().mockResolvedValue(undefined),
  getBleSnapshot: jest.fn().mockImplementation(async () => {
    mockMileageTotalKm += 0.5;
    return {
      online: true,
      deviceName: 'NAVEE',
      speedKmh: 20,
      batteryPct: 80,
      remoteBatteryPct: null,
      mileageOnceKm: null,
      mileageTotalKm: mockMileageTotalKm,
      rideTimeOnceSec: null,
      voltageV: null,
      mode: null,
      headlightOn: null,
      cruiseOn: null,
      lockOn: null,
      unit: null,
    };
  }),
  getBoardUsability: jest.fn(() => (mockBleOffline ? 'offline' : 'usable')),
  getPairedDeviceId: jest.fn(() => Promise.resolve(mockPairedDeviceId)),
  onDevicePaired: jest.fn((listener: () => void) => {
    mockDevicePairedListener = listener;
    return () => {
      mockDevicePairedListener = null;
    };
  }),
  subscribeBleSession: jest.fn((_devId: string, cb: (s: { dps?: Record<string, unknown> }) => void) => {
    mockBleSessionListener = cb;
    return () => {
      mockBleSessionListener = null;
    };
  }),
}));

import { saveAndSyncTrip } from '@/features/rides/tripSync';
import { tripRecorder } from '@/features/rides/tripRecorder';

function fakeSample(baseMs: number, offsetMs: number, speedMs: number) {
  return {
    coords: { latitude: 1, longitude: 1, speed: speedMs, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null },
    timestamp: baseMs + offsetMs,
  } as unknown as Parameters<typeof tripRecorder.handleLocationSample>[0];
}

function pushBoardSpeed(speedKmh: number) {
  mockBleSessionListener?.({ dps: { '2': speedKmh * 10 } });
}

function pushBoardTelemetry(odometerKm: number) {
  mockBleSessionListener?.({ dps: { '12': Math.round(odometerKm * 10) } });
}

describe('BLE speed tracking arms once a device pairs after startBleSpeedTracking already ran', () => {
  const t0 = Date.parse('2026-09-13T12:30:00Z');

  beforeAll(async () => {
    // Nothing paired yet at the moment this is called — mirrors a fresh app launch on
    // an install with no paired device.
    tripRecorder.startBleSpeedTracking();
    await new Promise((r) => setTimeout(r, 0));
  });

  afterEach(async () => {
    // Drains any still-settling fire-and-forget auto-start/end chain before the next test.
    await new Promise((r) => setTimeout(r, 1500));
  });

  it('never sees board speed while nothing is paired', () => {
    expect(mockBleSessionListener).toBeNull();
    pushBoardSpeed(30);
    expect(tripRecorder.getSnapshot().state).toBe('idle');
  });

  it('subscribes and auto-starts once a device becomes paired mid-session', async () => {
    mockPairedDeviceId = 'navee-AABBCCDDEEFF';
    // The real pairing flow calls notifyDevicePaired() (deviceLink) at the end of
    // registerDirectBoard/naveePairVehicle/setActiveDeviceId — simulated here by firing
    // the captured onDevicePaired listener directly.
    expect(mockDevicePairedListener).not.toBeNull();
    mockDevicePairedListener?.();
    // getPairedDeviceId() resolves asynchronously inside the retried attempt.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockBleSessionListener).not.toBeNull();

    const nowSpy = jest.spyOn(Date, 'now');
    let fakeNow = t0;
    nowSpy.mockImplementation(() => fakeNow);

    try {
      pushBoardTelemetry(500);
      pushBoardSpeed(30);
      fakeNow = t0 + 4000;
      pushBoardSpeed(30);
      // handleAutoStartEvent is fire-and-forget from feedBoardSpeedToMachine, and this
      // test drives no GPS samples to yield to it in between — a real, short wait lets
      // its own async chain (GPS-tier escalation, snapshot, checkpoint) actually settle.
      await new Promise((r) => setTimeout(r, 100));

      expect(tripRecorder.getSnapshot().state).toBe('riding');
    } finally {
      nowSpy.mockRestore();
      // Auto-stop is BLE-disconnect only — see tripStateMachine.ts.
      pushBoardTelemetry(510);
      mockBleOffline = true;
      await tripRecorder.handleLocationSample(fakeSample(t0, 20_000, 20 / 3.6));
    }

    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
  });
});
