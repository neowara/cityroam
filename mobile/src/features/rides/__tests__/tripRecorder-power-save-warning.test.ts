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

let mockBleOffline = false;
let mockMileageTotalKm = 500;
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

import DevicePowerNative from '@modules/device-power/src/DevicePower';
import * as tripNotifications from '@/features/rides/tripNotifications';
import { tripRecorder } from '@/features/rides/tripRecorder';

function pushBoardSpeed(speedKmh: number) {
  mockBleSessionListener?.({ dps: { '2': speedKmh * 10 } });
}

function pushBoardTelemetry(odometerKm: number) {
  mockBleSessionListener?.({ dps: { '12': Math.round(odometerKm * 10) } });
}

// Real gap this closes: Battery Saver's own screen-off location cutoff has no
// app-level exemption (getPowerSaveModeStatus's own doc), and the app used to only
// ever check for it once, at trip start — a phone that entered Battery Saver mid-ride
// (the reported case: a real ride clipped ~2.5 minutes of route) got no warning at
// all while backgrounded, since the dashboard's own live pill only helps a foregrounded
// rider. This drives the recorder's event-driven heartbeat (the same one the GPS-stall
// and disconnect watchdogs run on) and checks that a mid-ride flip to Battery Saver
// fires exactly one notifyTripLifecycle('power-save-warning') call, not a repeat every
// tick.
describe('power-save-warning notification', () => {
  const t0 = Date.parse('2026-09-13T16:00:00Z');

  beforeAll(async () => {
    tripRecorder.startBleSpeedTracking();
    await new Promise((r) => setTimeout(r, 0));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockBleOffline = false;
    mockMileageTotalKm = 500;
    DevicePowerNative.isPowerSaveModeOn = jest.fn(() => false);
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 1500));
  });

  /** Controls the mocked clock throughout, since drivePeriodicWorkFromEvents' own
   * heartbeat throttles on real elapsed `now` (`now - lastEventDrivenTickAtMs < 1000`) —
   * a frozen clock across pushes would make every push after the first look like it
   * landed in the same instant and get throttled away. */
  function makeClock(nowSpy: jest.SpyInstance, startAtMs: number) {
    let fakeNow = startAtMs;
    nowSpy.mockImplementation(() => fakeNow);
    return {
      advance(ms: number) {
        fakeNow += ms;
      },
    };
  }

  async function driveToRiding(clock: { advance(ms: number): void }) {
    pushBoardTelemetry(500);
    pushBoardSpeed(30);
    clock.advance(4000);
    pushBoardSpeed(30);
    await new Promise((r) => setTimeout(r, 100));
  }

  async function endTrip() {
    pushBoardTelemetry(510);
    mockBleOffline = true;
    await tripRecorder.handleLocationSample({
      coords: { latitude: 1, longitude: 1, speed: 0, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null },
      timestamp: t0 + 20_000,
    } as unknown as Parameters<typeof tripRecorder.handleLocationSample>[0]);
  }

  it('notifies once when Battery Saver turns on mid-ride, not at every subsequent tick', async () => {
    const notifySpy = jest.spyOn(tripNotifications, 'notifyTripLifecycle').mockResolvedValue(undefined);
    const nowSpy = jest.spyOn(Date, 'now');
    const clock = makeClock(nowSpy, t0);

    try {
      await driveToRiding(clock);
      expect(tripRecorder.getSnapshot().state).toBe('riding');
      // Not yet on.
      expect(notifySpy).not.toHaveBeenCalledWith('power-save-warning');

      DevicePowerNative.isPowerSaveModeOn = jest.fn(() => true);
      // Two more board pushes, each on its own real tick — the event-driven watchdog
      // throttles on real elapsed time (see makeClock), so advancing the mocked clock
      // alone isn't enough; each push also needs its own real setTimeout gap.
      clock.advance(2000);
      pushBoardSpeed(30);
      await new Promise((r) => setTimeout(r, 1100));
      clock.advance(2000);
      pushBoardSpeed(30);
      await new Promise((r) => setTimeout(r, 50));

      const calls = notifySpy.mock.calls.filter(([kind]) => kind === 'power-save-warning');
      expect(calls).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
      await endTrip();
      notifySpy.mockRestore();
    }
  });

  it('does not notify at all when Battery Saver never turns on', async () => {
    const notifySpy = jest.spyOn(tripNotifications, 'notifyTripLifecycle').mockResolvedValue(undefined);
    const nowSpy = jest.spyOn(Date, 'now');
    const clock = makeClock(nowSpy, t0);

    try {
      await driveToRiding(clock);
      clock.advance(2000);
      pushBoardSpeed(30);
      await new Promise((r) => setTimeout(r, 100));

      expect(notifySpy).not.toHaveBeenCalledWith('power-save-warning');
    } finally {
      nowSpy.mockRestore();
      await endTrip();
      notifySpy.mockRestore();
    }
  });
});
