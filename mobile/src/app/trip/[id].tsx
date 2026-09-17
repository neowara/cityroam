import { useState } from 'react';
import { StyleSheet, ScrollView, ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BatteryMedium, CloudUpload, Gauge, HeartPulse, Map as MapIcon, Trash2, TrendingUp, Zap } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { Card } from '@/components/ui/Card';
import { AppModal } from '@/components/ui/AppModal';
import { ConfirmModalBody } from '@/components/ui/ConfirmModalBody';
import { PressableScale } from '@/components/ui/PressableScale';
import { RefreshSpinButton } from '@/components/ui/RefreshSpinButton';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { StatusBarScrim } from '@/components/ui/StatusBarScrim';
import { StatTile } from '@/components/ui/StatTile';
import { ModeChip } from '@/components/ui/ModeChip';
import { WeatherBadge } from '@/components/ui/WeatherBadge';
import { SyncStatusBadge } from '@/features/rides/components/SyncStatusBadge';
import { SyncRequiredOverlay } from '@/components/ui/SyncRequiredOverlay';
import { TripMap } from '@/features/rides/components/TripMap';
import { ModeBreakdown } from '@/features/rides/components/ModeBreakdown';
import { VoltageGraph } from '@/features/rides/components/VoltageGraph';
import { ElevationChart } from '@/features/rides/components/ElevationChart';
import { TripByModeModule } from '@/features/rides/components/TripByModeModule';
import { profileForDevId } from '@/features/device/deviceProfile';
import { useDeleteTrip, useTrip, useTripElevation, useRefreshTripVitals, useSyncTrip } from '@/lib/queries';
import { isLocalTripId, localIdFromTripId } from '@/features/rides/localTrips';
import { formatDateTime } from '@/lib/dateFormat';
import { GLASS_GRADIENT, useAppTheme } from '@/lib/theme';
import { useColorScheme } from '@/components/useColorScheme';
import { FloatingBackHeader, PILL_TOP_OFFSET, PILL_CLEARANCE } from '@/components/ui/FloatingBackHeader';
import { getHealthConnectPermissionStatus, isHealthConnectAvailable } from '@/features/health/healthConnect';
import { useAppForegroundEffect } from '@/lib/useAppForeground';

const NO_HR_TEXT = 'No HR data found in Health Connect for this trip';

// Real in-app map, mode-breakdown bars, and voltage-over-time graph are
// all live. Vitals show real data when available, or an explanatory placeholder
// instead of just disappearing when there's nothing to show.
export default function TripDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: trip, error, isPending } = useTrip(Number(id));
  const { data: elevationRoute } = useTripElevation(Number(id));
  const deleteTrip = useDeleteTrip();
  const refreshVitals = useRefreshTripVitals(trip);
  const syncTrip = useSyncTrip();
  const [healthConnectAvailable, setHealthConnectAvailable] = useState(false);
  const [healthConnectGranted, setHealthConnectGranted] = useState(false);
  // ScrollView wins the vertical gesture axis against MapLibre's own pan — disable page scroll while a touch is on the map, standard workaround.
  const [pageScrollEnabled, setPageScrollEnabled] = useState(true);
  const [confirmDeleteVisible, setConfirmDeleteVisible] = useState(false);
  const { accentColor, containerStyle } = useAppTheme();
  const colorScheme = useColorScheme() ?? 'light';
  const isGlass = containerStyle === 'glass';
  const insets = useSafeAreaInsets();
  const inkDim = useThemeColor({}, 'inkDim');
  const crit = useThemeColor({}, 'crit');
  const axisTextColor = useThemeColor({}, 'text');

  useAppForegroundEffect(() => {
    isHealthConnectAvailable().then(setHealthConnectAvailable);
    getHealthConnectPermissionStatus().then(setHealthConnectGranted);
  });

  if (error) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.error}>{String((error as Error).message ?? error)}</Text>
      </View>
    );
  }

  if (isPending) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const hasVitals =
    trip.heartRateAvgBpm != null ||
    trip.heartRateMaxBpm != null ||
    trip.heartRateStartBpm != null ||
    trip.heartRateEndBpm != null ||
    trip.restingHeartRateBpm != null ||
    trip.heartRateVariabilityMs != null ||
    trip.steps != null ||
    trip.weightKg != null;

  const hasAnyHr =
    trip.heartRateAvgBpm != null ||
    trip.heartRateMaxBpm != null ||
    trip.heartRateStartBpm != null ||
    trip.heartRateEndBpm != null ||
    trip.restingHeartRateBpm != null ||
    trip.heartRateVariabilityMs != null;

  const confirmDelete = () => setConfirmDeleteVisible(true);
  const synced = !isLocalTripId(trip.id);
  // Shared by the top-level "Not backed up yet" card and every locked-module overlay
  // below — all three are the same action (upload this trip), just triggered from
  // wherever the rider happened to be looking on the screen.
  const retrySync = () =>
    syncTrip.mutate(localIdFromTripId(trip.id), {
      onSuccess: (saved) => router.replace(`/trip/${saved.id}`),
    });

  return (
    <View style={styles.screen}>
      {isGlass && (
        <LinearGradient colors={GLASS_GRADIENT[colorScheme]} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
      )}
      <StatusBarScrim />
      <AppModal visible={confirmDeleteVisible} onRequestClose={() => setConfirmDeleteVisible(false)}>
        <ConfirmModalBody
          icon={<Trash2 size={28} color={crit} />}
          title="Delete this trip?"
          body="It'll move to Deleted trips in Settings, recoverable for 7 days, then removed for good."
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            setConfirmDeleteVisible(false);
            deleteTrip.mutate(trip.id, { onSuccess: () => router.back() });
          }}
        />
      </AppModal>
      <ScrollView style={styles.container} scrollEnabled={pageScrollEnabled}>
        <View style={[styles.content, { paddingTop: insets.top + PILL_TOP_OFFSET + PILL_CLEARANCE }]}>
          <Text style={styles.title}>
            {trip.distanceKm.toFixed(1)} km · {(trip.durationSec / 60).toFixed(0)} min
          </Text>
          <View style={styles.subtitleRow}>
            <Text style={styles.subtitle}>{formatDateTime(trip.startTime)}</Text>
            <ModeChip dominantMode={trip.dominantMode} mixed={trip.modeMixed} />
            <WeatherBadge weatherCodes={trip.weatherCodes} feelsLikeC={trip.feelsLikeC} windSpeedMs={trip.windSpeedMs} color={inkDim} />
            <SyncStatusBadge synced={synced} size={13} inline />
          </View>

          {!synced && (
            <Card style={styles.syncCard}>
              <View style={styles.syncCardRow}>
                <CloudUpload size={18} color={crit} />
                <View style={styles.syncCardText}>
                  <Text style={styles.syncCardTitle}>Not backed up yet</Text>
                  <Text style={[styles.subtitle, { color: inkDim }]}>
                    This trip only exists on this device. Upload it so it's never lost.
                  </Text>
                </View>
              </View>
              <PressableScale style={[styles.button, { backgroundColor: accentColor }]} onPress={retrySync} disabled={syncTrip.isPending}>
                <Text style={styles.buttonText}>{syncTrip.isPending ? 'Uploading…' : 'Upload trip to server'}</Text>
              </PressableScale>
              {syncTrip.isError && (
                <Text style={[styles.subtitle, { color: crit, marginTop: 8 }]}>{(syncTrip.error as Error).message}</Text>
              )}
            </Card>
          )}

          <View
            onTouchStart={() => setPageScrollEnabled(false)}
            onTouchEnd={() => setPageScrollEnabled(true)}
            onTouchCancel={() => setPageScrollEnabled(true)}>
            <TripMap route={trip.route} snappedRoute={trip.snappedRoute} stops={trip.stops} />
          </View>

          <View style={styles.grid}>
            <StatTile label="Avg speed" value={`${trip.avgSpeedKmh.toFixed(1)} km/h`} />
            <StatTile label="Max speed" value={`${trip.maxSpeedKmh.toFixed(1)} km/h`} />
            {/* Same %/km formula as Dashboard's Efficiency tile (activityStats.ts), per-trip instead of weekly. */}
            <StatTile
              label="Efficiency"
              value={trip.batteryUsedPct != null && trip.distanceKm > 0 ? `${(trip.batteryUsedPct / trip.distanceKm).toFixed(1)}%/km` : '–'}
              sub={trip.batteryUsedPct != null ? `${trip.batteryUsedPct.toFixed(0)}% used` : undefined}
            />
            <StatTile label="Stops" value={String(trip.stops.length)} />
            <StatTile label="Odometer start" value={trip.odometerStartKm != null ? `${trip.odometerStartKm} km` : '–'} />
            <StatTile label="Odometer end" value={trip.odometerEndKm != null ? `${trip.odometerEndKm} km` : '–'} />
          </View>

          <View style={styles.cardsGap}>
            <Card>
              <SectionLabel icon={Gauge}>Mode breakdown</SectionLabel>
              <ModeBreakdown modeSamples={trip.modeSamples} />
            </Card>

            <Card>
              <SectionLabel icon={Zap}>Voltage over time</SectionLabel>
              <VoltageGraph
                voltageSamples={trip.voltageSamples}
                tripStartMs={new Date(trip.startTime).getTime()}
                plausibleVoltageV={profileForDevId(trip.deviceId).plausibleVoltageV}
              />
            </Card>

            <Card>
              <SectionLabel icon={TrendingUp}>Elevation profile</SectionLabel>
              <ElevationChart
                route={synced ? (elevationRoute ?? []) : []}
                accentColor={accentColor}
                axisTextColor={axisTextColor}
                unavailableReason={synced ? undefined : 'Sync this trip to see its elevation profile.'}
              />
              {!synced && <SyncRequiredOverlay onRetry={retrySync} retrying={syncTrip.isPending} />}
            </Card>

            {synced ? (
              <TripByModeModule tripId={trip.id} rideModes={profileForDevId(trip.deviceId).rideModes} />
            ) : (
              <Card>
                <SectionLabel icon={BatteryMedium}>Cost by mode</SectionLabel>
                <View style={styles.lockedModulePlaceholder} />
                <SyncRequiredOverlay onRetry={retrySync} retrying={syncTrip.isPending} />
              </Card>
            )}

            <Card>
              <View style={styles.cardHead}>
                <SectionLabel icon={HeartPulse}>Vitals</SectionLabel>
                {synced && healthConnectAvailable && healthConnectGranted && !hasAnyHr && (
                  <View style={{ marginLeft: 'auto' }}>
                    <RefreshSpinButton
                      onPress={() => refreshVitals.mutate()}
                      spinning={refreshVitals.isPending}
                      disabled={refreshVitals.isPending}
                      size={12}
                      color={inkDim}
                    />
                  </View>
                )}
              </View>
              {hasVitals ? (
                <View style={styles.grid}>
                  {trip.heartRateStartBpm != null && <StatTile label="Start HR" value={`${trip.heartRateStartBpm} bpm`} />}
                  {trip.heartRateEndBpm != null && <StatTile label="End HR" value={`${trip.heartRateEndBpm} bpm`} />}
                  {trip.heartRateAvgBpm != null && <StatTile label="Avg HR" value={`${trip.heartRateAvgBpm} bpm`} />}
                  {trip.heartRateMaxBpm != null && <StatTile label="Max HR" value={`${trip.heartRateMaxBpm} bpm`} />}
                  {trip.restingHeartRateBpm != null && <StatTile label="Resting HR" value={`${trip.restingHeartRateBpm} bpm`} />}
                  {trip.heartRateVariabilityMs != null && <StatTile label="HRV" value={`${trip.heartRateVariabilityMs} ms`} />}
                  {trip.steps != null && <StatTile label="Steps" value={String(trip.steps)} />}
                  {trip.weightKg != null && <StatTile label="Weight" value={`${trip.weightKg.toFixed(2)} kg`} />}
                </View>
              ) : !healthConnectAvailable ? (
                <Text style={styles.placeholder}>Health Connect isn't available on this device, so vitals can't be shown.</Text>
              ) : !healthConnectGranted ? (
                <>
                  <Text style={styles.placeholder}>Connect Health Connect to see heart rate, steps, and weight on future rides.</Text>
                  <Text
                    style={[styles.linkText, { color: accentColor }]}
                    onPress={() => router.push({ pathname: '/(tabs)/settings', params: { group: 'health' } })}>
                    Open Settings →
                  </Text>
                </>
              ) : healthConnectAvailable && healthConnectGranted && !hasAnyHr ? (
                <Text style={styles.placeholder}>{NO_HR_TEXT}</Text>
              ) : (
                <Text style={styles.placeholder}>No health data found for this ride's time window.</Text>
              )}
              {hasVitals && healthConnectAvailable && healthConnectGranted && !hasAnyHr && (
                <Text style={styles.placeholder}>{NO_HR_TEXT}</Text>
              )}
            </Card>
          </View>
        </View>
      </ScrollView>
      <FloatingBackHeader
        icon={MapIcon}
        title="Trip detail"
        onPress={() => router.back()}
        right={
          // Deleting a trip that's only in the local queue isn't wired up yet — sync it
          // first, same as the offline queue's own default state.
          synced ? (
            <PressableScale onPress={confirmDelete} hitSlop={10} disabled={deleteTrip.isPending}>
              <Trash2 size={19} color={inkDim} />
            </PressableScale>
          ) : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { flex: 1 },
  content: { padding: 20, gap: 16 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardsGap: { gap: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  error: { color: '#e5484d', textAlign: 'center' },
  title: { fontSize: 20, fontWeight: '700' },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: -10 },
  subtitle: { fontSize: 13, opacity: 0.6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  placeholder: { fontSize: 13, opacity: 0.6, lineHeight: 18 },
  linkText: { fontSize: 13, marginTop: 4 },
  syncCard: { marginTop: 4 },
  // Matches the roughly-empty-chart height the elevation card already sits at when it
  // has no data, so the locked "Cost by mode" card doesn't look tiny/broken next to it.
  lockedModulePlaceholder: { height: 90 },
  syncCardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 },
  syncCardText: { flex: 1, gap: 2 },
  syncCardTitle: { fontSize: 14, fontWeight: '600' },
  button: { borderRadius: 10, padding: 13, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
});
