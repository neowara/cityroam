import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { ModeText } from '@/components/ui/ModeText';
import { MODE_META, MODE_ORDER } from '@/lib/mode';
import type { ModeSample } from '@/features/rides/tripTypes';

/** Time % per mode level, always visible on trip detail regardless of the dominant-mode chip shown elsewhere. */
export function ModeBreakdown({ modeSamples }: { modeSamples: ModeSample[] }) {
  if (modeSamples.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No mode data recorded for this trip.</Text>
      </View>
    );
  }

  const counts: Record<string, number> = {};
  for (const s of modeSamples) counts[s.mode] = (counts[s.mode] ?? 0) + 1;
  const total = modeSamples.length;

  const segments = MODE_ORDER.filter((m) => counts[m] > 0).map((mode) => ({
    mode,
    pct: (counts[mode] / total) * 100,
    ...MODE_META[mode],
  }));

  return (
    <View style={styles.container}>
      <View style={styles.bar}>
        {segments.map((s) => (
          <View key={s.mode} style={{ flex: s.pct, backgroundColor: s.color }} />
        ))}
      </View>
      <View style={styles.legend}>
        {segments.map((s) => (
          <View key={s.mode} style={styles.legendItem}>
            <View style={[styles.dot, { backgroundColor: s.color }]} />
            <Text style={styles.legendText}>
              <ModeText mode={s.mode} /> {s.pct.toFixed(0)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10 },
  bar: { flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 12, opacity: 0.75 },
  empty: { paddingVertical: 12, alignItems: 'center' },
  emptyText: { fontSize: 12, opacity: 0.5 },
});
