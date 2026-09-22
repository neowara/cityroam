import { finalizeTrip, type FinalizeDeps, type FinalizeInput } from '@/features/rides/tripFinalize';
import { MIN_TRIP_DURATION_SEC, shouldDiscardTrip } from '@/features/rides/tripStateMachine';

const T0 = Date.parse('2026-08-22T09:00:00Z');

function makeInput(overrides: Partial<FinalizeInput> = {}): FinalizeInput {
  return {
    tripStartMs: T0,
    endMs: T0 + 5 * 60_000,
    wasManual: true,
    route: [{ lat: 1, lon: 1, timestampMs: T0, speedKmh: 20 }],
    stops: [],
    modeSamples: [],
    voltageSamples: [],
    boardSpeedSamples: [],
    distanceKm: 2.5,
    maxSpeedKmh: 30,
    batteryStartPct: 80,
    odometerStartKm: 500,
    batteryEndPct: 60,
    odometerEndKm: 500.5,
    ...overrides,
  };
}

/** Injected deps with jest.fn() defaults; the real (pure) shouldDiscardTrip is used by
 * default so the module's manual-aware discard behavior is exercised for real. */
function makeDeps(overrides: Partial<FinalizeDeps> = {}): FinalizeDeps {
  return {
    fetchVitals: jest.fn().mockResolvedValue({
      heartRateAvgBpm: 120,
      heartRateMaxBpm: 150,
      restingHeartRateBpm: 60,
      heartRateVariabilityMs: 40,
      steps: 100,
      weightKg: 70,
    }),
    writeExerciseSession: jest.fn().mockResolvedValue(undefined),
    saveAndSync: jest.fn().mockResolvedValue({ localId: 42, synced: true }),
    clearCheckpoints: jest.fn().mockResolvedValue(undefined),
    notifyTripSaved: jest.fn(),
    shouldDiscard: shouldDiscardTrip,
    ...overrides,
  };
}

describe('finalizeTrip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('saves a real trip, building the exact payload, and clears+notifies only after the save', async () => {
    const deps = makeDeps();

    const result = await finalizeTrip(makeInput(), deps);

    expect(result).toEqual({ outcome: 'saved', saved: { localId: 42, synced: true } });

    const saved = (deps.saveAndSync as jest.Mock).mock.calls[0][0];
    expect(saved.startTime).toBe(new Date(T0).toISOString());
    expect((deps.writeExerciseSession as jest.Mock).mock.calls[0][4]).toBe(saved.clientTripId);
    expect(saved.endTime).toBe(new Date(T0 + 5 * 60_000).toISOString());
    expect(saved.distanceKm).toBe(2.5);
    // 2.5 km over 300s = 30 km/h.
    expect(saved.avgSpeedKmh).toBe(30);
    expect(saved.maxSpeedKmh).toBe(30);
    expect(saved.durationSec).toBe(300);
    expect(saved.wasManual).toBe(true);
    expect(saved.batteryStartPct).toBe(80);
    expect(saved.batteryEndPct).toBe(60);
    expect(saved.batteryUsedPct).toBe(20);
    expect(saved.odometerStartKm).toBe(500);
    expect(saved.odometerEndKm).toBe(500.5);
    // Vitals spread through to the payload.
    expect(saved.heartRateAvgBpm).toBe(120);
    expect(saved.steps).toBe(100);
    // Route/stops/samples passthrough.
    expect(saved.route).toEqual([{ lat: 1, lon: 1, timestampMs: T0, speedKmh: 20 }]);
    expect(saved.stops).toEqual([]);
    expect(saved.modeSamples).toEqual([]);
    expect(saved.voltageSamples).toEqual([]);

    // Deliberate ordering: the checkpoint is only cleared AFTER the durable persist,
    // and the notify fires after that — never before.
    expect(deps.clearCheckpoints).toHaveBeenCalledTimes(1);
    expect(deps.notifyTripSaved).toHaveBeenCalledTimes(1);
    const saveCall = (deps.saveAndSync as jest.Mock).mock.invocationCallOrder[0];
    const clearCall = (deps.clearCheckpoints as jest.Mock).mock.invocationCallOrder[0];
    const notifyCall = (deps.notifyTripSaved as jest.Mock).mock.invocationCallOrder[0];
    expect(clearCall).toBeGreaterThan(saveCall);
    expect(notifyCall).toBeGreaterThan(clearCall);
  });

  it('notifies as soon as the trip is locally queued, before saveAndSync itself resolves', async () => {
    // the trips list only ever learned about a new trip once — after the
    // WHOLE saveAndSync call (local enqueue + network sync attempt) resolved. On a
    // fast/successful sync, the offline/local entry never had a chance to render before
    // the trip was already showing synced. The fix: finalizeTrip must pass a callback
    // to saveAndSync that notifyTripSaved fires as soon as the local enqueue succeeds,
    // distinctly earlier than the final notify after saveAndSync resolves.
    const notifyOrder: string[] = [];
    const deps = makeDeps({
      notifyTripSaved: jest.fn(() => {
        notifyOrder.push(notifyOrder.length === 0 ? 'early (locally queued)' : 'final (after save)');
      }),
      saveAndSync: jest.fn(async (_payload, onLocallyQueued) => {
        // Simulate the real ordering in tripSync.ts's saveAndSyncTrip: the queued
        // callback fires, THEN (only after further async work, i.e. the network
        // attempt) the promise itself resolves.
        onLocallyQueued?.(42);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { localId: 42, synced: true };
      }),
    });

    await finalizeTrip(makeInput(), deps);

    expect(deps.notifyTripSaved).toHaveBeenCalledTimes(2);
    expect(notifyOrder).toEqual(['early (locally queued)', 'final (after save)']);
  });

  it('computes batteryUsedPct/odometerEndKm as null when there is no end snapshot (recovery)', async () => {
    const deps = makeDeps();

    await finalizeTrip(makeInput({ batteryEndPct: null, odometerEndKm: null }), deps);

    const saved = (deps.saveAndSync as jest.Mock).mock.calls[0][0];
    expect(saved.batteryEndPct).toBeNull();
    expect(saved.batteryUsedPct).toBeNull();
    expect(saved.odometerEndKm).toBeNull();
  });

  it('discards a manual trip shorter than MIN_TRIP_DURATION_SEC and still clears the checkpoint', async () => {
    const deps = makeDeps();

    const result = await finalizeTrip(makeInput({ endMs: T0 + MIN_TRIP_DURATION_SEC * 1000 - 1 }), deps);

    expect(result).toEqual({ outcome: 'discarded', reason: 'too-short' });
    expect(deps.saveAndSync).not.toHaveBeenCalled();
    // A discarded checkpoint must not linger and get recovered again.
    expect(deps.clearCheckpoints).toHaveBeenCalledTimes(1);
    expect(deps.notifyTripSaved).not.toHaveBeenCalled();
  });

  it('discards an auto trip that never actually moved, however long it ran', async () => {
    // Real bug the old recovery path had: judged by the AUTO rule, so a
    // long-running-but-zero-distance checkpoint (GPS never got a fix) was dropped.
    const deps = makeDeps();

    const result = await finalizeTrip(makeInput({ wasManual: false, distanceKm: 0.02, endMs: T0 + 300_000 }), deps);

    expect(result).toEqual({ outcome: 'discarded', reason: 'too-little-distance' });
    expect(deps.saveAndSync).not.toHaveBeenCalled();
    expect(deps.clearCheckpoints).toHaveBeenCalledTimes(1);
    expect(deps.notifyTripSaved).not.toHaveBeenCalled();
  });

  it('SAVES a manual zero-distance ride that ran long enough — manual rule only enforces duration', async () => {
    // Deliberate behavior change: recovery now applies the wasManual-aware rule, so a
    // long manual ride is not discarded purely on the distance floor (the old recovery
    // path wrongly used the auto rule for manual checkpoints).
    const deps = makeDeps();

    const result = await finalizeTrip(makeInput({ distanceKm: 0, endMs: T0 + 300_000 }), deps);

    expect(result.outcome).toBe('saved');
    expect(deps.saveAndSync).toHaveBeenCalledTimes(1);
  });

  it('returns failed/vitals and touches nothing when the vitals read throws', async () => {
    const deps = makeDeps({ fetchVitals: jest.fn().mockRejectedValue(new Error('no health connect')) });

    const result = await finalizeTrip(makeInput(), deps);

    expect(result).toEqual({ outcome: 'failed', reason: 'vitals' });
    expect(deps.saveAndSync).not.toHaveBeenCalled();
    expect(deps.clearCheckpoints).not.toHaveBeenCalled();
    expect(deps.notifyTripSaved).not.toHaveBeenCalled();
  });

  it('returns failed/health-write and touches nothing when the workout write throws', async () => {
    const deps = makeDeps({ writeExerciseSession: jest.fn().mockRejectedValue(new Error('write denied')) });

    const result = await finalizeTrip(makeInput(), deps);

    expect(result).toEqual({ outcome: 'failed', reason: 'health-write' });
    expect(deps.saveAndSync).not.toHaveBeenCalled();
    expect(deps.clearCheckpoints).not.toHaveBeenCalled();
    expect(deps.notifyTripSaved).not.toHaveBeenCalled();
  });

  it('returns failed/sync and leaves the checkpoint in place when the save throws', async () => {
    const deps = makeDeps({ saveAndSync: jest.fn().mockRejectedValue(new Error('offline')) });

    const result = await finalizeTrip(makeInput(), deps);

    expect(result).toEqual({ outcome: 'failed', reason: 'sync' });
    // Deliberate: a failed save must NOT clear the checkpoint — a later retry can
    // recover the ride instead of losing it outright.
    expect(deps.clearCheckpoints).not.toHaveBeenCalled();
    expect(deps.notifyTripSaved).not.toHaveBeenCalled();
  });

  it('derives clientTripId from tripStartMs rounded to the nearest second', async () => {
    const deps = makeDeps();

    await finalizeTrip(makeInput(), deps);

    const saved = (deps.saveAndSync as jest.Mock).mock.calls[0][0];
    expect(saved.clientTripId).toBe(String(Math.round(T0 / 1000)));
  });

  it('gives the same clientTripId for two tripStartMs values a couple ms apart (JS vs native clock skew)', async () => {
    const deps = makeDeps();

    await finalizeTrip(makeInput({ tripStartMs: T0 }), deps);
    await finalizeTrip(makeInput({ tripStartMs: T0 + 2 }), deps);

    const [firstSaved, secondSaved] = (deps.saveAndSync as jest.Mock).mock.calls.map((call) => call[0]);
    expect(firstSaved.clientTripId).toBe(secondSaved.clientTripId);
  });
});
