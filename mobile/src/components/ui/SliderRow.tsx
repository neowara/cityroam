import { StyleSheet, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { AlertTriangle, Check } from 'lucide-react-native';

import { Text } from '@/components/Themed';

export function SliderRow({
  label,
  dpId,
  value,
  draft,
  range,
  unit,
  confirmed,
  accentColor,
  inkDim,
  text,
  warn,
  good,
  justSaved,
  onChange,
  resetKey,
}: {
  label: string;
  dpId: string;
  value: number | null;
  draft: number | null;
  range: { min: number; max: number; step?: number };
  unit: string;
  confirmed: boolean;
  accentColor: string;
  inkDim: string;
  text: string;
  warn: string;
  good: string;
  justSaved: boolean;
  onChange: (v: number) => void;
  /** Bumped on Cancel to force a remount — the native slider doesn't re-sync its thumb
   * when `value` is numerically unchanged (dragging a stale draft, then clearing it). */
  resetKey: number;
}) {
  if (value == null) {
    return (
      <View style={styles.sliderRow}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={[styles.note, { color: inkDim }]}>No data yet</Text>
      </View>
    );
  }
  const changed = draft != null && draft !== value;
  return (
    <View style={styles.sliderRow}>
      <View style={styles.row}>
        <View style={styles.labelRow}>
          <Text style={styles.rowLabel}>{label}</Text>
          {!confirmed && (
            <View style={[styles.unconfirmedBadge, { borderColor: warn }]}>
              <AlertTriangle size={10} color={warn} />
              <Text style={[styles.unconfirmedText, { color: warn }]}>unconfirmed</Text>
            </View>
          )}
        </View>
        <View style={styles.valueRow}>
          {justSaved && <Check size={14} color={good} />}
          <Text style={[styles.rowValue, { color: changed ? accentColor : text }]}>
            {draft ?? value}
            {unit}
          </Text>
        </View>
      </View>
      <Slider
        key={`${dpId}-${resetKey}`}
        style={styles.slider}
        minimumValue={range.min}
        maximumValue={range.max}
        step={range.step ?? 1}
        value={value}
        onValueChange={onChange}
        minimumTrackTintColor={accentColor}
        maximumTrackTintColor={accentColor + '33'}
        thumbTintColor={accentColor}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  sliderRow: { paddingVertical: 4, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  note: { fontSize: 12, lineHeight: 17 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  rowLabel: { fontSize: 14 },
  unconfirmedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  unconfirmedText: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  rowValue: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  slider: { width: '100%', height: 32, marginTop: -6 },
});
