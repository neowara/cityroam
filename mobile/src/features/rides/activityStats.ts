import type { TripSummary } from '@/lib/api';

// Shared by index.tsx's "This week" tile and activity.tsx's day/week/month views —
// used to be two independently-maintained copies of the same week-boundary math.

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Monday-start, matching this app's convention throughout — `getDay()`'s 0 is
 * Sunday, so Sunday is treated as day 7 of the *previous* week's Monday start. */
export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay();
  x.setDate(x.getDate() + ((day === 0 ? -6 : 1) - day));
  return x;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function tripsInRange(trips: TripSummary[], start: Date, end: Date): TripSummary[] {
  return trips.filter((t) => {
    const d = new Date(t.startTime);
    return d >= start && d < end;
  });
}

export type Period = 'day' | 'week' | 'month';

export function periodRange(period: Period, cursor: Date): { start: Date; end: Date } {
  if (period === 'day') {
    const start = startOfDay(cursor);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }
  if (period === 'week') {
    const start = startOfWeek(cursor);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { start, end };
  }
  const start = startOfMonth(cursor);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return { start, end };
}

/** Splits a month's [start, end) range into <=7-day buckets for activity.tsx's month
 * chart, starting from the month's *actual* start date -- not the calendar-week-aligned
 * Monday before it. Starting from a calendar-week alignment let early/late buckets leak
 * in days from the adjacent month, which is exactly why a month starting mid-week (most
 * months) could show a misleading "W1..W6" (6 buckets) even though no month has 6 real
 * weeks -- the first and last buckets were mostly someone else's month. Buckets here are
 * always ceil((end-start)/7 days): 4 or 5 for a real calendar month, never 6, and every
 * bucket's [bucketStart, bucketEnd) stays within [start, end). */
export function monthWeekBuckets(start: Date, end: Date): { start: Date; end: Date }[] {
  const buckets: { start: Date; end: Date }[] = [];
  let bucketStart = new Date(start);
  while (bucketStart < end) {
    const bucketEnd = new Date(bucketStart);
    bucketEnd.setDate(bucketEnd.getDate() + 7);
    buckets.push({ start: bucketStart, end: bucketEnd });
    bucketStart = new Date(bucketStart);
    bucketStart.setDate(bucketStart.getDate() + 7);
  }
  return buckets;
}

export type WeeklyStats = {
  tripCount: number;
  distanceKm: number;
  lastWeekDistanceKm: number;
  avgSpeedKmh: number;
  efficiencyPctPerKm: number | null;
};

export function weeklyStats(trips: TripSummary[], now: Date = new Date()): WeeklyStats {
  const since = startOfWeek(now);
  const untilNextWeek = new Date(since);
  untilNextWeek.setDate(untilNextWeek.getDate() + 7);
  const prevSince = new Date(since);
  prevSince.setDate(prevSince.getDate() - 7);

  const thisWeek = tripsInRange(trips, since, untilNextWeek);
  const lastWeek = tripsInRange(trips, prevSince, since);

  const distanceKm = thisWeek.reduce((sum, t) => sum + t.distanceKm, 0);
  const lastWeekDistanceKm = lastWeek.reduce((sum, t) => sum + t.distanceKm, 0);
  const totalHours = thisWeek.reduce((sum, t) => sum + t.durationSec, 0) / 3600;
  const avgSpeedKmh = totalHours > 0 ? distanceKm / totalHours : 0;

  const withBattery = thisWeek.filter((t) => t.batteryUsedPct != null);
  const batteryUsedSum = withBattery.reduce((sum, t) => sum + (t.batteryUsedPct ?? 0), 0);
  const batteryDistanceSum = withBattery.reduce((sum, t) => sum + t.distanceKm, 0);
  const efficiencyPctPerKm = batteryDistanceSum > 0 ? batteryUsedSum / batteryDistanceSum : null;

  return { tripCount: thisWeek.length, distanceKm, lastWeekDistanceKm, avgSpeedKmh, efficiencyPctPerKm };
}
