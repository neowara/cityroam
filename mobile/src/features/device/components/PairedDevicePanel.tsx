import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Easing, View, useAnimatedValue } from 'react-native';
import { useRouter } from 'expo-router';
import { AlertTriangle, Bluetooth, BluetoothOff, ChevronRight, Clock, RefreshCw, Settings2 } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { AppModal } from '@/components/ui/AppModal';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';
import { useDeviceNoun } from '@/features/device/deviceNoun';
import {
  disconnectBoard,
  forgetPairedDevice,
  getActiveDeviceId,
  getPairedDevices,
  retryBoardConnection,
  syncPendingSettingsNow,
  useBleConnectionStatus,
  usePairedDeviceEpoch,
  usePendingSettingsCount,
  type PairedDevice,
} from '@/features/device/deviceLink';

/** Continuous rotation for the retry icon while the connect button is actively
 * searching (auto-scan or a manual retry in flight) — stops and resets cleanly
 * once it's no longer applicable, since this can toggle on and off repeatedly. */
export function SpinningIcon({ spinning, children }: { spinning: boolean; children: React.ReactNode }) {
  const spin = useAnimatedValue(0);

  useEffect(() => {
    if (!spinning) return;
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => {
      loop.stop();
      spin.setValue(0);
    };
  }, [spinning, spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <Animated.View style={{ transform: [{ rotate }] }}>{children}</Animated.View>;
}

export function cleanErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n')[0].trim();
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}

/**
 * Everything a paired device shows in Settings, for every brand: which device, one
 * merged connect/disconnect button, the offline settings queue, the settings shortcut,
 * and "Forget". Brand pairing cards (TuyaPairingCard for Tynee, NaveePairingCard
 * for NAVEE) supply only their own sign-in flow — `unpaired` — and the copy that
 * explains what "Forget" deletes for that brand.
 */
export function PairedDevicePanel({
  unpaired,
  footnote,
  forgetBody,
  refreshKey,
}: {
  /** Rendered instead of the panel while nothing is paired. */
  unpaired: React.ReactNode;
  footnote: string;
  forgetBody: string;
  /** Re-reads the paired device when it changes (e.g. the brand card's flow step). */
  refreshKey?: unknown;
}) {
  const router = useRouter();
  const { accentColor } = useAppTheme();
  const noun = useDeviceNoun();
  const text = useThemeColor({}, 'text');
  const inkDim = useThemeColor({}, 'inkDim');
  const crit = useThemeColor({}, 'crit');
  const good = useThemeColor({}, 'good');
  const line = useThemeColor({}, 'line');
  const connection = useBleConnectionStatus();
  const pendingSettings = usePendingSettingsCount();
  const [linkBusy, setLinkBusy] = useState(false);
  const epoch = usePairedDeviceEpoch();
  const [pairedDevice, setPairedDevice] = useState<PairedDevice | null>(null);
  const [forgetConfirmOpen, setForgetConfirmOpen] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [devices, activeId] = await Promise.all([getPairedDevices(), getActiveDeviceId()]);
      const active = activeId ? (devices.find((d) => d.devId === activeId) ?? null) : devices.length === 1 ? devices[0] : null;
      if (alive) setPairedDevice(active);
    })();
    return () => {
      alive = false;
    };
  }, [epoch, refreshKey]);

  const connectionLabel = connection.manuallyDisconnected
    ? 'Disconnected'
    : connection.permissionDenied
      ? 'Bluetooth permission denied'
      : connection.online === true
        ? 'Connected'
        : connection.online === false || connection.searchingTimeout
          ? `Not connected. Wake the ${noun.lower} and retry`
          : `Looking for your ${noun.lower}…`;

  // Re-registers the session rather than nudging it: Android only shows the Bluetooth
  // prompt while the app is actively asking, and a native client already in backoff
  // will not rescan on its own.
  const retry = useCallback(async () => {
    setLinkBusy(true);
    try {
      await retryBoardConnection();
    } finally {
      setLinkBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setLinkBusy(true);
    try {
      await disconnectBoard();
    } finally {
      setLinkBusy(false);
    }
  }, []);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const applied = await syncPendingSettingsNow();
      if (applied > 0) {
        setSyncResult(`Applied ${applied} setting${applied === 1 ? '' : 's'}.`);
        return;
      }
      // Nothing applied means the device is not reachable yet; reconnecting is the
      // useful next step, and the queue flushes itself on the connection transition.
      const ok = await retryBoardConnection();
      setSyncResult(
        ok
          ? `Reconnecting to your ${noun.lower}. The queue applies as soon as it answers.`
          : `Bluetooth permission is needed to reach your ${noun.lower}.`,
      );
    } catch (err) {
      setSyncResult(cleanErrorMessage(err));
    } finally {
      setSyncing(false);
    }
  }, [noun]);

  const confirmForget = useCallback(async () => {
    if (!pairedDevice || forgetting) return;
    setForgetting(true);
    try {
      await forgetPairedDevice(pairedDevice.devId);
      setForgetConfirmOpen(false);
      setPairedDevice(null);
    } finally {
      setForgetting(false);
    }
  }, [pairedDevice, forgetting]);

  if (!pairedDevice) return <>{unpaired}</>;

  const connected = connection.online === true;
  const autoScanning = connection.online == null && !connection.manuallyDisconnected && !connection.permissionDenied;
  const searching = !connected && !connection.permissionDenied && (linkBusy || autoScanning);
  // Color follows the action the button performs, not connection health:
  // "Disconnect" is a stop action (crit), "Connect" is an inviting one (good).
  const statusColor = connected ? crit : connection.online === false ? good : inkDim;
  const label = connected
    ? linkBusy
      ? 'Disconnecting…'
      : 'Disconnect'
    : linkBusy
      ? 'Connecting…'
      : connection.permissionDenied
        ? 'Allow Bluetooth'
        : autoScanning
          ? `Searching for your ${noun.lower}…`
          : 'Connect';

  return (
    <>
      <View style={styles.pairedRow}>
        <Bluetooth size={16} color={accentColor} />
        <View style={styles.pairedMetaWrap}>
          <Text style={[styles.pairedName, { color: text }]} numberOfLines={1}>
            {pairedDevice.name || `Paired ${noun.lower}`}
          </Text>
          <Text style={[styles.pairedMeta, { color: inkDim }]} numberOfLines={1}>
            {pairedDevice.devId}
          </Text>
        </View>
        <PressableScale style={[styles.forgetLink, { borderColor: crit }]} disabled={forgetting} onPress={() => setForgetConfirmOpen(true)}>
          <Text style={[styles.forgetLinkText, { color: crit }]}>{forgetting ? 'Forgetting…' : 'Forget'}</Text>
        </PressableScale>
      </View>
      <View style={styles.connPanelMerged}>
        <PressableScale
          style={[styles.connButton, { borderColor: statusColor }]}
          disabled={linkBusy}
          onPress={connected ? disconnect : retry}>
          <View style={styles.buttonRow}>
            {connected ? (
              <BluetoothOff size={15} color={statusColor} />
            ) : (
              <SpinningIcon spinning={searching}>
                <RefreshCw size={15} color={statusColor} />
              </SpinningIcon>
            )}
            <Text style={[styles.connButtonText, { color: statusColor }]}>{label}</Text>
          </View>
        </PressableScale>
        {/* Extra detail beyond what the button's own border color/label already say —
            shown only for states that need a hint the button alone doesn't carry. */}
        {(connection.permissionDenied || connection.online === false || connection.searchingTimeout) && (
          <Text style={[styles.connCaption, { color: inkDim }]}>{connectionLabel}</Text>
        )}
      </View>
      {/* Always shown while a device is paired, including at zero. Rendering it only
          when something is queued means the one moment a rider looks for it — after
          saving a setting the device did not take — is indistinguishable from the
          section not existing. */}
      <View style={[styles.queuePanel, { borderColor: pendingSettings > 0 ? accentColor : line }]}>
        <View style={styles.queueHeader}>
          <Clock size={16} color={pendingSettings > 0 ? accentColor : inkDim} />
          <Text style={[styles.queueTitle, { color: text }]}>
            {pendingSettings === 0
              ? 'All settings synced'
              : `${pendingSettings} setting${pendingSettings === 1 ? '' : 's'} waiting to sync`}
          </Text>
        </View>
        <Text style={[styles.pendingText, { color: inkDim }]}>
          {pendingSettings === 0
            ? `Changes you make are written straight to the ${noun.lower} while it is connected.`
            : `Saved on this phone and applied automatically the next time the ${noun.lower} connects.`}
        </Text>
        <PressableScale style={[styles.boardSettingsRow, { borderColor: line }]} onPress={() => router.push('/device-settings')}>
          <Settings2 size={15} color={inkDim} />
          <Text style={[styles.boardSettingsText, { color: text }]}>{`${noun.Cap} settings`}</Text>
          <ChevronRight size={16} color={inkDim} />
        </PressableScale>
        {pendingSettings > 0 && (
          <PressableScale
            style={[styles.connButton, { backgroundColor: accentColor, borderColor: accentColor }]}
            disabled={syncing}
            onPress={syncNow}>
            <View style={styles.buttonRow}>
              <RefreshCw size={15} color="#fff" />
              <Text style={[styles.connButtonText, { color: '#fff' }]}>{syncing ? 'Syncing…' : 'Sync now'}</Text>
            </View>
          </PressableScale>
        )}
        {syncResult && <Text style={[styles.pendingText, { color: inkDim }]}>{syncResult}</Text>}
      </View>

      <Text style={[pairingModalStyles.body, { color: inkDim, textAlign: 'left' as const }]}>{footnote}</Text>

      <AppModal
        visible={forgetConfirmOpen}
        onRequestClose={() => !forgetting && setForgetConfirmOpen(false)}
        contentStyle={pairingModalStyles.card}>
        <AlertTriangle size={28} color={crit} />
        <Text style={[pairingModalStyles.title, { color: text }]}>{`Forget this ${noun.lower}?`}</Text>
        <Text style={[pairingModalStyles.body, { color: inkDim }]}>{forgetBody}</Text>
        {forgetting ? (
          <ActivityIndicator color={accentColor} />
        ) : (
          <PressableScale style={[pairingModalStyles.confirmButton, { backgroundColor: crit }]} onPress={confirmForget}>
            <Text style={pairingModalStyles.confirmText}>Forget</Text>
          </PressableScale>
        )}
      </AppModal>
    </>
  );
}

const styles = {
  buttonRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
  connPanelMerged: { marginTop: 10, gap: 6 },
  connCaption: { fontSize: 12, lineHeight: 16, textAlign: 'center' as const },
  queuePanel: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 10, gap: 10 },
  queueHeader: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
  queueTitle: { fontSize: 15, fontWeight: '700' as const, flexShrink: 1 },
  pendingText: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
  boardSettingsRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  boardSettingsText: { flex: 1, fontSize: 13, fontWeight: '600' as const },
  connButton: { borderRadius: 10, borderWidth: 1, paddingVertical: 10, alignItems: 'center' as const },
  connButtonText: { fontWeight: '600' as const, fontSize: 14 },
  pairedRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, alignSelf: 'stretch' as const },
  pairedMetaWrap: { flex: 1 },
  pairedName: { fontSize: 14, fontWeight: '600' as const },
  pairedMeta: { fontSize: 12, marginTop: 2 },
  forgetLink: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
  forgetLinkText: { fontWeight: '600' as const, fontSize: 13 },
};

/** Shared by every brand's sign-in modal, so the flows look the same. */
export const pairingModalStyles = {
  card: { maxHeight: '80%' as const },
  pickerCard: { maxHeight: '85%' as const },
  title: { fontSize: 18, fontWeight: '700' as const, textAlign: 'center' as const },
  body: { fontSize: 13, lineHeight: 18, textAlign: 'center' as const, marginTop: 4 },
  errorBody: { fontSize: 13, lineHeight: 18, textAlign: 'left' as const, marginTop: 4 },
  deviceRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, paddingVertical: 10, borderBottomWidth: 1 },
  deviceName: { fontSize: 14, fontWeight: '600' as const },
  deviceMeta: { fontSize: 12, marginTop: 2 },
  confirmButton: { alignSelf: 'stretch' as const, borderRadius: 14, paddingVertical: 14, alignItems: 'center' as const, marginTop: 12 },
  confirmText: { color: '#fff', fontSize: 15, fontWeight: '700' as const },
  busyLabel: { fontSize: 13, marginTop: 8 },
};

/** Shared form styles for brand sign-in modals. */
export const pairingFormStyles = {
  button: { marginTop: 4, borderRadius: 10, padding: 14, alignItems: 'center' as const },
  buttonRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
  buttonText: { color: '#fff', fontWeight: '600' as const },
  input: {
    alignSelf: 'stretch' as const,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 8,
    fontSize: 14,
  },
  passwordRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, marginTop: 8 },
  passwordInput: { flex: 1, marginTop: 0 },
  passwordToggle: { borderWidth: 1, borderRadius: 10, padding: 10, alignItems: 'center' as const },
  deviceMetaWrap: { flex: 1 },
  deviceFarIcon: { marginRight: 4 },
  rememberRow: {
    alignSelf: 'stretch' as const,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    marginTop: 10,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  rememberText: { fontSize: 13, fontWeight: '500' as const },
};
