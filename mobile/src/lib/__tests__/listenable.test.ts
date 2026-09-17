// The shared listenable primitive's notify used to be a bare forEach: one listener
// throwing synchronously aborted the iteration, so every listener registered AFTER the
// throwing one silently stopped receiving this event and all future ones. The trip
// recorder subscribes late to the connection-transition listenable — exactly the
// subscriber a mid-chain throw would blind, and the reason a board power-off could
// stop ending/saving trips.
import { createListenable } from '@/lib/listenable';

describe('createListenable — notify is exception-safe', () => {
  it('keeps delivering to later listeners when an earlier one throws', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { subscribe, notify } = createListenable();
      const received: string[] = [];

      subscribe(() => {
        throw new Error('broken listener');
      });
      subscribe(() => received.push('second'));
      subscribe(() => received.push('third'));

      expect(() => notify()).not.toThrow();
      expect(received).toEqual(['second', 'third']);

      // Delivery survives for future notifications too, not just this one.
      notify();
      expect(received).toEqual(['second', 'third', 'second', 'third']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('unsubscribe still removes a listener', () => {
    const { subscribe, notify } = createListenable();
    const received: string[] = [];
    const unsubscribe = subscribe(() => received.push('hit'));

    unsubscribe();
    notify();

    expect(received).toEqual([]);
  });
});
