// Regression coverage for the stalled-start-snapshot fallback: the 'start' snapshot is
// an active BLE query whose own bounds are JS timers — with the phone locked those
// timers pause, and a real ride recorded a start snapshot 88s after it was requested.
// A too-late (or telemetry-less) start reading used to leave odometerStartKm AND
// batteryStartPct null for the whole trip: no "Odometer start" tile, no "% used", no
// Efficiency (%/km). The record now remembers the first dp12/dp3 the live BLE stream
// pushed and falls back to those.
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));

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

describe('tripRecord — start telemetry falls back to the first live-stream dp12/dp3', () => {
  let nowSpy: jest.SpyInstance;

  afterEach(() => {
    nowSpy?.mockRestore();
    // Test 1 swaps in a time-advancing getBleSnapshot implementation; restore the
    // queue-based default so later tests don't inherit it.
    const { getBleSnapshot } = jest.requireMock('@/features/device/deviceLink') as { getBleSnapshot: jest.Mock };
    getBleSnapshot.mockImplementation(() => {
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
    });
    mockSnapshotQueue = [];
  });

  it('a start snapshot arriving past STALE_START_SNAPSHOT_MS falls back to first-seen telemetry', async () => {
    let fakeNow = 50_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    // The snapshot's read answers 88s of wall clock after snapshotAt captured its
    // calledAtMs — the read is where the stalled query's latency lands.
    const { getBleSnapshot } = jest.requireMock('@/features/device/deviceLink') as { getBleSnapshot: jest.Mock };
    getBleSnapshot.mockImplementation(() => {
      fakeNow += 88_000;
      return Promise.resolve(makeSnapshot({ mileageTotalKm: 79.35, batteryPct: 91 }));
    });

    const record = createTripRecord();
    record.begin(fakeNow);
    // The board pushed dp12/dp3 on its own well before any query landed.
    record.onBoardTelemetry({ odometerKm: 79.21, batteryPct: 95 });

    await record.snapshotAt(fakeNow, 'start');

    expect(record.odometerStartKm).toBe(79.21);
    expect(record.batteryStartPct).toBe(95);
    // The late snapshot's values still become the rolling latest (recovery's end values).
    expect(record.latestOdometerKm).toBe(79.35);
    expect(record.latestBatteryPct).toBe(91);
  });

  it('a trusted but telemetry-less start snapshot does not clobber first-seen values', async () => {
    // A 'start' snapshotAt now measures staleness against Date.now() - timestampMs (see
    // tripRecord.ts's own comment) -- timestampMs=0 needs Date.now() pinned to match, or
    // every read here reads as impossibly stale regardless of what's under test.
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => 0);

    const record = createTripRecord();
    record.begin(0);
    record.onBoardTelemetry({ odometerKm: 10.5, batteryPct: 80 });

    // Arrives fast (trusted) but the cached dps had no dp3/dp12 yet.
    mockSnapshotQueue = [makeSnapshot({})];
    await record.snapshotAt(0, 'start');

    expect(record.odometerStartKm).toBe(10.5);
    expect(record.batteryStartPct).toBe(80);
  });

  it('a fresh start snapshot with real values still wins over first-seen', async () => {
    // Same reasoning as the test above -- Date.now() pinned to match timestampMs=0 so
    // this snapshot reads as genuinely fresh, which is the exact scenario under test.
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => 0);

    const record = createTripRecord();
    record.begin(0);
    record.onBoardTelemetry({ odometerKm: 10.5, batteryPct: 80 });

    mockSnapshotQueue = [makeSnapshot({ mileageTotalKm: 10.5, batteryPct: 79 })];
    await record.snapshotAt(0, 'start');

    expect(record.odometerStartKm).toBe(10.5);
    expect(record.batteryStartPct).toBe(79);
  });
});
