/** Shared subscribe/notify primitive for module-level cross-component signals — the
 * same `Set<() => void>` add/remove/notify-all shape used independently by
 * deviceLink's paired-device epoch, lib/api/client.ts's session-expired signal, and
 * lib/auth.ts's session-state change signal, pulled out once three call sites
 * confirmed it's a real repeated shape rather than a one-off. */
export function createListenable() {
  const listeners = new Set<() => void>();

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function notify(): void {
    // One listener throwing synchronously must not strand the rest of the Set: an
    // aborted forEach means every later subscriber silently stops receiving THIS
    // event and every future one. The trip recorder's BLE-disconnect auto-end is a
    // late subscriber on the connection-transition listenable — exactly the
    // subscriber a mid-chain throw would blind, and the reason a board power-off
    // would stop ending/saving trips.
    listeners.forEach((l) => {
      try {
        l();
      } catch (err) {
        // Swallowed: a broken listener is that listener's bug, not a reason to
        // sever delivery to everyone registered after it. console rather than
        // lib/log on purpose — this primitive stays dependency-free.
        console.warn('[listenable] listener threw during notify', err);
      }
    });
  }

  return { subscribe, notify };
}
