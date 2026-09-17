jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));

// Minimal BoardSnapshot queue, same shape/mocking pattern as
// tripRecorder-snapshot-retry.test.ts, but driving createTripRecord() directly rather
// than the full TripRecorder singleton.
let mockSnapshotQueue: Record<string, unknown>[] = [];
jest.mock('@/features/device/deviceLink', () => ({
  refreshDeviceStatus: jest.fn().mockResolvedValue(undefined),
  getBleSnapshot: jest.fn(() => {
    const next = mockSnapshotQueue.shift() ?? {
      online: true,
      deviceName: 'Tynee',
      speedKmh: null,
      batteryPct: null,
      remoteBatteryPct: null,
      mileageOnceKm: null,
      mileageTotalKm: null,
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
}));

import { createTripRecord } from '@/features/rides/tripRecorder/tripRecord';

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    online: true,
    deviceName: 'Tynee',
    speedKmh: null,
    batteryPct: null,
    remoteBatteryPct: null,
    mileageOnceKm: null,
    mileageTotalKm: null,
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

describe('tripRecord', () => {
  beforeEach(() => {
    mockSnapshotQueue = [];
  });

  it('drops a snapshot that resolves after a newer trip has begun', async () => {
    const record = createTripRecord();
    record.begin(1000);
    mockSnapshotQueue = [makeSnapshot({ mode: 'level_3', voltageV: 50, speedKmh: 30, batteryPct: 40, mileageTotalKm: 900 })];
    const pending = record.snapshotAt(1000, 'start');

    record.begin(5_000_000);
    const result = await pending;

    expect(result).toBeNull();
    expect(record.modeSamples).toEqual([]);
    expect(record.voltageSamples).toEqual([]);
    expect(record.boardSpeedSamples).toEqual([]);
    expect(record.maxSpeedKmh).toBe(0);
  });

  describe('checkpointPayload()/collect() field-set consistency', () => {
    it('return the same field set, in sync with the record as it stands', () => {
      const record = createTripRecord();
      record.begin(1000);
      record.onGpsSample(
        { lat: 1, lon: 1, timestampMs: 1000, speedKmh: 10, accuracyM: 5 },
        { enteringStopped: false, leavingStopped: false, isStopped: false },
      );
      record.onBoardSpeed(15, 1000);

      const checkpoint = record.checkpointPayload();
      const collected = record.collect();

      // Same keys on both — writeCheckpoint and finalizeTrip must never silently drift
      // apart on what the record hands them.
      expect(Object.keys(checkpoint).sort()).toEqual(Object.keys(collected).sort());
      expect(checkpoint).toEqual(collected);

      // And the values are exactly the record's current live state.
      expect(checkpoint.route).toBe(record.route);
      expect(checkpoint.stops).toBe(record.stops);
      expect(checkpoint.modeSamples).toBe(record.modeSamples);
      expect(checkpoint.voltageSamples).toBe(record.voltageSamples);
      expect(checkpoint.boardSpeedSamples).toBe(record.boardSpeedSamples);
      expect(checkpoint.distanceKm).toBe(record.distanceKm);
      expect(checkpoint.maxSpeedKmh).toBe(record.maxSpeedKmh);
      expect(checkpoint.batteryStartPct).toBe(record.batteryStartPct);
      expect(checkpoint.odometerStartKm).toBe(record.odometerStartKm);
    });

    it('collect() reflects computeFinalDistance()s updated distanceKm', async () => {
      const record = createTripRecord();
      // A 'start' snapshotAt now measures staleness against the trip's real elapsed
      // time (Date.now() - timestampMs, see tripRecord.ts's own comment on why), so
      // timestampMs has to be a genuine near-"now" epoch value here, not an arbitrary
      // small literal, or the fixture itself reads as a ride that started decades ago.
      const tripStartMs = Date.now();
      record.begin(tripStartMs);
      mockSnapshotQueue = [makeSnapshot({ mileageTotalKm: 100, batteryPct: 90 })];
      await record.snapshotAt(tripStartMs, 'start');

      expect(record.odometerStartKm).toBe(100);

      const finalDistanceKm = record.computeFinalDistance({ odometerEndKm: 105 });
      expect(finalDistanceKm).toBe(5);
      expect(record.collect().distanceKm).toBe(5);
      expect(record.checkpointPayload().distanceKm).toBe(5);
    });
  });

  describe('distance integration via onBoardSpeed/snapshotAt', () => {
    it('onBoardSpeed updates live speed fields and thins the dp2 stream into boardSpeedSamples', () => {
      const record = createTripRecord();
      record.begin(0);
      // liveSpeedKmh() freezes lastBoardSpeedKmh through LIVE_SPEED_GRACE_MS measured
      // against Date.now(), so use real "now"-relative timestamps here (mirrors how
      // startBleSpeedTracking's real caller passes Date.now(), not the GPS sample clock).
      const now = Date.now();
      record.onBoardSpeed(10, now);
      expect(record.boardSpeedKmh).toBe(10);
      expect(record.maxSpeedKmh).toBe(10);
      expect(record.liveSpeedKmh()).toBe(10);

      record.onBoardSpeed(25, now + 1000);
      expect(record.boardSpeedKmh).toBe(25);
      expect(record.maxSpeedKmh).toBe(25);

      // A drop below the prior max doesn't lower maxSpeedKmh.
      record.onBoardSpeed(5, now + 2000);
      expect(record.boardSpeedKmh).toBe(5);
      expect(record.maxSpeedKmh).toBe(25);

      // The dp2 push stream is far denser than the snapshot poll, so onBoardSpeed thins
      // it into boardSpeedSamples at BOARD_SPEED_SAMPLE_MIN_INTERVAL_MS spacing — the
      // first sample lands, the ones within 5s of it don't. A single sample has no time
      // span to integrate over, so distanceKm stays 0 until a later sample arrives.
      expect(record.boardSpeedSamples).toEqual([{ timestampMs: now, speedKmh: 10 }]);
      expect(record.distanceKm).toBe(0);

      // A sample 5s+ after the last thinned one is appended and distance integrates.
      record.onBoardSpeed(36, now + 10_000);
      expect(record.boardSpeedSamples).toHaveLength(2);
      expect(record.distanceKm).toBeGreaterThan(0);
    });

    it('onBoardTelemetry folds the live dp12 odometer / dp3 battery into the rolling latest', () => {
      const record = createTripRecord();
      record.begin(0);
      expect(record.latestOdometerKm).toBeNull();
      expect(record.latestBatteryPct).toBeNull();

      record.onBoardTelemetry({ odometerKm: 748.7, batteryPct: 62 });
      expect(record.latestOdometerKm).toBe(748.7);
      expect(record.latestBatteryPct).toBe(62);

      // A later read replaces the rolling latest; nulls are ignored (don't clobber).
      record.onBoardTelemetry({ odometerKm: 749.2, batteryPct: null });
      expect(record.latestOdometerKm).toBe(749.2);
      expect(record.latestBatteryPct).toBe(62);

      // The rolling latest rides the checkpoint payload for recovery's end values.
      expect(record.checkpointPayload().latestOdometerKm).toBe(749.2);
      expect(record.checkpointPayload().latestBatteryPct).toBe(62);
    });

    it('snapshotAt integrates boardSpeedSamples into distanceKm via the trapezoid rule', async () => {
      const record = createTripRecord();
      record.begin(0);

      mockSnapshotQueue = [makeSnapshot({ speedKmh: 36, mode: 'ride', batteryPct: 80 })];
      await record.snapshotAt(0, 'start');
      expect(record.boardSpeedSamples).toEqual([{ timestampMs: 0, speedKmh: 36 }]);
      // A single sample has no time span to integrate over.
      expect(record.distanceKm).toBe(0);

      // 36 km/h held for 10s (10_000ms) -> 0.1 km, via the trapezoid rule over the two samples.
      mockSnapshotQueue = [makeSnapshot({ speedKmh: 36, mode: 'ride', batteryPct: 79 })];
      await record.snapshotAt(10_000, 'periodic');
      expect(record.boardSpeedSamples).toHaveLength(2);
      expect(record.distanceKm).toBeCloseTo(0.1, 6);
      expect(record.maxSpeedKmh).toBe(36);
    });

    it('snapshotAt re-queries when the first read has no fresh telemetry (H3)', async () => {
      const { getBleSnapshot } = jest.requireMock('@/features/device/deviceLink') as { getBleSnapshot: jest.Mock };
      getBleSnapshot.mockClear();
      const record = createTripRecord();
      // Same reasoning as the collect()/computeFinalDistance() test above: a 'start'
      // snapshotAt's staleness check now measures against this real timestamp.
      const tripStartMs = Date.now();
      record.begin(tripStartMs);

      mockSnapshotQueue = [
        makeSnapshot({ batteryPct: null, mileageTotalKm: null, mode: null, voltageV: null }),
        makeSnapshot({ batteryPct: 80, mileageTotalKm: 500, mode: 'drive', voltageV: 52 }),
      ];

      const snap = await record.snapshotAt(tripStartMs, 'start');
      expect(getBleSnapshot).toHaveBeenCalledTimes(2);
      expect(snap?.batteryPct).toBe(80);
      expect(record.batteryStartPct).toBe(80);
    });
  });

  describe('stop dedup via onGpsSample', () => {
    it('starts a pendingStop on enteringStopped and drops it if too short (MIN_STOP_DURATION_SEC)', () => {
      const record = createTripRecord();
      record.begin(0);

      record.onGpsSample(
        { lat: 1, lon: 1, timestampMs: 0, speedKmh: 0, accuracyM: 5 },
        { enteringStopped: true, leavingStopped: false, isStopped: true },
      );
      expect(record.pendingStop).toEqual({ lat: 1, lon: 1, startTimestampMs: 0 });
      // Frozen while stopped — no route point pushed.
      expect(record.route).toEqual([]);

      // Only 5s later — below the 20s floor, so leaving stopped drops it, not a stop.
      record.onGpsSample(
        { lat: 1.0001, lon: 1, timestampMs: 5_000, speedKmh: 12, accuracyM: 5 },
        { enteringStopped: false, leavingStopped: true, isStopped: false },
      );
      expect(record.pendingStop).toBeNull();
      expect(record.stops).toEqual([]);
      expect(record.route).toEqual([{ lat: 1.0001, lon: 1, timestampMs: 5_000, speedKmh: 12, accuracyM: 5 }]);
    });

    it('records a real stop once it clears MIN_STOP_DURATION_SEC, deduped to a single stop entry', () => {
      const record = createTripRecord();
      record.begin(0);

      record.onGpsSample(
        { lat: 2, lon: 2, timestampMs: 0, speedKmh: 0, accuracyM: 5 },
        { enteringStopped: true, leavingStopped: false, isStopped: true },
      );
      // 25s later, well above the 20s floor.
      record.onGpsSample(
        { lat: 2, lon: 2, timestampMs: 25_000, speedKmh: 15, accuracyM: 5 },
        { enteringStopped: false, leavingStopped: true, isStopped: false },
      );

      expect(record.stops).toEqual([{ lat: 2, lon: 2, startTimestampMs: 0, durationSec: 25 }]);
      expect(record.pendingStop).toBeNull();

      // A second stop/resume cycle appends exactly one more entry, not a duplicate of the first.
      record.onGpsSample(
        { lat: 3, lon: 3, timestampMs: 30_000, speedKmh: 0, accuracyM: 5 },
        { enteringStopped: true, leavingStopped: false, isStopped: true },
      );
      record.onGpsSample(
        { lat: 3, lon: 3, timestampMs: 55_000, speedKmh: 10, accuracyM: 5 },
        { enteringStopped: false, leavingStopped: true, isStopped: false },
      );
      expect(record.stops).toHaveLength(2);
      expect(record.stops[1]).toEqual({ lat: 3, lon: 3, startTimestampMs: 30_000, durationSec: 25 });
    });

    it('finalizeStopIfAny is idempotent once pendingStop is already cleared', () => {
      const record = createTripRecord();
      record.begin(0);
      record.finalizeStopIfAny(1000);
      expect(record.stops).toEqual([]);
    });
  });
});
