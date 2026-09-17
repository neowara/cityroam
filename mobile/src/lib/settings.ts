import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

import { LOCATION_TASK_NAME, initAutoTracking, stopLocationWatch, tripRecorder } from '@/features/rides/tripRecorder';

const AUTO_TRACKING_KEY = 'turbo.autoTrackingEnabled';

export async function getAutoTrackingEnabled(): Promise<boolean> {
  const stored = await AsyncStorage.getItem(AUTO_TRACKING_KEY);
  return stored !== 'false'; // defaults on
}

export async function setAutoTrackingEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(AUTO_TRACKING_KEY, String(enabled));
  if (enabled) {
    await initAutoTracking();
  } else {
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
    if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    // A manual trip explicitly in progress must keep being tracked even if
    // auto-tracking is toggled off mid-ride — only actually stop the watch when
    // nothing is currently recording.
    if (tripRecorder.getSnapshot().state === 'idle') {
      // No motion-activity polling exists anymore — idle GPS is gated purely on
      // the board being connected. Stopping the watch here (if it happens to be
      // running) is all that's needed when auto-tracking is off.
      stopLocationWatch();
    }
  }
}

// Estimate inputs (board weight, battery capacity) moved from here
// (phone-wide AsyncStorage) to per-device server storage: see
// mobile/lib/api/devices.ts (GET/PUT /devices/{deviceId}/settings) and
// EstimateSettingsCard.tsx, so switching boards picks up that board's own saved
// values instead of one phone-wide value shared across every paired board.
