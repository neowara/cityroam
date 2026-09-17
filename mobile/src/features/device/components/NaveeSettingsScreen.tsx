import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { AlertTriangle, Clock, Settings2, WifiOff } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { Card } from '@/components/ui/Card';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SelectField } from '@/components/ui/SelectField';
import { StatusBarScrim } from '@/components/ui/StatusBarScrim';
import { FloatingBackHeader, PILL_TOP_OFFSET, PILL_CLEARANCE } from '@/components/ui/FloatingBackHeader';
import { DeviceNameRow } from '@/features/device/components/DeviceNameRow';
import { useColorScheme } from '@/components/useColorScheme';
import { GLASS_GRADIENT, useAppTheme } from '@/lib/theme';
import { useDeviceNoun } from '@/features/device/deviceNoun';
import { logEvent } from '@/lib/log';
import {
  getActiveDeviceId,
  refreshDeviceStatus,
  useBleConnectionStatus,
  useBleRawDps,
  usePendingSettings,
  writeBoardSetting,
} from '@/features/device/deviceLink';
import { loadNaveeCredentials } from '@/features/device/navee/credentials';
import {
  decodeSpeedLimit,
  encodeSpeedLimit,
  NAVEE_MODE_WALK,
  visibleSections,
  type NaveeSettingField,
} from '@/features/device/navee/settings';
import { useNaveeWalkAssist } from '@/features/device/navee/quickControls';

type RowStatus = { state: 'saving' } | { state: 'queued' } | { state: 'error'; message: string };

/**
 * Scooter settings for a NAVEE, rendered from the scooter's own settings frame: only
 * rows the scooter reported exist (lib/navee/settings.ts). Unlike the board's batched
 * draft/save flow, each change here is written the moment it's made — a scooter's
 * settings are independent switches, and the official app behaves the same way.
 * Offline changes go through the same queue as board settings and apply on reconnect.
 */
export function NaveeSettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const noun = useDeviceNoun();
  const { accentColor, containerStyle } = useAppTheme();
  const colorScheme = useColorScheme() ?? 'light';
  const inkDim = useThemeColor({}, 'inkDim');
  const text = useThemeColor({}, 'text');
  const crit = useThemeColor({}, 'crit');
  const warn = useThemeColor({}, 'warn');

  const rawDps = useBleRawDps();
  const pending = usePendingSettings();
  const { online, paired } = useBleConnectionStatus();
  const [productId, setProductId] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
  // Walking is a push-along assist, not a riding level (see lib/navee/settings.ts's
  // RIDE_MODES) — it gets its own switch here, right below Ride mode, sharing the
  // FAB's own previous-mode-restore logic instead of duplicating it.
  const walkAssist = useNaveeWalkAssist();

  useEffect(() => {
    void (async () => {
      const devId = await getActiveDeviceId();
      if (devId) setProductId((await loadNaveeCredentials(devId))?.productId ?? null);
    })();
  }, []);

  // The settings frame only arrives when asked for; ask whenever the screen is shown
  // on a live connection so the rows reflect the scooter, not a stale cache.
  useEffect(() => {
    if (online === true) void refreshDeviceStatus();
  }, [online]);

  const valueOf = (key: string): number | null => {
    const queued = pending[key];
    if (typeof queued === 'number') return queued;
    const raw = rawDps?.[key];
    return typeof raw === 'number' ? raw : null;
  };

  const write = useCallback(async (key: string, value: number) => {
    setRowStatus((s) => ({ ...s, [key]: { state: 'saving' } }));
    try {
      const outcome = await writeBoardSetting(key, value);
      setRowStatus((s) => {
        const next = { ...s };
        if (outcome === 'queued') next[key] = { state: 'queued' };
        else delete next[key];
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent('navee-settings', `${key}: write failed`, { value, message });
      setRowStatus((s) => ({ ...s, [key]: { state: 'error', message } }));
    }
  }, []);

  const sections = visibleSections(rawDps);

  const renderControl = (field: NaveeSettingField) => {
    const value = valueOf(field.key);
    if (value == null) return null;
    const busy = rowStatus[field.key]?.state === 'saving';

    if (field.kind === 'toggle') {
      return <Switch value={value !== 0} disabled={busy} onValueChange={(on) => void write(field.key, on ? 1 : 0)} />;
    }

    if (field.kind === 'speedLimit') {
      const { enabled, kmh } = decodeSpeedLimit(value);
      const options: string[] = [];
      for (let v = field.min; v <= field.max; v++) options.push(`${v} km/h`);
      const current = kmh >= field.min && kmh <= field.max ? kmh : field.max;
      return (
        <View style={styles.speedLimit}>
          <Switch value={enabled} disabled={busy} onValueChange={(on) => void write(field.key, encodeSpeedLimit(on, current))} />
          {enabled && (
            <SelectField
              value={`${current} km/h`}
              options={options}
              disabled={busy}
              onChange={(label) => void write(field.key, encodeSpeedLimit(true, parseInt(label, 10)))}
            />
          )}
        </View>
      );
    }

    const options = field.options(productId);
    // A value the scooter reports that isn't in the known list is still shown, so the
    // row never lies about what the scooter is actually set to — e.g. Ride mode's own
    // options no longer include walking (see settings.ts), so a scooter that's
    // currently walking shows it here rather than showing nothing selected.
    const fallbackLabel = field.key === 'rideMode' && value === NAVEE_MODE_WALK ? 'Walking' : String(value);
    const all = options.some((o) => o.value === value) ? options : [...options, { value, label: fallbackLabel }];
    const selected = all.find((o) => o.value === value)!.label;
    const pick = (label: string) => {
      const option = all.find((o) => o.label === label);
      if (option && option.value !== value) void write(field.key, option.value);
    };
    return all.length <= 4 ? (
      <SegmentedControl
        options={all.map((o) => o.label)}
        value={selected}
        onChange={pick}
        accentColor={accentColor}
        inkDim={inkDim}
        text={text}
      />
    ) : (
      <SelectField value={selected} options={all.map((o) => o.label)} onChange={pick} disabled={busy} />
    );
  };

  const statusLine = (key: string) => {
    const status = rowStatus[key] ?? (pending[key] != null ? ({ state: 'queued' } as RowStatus) : undefined);
    if (!status) return null;
    if (status.state === 'saving') return <ActivityIndicator size="small" color={accentColor} style={styles.rowSpinner} />;
    if (status.state === 'queued') {
      return (
        <View style={styles.statusRow}>
          <Clock size={13} color={warn} />
          <Text style={[styles.note, { color: inkDim }]}>{`Saved on this phone. Applies when the ${noun.lower} reconnects.`}</Text>
        </View>
      );
    }
    return (
      <View style={styles.statusRow}>
        <AlertTriangle size={13} color={crit} />
        <Text style={[styles.note, { color: crit }]}>{status.message}</Text>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      {containerStyle === 'glass' && (
        <LinearGradient colors={GLASS_GRADIENT[colorScheme]} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
      )}
      <StatusBarScrim />
      <ScrollView style={styles.container}>
        <View style={[styles.content, { paddingTop: insets.top + PILL_TOP_OFFSET + PILL_CLEARANCE }]}>
          <Text style={[styles.subtitle, { color: inkDim }]}>
            {`Read and written live over Bluetooth. Only settings your ${noun.lower} reports are shown.`}
          </Text>

          <SectionLabel>{`${noun.Cap} name`}</SectionLabel>
          <Card style={styles.cardGap}>
            <DeviceNameRow paired={paired} accentColor={accentColor} inkDim={inkDim} text={text} last />
          </Card>

          {online !== true && (
            <Card style={[styles.cardGap, styles.offlineCard]}>
              <View style={styles.statusRow}>
                <WifiOff size={16} color={inkDim} />
                <Text style={[styles.note, { color: inkDim }]}>
                  {sections.length > 0
                    ? `Not connected. Showing the last values the ${noun.lower} reported; changes apply when it reconnects.`
                    : `Connect your ${noun.lower} to load its settings.`}
                </Text>
              </View>
            </Card>
          )}

          {online === true && sections.length === 0 && (
            <Card style={styles.cardGap}>
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={accentColor} />
                <Text style={[styles.note, { color: inkDim }]}>{`Reading settings from your ${noun.lower}…`}</Text>
              </View>
            </Card>
          )}

          {sections.map((section) => (
            <View key={section.title}>
              <SectionLabel>{section.title}</SectionLabel>
              <Card style={styles.cardGap}>
                {section.fields.map((field, index) => {
                  const inline = field.kind === 'toggle' || field.kind === 'speedLimit';
                  // Walk assist rides right below Ride mode, in the same card, as its
                  // own switch — same behavior as the FAB's button (previous-mode
                  // restore comes from the shared useNaveeWalkAssist hook), not a
                  // third option in the Ride mode picker itself.
                  const showWalkAssistBelow = field.key === 'rideMode' && walkAssist.on != null;
                  const isLast = index === section.fields.length - 1 && !showWalkAssistBelow;
                  return (
                    <View key={field.key}>
                      <View style={[styles.field, !isLast && styles.fieldDivider]}>
                        <View style={styles.fieldHeader}>
                          <Text style={styles.rowLabel}>{field.label}</Text>
                          {inline && renderControl(field)}
                        </View>
                        {field.description && <Text style={[styles.note, { color: inkDim }]}>{field.description}</Text>}
                        {!inline && renderControl(field)}
                        {statusLine(field.key)}
                      </View>
                      {showWalkAssistBelow && (
                        <View style={[styles.field, index < section.fields.length - 1 && styles.fieldDivider]}>
                          <View style={styles.fieldHeader}>
                            <Text style={styles.rowLabel}>Walk assist</Text>
                            <Switch
                              value={walkAssist.on ?? false}
                              disabled={walkAssist.sending}
                              onValueChange={() => void walkAssist.toggle()}
                            />
                          </View>
                          {walkAssist.error && <Text style={[styles.note, { color: crit }]}>{walkAssist.error}</Text>}
                        </View>
                      )}
                    </View>
                  );
                })}
              </Card>
            </View>
          ))}
        </View>
      </ScrollView>
      <FloatingBackHeader icon={Settings2} title={`${noun.Cap} settings`} onPress={() => router.back()} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { flex: 1 },
  content: { padding: 20, gap: 4, paddingBottom: 60 },
  subtitle: { fontSize: 13, lineHeight: 18, marginBottom: 12 },
  cardGap: { gap: 4 },
  offlineCard: { marginTop: 8 },
  field: { paddingVertical: 10, gap: 6 },
  fieldDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#8883' },
  fieldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowLabel: { fontSize: 14, flexShrink: 1 },
  note: { fontSize: 12, lineHeight: 17, flexShrink: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowSpinner: { alignSelf: 'flex-start' },
  speedLimit: { alignItems: 'flex-end', gap: 6, minWidth: 140 },
});
