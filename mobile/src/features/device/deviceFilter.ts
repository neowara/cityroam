import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getPairedDevices, usePairedDeviceEpoch, type PairedDevice } from '@/features/device/deviceLink';

// — a persisted, shared "which board's trips am I
// looking at" preference. Every screen that calls useTripDeviceFilter() reads and
// writes the same value, so changing it on one tab (Dashboard/Rides/Activity) is
// reflected on the others immediately, no navigation remount needed — same
// share-one-value-everywhere shape as deviceLink/session.ts's BLE session state, just
// for a local-only preference instead of live device data.

const TRIP_FILTER_KEY = 'tynee.tripDeviceFilter';

// null = "every board combined" (today's existing behavior before this feature
// existed, and still the default) — distinct from undefined, which just means
// "hasn't been read from storage yet". Only used for the hook's synchronous
// initial-render value below; getTripDeviceFilter/setTripDeviceFilter always go
// straight to AsyncStorage as the actual source of truth, so this can never drift
// out of sync with it the way a permanently-cached read could.
let lastKnownFilter: string | null | undefined;
const filterListeners = new Set<(devId: string | null) => void>();

export async function getTripDeviceFilter(): Promise<string | null> {
  const value = await AsyncStorage.getItem(TRIP_FILTER_KEY);
  lastKnownFilter = value;
  return value;
}

export async function setTripDeviceFilter(devId: string | null): Promise<void> {
  lastKnownFilter = devId;
  if (devId) await AsyncStorage.setItem(TRIP_FILTER_KEY, devId);
  else await AsyncStorage.removeItem(TRIP_FILTER_KEY);
  filterListeners.forEach((l) => l(devId));
}

/** `devices` refreshes on every pair/forget/switch (usePairedDeviceEpoch), not just
 * on mount — so a device forgotten elsewhere disappears from the filter row
 * immediately, and the guard effect below can catch "filtered by a board that no
 * longer exists" as soon as it happens, not just next time this hook remounts. */
export function useTripDeviceFilter(): {
  deviceId: string | null;
  setDeviceId: (id: string | null) => void;
  devices: PairedDevice[];
} {
  const [deviceId, setDeviceIdState] = useState<string | null>(lastKnownFilter ?? null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  // Distinguishes "haven't fetched the paired list yet" (devices still []) from
  // "fetched it and there really are zero paired devices" — without this, the
  // stuck-filter guard below couldn't fire for the last-device-forgotten case
  // without also firing spuriously during the initial load's [] flash (code review
  // finding, the old `devices.length > 0` check meant forgetting the very
  // last paired device while it was the active filter left it permanently stuck).
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const pairedEpoch = usePairedDeviceEpoch();

  useEffect(() => {
    let cancelled = false;
    getTripDeviceFilter().then((v) => {
      if (!cancelled) setDeviceIdState(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getPairedDevices().then((d) => {
      if (!cancelled) {
        setDevices(d);
        setDevicesLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pairedEpoch]);

  useEffect(() => {
    const listener = (v: string | null) => setDeviceIdState(v);
    filterListeners.add(listener);
    return () => {
      filterListeners.delete(listener);
    };
  }, []);

  // A board that's currently filtered-to but no longer paired (forgotten from
  // another screen — including forgetting the very last paired device) would
  // otherwise silently filter to a devId that can never match anything again —
  // fall back to "all boards" instead of a stuck-empty view.
  useEffect(() => {
    if (devicesLoaded && deviceId && !devices.some((d) => d.devId === deviceId)) {
      setTripDeviceFilter(null);
    }
  }, [devicesLoaded, deviceId, devices]);

  const setDeviceId = useCallback((id: string | null) => {
    setTripDeviceFilter(id);
  }, []);

  return { deviceId, setDeviceId, devices };
}
