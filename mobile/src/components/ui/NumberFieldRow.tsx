import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { Check, ChevronRight } from 'lucide-react-native';

import { Text } from '@/components/Themed';
import { AppModal } from '@/components/ui/AppModal';
import { PressableScale } from '@/components/ui/PressableScale';
import type { FieldRowProps } from '@/components/ui/EnumFieldRow';
import { encodeScaled, formatScaled } from '@/features/device/boardValue';
import { useDeviceNoun } from '@/features/device/deviceNoun';

/** Row shows the current value + chevron; tapping opens a modal. Once the device's
 * schema gives a real min/max/step, the modal is a bounded Slider; falls back to a
 * free-typed number only while schema hasn't loaded yet. */
export function NumberFieldRow({
  label,
  dpId,
  rawDps,
  drafts,
  schema,
  fallbackUnit,
  accentColor,
  inkDim,
  text,
  good,
  justSaved,
  onChange,
  last,
}: FieldRowProps & { fallbackUnit: string }) {
  const noun = useDeviceNoun();
  const raw = rawDps?.[dpId];
  const rawNum = typeof raw === 'number' ? raw : null;
  const entry = schema?.[dpId];
  const hasRange = !!entry && entry.min != null && entry.max != null;
  const scale = hasRange ? (entry!.scale ?? 0) : 0;
  const draftRaw = typeof drafts[dpId] === 'number' ? (drafts[dpId] as number) : null;
  const currentRaw = draftRaw ?? rawNum;
  const realText = (raw: number) => formatScaled(raw, scale);

  const [modalVisible, setModalVisible] = useState(false);
  const [sliderValue, setSliderValue] = useState(0);
  const [buffer, setBuffer] = useState('');

  if (rawNum == null) {
    return (
      <View style={[styles.row, !last && styles.rowDivider]}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={[styles.note, { color: inkDim }]}>No data yet</Text>
      </View>
    );
  }

  const displayUnit = (hasRange && entry!.unit) || fallbackUnit;
  const changed = draftRaw != null && draftRaw !== rawNum;

  const openModal = () => {
    if (hasRange) setSliderValue(currentRaw ?? entry!.min!);
    else setBuffer(currentRaw != null ? realText(currentRaw) : '');
    setModalVisible(true);
  };

  const commitSlider = () => {
    onChange(sliderValue);
    setModalVisible(false);
  };

  const commitText = () => {
    const parsed = parseFloat(buffer.replace(',', '.'));
    if (!Number.isNaN(parsed)) onChange(encodeScaled(parsed, scale));
    setModalVisible(false);
  };

  return (
    <>
      <PressableScale style={[styles.row, !last && styles.rowDivider]} onPress={openModal}>
        <Text style={styles.rowLabel}>{label}</Text>
        <View style={styles.valueRow}>
          {justSaved && <Check size={14} color={good} />}
          <Text style={[styles.rowValue, { color: changed ? accentColor : text }]}>
            {currentRaw != null ? realText(currentRaw) : '—'}
            {displayUnit ? ` ${displayUnit}` : ''}
          </Text>
          <ChevronRight size={16} color={inkDim} />
        </View>
      </PressableScale>

      <AppModal visible={modalVisible} onRequestClose={() => setModalVisible(false)} contentStyle={modalStyles.card}>
        <Text style={[modalStyles.title, { color: text }]}>{label}</Text>
        {hasRange ? (
          <>
            <Text style={[styles.modalValueText, { color: accentColor }]}>
              {realText(sliderValue)}
              {displayUnit ? ` ${displayUnit}` : ''}
            </Text>
            <Slider
              style={styles.modalSlider}
              minimumValue={entry!.min!}
              maximumValue={entry!.max!}
              step={entry!.step ?? 1}
              value={sliderValue}
              onValueChange={setSliderValue}
              minimumTrackTintColor={accentColor}
              maximumTrackTintColor={accentColor + '33'}
              thumbTintColor={accentColor}
            />
            <PressableScale style={[modalStyles.confirmButton, { backgroundColor: accentColor }]} onPress={commitSlider}>
              <Text style={modalStyles.confirmText}>Save</Text>
            </PressableScale>
          </>
        ) : (
          <>
            <View style={styles.modalInputRow}>
              <TextInput
                value={buffer}
                onChangeText={setBuffer}
                keyboardType="decimal-pad"
                autoFocus
                selectTextOnFocus
                onSubmitEditing={commitText}
                style={[styles.modalInput, { color: text, borderColor: inkDim + '44' }]}
              />
              {!!displayUnit && <Text style={[styles.rowValue, { color: inkDim }]}>{displayUnit}</Text>}
            </View>
            {!schema && <Text style={[modalStyles.body, { color: inkDim, fontSize: 12 }]}>Loading real range from the {noun.lower}…</Text>}
            <PressableScale style={[modalStyles.confirmButton, { backgroundColor: accentColor }]} onPress={commitText}>
              <Text style={modalStyles.confirmText}>Save</Text>
            </PressableScale>
          </>
        )}
      </AppModal>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#8884' },
  rowLabel: { fontSize: 14 },
  rowValue: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  note: { fontSize: 12, lineHeight: 17 },
  modalInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch' },
  modalInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 20,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  modalValueText: { fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  modalSlider: { width: '100%', height: 40, marginTop: 4 },
});

const modalStyles = StyleSheet.create({
  card: { maxHeight: '85%' },
  title: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  confirmButton: { alignSelf: 'stretch', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  confirmText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
