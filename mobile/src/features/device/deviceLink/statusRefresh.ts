import { AppState } from 'react-native';

import { subscribeToBleConnectionTransitions } from '@/features/device/deviceLink/connectionEvents';
import { tripRecorder } from '@/features/rides/tripRecorder';
import { getBoardUsability, refreshDeviceStatus } from '@/features/device/deviceLink';
import { applyBackgroundSelfHeal } from '@/features/device/backgroundSelfHeal';
import { logEvent } from '@/lib/log';

/** The board only ever pushes DP updates on its own schedule (see
 * deviceLink/session.ts's registerDeviceStatus), so a value that hasn't changed from
 * the board's perspective (or a push that was simply missed) had no way to
 * refresh short of a pull-to-refresh that didn't even re-query the board. Two triggers,
 * same as the app's existing GPS-tier philosophy of "escalate on a real signal, demote
 * the rest of the time" rather than a naive always-on poll:
 *
 * 1. The instant a connection transition fires (same seam haptics/sound/pending-settings
 *    flush already use) -- freshest possible data right when it matters most, reconnect
 *    after a drop or app cold start.
 * 2. A conservative periodic poll while the app is actually in the foreground AND the
 *    board is already connected -- catches the "sat connected for a while, board never
 *    pushed anything new" case the transition trigger alone can't. Paused in the
 *    background so it can't run up BLE/battery cost for a screen nobody's looking at.
 *
 * This module is the single owner of "refresh while foregrounded and idle"; while a
 * trip is actively recording, the trip recorder's own snapshot cadence (samplingCadence)
 * already queries the board on its tighter 20s schedule, so this poll stands down to
 * avoid two independent timers both poking the board. Must run at module scope (side
 * effect on import), same pattern as lib/bleConnectionFeedback.ts -- imported once,
 * early, from app/_layout.tsx.
 */
subscribeToBleConnectionTransitions((event) => {
  if (event.type !== 'connected') return;
  refreshDeviceStatus();
  // Background reconnection is armed here rather than at launch. Reaching this point
  // proves what starting it needs and what startup cannot promise: Bluetooth
  // permission is granted, and the app is in the foreground. Starting it at launch
  // instead shipped a crash, because the foreground service it brings up is refused —
  // by throwing — before that permission exists.
  applyBackgroundSelfHeal().catch((err) =>
    logEvent('trip', 'applyBackgroundSelfHeal failed after connect', {
      error: err instanceof Error ? err.message : String(err),
    }),
  );
});

// Generous enough that a real board push (or the connection-transition trigger above)
// is almost always what actually updates the UI -- this is a backstop for "the board
// just didn't push anything for a while," not the primary data path, so it doesn't need
// to be aggressive to be useful.
const FOREGROUND_POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Whether the foreground poll should actually query the board right now. Extracted from
 * pollTick so the stand-down logic is unit-testable without driving the real interval.
 * The poll only runs when a board is paired AND no trip is recording — while a trip is
 * recording, the trip recorder's snapshot cadence owns board refresh (tighter 20s
 * interval), so this poll stands down to avoid two independent timers both poking the
 * board.
 */
export function shouldPollBoardStatus(): boolean {
  // Only worth asking a board that can actually answer. Polling a disconnected board
  // achieves nothing, waits out the response timeout, and fills the debug log with a
  // failure every 30 seconds that says only what the session already knew.
  const usability = getBoardUsability();
  if (usability !== 'usable' && usability !== 'charging') return false;
  if (tripRecorder.isTripActive()) return false;
  return true;
}

function pollTick(): void {
  if (!shouldPollBoardStatus()) return;
  refreshDeviceStatus();
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(pollTick, FOREGROUND_POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

if (AppState.currentState === 'active') startPolling();
AppState.addEventListener('change', (state) => {
  if (state === 'active') startPolling();
  else stopPolling();
});
