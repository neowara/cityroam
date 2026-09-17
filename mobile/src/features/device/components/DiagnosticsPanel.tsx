import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import * as Location from 'expo-location';

import { Text, useThemeColor } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';
import { logEvent } from '@/lib/log';
import { getPairedDeviceId, refreshDeviceStatus } from '@/features/device/deviceLink';
import { setHomeRegion } from '@/features/rides/homeGeofence';
import { startNativeRideCapture, stopNativeRideCapture } from '@/features/rides/rideCore';
import BoardBleNative from '@modules/board-ble/src/BoardBle';
import { directConnectionPhase } from '@/features/device/deviceLink/transport';
import NaveeBleNative from '@modules/navee-ble/src/NaveeBle';
import { isNaveeDevId } from '@/features/device/navee/credentials';
import RideCoreNative from '@modules/ride-core/src/RideCore';

/**
 * The runtime switches and live state a real on-device verification pass needs —
 * every mechanism this panel touches was built with a fallback specifically so a
 * failed check here means flipping one of these, not a redesign. Lives inside the
 * existing debug console rather than a new screen: same "developer-only, not normal
 * Settings" audience, no new navigation surface needed.
 */
export function DiagnosticsPanel() {
  const { accentColor } = useAppTheme();
  const inkDim = useThemeColor({}, 'inkDim');
  const chipBorder = useThemeColor({}, 'line');

  const [phase, setPhase] = useState<string | null>(null);
  const [idleStrategy, setIdleStrategy] = useState<string>('scan_then_direct');
  const [stitchWindowMs, setStitchWindowMsState] = useState(0);
  const [rideCoreRunning, setRideCoreRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [isNavee, setIsNavee] = useState(false);
  const [naveeAuth, setNaveeAuth] = useState<string>('not yet');

  // The scooter's auth outcome is the first thing to check when a NAVEE won't stay
  // connected; its frames and steps are already in the live log below.
  useEffect(() => {
    const sub = NaveeBleNative.addListener('onNaveeAuthResult', (event) => {
      const label = event.ok ? 'ok' : `failed (${event.status ?? event.message})`;
      setNaveeAuth(label);
      logEvent('diagnostics', `NAVEE auth ${label}`, { devId: event.devId, message: event.message });
    });
    return () => sub.remove();
  }, []);

  const refresh = useCallback(async () => {
    const devId = await getPairedDeviceId();
    try {
      setPhase(devId ? directConnectionPhase(devId) : null);
      setIsNavee(isNaveeDevId(devId));
    } catch {
      setPhase(null);
    }
    try {
      setIdleStrategy(BoardBleNative.getIdleConnectStrategy());
    } catch {
      // native module absent on a build without the board-ble module prebuilt
    }
    try {
      setStitchWindowMsState(RideCoreNative.getStitchWindowMs());
      setRideCoreRunning(RideCoreNative.isRunning());
    } catch {
      // native module absent on a build without ride-core prebuilt
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [refresh]);

  const toggleIdleStrategy = useCallback(async () => {
    const next = idleStrategy === 'auto_connect' ? 'scan_then_direct' : 'auto_connect';
    BoardBleNative.setIdleConnectStrategy(next);
    logEvent('diagnostics', `idle-connect strategy set to ${next}`);
    await refresh();
  }, [idleStrategy, refresh]);

  const toggleStitchWindow = useCallback(async () => {
    const next = stitchWindowMs > 0 ? 0 : 60_000;
    RideCoreNative.setStitchWindowMs(next);
    logEvent('diagnostics', `stitch window set to ${next}ms`);
    await refresh();
  }, [stitchWindowMs, refresh]);

  const toggleRideCore = useCallback(async () => {
    if (rideCoreRunning) stopNativeRideCapture();
    else startNativeRideCapture();
    logEvent('diagnostics', `native ride capture ${rideCoreRunning ? 'stopped' : 'started'} (manual)`);
    await refresh();
  }, [rideCoreRunning, refresh]);

  const setHomeHere = useCallback(async () => {
    setBusy('home');
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await setHomeRegion(pos.coords.latitude, pos.coords.longitude);
      logEvent('diagnostics', 'home area set to current location');
    } catch (err) {
      logEvent('diagnostics', 'set home area failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, []);

  const scanNavee = useCallback(async () => {
    setBusy('scan');
    const sub = NaveeBleNative.addListener('onScanResult', (result) => logEvent('diagnostics', 'NAVEE nearby', result));
    try {
      await NaveeBleNative.scan(10_000);
    } catch (err) {
      logEvent('diagnostics', 'NAVEE scan failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      sub.remove();
      setBusy(null);
    }
  }, []);

  const exportBleDiagnostics = useCallback(() => {
    try {
      const lines = BoardBleNative.recentDiagnostics();
      logEvent('diagnostics', `${lines.length} recent BLE diagnostic line(s)`, { lines });
    } catch (err) {
      logEvent('diagnostics', 'exportBleDiagnostics failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.row} contentContainerStyle={styles.rowContent}>
      <Chip label={`phase: ${phase ?? 'none'}`} border={chipBorder} textColor={inkDim} />
      <Chip
        label={`idle: ${idleStrategy}`}
        border={chipBorder}
        textColor={accentColor}
        onPress={toggleIdleStrategy}
        pending={busy === 'idle'}
      />
      <Chip label={`stitch: ${stitchWindowMs}ms`} border={chipBorder} textColor={accentColor} onPress={toggleStitchWindow} />
      <Chip label={`rideCore: ${rideCoreRunning ? 'on' : 'off'}`} border={chipBorder} textColor={accentColor} onPress={toggleRideCore} />
      <Chip label="set home here" border={chipBorder} textColor={accentColor} onPress={setHomeHere} pending={busy === 'home'} />
      <Chip label="export BLE log" border={chipBorder} textColor={accentColor} onPress={exportBleDiagnostics} />
      {isNavee && <Chip label={`navee auth: ${naveeAuth}`} border={chipBorder} textColor={inkDim} />}
      {isNavee && <Chip label="read settings" border={chipBorder} textColor={accentColor} onPress={() => void refreshDeviceStatus()} />}
      <Chip label="scan NAVEE" border={chipBorder} textColor={accentColor} onPress={scanNavee} pending={busy === 'scan'} />
    </ScrollView>
  );
}

function Chip({
  label,
  border,
  textColor,
  onPress,
  pending,
}: {
  label: string;
  border: string;
  textColor: string;
  onPress?: () => void;
  pending?: boolean;
}) {
  return (
    <PressableScale disabled={!onPress || pending} onPress={onPress} style={[styles.chip, { borderColor: border }]}>
      <Text style={[styles.chipText, { color: textColor }]}>{pending ? '…' : label}</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: { flexGrow: 0, marginBottom: 8 },
  rowContent: { gap: 6, paddingHorizontal: 2 },
  chip: { borderWidth: 1, borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10 },
  chipText: { fontSize: 11, fontWeight: '600' },
});
