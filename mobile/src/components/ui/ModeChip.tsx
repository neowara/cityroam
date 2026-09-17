import { StyleSheet, View } from 'react-native';

import { MODE_META, MODE_ORDER, type Mode } from '@/lib/mode';
import { ModeText } from '@/components/ui/ModeText';

// The Mode domain (identity/order/labels/colors/icons/decode) lives in src/lib/mode.ts
// as the single source of truth; re-exported here so callers importing from this component
// keep working unchanged. modeFromRawLevel is an alias for mode.ts's decodeMode (same
// level_1..4 -> eco/ride/speed/turbo table as the backend's LEVEL_TO_MODE).
export { MODE_META, decodeMode as modeFromRawLevel, modeColor } from '@/lib/mode';

/** A single mode chip, or a "Mixed modes" swatch with one segment per mode the ride's
 * device has (`modes`, from its device profile). */
export function ModeChip({
  dominantMode,
  mixed,
  modes = MODE_ORDER,
}: {
  dominantMode: string | null;
  mixed: boolean;
  modes?: readonly Mode[];
}) {
  if (mixed) {
    return (
      <View style={styles.chip}>
        <View style={styles.mixedSwatch}>
          {modes.map((m) => (
            <View key={m} style={[styles.mixedSegment, { backgroundColor: MODE_META[m].color }]} />
          ))}
        </View>
        <ModeText mode="eco" mixed modes={modes} label="Mixed modes" style={styles.label} />
      </View>
    );
  }

  if (!dominantMode) return null;
  const meta = MODE_META[dominantMode] ?? { label: dominantMode, color: '#8888' };
  return (
    <View style={styles.chip}>
      <View style={[styles.dot, { backgroundColor: meta.color }]} />
      <ModeText mode={dominantMode} style={styles.label} />
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  mixedSwatch: { flexDirection: 'row', width: 14, height: 8, borderRadius: 2, overflow: 'hidden' },
  mixedSegment: { flex: 1 },
  label: { fontSize: 11, opacity: 0.7 },
});
