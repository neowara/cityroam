import { pickOdometerReading } from '@/features/rides/odometer';

describe('pickOdometerReading', () => {
  it('uses the live board reading when there is one', () => {
    expect(pickOdometerReading(815.9, 800)).toEqual({ km: 815.9, source: 'live' });
  });

  it('falls back to the last value the board reported', () => {
    expect(pickOdometerReading(null, 815.9)).toEqual({ km: 815.9, source: 'last-reported' });
  });

  it('shows nothing rather than estimating when the board never reported', () => {
    expect(pickOdometerReading(null, null)).toBeNull();
    expect(pickOdometerReading(undefined, undefined)).toBeNull();
  });
});
