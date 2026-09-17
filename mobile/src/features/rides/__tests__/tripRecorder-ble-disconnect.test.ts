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

let mockBleOffline = false;
// The board's odometer (dp12) advances as the trip progresses. Distance is the odometer
// delta (end − start) when the board is connected the whole trip (BOARD = telemetry /
// PHONE = GPS only), so the mock must return a *growing* mileageTotalKm across
// snapshot calls — a constant odometer would give a 0 km delta and the finished ride would
// be discarded. Each snapshot call advances the odometer by 0.5 km so that even the
// minimum start→end pair of reads (only a couple of snapshot polls happen in this short
// test) clears the 0.1 km discard floor with margin.
let mockMileageTotalKm = 500;
// Merged mock of the board-link module (formerly split across @/lib/tuyaBle +
// @/lib/tuyaBleSession). Capture the BLE session subscription callback so
// tests can push board dp2 speed in — auto-start is now driven by the board's wheel
// speed, so GPS-only samples no longer start a trip on their own.
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

// Push a board dp2 speed (raw, scale 1) through the captured BLE session subscription.
function pushBoardSpeed(speedKmh: number) {
  mockBleSessionListener?.({ dps: { '2': speedKmh * 10 } });
}

// Push the board's own passive dp12 (odometer, scale 1)/dp3 (battery, unscaled)
// telemetry -- the real production source for latestOdometerKm/latestBatteryPct (and,
// via seedStartTelemetry, odometerStartKm/batteryStartPct), which a ble_disconnect end
// now relies on instead of the (skipped) end snapshot. Without this, this mock's only
// source of odometer/battery is the active snapshot query (getBleSnapshot), which is
// not how a real board actually reports either -- getBleSnapshot's real implementation
// (deviceLink) only ever reflects the passive dp cache, and returns null telemetry
// outright once the board is confirmed offline.
//
// Deliberately independent of mockMileageTotalKm (the active-query counter): the record
// this feeds (tripRecorder's singleton) is NOT reset between tests -- only
// mockMileageTotalKm is (see beforeEach) -- so a value derived from that counter would
// silently ride on whatever the PREVIOUS test's ride left the counter at, rather than
// each test owning its own clean, known odometer baseline.
function pushBoardTelemetry(odometerKm: number, batteryPct: number) {
  mockBleSessionListener?.({ dps: { '12': Math.round(odometerKm * 10), '3': batteryPct } });
}

// turning the board off should end and save the trip on its own, even while
// the phone itself keeps reporting real-looking movement (walking away, being carried).
// BLE disconnect is the sole auto-stop mechanism — there is no speed-based
// stop timeout anymore, so a board that dies mid-ride must end the trip immediately.
describe('BLE-disconnect auto-end (issue #35)', () => {
  const t0 = Date.parse('2026-08-22T09:00:00Z');

  // Wire the recorder's BLE speed subscription ONCE (it's a singleton guarded by
  // bleSpeedTrackingStarted). startBleSpeedTracking resolves getPairedDeviceId()
  // asynchronously, so flush the microtask before any test pushes board speed —
  // otherwise the listener isn't registered yet.
  beforeAll(async () => {
    tripRecorder.startBleSpeedTracking();
    await new Promise((r) => setTimeout(r, 0));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockBleOffline = false;
    mockMileageTotalKm = 500;
  });

  async function driveToRiding() {
    // + auto-start is driven ONLY by the
    // board's wheel speed (dp2), fed DIRECTLY from the BLE stream (feedBoardSpeedToMachine)
    // — never by GPS samples (handleLocationSample no longer feeds the machine while
    // idle). So drive the 3s sustain window by pushing board speed across it; Date.now
    // controls the clock (feedBoardSpeedToMachine stamps samples with Date.now()).
    const nowSpy = jest.spyOn(Date, 'now');
    let fakeNow = t0;
    nowSpy.mockImplementation(() => fakeNow);
    try {
      // A clean, known pre-ride odometer/battery reading -- see pushBoardTelemetry's
      // own doc comment for why this can't be left to whatever a previous test's ride
      // happened to leave the record's rolling telemetry at.
      pushBoardTelemetry(500, 100);
      // Board starts moving (dp2 = 20 km/h) at t0 — above START_SPEED_KMH.
      pushBoardSpeed(20);
      // 4s later the board is still moving — the 3s sustain window is met from the BLE
      // stream alone, so the machine auto-starts.
      fakeNow = t0 + 4000;
      pushBoardSpeed(20);

      // GPS samples now flow while the trip is recording (state != idle) — they feed the
      // machine for the riding/stopped route-freeze distinction and the BLE-disconnect
      // auto-end, and drive the periodic snapshot cadence. Real timers (matching
      // tripRecorder-board-motion.test.ts): pollSnapshotAt's bounded settle/retry waits
      // are real setTimeout calls, so awaiting each sample lets them resolve naturally.
      for (let i = 0; i <= 30; i++) {
        await tripRecorder.handleLocationSample(fakeSample(t0, i * 1000, 20 / 3.6));
      }
      // auto_start's snapshotAt('start') call is fire-and-forget (see
      // feedBoardSpeedToMachine) and reads real Date.now() internally once it resolves
      // (tripRecord.ts's snapshotAt staleness guard) — the loop above can finish before
      // that settles if no periodic snapshot happened to land during it, so give it a
      // moment here while Date.now is still mocked, rather than letting the mock get
      // pulled out from under it mid-flight and misread a huge (real minus fake) delay
      // as a stale capture.
      await new Promise((resolve) => setTimeout(resolve, 700));
    } finally {
      nowSpy.mockRestore();
    }
  }

  // Hard requirement: there is no recording without the board connected
  // — a disconnect ends and saves the trip on the very next sample, no debounce.
  it('ends and saves the trip on the first offline sample, even while still "moving"', async () => {
    await driveToRiding();

    // Board telemetry doesn't depend on GPS (BOARD = telemetry / PHONE = GPS only) --
    // pushed here, after driveToRiding's own start-snapshot settle has already
    // resolved, so the eventual ble_disconnect end (which skips its own end snapshot,
    // see finishTrip) has a real, later odometer reading to diff the start baseline
    // (500, from driveToRiding's own pre-ride push) against, exactly as a real ride's
    // continuous dp12 pushes would.
    pushBoardTelemetry(501, 78);
    mockBleOffline = true;
    await tripRecorder.handleLocationSample(fakeSample(t0, 31_000, 20 / 3.6));

    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
    const saved = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    expect(saved.wasManual).toBe(false);
  });

  it('ends and saves the trip on a BLE disconnect even with no GPS samples flowing', async () => {
    // A BLE disconnect while a trip is active is fed straight into the state machine
    // (deviceOffline=true) to fire auto_end and finalize the trip — even when no GPS
    // samples are flowing (background throttling, a board that dropped mid-ride). This
    // drives the disconnect through handleBleConnectionTransition directly, with zero
    // handleLocationSample calls after the board-speed auto-start.
    const nowSpy = jest.spyOn(Date, 'now');
    let fakeNow = t0;
    nowSpy.mockImplementation(() => fakeNow);
    try {
      // A clean, known pre-ride odometer/battery reading -- see pushBoardTelemetry's
      // own doc comment.
      pushBoardTelemetry(500, 100);
      pushBoardSpeed(20);
      fakeNow = t0 + 4000;
      pushBoardSpeed(20);

      // Let the fire-and-forget auto_start handler reach 'riding' (its start snapshot
      // waits a real settle before reading the board) so the disconnect lands mid-trip.
      // Date.now stays mocked through this wait (restored only after), not right after
      // the pushes above -- a 'start' snapshotAt now measures staleness against the
      // real elapsed time since the trip's own (fake-clock) start timestamp (see
      // tripRecord.ts's snapshotAt), so letting the real clock resume before that
      // settle finishes would make the snapshot read as impossibly stale.
      await new Promise((r) => setTimeout(r, 1200));
    } finally {
      nowSpy.mockRestore();
    }
    expect(tripRecorder.getSnapshot().state).toBe('riding');

    // Board telemetry doesn't depend on GPS (BOARD = telemetry / PHONE = GPS only) --
    // pushed here, same as a real ride's continuous dp12 stream, so the eventual
    // ble_disconnect end (which skips its own end snapshot) has a real, later
    // odometer reading to diff the start baseline (500, pushed above) against.
    pushBoardTelemetry(501, 78);
    mockBleOffline = true;
    tripRecorder.handleBleConnectionTransition({ type: 'disconnected' });

    // The disconnect's auto_end finalize is fire-and-forget and its end snapshot waits a
    // real settle — give it time to save.
    await new Promise((r) => setTimeout(r, 1500));

    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
    const saved = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    expect(saved.wasManual).toBe(false);
  });
});
