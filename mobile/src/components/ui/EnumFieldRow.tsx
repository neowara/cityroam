import { StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';

import { Text } from '@/components/Themed';
import { humanizeEnumValue } from '@/features/device/boardValue';
import { useDeviceNoun } from '@/features/device/deviceNoun';
import type { BoardDpSchema } from '@/features/device/deviceLink';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { InfoRow } from '@/components/ui/InfoRow';

export type FieldRowProps = {
  label: string;
  dpId: string;
  rawDps: Record<string, unknown> | null;
  drafts: Record<string, number | string>;
  schema: Record<string, BoardDpSchema> | null;
  accentColor: string;
  inkDim: string;
  text: string;
  good: string;
  justSaved: boolean;
  onChange: (v: number | string) => void;
  last?: boolean;
};

/** Real allowed values, straight from the device's own schema (schema[dpId].range)
 * — a sliding segmented toggle ([Km][Miles]-style), not free text, since Tuya
 * defines a fixed option set for these (Direction: forward/backward, Motor type:
 * belt/hub, Distance unit: km/mile — real device-confirmed values, not guessed).
 * Falls back to a plain read-only row (same as this section rendered before) while
 * the schema is still loading or unavailable. */
export function EnumFieldRow({
  label,
  dpId,
  rawDps,
  drafts,
  schema,
  accentColor,
  inkDim,
  text,
  good,
  justSaved,
  onChange,
  last,
}: FieldRowProps) {
  const noun = useDeviceNoun();
  const raw = rawDps?.[dpId];
  const rawStr = typeof raw === 'string' ? raw : null;
  const draft = typeof drafts[dpId] === 'string' ? (drafts[dpId] as string) : null;

  if (rawStr == null) {
    return (
      <View style={[styles.row, !last && styles.rowDivider]}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={[styles.note, { color: inkDim }]}>No data yet</Text>
      </View>
    );
  }

  const entry = schema?.[dpId];
  if (!entry || !entry.range || entry.range.length === 0) {
    return (
      <InfoRow
        label={label}
        value={humanizeEnumValue(rawStr)}
        text={text}
        last={last}
        note={!schema ? `Loading real options from the ${noun.lower}…` : undefined}
      />
    );
  }

  const current = draft ?? rawStr;
  return (
    <View style={[styles.sliderRow, !last && styles.rowDivider]}>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>{label}</Text>
        {justSaved && <Check size={14} color={good} />}
      </View>
      <SegmentedControl options={entry.range} value={current} onChange={onChange} accentColor={accentColor} inkDim={inkDim} text={text} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#8884' },
  rowLabel: { fontSize: 14 },
  sliderRow: { paddingVertical: 4, gap: 2 },
  note: { fontSize: 12, lineHeight: 17 },
});
