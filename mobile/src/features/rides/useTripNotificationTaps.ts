import { useEffect } from 'react';
import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';

import { savedTripLocalIdFrom, savedTripPath } from '@/features/rides/tripNotifications';
import { getBackendIdForLocal } from '@/lib/db';
import { logEvent } from '@/lib/log';

async function openSavedTrip(localId: number): Promise<void> {
  // Resolved at tap time, not post time: a ride saved offline may have synced since.
  const backendId = await getBackendIdForLocal(localId).catch(() => null);
  const path = savedTripPath(localId, backendId);
  logEvent('notifications', 'opening saved trip from notification', { localId, backendId });
  router.push(path);
}

/** Opens the saved trip when a "Ride saved" notification is tapped, including a tap that
 * launched the app from scratch. `enabled` holds it back until the trip screen is
 * reachable (signed in); the launching tap stays pending in expo-notifications until
 * then. */
export function useTripNotificationTaps(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    // A cold-start tap can be reported both as the last response and to the listener.
    const handled = new Set<string>();
    const handle = (response: Notifications.NotificationResponse) => {
      const id = response.notification.request.identifier;
      if (handled.has(id)) return;
      handled.add(id);
      const localId = savedTripLocalIdFrom(response.notification.request.content.data);
      if (localId != null) void openSavedTrip(localId);
    };
    try {
      const launching = Notifications.getLastNotificationResponse();
      if (launching) {
        Notifications.clearLastNotificationResponse();
        handle(launching);
      }
    } catch {
      // Best-effort: a missing native module just means taps open the app as before.
    }
    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    return () => sub.remove();
  }, [enabled]);
}
