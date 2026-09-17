import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';

export function InfoRow({ label, value, text, last, note }: { label: string; value: string; text: string; last?: boolean; note?: string }) {
  // Real UX bug fixed here: the caption used to sit inline next to the value,
  // crowding label/value/note onto one line that wrapped badly on narrower fields
  // ("Direction  Forward  Loading options…" all fighting for the same row). A
  // second line below reads cleanly regardless of how long the note is.
  return (
    <View style={[styles.sliderRow, !last && styles.rowDivider]}>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={[styles.rowValue, { color: text }]}>{value}</Text>
      </View>
      {note && <Text style={styles.note}>{note}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  sliderRow: { paddingVertical: 4, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#8884' },
  rowLabel: { fontSize: 14 },
  rowValue: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  note: { fontSize: 12, lineHeight: 17 },
});
