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
// hasStartedLocationUpdatesAsync must actually reflect start/stop calls — otherwise
// stopForegroundService's own "only stop if it's actually running" guard (location.ts)
// would see a permanently-false mock and never call stopLocationUpdatesAsync at all,
// which would make the disconnect test pass for the wrong reason (or not exercise the
// real guard) regardless of whether the fix works.
let mockForegroundServiceStarted = false;
jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3, BestForNavigation: 6 },
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  startLocationUpdatesAsync: jest.fn().mockImplementation(async () => {
    mockForegroundServiceStarted = true;
  }),
  stopLocationUpdatesAsync: jest.fn().mockImplementation(async () => {
    mockForegroundServiceStarted = false;
  }),
  hasStartedLocationUpdatesAsync: jest.fn().mockImplementation(async () => mockForegroundServiceStarted),
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));

// The "Turbo is tracking your location" notification (an Android OS requirement for
// the whole lifetime of the LOCATION_TASK_NAME foreground service) should only appear
// once a board is actually paired — not for a fresh install with nothing paired yet.
// This test drives that lifecycle end-to-end through the same connection-transition
// path a real autoConnect would use.
//
// Deliberately does NOT test "stops on disconnect" any more — that used to be real
// behavior, but caused a confirmed production bug: stopping the service every
// disconnect meant starting it fresh again on the next reconnect or trip auto-start,
// and Android 12+ refuses to start a *new* foreground service while the app is
// backgrounded (a board reconnecting, or a trip auto-starting from the board's own
// wheel speed, can both legitimately happen with the phone locked in a pocket).
// Without an active foreground service, Android's own background-location throttle
// then cuts GPS to a few fixes per hour, silently, for as long as the app stays
// backgrounded — confirmed against real production logs (~7 minutes of zero GPS
// samples on an otherwise-real ride). See ADR 0004 in docs/adr/. The service now
// starts once — proactively, at app launch, whenever a board is paired (see
// tripRecorder.ts's initAutoTracking) — and deliberately stays up for the rest of the
// process's lifetime; only the JS watch (tier/connection-gated as before) stops and
// starts.
let mockUsability: 'unpaired' | 'usable' = 'unpaired';
let mockPairedDeviceId: string | null = null;
let mockConnectionListener: ((event: { type: 'connected' | 'disconnected'; devId: string }) => void) | null = null;
jest.mock('@/features/device/deviceLink', () => ({
  ensureBleConnected: jest.fn(),
  refreshDeviceStatus: jest.fn().mockResolvedValue(undefined),
  getBleSnapshot: jest
    .fn()
    .mockResolvedValue({ online: false, speedKmh: null, batteryPct: null, mileageTotalKm: null, voltageV: null, mode: null }),
  getBoardUsability: jest.fn(() => mockUsability),
  onDevicePaired: jest.fn(() => () => {}),
  getPairedDeviceId: jest.fn(() => Promise.resolve(mockPairedDeviceId)),
  subscribeBleSession: jest.fn(() => () => {}),
  subscribeToBleConnectionTransitions: jest.fn((cb: (event: { type: 'connected' | 'disconnected'; devId: string }) => void) => {
    mockConnectionListener = cb;
    return () => {
      mockConnectionListener = null;
    };
  }),
}));

import * as Location from 'expo-location';
import { initAutoTracking, tripRecorder } from '@/features/rides/tripRecorder';

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

// The actual fix: the service must be running *before* the risky moment (a board
// reconnect or trip auto-start while backgrounded), not started reactively in
// response to it — so initAutoTracking (app launch, a guaranteed-foreground moment)
// starts it proactively itself, ahead of anything connection-gated tracking might do
// later. Separate describe block: exercises initAutoTracking directly rather than
// going through the connection-transition path the block below covers.
describe('initAutoTracking proactively starts the service at launch (ADR 0004)', () => {
  beforeEach(() => {
    mockForegroundServiceStarted = false;
    (Location.startLocationUpdatesAsync as jest.Mock).mockClear();
  });

  it('starts the foreground service at launch when a board is already paired', async () => {
    mockPairedDeviceId = 'dev-1';
    await initAutoTracking();
    await flush();

    expect(Location.startLocationUpdatesAsync).toHaveBeenCalled();
  });

  it('does not start the foreground service at launch when nothing is paired yet', async () => {
    mockPairedDeviceId = null;
    await initAutoTracking();
    await flush();

    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });
});

describe('foreground-service notification lifecycle', () => {
  it('does not start the foreground service at app launch when no board is connected', async () => {
    mockUsability = 'unpaired';
    mockPairedDeviceId = null;
    tripRecorder.startConnectionGatedTracking();
    await flush();

    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('starts the foreground service (and thus the notification) the moment the board connects', async () => {
    mockUsability = 'usable';
    mockConnectionListener?.({ type: 'connected', devId: 'dev-1' });
    await flush();

    expect(Location.startLocationUpdatesAsync).toHaveBeenCalled();
  });

  it('does NOT stop the foreground service when the board disconnects while idle (real bug, see ADR 0004)', async () => {
    mockUsability = 'unpaired';
    mockConnectionListener?.({ type: 'disconnected', devId: 'dev-1' });
    await flush();

    expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });
});
