// subscribeWatch (lib/tripRecorder/location.ts) mutates module-level state
// with no concurrency guard. Two overlapping tier-escalation calls — e.g. auto_start's
// 'active' escalation racing ensureLocationTrackingAlive's unconditional
// restartLocationWatch self-heal around the same foreground-return moment — could each
// read locationWatchSubscription as the same stale "outgoing" before either resolved
// its own (possibly minutes-long) Location.watchPositionAsync call. Whichever resolved
// *second* silently overwrote locationWatchSubscription, orphaning the first call's
// subscription: still alive, still calling onSample on every fix, referenced by
// nothing, so nothing — not even stopLocationWatch at trip end — could ever remove it.

jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3, BestForNavigation: 6 },
  startLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  hasStartedLocationUpdatesAsync: jest.fn().mockResolvedValue(true),
  watchPositionAsync: jest.fn(),
}));
jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));

import * as Location from 'expo-location';
import { restartLocationWatch, setLocationWatchTier, startLocationWatch, stopLocationWatch } from '@/features/rides/tripRecorder/location';

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i++) {
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
  }
  if (!predicate()) throw new Error('waitFor: condition never became true');
}

describe('subscribeWatch handover race (generation guard)', () => {
  afterEach(() => {
    stopLocationWatch();
    jest.clearAllMocks();
  });

  it("a stale call's subscription is torn down instead of overwriting a newer call's, when it resolves later", async () => {
    const onSample = jest.fn();
    const mockWatch = Location.watchPositionAsync as jest.Mock;
    const resolvers: ((v: { remove: () => void }) => void)[] = [];
    mockWatch.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));

    const initial = startLocationWatch(onSample, 'idle');
    await waitFor(() => resolvers.length === 1);
    resolvers[0]({ remove: jest.fn() });
    await initial;

    // Call A: the normal 'active' escalation (e.g. auto_start). Starts first.
    const callA = setLocationWatchTier('active');
    await waitFor(() => resolvers.length === 2);
    // Call B: the unconditional self-heal restart, racing in behind it (bypasses the
    // tier-equality no-op every other caller respects).
    const callB = restartLocationWatch(onSample, 'active');
    await waitFor(() => resolvers.length === 3);

    const removeA = jest.fn();
    const removeB = jest.fn();
    // B resolves first even though it was requested second — the exact out-of-order
    // case that used to corrupt state.
    resolvers[2]({ remove: removeB });
    await callB;
    resolvers[1]({ remove: removeA });
    await callA;

    // A lost the race: its subscription must be torn down immediately, not installed
    // as the current one and not left dangling.
    expect(removeA).toHaveBeenCalledTimes(1);
    // B won and is still the live subscription — untouched by A's resolution.
    expect(removeB).not.toHaveBeenCalled();

    // A real sample delivered on B's subscription must still reach onSample exactly
    // once (not doubled by a second live subscription A left running).
    const watchCallback = mockWatch.mock.calls[2][1];
    watchCallback({ coords: { latitude: 1, longitude: 1 }, timestamp: Date.now() });
    expect(onSample).toHaveBeenCalledTimes(1);
  });
});
