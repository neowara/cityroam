import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react-native';

import { Text } from '@/components/Themed';
import { AppModal } from '@/components/ui/AppModal';
import { PressableScale } from '@/components/ui/PressableScale';
import { getActiveDeviceId, renamePairedDevice, resolveDeviceName } from '@/features/device/deviceLink';
import { queryKeys } from '@/lib/queries';
import { logEvent } from '@/lib/log';
import { useDeviceNoun } from '@/features/device/deviceNoun';

/** Same tap-to-open-modal shape as other editable fields on this page (e.g.
 * NumberFieldRow), simpler since this is a local-only preference, not a BLE write. */
export function DeviceNameRow({
  paired,
  accentColor,
  inkDim,
  text,
  last,
}: {
  paired: boolean;
  accentColor: string;
  inkDim: string;
  text: string;
  last?: boolean;
}) {
  const noun = useDeviceNoun();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [buffer, setBuffer] = useState('');

  useEffect(() => {
    // resolveDeviceName (not just the local cache) so this row shows the real current
    // name even when the local cache is empty — a fresh install, or this board named
    // from another phone — instead of blank until the rider retypes it.
    getActiveDeviceId().then((devId) => {
      if (!devId) {
        setName('');
        return;
      }
      resolveDeviceName(devId).then((n) => setName(n ?? ''));
    });
  }, [paired]);

  const openModal = () => {
    setBuffer(name);
    setModalVisible(true);
  };

  const commit = () => {
    renamePairedDevice(buffer)
      .then(() => {
        setName(buffer.trim());
        queryClient.invalidateQueries({ queryKey: queryKeys.snapshot });
      })
      .catch((err) => logEvent('board-name', 'renamePairedDevice failed', { error: err instanceof Error ? err.message : String(err) }));
    setModalVisible(false);
  };

  if (!paired) {
    return (
      <View style={[styles.row, !last && styles.rowDivider]}>
        <Text style={styles.rowLabel}>{noun.Cap} name</Text>
        <Text style={[styles.note, { color: inkDim }]}>Pair a {noun.lower} first</Text>
      </View>
    );
  }

  return (
    <>
      <PressableScale style={[styles.row, !last && styles.rowDivider]} onPress={openModal}>
        <Text style={styles.rowLabel}>{noun.Cap} name</Text>
        <View style={styles.valueRow}>
          <Text style={[styles.rowValue, { color: text }]}>{name || `Your ${noun.lower}`}</Text>
          <ChevronRight size={16} color={inkDim} />
        </View>
      </PressableScale>

      <AppModal visible={modalVisible} onRequestClose={() => setModalVisible(false)} contentStyle={modalStyles.card}>
        <Text style={[modalStyles.title, { color: text }]}>{noun.Cap} name</Text>
        <View style={styles.modalInputRow}>
          <TextInput
            value={buffer}
            onChangeText={setBuffer}
            autoFocus
            selectTextOnFocus
            placeholder={`Your ${noun.lower}`}
            placeholderTextColor={inkDim}
            onSubmitEditing={commit}
            style={[styles.modalInput, { color: text, borderColor: inkDim + '44', textAlign: 'left' }]}
          />
        </View>
        <PressableScale style={[modalStyles.confirmButton, { backgroundColor: accentColor }]} onPress={commit}>
          <Text style={modalStyles.confirmText}>Save</Text>
        </PressableScale>
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
});

const modalStyles = StyleSheet.create({
  card: { maxHeight: '85%' },
  title: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  confirmButton: { alignSelf: 'stretch', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  confirmText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
