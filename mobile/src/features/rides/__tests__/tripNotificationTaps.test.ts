import { buildFinalizeSummaryPayload, savedTripLocalIdFrom, savedTripPath } from '@/features/rides/tripNotifications';

describe('Ride saved notification taps', () => {
  it('carries the saved ride local id in the payload', () => {
    const payload = buildFinalizeSummaryPayload({
      distanceKm: 10.3,
      durationSec: 1754,
      maxSpeedKmh: 40,
      batteryStartPct: 64,
      batteryEndPct: 10,
      dominantMode: 'Ride',
      localId: 48,
    });
    expect(payload.localId).toBe(48);
  });

  it('reads the local id only from a Ride saved notification', () => {
    expect(savedTripLocalIdFrom({ kind: 'finalize-summary', localId: 48 })).toBe(48);
    expect(savedTripLocalIdFrom({ kind: 'auto-start', localId: 48 })).toBeNull();
    expect(savedTripLocalIdFrom({ kind: 'finalize-summary', localId: null })).toBeNull();
    expect(savedTripLocalIdFrom({ kind: 'finalize-summary' })).toBeNull();
    expect(savedTripLocalIdFrom(undefined)).toBeNull();
  });

  it('opens the synced trip, or the offline one before it syncs', () => {
    expect(savedTripPath(48, 114)).toBe('/trip/114');
    expect(savedTripPath(48, null)).toBe('/trip/-48');
  });
});
