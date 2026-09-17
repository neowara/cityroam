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
  // subscribeWatch (location.ts) awaits watchPositionAsync on every tier escalation; a
  // real subscription object with .remove() keeps the handover path from throwing.
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));

// Auto-start is driven purely by the board's wheel-based speed sensor (dp2) — there is
// no motion-activity gate on auto-start. Android's Activity Recognition
// API has no "scooter" category, so a mounted/pocketed phone reports "stationary"
// (Medium confidence) even at 15km/h+; that false verdict used to block auto-start on
// every real ride. The fix removed the gate entirely: board speed alone
// decides. Under Option 1 (connection-gated idle) the motion-activity module no longer
// exists at all — idle GPS is gated purely on the board being connected. These tests
// pin that a board reporting real speed via the BLE session auto-starts regardless of
// any phone-side motion signal.
let mockBleOffline = false;
// The board's odometer (dp12) advances as the trip progresses. Distance is the odometer
// delta (end − start) when the board is connected the whole trip (BOARD = telemetry /
// PHONE = GPS only), so the mock must return a *growing* mileageTotalKm across
// snapshot calls — a constant odometer would give a 0 km delta and the finished ride would
// be discarded. Each snapshot call advances the odometer by ~0.05 km (50 m), so a trip that
// polls a handful of snapshots accumulates well past the 0.1 km discard floor.
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
      speedKmh: 30,
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

function fakeSample(baseMs: number, offsetMs: number, speedMs: number) {
  return {
    coords: { latitude: 1, longitude: 1, speed: speedMs, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null },
    timestamp: baseMs + offsetMs,
  } as unknown as Parameters<typeof tripRecorder.handleLocationSample>[0];
}

// Push a board dp2 speed (raw, scale 1) through the captured BLE session subscription.
function pushBoardSpeed(speedKmh: number) {
  mockBleSessionListener?.({ dps: { '2': speedKmh * 10 } });
}

// Push the board's own passive dp12 (odometer, scale 1) telemetry -- the real
// production source for latestOdometerKm, which a ble_disconnect end now relies on
// instead of the (skipped) end snapshot (see tripRecorder.ts's finishTrip). This
// file's only other odometer source is the active getBleSnapshot query mock, which
// isn't reached deterministically enough (a real board's dp12 stream vs. the active
// query race the same way an actual ride's periodic poll and passive pushes do) to
// guarantee a real, later reading exists by the time a test's ble_disconnect fires.
function pushBoardTelemetry(odometerKm: number) {
  mockBleSessionListener?.({ dps: { '12': Math.round(odometerKm * 10) } });
}

describe('board-speed-driven auto-start (real bug 2026-09-01)', () => {
  const t0 = Date.parse('2026-09-01T10:00:00Z');

  // Wire the recorder's BLE speed subscription ONCE (it's a singleton guarded by
  // bleSpeedTrackingStarted, so calling it in beforeEach would no-op on every test after
  // the first and leave mockBleSessionListener null). startBleSpeedTracking resolves
  // getPairedDeviceId() asynchronously, so flush the microtask before any test pushes
  // board speed — otherwise the listener isn't registered yet.
  beforeAll(async () => {
    tripRecorder.startBleSpeedTracking();
    await new Promise((r) => setTimeout(r, 0));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockBleOffline = false;
    mockMileageTotalKm = 500;
  });

  // A test's own auto-start handler (handleAutoStartEvent) can still be mid-flight
  // (its own bounded snapshot/checkpoint waits are real setTimeout calls) when a test
  // ends the ride from a completely separate path (endTrip's ble_disconnect) before
  // that original chain reaches its own `finally` -- autoStartInFlight only clears
  // there, and nothing else clears it. Left running, it settles on its own schedule,
  // which can land during the NEXT test and (since autoStartInFlight is still true)
  // silently block that test's own real auto-start from ever calling
  // handleAutoStartEvent, even though the state machine itself transitions fine.
  // Draining here (comfortably longer than that chain's own real settle bound) keeps
  // one test's still-finishing auto-start from stealing the next test's.
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 1500));
  });

  // Ending the trip (BLE disconnect -> auto_end) stops the background location-watch /
  // motion-poll / tick timers that auto_start started, so the test process doesn't hang
  // on open handles — same cleanup the existing tripRecorder tests rely on. It also
  // returns the module-level tripRecorder singleton to 'idle' so the next test starts
  // clean (there is no public reset; ending the trip is the reset).
  async function endTrip() {
    // A real, later odometer reading via the passive stream -- see
    // pushBoardTelemetry's own doc comment for why this suite needs it now that a
    // ble_disconnect end skips its own end-of-ride snapshot query.
    pushBoardTelemetry(510);
    mockBleOffline = true;
    await tripRecorder.handleLocationSample(fakeSample(t0, 20_000, 20 / 3.6));
  }

  it('auto-starts on board speed alone, regardless of any phone-side motion signal', async () => {
    // The board is moving (dp2 = 30 km/h) — board speed is the sole auto-start source
    // there is no motion-activity gate anymore (Option 1 removed it).
    // Since the idle -> auto_start transition is driven ONLY by the BLE dp2
    // stream (feedBoardSpeedToMachine), never by GPS samples — so the sustain window is
    // advanced by pushing board speed across the 3s window, not by handleLocationSample.
    // GPS samples still flow below to prove they neither gate nor block the start.
    const nowSpy = jest.spyOn(Date, 'now');
    let fakeNow = t0;
    nowSpy.mockImplementation(() => fakeNow);

    try {
      // A clean, known pre-ride odometer reading -- see pushBoardTelemetry's own doc
      // comment.
      pushBoardTelemetry(500);
      // Board starts moving (dp2 = 30 km/h) at t0 — above START_SPEED_KMH.
      pushBoardSpeed(30);
      // 4s later the board is still moving — the 3s sustain window is met from the BLE
      // stream alone. GPS samples also flow (below) but play no part in the start.
      fakeNow = t0 + 4000;
      pushBoardSpeed(30);

      // GPS samples above the 15 km/h threshold, sustained — they must NOT gate the
      // start (they no longer feed the machine while idle) and must not block it either.
      for (let i = 0; i <= 19; i++) {
        await tripRecorder.handleLocationSample(fakeSample(t0, i * 1000, 30 / 3.6));
      }

      // The trip must have started (state is no longer idle).
      expect(tripRecorder.getSnapshot().state).toBe('riding');
    } finally {
      nowSpy.mockRestore();
      await endTrip();
    }

    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
    const saved = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    expect(saved.wasManual).toBe(false);
  });

  it('does NOT auto-start when the board reports no speed, even though GPS shows speed', async () => {
    // The board is stationary (dp2 = 0) — board speed is the sole auto-start source, and
    // 0 km/h is below START_SPEED_KMH, so auto-start never fires no matter what GPS says.
    // Explicitly resetting board speed to 0 also clears any boardSpeedKmh left on the
    // shared singleton by the previous test.
    pushBoardSpeed(0);

    for (let i = 0; i <= 19; i++) {
      await tripRecorder.handleLocationSample(fakeSample(t0, i * 1000, 30 / 3.6));
    }

    expect(tripRecorder.getSnapshot().state).toBe('idle');
    expect(saveAndSyncTrip).not.toHaveBeenCalled();
  });

  // Real user report: the board was connected and moving >10 km/h, but
  // auto-start never fired. Root cause: the state machine was only ever fed from
  // handleLocationSample (the GPS watch callback), so if GPS samples weren't flowing
  // (the board never confirmed usable so the connection-gated idle watch never started,
  // background throttling, etc.) the board's wheel speed never reached the machine —
  // auto-start was silently gated behind GPS. Fix: feed the machine directly from the
  // BLE dp2 stream (feedBoardSpeedToMachine), decoupling the start decision from GPS.
  // This test pins that board speed ALONE — with zero handleLocationSample calls, i.e.
  // no GPS samples at all — auto-starts the trip.
  it('auto-starts from board speed alone, with NO GPS samples flowing', async () => {
    // feedBoardSpeedToMachine stamps samples with Date.now(), so control the clock to
    // drive the 3s sustain window without real delays. Real timers stay on so the
    // fire-and-forget async auto-start handler (GPS tier escalation, snapshot,
    // checkpoint) can actually resolve.
    const nowSpy = jest.spyOn(Date, 'now');
    let fakeNow = t0;
    nowSpy.mockImplementation(() => fakeNow);

    try {
      // A clean, known pre-ride odometer reading -- see pushBoardTelemetry's own doc
      // comment.
      pushBoardTelemetry(500);
      // Board starts moving (dp2 = 30 km/h) at t0 — above START_SPEED_KMH.
      pushBoardSpeed(30);
      // 4s later the board is still moving — the 3s sustain window is met purely from
      // the BLE stream. No handleLocationSample is ever called in this test.
      fakeNow = t0 + 4000;
      pushBoardSpeed(30);

      // Let the fire-and-forget async auto-start handler complete (it awaits the mocked
      // GPS-tier escalation, snapshot, and checkpoint) and emit the 'riding' snapshot.
      await new Promise((r) => setTimeout(r, 100));

      expect(tripRecorder.getSnapshot().state).toBe('riding');
    } finally {
      nowSpy.mockRestore();
      await endTrip();
    }
  });
});
