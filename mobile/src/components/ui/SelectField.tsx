import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { Check, ChevronDown } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { AppModal } from '@/components/ui/AppModal';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';

/**
 * A dropdown/select field — a pressable row that shows the current value and opens a
 * modal list of options. Used where a SegmentedControl would overflow (e.g. the board
 * model catalog picker, which can have many entries) or where too many segments would
 * be crammed into one row.
 */
export function SelectField({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  testID,
  disabled = false,
}: {
  value: string | null;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  testID?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const textColor = useThemeColor({}, 'text');
  const placeholderColor = useThemeColor({ light: '#888', dark: '#777' }, 'text');
  const inkDim = useThemeColor({}, 'inkDim');
  const { accentColor } = useAppTheme();

  const selected = value != null && options.includes(value) ? value : null;

  return (
    <>
      <PressableScale
        testID={testID}
        onPress={() => {
          if (!disabled) setOpen(true);
        }}
        disabled={disabled}
        style={[styles.field, { borderColor: inkDim + '44' }, disabled && styles.fieldDisabled]}>
        <Text style={[styles.value, { color: selected ? textColor : placeholderColor }]} numberOfLines={1}>
          {selected ?? placeholder}
        </Text>
        <ChevronDown size={18} color={inkDim} />
      </PressableScale>

      <AppModal visible={open} onRequestClose={() => setOpen(false)} contentStyle={styles.modal}>
        <Text style={styles.modalTitle}>Select</Text>
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent} nestedScrollEnabled persistentScrollbar>
          {options.map((opt) => {
            const isSelected = opt === selected;
            return (
              <Pressable
                key={opt}
                onPress={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                style={[styles.row, { borderColor: inkDim + '22' }]}>
                <Text style={[styles.rowText, { color: isSelected ? accentColor : textColor }]} numberOfLines={1}>
                  {opt}
                </Text>
                {isSelected && <Check size={18} color={accentColor} />}
              </Pressable>
            );
          })}
        </ScrollView>
      </AppModal>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  fieldDisabled: { opacity: 0.5 },
  value: { fontSize: 15, flex: 1 },
  modal: { gap: 4 },
  modalTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  // The list stretches to the modal's full width so options render at readable size
  // instead of collapsing to a sliver.
  list: { alignSelf: 'stretch', width: '100%', maxHeight: 320 },
  listContent: { alignSelf: 'stretch' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  rowText: { fontSize: 15, flex: 1 },
});
