/** Accumulates the per-ride health metrics, summarized in one
 * line logged at finalize, instead of trying to reconstruct "did this ride actually
 * record properly" after the fact from a raw event log. Pure bookkeeping, no side
 * effects; the recorder owns calling reset()/record*()/summary() at the right points.
 *
 * Deliberately doesn't split dpPushCount into idle-vs-riding: reset() runs at trip
 * start, so this tracker's own window only ever begins once idle time is already
 * over — it is structurally incapable of measuring idle push cadence, whatever it
 * counted there was reporting an artifact of tracker timing, not the board's real
 * behavior. Also deliberately doesn't report a wake-lock state: nothing in the JS
 * capture path this tracker measures ever holds one (the native journal's own wake
 * lock is a separate recording path entirely). */

export type GpsFixSource = 'watch' | 'task';

export type RideHealthSummary = {
  gpsFixCountWatch: number;
  gpsFixCountTask: number;
  maxGpsGapMs: number;
  dpPushCount: number;
  maxDpGapMs: number;
  disconnectCount: number;
  reconnectLatenciesMs: number[];
  appStateTransitionCount: number;
};

export function createRideHealthTracker() {
  let gpsFixCountWatch = 0;
  let gpsFixCountTask = 0;
  let lastGpsFixAtMs = 0;
  let maxGpsGapMs = 0;

  let dpPushCount = 0;
  let lastDpPushAtMs = 0;
  let maxDpGapMs = 0;

  let disconnectCount = 0;
  let disconnectStartedAtMs = 0;
  let reconnectLatenciesMs: number[] = [];

  let appStateTransitionCount = 0;

  function reset(): void {
    gpsFixCountWatch = 0;
    gpsFixCountTask = 0;
    lastGpsFixAtMs = 0;
    maxGpsGapMs = 0;
    dpPushCount = 0;
    lastDpPushAtMs = 0;
    maxDpGapMs = 0;
    disconnectCount = 0;
    disconnectStartedAtMs = 0;
    reconnectLatenciesMs = [];
    appStateTransitionCount = 0;
  }

  function recordGpsFix(source: GpsFixSource, atMs: number = Date.now()): void {
    if (source === 'watch') gpsFixCountWatch++;
    else gpsFixCountTask++;
    if (lastGpsFixAtMs > 0) maxGpsGapMs = Math.max(maxGpsGapMs, atMs - lastGpsFixAtMs);
    lastGpsFixAtMs = atMs;
  }

  function recordDpPush(atMs: number = Date.now()): void {
    dpPushCount++;
    if (lastDpPushAtMs > 0) maxDpGapMs = Math.max(maxDpGapMs, atMs - lastDpPushAtMs);
    lastDpPushAtMs = atMs;
  }

  function recordDisconnect(atMs: number = Date.now()): void {
    disconnectCount++;
    disconnectStartedAtMs = atMs;
  }

  /** No-op if there's no matching disconnect in progress (a reconnect signal firing
   * outside a tracked ride, e.g. before the first disconnect of a fresh trip). */
  function recordReconnect(atMs: number = Date.now()): void {
    if (disconnectStartedAtMs === 0) return;
    reconnectLatenciesMs.push(atMs - disconnectStartedAtMs);
    disconnectStartedAtMs = 0;
  }

  function recordAppStateTransition(): void {
    appStateTransitionCount++;
  }

  function summary(): RideHealthSummary {
    return {
      gpsFixCountWatch,
      gpsFixCountTask,
      maxGpsGapMs,
      dpPushCount,
      maxDpGapMs,
      disconnectCount,
      reconnectLatenciesMs: [...reconnectLatenciesMs],
      appStateTransitionCount,
    };
  }

  return { reset, recordGpsFix, recordDpPush, recordDisconnect, recordReconnect, recordAppStateTransition, summary };
}

export type RideHealthTracker = ReturnType<typeof createRideHealthTracker>;
