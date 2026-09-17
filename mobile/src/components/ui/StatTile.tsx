import { StyleSheet, View } from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { FitText } from '@/components/ui/FitText';
import { fontStyleFor, useAppTheme } from '@/lib/theme';

// Same bordered-square-card look as the Dashboard's own stat tiles (index.tsx's statTile style).
// `sub` is an optional second data line, e.g. Efficiency nesting battery-used instead of getting its own tile.
export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const { font } = useAppTheme();
  const surface = useThemeColor({}, 'surface');
  const line = useThemeColor({}, 'line');
  return (
    <View style={[styles.stat, { backgroundColor: surface, borderColor: line }]}>
      <FitText style={[styles.value, fontStyleFor(font)]}>{value}</FitText>
      <Text style={styles.label}>{label}</Text>
      {sub != null && <Text style={styles.sub}>{sub}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  stat: { flexGrow: 1, flexBasis: '30%', gap: 2, borderWidth: 1, borderRadius: 14, padding: 13 },
  value: { fontSize: 18, fontVariant: ['tabular-nums'] },
  sub: { fontSize: 12, opacity: 0.75, fontVariant: ['tabular-nums'] },
  label: { fontSize: 11, opacity: 0.6 },
});
