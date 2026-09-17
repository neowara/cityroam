import { pickBatteryTelemetry } from '@/lib/queries';

describe('pickBatteryTelemetry — Range-by-mode cache fallback (real user ask, 2026-09-02)', () => {
  it('uses the live reading when connected, marked not stale', () => {
    expect(pickBatteryTelemetry({ batteryPct: 62, voltageV: 41.2 }, { batteryPct: 40, voltageV: 39.9 })).toEqual({
      batteryPct: 62,
      voltageV: 41.2,
      stale: false,
    });
  });

  it('falls back to the last-known reading when the board is disconnected (both live fields null)', () => {
    expect(pickBatteryTelemetry({ batteryPct: null, voltageV: null }, { batteryPct: 40, voltageV: 39.9 })).toEqual({
      batteryPct: 40,
      voltageV: 39.9,
      stale: true,
    });
  });

  it('prefers a live partial reading (e.g. batteryPct only) over the cache entirely', () => {
    expect(pickBatteryTelemetry({ batteryPct: 62, voltageV: null }, { batteryPct: 40, voltageV: 39.9 })).toEqual({
      batteryPct: 62,
      voltageV: null,
      stale: false,
    });
  });

  it('stays non-stale "no data at all" when neither live nor cached telemetry exists — a board that has never reported in', () => {
    expect(pickBatteryTelemetry({ batteryPct: null, voltageV: null }, { batteryPct: null, voltageV: null })).toEqual({
      batteryPct: null,
      voltageV: null,
      stale: false,
    });
  });
});
