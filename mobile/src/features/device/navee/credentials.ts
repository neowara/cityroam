import * as SecureStore from 'expo-secure-store';

/**
 * What a NAVEE scooter's Bluetooth auth needs, kept in expo-secure-store per device —
 * the NAVEE counterpart of lib/boardCredentials.ts, separate because the secret and
 * its shape are different. There is no per-device key on a NAVEE: the scooter checks
 * the account id it is bound to, so that id is the secret.
 */
export type StoredNaveeCredentials = {
  devId: string;
  /** The account API's id for the scooter, printed in its advertisement. */
  cloudMac: string;
  /** The account id the scooter's auth checks: the owner's, for a shared scooter. */
  accountId: number;
  /** 1 when authenticating as the owner of a scooter shared with this account. */
  bindFlag: number;
  /** Bluetooth address and type, once a scan has learned them. */
  address: string | null;
  addressType: number | null;
  productId: string | null;
  name: string | null;
};

const KEY_PREFIX = 'naveeCreds.';

/** NAVEE devIds carry a prefix so the session layer can tell brands apart synchronously. */
export const NAVEE_DEV_ID_PREFIX = 'navee-';

export function naveeDevId(cloudMac: string): string {
  return `${NAVEE_DEV_ID_PREFIX}${cloudMac.replace(/[:-]/g, '').toUpperCase()}`;
}

export function isNaveeDevId(devId: string | null | undefined): boolean {
  return !!devId && devId.startsWith(NAVEE_DEV_ID_PREFIX);
}

export async function saveNaveeCredentials(credentials: StoredNaveeCredentials): Promise<void> {
  await SecureStore.setItemAsync(`${KEY_PREFIX}${credentials.devId}`, JSON.stringify(credentials));
}

export async function loadNaveeCredentials(devId: string): Promise<StoredNaveeCredentials | null> {
  try {
    const raw = await SecureStore.getItemAsync(`${KEY_PREFIX}${devId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredNaveeCredentials;
    return parsed.accountId > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function deleteNaveeCredentials(devId: string): Promise<void> {
  await SecureStore.deleteItemAsync(`${KEY_PREFIX}${devId}`);
}
