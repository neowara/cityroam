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
jest.mock('@/features/rides/rideCoreSync', () => ({
  getNativeTripData: jest.fn().mockReturnValue(null),
}));
jest.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6 },
  startLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  hasStartedLocationUpdatesAsync: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));

let mockBleOffline = false;
let mockBleSessionListener: ((s: { dps?: Record<string, unknown> }) => void) | null = null;
// The very first getBleSnapshot call (ride 1's own 'start' snapshot) never resolves —
// simulating Android suspending the JS timers its own internal bounded waits rely on
// once the phone screen locks, exactly like the real ride that surfaced this bug (a
// start snapshot that only resolved ~28 minutes later, once the app foregrounded
// again). Every later call resolves normally, so ride 2 can complete cleanly.
let mockGetBleSnapshotCallCount = 0;
jest.mock('@/features/device/deviceLink', () => ({
  ensureBleConnected: jest.fn(),
  refreshDeviceStatus: jest.fn().mockResolvedValue(undefined),
  getBleSnapshot: jest.fn().mockImplementation(() => {
    mockGetBleSnapshotCallCount++;
    if (mockGetBleSnapshotCallCount === 1) return new Promise(() => {});
    return Promise.resolve({ batteryPct: 80, mileageTotalKm: 500, mode: null, voltageV: null });
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

import { tripRecorder } from '@/features/rides/tripRecorder';

function pushBoardSpeed(speedKmh: number) {
  mockBleSessionListener?.({ dps: { '2': speedKmh * 10 } });
}

function fakeSample(timestampMs: number, speedMs: number) {
  return {
    coords: { latitude: 1, longitude: 1, speed: speedMs, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null },
    timestamp: timestampMs,
  } as unknown as Parameters<typeof tripRecorder.handleLocationSample>[0];
}

// Real production bug: a ride's own auto_start left handleAutoStartEvent
// stuck awaiting a board snapshot that never resolved (the same JS-timer-suspension
// class of bug PERIODIC_RUN_STUCK_MS already guards against for the periodic tick).
// autoStartInFlight then stayed true for the rest of the app session, silently
// dropping every later real auto_start — the pure TripStateMachine still flipped to
// 'riding' regardless, so the NEXT ble_disconnect finalized one trip spanning both
// real rides under the first one's stale tripStartMs, and the backend's clientTripId
// dedup silently discarded the second (much larger, real) ride's actual data.
describe('a stuck handleAutoStartEvent does not swallow the next real auto_start', () => {
  const t0 = Date.parse('2026-09-12T14:00:00Z');
  // Each test that leaves a ride-1 auto_start permanently stuck (its own mocked
  // getBleSnapshot promise never resolves, matching the bug) leaves
  // autoStartInFlightSinceMs pointing at ITS OWN start time forever — the recorder
  // singleton isn't reset between tests in this file. A big, fixed gap per test
  // keeps that leftover trivially >= AUTO_START_STUCK_MS stale by the time the next
  // test's own clock starts, rather than the two tests' timelines coincidentally
  // overlapping just because they'd otherwise share the same t0.
  const T0_GAP_MS = 10_000_000;

  beforeAll(async () => {
    tripRecorder.startBleSpeedTracking();
    await new Promise((r) => setTimeout(r, 0));
  });

  beforeEach(() => {
    mockBleOffline = false;
    mockGetBleSnapshotCallCount = 0;
  });

  // Runs first (declaration order), while the singleton recorder is still in its
  // pristine post-beforeAll state — its own trailing disconnect leaves the recorder
  // idle again for whichever test runs next, since it isn't reset between tests in
  // this same file.
  it('lets a manual start proceed too, once the stuck auto-start is past the deadline', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    let fakeNow = t0;
    nowSpy.mockImplementation(() => fakeNow);
    try {
      // Ride 1 auto-starts and gets stuck the same way — nothing about a manual start
      // is what got the flag stuck, but it must not stay blocked forever either: the
      // only thing that ever clears or bypasses autoStartInFlight is this same
      // staleness check, wherever it's read.
      pushBoardSpeed(20);
      fakeNow = t0 + 4000;
      pushBoardSpeed(20);
      await new Promise((r) => setTimeout(r, 50));
      expect(tripRecorder.getSnapshot().state).toBe('riding');

      mockBleOffline = true;
      await tripRecorder.handleLocationSample(fakeSample(fakeNow, 0));
      mockBleOffline = false;

      fakeNow = t0 + 4000 + 40_000;
      const started = await tripRecorder.startManual();

      expect(started).toBe(true);
      expect(tripRecorder.getSnapshot().tripStartEpochMs).toBe(fakeNow);
      expect(tripRecorder.getSnapshot().state).toBe('manual');

      // Leave the recorder idle for the next test — a manual trip only ends on a
      // disconnect or an explicit finish, never on its own.
      mockBleOffline = true;
      await tripRecorder.handleLocationSample(fakeSample(fakeNow, 0));
      mockBleOffline = false;
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('lets a second auto_start proceed with a fresh start time once the first has been stuck past the deadline', async () => {
    // A later, far-separated base — see T0_GAP_MS's own comment.
    const t1 = t0 + T0_GAP_MS;
    const nowSpy = jest.spyOn(Date, 'now');
    let fakeNow = t1;
    nowSpy.mockImplementation(() => fakeNow);
    try {
      // Ride 1 auto-starts; its own snapshotAt('start') call hangs forever (see the
      // getBleSnapshot mock above) — autoStartInFlight is now stuck true.
      pushBoardSpeed(20);
      fakeNow = t1 + 4000;
      pushBoardSpeed(20);
      await new Promise((r) => setTimeout(r, 50));
      expect(tripRecorder.getSnapshot().tripStartEpochMs).toBe(t1 + 4000);

      // The board drops mid-ride-1 (BLE disconnect ends it, matching the real ride —
      // this path is independent of autoStartInFlight, so it correctly resets the
      // pure TripStateMachine to 'idle' even with ride 1's own handleAutoStartEvent
      // still stuck) and reconnects — a fresh ride begins well past
      // AUTO_START_STUCK_MS later. handleAutoStartEvent's own guard treats the
      // still-in-flight ride-1 call as stale past this deadline, rather than silently
      // dropping the real ride 2 start.
      mockBleOffline = true;
      await tripRecorder.handleLocationSample(fakeSample(fakeNow, 0));
      mockBleOffline = false;

      fakeNow = t1 + 4000 + 40_000;
      pushBoardSpeed(20);
      fakeNow = t1 + 4000 + 44_000;
      pushBoardSpeed(20);
      await new Promise((r) => setTimeout(r, 50));

      expect(tripRecorder.getSnapshot().tripStartEpochMs).toBe(t1 + 4000 + 44_000);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
