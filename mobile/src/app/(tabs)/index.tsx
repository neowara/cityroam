import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { StyleSheet, ScrollView, RefreshControl, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { BlurView } from 'expo-blur';
import { Bike, Gauge, Zap, TrendingUp, Map as MapIcon, History, Radar, Hand, Route, ChevronRight } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { CityroamWordmark } from '@/components/ui/CityroamMark';
import { RouteMapThumbnail } from '@/features/rides/components/RouteMapThumbnail';
import { DeviceStatusHeader } from '@/features/device/components/DeviceStatusHeader';
import { modeColor } from '@/components/ui/ModeChip';
import { ModuleTitle } from '@/components/ui/ModuleTitle';
import { profileForDevId } from '@/features/device/deviceProfile';
import { ModeText } from '@/components/ui/ModeText';
import { WeatherBadge } from '@/components/ui/WeatherBadge';
import { SyncStatusBadge } from '@/features/rides/components/SyncStatusBadge';
import { Card, GlassFill } from '@/components/ui/Card';
import { FitText } from '@/components/ui/FitText';
import { LiveTripModule } from '@/features/rides/components/LiveTripModule';
import { StartTripModule } from '@/features/rides/components/StartTripModule';
import { BleConnectionIndicator } from '@/features/device/components/BleConnectionIndicator';
import { RangeEstimateModule } from '@/features/planner/components/RangeEstimateModule';
import { DeviceFilterRow } from '@/features/device/components/DeviceFilterRow';
import { PressableScale } from '@/components/ui/PressableScale';
import { StaggerReveal } from '@/components/ui/StaggerReveal';
import { ReadinessBanner } from '@/features/rides/components/ReadinessBanner';
import { UpdateBanner } from '@/features/updates/components/UpdateBanner';
import { fontStyleFor, useAppTheme } from '@/lib/theme';
import { estimateLifetimeKm } from '@/features/rides/odometer';
import { useSnapshot, useTrips, useTrip, useRefetchOnFocus } from '@/lib/queries';
import { useTripDeviceFilter } from '@/features/device/deviceFilter';
import { isLocalTripId } from '@/features/rides/localTrips';
import type { TripSummary } from '@/lib/api';
import { tripRecorder } from '@/features/rides/tripRecorder';
import { ensureBleConnected, useBleConnectionStatus } from '@/features/device/deviceLink';
import { weeklyStats } from '@/features/rides/activityStats';

function timeAgoLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isToday) return `Today, ${time}`;
  if (isYesterday) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })}, ${time}`;
}

// Module-level (not component-level) so this only resets on a fresh JS process —
// a genuine cold start, not every time the user navigates back to this tab. The
// component below captures its value once at mount (a ref, not read live), so
// every module in the same reveal pass agrees on whether to animate, then flips it
// so any later mount (tab re-focus, or a rare screen remount) never re-animates.
let hasPlayedDashboardEntrance = false;

export default function DashboardScreen() {
  const router = useRouter();
  const { accentColor: tint, font, containerStyle } = useAppTheme();
  const colorScheme = useColorScheme();
  const isGlass = containerStyle === 'glass';

  // Captured once at mount, not read live from the module flag on every render —
  // so every StaggerReveal in this render agrees on the same decision. Flipped for
  // any subsequent mount this app session. This app's tab navigator (app/(tabs)/
  // _layout.tsx) doesn't unmount inactive tabs today, so in practice Dashboard only
  // ever mounts once per session -- the module-level flag is defensive plumbing for
  // if that ever changes, not a live concern right now.
  const shouldAnimateEntrance = useRef(!hasPlayedDashboardEntrance).current;
  useEffect(() => {
    hasPlayedDashboardEntrance = true;
  }, []);

  const insets = useSafeAreaInsets();
  const ink = useThemeColor({}, 'text');
  const surface = useThemeColor({}, 'surface');
  const line = useThemeColor({}, 'line');
  const inkDim = useThemeColor({}, 'inkDim');
  const inkFaint = useThemeColor({}, 'inkFaint');
  const good = useThemeColor({}, 'good');
  const crit = useThemeColor({}, 'crit');

  const { data: snapshot, isRefetching, refetch } = useSnapshot();
  // Pull-to-refresh spinner state — kept separate from isRefetching so the snapshot
  // query's 2s background refetch doesn't flash the RefreshControl bubble constantly.
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const { deviceId } = useTripDeviceFilter();
  const { data: trips, refetch: refetchTrips } = useTrips(deviceId);
  useRefetchOnFocus(refetch);
  useRefetchOnFocus(refetchTrips);

  // The native SDK's autoConnect doesn't recover from a full board power-cycle on its
  // own (same reason _layout.tsx's BleReconnectGate exists for app-foreground) — a real
  // user report: after the board turned off and back on, it only reconnected once the
  // app itself was backgrounded and foregrounded. Landing on the Dashboard is another
  // natural "the user wants current board state" moment, so nudge reconnect here too.
  useFocusEffect(
    useCallback(() => {
      ensureBleConnected();
    }, []),
  );

  const recorder = useSyncExternalStore(tripRecorder.subscribe, tripRecorder.getSnapshot);
  const { online: bleOnline } = useBleConnectionStatus();

  const stats = trips ? weeklyStats(trips) : null;
  const lastTrip =
    trips && trips.length > 0
      ? trips.reduce((latest, t) => (new Date(t.startTime) > new Date(latest.startTime) ? t : latest), trips[0])
      : null;
  // Bug fix: used to start at index 1, skipping the most recent trip entirely since
  // it's also shown above in the "Last ride" hero card -- but that meant it never
  // appeared in the Recent Rides list at all. Now included (index 0) same as every
  // other recent trip; showing it twice (once as the hero, once at the top of the
  // list) is the intended behavior, not a duplicate-to-fix.
  const recentTrips = trips
    ? trips
        .slice()
        .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
        .slice(0, 4)
    : [];

  const { data: lastTripDetail } = useTrip(lastTrip?.id ?? 0);
  const odometerKm = estimateLifetimeKm(trips, snapshot?.mileageTotalKm);

  const mm = String(Math.floor(recorder.elapsedSec / 60)).padStart(2, '0');
  const ss = String(recorder.elapsedSec % 60).padStart(2, '0');

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl
          // Only the manual pull-to-refresh drives this spinner. The snapshot query's
          // 2s refetchInterval keeps isRefetching true every couple of seconds for the
          // live speedometer/battery — wiring that straight into `refreshing` made the
          // pull-to-refresh bubble appear constantly. The live-update affordance now
          // lives on the "Device connected" pill (BleConnectionIndicator's spinning
          // refresh icon) instead.
          refreshing={manualRefreshing}
          onRefresh={() => {
            ensureBleConnected();
            setManualRefreshing(true);
            refetch().finally(() => setManualRefreshing(false));
          }}
        />
      }>
      <View style={styles.content}>
        <StaggerReveal index={0} enabled={shouldAnimateEntrance}>
          <View style={[styles.topbar, { marginTop: insets.top + 8 }]}>
            <View style={styles.topbarText}>
              <CityroamWordmark size={36} cityColor={ink} roamColor={tint} />
              <DeviceStatusHeader online={bleOnline} snapshot={snapshot} />
            </View>
          </View>

          {/* Below the logo, never above it — nothing in this app renders above the wordmark. */}
          <ReadinessBanner />
          <UpdateBanner />

          <DeviceFilterRow />

          {/* Same shared BleConnectionIndicator component Settings uses, wrapped in the pill container. */}
          <View style={[styles.statusPill, styles.boardPill, { backgroundColor: surface, borderColor: tint + '55' }]}>
            <BleConnectionIndicator
              isRefetching={isRefetching}
              onPressUnpaired={() => router.push({ pathname: '/(tabs)/settings', params: { group: 'connection' } })}
            />
          </View>

          {/* One status line for both auto/manual recording, distinguished by icon (Radar = auto, Hand = manual) instead of a text suffix. */}
          <View style={[styles.statusPill, { backgroundColor: surface, borderColor: tint + '55' }]}>
            <View style={[styles.pillDot, { backgroundColor: recorder.state === 'manual' ? tint : good }]} />
            <Text style={[styles.pillText, { color: inkDim }]}>
              {recorder.state === 'idle' && (
                <>
                  {recorder.startBlockedReason === 'device-not-connected' && bleOnline !== true ? (
                    <>Device is offline. Trip not started.</>
                  ) : (
                    <>
                      Auto-tracking <Text style={{ color: undefined, fontWeight: '700' }}>ready</Text>. Start riding to record a trip.
                    </>
                  )}
                </>
              )}
              {(recorder.state === 'riding' ||
                recorder.state === 'manual' ||
                (recorder.state === 'stopped' && !recorder.isPausedForDisplay)) && (
                <>
                  Recording · {mm}:{ss} · {recorder.distanceKm.toFixed(2)} km
                </>
              )}
              {recorder.isPausedForDisplay && 'Ride paused. It saves automatically if you stay stopped.'}
            </Text>
            {recorder.state === 'manual' && <Hand size={14} color={tint} />}
            {recorder.state === 'riding' && <Radar size={14} color={good} />}
          </View>

          {/* only shown while actually recording — the highest-value spot to catch the silent "0 km, no route" failure mode while it's still happening. */}
          {(recorder.state === 'riding' || recorder.state === 'manual') && recorder.powerSaveModeOn && (
            <View style={[styles.statusPill, styles.warnPill, { backgroundColor: surface, borderColor: crit }]}>
              <View style={[styles.pillDot, { backgroundColor: crit }]} />
              <Text style={[styles.pillText, { color: crit }]}>
                Battery Saver is on, so location tracking can stop. Turn it off in Android Settings.
              </Text>
            </View>
          )}
        </StaggerReveal>

        <StaggerReveal index={1} enabled={shouldAnimateEntrance}>
          <View style={styles.moduleSpacing}>
            <PressableScale onPress={() => router.push('/(tabs)/planner')}>
              <Card>
                <View style={styles.plannerCardInner}>
                  <View style={[styles.plannerCardIcon, { backgroundColor: tint + '1A' }]}>
                    <Route size={20} color={tint} />
                  </View>
                  <View style={styles.plannerCardText}>
                    <Text style={[styles.plannerCardTitle, fontStyleFor(font)]}>Plan a trip</Text>
                    <Text style={[styles.plannerCardSubtitle, { color: inkDim }]}>
                      Tap the map, pick a destination, and check you have enough battery
                    </Text>
                  </View>
                  <ChevronRight size={18} color={inkDim} />
                </View>
              </Card>
            </PressableScale>
          </View>
        </StaggerReveal>

        {/* Wrapping View, not marginBottom on the Card itself — Card.tsx applies caller style to
          the inner glassInner view in glass mode, so margin there pads inside the card instead
          of spacing it from the next element (matches RangeEstimateModule's moduleSpacing).
          StartTripModule and LiveTripModule are mutually exclusive (idle vs. active trip),
          so they safely share the same reveal index. */}
        <StaggerReveal index={2} enabled={shouldAnimateEntrance}>
          <View style={styles.moduleSpacing}>
            <StartTripModule />
            <LiveTripModule />
          </View>
        </StaggerReveal>

        <StaggerReveal index={3} enabled={shouldAnimateEntrance}>
          <View style={styles.statGrid}>
            <StatCard
              icon={<Bike size={13} color={tint} />}
              label="This week"
              value={stats ? stats.distanceKm.toFixed(1) : '0.0'}
              unit="km"
              delta={
                // Checks this week's own data first, not just whether last week had data to compare against.
                stats && stats.lastWeekDistanceKm > 0
                  ? `${stats.distanceKm >= stats.lastWeekDistanceKm ? '↑' : '↓'} ${Math.abs(stats.distanceKm - stats.lastWeekDistanceKm).toFixed(1)} km vs last week`
                  : stats && stats.tripCount > 0
                    ? `${stats.tripCount} ride${stats.tripCount === 1 ? '' : 's'} this week`
                    : 'Start riding to add data'
              }
              deltaUp={!!stats && stats.distanceKm >= stats.lastWeekDistanceKm && stats.lastWeekDistanceKm > 0}
              accented
              tint={tint}
              good={good}
            />
            <StatCard
              icon={<Gauge size={13} color={tint} />}
              label="Avg speed"
              value={stats ? stats.avgSpeedKmh.toFixed(1) : '0.0'}
              unit="km/h"
              delta={
                stats && stats.tripCount > 0 ? `across ${stats.tripCount} ride${stats.tripCount === 1 ? '' : 's'}` : 'No rides this week'
              }
              tint={tint}
              good={good}
            />
            <StatCard
              icon={<Zap size={13} color={tint} />}
              label="Efficiency"
              value={stats?.efficiencyPctPerKm != null ? stats.efficiencyPctPerKm.toFixed(1) : '–'}
              unit="%/km"
              delta="battery used per km"
              tint={tint}
              good={good}
            />
            <StatCard
              icon={<TrendingUp size={13} color={tint} />}
              label="Odometer"
              value={odometerKm != null ? odometerKm.toFixed(1) : '–'}
              unit="km"
              delta="lifetime, live via BLE"
              tint={tint}
              good={good}
            />
          </View>
        </StaggerReveal>

        <StaggerReveal index={4} enabled={shouldAnimateEntrance}>
          <View style={styles.sectionHead}>
            <ModuleTitle icon={MapIcon}>Last ride</ModuleTitle>
          </View>
          {lastTrip ? (
            <View style={styles.tripCardWrap}>
              <PressableScale style={[styles.tripCard, { borderColor: tint + '55' }]} onPress={() => router.push(`/trip/${lastTrip.id}`)}>
                <RouteMapThumbnail route={lastTripDetail?.route} snappedRoute={lastTripDetail?.snappedRoute} width="100%" height={108} />
                {/* Only this text panel gets the glass treatment, not the map imagery above it. */}
                {isGlass ? (
                  <BlurView intensity={60} tint={colorScheme} blurMethod="none" style={styles.tripCardBody}>
                    <GlassFill />
                    <TripCardStats trip={lastTrip} stopsCount={lastTripDetail?.stops.length} inkDim={inkDim} font={font} />
                  </BlurView>
                ) : (
                  <View style={[styles.tripCardBody, { backgroundColor: surface }]}>
                    <TripCardStats trip={lastTrip} stopsCount={lastTripDetail?.stops.length} inkDim={inkDim} font={font} />
                  </View>
                )}
              </PressableScale>
              <SyncStatusBadge synced={!isLocalTripId(lastTrip.id)} size={13} />
            </View>
          ) : (
            <View style={[styles.tripCard, styles.emptyCard, { backgroundColor: surface, borderColor: line }]}>
              <Text style={{ color: inkFaint }}>Start riding to add data</Text>
            </View>
          )}
        </StaggerReveal>

        <StaggerReveal index={5} enabled={shouldAnimateEntrance}>
          <View style={styles.moduleSpacing}>
            <RangeEstimateModule />
          </View>
        </StaggerReveal>

        <StaggerReveal index={6} enabled={shouldAnimateEntrance}>
          <View style={styles.sectionHead}>
            <ModuleTitle icon={History}>Recent rides</ModuleTitle>
            <PressableScale onPress={() => router.push('/(tabs)/rides')}>
              <Text style={[styles.sectionHeadLink, { color: tint }]}>See all</Text>
            </PressableScale>
          </View>
          {recentTrips.length > 0 ? (
            <View style={styles.recentTripsList}>
              {recentTrips.map((trip) => (
                <RecentTripRow key={trip.id} trip={trip} />
              ))}
            </View>
          ) : (
            <Text style={{ color: inkFaint, fontSize: 13 }}>Start riding to add data</Text>
          )}
        </StaggerReveal>
      </View>
    </ScrollView>
  );
}

function TripCardStats({
  trip,
  stopsCount,
  inkDim,
  font,
}: {
  trip: TripSummary;
  stopsCount: number | undefined;
  inkDim: string;
  font: Parameters<typeof fontStyleFor>[0];
}) {
  return (
    <>
      <View style={styles.tripCardRow1}>
        <FitText style={[styles.tripCardDist, fontStyleFor(font)]}>
          {trip.distanceKm.toFixed(1)}
          <Text style={[styles.unit, { color: inkDim }]}> km</Text>
        </FitText>
        <View style={styles.tripCardWhenRow}>
          <WeatherBadge
            weatherCodes={trip.weatherCodes}
            feelsLikeC={trip.feelsLikeC}
            windSpeedMs={trip.windSpeedMs}
            size={12}
            color={inkDim}
          />
          <Text style={[styles.tripCardWhen, { color: inkDim }]}>{timeAgoLabel(trip.startTime)}</Text>
        </View>
      </View>
      <View style={styles.tripCardRow2}>
        <Text style={[styles.tripCardMeta, { color: inkDim }]}>
          Avg <Text style={styles.tripCardMetaBold}>{trip.avgSpeedKmh.toFixed(0)} km/h</Text>
        </Text>
        <Text style={[styles.tripCardMeta, { color: inkDim }]}>
          Max <Text style={styles.tripCardMetaBold}>{trip.maxSpeedKmh.toFixed(0)} km/h</Text>
        </Text>
        <Text style={[styles.tripCardMeta, { color: inkDim }]}>{Math.round(trip.durationSec / 60)} min</Text>
        <Text style={[styles.tripCardMeta, { color: inkDim }]}>
          {stopsCount ?? 0} stop{stopsCount === 1 ? '' : 's'}
        </Text>
      </View>
    </>
  );
}

const RecentTripRow = memo(function RecentTripRow({ trip }: { trip: TripSummary }) {
  const router = useRouter();
  const { data: detail } = useTrip(trip.id);
  const surface = useThemeColor({}, 'surface');
  const inkDim = useThemeColor({}, 'inkDim');
  const { font } = useAppTheme();
  const color = modeColor(trip.dominantMode, trip.modeMixed);

  return (
    <PressableScale onPress={() => router.push(`/trip/${trip.id}`)}>
      <Card style={styles.miniTrip}>
        <View style={styles.miniTripSwatchWrap}>
          <View style={styles.miniTripSwatchRadius}>
            <RouteMapThumbnail route={detail?.route} snappedRoute={detail?.snappedRoute} width={44} height={44} />
          </View>
          <View style={[styles.modeDot, { backgroundColor: color, borderColor: surface }]} />
          <SyncStatusBadge synced={!isLocalTripId(trip.id)} size={8} />
        </View>
        <View style={styles.miniTripInfo}>
          <FitText style={[styles.miniTripT1, fontStyleFor(font)]}>
            {trip.distanceKm.toFixed(1)} km · {Math.round(trip.durationSec / 60)} min ·{' '}
            {trip.modeMixed ? (
              <ModeText mode="eco" mixed modes={profileForDevId(trip.deviceId).rideModes} label="Mixed modes" />
            ) : trip.dominantMode ? (
              <>
                <ModeText mode={trip.dominantMode} /> mode
              </>
            ) : (
              'No mode data'
            )}
          </FitText>
          <View style={styles.miniTripT2Row}>
            <WeatherBadge
              weatherCodes={trip.weatherCodes}
              feelsLikeC={trip.feelsLikeC}
              windSpeedMs={trip.windSpeedMs}
              size={11}
              color={inkDim}
            />
            <Text style={[styles.miniTripT2, { color: inkDim }]}>{timeAgoLabel(trip.startTime)}</Text>
          </View>
        </View>
        <Text style={{ color: inkDim, fontSize: 15 }}>›</Text>
      </Card>
    </PressableScale>
  );
});

function StatCard({
  icon,
  label,
  value,
  unit,
  delta,
  deltaUp,
  accented,
  tint,
  good,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit: string;
  delta: string;
  deltaUp?: boolean;
  accented?: boolean;
  tint: string;
  good: string;
}) {
  const surface = useThemeColor({}, 'surface');
  const inkFaint = useThemeColor({}, 'inkFaint');
  const inkDim = useThemeColor({}, 'inkDim');
  const { font } = useAppTheme();

  return (
    <View
      style={[
        styles.statTile,
        { backgroundColor: surface, borderColor: tint + '55' },
        accented && { borderLeftWidth: 2.5, borderLeftColor: tint },
      ]}>
      <View style={styles.statTileLabelRow}>
        {icon}
        <Text style={[styles.statTileLabel, { color: inkFaint }]}>{label}</Text>
      </View>
      <FitText style={[styles.statTileValue, fontStyleFor(font)]}>
        {value}
        <Text style={[styles.unit, { color: inkDim }]}> {unit}</Text>
      </FitText>
      <Text style={[styles.statTileDelta, { color: deltaUp ? good : inkDim }]}>{delta}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // FloatingTabBar is absolutely positioned — reserve clearance so content doesn't render underneath it.
  content: { padding: 16, paddingTop: 12, paddingBottom: 110, gap: 0 },
  topbar: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 14 },
  topbarText: { gap: 1, flex: 1 },

  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginBottom: 16,
    maxWidth: '100%',
  },
  boardPill: { marginBottom: 8 },
  warnPill: { marginTop: -8 },
  pillDot: { width: 7, height: 7, borderRadius: 3.5 },
  pillText: { fontSize: 12, lineHeight: 15, flexShrink: 1 },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  statTile: { width: '48%', borderWidth: 1, borderRadius: 14, padding: 13 },
  statTileLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 6 },
  statTileLabel: { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: '600' },
  statTileValue: { fontSize: 24, fontVariant: ['tabular-nums'] },
  statTileDelta: { fontSize: 11, marginTop: 5 },
  unit: { fontSize: 13, fontWeight: '400' },

  sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 },
  sectionHeadLink: { fontSize: 12, fontWeight: '600' },

  tripCardWrap: { position: 'relative' },
  tripCard: { borderWidth: 1, borderRadius: 14, overflow: 'hidden', marginBottom: 10 },
  moduleSpacing: { marginBottom: 16 },
  emptyCard: { padding: 24, alignItems: 'center', justifyContent: 'center' },
  tripCardBody: { padding: 13, overflow: 'hidden', backgroundColor: 'transparent' },
  tripCardRow1: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
  tripCardDist: { fontSize: 19 },
  tripCardWhenRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tripCardWhen: { fontSize: 11.5 },
  tripCardRow2: { flexDirection: 'row', gap: 14 },
  tripCardMeta: { fontSize: 12 },
  tripCardMetaBold: { fontWeight: '600' },

  recentTripsList: { gap: 8 },
  miniTrip: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  miniTripSwatchWrap: { position: 'relative' },
  miniTripSwatchRadius: { borderRadius: 9, overflow: 'hidden' },
  modeDot: { position: 'absolute', bottom: -3, right: -3, width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
  miniTripInfo: { flex: 1 },
  miniTripT1: { fontSize: 13.5 },
  miniTripT2Row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 },
  miniTripT2: { fontSize: 11.5 },

  plannerCardInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  plannerCardIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  plannerCardText: { flex: 1, gap: 2 },
  plannerCardTitle: { fontSize: 15 },
  plannerCardSubtitle: { fontSize: 12, lineHeight: 15 },
});
