jest.mock('@/lib/db', () => ({
  getBackendIdForLocal: jest.fn().mockResolvedValue(null),
  getTripCheckpoint: jest.fn(),
  clearTripCheckpoint: jest.fn().mockResolvedValue(undefined),
  saveTripCheckpoint: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/api', () => ({
  api: {
    getInProgressTrip: jest.fn(),
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

import { getTripCheckpoint, clearTripCheckpoint, type TripCheckpoint } from '@/lib/db';
import { api } from '@/lib/api';
import { saveAndSyncTrip } from '@/features/rides/tripSync';
import { recoverInterruptedTrip } from '@/features/rides/tripRecorder';

function makeCheckpoint(overrides: Partial<TripCheckpoint> = {}): TripCheckpoint {
  const tripStartMs = Date.parse('2026-08-22T09:00:00Z');
  return {
    tripStartMs,
    wasManual: true,
    route: [{ lat: 1, lon: 1, timestampMs: tripStartMs, speedKmh: 20 }],
    stops: [],
    modeSamples: [],
    voltageSamples: [],
    boardSpeedSamples: [],
    distanceKm: 2.5,
    maxSpeedKmh: 30,
    batteryStartPct: 80,
    odometerStartKm: 500,
    latestOdometerKm: null,
    latestBatteryPct: null,
    lastUpdateMs: tripStartMs + 5 * 60_000,
    ...overrides,
  };
}

describe('recoverInterruptedTrip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetNativeTripData.mockReturnValue(null);
  });

  it('saves the native journal route/mode/voltage instead of the checkpoint ones when a native ride matches', async () => {
    const checkpoint = makeCheckpoint();
    (getTripCheckpoint as jest.Mock).mockResolvedValue(checkpoint);
    const nativeRoute = [{ lat: 5, lon: 5, timestampMs: checkpoint.tripStartMs, speedKmh: 8, accuracyM: 3 }];
    const nativeModeSamples = [{ timestampMs: checkpoint.tripStartMs, mode: 'eco', batteryPct: 80 }];
    const nativeVoltageSamples = [{ timestampMs: checkpoint.tripStartMs, voltage: 57.2 }];
    mockGetNativeTripData.mockReturnValue({
      route: nativeRoute,
      modeSamples: nativeModeSamples,
      voltageSamples: nativeVoltageSamples,
      nativeRideId: 99,
    });

    await expect(recoverInterruptedTrip()).resolves.toBe(true);

    expect(mockGetNativeTripData).toHaveBeenCalledWith(checkpoint.tripStartMs);
    const saved = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    expect(saved.route).toEqual(nativeRoute);
    expect(saved.modeSamples).toEqual(nativeModeSamples);
    expect(saved.voltageSamples).toEqual(nativeVoltageSamples);
  });

  it('falls back to the checkpoint route/mode/voltage when no native ride matches', async () => {
    const checkpoint = makeCheckpoint({
      modeSamples: [{ timestampMs: 0, mode: 'ride' }],
      voltageSamples: [{ timestampMs: 0, voltage: 55 }],
    });
    (getTripCheckpoint as jest.Mock).mockResolvedValue(checkpoint);

    await expect(recoverInterruptedTrip()).resolves.toBe(true);

    const saved = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    expect(saved.route).toEqual(checkpoint.route);
    expect(saved.modeSamples).toEqual(checkpoint.modeSamples);
    expect(saved.voltageSamples).toEqual(checkpoint.voltageSamples);
  });

  it('returns false and clears nothing pending when there is no checkpoint anywhere', async () => {
    (getTripCheckpoint as jest.Mock).mockResolvedValue(null);
    (api.getInProgressTrip as jest.Mock).mockResolvedValue(null);

    await expect(recoverInterruptedTrip()).resolves.toBe(false);
    expect(saveAndSyncTrip).not.toHaveBeenCalled();
  });

  it('finalizes and saves a real interrupted trip from the local checkpoint', async () => {
    const checkpoint = makeCheckpoint();
    (getTripCheckpoint as jest.Mock).mockResolvedValue(checkpoint);

    await expect(recoverInterruptedTrip()).resolves.toBe(true);

    // The finalize tail now runs through the shared finalizeTrip module (its own
    // payload construction + batteryUsedPct/odometer math are covered in
    // tripFinalize.test.ts), so this only asserts the recorder-level contract:
    // a saved recovery persists and clears the checkpoint on both layers.
    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
    expect(clearTripCheckpoint).toHaveBeenCalled();
    expect(api.deleteInProgressTrip).toHaveBeenCalled();
  });

  it('uses the checkpoint rolling-latest odometer/battery as the recovered trip end values', async () => {
    // Recovery has no end-of-trip snapshot, but the checkpoint now carries the board's
    // rolling latest odometer (dp12) / battery (dp3) captured at the last checkpoint.
    // Those become odometerEndKm/batteryEndPct so the recovered ride keeps its real
    // odometer delta and end battery instead of nulling them out (which would drop the
    // odometer delta and force a board-speed-integration fallback for distance).
    const checkpoint = makeCheckpoint({
      odometerStartKm: 500,
      latestOdometerKm: 509.3,
      latestBatteryPct: 62,
    });
    (getTripCheckpoint as jest.Mock).mockResolvedValue(checkpoint);

    await expect(recoverInterruptedTrip()).resolves.toBe(true);

    const saved = (saveAndSyncTrip as jest.Mock).mock.calls[0][0];
    expect(saved.odometerEndKm).toBe(509.3);
    expect(saved.batteryEndPct).toBe(62);
  });

  it('falls back to the backend checkpoint when nothing is stored locally', async () => {
    (getTripCheckpoint as jest.Mock).mockResolvedValue(null);
    // A real new-format backend checkpoint carries the boardSpeedSamples time series
    // (BOARD = telemetry / PHONE = GPS only). Recovery has no end-of-trip
    // odometer snapshot, so distance is reconstructed from these board samples — the
    // board is the only distance source, never GPS. 20 km/h over the 4-minute span
    // integrates to ~1.3 km, which clears the discard guard for this auto trip.
    const tripStartMs = Date.parse('2026-08-22T09:00:00Z');
    const lastUpdateMs = Date.parse('2026-08-22T09:04:00Z');
    (api.getInProgressTrip as jest.Mock).mockResolvedValue({
      tripStartTime: new Date(tripStartMs).toISOString(),
      wasManual: false,
      distanceKm: 1.2,
      maxSpeedKmh: 22,
      batteryStartPct: 60,
      odometerStartKm: 400,
      route: [],
      stops: [],
      modeSamples: [],
      voltageSamples: [],
      boardSpeedSamples: [
        { timestampMs: tripStartMs, speedKmh: 20 },
        { timestampMs: tripStartMs + 60_000, speedKmh: 20 },
        { timestampMs: tripStartMs + 120_000, speedKmh: 20 },
        { timestampMs: tripStartMs + 180_000, speedKmh: 20 },
        { timestampMs: tripStartMs + 240_000, speedKmh: 20 },
      ],
      lastUpdateTime: new Date(lastUpdateMs).toISOString(),
    });

    await expect(recoverInterruptedTrip()).resolves.toBe(true);
    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
  });

  it('silently discards a checkpoint that looks like a misclick, not a real ride', async () => {
    // Real scenario this guards: startManual's immediate checkpoint write, killed
    // before any GPS sample ever advanced it — distance and elapsed time both ~0.
    const checkpoint = makeCheckpoint({ distanceKm: 0, lastUpdateMs: Date.parse('2026-08-22T09:00:00Z') });
    (getTripCheckpoint as jest.Mock).mockResolvedValue(checkpoint);

    await expect(recoverInterruptedTrip()).resolves.toBe(false);
    expect(saveAndSyncTrip).not.toHaveBeenCalled();
    // Still cleared — a discarded checkpoint must not linger and get recovered again.
    expect(clearTripCheckpoint).toHaveBeenCalled();
    expect(api.deleteInProgressTrip).toHaveBeenCalled();
  });

  it('keeps a real short ride that clears both the distance and duration floors', async () => {
    const tripStartMs = Date.parse('2026-08-22T09:00:00Z');
    const checkpoint = makeCheckpoint({ distanceKm: 0.3, tripStartMs, lastUpdateMs: tripStartMs + 30_000 });
    (getTripCheckpoint as jest.Mock).mockResolvedValue(checkpoint);

    await expect(recoverInterruptedTrip()).resolves.toBe(true);
    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
  });

  it('discards an AUTO recovered checkpoint that never actually moved, however long it ran', async () => {
    // Same bug shouldDiscardTrip's own tests cover: a long-running-but-zero-
    // distance auto checkpoint (GPS never got a fix) must not get saved just because
    // enough wall-clock time passed. (The manual counterpart — which the old recovery
    // path wrongly judged by this same auto rule — now saves; see the next test.)
    const tripStartMs = Date.parse('2026-08-22T09:00:00Z');
    const checkpoint = makeCheckpoint({ distanceKm: 0.02, wasManual: false, tripStartMs, lastUpdateMs: tripStartMs + 300_000 });
    (getTripCheckpoint as jest.Mock).mockResolvedValue(checkpoint);

    await expect(recoverInterruptedTrip()).resolves.toBe(false);
    expect(saveAndSyncTrip).not.toHaveBeenCalled();
  });

  it('saves a MANUAL zero-distance recovered checkpoint that ran long enough', async () => {
    // Deliberate behavior change: recovery now applies the wasManual-aware discard
    // rule (via the shared finalizeTrip module), so a long manual checkpoint is not
    // dropped purely on the distance floor the way the old recovery path did.
    const tripStartMs = Date.parse('2026-08-22T09:00:00Z');
    const checkpoint = makeCheckpoint({ distanceKm: 0, tripStartMs, lastUpdateMs: tripStartMs + 300_000 });
    (getTripCheckpoint as jest.Mock).mockResolvedValue(checkpoint);

    await expect(recoverInterruptedTrip()).resolves.toBe(true);
    expect(saveAndSyncTrip).toHaveBeenCalledTimes(1);
  });
});
