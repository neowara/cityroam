import { getPairedDeviceId } from '@/features/device/deviceLink';

/** The device a ride being saved now belongs to: the active paired device. Only one
 * device is ever active, and data from different devices must never mix, so every
 * saved trip carries it. Null (not a throw) when nothing is paired or the lookup fails. */
export async function resolveTripDeviceId(): Promise<string | null> {
  try {
    return await getPairedDeviceId();
  } catch {
    return null;
  }
}
