import { useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { Timer, WifiOff, ChevronRight } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { Card } from '@/components/ui/Card';
import { AppModal } from '@/components/ui/AppModal';
import { ConfirmModalBody } from '@/components/ui/ConfirmModalBody';
import { PressableScale } from '@/components/ui/PressableScale';
import { tripRecorder } from '@/features/rides/tripRecorder';
import { fontStyleFor, useAppTheme } from '@/lib/theme';
import { useDeviceNoun } from '@/features/device/deviceNoun';

/** Manual "start recording right now" action, styled to match the Dashboard's own
 * "Plan a trip" card exactly (same icon/title/subtitle layout). Only shown while idle —
 * once a trip is active (auto-detected or manual), LiveTripModule already owns that
 * surface (map, live stats, its own "Finish trip" action), so this never needs an "end
 * trip" counterpart of its own. */
export function StartTripModule() {
  const recorder = useSyncExternalStore(tripRecorder.subscribe, tripRecorder.getSnapshot);
  const { accentColor: tint, font } = useAppTheme();
  const inkDim = useThemeColor({}, 'inkDim');
  const warn = useThemeColor({}, 'warn');
  const noun = useDeviceNoun();
  const [deviceOfflineVisible, setDeviceOfflineVisible] = useState(false);

  if (recorder.state !== 'idle') return null;

  return (
    <>
      <AppModal visible={deviceOfflineVisible} onRequestClose={() => setDeviceOfflineVisible(false)}>
        <ConfirmModalBody
          icon={<WifiOff size={26} color={warn} />}
          title={`${noun.Cap} is offline`}
          body={`Connect your ${noun.lower} before starting a trip.`}
          confirmLabel="Got it"
          onConfirm={() => setDeviceOfflineVisible(false)}
        />
      </AppModal>
      <PressableScale
        onPress={() => {
          void tripRecorder.startManual().then((started) => {
            if (!started) setDeviceOfflineVisible(true);
          });
        }}>
        <Card>
          <View style={styles.inner}>
            <View style={[styles.icon, { backgroundColor: tint + '1A' }]}>
              <Timer size={20} color={tint} />
            </View>
            <View style={styles.text}>
              <Text style={[styles.title, fontStyleFor(font)]}>Start Trip</Text>
              <Text style={[styles.subtitle, { color: inkDim }]}>Manually start recording a ride right now</Text>
            </View>
            <ChevronRight size={18} color={inkDim} />
          </View>
        </Card>
      </PressableScale>
    </>
  );
}

// Matches the Dashboard's own plannerCard* styles exactly (app/(tabs)/index.tsx).
const styles = StyleSheet.create({
  inner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 15 },
  subtitle: { fontSize: 12, lineHeight: 15 },
});
