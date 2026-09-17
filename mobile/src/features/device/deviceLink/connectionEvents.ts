import { createListenable } from '@/lib/listenable';

export type BleConnectionTransition = { type: 'connected' | 'disconnected'; devId: string };

/**
 * Speculative extraction (codebase-design review) — at extraction time,
 * `deviceLink/session.ts`'s `onDeviceStatusChanged` listener was the only real adapter
 * that would call into this, which by this repo's own "one adapter = hypothetical
 * seam, two = real" rule normally wouldn't be worth pulling out yet. Done anyway on
 * explicit request, kept deliberately minimal: `deviceLink/session.ts` still owns
 * detecting a genuine online/offline transition (the existing `wasOnline` diffing
 * logic, unchanged) and only calls `emitBleConnectionTransition()` after it has
 * already decided a real transition happened — this seam only decouples what runs
 * *after* that decision (haptics, sound, flushing queued settings) from the
 * detection logic itself, so `deviceLink/session.ts` goes back to only knowing about
 * connection *state*, not connection *side effects*.
 *
 * Uses the shared createListenable() primitive plus a thin wrapper, same shape as
 * lib/liveLogTail.ts's live-log tail: createListenable()'s notify() takes no args,
 * but subscribers here need to know *which* transition just happened, so the last
 * emitted event is stashed and read by each listener synchronously when notified.
 */
const transitions = createListenable();
let lastTransition: BleConnectionTransition | null = null;

/** Subscribe to connection transitions. Returns an unsubscribe function. Fires
 * immediately with the last transition (if any) on subscribe, then on every
 * subsequent transition — mirroring liveLogTail's tail. Replaying the last
 * transition to a late subscriber is what closes the startup race where the
 * board's autoConnect brings it online before the trip recorder's
 * startConnectionGatedTracking() ever subscribes: without replay, that early
 * 'connected' transition is silently lost and the idle GPS watch never starts
 * (see tripRecorder.ts's startConnectionGatedTracking). */
export function subscribeToBleConnectionTransitions(callback: (event: BleConnectionTransition) => void): () => void {
  const unsubscribe = transitions.subscribe(() => {
    if (lastTransition) callback(lastTransition);
  });
  if (lastTransition) callback(lastTransition);
  return unsubscribe;
}

export function emitBleConnectionTransition(event: BleConnectionTransition): void {
  lastTransition = event;
  transitions.notify();
}
