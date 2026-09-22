import { StyleSheet, FlatList, ActivityIndicator, RefreshControl, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ListOrdered } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { Card } from '@/components/ui/Card';
import { PressableScale } from '@/components/ui/PressableScale';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { ModeChip } from '@/components/ui/ModeChip';
import { profileForDevId } from '@/features/device/deviceProfile';
import { WeatherBadge } from '@/components/ui/WeatherBadge';
import { SyncStatusBadge } from '@/features/rides/components/SyncStatusBadge';
import { ApiNotConfiguredError } from '@/lib/api';
import { useTrips, useRefetchOnFocus } from '@/lib/queries';
import { useTripDeviceFilter } from '@/features/device/deviceFilter';
import { isLocalTripId } from '@/features/rides/localTrips';
import { formatDateTime } from '@/lib/dateFormat';

export default function RidesScreen() {
  const router = useRouter();
  const { deviceId } = useTripDeviceFilter();
  const { data: trips, error, isPending, isRefetching, refetch } = useTrips(deviceId);
  const inkDim = useThemeColor({}, 'inkDim');
  useRefetchOnFocus(refetch);

  if (error) {
    return (
      <View style={styles.center}>
        <ScreenHeader icon={ListOrdered} title="Rides" />
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

  if (trips.length === 0) {
    return (
      <View style={styles.centerWithHeader}>
        <ScreenHeader icon={ListOrdered} title="Rides" />
        <View style={styles.center}>
          <Text style={styles.empty}>No rides yet</Text>
        </View>
      </View>
    );
  }

  return (
    <FlatList
      data={trips}
      keyExtractor={(t) => String(t.id)}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <>
          <ScreenHeader icon={ListOrdered} title="Rides" />
        </>
      }
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} />}
      renderItem={({ item }) => (
        <PressableScale onPress={() => router.push(`/trip/${item.id}`)} style={styles.cardWrap}>
          <Card>
            <View style={styles.row}>
              <View style={styles.rowInfo}>
                <Text style={styles.t1}>
                  {item.distanceKm.toFixed(1)} km · {(item.durationSec / 60).toFixed(0)} min
                </Text>
                <View style={styles.rowMeta}>
                  <Text style={styles.t2}>{formatDateTime(item.startTime)}</Text>
                  <ModeChip dominantMode={item.dominantMode} mixed={item.modeMixed} modes={profileForDevId(item.deviceId).rideModes} />
                  <WeatherBadge
                    weatherCodes={item.weatherCodes}
                    feelsLikeC={item.feelsLikeC}
                    windSpeedMs={item.windSpeedMs}
                    size={11}
                    color={inkDim}
                  />
                </View>
              </View>
              <Text style={styles.chev}>›</Text>
            </View>
          </Card>
          <SyncStatusBadge synced={!isLocalTripId(item.id)} />
        </PressableScale>
      )}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  centerWithHeader: { flex: 1, padding: 16 },
  error: { color: '#e5484d', textAlign: 'center' },
  empty: { opacity: 0.5 },
  // Floating dock nav bar is absolutely positioned — reserve clearance so the last row
  // doesn't render underneath it (see index.tsx's `content` style for the same fix).
  list: { padding: 16, paddingBottom: 110, gap: 10 },
  cardWrap: { position: 'relative' },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowInfo: { flex: 1 },
  t1: { fontSize: 15, fontWeight: '600' },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  t2: { fontSize: 12, opacity: 0.6 },
  chev: { fontSize: 18, opacity: 0.4 },
});
