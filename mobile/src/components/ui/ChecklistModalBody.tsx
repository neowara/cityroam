import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';

export type ChecklistItem<T extends string | number> = {
  key: T;
  label: string;
};

type ChecklistModalBodyProps<T extends string | number> = {
  /** Rendered above the title, matching every other AppModal dialog's leading icon. */
  icon: ReactNode;
  /** Given the current selected count, since callers show it in the title (e.g. "Restore 3 trips?"). */
  title: (selectedCount: number) => string;
  bodyText: string;
  items: ChecklistItem<T>[];
  selectedKeys: Set<T>;
  onToggleItem: (key: T) => void;
  onToggleSelectAll: () => void;
  /** Given the current selected count, since callers show it on the button (e.g. "Restore 3"). */
  confirmLabel: (selectedCount: number) => string;
  onConfirm: () => void;
  /** Shows a "working" label and disables the confirm button — the caller's mutation is in flight. */
  confirmPending?: boolean;
  confirmPendingLabel?: string;
};

/** Shared body for AppModal dialogs that ask "which of these do you want to
 * affect?" — a scrollable checklist with per-item checkboxes, a select-all toggle,
 * and a confirm button. Extracted out of settings.tsx's restore-deleted-trips
 * modal, which was the one real call site for this shape at extraction time (see
 * PR review notes) — designed as a standalone `components/ui/` sibling to AppModal,
 * not folded into it, since not every AppModal dialog needs a checklist (most of
 * them, e.g. TuyaBlePairingCard's plain confirm dialogs, don't). Dismissal is
 * handled by AppModal's own close (X) button, so there's no redundant Cancel button
 * here. */
export function ChecklistModalBody<T extends string | number>({
  icon,
  title,
  bodyText,
  items,
  selectedKeys,
  onToggleItem,
  onToggleSelectAll,
  confirmLabel,
  onConfirm,
  confirmPending = false,
  confirmPendingLabel = 'Working…',
}: ChecklistModalBodyProps<T>) {
  const { accentColor } = useAppTheme();
  const inkDim = useThemeColor({}, 'inkDim');
  const selectedCount = selectedKeys.size;
  const allSelected = items.length > 0 && selectedCount === items.length;

  return (
    <>
      {icon}
      <Text style={styles.title}>{title(selectedCount)}</Text>
      <Text style={[styles.body, { color: inkDim }]}>{bodyText}</Text>
      <PressableScale style={styles.selectAllRow} onPress={onToggleSelectAll}>
        <Text style={[styles.selectAllText, { color: accentColor }]}>{allSelected ? 'Deselect all' : 'Select all'}</Text>
      </PressableScale>
      <ScrollView style={styles.list} nestedScrollEnabled>
        {items.map((item) => {
          const selected = selectedKeys.has(item.key);
          return (
            <PressableScale key={item.key} style={styles.listRow} onPress={() => onToggleItem(item.key)}>
              <View style={[styles.checkbox, { borderColor: accentColor }, selected && { backgroundColor: accentColor }]}>
                {selected && <Check size={13} color="#fff" strokeWidth={3} />}
              </View>
              <Text style={[styles.listRowText, { color: inkDim }]}>{item.label}</Text>
            </PressableScale>
          );
        })}
      </ScrollView>
      <PressableScale
        style={[styles.confirmButton, { backgroundColor: accentColor, opacity: selectedCount ? 1 : 0.5 }]}
        onPress={onConfirm}
        disabled={confirmPending || !selectedCount}>
        <Text style={styles.confirmText}>{confirmPending ? confirmPendingLabel : confirmLabel(selectedCount)}</Text>
      </PressableScale>
    </>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginBottom: 4 },
  selectAllRow: { alignSelf: 'flex-end' },
  selectAllText: { fontSize: 12, fontWeight: '600', marginBottom: 2 },
  list: { alignSelf: 'stretch', maxHeight: 200, marginBottom: 4 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  listRowText: { fontSize: 13, flex: 1 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmButton: { alignSelf: 'stretch', borderRadius: 10, padding: 14, alignItems: 'center' },
  confirmText: { color: '#fff', fontWeight: '600' },
});
