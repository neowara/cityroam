/** Owns "is it time yet" for the two periodic actions a recording trip performs
 * (poll the board's snapshot, write a checkpoint) — pure, no native deps, so the
 * scheduling itself is unit-testable without driving the full sample handler. */

// Each snapshot actively queries the board first (see tripRecorder.ts's
// pollSnapshotAt) instead of just reading whatever's cached, so a shorter interval
// buys real additional resolution on mode/voltage samples per trip instead of just
// re-reading the same stale value more often. Not tightened all the way to GPS's
// ~3s cadence -- mode/voltage change on a slower timescale than position, and each
// poll costs a real BLE round trip.
const SNAPSHOT_POLL_INTERVAL_MS = 20_000;

// Local SQLite write (cheap), so more frequent than the Tuya poll; bounds ride loss on kill.
// Exported: tripRecorder's event-driven durability path (drivePeriodicWorkFromEvents)
// uses the same floor for its own checkpoint throttle.
export const CHECKPOINT_INTERVAL_MS = 60_000;

export type CadenceDecision = {
  snapshotDue: boolean;
  checkpointDue: boolean;
};

export class SamplingCadence {
  private lastSnapshotAtMs = 0;
  private lastCheckpointAtMs = 0;

  /** Called when a new trip starts — zeroes both timers the same way a fresh trip's
   * first sample always looks "due" (matches the pre-extraction behavior). */
  reset(): void {
    this.lastSnapshotAtMs = 0;
    this.lastCheckpointAtMs = 0;
  }

  /** Feed the current sample's timestamp; returns which periodic actions are due,
   * advancing that action's timer when it is. */
  tick(nowMs: number): CadenceDecision {
    const snapshotDue = nowMs - this.lastSnapshotAtMs >= SNAPSHOT_POLL_INTERVAL_MS;
    if (snapshotDue) this.lastSnapshotAtMs = nowMs;

    const checkpointDue = nowMs - this.lastCheckpointAtMs >= CHECKPOINT_INTERVAL_MS;
    if (checkpointDue) this.lastCheckpointAtMs = nowMs;

    return { snapshotDue, checkpointDue };
  }
}
