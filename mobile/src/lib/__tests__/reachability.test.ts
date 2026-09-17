import { ROUND_TRIP_MARGIN_PCT, reachabilityVerdict, type ReachabilityVerdict } from '@/lib/reachability';
import type { DestinationModeResult } from '@/lib/api/rangeEstimate';

function mode(partial: Partial<DestinationModeResult>): DestinationModeResult {
  return {
    reachable: null,
    reachableRoundTrip: null,
    estimatedArrivalBatteryPct: null,
    estimatedRoundTripArrivalBatteryPct: null,
    estimatedEnergyWh: null,
    distanceKm: null,
    climbM: null,
    ...partial,
  };
}

describe('reachabilityVerdict', () => {
  it('returns unknown when there is no battery reading', () => {
    expect(reachabilityVerdict(mode({ reachable: null, estimatedArrivalBatteryPct: null }))).toBe<ReachabilityVerdict>('unknown');
  });

  it('returns not-enough when the one-way trip is unreachable', () => {
    expect(
      reachabilityVerdict(mode({ reachable: false, estimatedArrivalBatteryPct: -5, estimatedRoundTripArrivalBatteryPct: -25 })),
    ).toBe<ReachabilityVerdict>('not-enough');
  });

  it('returns doable when the round trip stays above the margin', () => {
    expect(
      reachabilityVerdict(mode({ reachable: true, estimatedArrivalBatteryPct: 70, estimatedRoundTripArrivalBatteryPct: 40 })),
    ).toBe<ReachabilityVerdict>('doable');
  });

  it('returns doable exactly at the margin', () => {
    expect(
      reachabilityVerdict(
        mode({ reachable: true, estimatedArrivalBatteryPct: 60, estimatedRoundTripArrivalBatteryPct: ROUND_TRIP_MARGIN_PCT }),
      ),
    ).toBe<ReachabilityVerdict>('doable');
  });

  it('returns cutting-close when the round trip falls below the margin', () => {
    expect(
      reachabilityVerdict(
        mode({ reachable: true, estimatedArrivalBatteryPct: 30, estimatedRoundTripArrivalBatteryPct: ROUND_TRIP_MARGIN_PCT - 1 }),
      ),
    ).toBe<ReachabilityVerdict>('cutting-close');
  });

  it('returns cutting-close when you cannot get back at all', () => {
    expect(
      reachabilityVerdict(mode({ reachable: true, estimatedArrivalBatteryPct: 5, estimatedRoundTripArrivalBatteryPct: -10 })),
    ).toBe<ReachabilityVerdict>('cutting-close');
  });

  describe('one-way mode (roundTrip=false)', () => {
    it('ignores a tight/negative round-trip figure entirely -- only getting there matters', () => {
      const oneWayDoable = mode({ reachable: true, estimatedArrivalBatteryPct: 5, estimatedRoundTripArrivalBatteryPct: -10 });
      expect(reachabilityVerdict(oneWayDoable, false)).toBe<ReachabilityVerdict>('doable');
    });

    it('still returns not-enough when the one-way leg itself is unreachable', () => {
      const unreachable = mode({ reachable: false, estimatedArrivalBatteryPct: -5, estimatedRoundTripArrivalBatteryPct: -25 });
      expect(reachabilityVerdict(unreachable, false)).toBe<ReachabilityVerdict>('not-enough');
    });

    it('still returns unknown with no battery reading', () => {
      expect(reachabilityVerdict(mode({ reachable: null, estimatedArrivalBatteryPct: null }), false)).toBe<ReachabilityVerdict>('unknown');
    });
  });
});
