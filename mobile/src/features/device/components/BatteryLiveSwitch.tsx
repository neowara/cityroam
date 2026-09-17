import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BatteryMedium } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';

/**
 * Compact "live battery" switch that sits on the same row as the Range-by-mode /
 * By-mode titles, pushed to the right end of the row.
 *
 * Semantics: the switch is a two-position control whose
 * thumb points at whichever state is active. Layout is [battery icon] [switch] [live]:
 *  - thumb right / "live" lit green  = the board's current charge (live when
 *    connected, else the last known value) — scenario 'current';
 *  - thumb left / battery icon lit green = a hypothetical full battery — scenario 'full'.
 * Exactly one of the icon or the word is lit green at a time, matching the thumb side.
 */
export function BatteryLiveSwitch({
  live,
  onChange,
  style,
}: {
  /** true = current/live battery; false = full battery. */
  live: boolean;
  onChange: (live: boolean) => void;
  /** Optional style merged onto the outer row (e.g. to push it to the row's far end). */
  style?: StyleProp<ViewStyle>;
}) {
  const green = useThemeColor({}, 'good');
  const inkDim = useThemeColor({}, 'inkDim');
  const inkFaint = useThemeColor({}, 'inkFaint');

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: live }}
      accessibilityLabel={live ? 'Live battery' : 'Full battery'}
      onPress={() => onChange(!live)}
      hitSlop={8}
      style={[styles.row, style]}>
      <BatteryMedium size={14} color={live ? inkDim : green} />
      <View style={[styles.track, { backgroundColor: inkFaint + '44' }]}>
        <View
          style={[
            styles.thumb,
            live ? { backgroundColor: green, transform: [{ translateX: 14 }] } : { backgroundColor: green, transform: [{ translateX: 0 }] },
          ]}
        />
      </View>
      <Text style={[styles.label, { color: live ? green : inkDim }]}>live</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: { fontSize: 11.5, fontWeight: '600', textTransform: 'lowercase' },
  track: {
    width: 34,
    height: 20,
    borderRadius: 10,
    padding: 2,
  },
  thumb: {
    width: 16,
    height: 16,
    borderRadius: 8,
  },
});
