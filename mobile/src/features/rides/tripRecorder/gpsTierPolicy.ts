/**
 * The single place that answers "given this event, what should the GPS watch tier be
 * doing right now?"
 *
 * This module owns the DECISION; tripRecorder.ts owns executing it via the existing
 * mechanisms in ./location.ts (which are untouched — this is purely the decision, not
 * the mechanism).
 *
 * Architecture (Option 1 — full connection-gated idle strategy): PHONE = GPS only,
 * DEVICE = telemetry. The GPS watch is gated on the board being connected — there is
 * no continuous GPS watch and no motion-activity polling while idle. When the board
 * connects, the watch starts at the low-power 'idle' tier so location samples are
 * already flowing the moment the rider starts moving; the board's own wheel speed
 * (dp2) then drives auto-start through the state machine, which escalates the watch to
 * the 'active' tier. When the board disconnects (or a trip ends with the board gone),
 * the watch stops — no GPS cost while there's no board to ride.
 *
 * Pure and side-effect free by design: no expo-location calls, no TripStateMachine
 * mutation, nothing async. That's what makes it directly unit-testable without driving
 * the whole recorder through a fake location-sample loop.
 */

import type { LocationWatchTier } from '@/features/rides/tripRecorder/location';

/** How tripRecorder.ts should change the running location watch in response to a
 * decision. The three "start something at a tier" kinds differ in how much they
 * trust what's already running: 'set' forces the given tier — starts the watch if
 * nothing is running yet, or switches an already-running one (see location.ts's
 * setLocationWatchTier). 'start-if-idle' only starts a fresh watch if none is
 * running yet, and otherwise leaves an already-running watch's tier untouched (see
 * location.ts's startLocationWatch/startLocationWatchCore). 'restart' trusts nothing
 * — it unconditionally tears down and resubscribes even if the tier already matches
 * and a subscription object still exists, because that subscription can be silently
 * dead without either of those two signals having moved (see location.ts's
 * restartLocationWatch); only the self-heal path (ensure_alive_while_recording) uses
 * it today. */
export type WatchAction =
  | { kind: 'set'; tier: LocationWatchTier }
  | { kind: 'start-if-idle'; tier: LocationWatchTier }
  | { kind: 'restart'; tier: LocationWatchTier }
  | { kind: 'stop' }
  | { kind: 'none' };

export type GpsTierAction = {
  watch: WatchAction;
  /** True when TripStateMachine's in-progress auto-start sustain window (if any) should
   * be cancelled — a demotion away from a would-be start that didn't turn into a real
   * one. */
  cancelAutoStart: boolean;
};

export type GpsPolicyInput =
  /** A location sample's `auto_start` event fired, but the board turned out not to be
   * usable — the would-be trip can't actually start. Under the connection-gated model
   * this is nearly unreachable (a not-usable board means the watch was already stopped
   * on disconnect), but kept as a safety net: stop the watch and cancel the sustain
   * window. */
  | { event: 'auto_start_blocked' }
  /** A trip is genuinely starting — either a location sample's `auto_start` event with a
   * usable board, or a manual Start Trip tap. Escalate the watch to full accuracy. */
  | { event: 'trip_starting' }
  /** A trip just ended (saved, discarded, or failed) — decide the idle-time "at rest"
   * strategy to resume. Under the connection-gated model that's: keep the idle-tier
   * watch running if the board is still connected (so the next ride auto-starts
   * instantly), or stop it entirely if the board is gone. */
  | { event: 'trip_ended'; boardUsable: boolean }
  /** The board just connected (BLE online transition) while idle — start the low-power
   * idle-tier watch so location samples flow and the board's wheel speed can drive an
   * auto-start the moment the rider moves. */
  | { event: 'board_connected' }
  /** The board just disconnected (BLE offline transition) while idle — stop the watch;
   * there's no board to ride, so no point paying GPS cost. (While a trip is recording,
   * tripRecorder.ts deliberately does NOT act on this — it needs samples to keep
   * flowing so the state machine's BLE-disconnect auto-end can fire.) */
  | { event: 'board_disconnected' }
  /** App-foreground self-heal (ensureLocationTrackingAlive) confirmed a trip is actively
   * being recorded — force a genuinely fresh recording-tier watch subscription
   * regardless of what tier it's nominally on or whether one appears to be running.
   * The JS watchPositionAsync subscription (the real GPS data path) can die silently
   * without currentWatchTier or the foreground-service task changing at all, so a mere
   * tier check can't detect it — only an unconditional restart can. */
  | { event: 'ensure_alive_while_recording' };

const NONE_ACTION: GpsTierAction = { watch: { kind: 'none' }, cancelAutoStart: false };

export function decideGpsTierAction(input: GpsPolicyInput): GpsTierAction {
  switch (input.event) {
    case 'auto_start_blocked':
      // The board turned out not to be usable, so the would-be start can't happen.
      // Under the connection-gated model the watch is only ever running because the
      // board was connected — if it's not usable now, stop the watch (the next
      // board_connected transition restarts it) and cancel the sustain window.
      return {
        watch: { kind: 'stop' },
        cancelAutoStart: true,
      };

    case 'trip_starting':
      // Once a trip is genuinely starting, go straight to full accuracy — idle waiting
      // stays on the low-power tier, this isn't that anymore.
      return {
        watch: { kind: 'set', tier: 'active' },
        cancelAutoStart: false,
      };

    case 'trip_ended':
      // Back to the cheapest idle-time strategy the instant a trip is over. Under the
      // connection-gated model that's: keep the low-power idle-tier watch running if the
      // board is still connected (so the next ride auto-starts instantly), or stop it
      // entirely if the board is gone (no GPS cost while there's no board to ride).
      return input.boardUsable
        ? { watch: { kind: 'start-if-idle', tier: 'idle' }, cancelAutoStart: false }
        : { watch: { kind: 'stop' }, cancelAutoStart: false };

    case 'board_connected':
      // The board is connected and idle — start the low-power idle-tier watch (no-op if
      // it's somehow already running) so location samples flow and the board's wheel
      // speed can drive an auto-start the moment the rider moves.
      return {
        watch: { kind: 'start-if-idle', tier: 'idle' },
        cancelAutoStart: false,
      };

    case 'board_disconnected':
      // The board is gone and idle — stop the watch. (While recording, tripRecorder.ts
      // guards this away so samples keep flowing to the BLE-disconnect auto-end.)
      return {
        watch: { kind: 'stop' },
        cancelAutoStart: false,
      };

    case 'ensure_alive_while_recording':
      return { watch: { kind: 'restart', tier: 'active' }, cancelAutoStart: false };

    default:
      return NONE_ACTION;
  }
}
