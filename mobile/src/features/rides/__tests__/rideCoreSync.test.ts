// Breaks a pre-existing require cycle (tripRecord.ts -> deviceLink ->
// backgroundSelfHeal.ts -> settings.ts -> tripRecorder.ts -> tripRecord.ts) that only
// bites when a test enters the graph through rideCoreSync.ts/tripRecord.ts directly
// rather than through tripRecorder.ts first — same fix tripRecord.test.ts already
// uses. Nothing in this file exercises live BLE, so an empty mock is safe.
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));
jest.mock('@/features/device/deviceLink', () => ({
  refreshDeviceStatus: jest.fn().mockResolvedValue(undefined),
  getBleSnapshot: jest.fn().mockResolvedValue({}),
}));
jest.mock('@/lib/api', () => ({
  api: { deleteInProgressTrip: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@/lib/db', () => ({
  clearTripCheckpoint: jest.fn().mockResolvedValue(undefined),
  hasQueuedTripNear: jest.fn().mockResolvedValue(false),
  hasQueuedTripOverlapping: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/features/health/healthConnect', () => ({
  fetchVitalsForTrip: jest.fn().mockResolvedValue({}),
  writeExerciseSessionForTrip: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/features/rides/tripSync', () => ({
  saveAndSyncTrip: jest.fn().mockResolvedValue({ localId: 1, synced: true }),
}));

import RideCoreNative, { type NativeRide } from '@modules/ride-core/src/RideCore';
import { findNativeRideToAdopt, getNativeTripData, syncNativeRides } from '@/features/rides/rideCoreSync';
import { saveAndSyncTrip } from '@/features/rides/tripSync';
import { writeExerciseSessionForTrip } from '@/features/health/healthConnect';
import { hasQueuedTripNear, hasQueuedTripOverlapping } from '@/lib/db';

const T0 = Date.parse('2026-09-12T09:00:00Z');

function makeRide(overrides: Partial<NativeRide> = {}): NativeRide {
  return {
    id: 7,
    devId: 'bf480bsvdisp7zzv',
    startMs: T0,
    endMs: null,
    state: 'open',
    wasManual: false,
    odoStartKm: 500,
    odoEndKm: null,
    batteryStartPct: 90,
    batteryEndPct: null,
    distanceKm: null,
    maxSpeedKmh: null,
    endReason: null,
    backendId: null,
    ...overrides,
  };
}

describe('getNativeTripData', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null when no native ride exists at all', () => {
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(null);
    jest.spyOn(RideCoreNative, 'listFinishedRides').mockReturnValue([]);

    expect(getNativeTripData(T0)).toBeNull();
  });

  it('converts the active ride’s GPS, mode, and voltage samples when its start time matches', () => {
    // Real regression this guards: a locked-phone ride's own JS snapshotAt('start'/
    // 'periodic') can capture zero mode/voltage samples (the periodic tick is a JS
    // timer Android suspends on screen lock) — RideService's dp handler writes both
    // on every BLE push regardless, so the native journal always has them.
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(makeRide({ id: 11, startMs: T0 }));
    jest.spyOn(RideCoreNative, 'listFinishedRides').mockReturnValue([]);
    jest.spyOn(RideCoreNative, 'getRideSamples').mockReturnValue({
      gps: [
        { tMs: T0, lat: 1, lon: 2, accM: 5, speedMs: 10, bearing: 90, altM: 12 },
        { tMs: T0 + 1000, lat: 1.001, lon: 2.001, accM: 4, speedMs: null, bearing: null, altM: null },
      ],
      board: [
        // `mode: '2'` is what the journal ACTUALLY stores — the bare enum index the
        // board sent, stringified. This fixture previously said 'level_2', a shape the
        // journal never produces, which is precisely why the raw-index bug shipped:
        // the test passed against data that didn't exist. Index 2 is dp14's third range
        // entry ('level_3'), i.e. Speed.
        { tMs: T0, speedKmh: 20, batteryPct: 90, voltageV: 57.2, mode: '2', odoKm: 500, rideTimeOnceS: 0, mileageOnceKm: 0 },
      ],
      events: [],
    });

    const result = getNativeTripData(T0);

    expect(result?.nativeRideId).toBe(11);
    expect(result?.route).toEqual([
      { lat: 1, lon: 2, timestampMs: T0, speedKmh: 36, accuracyM: 5 },
      { lat: 1.001, lon: 2.001, timestampMs: T0 + 1000, speedKmh: 0, accuracyM: 4 },
    ]);
    expect(result?.modeSamples).toEqual([{ timestampMs: T0, mode: 'speed', batteryPct: 90 }]);
    expect(result?.voltageSamples).toEqual([{ timestampMs: T0, voltage: 57.2 }]);
  });

  it('still decodes a journal row that already holds a resolved level label', () => {
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(makeRide({ id: 12, startMs: T0 }));
    jest.spyOn(RideCoreNative, 'listFinishedRides').mockReturnValue([]);
    jest.spyOn(RideCoreNative, 'getRideSamples').mockReturnValue({
      gps: [],
      board: [{ tMs: T0, speedKmh: 20, batteryPct: 90, voltageV: 57.2, mode: 'level_2', odoKm: 500, rideTimeOnceS: 0, mileageOnceKm: 0 }],
      events: [],
    });

    expect(getNativeTripData(T0)?.modeSamples).toEqual([{ timestampMs: T0, mode: 'ride', batteryPct: 90 }]);
  });

  it('matches a finished (not yet uploaded) ride when no ride is currently active', () => {
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(null);
    jest.spyOn(RideCoreNative, 'listFinishedRides').mockReturnValue([makeRide({ id: 22, startMs: T0, state: 'finished' })]);
    jest.spyOn(RideCoreNative, 'getRideSamples').mockReturnValue({ gps: [], board: [], events: [] });

    expect(getNativeTripData(T0)?.nativeRideId).toBe(22);
  });

  it('does not match a ride whose start time is too far from the JS trip', () => {
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(makeRide({ id: 33, startMs: T0 + 60_000 }));
    jest.spyOn(RideCoreNative, 'listFinishedRides').mockReturnValue([]);

    expect(getNativeTripData(T0)).toBeNull();
  });

  it('picks the closer of two candidate rides', () => {
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(makeRide({ id: 1, startMs: T0 + 8000 }));
    jest.spyOn(RideCoreNative, 'listFinishedRides').mockReturnValue([makeRide({ id: 2, startMs: T0 + 500 })]);
    jest.spyOn(RideCoreNative, 'getRideSamples').mockReturnValue({ gps: [], board: [], events: [] });

    expect(getNativeTripData(T0)?.nativeRideId).toBe(2);
  });

  it('returns null (not throwing) when the native module throws — e.g. a build without ride-core prebuilt', () => {
    jest.spyOn(RideCoreNative, 'getActiveRide').mockImplementation(() => {
      throw new Error('native module not found');
    });

    expect(getNativeTripData(T0)).toBeNull();
  });

  it('returns null (not throwing) when getRideSamples itself throws after a ride matched', () => {
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(makeRide({ id: 44, startMs: T0 }));
    jest.spyOn(RideCoreNative, 'listFinishedRides').mockReturnValue([]);
    jest.spyOn(RideCoreNative, 'getRideSamples').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(getNativeTripData(T0)).toBeNull();
  });

  it("never marks the matched ride uploaded — it must stay eligible for RideService's own reconnect-stitch window", () => {
    // Real regression this guards: marking a ride 'uploaded' the instant the live path
    // reads its route makes it invisible to RideService.kt's findStitchCandidateLocked
    // (which only reopens a 'finished' ride), so a same-second BLE reconnect well
    // within the stitch window would silently open a new native ride instead of
    // continuing this one.
    const spy = jest.spyOn(RideCoreNative, 'markRideUploaded');
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(makeRide({ id: 55, startMs: T0 }));
    jest.spyOn(RideCoreNative, 'listFinishedRides').mockReturnValue([]);
    jest.spyOn(RideCoreNative, 'getRideSamples').mockReturnValue({ gps: [], board: [], events: [] });

    getNativeTripData(T0);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('syncNativeRides', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function finishedRide(overrides: Partial<NativeRide> = {}): NativeRide {
    return makeRide({
      id: 1,
      state: 'finished',
      endMs: T0 + 60_000,
      distanceKm: 1.0,
      maxSpeedKmh: 20,
      odoEndKm: 501,
      batteryEndPct: 80,
      ...overrides,
    });
  }

  // Real bug this guards: app/_layout.tsx calls syncNativeRides() from its mount effect
  // AND from useAppForegroundEffect (which also fires once on mount, per its own
  // contract) — two calls a few ms apart both listed the same finished ride before
  // either marked it uploaded, so one native ride synced (and wrote to Health Connect)
  // 4 times over in production. A concurrent call must join the one already running
  // instead of re-listing the same rides.
  it('a concurrent call joins the in-flight run instead of re-processing the same rides', async () => {
    jest.spyOn(RideCoreNative, 'listFinishedRides').mockReturnValue([finishedRide()]);
    jest.spyOn(RideCoreNative, 'getRideSamples').mockReturnValue({ gps: [], board: [], events: [] });
    jest.spyOn(RideCoreNative, 'markRideUploaded').mockImplementation(() => {});

    const [a, b] = await Promise.all([syncNativeRides(), syncNativeRides()]);

    expect(a).toEqual({ attempted: 1, saved: 1 });
    expect(b).toEqual({ attempted: 1, saved: 1 });
    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
    expect(writeExerciseSessionForTrip).toHaveBeenCalledTimes(1);
    expect(RideCoreNative.markRideUploaded).toHaveBeenCalledTimes(1);
  });

  it('a later call (once the in-flight one resolves) runs again, independently', async () => {
    jest
      .spyOn(RideCoreNative, 'listFinishedRides')
      .mockReturnValueOnce([finishedRide({ id: 1 })])
      .mockReturnValueOnce([finishedRide({ id: 2 })]);
    jest.spyOn(RideCoreNative, 'getRideSamples').mockReturnValue({ gps: [], board: [], events: [] });
    jest.spyOn(RideCoreNative, 'markRideUploaded').mockImplementation(() => {});

    await syncNativeRides();
    await syncNativeRides();

    expect(saveAndSyncTrip).toHaveBeenCalledTimes(2);
  });

  it('marks a ride the live path already saved as uploaded without saving it again', async () => {
    jest.spyOn(RideCoreNative, 'listFinishedRides').mockReturnValue([finishedRide({ id: 19 })]);
    jest.spyOn(RideCoreNative, 'markRideUploaded').mockImplementation(() => {});
    (hasQueuedTripNear as jest.Mock).mockResolvedValueOnce(true);

    await syncNativeRides();

    expect(hasQueuedTripNear).toHaveBeenCalledWith(String(Math.round(T0 / 1000)));
    expect(saveAndSyncTrip).not.toHaveBeenCalled();
    expect(writeExerciseSessionForTrip).not.toHaveBeenCalled();
    expect(RideCoreNative.markRideUploaded).toHaveBeenCalledWith(19, null);
  });

  it('does not save a native ride that overlaps a trip the live path saved with a later start', async () => {
    const ride = finishedRide({ id: 20 });
    jest.spyOn(RideCoreNative, 'listFinishedRides').mockReturnValue([ride]);
    jest.spyOn(RideCoreNative, 'markRideUploaded').mockImplementation(() => {});
    (hasQueuedTripOverlapping as jest.Mock).mockResolvedValueOnce(true);

    await syncNativeRides();

    expect(hasQueuedTripOverlapping).toHaveBeenCalledWith(ride.startMs, ride.endMs);
    expect(saveAndSyncTrip).not.toHaveBeenCalled();
    expect(RideCoreNative.markRideUploaded).toHaveBeenCalledWith(20, null);
  });
});

// Real case: the app reopened mid-ride at 13:14 while RideService had been recording
// since 12:40. The JS trip started fresh, and the native ride was later saved as a
// second 22.4 km trip over the same stretch.
describe('findNativeRideToAdopt', () => {
  const appNoticedAt = T0 + 34 * 60_000;

  afterEach(() => {
    jest.restoreAllMocks();
    (hasQueuedTripNear as jest.Mock).mockResolvedValue(false);
  });

  it('adopts the native ride already in progress', async () => {
    const ride = makeRide({ startMs: T0 });
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(ride);
    jest.spyOn(RideCoreNative, 'getRideLastActivityMs').mockReturnValue(appNoticedAt - 2000);
    await expect(findNativeRideToAdopt(appNoticedAt)).resolves.toBe(ride);
  });

  it('adopts nothing when no native ride is open or it started later', async () => {
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(null);
    await expect(findNativeRideToAdopt(appNoticedAt)).resolves.toBeNull();
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(makeRide({ startMs: appNoticedAt + 1000 }));
    await expect(findNativeRideToAdopt(appNoticedAt)).resolves.toBeNull();
  });

  it('adopts nothing when a trip with that start is already saved (a stitched ride)', async () => {
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(makeRide({ startMs: T0 }));
    (hasQueuedTripNear as jest.Mock).mockResolvedValue(true);
    await expect(findNativeRideToAdopt(appNoticedAt)).resolves.toBeNull();
  });

  it('adopts nothing when the open native ride has gone quiet', async () => {
    jest.spyOn(RideCoreNative, 'getActiveRide').mockReturnValue(makeRide({ startMs: T0 }));
    jest.spyOn(RideCoreNative, 'getRideLastActivityMs').mockReturnValue(appNoticedAt - 30 * 60_000);
    await expect(findNativeRideToAdopt(appNoticedAt)).resolves.toBeNull();
  });
});
