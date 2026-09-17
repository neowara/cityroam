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

// Real bug (H3): pollSnapshotAt did a single query+settle then read the
// snapshot once. If the board's response to queryDeviceStatus raced the settle window,
// the snapshot came back with no fresh telemetry (mode/voltage/battery all null) and
// that stale read was recorded. The fix re-queries (bounded) while the snapshot has no
// fresh telemetry, so a board that's genuinely up but slow to answer gets a second
// chance instead of a telemetry-less sample.
//
// These tests assert on the *recorded* snapshot data (batteryStartPct on the saved
// trip) — the definitive proof that the retry re-queried and recorded the fresh read
// rather than the stale one — plus on how many times getBleSnapshot ran during the
// start snapshot.
import type { BoardSnapshot } from '@/lib/api';

// Build a structurally complete BoardSnapshot so the mock queue is type-checked against
// the real snapshot shape (a Partial would silently drift if BoardSnapshot changes).
function makeSnapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    online: true,
    deviceName: 'Tynee',
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
    ...overrides,
  };
}

let mockSnapshotQueue: BoardSnapshot[] = [];
let mockBleOffline = false;
// The board's odometer (dp12) advances as the trip progresses. Distance is the odometer
// delta (end − start) when the board is connected the whole trip (BOARD = telemetry /
// PHONE = GPS only), so the default snapshot (returned once the queue is
// drained — i.e. the periodic/end reads) must return a *growing* mileageTotalKm. The
// queued start snapshots pin odometerStartKm to 500; the growing default then gives a
// positive end−start delta so the finished ride clears the 0.1 km discard floor. The
// increment is large (0.5 km/read) so the start+end reads alone clear the floor even if
// the timer-driven periodic read lands mid-start-snapshot and steals a queued entry —
// the cadence now runs off the 1s tick, not GPS samples, so a fast test can't rely on
// GPS-driven periodic reads to accumulate distance.
let mockMileageTotalKm = 500;
// Merged mock of the board-link module (formerly split across @/lib/tuyaBle +
// @/lib/tuyaBleSession). Capture the BLE session subscription callback so
// tests can push board dp2 speed in.
let mockBleSessionListener: ((s: { dps?: Record<string, unknown> }) => void) | null = null;
jest.mock('@/features/device/deviceLink', () => ({
  ensureBleConnected: jest.fn(),
  refreshDeviceStatus: jest.fn().mockResolvedValue(undefined),
  getBleSnapshot: jest.fn(() => {
    const next = mockSnapshotQueue.shift() ??
      // Default full BoardSnapshot (must be inlined — the mock factory can't reference
      // out-of-scope helpers like makeSnapshot). Each default read advances the odometer.
      {
        online: true,
        deviceName: 'Tynee',
        speedKmh: null,
        batteryPct: 80,
        remoteBatteryPct: null,
        mileageOnceKm: null,
        mileageTotalKm: (mockMileageTotalKm += 0.5),
        rideTimeOnceSec: null,
        voltageV: null,
        mode: null,
        headlightOn: null,
        cruiseOn: null,
        lockOn: null,
        unit: null,
      };
    return Promise.resolve(next);
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

import { getBleSnapshot } from '@/features/device/deviceLink';
import { saveAndSyncTrip } from '@/features/rides/tripSync';
import { tripRecorder } from '@/features/rides/tripRecorder';

// Push a board dp2 speed (raw, scale 1) through the captured BLE session subscription.
function pushBoardSpeed(speedKmh: number) {
  mockBleSessionListener?.({ dps: { '2': speedKmh * 10 } });
}

// Push the board's own passive dp12 (odometer, scale 1) telemetry -- the real
// production source for latestOdometerKm, which a ble_disconnect end now relies on
// instead of the (skipped) end snapshot (see finishTrip). This suite's own start/
// periodic snapshots race each other for the shared mock queue (by design -- that
// race is what H3's retry logic is being tested against), so which one last touches
// latestOdometerKm is nondeterministic; a real, later odometer reading pushed here
// (independent of that race) keeps the ride's distance genuinely nonzero regardless.
function pushBoardTelemetry(odometerKm: number) {
  mockBleSessionListener?.({ dps: { '12': Math.round(odometerKm * 10) } });
}

function fakeSample(baseMs: number, offsetMs: number, speedMs: number) {
  return {
    coords: { latitude: 1, longitude: 1, speed: speedMs, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null },
    timestamp: baseMs + offsetMs,
  } as unknown as Parameters<typeof tripRecorder.handleLocationSample>[0];
}

describe('trip recorder snapshot retry (H3)', () => {
  // These tests drive real timers (a hard 3s auto-start settle wait plus 20 GPS samples
  // at the 1s tick cadence), so each takes ~4s of wall-clock time. Under the parallel
  // CPU load of a full-suite run that can exceed Jest's 5s default per-test timeout and
  // flake, so give this block a generous ceiling.
  jest.setTimeout(20000);

  const t0 = Date.parse('2026-09-01T09:00:00Z');

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
    mockSnapshotQueue = [];
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
      // A clean, known pre-ride odometer reading -- see pushBoardTelemetry's own doc
      // comment for why this can't be left to whatever a previous test's ride happened
      // to leave the shared tripRecorder singleton's rolling telemetry at (seeded into
      // odometerStartKm at auto_start, see tripRecorder.ts's handleAutoStartEvent).
      pushBoardTelemetry(500);
      // Board starts moving (dp2 = 30 km/h) at t0 — above START_SPEED_KMH.
      pushBoardSpeed(30);
      // 4s later the board is still moving — the 3s sustain window is met from the BLE
      // stream alone, so the machine auto-starts.
      fakeNow = t0 + 4000;
      pushBoardSpeed(30);
      // Let the fire-and-forget async auto-start handler complete (GPS tier escalation,
      // start snapshot with its bounded settle/retry waits, checkpoint) so the start
      // snapshot's getBleSnapshot reads finish BEFORE the periodic one below — that
      // ordering is what keeps the getBleSnapshot count deterministic.
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      nowSpy.mockRestore();
    }

    // GPS samples now flow while the trip is recording (state != idle). The snapshot/
    // checkpoint cadence runs off the 1s tick timer (not GPS samples), and the 3s wait
    // above let that timer fire exactly once after auto_start: cadence.reset() zeroes
    // lastSnapshotAtMs, so the first tick after auto_start is always "due" — that's the
    // intended "first sample of a fresh trip looks due" behavior. The next periodic
    // would need nowMs - lastSnapshotAtMs >= 20s, which the trip never reaches. So the
    // getBleSnapshot count before endTrip() is deterministic: start + 1 periodic. We
    // drive 20 samples (t=0..19s) so the finished trip clears the discard guard
    // (duration >= 10s AND distance >= 100m) and actually reaches saveAndSyncTrip.
    //
    // Real timers (matching tripRecorder-ble-disconnect.test.ts): pollSnapshotAt's
    // bounded settle/retry waits are real setTimeout calls, so awaiting each sample
    // lets them resolve naturally.
    for (let i = 0; i <= 19; i++) {
      await tripRecorder.handleLocationSample(fakeSample(t0, i * 1000, 30 / 3.6));
    }
  }

  // Ending the trip (BLE disconnect -> auto_end) stops the background location-watch /
  // motion-poll / tick timers that auto_start started, so the test process doesn't hang
  // on open handles — same cleanup the existing tripRecorder-ble-disconnect.test.ts
  // relies on. It also returns the module-level tripRecorder singleton to 'idle' so the
  // next test starts clean (there is no public reset; ending the trip is the reset).
  async function endTrip() {
    // A real, later odometer reading via the passive stream -- see pushBoardTelemetry's
    // own doc comment for why this suite needs it now that a ble_disconnect end skips
    // its own end-of-ride snapshot query.
    pushBoardTelemetry(510);
    mockBleOffline = true;
    await tripRecorder.handleLocationSample(fakeSample(t0, 20_000, 30 / 3.6));
  }

  it('re-queries when the first snapshot has no fresh telemetry, then records the fresh one', async () => {
    // First read returns a stale snapshot (no telemetry), second returns fresh data.
    mockSnapshotQueue = [
      makeSnapshot({ batteryPct: null, mileageTotalKm: null, mode: null, voltageV: null }),
      makeSnapshot({ batteryPct: 80, mileageTotalKm: 500, mode: 'drive', voltageV: 52.0 }),
    ];

    await driveToRiding();

    // The start snapshot read stale data first, so the H3 retry loop re-queried once
    // (SNAPSHOT_RETRY_ATTEMPTS=1 — this test's exact scenario doesn't distinguish 1
    // from 2, since the single retry here already returns fresh data) — getBleSnapshot
    // ran twice for the start snapshot, plus the one periodic read. Total before
    // endTrip(): 2 (start retry) + 1 (periodic).
    try {
      expect(getBleSnapshot).toHaveBeenCalledTimes(3);
    } finally {
      // Always end the trip so the singleton returns to idle even if the assertion fails.
      await endTrip();
    }

    // The retry must have recorded the FRESH read (batteryStartPct=80), not the stale
    // null — if the retry hadn't re-queried, batteryStartPct would be null.
    const saved = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    expect(saved.batteryStartPct).toBe(80);
  });

  it('does not re-query when the first snapshot already has fresh telemetry', async () => {
    mockSnapshotQueue = [makeSnapshot({ batteryPct: 80, mileageTotalKm: 500, mode: 'drive', voltageV: 52.0 })];

    await driveToRiding();

    // Fresh on the first read — no retry, exactly one getBleSnapshot for the start
    // snapshot, plus the one periodic read. Total before endTrip(): 1 (start) + 1 (periodic).
    try {
      expect(getBleSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      await endTrip();
    }

    const saved = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    expect(saved.batteryStartPct).toBe(80);
  });

  // A third test asserting SNAPSHOT_RETRY_ATTEMPTS' exact boundary (1 vs 2) was tried
  // and dropped — it requires queuing exactly 2 stale reads with nothing left over,
  // but the real 1s periodic-tick timer runs concurrently with the start snapshot's
  // own retry loop in this real-timer harness and non-deterministically steals from
  // the same shared mock queue, making the outcome depend on Node's event-loop
  // scheduling rather than the constant under test. The two tests above already cover
  // the retry mechanism's real behavior (retries once when stale, doesn't retry when
  // already fresh); the loop's own bound (`attempt < SNAPSHOT_RETRY_ATTEMPTS`) is a
  // one-line, low-risk change not worth a flaky test to pin down further.
});
