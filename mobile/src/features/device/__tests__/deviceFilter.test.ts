import AsyncStorage from '@react-native-async-storage/async-storage';

import { getTripDeviceFilter, setTripDeviceFilter } from '@/features/device/deviceFilter';

// the persisted "which board's trips am I looking at" preference.
// Covers the plain storage functions directly, same convention as
// pendingSettings.test.ts (the useTripDeviceFilter hook's React-side behavior —
// reacting to a forgotten device, syncing across mounted screens — isn't covered
// here; no hook-testing harness exists in this repo yet).

describe('trip device filter (#6)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('defaults to null (all boards combined) when nothing has been set', async () => {
    expect(await getTripDeviceFilter()).toBeNull();
  });

  it('persists a chosen device across reads', async () => {
    await setTripDeviceFilter('dev-1');
    expect(await getTripDeviceFilter()).toBe('dev-1');
  });

  it('clearing back to null actually removes the stored value, not just returns null', async () => {
    await setTripDeviceFilter('dev-1');
    await setTripDeviceFilter(null);
    expect(await getTripDeviceFilter()).toBeNull();
    expect(await AsyncStorage.getItem('tynee.tripDeviceFilter')).toBeNull();
  });
});
