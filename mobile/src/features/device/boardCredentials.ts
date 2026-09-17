import * as SecureStore from 'expo-secure-store';

/**
 * The board's key material, keyed by devId in expo-secure-store — never AsyncStorage
 * (these are secrets) and never the debug log. Written once during the direct-path
 * sign-in flow (deviceLink's directPairDevice); read by the session layer every time
 * the direct BLE session registers, because the native client deliberately receives
 * keys as call parameters and holds them only in memory.
 */

export type StoredBoardCredentials = {
  devId: string;
  /** Tuya device uuid — what the BLE scanner matches the advertisement against. */
  uuid: string | null;
  /** MAC address, if a previous scan saw one. Optional; uuid matching is primary. */
  mac: string | null;
  localKey: string;
  /** Only devices on the newer key derivation have one; the handshake tries v3 without it. */
  secKey: string | null;
  productId: string | null;
  name: string | null;
  /** `BluetoothDevice.ADDRESS_TYPE_PUBLIC` (0) / `_RANDOM` (1), learned from a scan —
   * see BoardScanner.addressTypeOf's own comment (native side). Null until learned;
   * absent entirely on a record saved before this field existed. */
  addressType?: number | null;
};

const KEY_PREFIX = 'boardCreds.';

function keyFor(devId: string): string {
  return `${KEY_PREFIX}${devId}`;
}

export async function saveBoardCredentials(credentials: StoredBoardCredentials): Promise<void> {
  await SecureStore.setItemAsync(keyFor(credentials.devId), JSON.stringify(credentials));
}

export async function loadBoardCredentials(devId: string): Promise<StoredBoardCredentials | null> {
  try {
    const raw = await SecureStore.getItemAsync(keyFor(devId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredBoardCredentials;
    if (!parsed.localKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function hasBoardCredentials(devId: string): Promise<boolean> {
  return (await loadBoardCredentials(devId)) != null;
}

export async function deleteBoardCredentials(devId: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyFor(devId));
}
