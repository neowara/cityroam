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
  // subscribeWatch (location.ts) awaits watchPositionAsync on every tier escalation; a
  // real subscription object with .remove() keeps the handover path from throwing.
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));
let mockBleOffline = false;
// The board's odometer (dp12) advances as the trip progresses. Distance is the odometer
// delta (end − start) when the board is connected the whole trip (BOARD = telemetry /
// PHONE = GPS only), so the mock must return a *growing* mileageTotalKm across
// snapshot calls — a constant odometer would give a 0 km delta and the finished ride would
// be discarded.
let mockMileageTotalKm = 500;
// Merged mock of the board-link module (formerly split across @/lib/tuyaBle +
// @/lib/tuyaBleSession). Capture the BLE session subscription callback so
// tests can push board dp2 speed in.
let mockBleSessionListener: ((s: { dps?: Record<string, unknown> }) => void) | null = null;
jest.mock('@/features/device/deviceLink', () => ({
  ensureBleConnected: jest.fn(),
  refreshDeviceStatus: jest.fn().mockResolvedValue(undefined),
  getBleSnapshot: jest.fn().mockImplementation(async () => {
    mockMileageTotalKm += 0.5;
    return {
      online: true,
      deviceName: 'Tynee',
      speedKmh: null,
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

// Push a board dp2 speed (raw, scale 1) through the captured BLE session subscription.
function pushBoardSpeed(speedKmh: number) {
  mockBleSessionListener?.({ dps: { '2': speedKmh * 10 } });
}

function fakeSample(baseMs: number, offsetMs: number, speedMs: number) {
  return {
    coords: { latitude: 1, longitude: 1, speed: speedMs, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null },
    timestamp: baseMs + offsetMs,
  } as unknown as Parameters<typeof tripRecorder.handleLocationSample>[0];
}

describe('startManual — handoff from an in-progress auto-detected trip', () => {
  // The auto trip's finalize tail (save-or-discard, checkpoint clear, notify) now runs
  // through the shared finalizeTrip module — these tests exercise that full recorder
  // path with the module's deps stubbed by the jest.mock()s above, so they assert the
  // recorder-level contract while tripFinalize.test.ts covers the module itself.
  const t0 = Date.parse('2026-08-22T09:00:00Z');

  // Wire the recorder's BLE speed subscription ONCE (it's a singleton guarded by
  // bleSpeedTrackingStarted, so calling it in beforeEach would no-op on every test after
  // the first and leave mockBleSessionListener null). startBleSpeedTracking resolves
  // getPairedDeviceId() asynchronously, so flush the microtask before any test pushes
  // board speed — otherwise the listener isn't registered yet.
  beforeAll(async () => {
    tripRecorder.startBleSpeedTracking();
    await new Promise((r) => setTimeout(r, 0));
  });

  // Real timers (matching tripRecorder-ble-disconnect.test.ts): pollSnapshotAt's bounded
  // settle/retry waits are real setTimeout calls, so awaiting each sample lets them
  // resolve naturally — fake timers would hang those waits.
  beforeEach(() => {
    jest.clearAllMocks();
    mockBleOffline = false;
    mockMileageTotalKm = 500;
  });

  // + auto-start is driven ONLY by the
  // board's wheel speed (dp2), fed DIRECTLY from the BLE stream (feedBoardSpeedToMachine)
  // — never by GPS samples (handleLocationSample no longer feeds the machine while idle).
  // So drive the 3s sustain window by pushing board speed across it; Date.now controls
  // the clock (feedBoardSpeedToMachine stamps samples with Date.now()).
  async function driveToRiding() {
    const nowSpy = jest.spyOn(Date, 'now');
    let fakeNow = t0;
    nowSpy.mockImplementation(() => fakeNow);
    try {
      pushBoardSpeed(30); // at t0 — above START_SPEED_KMH
      fakeNow = t0 + 4000; // 4s later — the 3s sustain window is met
      pushBoardSpeed(30); // auto_start fires here
      // auto_start's snapshotAt('start') call is fire-and-forget from here (see
      // feedBoardSpeedToMachine) and reads real Date.now() internally once it resolves
      // (tripRecord.ts's snapshotAt staleness guard) — give it a moment to finish while
      // Date.now is still mocked, so it doesn't see the mock get pulled out from under
      // it mid-flight and misread a huge (real minus fake) delay as a stale capture.
      await new Promise((resolve) => setTimeout(resolve, 700));
    } finally {
      nowSpy.mockRestore();
    }
  }

  it('saves the auto trip (if it clears the minimum-viability guard) before starting the manual one', async () => {
    // Real user ask: manual Start used to silently wipe whatever auto-detection was
    // already tracking, with nothing saved. Under the BOARD = telemetry / PHONE = GPS
    // only semantics, auto-start is driven by the board's wheel speed, so
    // drive it via sustained board speed first. GPS samples then flow while recording
    // to give the trip enough real distance/duration to clear shouldDiscardTrip's
    // floors before the user taps Start Trip manually.
    await driveToRiding();

    // auto_start's handler is fire-and-forget and its start snapshot waits a real
    // SNAPSHOT_RESPONSE_SETTLE_MS before reading the board, so autoStartInFlight is
    // still true right after driveToRiding() returns. startManual() blocks while that
    // flag is set, so give the auto trip time to actually reach 'riding' (and clear the
    // flag) before handing off — otherwise the auto trip is never finalized and saved.
    await new Promise((r) => setTimeout(r, 1200));

    await tripRecorder.handleLocationSample(fakeSample(t0, 4_000, 10));
    await tripRecorder.handleLocationSample(fakeSample(t0, 15_100, 10));

    await tripRecorder.startManual();

    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
    const savedAutoTrip = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    expect(savedAutoTrip.wasManual).toBe(false);
    expect(savedAutoTrip.distanceKm).toBeGreaterThan(0);
  });

  it('discards a too-short auto trip instead of saving it, then still starts the manual one cleanly', async () => {
    // Auto-start via board speed, then immediately hand off to manual — the auto trip
    // has ~0 distance and ~0 duration, so it's discarded rather than saved.
    await driveToRiding();

    await tripRecorder.startManual();

    expect(saveAndSyncTrip).not.toHaveBeenCalled();
  });
});
