import { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { AlertTriangle, Check, CheckCircle2, X } from 'lucide-react-native';
import * as Location from 'expo-location';

import { Text, useThemeColor } from '@/components/Themed';
import { AppModal } from '@/components/ui/AppModal';
import { MarqueeText } from '@/components/ui/MarqueeText';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';
import { useAppForegroundEffect } from '@/lib/useAppForeground';
import { ensureBlePermissions } from '@/features/device/deviceLink/permissions';
import { ensureNotificationPermission } from '@/features/rides/tripNotifications';
import {
  openPowerSaveModeSettings,
  requestBackgroundLocationPermission,
  requestIgnoreBatteryOptimizations,
} from '@/features/rides/tripRecorder';
import {
  getReadinessStatus,
  READINESS_ITEM_COPY,
  type ReadinessItem,
  type ReadinessItemKey,
  type ReadinessStatus,
} from '@/features/rides/readinessChecklist';

/** Per-item fix action — each one prompts or opens the specific system screen that
 * actually resolves that item; none of them are guaranteed to succeed synchronously
 * (the rider might decline again), which is why the modal re-reads status afterward
 * rather than trusting the action's own resolution. */
async function runFix(key: ReadinessItemKey): Promise<void> {
  switch (key) {
    case 'bluetooth':
      await ensureBlePermissions();
      return;
    case 'preciseLocation': {
      const current = await Location.getForegroundPermissionsAsync();
      if (!current.granted) {
        await Location.requestForegroundPermissionsAsync();
        return;
      }
      // Already granted, just at "approximate" — Android does not re-show the
      // precise/approximate choice on a second request once granted at all, so the
      // only way to change it is the app's own system settings page.
      await Linking.openSettings();
      return;
    }
    case 'backgroundLocation':
      await requestBackgroundLocationPermission();
      return;
    case 'batteryOptimization':
      await requestIgnoreBatteryOptimizations();
      return;
    case 'notifications': {
      const granted = await ensureNotificationPermission();
      if (!granted) await Linking.openSettings();
      return;
    }
    case 'batterySaver':
      await openPowerSaveModeSettings();
      return;
  }
}

/**
 * Dashboard banner that surfaces every permission/setting a pocket ride depends on,
 * checked together rather than discovered one at a time — see readinessChecklist.ts's
 * own doc comment for why this exists (the 3.2.0 rename reset all of these).
 *
 * Dismissible per missing-item-set (not globally): if the rider fixes one item and a
 * different one goes missing later (e.g. Battery Saver gets turned back on), the banner
 * reappears rather than staying dismissed forever for an unrelated problem.
 */
// How long the checklist stays on screen, fully checked, once the last item is fixed
// — long enough to actually see the last row flip to a checkmark before the dialog
// changes under you, not an instant swap.
const ALL_FIXED_HOLD_MS = 1800;

export function ReadinessBanner() {
  const [status, setStatus] = useState<ReadinessStatus | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [successModalVisible, setSuccessModalVisible] = useState(false);
  const [fixingKey, setFixingKey] = useState<ReadinessItemKey | null>(null);
  const { accentColor } = useAppTheme();
  const inkDim = useThemeColor({}, 'inkDim');
  const warn = useThemeColor({}, 'warn');
  const good = useThemeColor({}, 'good');

  const refresh = useCallback(() => {
    void getReadinessStatus().then(setStatus);
  }, []);

  // Checked at mount and on every foreground return (e.g. coming back from the system
  // settings screen one of the fix actions opened) — none of these calls prompt on
  // their own, so this is cheap enough to run opportunistically.
  useAppForegroundEffect(refresh);

  // Everything becoming ready while the checklist is open used to unmount this whole
  // component instantly (the early-return below used to key off status.allReady
  // directly), snapping the dialog away mid-read. Now it hands off to a dedicated
  // confirmation modal instead, after a beat.
  useEffect(() => {
    if (!modalVisible || !status?.allReady) return;
    const timer = setTimeout(() => {
      setModalVisible(false);
      setSuccessModalVisible(true);
    }, ALL_FIXED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [modalVisible, status?.allReady]);

  const missingKey =
    status && !status.allReady
      ? status.items
          .filter((i) => !i.ready)
          .map((i) => i.key)
          .sort()
          .join(',')
      : null;

  const fix = useCallback(
    async (key: ReadinessItemKey) => {
      setFixingKey(key);
      try {
        await runFix(key);
      } finally {
        setFixingKey(null);
        refresh();
      }
    },
    [refresh],
  );

  if (!status) return null;
  const showBanner = !status.allReady && !!missingKey && dismissedFor !== missingKey;
  if (!showBanner && !modalVisible && !successModalVisible) return null;

  const missingCount = status.items.filter((i) => !i.ready).length;

  return (
    <>
      {showBanner && (
        <PressableScale style={[styles.banner, { borderColor: warn }]} onPress={() => setModalVisible(true)}>
          <AlertTriangle size={16} color={warn} />
          <MarqueeText style={[styles.bannerText, { color: warn }]}>
            {missingCount === 1
              ? '1 setting may stop rides from recording fully'
              : `${missingCount} settings may stop rides from recording fully`}
          </MarqueeText>
          <PressableScale
            hitSlop={8}
            onPress={(e) => {
              e.stopPropagation?.();
              setDismissedFor(missingKey);
            }}>
            <X size={16} color={inkDim} />
          </PressableScale>
        </PressableScale>
      )}

      <AppModal
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
        header={
          <>
            <Text style={styles.title}>Ready to record</Text>
            <Text style={[styles.body, { color: inkDim }]}>
              Every setting below matters for a ride recorded with your phone locked in your pocket. Tap one to fix it.
            </Text>
          </>
        }>
        {status.items.map((item) => (
          <ReadinessRow
            key={item.key}
            item={item}
            pending={fixingKey === item.key}
            onPress={() => fix(item.key)}
            accentColor={accentColor}
          />
        ))}
      </AppModal>

      <AppModal visible={successModalVisible} onRequestClose={() => setSuccessModalVisible(false)}>
        <CheckCircle2 size={64} color={good} />
        <Text style={styles.title}>All set</Text>
        <Text style={[styles.body, { color: inkDim }]}>Every setting is fixed. Rides will record reliably now.</Text>
        <PressableScale style={[styles.confirmButton, { backgroundColor: accentColor }]} onPress={() => setSuccessModalVisible(false)}>
          <Text style={styles.confirmText}>Got it</Text>
        </PressableScale>
      </AppModal>
    </>
  );
}

function ReadinessRow({
  item,
  pending,
  onPress,
  accentColor,
}: {
  item: ReadinessItem;
  pending: boolean;
  onPress: () => void;
  accentColor: string;
}) {
  const inkDim = useThemeColor({}, 'inkDim');
  const warn = useThemeColor({}, 'warn');
  const good = useThemeColor({}, 'good');
  const copy = READINESS_ITEM_COPY[item.key];
  return (
    <PressableScale style={styles.row} onPress={item.ready ? undefined : onPress} disabled={item.ready || pending}>
      {item.ready ? <Check size={18} color={good} /> : <AlertTriangle size={18} color={warn} />}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{copy.title}</Text>
        <Text style={[styles.rowBody, { color: inkDim }]}>{copy.body}</Text>
      </View>
      {!item.ready && <Text style={[styles.rowAction, { color: accentColor }]}>{pending ? 'Opening…' : 'Fix'}</Text>}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  bannerText: { flex: 1, fontSize: 13, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, alignSelf: 'stretch' },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 14, fontWeight: '600' },
  rowBody: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  rowAction: { fontSize: 13, fontWeight: '700' },
  confirmButton: { alignSelf: 'stretch', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 4 },
  confirmText: { color: '#fff', fontWeight: '600' },
});
