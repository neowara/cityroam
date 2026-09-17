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
  hasStartedLocationUpdatesAsync: jest.fn().mockResolvedValue(false),
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));

// the native SDK's autoConnect can bring the board online before
// tripRecorder.startConnectionGatedTracking() ever subscribes to connection
// transitions (it's wired up behind two chained async steps in app/_layout.tsx's
// startup effect). subscribeToBleConnectionTransitions deliberately did NOT replay
// the last transition to a late subscriber (see connectionEvents.ts), so a
// 'connected' transition that already fired before the subscription existed used to
// be silently lost — the idle GPS watch never started, no location samples ever
// flowed, and the board's wheel speed never got a chance to drive auto-start. The
// fix makes the subscription replay the last transition on subscribe (mirroring
// liveLogTail.ts), so the watch starts even when the board is already connected but
// the recorder's one-shot getBoardUsability() check would have missed it.
//
// These mocks are made configurable so each test can control (a) whether the
// subscription replays a 'connected' event on subscribe, and (b) what the one-shot
// getBoardUsability() check returns — letting us prove which mechanism actually
// starts the watch in each window.
let mockReplayConnectedOnSubscribe = false;
let mockUsability: 'unpaired' | 'connecting' | 'usable' | 'charging' | 'offline' = 'usable';

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
  getBoardUsability: jest.fn(() => mockUsability),
  getPairedDeviceId: jest.fn().mockResolvedValue(null),
  subscribeBleSession: jest.fn(() => () => {}),
  subscribeToBleConnectionTransitions: jest.fn((cb: (event: { type: 'connected' | 'disconnected'; devId: string }) => void) => {
    if (mockReplayConnectedOnSubscribe) cb({ type: 'connected', devId: 'dev-1' });
    return () => {};
  }),
}));

import * as Location from 'expo-location';
import { tripRecorder } from '@/features/rides/tripRecorder';
import { stopLocationWatch } from '@/features/rides/tripRecorder/location';

describe('connection-gated idle GPS watch — startup race with autoConnect', () => {
  beforeEach(() => {
    mockReplayConnectedOnSubscribe = false;
    mockUsability = 'usable';
    (Location.watchPositionAsync as jest.Mock).mockClear();
    // tripRecorder is a module-level singleton and startConnectionGatedTracking() is
    // guarded by a private connectionGatedTrackingStarted flag (it's meant to run once
    // per app lifetime). Each test here needs to re-run that wiring with different mock
    // conditions, so reset the private flag between tests via the same `as unknown as`
    // private-access cast the rest of the suite uses (cf. auth.test.ts's __clear).
    (tripRecorder as unknown as { connectionGatedTrackingStarted: boolean }).connectionGatedTrackingStarted = false;
    // location.ts's watch state (locationWatchSubscription etc.) is also module-level and
    // persists across tests: once a test starts the watch, startLocationWatch no-ops on
    // the already-set subscription, so watchPositionAsync wouldn't be called again. Reset
    // it via the module's own public teardown so each test starts from a clean watch.
    stopLocationWatch();
  });

  it('starts the idle watch immediately if the board is already usable when tracking is wired up', async () => {
    tripRecorder.startConnectionGatedTracking();

    // startConnectionGatedTracking's handleBleConnectionTransition call is
    // fire-and-forget, and subscribeWatch (location.ts) now awaits
    // ensureForegroundServiceRunning's own hasStartedLocationUpdatesAsync check before
    // calling watchPositionAsync (the foreground-service
    // notification only starts lazily now, not unconditionally at app launch) — flush
    // that extra microtask hop before asserting.
    await new Promise((r) => setTimeout(r, 0));

    expect(Location.watchPositionAsync).toHaveBeenCalled();
  });

  it('starts the idle watch via the replayed connected transition even when the one-shot usability check misses', async () => {
    // The previously-broken window: the board connected before startConnectionGatedTracking
    // subscribed (so the subscription replays 'connected'), but at the moment of the
    // one-shot getBoardUsability() check the board is momentarily NOT 'usable' (e.g. still
    // 'connecting'). Before the replay fix, this left the watch never started with no future
    // transition to recover it. The replay must start the watch regardless of the check.
    mockReplayConnectedOnSubscribe = true;
    mockUsability = 'connecting';

    tripRecorder.startConnectionGatedTracking();

    await new Promise((r) => setTimeout(r, 0));

    expect(Location.watchPositionAsync).toHaveBeenCalled();
  });

  it('does not start the watch when the board is offline and no connected transition is replayed', async () => {
    // Sanity check: with the board offline (no replay, non-usable), the watch must NOT start.
    mockUsability = 'offline';

    tripRecorder.startConnectionGatedTracking();

    await new Promise((r) => setTimeout(r, 0));

    expect(Location.watchPositionAsync).not.toHaveBeenCalled();
  });
});
