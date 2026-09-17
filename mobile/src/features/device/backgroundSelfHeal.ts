import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { getPairedDeviceId } from '@/features/device/deviceLink';
import { hasBlePermissions } from '@/features/device/deviceLink/permissions';
import { loadBoardCredentials } from '@/features/device/boardCredentials';
import { logEvent } from '@/lib/log';
import { getAutoTrackingEnabled } from '@/lib/settings';
import { ensureForegroundServiceRunning } from '@/features/rides/tripRecorder/location';
import { startNativeRideCapture, stopNativeRideCapture } from '@/features/rides/rideCore';
import BoardBleNative from '@modules/board-ble/src/BoardBle';
import NaveeBleNative from '@modules/navee-ble/src/NaveeBle';
import { isNaveeDevId } from '@/features/device/navee/credentials';
import { stopAllBackgroundReconnect } from '@/features/device/deviceLink/transport';

const ENABLED_KEY = 'turbo.backgroundSelfHealEnabled';
export const SELF_HEAL_TASK_NAME = 'turbo-self-heal-task';

// Attempts to revive the location foreground service from JS if it died along with a
// killed process — the layer that CAN'T be done in pure native code (BoardSelfHealWorker
// handles the BLE/GPS-independent reconnect side natively). Relies on
// TaskManager.defineTask's headless delivery, which this app has already hit real
// reliability problems with for a different consumer (see the comment on
// LOCATION_TASK_NAME in tripRecorder/location.ts, and the wider history of this exact
// failure mode across Expo's background-fetch/notifications/location task consumers on
// Android) — this task is a genuine attempt, not a guaranteed fix, and needs real
// on-device verification (kill the app, wait past the 15min interval, confirm via adb
// logcat that this actually ran) before it can be trusted. BoardSelfHealWorker.kt (pure
// native, no JS dependency) is the layer that's guaranteed to work regardless.
//
// Must be called in the global scope, not inside a component — same requirement as
// LOCATION_TASK_NAME's own defineTask call.
TaskManager.defineTask(SELF_HEAL_TASK_NAME, async () => {
  try {
    // Respect an explicit "auto-tracking off" choice (Settings) — without this check,
    // this task would silently resurrect the GPS foreground service (and its
    // persistent notification) on its next ~15min tick even after the user turned
    // tracking off, since ensureForegroundServiceRunning has no other caller that
    // ever stops it again once started (see ADR 0004).
    if (await getAutoTrackingEnabled()) {
      await ensureForegroundServiceRunning();
    }
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (err) {
    logEvent('trip', 'self-heal background task failed', { error: err instanceof Error ? err.message : String(err) });
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function getBackgroundSelfHealEnabled(): Promise<boolean> {
  const stored = await AsyncStorage.getItem(ENABLED_KEY);
  return stored !== 'false'; // defaults on
}

export async function setBackgroundSelfHealEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(ENABLED_KEY, String(enabled));
  await applyBackgroundSelfHeal(enabled);
}

/** Actually applies the enabled/disabled state to both self-heal layers (native
 * WorkManager BLE reconnect + JS BackgroundTask GPS-service revival). Call at app
 * launch (gated on a board being paired — nothing to self-heal for otherwise) and on
 * every toggle change. Idempotent either way. */
export async function applyBackgroundSelfHeal(enabled?: boolean): Promise<void> {
  const isEnabled = enabled ?? (await getBackgroundSelfHealEnabled());
  const devId = await getPairedDeviceId();
  // The native side of this starts a connectedDevice foreground service, which Android
  // 14+ refuses unless BLUETOOTH_CONNECT is already granted — and a refusal at launch
  // is fatal, not a degradation. The rider is asked for Bluetooth when a connection is
  // actually attempted, so on a fresh install this correctly does nothing until then,
  // and the next launch picks it up.
  const permitted = await hasBlePermissions();
  if (isEnabled && devId && permitted) {
    try {
      // The native side needs the key material to reconnect from a process the system
      // recreated, where nothing can read it back out of secure storage.
      // A NAVEE scooter's session lives in this process; keeping RideService up is
      // what keeps it alive. Process-death reconnection is Tuya-only for now.
      const credentials = isNaveeDevId(devId) ? null : await loadBoardCredentials(devId);
      if (isNaveeDevId(devId)) {
        // A board paired earlier leaves its keys in the native store, and RideService
        // brings up a client for whatever is stored — so a switch to the scooter would
        // quietly keep reconnecting the board and feed both into one ride journal.
        BoardBleNative.stopBackgroundReconnect();
        NaveeBleNative.startBackgroundReconnect();
      }
      if (credentials) {
        BoardBleNative.startBackgroundReconnect(
          credentials.devId,
          credentials.uuid,
          credentials.mac,
          credentials.localKey,
          credentials.secKey,
          credentials.addressType,
        );
      }
    } catch (err) {
      logEvent('trip', 'startBackgroundReconnect failed', { error: err instanceof Error ? err.message : String(err) });
    }
    await BackgroundTask.registerTaskAsync(SELF_HEAL_TASK_NAME, { minimumInterval: 15 }).catch((err) =>
      logEvent('trip', 'registerTaskAsync(self-heal) failed', { error: err instanceof Error ? err.message : String(err) }),
    );
    // Same gate as background BLE reconnection above (a board paired, Bluetooth
    // permission granted) — without a board to connect to, there's nothing for the
    // native ride journal to capture. See rideCore.ts's own doc comment for scope.
    startNativeRideCapture();
  } else {
    if (isEnabled && devId && !permitted) {
      logEvent('trip', 'background reconnect deferred — Bluetooth permission not granted yet');
    }
    stopAllBackgroundReconnect();
    await BackgroundTask.unregisterTaskAsync(SELF_HEAL_TASK_NAME).catch(() => {});
    stopNativeRideCapture();
  }
}
