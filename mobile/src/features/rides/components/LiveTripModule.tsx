import { useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Radar, Hand, Gauge, MapPin, Square } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { BatteryLevelIcon } from '@/components/ui/BatteryLevelIcon';
import { Card } from '@/components/ui/Card';
import { AppModal } from '@/components/ui/AppModal';
import { ConfirmModalBody } from '@/components/ui/ConfirmModalBody';
import { FitText } from '@/components/ui/FitText';
import { ModeText } from '@/components/ui/ModeText';
import { PressableScale } from '@/components/ui/PressableScale';
import { TripMap } from '@/features/rides/components/TripMap';
import { WeatherBadge } from '@/components/ui/WeatherBadge';
import { getCachedLaunchLocation, subscribeLaunchLocation } from '@/features/rides/launchLocation';
import { MODE_META, decodeMode } from '@/lib/mode';
import { tripRecorder } from '@/features/rides/tripRecorder';
import { finishTripAndNavigate } from '@/features/rides/tripFinishUi';
import { useSnapshot } from '@/lib/queries';
import { fetchCurrentWeather } from '@/lib/weather';
import { fontStyleFor, useAppTheme } from '@/lib/theme';

function batteryColorFor(pct: number | null, good: string, warn: string, crit: string, fallback: string): string {
  if (pct == null) return fallback;
  if (pct <= 30) return crit;
  if (pct <= 60) return warn;
  return good;
}

// A launch-time fix older than this is more likely to mislead ("shows you at home
// while you're several blocks into a ride you started after leaving the app
// backgrounded for a while") than to help — past this age, no fallback beats a wrong one.
const LAUNCH_LOCATION_MAX_AGE_MS = 10 * 60_000;

// subscribeLaunchLocation's listener receives the new value directly (it has its own
// consumers outside React) — useSyncExternalStore instead wants a bare "something
// changed, go re-read getSnapshot" callback with no arguments. Defined once at module
// scope, not inline in the component: useSyncExternalStore requires a referentially
// stable subscribe function, and LiveTripModule re-renders on every recorder tick
// (several times a second while a trip is recording) — an inline arrow function here
// would resubscribe to the global launchLocation listener set on every single render.
function subscribeLaunchLocationForSyncStore(onStoreChange: () => void): () => void {
  return subscribeLaunchLocation(() => onStoreChange());
}

// The cached fix only while it's recent enough to stand in for the rider's position.
// Returns the same cached object (or null) between calls, as useSyncExternalStore needs;
// the recorder's frequent re-renders re-read it, so it drops out once it ages past the limit.
function getFreshLaunchLocation() {
  const cached = getCachedLaunchLocation();
  return cached && Date.now() - cached.timestampMs <= LAUNCH_LOCATION_MAX_AGE_MS ? cached : null;
}

// Only appears while a trip is actually recording, so "is this actually working" is answerable at a glance instead of after the ride.
export function LiveTripModule() {
  const recorder = useSyncExternalStore(tripRecorder.subscribe, tripRecorder.getSnapshot);
  // the live map's "current position" only ever came from recorder.route's
  // last point, which is empty for however long it takes the first couple of real GPS
  // fixes to land after a trip starts (or after a self-heal process restart mid-ride) —
  // the card showed a bare "No route recorded" placeholder the whole time, even though
  // the idle-tier GPS watch has been running (and the phone's last known position is
  // already cached) since well before the trip even started. Falls back to that cached
  // fix (age-gated above) so the map centers on the rider immediately instead of
  // staying blank, without risking showing a genuinely stale position as if it were live.
  const launchLocation = useSyncExternalStore(subscribeLaunchLocationForSyncStore, getFreshLaunchLocation);
  const { data: snapshot } = useSnapshot();
  const router = useRouter();
  const { accentColor: tint, font } = useAppTheme();
  const inkDim = useThemeColor({}, 'inkDim');
  const good = useThemeColor({}, 'good');
  const warn = useThemeColor({}, 'warn');
  const crit = useThemeColor({}, 'crit');
  const [confirmFinishVisible, setConfirmFinishVisible] = useState(false);

  // Rounded to ~1.1km precision so GPS jitter doesn't refetch on every sample. Must run before the early return below (hooks can't be conditional).
  const latestPoint = recorder.route[recorder.route.length - 1];
  const weatherLat = latestPoint ? Math.round(latestPoint.lat * 100) / 100 : null;
  const weatherLon = latestPoint ? Math.round(latestPoint.lon * 100) / 100 : null;
  const { data: weather } = useQuery({
    queryKey: ['live-weather', weatherLat, weatherLon],
    queryFn: () => fetchCurrentWeather(weatherLat!, weatherLon!),
    enabled: weatherLat != null && weatherLon != null,
    staleTime: 5 * 60_000,
  });

  const isActive = recorder.state === 'riding' || recorder.state === 'manual' || recorder.state === 'stopped';
  if (!isActive) return null;

  const mm = String(Math.floor(recorder.elapsedSec / 60)).padStart(2, '0');
  const ss = String(recorder.elapsedSec % 60).padStart(2, '0');
  const avgSpeedKmh = recorder.elapsedSec > 0 ? recorder.distanceKm / (recorder.elapsedSec / 3600) : 0;
  const currentBatteryPct = snapshot?.batteryPct ?? null;
  const batteryUsedPct =
    recorder.batteryStartPct != null && currentBatteryPct != null ? Math.max(0, recorder.batteryStartPct - currentBatteryPct) : null;
  const currentMode = snapshot?.mode ? decodeMode(snapshot.mode) : null;
  const modesUsed = recorder.modesUsed.map(decodeMode);
  // Board's own live speed sensor (dp2), not the GPS-integrated speed used for avg/max — responsive where GPS speed is noisy or near-zero.
  const currentSpeedKmh = snapshot?.speedKmh ?? null;

  const confirmFinish = () => setConfirmFinishVisible(true);

  return (
    <Card style={styles.cardInner}>
      <AppModal visible={confirmFinishVisible} onRequestClose={() => setConfirmFinishVisible(false)}>
        <ConfirmModalBody
          icon={<Square size={28} color={crit} />}
          title="Finish trip?"
          body="This saves the ride recorded so far."
          confirmLabel="Finish"
          destructive
          onConfirm={() => {
            setConfirmFinishVisible(false);
            void finishTripAndNavigate(router);
          }}
        />
      </AppModal>
      <View style={styles.header}>
        {recorder.state === 'manual' ? <Hand size={15} color={tint} /> : <Radar size={15} color={good} />}
        <Text style={styles.headerText}>{recorder.isPausedForDisplay ? 'Ride paused' : 'Recording your ride'}</Text>
        {weather && (
          <WeatherBadge
            weatherCodes={[weather.weatherCode]}
            feelsLikeC={weather.feelsLikeC}
            windSpeedMs={weather.windSpeedMs}
            size={13}
            color={inkDim}
          />
        )}
        <FitText style={[styles.headerTime, fontStyleFor(font), { color: inkDim }]}>
          {mm}:{ss}
        </FitText>
      </View>

      <View style={styles.mapWrap}>
        {/* Fresh array reference each render, since recorder.route is mutated in place and TripMap's memoization keys off reference, not contents. */}
        <TripMap
          route={[...recorder.route]}
          snappedRoute={null}
          stops={[]}
          follow
          currentPosition={
            latestPoint
              ? { lat: latestPoint.lat, lon: latestPoint.lon }
              : launchLocation
                ? { lat: launchLocation.lat, lon: launchLocation.lon }
                : null
          }
          currentPositionApproximate={!latestPoint}
        />
      </View>

      <View style={styles.statRow}>
        <View style={styles.stat}>
          <Gauge size={12} color={tint} />
          <FitText style={[styles.statValue, fontStyleFor(font), { color: tint }]}>
            {currentSpeedKmh != null ? currentSpeedKmh.toFixed(1) : '–'} <Text style={{ color: inkDim, fontSize: 11 }}>km/h now</Text>
          </FitText>
        </View>
        <View style={styles.stat}>
          <MapPin size={12} color={inkDim} />
          <FitText style={[styles.statValue, fontStyleFor(font)]}>{recorder.distanceKm.toFixed(2)} km</FitText>
        </View>
        <View style={styles.stat}>
          <Gauge size={12} color={inkDim} />
          <FitText style={[styles.statValue, fontStyleFor(font)]}>
            {avgSpeedKmh.toFixed(1)} <Text style={{ color: inkDim, fontSize: 11 }}>avg</Text>
          </FitText>
        </View>
        <View style={styles.stat}>
          <Gauge size={12} color={inkDim} />
          <FitText style={[styles.statValue, fontStyleFor(font)]}>
            {recorder.maxSpeedKmh.toFixed(1)} <Text style={{ color: inkDim, fontSize: 11 }}>max</Text>
          </FitText>
        </View>
        <View style={styles.stat}>
          <BatteryLevelIcon pct={currentBatteryPct} size={12} color={batteryColorFor(currentBatteryPct, good, warn, crit, inkDim)} />
          <FitText style={[styles.statValue, fontStyleFor(font)]}>
            {batteryUsedPct != null ? `${batteryUsedPct.toFixed(0)}% used` : '–'}
          </FitText>
        </View>
      </View>

      {(currentMode || modesUsed.length > 0) && (
        <View style={styles.modesRow}>
          <Text style={[styles.modesLabel, { color: inkDim }]}>
            {currentMode ? (
              <>
                Mode: <ModeText mode={currentMode} />
              </>
            ) : (
              'Modes'
            )}
          </Text>
          {modesUsed.map((mode) => {
            const meta = MODE_META[mode];
            const isCurrent = mode === currentMode;
            return <View key={mode} style={[styles.modeDot, { backgroundColor: meta?.color ?? inkDim, opacity: isCurrent ? 1 : 0.4 }]} />;
          })}
        </View>
      )}

      <PressableScale style={[styles.finishButton, { backgroundColor: tint }]} onPress={confirmFinish}>
        <Text style={styles.finishButtonText}>Finish trip</Text>
      </PressableScale>
    </Card>
  );
}

const styles = StyleSheet.create({
  cardInner: { gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  headerText: { fontSize: 14, lineHeight: 18, fontWeight: '600', flex: 1 },
  headerTime: { fontSize: 14, lineHeight: 18, fontVariant: ['tabular-nums'] },
  mapWrap: { height: 160, borderRadius: 10, overflow: 'hidden' },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between' },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statValue: { fontSize: 13, lineHeight: 17, fontVariant: ['tabular-nums'] },
  modesRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  modesLabel: { fontSize: 11, lineHeight: 14 },
  modeDot: { width: 9, height: 9, borderRadius: 4.5 },
  finishButton: { borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  finishButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
