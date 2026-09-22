import { useEffect, useState } from 'react';

import { getPairedDeviceId, getPairedDevices, usePairedDeviceEpoch, type PairedDevice } from '@/features/device/deviceLink';

// Trips, stats and estimates always describe exactly one device: the active paired one.
// Data from different devices (a board and a scooter, or two boards) never mixes, so
// there is no "all devices" view. Switching the active device (Settings) switches every
// screen with it, since setActiveDeviceId bumps the paired-device epoch.

// Last resolved active device, so a screen mounting after the first read renders with
// it straight away instead of flashing an empty state.
let lastKnownActive: string | null | undefined;

/** `deviceId` is the active device, or null when none is paired. `ready` is false
 * until that has been read from storage; queries keyed on the device wait for it, so
 * nothing is ever fetched unscoped. */
export function useTripDeviceFilter(): {
  deviceId: string | null;
  ready: boolean;
  devices: PairedDevice[];
} {
  const [deviceId, setDeviceId] = useState<string | null>(lastKnownActive ?? null);
  const [ready, setReady] = useState(lastKnownActive !== undefined);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const pairedEpoch = usePairedDeviceEpoch();

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPairedDeviceId(), getPairedDevices()]).then(([active, paired]) => {
      if (cancelled) return;
      lastKnownActive = active;
      setDeviceId(active);
      setDevices(paired);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [pairedEpoch]);

  return { deviceId, ready, devices };
}
