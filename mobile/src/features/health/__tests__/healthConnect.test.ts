// Weight-sync change-guard (code-review finding: weight-sync auto-trigger / scope creep).
// syncLatestWeightToBackend runs on every Settings mount + foreground return, so it must
// only PUT /auth/me/weight when the live Health Connect reading actually differs from the
// weight the backend already has (the caller's persisted session value). These tests pin
// that guard — the common "nothing changed" case must be a no-op, not a redundant write.

const mockPutWeight = jest.fn();

jest.mock('@/lib/api/auth', () => ({
  authApi: {
    putWeight: (...args: unknown[]) => mockPutWeight(...args),
  },
}));

jest.mock('@/lib/log', () => ({
  logEvent: jest.fn(),
  flushRemoteLog: jest.fn(),
}));

// react-native-health-connect is a native module; mock just the surface healthConnect.ts
// touches (weight path: getSdkStatus/initialize/readRecords; exercise-session write path:
// getGrantedPermissions/insertRecords/ExerciseType).
jest.mock('react-native-health-connect', () => ({
  getSdkStatus: jest.fn().mockResolvedValue(2), // SdkAvailabilityStatus.SDK_AVAILABLE
  initialize: jest.fn().mockResolvedValue(undefined),
  readRecords: jest.fn(),
  getGrantedPermissions: jest.fn(),
  insertRecords: jest.fn().mockResolvedValue(undefined),
  openHealthConnectSettings: jest.fn(),
  SdkAvailabilityStatus: { SDK_AVAILABLE: 2 },
  ExerciseType: { SKATING: 'skating' },
}));

import { getGrantedPermissions, insertRecords, readRecords } from 'react-native-health-connect';
import { invalidateWeightCache, syncLatestWeightToBackend, writeExerciseSessionForTrip } from '@/features/health/healthConnect';

/** A Health Connect Weight record at `time` with `kg`. */
const weightRecord = (kg: number, time: string) => ({
  time,
  weight: { inKilograms: kg },
});

/** Make readRecords resolve to a single latest weight of `kg`. */
const mockLatestWeight = (kg: number) => {
  (readRecords as jest.Mock).mockResolvedValue({
    records: [weightRecord(kg, '2026-09-01T10:00:00.000Z')],
  });
};

describe('syncLatestWeightToBackend change-guard (code-review finding)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // The weight read is cached to disk for a day, so without this each test would see
    // whatever the previous one cached rather than its own mocked reading.
    await invalidateWeightCache();
  });

  it('PUTs the live weight when it differs from the persisted backend weight', async () => {
    mockLatestWeight(82);
    mockPutWeight.mockResolvedValue({
      userId: 1,
      email: 'a@b.c',
      riderWeightKg: 82,
      riderWeightUpdatedAt: 'x',
      productFamilies: ['tynee'],
    });

    const me = await syncLatestWeightToBackend(75);

    expect(mockPutWeight).toHaveBeenCalledWith(82);
    expect(me?.riderWeightKg).toBe(82);
  });

  it('is a no-op (no PUT) when the live weight already matches the persisted weight', async () => {
    mockLatestWeight(82);

    const result = await syncLatestWeightToBackend(82);

    expect(mockPutWeight).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('PUTs when there is no persisted weight yet (first sync)', async () => {
    mockLatestWeight(82);
    mockPutWeight.mockResolvedValue({
      userId: 1,
      email: 'a@b.c',
      riderWeightKg: 82,
      riderWeightUpdatedAt: 'x',
      productFamilies: ['tynee'],
    });

    const me = await syncLatestWeightToBackend(null);

    expect(mockPutWeight).toHaveBeenCalledWith(82);
    expect(me?.riderWeightKg).toBe(82);
  });

  it('returns null (no PUT) when Health Connect has no weight reading', async () => {
    (readRecords as jest.Mock).mockResolvedValue({ records: [] });

    const result = await syncLatestWeightToBackend(75);

    expect(mockPutWeight).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('treats a tiny floating-point difference as "unchanged" (no PUT)', async () => {
    mockLatestWeight(82.0000001);

    const result = await syncLatestWeightToBackend(82);

    expect(mockPutWeight).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

// A tier handover keeps the outgoing watchPositionAsync subscription alive until the
// incoming one delivers its first sample (see tripRecorder/location.ts's subscribeWatch),
// so the assembled route isn't guaranteed strictly increasing by timestamp -- two
// subscriptions can briefly feed the same array. Health Connect rejects an out-of-order
// or duplicate-timestamp route; writeExerciseSessionForTrip now sorts and dedupes before
// handing the route to insertRecords.
describe('writeExerciseSessionForTrip route ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getGrantedPermissions as jest.Mock).mockResolvedValue([
      { accessType: 'write', recordType: 'ExerciseSession' },
      { accessType: 'write', recordType: 'ExerciseRoute' },
    ]);
  });

  function point(timestampMs: number, lat = 1, lon = 1) {
    return { lat, lon, timestampMs, speedKmh: 10, accuracyM: 5 };
  }

  it('sorts an out-of-order route before writing it', async () => {
    const start = new Date('2026-09-01T10:00:00.000Z');
    const end = new Date('2026-09-01T10:10:00.000Z');
    const route = [point(start.getTime() + 3000), point(start.getTime() + 1000), point(start.getTime() + 2000)];

    await writeExerciseSessionForTrip(start, end, 1.2, route);

    const written = (insertRecords as jest.Mock).mock.calls[0][0][0];
    const times = written.exerciseRoute.route.map((p: { time: string }) => new Date(p.time).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('drops duplicate/non-increasing timestamps instead of passing them through', async () => {
    const start = new Date('2026-09-01T10:00:00.000Z');
    const end = new Date('2026-09-01T10:10:00.000Z');
    const t0 = start.getTime() + 1000;
    const route = [point(t0), point(t0), point(t0 + 1000)];

    await writeExerciseSessionForTrip(start, end, 1.2, route);

    const written = (insertRecords as jest.Mock).mock.calls[0][0][0];
    expect(written.exerciseRoute.route).toHaveLength(2);
  });

  it('tags the session with a client record id so a second save of the same ride updates it', async () => {
    const start = new Date('2026-09-01T10:00:00.000Z');
    const end = new Date('2026-09-01T10:10:00.000Z');

    await writeExerciseSessionForTrip(start, end, 1.2, [point(start.getTime() + 1000), point(start.getTime() + 2000)], '1788256800');

    const written = (insertRecords as jest.Mock).mock.calls[0][0][0];
    expect(written.metadata).toEqual({ clientRecordId: 'cityroam-ride-1788256800', clientRecordVersion: 1 });
  });
});
