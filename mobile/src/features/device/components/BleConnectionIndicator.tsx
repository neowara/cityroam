import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { StatusDot } from '@/components/ui/StatusDot';
import { RefreshSpinButton } from '@/components/ui/RefreshSpinButton';
import { retryBoardConnection, useBleConnectionStatus } from '@/features/device/deviceLink';

/** Mirrors Tuya's own app's Bluetooth-icon behavior. Shared between the
 * Dashboard topbar and Settings' pairing card so both read the same live status. */
export function BleConnectionIndicator({
  isRefetching = false,
  onPressUnpaired,
}: {
  isRefetching?: boolean;
  /** Called when tapping the indicator while no board is paired — lets a caller (the
   * Dashboard) route straight to pairing instead of just showing the unpaired state. */
  onPressUnpaired?: () => void;
}) {
  const good = useThemeColor({}, 'good');
  // Fixed blue for "actively hunting over Bluetooth" — no dedicated theme token for it.
  const searching = useThemeColor({ light: '#3B82F6', dark: '#60A5FA' }, 'tint');
  const inkDim = useThemeColor({}, 'inkDim');
  const inkFaint = useThemeColor({}, 'inkFaint');
  const crit = useThemeColor({}, 'crit');
  const warn = useThemeColor({}, 'warn');
  const { paired, online, charging, searchingTimeout } = useBleConnectionStatus();
  // Brief spin + disable so a tap can't spam ensureBleConnected() (cheap, but still a native call).
  const [retrying, setRetrying] = useState(false);

  // Spins whenever the Dashboard's snapshot query is actively refetching (its 2s
  // refetchInterval keeps the speedometer/battery fresh) — a subtle "live update"
  // affordance on the pill instead of a constant pull-to-refresh bubble.
  const refreshing = isRefetching || retrying;

  // "Never connected yet" and "lost it, retrying" collapse into one "searching" state — the native side already auto-reconnects on disconnect.
  const color = !paired ? inkDim : charging === true ? warn : online === true ? good : searchingTimeout ? crit : searching;
  const label = !paired
    ? 'No device paired'
    : charging === true
      ? 'Device charging'
      : online === true
        ? 'Device connected'
        : searchingTimeout
          ? 'Device is offline'
          : 'Searching for device…';

  // Manual nudge for the same "board power-cycled and didn't auto-reconnect" case
  // BleReconnectGate/Dashboard-focus already retry automatically — this is for when the
  // user doesn't want to wait or background/foreground the app themselves.
  //
  // retryBoardConnection(), not ensureBleConnected(): the latter's registerPairedDevice
  // call is idempotent and no-ops once the client is already registered for this devId
  // — which it is here, since it's just sitting in its exponential backoff wait between
  // scan windows (up to 300s apart). It never actually interrupted that wait, so
  // pressing this icon did nothing while the client was mid-backoff. retryBoardConnection
  // tears the session down and re-registers, which restarts the connect cycle
  // immediately — the same call Settings' own "Try again" button already used.
  const showRetry = paired && online !== true;
  const retry = () => {
    if (retrying) return;
    setRetrying(true);
    void retryBoardConnection().finally(() => setRetrying(false));
  };

  const rowContent = (
    <>
      <StatusDot color={color} size={7} />
      <Text style={[styles.text, { color: inkDim }]}>{label}</Text>
      {/* Right next to the label, not after the retry/refresh icons below — those are
          unrelated to "this is tappable" and would otherwise sit between them. */}
      {!paired && onPressUnpaired && <ChevronRight size={14} color={inkFaint} style={styles.chevron} />}
      {showRetry && <RefreshSpinButton onPress={retry} spinning={refreshing} disabled={retrying} size={12} color={inkDim} />}
      {!showRetry && isRefetching && <RefreshSpinButton onPress={() => {}} spinning={true} disabled={true} size={12} color={inkDim} />}
    </>
  );

  if (!paired && onPressUnpaired) {
    return (
      <PressableScale style={styles.row} onPress={onPressUnpaired} hitSlop={8}>
        {rowContent}
      </PressableScale>
    );
  }

  return <View style={styles.row}>{rowContent}</View>;
}

// Dot size/gap match the Dashboard's status pill (index.tsx) exactly, since this sits directly above it.
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  // Android pads a Text's line box with extra ascent/descent space above and below
  // the actual glyphs by default, which isn't symmetric — it was throwing off
  // vertical-center alignment against the chevron/icons next to it.
  text: { fontSize: 12, includeFontPadding: false, textAlignVertical: 'center' },
  // Pulls in from the row's own 7px gap so the arrow reads as glued to the label
  // it belongs to, not evenly spaced like the row's other, unrelated icons.
  chevron: { marginLeft: -4 },
});
