jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));
jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 4, BestForNavigation: 6 },
  hasStartedLocationUpdatesAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
}));

import * as Location from 'expo-location';
import RideCoreNative from '@modules/ride-core/src/RideCore';
import { ensureForegroundServiceRunning, releaseForegroundServiceIfRedundant } from '@/features/rides/tripRecorder/location';

describe('expo-location service vs. RideService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('starts the expo-location service when RideService does not hold location', async () => {
    jest.spyOn(RideCoreNative, 'hasLocationForeground').mockReturnValue(false);
    (Location.hasStartedLocationUpdatesAsync as jest.Mock).mockResolvedValue(false);

    await ensureForegroundServiceRunning();

    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledTimes(1);
  });

  it('does not start it while RideService holds location', async () => {
    jest.spyOn(RideCoreNative, 'hasLocationForeground').mockReturnValue(true);
    (Location.hasStartedLocationUpdatesAsync as jest.Mock).mockResolvedValue(false);

    await ensureForegroundServiceRunning();

    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('starts it when the native check throws', async () => {
    jest.spyOn(RideCoreNative, 'hasLocationForeground').mockImplementation(() => {
      throw new Error('module missing');
    });
    (Location.hasStartedLocationUpdatesAsync as jest.Mock).mockResolvedValue(false);

    await ensureForegroundServiceRunning();

    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledTimes(1);
  });

  it('stops a running expo-location service once RideService holds location', async () => {
    jest.spyOn(RideCoreNative, 'hasLocationForeground').mockReturnValue(true);
    (Location.hasStartedLocationUpdatesAsync as jest.Mock).mockResolvedValue(true);

    await releaseForegroundServiceIfRedundant();

    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledTimes(1);
  });

  it('leaves it running when RideService does not hold location', async () => {
    jest.spyOn(RideCoreNative, 'hasLocationForeground').mockReturnValue(false);
    (Location.hasStartedLocationUpdatesAsync as jest.Mock).mockResolvedValue(true);

    await releaseForegroundServiceIfRedundant();

    expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });
});
