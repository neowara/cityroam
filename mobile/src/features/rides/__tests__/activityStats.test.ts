import { monthWeekBuckets, periodRange, startOfWeek, tripsInRange, weeklyStats } from '@/features/rides/activityStats';
import type { TripSummary } from '@/lib/api';

function makeTrip(overrides: Partial<TripSummary> & { startTime: string }): TripSummary {
  return {
    id: 1,
    endTime: overrides.startTime,
    distanceKm: 1,
    avgSpeedKmh: 20,
    maxSpeedKmh: 25,
    durationSec: 600,
    wasManual: true,
    batteryStartPct: null,
    batteryEndPct: null,
    batteryUsedPct: null,
    odometerStartKm: null,
    odometerEndKm: null,
    heartRateAvgBpm: null,
    heartRateMaxBpm: null,
    heartRateStartBpm: null,
    heartRateEndBpm: null,
    restingHeartRateBpm: null,
    heartRateVariabilityMs: null,
    steps: null,
    weightKg: null,
    dominantMode: null,
    modeMixed: false,
    weatherCodes: null,
    feelsLikeC: null,
    windSpeedMs: null,
    ...overrides,
  };
}

describe('startOfWeek', () => {
  // Asserted in LOCAL time throughout (never .toISOString(), which re-introduces a
  // UTC conversion and silently shifts the calendar date whenever the machine's local
  // timezone isn't UTC — startOfWeek deliberately operates in local time, matching
  // every screen that displays these boundaries to the user, so local time is what's
  // actually correct to assert against here).
  it('rolls a Sunday back to the *previous* Monday, not the same-day one', () => {
    const sunday = new Date(2026, 7, 23, 15, 0, 0); // Aug 23 2026 is a Sunday, local time
    const result = startOfWeek(sunday);
    expect(result.getDay()).toBe(1); // Monday
    expect(result.getDate()).toBe(17);
    expect(result.getHours()).toBe(0);
  });

  it('a Saturday belongs to the Monday earlier that same week', () => {
    // Aug 22 2026 is a Saturday (this app's real "today" during the session this bug
    // was found in).
    const saturday = new Date(2026, 7, 22, 18, 0, 0);
    const result = startOfWeek(saturday);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(17);
  });
});

describe('weeklyStats', () => {
  // a trip added "just for today" wasn't appearing in the
  // Dashboard's "this week" tile. The date math here checked out under test even
  // before the fix (root cause was a missing query invalidation, not this function) —
  // kept as regression coverage per the user's explicit ask: trips spread across
  // several different days of the current week must all be included.
  it('includes trips from every day of the current week, not just one', () => {
    const now = new Date('2026-08-22T18:00:00Z'); // Saturday
    const trips = [
      makeTrip({ id: 1, startTime: '2026-08-17T12:00:00Z', distanceKm: 2 }), // Monday
      makeTrip({ id: 2, startTime: '2026-08-19T12:00:00Z', distanceKm: 3 }), // Wednesday
      makeTrip({ id: 3, startTime: '2026-08-22T12:00:00Z', distanceKm: 0.2 }), // Saturday (today)
    ];
    const stats = weeklyStats(trips, now);
    expect(stats.tripCount).toBe(3);
    expect(stats.distanceKm).toBeCloseTo(5.2);
  });

  it('excludes a trip from the previous week', () => {
    const now = new Date('2026-08-22T18:00:00Z'); // Saturday, week of 08-17
    const trips = [
      makeTrip({ id: 1, startTime: '2026-08-16T12:00:00Z', distanceKm: 10 }), // Sunday, still last week
      makeTrip({ id: 2, startTime: '2026-08-22T12:00:00Z', distanceKm: 0.2 }), // this week
    ];
    const stats = weeklyStats(trips, now);
    expect(stats.tripCount).toBe(1);
    expect(stats.distanceKm).toBeCloseTo(0.2);
    expect(stats.lastWeekDistanceKm).toBeCloseTo(10);
  });

  it("excludes a trip from next week (future-dated, shouldn't happen but must not leak in)", () => {
    const now = new Date('2026-08-17T12:00:00Z'); // Monday, start of this week
    const trips = [makeTrip({ id: 1, startTime: '2026-08-24T12:00:00Z', distanceKm: 5 })]; // next Monday
    expect(weeklyStats(trips, now).tripCount).toBe(0);
  });
});

describe('periodRange + tripsInRange (Activity screen)', () => {
  it('a week period includes trips from every day within it', () => {
    const cursor = new Date('2026-08-22T18:00:00Z'); // Saturday
    const { start, end } = periodRange('week', cursor);
    const trips = [
      makeTrip({ id: 1, startTime: '2026-08-17T12:00:00Z' }), // Monday
      makeTrip({ id: 2, startTime: '2026-08-20T12:00:00Z' }), // Thursday
      makeTrip({ id: 3, startTime: '2026-08-22T12:00:00Z' }), // Saturday
    ];
    expect(tripsInRange(trips, start, end)).toHaveLength(3);
  });

  it('a day period only includes that single day, even mid-week', () => {
    const cursor = new Date('2026-08-20T18:00:00Z'); // Thursday
    const { start, end } = periodRange('day', cursor);
    const trips = [
      makeTrip({ id: 1, startTime: '2026-08-19T12:00:00Z' }), // Wednesday — excluded
      makeTrip({ id: 2, startTime: '2026-08-20T12:00:00Z' }), // Thursday — included
      makeTrip({ id: 3, startTime: '2026-08-21T12:00:00Z' }), // Friday — excluded
    ];
    expect(tripsInRange(trips, start, end).map((t) => t.id)).toEqual([2]);
  });
});

describe('monthWeekBuckets', () => {
  it('never produces 6 buckets for a real calendar month, regardless of which weekday it starts on', () => {
    // August 2026 starts on a Saturday -- the exact case that used to produce a
    // misleading "W1..W6" when buckets were calendar-week-aligned instead of
    // starting from the month's real start date.
    const start = new Date(2026, 7, 1); // Aug 1, 2026 (local) -- a Saturday
    const end = new Date(2026, 8, 1); // Sep 1, 2026
    const buckets = monthWeekBuckets(start, end);
    expect(buckets.length).toBeLessThanOrEqual(5);
    expect(buckets.length).toBeGreaterThanOrEqual(4);
  });

  it('every bucket stays within [start, end) -- no leaking into the adjacent month', () => {
    const start = new Date(2026, 7, 1);
    const end = new Date(2026, 8, 1);
    const buckets = monthWeekBuckets(start, end);
    expect(buckets[0].start.getTime()).toBe(start.getTime());
    for (const b of buckets) {
      expect(b.start.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(b.start.getTime()).toBeLessThan(end.getTime());
    }
  });

  it('produces exactly 4 buckets for a 28-day month, regardless of which weekday it starts on', () => {
    const start = new Date(2027, 1, 1); // Feb 1, 2027 (non-leap, 28 days)
    const end = new Date(2027, 2, 1);
    expect(monthWeekBuckets(start, end)).toHaveLength(4);
  });

  it('covers the entire month with no gaps between consecutive buckets', () => {
    const start = new Date(2026, 7, 1);
    const end = new Date(2026, 8, 1);
    const buckets = monthWeekBuckets(start, end);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].start.getTime()).toBe(buckets[i - 1].end.getTime());
    }
  });
});
