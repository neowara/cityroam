import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';

type ConfirmModalBodyProps = {
  /** Rendered above the title, matching every other AppModal dialog's leading icon. */
  icon: ReactNode;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  /** Fills the confirm button with `crit` instead of the accent color — for actions
   * that destroy/end something (delete, finish trip), matching the crit-red styling
   * TuyaBlePairingCard's own "Release" confirm button already uses. */
  destructive?: boolean;
};

/** Shared body for AppModal dialogs that ask a plain yes/no question or show a
 * single-button notice — extracted from FloatingTripButton's own `ConfirmStopModal`
 * which was the proven precedent for this exact shape
 * (icon + title + body + confirm). Standalone `components/ui/` sibling to
 * AppModal/ChecklistModalBody, not folded into AppModal itself, same reasoning as
 * ChecklistModalBody's own doc comment — not every AppModal dialog needs this shape
 * either (e.g. TuyaBlePairingCard's multi-step pairing flow doesn't). Dismissal is
 * handled by AppModal's own close (X) button, so there's no redundant Cancel button
 * here. */
export function ConfirmModalBody({ icon, title, body, confirmLabel, onConfirm, destructive = false }: ConfirmModalBodyProps) {
  const { accentColor } = useAppTheme();
  const text = useThemeColor({}, 'text');
  const inkDim = useThemeColor({}, 'inkDim');
  const crit = useThemeColor({}, 'crit');

  return (
    <>
      {icon}
      <Text style={[styles.title, { color: text }]}>{title}</Text>
      <Text style={[styles.body, { color: inkDim }]}>{body}</Text>
      <PressableScale style={[styles.confirmButton, { backgroundColor: destructive ? crit : accentColor }]} onPress={onConfirm}>
        <Text style={styles.confirmText}>{confirmLabel}</Text>
      </PressableScale>
    </>
  );
}

// Matches the modalStyles constants every other AppModal dialog in the app already
// uses (FloatingTripButton, settings.tsx, board-config.tsx, TuyaBlePairingCard) —
// same visual language for "are you sure"/notice dialogs across the app.
const styles = StyleSheet.create({
  title: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginBottom: 4 },
  confirmButton: { alignSelf: 'stretch', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  confirmText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
