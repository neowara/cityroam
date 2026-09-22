import { useMemo, useState } from 'react';
import { StyleSheet, ScrollView, ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';
import { BarChart } from 'react-native-gifted-charts';
import { Activity as ActivityIcon } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { Card } from '@/components/ui/Card';
import { PressableScale } from '@/components/ui/PressableScale';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { StatTile } from '@/components/ui/StatTile';
import { ModeChip } from '@/components/ui/ModeChip';
import { SyncStatusBadge } from '@/features/rides/components/SyncStatusBadge';
import { useAppTheme } from '@/lib/theme';
import { useTrips, useRefetchOnFocus } from '@/lib/queries';
import { useTripDeviceFilter } from '@/features/device/deviceFilter';
import { isLocalTripId } from '@/features/rides/localTrips';
import { formatDateTime } from '@/lib/dateFormat';
import { ApiNotConfiguredError, type TripSummary } from '@/lib/api';
import { monthWeekBuckets, periodRange as sharedPeriodRange, startOfDay, type Period } from '@/features/rides/activityStats';

// Adds the locale-formatted label on top of activityStats.ts's shared boundary math (also used by index.tsx).
function periodRange(period: Period, cursor: Date): { start: Date; end: Date; label: string } {
  const { start, end } = sharedPeriodRange(period, cursor);
  if (period === 'day') {
    return { start, end, label: start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) };
  }
  if (period === 'week') {
    const endInclusive = new Date(end);
    endInclusive.setDate(endInclusive.getDate() - 1);
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { start, end, label: `${fmt(start)} – ${fmt(endInclusive)}` };
  }
  return { start, end, label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
}

function shiftCursor(period: Period, cursor: Date, dir: 1 | -1): Date {
  const d = new Date(cursor);
  if (period === 'day') d.setDate(d.getDate() + dir);
  else if (period === 'week') d.setDate(d.getDate() + 7 * dir);
  else d.setMonth(d.getMonth() + dir);
  return d;
}

function aggregate(trips: TripSummary[]) {
  const distanceKm = trips.reduce((s, t) => s + t.distanceKm, 0);
  const totalHours = trips.reduce((s, t) => s + t.durationSec, 0) / 3600;
  const avgSpeedKmh = totalHours > 0 ? distanceKm / totalHours : 0;
  const withBattery = trips.filter((t) => t.batteryUsedPct && t.batteryUsedPct > 0);
  const efficiencyKmPerPct =
    withBattery.length > 0 ? withBattery.reduce((s, t) => s + t.distanceKm / (t.batteryUsedPct as number), 0) / withBattery.length : null;
  // The board's lifetime odometer as of the period's last ride, not a per-period distance
  // and not the highest value: the controller can fall back to an older stored total.
  const latestWithOdometer = trips
    .filter((t) => t.odometerEndKm != null)
    .reduce<TripSummary | null>((latest, t) => (!latest || Date.parse(t.endTime) > Date.parse(latest.endTime) ? t : latest), null);
  const odometerEndKm = latestWithOdometer?.odometerEndKm ?? null;
  return { distanceKm, avgSpeedKmh, efficiencyKmPerPct, odometerEndKm };
}

export default function ActivityScreen() {
  const router = useRouter();
  const { accentColor: tint } = useAppTheme();
  const axisTextColor = useThemeColor({}, 'text');
  const [period, setPeriod] = useState<Period>('week');
  const [cursor, setCursor] = useState(new Date());
  const { deviceId } = useTripDeviceFilter();
  const { data: trips, error, isPending, refetch } = useTrips(deviceId);
  useRefetchOnFocus(refetch);

  const { start, end, label } = periodRange(period, cursor);
  // Memo deps key off the timestamps, not the Date objects: periodRange returns fresh
  // Dates every render, so depending on the objects would rebuild every time.
  const startMs = start.getTime();
  const endMs = end.getTime();
  const periodTrips = useMemo(
    () => (trips ?? []).filter((t) => new Date(t.startTime) >= start && new Date(t.startTime) < end),
    [trips, startMs, endMs],
  );
  const stats = aggregate(periodTrips);

  const earliestTripDate = useMemo(
    () => (trips && trips.length > 0 ? new Date(Math.min(...trips.map((t) => new Date(t.startTime).getTime()))) : null),
    [trips],
  );
  const isCurrentPeriod = end > new Date();
  const canGoNext = !isCurrentPeriod;
  const canGoPrev = earliestTripDate != null && start > startOfDay(earliestTripDate);

  const chartData = useMemo(() => {
    if (period === 'day' || !trips) return null;
    if (period === 'week') {
      // Ride count, not summed distance — distance already has its own stat tile above.
      const days = Array.from({ length: 7 }, (_, i) => {
        const dayStart = new Date(start);
        dayStart.setDate(dayStart.getDate() + i);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        const dayTrips = periodTrips.filter((t) => new Date(t.startTime) >= dayStart && new Date(t.startTime) < dayEnd);
        return {
          value: dayTrips.length,
          label: dayStart.toLocaleDateString(undefined, { weekday: 'narrow' }),
          frontColor: tint,
          drillDate: dayStart,
        };
      });
      return days;
    }
    // month: bars per week within the month (see monthWeekBuckets's own docstring for
    // why buckets start from the month's actual start date, not a calendar-week-aligned
    // one -- that's what previously produced a misleading "W1..W6" for a month like
    // August, which doesn't really have 6 weeks).
    return monthWeekBuckets(start, end).map(({ start: bucketStart, end: bucketEnd }, i) => {
      const weekTrips = periodTrips.filter((t) => new Date(t.startTime) >= bucketStart && new Date(t.startTime) < bucketEnd);
      return { value: weekTrips.length, label: `W${i + 1}`, frontColor: tint, drillDate: bucketStart };
    });
  }, [period, startMs, endMs, periodTrips, tint]);

  // Week bar -> that day's Day view; Month bar -> that week's Week view. Day view has no further drill-down.
  function handleBarPress(item: { drillDate: Date }) {
    if (period === 'week') {
      setCursor(item.drillDate);
      setPeriod('day');
    } else if (period === 'month') {
      setCursor(item.drillDate);
      setPeriod('week');
    }
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>
          {error instanceof ApiNotConfiguredError ? error.message : String((error as Error).message ?? error)}
        </Text>
      </View>
    );
  }
  if (isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.content}>
        <ScreenHeader icon={ActivityIcon} title="Activity" />
        <View style={styles.switcher}>
          {(['day', 'week', 'month'] as Period[]).map((p) => (
            <PressableScale key={p} onPress={() => setPeriod(p)} style={[styles.opt, period === p && { backgroundColor: tint }]}>
              <Text style={[styles.optText, period === p && styles.optTextActive]}>{p[0].toUpperCase() + p.slice(1)}</Text>
            </PressableScale>
          ))}
        </View>

        <View style={styles.nav}>
          <PressableScale disabled={!canGoPrev} onPress={() => setCursor(shiftCursor(period, cursor, -1))} hitSlop={10}>
            <Text style={[styles.navArrow, !canGoPrev && styles.navArrowDisabled]}>‹</Text>
          </PressableScale>
          <PressableScale onPress={() => setCursor(new Date())}>
            <Text style={styles.navLabel}>{label}</Text>
          </PressableScale>
          <PressableScale disabled={!canGoNext} onPress={() => setCursor(shiftCursor(period, cursor, 1))} hitSlop={10}>
            <Text style={[styles.navArrow, !canGoNext && styles.navArrowDisabled]}>›</Text>
          </PressableScale>
        </View>
        {!isCurrentPeriod && <Text style={styles.nonCurrentHint}>Viewing a past period. Tap the date to jump to today.</Text>}

        {periodTrips.length === 0 ? (
          <Card>
            <Text style={styles.note}>No rides in this period.</Text>
          </Card>
        ) : (
          <>
            <View style={styles.statRow}>
              <StatTile label="Distance" value={`${stats.distanceKm.toFixed(1)} km`} />
              <StatTile label="Avg speed" value={`${stats.avgSpeedKmh.toFixed(1)} km/h`} />
              <StatTile label="Efficiency" value={stats.efficiencyKmPerPct != null ? `${stats.efficiencyKmPerPct.toFixed(2)} km/%` : '–'} />
              <StatTile label="Odometer" value={stats.odometerEndKm != null ? `${stats.odometerEndKm.toFixed(1)} km` : '–'} />
            </View>

            {chartData && (
              <Card>
                <BarChart
                  data={chartData}
                  barWidth={period === 'week' ? 28 : 36}
                  spacing={period === 'week' ? 18 : 24}
                  height={140}
                  noOfSections={3}
                  yAxisThickness={0}
                  xAxisThickness={1}
                  xAxisColor="#8884"
                  xAxisLabelTextStyle={{ color: axisTextColor, fontSize: 11 }}
                  yAxisTextStyle={{ color: axisTextColor, fontSize: 11 }}
                  hideRules
                  frontColor={tint}
                  onPress={handleBarPress}
                />
              </Card>
            )}

            <View style={styles.list}>
              {periodTrips.map((t) => (
                <View key={t.id} style={styles.cardWrap}>
                  <PressableScale style={[styles.row, { borderColor: tint + '55' }]} onPress={() => router.push(`/trip/${t.id}`)}>
                    <View style={styles.rowInfo}>
                      <Text style={styles.t1}>
                        {t.distanceKm.toFixed(1)} km · {(t.durationSec / 60).toFixed(0)} min
                      </Text>
                      <View style={styles.rowMeta}>
                        <Text style={styles.t2}>{formatDateTime(t.startTime)}</Text>
                        <ModeChip dominantMode={t.dominantMode} mixed={t.modeMixed} />
                      </View>
                    </View>
                    <Text style={styles.chev}>›</Text>
                  </PressableScale>
                  <SyncStatusBadge synced={!isLocalTripId(t.id)} />
                </View>
              ))}
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Floating dock nav bar is absolutely positioned — reserve clearance so the last card
  // doesn't render underneath it (see index.tsx's `content` style for the same fix).
  content: { padding: 20, paddingBottom: 110, gap: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  error: { color: '#e5484d', textAlign: 'center' },
  switcher: { flexDirection: 'row', gap: 8 },
  opt: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#8884',
    overflow: 'hidden',
  },
  optText: { fontSize: 13, fontWeight: '600' },
  optTextActive: { color: '#fff' },
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20 },
  navArrow: { fontSize: 22, fontWeight: '700', paddingHorizontal: 8 },
  navArrowDisabled: { opacity: 0.25 },
  navLabel: { fontSize: 14, fontWeight: '600', minWidth: 160, textAlign: 'center' },
  nonCurrentHint: { fontSize: 11, opacity: 0.5, textAlign: 'center', marginTop: -8 },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  note: { fontSize: 13, opacity: 0.6, lineHeight: 18 },
  list: { gap: 10 },
  cardWrap: { position: 'relative' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  rowInfo: { flex: 1 },
  t1: { fontSize: 15, fontWeight: '600' },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  t2: { fontSize: 12, opacity: 0.6 },
  chev: { fontSize: 18, opacity: 0.4 },
});
