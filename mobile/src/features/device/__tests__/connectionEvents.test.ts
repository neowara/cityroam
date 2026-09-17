// Regression coverage for the startup race fix: subscribeToBleConnectionTransitions
// now replays the last transition to a late subscriber (mirroring liveLogTail.ts), so
// the trip recorder's startConnectionGatedTracking() starts the idle GPS watch even
// when the board's autoConnect brought it online before the recorder ever subscribed.
// Previously the module deliberately did NOT replay, and the recorder's one-shot
// getBoardUsability() check was the only (fragile) mitigation — see tripRecorder.ts's
// startConnectionGatedTracking for the full write-up.

import { emitBleConnectionTransition, subscribeToBleConnectionTransitions } from '@/features/device/deviceLink/connectionEvents';

const DEV_ID = 'dev-1';

describe('connectionEvents — replay last transition to late subscribers', () => {
  it('replays the last transition to a subscriber registered after it fired', () => {
    emitBleConnectionTransition({ type: 'connected', devId: DEV_ID });

    const received: { type: 'connected' | 'disconnected'; devId: string }[] = [];
    subscribeToBleConnectionTransitions((event) => received.push(event));

    // The 'connected' transition fired before subscribe — it must be replayed, not lost.
    expect(received).toEqual([{ type: 'connected', devId: DEV_ID }]);
  });

  it('delivers future transitions to a subscriber registered before them', () => {
    // Establish a known lastTransition so the subscriber's immediate replay is
    // deterministic, then clear it so we only observe the new emit below.
    emitBleConnectionTransition({ type: 'connected', devId: DEV_ID });
    const received: { type: 'connected' | 'disconnected'; devId: string }[] = [];
    subscribeToBleConnectionTransitions((event) => received.push(event));
    received.length = 0;

    emitBleConnectionTransition({ type: 'disconnected', devId: DEV_ID });

    expect(received).toEqual([{ type: 'disconnected', devId: DEV_ID }]);
  });

  it('returns an unsubscribe that stops future deliveries', () => {
    emitBleConnectionTransition({ type: 'connected', devId: DEV_ID });
    const received: { type: 'connected' | 'disconnected'; devId: string }[] = [];
    const unsubscribe = subscribeToBleConnectionTransitions((event) => received.push(event));
    received.length = 0; // drop the replay from subscribe

    unsubscribe();
    emitBleConnectionTransition({ type: 'disconnected', devId: DEV_ID });

    expect(received).toEqual([]);
  });
});
