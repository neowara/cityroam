import { ScrollView, StyleSheet } from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';
import { useTripDeviceFilter } from '@/features/device/deviceFilter';
import { useDeviceNoun } from '@/features/device/deviceNoun';

/** a device picker for trip/stat data, same spirit as the existing mode
 * filter chips. Gates its own rendering on `devices.length < 2` internally (not a
 * caller-side check) — a single-board install sees no new UI at all, same "don't
 * clutter the common single-board case" rule TuyaBlePairingCard's own switcher
 * follows. */
export function DeviceFilterRow() {
  const noun = useDeviceNoun();
  const { deviceId, setDeviceId, devices } = useTripDeviceFilter();
  const { accentColor } = useAppTheme();
  const inkDim = useThemeColor({}, 'inkDim');

  if (devices.length < 2) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.row} contentContainerStyle={styles.content}>
      <FilterPill
        label={`All ${noun.lowerPlural}`}
        active={deviceId == null}
        accentColor={accentColor}
        inkDim={inkDim}
        onPress={() => setDeviceId(null)}
      />
      {devices.map((d) => (
        <FilterPill
          key={d.devId}
          label={d.name || `Your ${noun.lower}`}
          active={d.devId === deviceId}
          accentColor={accentColor}
          inkDim={inkDim}
          onPress={() => setDeviceId(d.devId)}
        />
      ))}
    </ScrollView>
  );
}

function FilterPill({
  label,
  active,
  accentColor,
  inkDim,
  onPress,
}: {
  label: string;
  active: boolean;
  accentColor: string;
  inkDim: string;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      style={[styles.pill, { borderColor: active ? accentColor : inkDim + '55' }, active && { backgroundColor: accentColor + '18' }]}>
      <Text style={[styles.pillText, { color: active ? accentColor : inkDim }]} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: 12 },
  content: { gap: 6, paddingRight: 4 },
  pill: { borderRadius: 20, borderWidth: 1.5, paddingVertical: 6, paddingHorizontal: 12, maxWidth: 160 },
  pillText: { fontSize: 12, fontWeight: '600' },
});
