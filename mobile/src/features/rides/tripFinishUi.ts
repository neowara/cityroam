import { Alert } from 'react-native';
import type { useRouter } from 'expo-router';

import { tripRecorder } from '@/features/rides/tripRecorder';
import { getBackendIdForLocal } from '@/lib/db';
import { logEvent } from '@/lib/log';

/** Shared "Finish trip" tap handler for both finish entry points (FloatingTripButton's
 * FAB confirm and LiveTripModule's card confirm) — awaits the save instead of firing
 * it and forgetting, so a failure is never silent and a successful manual finish opens
 * the trip it just saved. */
export async function finishTripAndNavigate(router: ReturnType<typeof useRouter>): Promise<void> {
  try {
    const result = await tripRecorder.endActive();
    if (result.outcome !== 'saved') return;
    if (!result.synced) return; // Queued offline — no backend id yet to navigate to.
    const backendId = await getBackendIdForLocal(result.localId);
    if (backendId != null) router.push(`/trip/${backendId}`);
  } catch (err) {
    logEvent('trip', 'manual finish failed to save', { error: err instanceof Error ? err.message : String(err) });
    Alert.alert(
      'Trip not saved',
      'Something went wrong saving your ride. Nothing is lost: Cityroam tries again the next time the app opens.',
    );
  }
}
