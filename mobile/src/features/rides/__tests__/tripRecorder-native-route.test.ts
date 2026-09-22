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
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));

const mockGetNativeTripData = jest.fn();
jest.mock('@/features/rides/rideCoreSync', () => ({
  getNativeTripData: (...args: unknown[]) => mockGetNativeTripData(...args),
  findNativeRideToAdopt: jest.fn().mockResolvedValue(null),
}));

let mockBleOffline = false;
let mockMileageTotalKm = 500;
let mockBleSessionListener: ((s: { dps?: Record<string, unknown> }) => void) | null = null;
jest.mock('@/features/device/deviceLink', () => ({
  ensureBleConnected: jest.fn(),
  refreshDeviceStatus: jest.fn().mockResolvedValue(undefined),
  getBleSnapshot: jest.fn().mockImplementation(async () => {
    mockMileageTotalKm += 0.5;
    return { batteryPct: 80, mileageTotalKm: mockMileageTotalKm, mode: null, voltageV: null };
  }),
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

function pushBoardTelemetry(odometerKm: number, batteryPct: number) {
  mockBleSessionListener?.({ dps: { '12': Math.round(odometerKm * 10), '3': batteryPct } });
}

// The live finish path is supposed to source a trip's saved route,
// mode, and voltage samples from the native ride journal instead of the JS capture
// path — this proves finishTrip actually wires the two together, not just that
// getNativeTripData's own logic is correct in isolation (covered separately in
// rideCoreSync.test.ts). Deliberately does NOT mark the native ride uploaded — see
// rideCoreSync.ts's own doc comment for why that would break RideService.kt's
// reconnect-stitch window.
describe('tripRecorder sources the saved route/mode/voltage from the native journal', () => {
  const t0 = Date.parse('2026-09-12T09:00:00Z');

  beforeAll(async () => {
    tripRecorder.startBleSpeedTracking();
    await new Promise((r) => setTimeout(r, 0));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockBleOffline = false;
    mockMileageTotalKm = 500;
    mockGetNativeTripData.mockReturnValue(null);
  });

  async function driveToRidingThenDisconnect() {
    const nowSpy = jest.spyOn(Date, 'now');
    let fakeNow = t0;
    nowSpy.mockImplementation(() => fakeNow);
    try {
      pushBoardTelemetry(500, 100);
      pushBoardSpeed(20);
      fakeNow = t0 + 4000;
      pushBoardSpeed(20);
      for (let i = 0; i <= 30; i++) {
        await tripRecorder.handleLocationSample(fakeSample(t0, i * 1000, 20 / 3.6));
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    } finally {
      nowSpy.mockRestore();
    }
    pushBoardTelemetry(501, 78);
    mockBleOffline = true;
    await tripRecorder.handleLocationSample(fakeSample(t0, 31_000, 20 / 3.6));
  }

  it('saves the native journal route/mode/voltage instead of the JS-collected ones when a native ride matches', async () => {
    const nativeRoute = [
      { lat: 9, lon: 9, timestampMs: t0, speedKmh: 10, accuracyM: 3 },
      { lat: 9.01, lon: 9.01, timestampMs: t0 + 5000, speedKmh: 12, accuracyM: 3 },
    ];
    const nativeModeSamples = [{ timestampMs: t0, mode: 'eco', batteryPct: 90 }];
    const nativeVoltageSamples = [{ timestampMs: t0, voltage: 57.2 }];
    mockGetNativeTripData.mockReturnValue({
      route: nativeRoute,
      modeSamples: nativeModeSamples,
      voltageSamples: nativeVoltageSamples,
      nativeRideId: 42,
    });

    await driveToRidingThenDisconnect();

    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
    const saved = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    // The JS GPS watch fed 31 samples into the record's own route — proves the native
    // one (2 points) actually replaced it rather than just being appended/ignored.
    expect(saved.route).toEqual(nativeRoute);
    expect(saved.modeSamples).toEqual(nativeModeSamples);
    expect(saved.voltageSamples).toEqual(nativeVoltageSamples);
  });

  it('falls back to the JS-collected route/mode/voltage when no native ride matches', async () => {
    mockGetNativeTripData.mockReturnValue(null);

    await driveToRidingThenDisconnect();

    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
    const saved = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    expect(saved.route.length).toBeGreaterThan(0);
  });
});
