import { StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { AppModal } from '@/components/ui/AppModal';
import { PressableScale } from '@/components/ui/PressableScale';
import { MODE_ORDER, MODE_META, MODE_ICONS, type Mode } from '@/lib/mode';

/** Tuya's own device page opens a select list for ride mode rather than cycling one
 * button through the four levels — this mirrors that, shared between the FAB's quick
 * control and board-config's. */
export function ModeSelectModal({
  visible,
  current,
  onSelect,
  onClose,
}: {
  visible: boolean;
  current: Mode | null;
  onSelect: (mode: Mode) => void;
  onClose: () => void;
}) {
  const text = useThemeColor({}, 'text');

  return (
    <AppModal visible={visible} onRequestClose={onClose} contentStyle={styles.card}>
      <Text style={[styles.title, { color: text }]}>Ride mode</Text>
      <View style={styles.list}>
        {MODE_ORDER.map((m) => {
          const Icon = MODE_ICONS[m];
          const meta = MODE_META[m];
          const selected = m === current;
          return (
            <PressableScale
              key={m}
              onPress={() => onSelect(m)}
              style={[
                styles.row,
                { borderColor: selected ? meta.color : meta.color + '33' },
                selected && { backgroundColor: meta.color + '18' },
              ]}>
              <Icon size={18} color={meta.color} />
              <Text style={[styles.rowLabel, { color: meta.color }]}>{meta.label}</Text>
              {selected && <Check size={16} color={meta.color} />}
            </PressableScale>
          );
        })}
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  card: { gap: 4 },
  title: { fontSize: 17, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  list: { alignSelf: 'stretch', gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  rowLabel: { flex: 1, fontSize: 14, fontWeight: '600' },
});
