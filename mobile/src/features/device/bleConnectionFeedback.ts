import { logEvent } from '@/lib/log';
import { hapticConnect, hapticDisconnect } from '@/lib/haptics';
import { notifyBoardConnection } from '@/features/device/deviceConnectionNotifications';
// Imported straight from the events module, not through lib/deviceLink's `export *`:
// that module is in a require cycle, and binding the subscriber through it while the
// emitter binds to the events module directly leaves the two ends on different
// instances, so transitions are emitted to nobody and the connect/disconnect feedback
// silently never fires.
import { subscribeToBleConnectionTransitions } from '@/features/device/deviceLink/connectionEvents';

/**
 * Registers haptic + notification feedback as independent subscribers on the shared
 * connection-transition seam (lib/bleConnectionEvents.ts), rather than
 * deviceLink/session.ts calling into haptics.ts/deviceConnectionNotifications.ts
 * directly from inside its connection-state listener. Two separate subscriptions, not
 * one combined callback, so each concern stays independently addable/removable.
 *
 * The audible half of this used to be a hand-rolled AudioPlayer (lib/sound.ts) —
 * replaced with a real system notification (a channel with a custom sound) so Do Not
 * Disturb/ringer-silent is respected automatically instead of reimplemented, and the
 * rider gets Android's own per-channel notification settings as a second, free
 * off-switch alongside the in-app one.
 *
 * Must run at module scope (side effect on import), same pattern as
 * lib/locationTask.ts's TaskManager.defineTask registration — imported once,
 * early, from app/_layout.tsx.
 */
subscribeToBleConnectionTransitions((event) => {
  if (event.type === 'connected') hapticConnect();
  else hapticDisconnect();
});

subscribeToBleConnectionTransitions((event) => {
  logEvent('ble-feedback', `transition ${event.type} — notifying`);
  void notifyBoardConnection(event.type === 'connected');
});
