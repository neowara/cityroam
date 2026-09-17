import { PermissionsAndroid, Platform } from 'react-native';

import { logEvent } from '@/lib/log';

/**
 * Asks for the runtime Bluetooth permissions the BLE client needs, returning whether
 * it may proceed.
 *
 * Android 12+ gates scanning behind BLUETOOTH_SCAN and connecting behind
 * BLUETOOTH_CONNECT. Without them a scan does not fail loudly — it returns no results
 * almost instantly, which reads exactly like a board that is switched off. Below 31
 * those permissions do not exist and the manifest's legacy BLUETOOTH/BLUETOOTH_ADMIN
 * are install-time, so there is nothing to ask for.
 *
 * Lives in its own module because both the connect path and any UI that wants to
 * prompt before connecting need it, and importing it through the deviceLink barrel
 * would create a require cycle.
 */
/**
 * Whether the Bluetooth permissions are already granted, without prompting.
 *
 * Anything that needs them before the rider has been asked — notably the
 * connectedDevice foreground service, which Android 14+ refuses outright without
 * BLUETOOTH_CONNECT — has to check rather than assume.
 */
export async function hasBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return true;
  const [scan, connect] = await Promise.all([
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN),
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT),
  ]);
  return scan && connect;
}

export async function ensureBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return true;

  const granted = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
  ]);
  const ok = Object.values(granted).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
  if (!ok) logEvent('board-link', 'Bluetooth permission denied — cannot scan for the board', granted);
  return ok;
}
