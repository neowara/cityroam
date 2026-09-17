import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, ActivityIndicator, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Settings2, AlertTriangle, WifiOff, X, Check, Lock, LockOpen, Gauge } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { Card } from '@/components/ui/Card';
import { AppModal } from '@/components/ui/AppModal';
import { FitText } from '@/components/ui/FitText';
import { HeadlightButtonIcon } from '@/features/device/components/HeadlightIcon';
import { ModeSelectModal } from '@/components/ui/ModeSelectModal';
import { ModeText } from '@/components/ui/ModeText';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { StatusBarScrim } from '@/components/ui/StatusBarScrim';
import { MODE_META, MODE_ICONS, type Mode } from '@/lib/mode';
import { GLASS_GRADIENT, fontStyleFor, useAppTheme } from '@/lib/theme';
import { useColorScheme } from '@/components/useColorScheme';
import {
  DP_WRITE_SETTLE_MS,
  getActiveDeviceId,
  getBoardUsability,
  usePairedDeviceEpoch,
  useActiveDeviceBrand,
  useBleConnectionStatus,
  useBleRawDps,
  useBleSchema,
  usePendingSettings,
  writeBoardSetting,
  type BoardDpSchema,
} from '@/features/device/deviceLink';
import { DEFAULT_BRAND } from '@/lib/api';
import { useLockControl, useHeadlightControl, useRideModeControl } from '@/features/device/boardQuickControls';
import { dpWriteType } from '@/features/device/boardDpSchema';
import { logEvent } from '@/lib/log';
import {
  MODE_ORDER,
  MODE_DP_CONFIG,
  ACCEL_DECEL_RANGE,
  GLOBAL_DP,
  BRAKE_POWER_MAX_RANGE,
  BRAKE_POWER_MAX_CONFIRMED,
  ALL_WRITABLE_DPS,
} from '@/features/device/boardDpLabels';
import { formatDpValue, formatScaled, humanizeEnumValue } from '@/features/device/boardValue';
import { FloatingBackHeader, PILL_TOP_OFFSET, PILL_CLEARANCE } from '@/components/ui/FloatingBackHeader';
import { useDeviceNoun } from '@/features/device/deviceNoun';
import { DeviceNameRow } from '@/features/device/components/DeviceNameRow';
import { EnumFieldRow } from '@/components/ui/EnumFieldRow';
import { InfoRow } from '@/components/ui/InfoRow';
import { NumberFieldRow } from '@/components/ui/NumberFieldRow';
import { PressableScale } from '@/components/ui/PressableScale';
import { NaveeSettingsScreen } from '@/features/device/components/NaveeSettingsScreen';
import { isNaveeDevId } from '@/features/device/navee/credentials';
import { SliderRow } from '@/components/ui/SliderRow';

type SaveState = 'idle' | 'confirming' | 'saving' | 'saved' | 'error' | 'queued';

/** Live board configuration over Direct BLE (dpId mapping confirmed,
 * see lib/boardDpLabels.ts). Local-draft + batched Save/Cancel: dragging a slider only
 * edits a draft; a floating bar lists every pending change across all mode tabs before one batched write. */
/**
 * One settings route for every brand: the screen follows the active device. A NAVEE
 * scooter's settings come from its own settings frame (NaveeSettingsScreen); a Tynee
 * board's from its Tuya datapoint schema (TuyaBoardConfigScreen). Renders nothing for
 * the moment it takes to read which device is active, so the wrong screen never flashes.
 */
export default function DeviceSettingsScreen() {
  const [devId, setDevId] = useState<string | null | undefined>(undefined);
  const pairedEpoch = usePairedDeviceEpoch();
  useEffect(() => {
    let alive = true;
    void getActiveDeviceId().then((id) => {
      if (alive) setDevId(id);
    });
    return () => {
      alive = false;
    };
  }, [pairedEpoch]);
  if (devId === undefined) return null;
  return isNaveeDevId(devId) ? <NaveeSettingsScreen /> : <TuyaBoardConfigScreen />;
}

function TuyaBoardConfigScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const noun = useDeviceNoun();
  const pendingSettings = usePendingSettings();
  const { accentColor, font, containerStyle } = useAppTheme();
  const colorScheme = useColorScheme() ?? 'light';
  const isGlass = containerStyle === 'glass';
  const inkDim = useThemeColor({}, 'inkDim');
  const warn = useThemeColor({}, 'warn');
  const crit = useThemeColor({}, 'crit');
  const good = useThemeColor({}, 'good');
  const text = useThemeColor({}, 'text');
  const surface = useThemeColor({}, 'surface');

  const rawDps = useBleRawDps();
  const schema = useBleSchema();
  const { online, paired } = useBleConnectionStatus();
  const brand = useActiveDeviceBrand();
  // The lock/headlight/ride-mode quick controls are Tuya-DP-specific — hidden for any
  // other paired brand, same gate the FAB's quick controls use. Cruise (dp13) was
  // removed — confirmed non-functional even in Tuya's own app.
  const quickControlsAvailable = online === true && brand === DEFAULT_BRAND;
  const lock = useLockControl();
  const headlight = useHeadlightControl();
  const rideMode = useRideModeControl();
  const [modeModalVisible, setModeModalVisible] = useState(false);
  const [selectedMode, setSelectedMode] = useState<Mode>('eco');
  const [drafts, setDrafts] = useState<Record<string, number | string>>({});
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<Set<string>>(new Set());
  const [autobrakeSending, setAutobrakeSending] = useState(false);
  const [autobrakeError, setAutobrakeError] = useState<string | null>(null);
  const justSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [queuedLabels, setQueuedLabels] = useState<string[]>([]);
  const [sliderResetKey, setSliderResetKey] = useState(0);
  const [savingProgress, setSavingProgress] = useState<{ index: number; total: number; label: string } | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the final "Saved to board" confirmation reflects a genuinely confirmed
  // connection, not just "the write call didn't throw" — see confirmSave's closing check.
  const [saveConfident, setSaveConfident] = useState(true);

  // Logged so a real device's schema can be read from adb logcat to confirm/correct the unconfirmed dp112-119 guesses in boardDpLabels.ts.
  useEffect(() => {
    if (schema && Object.keys(schema).length > 0) {
      logEvent('board-schema', 'loaded', schema);
    }
  }, [schema]);

  // Cancel the justSaved flash timer and the saved-confirmation timer on unmount, or
  // they fire setState after unmount.
  useEffect(() => {
    return () => {
      if (justSavedTimer.current) {
        clearTimeout(justSavedTimer.current);
        justSavedTimer.current = null;
      }
      if (savedTimer.current) {
        clearTimeout(savedTimer.current);
        savedTimer.current = null;
      }
    };
  }, []);

  const rawValue = (dpId: string): number | null => {
    const v = rawDps?.[dpId];
    return typeof v === 'number' ? v : null;
  };

  const draftFor = (dpId: string): number | null => {
    const d = drafts[dpId];
    return (typeof d === 'number' ? d : null) ?? rawValue(dpId);
  };

  const setDraft = (dpId: string, value: number) => setDrafts((prev) => ({ ...prev, [dpId]: Math.round(value) }));

  // Separate from rawValue/draftFor (number-only) since Board info fields can be string (enum) dp types too.
  const rawFieldValue = (dpId: string): number | string | null => {
    const v = rawDps?.[dpId];
    return typeof v === 'number' || typeof v === 'string' ? v : null;
  };
  const setFieldDraft = (dpId: string, value: number | string) => setDrafts((prev) => ({ ...prev, [dpId]: value }));

  // Prefer the device's live schema range/step over the static fallback — the static ranges were confirmed wrong once real schema data came back.
  const effectiveRange = (dpId: string, fallback: { min: number; max: number; step?: number }) => {
    const entry = schema?.[dpId];
    if (entry?.min != null && entry?.max != null) {
      return { min: entry.min, max: entry.max, step: entry.step ?? fallback.step ?? 1 };
    }
    return fallback;
  };

  // Across every mode tab, not just the one selected, so switching tabs never drops a pending edit.
  const pendingChanges = Object.entries(drafts)
    .filter(([dpId, draft]) => rawFieldValue(dpId) != null && draft !== rawFieldValue(dpId))
    .map(([dpId, draft]) => ({ dpId, draft, meta: ALL_WRITABLE_DPS[dpId] }))
    .filter((c) => c.meta);

  const cancelChanges = () => {
    setDrafts({});
    setSliderResetKey((k) => k + 1);
  };

  // Always attempts the real write first; only queues if it fails AND the board is
  // offline (a failure while online is a real error, not a queue-and-retry case).
  const confirmSave = async () => {
    setSaveState('saving');
    setSaveError(null);
    const saved = new Set<string>();
    const queued = new Set<string>();
    // The whole batch up front, so the log shows what was attempted even if the app is
    // killed partway through — and the exact value and wire type per datapoint, which
    // is what a "the board refused this" failure actually turns on.
    logEvent('board-settings', `saving ${pendingChanges.length} change(s)`, {
      boardUsability: getBoardUsability(),
      changes: pendingChanges.map((c) => ({
        dp: c.dpId,
        label: c.meta.label,
        from: rawFieldValue(c.dpId),
        to: c.draft,
        wireType: dpWriteType(c.dpId, schema),
      })),
    });
    try {
      for (const [index, change] of pendingChanges.entries()) {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, DP_WRITE_SETTLE_MS));
        setSavingProgress({ index: index + 1, total: pendingChanges.length, label: change.meta.label });
        // writeBoardSetting does the live re-check itself (not the `online` closure
        // from render — the board can drop mid-save, several writes with settle
        // delays between them can span multiple seconds) and rethrows a genuine
        // failure, which the outer try/catch below still handles the same way.
        const outcome = await writeBoardSetting(change.dpId, change.draft);
        if (outcome === 'saved') saved.add(change.dpId);
        else queued.add(change.dpId);
      }
      setDrafts((prev) => {
        const next = { ...prev };
        saved.forEach((id) => delete next[id]);
        queued.forEach((id) => delete next[id]);
        return next;
      });
      const settled = new Set([...saved, ...queued]);
      setJustSaved(settled);
      if (justSavedTimer.current) clearTimeout(justSavedTimer.current);
      justSavedTimer.current = setTimeout(() => setJustSaved(new Set()), 2500);
      setSavingProgress(null);
      logEvent('board-settings', 'save finished', { saved: [...saved], queued: [...queued] });
      if (queued.size > 0) {
        // Snapshot labels before drafts clears, so the 'queued' modal has something to show.
        setQueuedLabels(pendingChanges.filter((c) => queued.has(c.dpId)).map((c) => c.meta.label));
        setSaveState('queued');
      } else {
        // A write's onSuccess callback can fire even if the board dropped right as it
        // arrived (the SDK doesn't reliably surface that as an error), so settings can
        // appear "saved" while the board had actually powered off mid-save. One last
        // live check before claiming success, not just "the promise resolved."
        const confident = getBoardUsability() === 'usable';
        setSaveConfident(confident);
        // Brief full-screen confirmation before returning to idle — see the 'saved' modal branch.
        setSaveState('saved');
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaveState('idle'), confident ? 1400 : 2600);
      }
    } catch (err) {
      logEvent('board-settings', 'save failed', {
        error: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string } | null)?.code ?? null,
        savedSoFar: [...saved],
        queuedSoFar: [...queued],
        boardUsability: getBoardUsability(),
      });
      // Whatever already made it into `saved` stays saved; only the remainder is still pending.
      setDrafts((prev) => {
        const next = { ...prev };
        saved.forEach((id) => delete next[id]);
        return next;
      });
      setSavingProgress(null);
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message.split('\n')[0] : String(err));
    }
  };

  const toggleAutobrake = async (next: boolean) => {
    setAutobrakeSending(true);
    setAutobrakeError(null);
    try {
      // Through writeBoardSetting, not writeBleDp: a toggle is a setting like any
      // other, so an unreachable board queues it for the next reconnect instead of
      // making the rider wait out a response timeout and then showing a raw error.
      const outcome = await writeBoardSetting(GLOBAL_DP.autobrake, next);
      if (outcome === 'queued') setAutobrakeError(`Saved. Applies when the ${noun.lower} reconnects.`);
    } catch (err) {
      setAutobrakeError(err instanceof Error ? err.message.split('\n')[0] : String(err));
    } finally {
      setAutobrakeSending(false);
    }
  };

  const modeConfig = MODE_DP_CONFIG[selectedMode];
  const modeMeta = MODE_META[selectedMode];
  const ModeIcon = MODE_ICONS[selectedMode];

  // A queued value wins over the board's own: the rider flipped the switch and the
  // change is saved, it just has not reached the board yet. Reading only rawDps made
  // the switch spring back to its old position on the next render, which reads as the
  // toggle having done nothing at all.
  const pendingAutobrake = pendingSettings[GLOBAL_DP.autobrake];
  const autobrakeOn = pendingAutobrake != null ? pendingAutobrake === true : rawDps?.[GLOBAL_DP.autobrake] === true;
  const autobrakeQueued = pendingAutobrake != null;
  const hasUnconfirmedChange = pendingChanges.some((c) => !c.meta.confirmed);

  return (
    <View style={styles.screen}>
      {isGlass && (
        <LinearGradient colors={GLASS_GRADIENT[colorScheme]} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
      )}
      <StatusBarScrim />
      <ScrollView style={styles.container}>
        <View
          style={[
            styles.content,
            pendingChanges.length > 0 && styles.contentWithBar,
            { paddingTop: insets.top + PILL_TOP_OFFSET + PILL_CLEARANCE },
          ]}>
          <Text style={[styles.subtitle, { color: inkDim }]}>Read from and written to the board live over Bluetooth.</Text>

          <SectionLabel>{`${noun.Cap} name`}</SectionLabel>
          <Card style={styles.cardGap}>
            <DeviceNameRow paired={paired} accentColor={accentColor} inkDim={inkDim} text={text} last />
          </Card>

          {quickControlsAvailable && (
            <>
              <SectionLabel>Quick controls</SectionLabel>
              <View style={styles.tiles}>
                <PressableScale
                  style={[
                    styles.tile,
                    { borderColor: lock.locked ? accentColor : accentColor + '33' },
                    lock.locked && { backgroundColor: accentColor + '18' },
                  ]}
                  disabled={lock.locked == null || lock.sending}
                  onPress={() => void lock.toggle()}>
                  {lock.sending ? (
                    <ActivityIndicator size="small" color={accentColor} />
                  ) : lock.locked ? (
                    <Lock size={18} color={accentColor} />
                  ) : (
                    <LockOpen size={18} color={accentColor} />
                  )}
                  <Text style={styles.tileLabel}>{lock.locked ? 'Locked' : 'Lock'}</Text>
                </PressableScale>

                <PressableScale
                  style={[styles.tile, { borderColor: accentColor }, { backgroundColor: accentColor + '18' }]}
                  disabled={headlight.sending}
                  onPress={() => void headlight.toggle()}>
                  {headlight.sending ? (
                    <ActivityIndicator size="small" color={accentColor} />
                  ) : (
                    <HeadlightButtonIcon mode={headlight.mode} color={accentColor} size={18} />
                  )}
                  <Text style={styles.tileLabel}>{headlight.mode === 'static' ? 'Light On' : 'Blinking'}</Text>
                </PressableScale>

                <PressableScale
                  style={[
                    styles.tile,
                    { borderColor: rideMode.mode ? MODE_META[rideMode.mode].color : accentColor + '33' },
                    rideMode.mode && { backgroundColor: MODE_META[rideMode.mode].color + '18' },
                  ]}
                  disabled={rideMode.mode == null || rideMode.sending}
                  onPress={() => setModeModalVisible(true)}>
                  {rideMode.sending ? (
                    <ActivityIndicator size="small" color={accentColor} />
                  ) : rideMode.mode ? (
                    (() => {
                      const Icon = MODE_ICONS[rideMode.mode!];
                      return <Icon size={18} color={MODE_META[rideMode.mode!].color} />;
                    })()
                  ) : (
                    <Gauge size={18} color={accentColor} />
                  )}
                  <Text style={styles.tileLabel}>{rideMode.mode ? MODE_META[rideMode.mode].label : 'Ride mode'}</Text>
                </PressableScale>
              </View>
              {(lock.error || headlight.error || rideMode.error) && (
                <Text style={[styles.note, { color: crit, marginBottom: 12 }]}>{lock.error || headlight.error || rideMode.error}</Text>
              )}
            </>
          )}

          {!rawDps && (
            <Card style={styles.cardGap}>
              <ActivityIndicator color={accentColor} />
              <Text
                style={[styles.note, { color: inkDim, marginTop: 8 }]}>{`Waiting for the ${noun.lower} to push data over Bluetooth…`}</Text>
            </Card>
          )}

          {rawDps && (
            <>
              <SectionLabel>Ride modes</SectionLabel>
              <View style={styles.tiles}>
                {MODE_ORDER.map((m) => {
                  const TileIcon = MODE_ICONS[m];
                  const isSelected = m === selectedMode;
                  const color = MODE_META[m].color;
                  const modeCfg = MODE_DP_CONFIG[m];
                  const modeHasChange = [modeCfg.speedLimitDp, modeCfg.accelerationDp, modeCfg.decelerationDp].some((id) =>
                    pendingChanges.some((c) => c.dpId === id),
                  );
                  return (
                    <PressableScale
                      key={m}
                      onPress={() => setSelectedMode(m)}
                      style={[
                        styles.tile,
                        { borderColor: isSelected ? color : color + '33' },
                        isSelected && { backgroundColor: color + '18' },
                      ]}>
                      <TileIcon size={18} color={color} />
                      <ModeText mode={m} style={styles.tileLabel} />
                      {modeHasChange && <View style={[styles.dirtyDot, { backgroundColor: color }]} />}
                    </PressableScale>
                  );
                })}
              </View>

              <Card style={styles.cardGap}>
                <View style={styles.modeHeaderRow}>
                  <ModeIcon size={16} color={modeMeta.color} />
                  <FitText style={[styles.modeHeaderText, fontStyleFor(font), { color: modeMeta.color }]}>
                    <ModeText mode={selectedMode} /> mode
                  </FitText>
                </View>

                <SliderRow
                  label="Speed limit"
                  dpId={modeConfig.speedLimitDp}
                  value={rawValue(modeConfig.speedLimitDp)}
                  draft={draftFor(modeConfig.speedLimitDp)}
                  range={effectiveRange(modeConfig.speedLimitDp, modeConfig.speedLimitRange)}
                  unit=" km/h"
                  confirmed={modeConfig.speedLimitConfirmed}
                  accentColor={modeMeta.color}
                  inkDim={inkDim}
                  text={text}
                  warn={warn}
                  good={good}
                  justSaved={justSaved.has(modeConfig.speedLimitDp)}
                  onChange={(v) => setDraft(modeConfig.speedLimitDp, v)}
                  resetKey={sliderResetKey}
                />
                <SliderRow
                  label="Acceleration"
                  dpId={modeConfig.accelerationDp}
                  value={rawValue(modeConfig.accelerationDp)}
                  draft={draftFor(modeConfig.accelerationDp)}
                  range={effectiveRange(modeConfig.accelerationDp, ACCEL_DECEL_RANGE)}
                  unit="%"
                  confirmed={modeConfig.accelDecelConfirmed}
                  accentColor={modeMeta.color}
                  inkDim={inkDim}
                  text={text}
                  warn={warn}
                  good={good}
                  justSaved={justSaved.has(modeConfig.accelerationDp)}
                  onChange={(v) => setDraft(modeConfig.accelerationDp, v)}
                  resetKey={sliderResetKey}
                />
                <SliderRow
                  label="Deceleration"
                  dpId={modeConfig.decelerationDp}
                  value={rawValue(modeConfig.decelerationDp)}
                  draft={draftFor(modeConfig.decelerationDp)}
                  range={effectiveRange(modeConfig.decelerationDp, ACCEL_DECEL_RANGE)}
                  unit="%"
                  confirmed={modeConfig.accelDecelConfirmed}
                  accentColor={modeMeta.color}
                  inkDim={inkDim}
                  text={text}
                  warn={warn}
                  good={good}
                  justSaved={justSaved.has(modeConfig.decelerationDp)}
                  onChange={(v) => setDraft(modeConfig.decelerationDp, v)}
                  resetKey={sliderResetKey}
                />
              </Card>

              <SectionLabel>Braking</SectionLabel>
              <Card style={styles.cardGap}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>R-LOS Autobrake</Text>
                  {autobrakeSending ? (
                    <ActivityIndicator size="small" color={accentColor} />
                  ) : (
                    <Switch value={autobrakeOn} onValueChange={toggleAutobrake} />
                  )}
                </View>
                {autobrakeQueued && !autobrakeError && <Text style={styles.note}>Saved. Applies when the {noun.lower} reconnects.</Text>}
                {autobrakeError && <Text style={[styles.note, { color: crit }]}>{autobrakeError}</Text>}
                <SliderRow
                  label="Brake power max"
                  dpId={GLOBAL_DP.brakePowerMax}
                  value={rawValue(GLOBAL_DP.brakePowerMax)}
                  draft={draftFor(GLOBAL_DP.brakePowerMax)}
                  range={effectiveRange(GLOBAL_DP.brakePowerMax, BRAKE_POWER_MAX_RANGE)}
                  unit="%"
                  confirmed={BRAKE_POWER_MAX_CONFIRMED}
                  accentColor={accentColor}
                  inkDim={inkDim}
                  text={text}
                  warn={warn}
                  good={good}
                  justSaved={justSaved.has(GLOBAL_DP.brakePowerMax)}
                  onChange={(v) => setDraft(GLOBAL_DP.brakePowerMax, v)}
                  resetKey={sliderResetKey}
                />
              </Card>

              {/* Editable settings; enum values/ranges come live from the device's Tuya schema, falling back to read-only display while it loads. */}
              <SectionLabel>{`${noun.Cap} info`}</SectionLabel>
              <Card style={styles.cardGap}>
                <EnumFieldRow
                  label="Direction"
                  dpId={GLOBAL_DP.direction}
                  rawDps={rawDps}
                  drafts={drafts}
                  schema={schema}
                  accentColor={accentColor}
                  inkDim={inkDim}
                  text={text}
                  good={good}
                  justSaved={justSaved.has(GLOBAL_DP.direction)}
                  onChange={(v) => setFieldDraft(GLOBAL_DP.direction, v)}
                />
                <EnumFieldRow
                  label="Motor type"
                  dpId={GLOBAL_DP.motorType}
                  rawDps={rawDps}
                  drafts={drafts}
                  schema={schema}
                  accentColor={accentColor}
                  inkDim={inkDim}
                  text={text}
                  good={good}
                  justSaved={justSaved.has(GLOBAL_DP.motorType)}
                  onChange={(v) => setFieldDraft(GLOBAL_DP.motorType, v)}
                />
                <NumberFieldRow
                  label="Wheel diameter"
                  dpId={GLOBAL_DP.wheelDiameter}
                  rawDps={rawDps}
                  drafts={drafts}
                  schema={schema}
                  fallbackUnit="mm"
                  accentColor={accentColor}
                  inkDim={inkDim}
                  text={text}
                  good={good}
                  justSaved={justSaved.has(GLOBAL_DP.wheelDiameter)}
                  onChange={(v) => setFieldDraft(GLOBAL_DP.wheelDiameter, v)}
                />
                <NumberFieldRow
                  label="Motor ratio"
                  dpId={GLOBAL_DP.motorRatio}
                  rawDps={rawDps}
                  drafts={drafts}
                  schema={schema}
                  fallbackUnit=""
                  accentColor={accentColor}
                  inkDim={inkDim}
                  text={text}
                  good={good}
                  justSaved={justSaved.has(GLOBAL_DP.motorRatio)}
                  onChange={(v) => setFieldDraft(GLOBAL_DP.motorRatio, v)}
                />
                <NumberFieldRow
                  label="Motor pole pairs"
                  dpId={GLOBAL_DP.motorPolePairs}
                  rawDps={rawDps}
                  drafts={drafts}
                  schema={schema}
                  fallbackUnit="p"
                  accentColor={accentColor}
                  inkDim={inkDim}
                  text={text}
                  good={good}
                  justSaved={justSaved.has(GLOBAL_DP.motorPolePairs)}
                  onChange={(v) => setFieldDraft(GLOBAL_DP.motorPolePairs, v)}
                />
                <EnumFieldRow
                  label="Distance unit"
                  dpId={GLOBAL_DP.unit}
                  rawDps={rawDps}
                  drafts={drafts}
                  schema={schema}
                  accentColor={accentColor}
                  inkDim={inkDim}
                  text={text}
                  good={good}
                  justSaved={justSaved.has(GLOBAL_DP.unit)}
                  onChange={(v) => setFieldDraft(GLOBAL_DP.unit, v)}
                  last
                />
              </Card>

              {/* Genuinely read-only — no way to "set" battery/voltage from here. */}
              <SectionLabel>Live telemetry</SectionLabel>
              <Card style={styles.cardGap}>
                <InfoRow
                  label={`${noun.Cap} battery`}
                  value={formatDpValue(GLOBAL_DP.battery, rawDps[GLOBAL_DP.battery], { unit: '%' })}
                  text={text}
                />
                <InfoRow
                  label="Remote Battery"
                  value={formatDpValue(GLOBAL_DP.remotePower, rawDps[GLOBAL_DP.remotePower], { unit: '%' })}
                  text={text}
                />
                <InfoRow
                  label="Voltage"
                  value={formatDpValue(GLOBAL_DP.voltage, rawDps[GLOBAL_DP.voltage], { unit: 'V', scale: 1 })}
                  text={text}
                  last
                />
              </Card>
            </>
          )}
        </View>
      </ScrollView>
      <FloatingBackHeader icon={Settings2} title={`${noun.Cap} settings`} onPress={() => router.back()} />

      <ModeSelectModal
        visible={modeModalVisible}
        current={rideMode.mode}
        onClose={() => setModeModalVisible(false)}
        onSelect={(m) => {
          setModeModalVisible(false);
          void rideMode.select(m);
        }}
      />

      {pendingChanges.length > 0 && (
        <View style={[styles.floatingBar, { backgroundColor: surface, paddingBottom: insets.bottom + 14 }]}>
          <View style={styles.floatingBarText}>
            <Text style={[styles.floatingBarTitle, { color: text }]}>
              {pendingChanges.length} change{pendingChanges.length === 1 ? '' : 's'} pending
            </Text>
            <Text style={[styles.floatingBarSubtitle, { color: inkDim }]} numberOfLines={1}>
              {pendingChanges.map((c) => c.meta.label).join(' · ')}
            </Text>
          </View>
          <PressableScale style={[styles.barButton, styles.cancelBarButton, { borderColor: crit }]} onPress={cancelChanges}>
            <X size={16} color={crit} />
          </PressableScale>
          <PressableScale style={[styles.barButton, { backgroundColor: accentColor }]} onPress={() => setSaveState('confirming')}>
            <Text style={styles.saveBarButtonText}>Save</Text>
          </PressableScale>
        </View>
      )}

      <AppModal
        visible={saveState === 'confirming' || saveState === 'error' || saveState === 'queued'}
        onRequestClose={() => setSaveState('idle')}
        contentStyle={modalStyles.card}>
        {saveState === 'queued' ? (
          <>
            <WifiOff size={26} color={warn} />
            <Text style={[modalStyles.title, { color: text }]}>Saved. Applies when the {noun.lower} reconnects</Text>
            <ScrollView style={modalStyles.list} nestedScrollEnabled>
              {queuedLabels.map((label) => (
                <View key={label} style={modalStyles.listRow}>
                  <Text style={[modalStyles.listRowLabel, { color: text }]}>{label}</Text>
                </View>
              ))}
            </ScrollView>
            <Text style={[modalStyles.body, { color: inkDim, fontSize: 12 }]}>
              {`Your ${noun.lower} is offline right now. These changes are saved on this phone and are written to the ${noun.lower} as soon as it reconnects. You don't need to save them again.`}
            </Text>
            <PressableScale style={[modalStyles.confirmButton, { backgroundColor: accentColor }]} onPress={() => setSaveState('idle')}>
              <Text style={modalStyles.confirmText}>Got it</Text>
            </PressableScale>
          </>
        ) : (
          <>
            <AlertTriangle size={26} color={hasUnconfirmedChange ? crit : warn} />
            <Text
              style={[
                modalStyles.title,
                { color: text },
              ]}>{`Save ${pendingChanges.length} change${pendingChanges.length === 1 ? '' : 's'} to your ${noun.lower}?`}</Text>
            <ScrollView style={modalStyles.list} nestedScrollEnabled>
              {pendingChanges.map((c) => (
                <View key={c.dpId} style={modalStyles.listRow}>
                  <Text style={[modalStyles.listRowLabel, { color: text }]}>
                    {c.meta.label}
                    {!c.meta.confirmed && ' (unconfirmed)'}
                  </Text>
                  <Text style={[modalStyles.listRowValue, { color: inkDim }]}>
                    {formatChangeValue(c.dpId, rawFieldValue(c.dpId), schema, c.meta.unit)} →{' '}
                    {formatChangeValue(c.dpId, c.draft, schema, c.meta.unit)}
                  </Text>
                </View>
              ))}
            </ScrollView>
            {hasUnconfirmedChange && (
              <Text style={[modalStyles.body, { color: crit, fontSize: 12 }]}>
                Includes at least one setting whose mapping hasn't been confirmed on a real board.
              </Text>
            )}
            {!online && (
              <Text style={[modalStyles.body, { color: warn, fontSize: 12 }]}>
                {`Your ${noun.lower} is offline. This saves on your phone and applies when it reconnects.`}
              </Text>
            )}
            <Text
              style={[
                modalStyles.body,
                { color: inkDim, fontSize: 12 },
              ]}>{`This writes directly to your ${noun.lower} over Bluetooth, right now.`}</Text>
            {saveState === 'error' && <Text style={[modalStyles.body, { color: crit }]}>{saveError}</Text>}
            <PressableScale
              style={[modalStyles.confirmButton, { backgroundColor: hasUnconfirmedChange ? crit : warn }]}
              onPress={confirmSave}>
              <Text style={modalStyles.confirmText}>Save</Text>
            </PressableScale>
          </>
        )}
      </AppModal>

      {/* Full-screen, not the smaller confirm/error/queued card above — this is the
          "writing to the board right now" moment, deliberately more prominent than a
          small inline spinner so a dropped/slow BLE write is obviously still in progress. */}
      <AppModal visible={saveState === 'saving' || saveState === 'saved'} onRequestClose={() => {}} variant="fullScreen">
        {saveState === 'saved' ? (
          <>
            <View style={[modalStyles.fullScreenIconCircle, { backgroundColor: saveConfident ? good : warn }]}>
              {saveConfident ? <Check size={40} color="#fff" /> : <AlertTriangle size={36} color="#fff" />}
            </View>
            <Text style={[modalStyles.fullScreenTitle, { color: text }]}>
              {saveConfident ? `Saved to ${noun.lower}` : 'Sent, but connection dropped'}
            </Text>
            {!saveConfident && (
              <Text style={[modalStyles.body, { color: inkDim, fontSize: 12 }]}>
                The board stopped responding partway through. Check these settings took before riding.
              </Text>
            )}
          </>
        ) : (
          <>
            <View style={[modalStyles.fullScreenIconCircle, { backgroundColor: accentColor }]}>
              <Settings2 size={36} color="#fff" />
            </View>
            <ActivityIndicator color={accentColor} style={{ marginTop: 20 }} />
            <Text style={[modalStyles.fullScreenTitle, { color: text }]}>
              {savingProgress ? `Applying ${savingProgress.label}…` : 'Applying settings…'}
            </Text>
            {savingProgress && savingProgress.total > 1 && (
              <Text style={[modalStyles.body, { color: inkDim }]}>
                {savingProgress.index} of {savingProgress.total}
              </Text>
            )}
            <Text style={[modalStyles.body, { color: inkDim, fontSize: 12, marginTop: 12 }]}>
              Writing to the board over Bluetooth. Keep it nearby.
            </Text>
          </>
        )}
      </AppModal>
    </View>
  );
}

/** Confirm-modal old→new display value — humanized for enums, schema-scaled for numeric types. */
function formatChangeValue(
  dpId: string,
  value: number | string | null,
  schema: Record<string, BoardDpSchema> | null,
  fallbackUnit: string,
): string {
  if (value == null) return '—';
  if (typeof value === 'string') return humanizeEnumValue(value);
  const entry = schema?.[dpId];
  if (entry?.type === 'value' && entry.scale) return `${formatScaled(value, entry.scale)}${entry.unit || fallbackUnit}`;
  return `${value}${fallbackUnit}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { flex: 1 },
  content: { padding: 20, gap: 4, paddingBottom: 60 },
  contentWithBar: { paddingBottom: 130 },
  subtitle: { fontSize: 13, lineHeight: 18, marginBottom: 12 },
  cardGap: { gap: 4 },
  tiles: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  tile: { flex: 1, alignItems: 'center', gap: 5, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5 },
  tileLabel: { fontSize: 12, fontWeight: '600' },
  dirtyDot: { position: 'absolute', top: 8, right: 8, width: 6, height: 6, borderRadius: 3 },
  modeHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 6 },
  modeHeaderText: { fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  rowLabel: { fontSize: 14 },
  quickControlLabel: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  note: { fontSize: 12, lineHeight: 17 },
  floatingBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 14,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    elevation: 12,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -3 },
  },
  floatingBarText: { flex: 1 },
  floatingBarTitle: { fontSize: 14, fontWeight: '700' },
  floatingBarSubtitle: { fontSize: 11, marginTop: 1 },
  barButton: { borderRadius: 12, paddingVertical: 11, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  cancelBarButton: { backgroundColor: 'transparent', borderWidth: 1.5, paddingHorizontal: 11 },
  saveBarButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});

const modalStyles = StyleSheet.create({
  card: { maxHeight: '85%' },
  title: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  list: { alignSelf: 'stretch', maxHeight: 220 },
  listRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#8884' },
  listRowLabel: { fontSize: 13, fontWeight: '600' },
  listRowValue: { fontSize: 12, marginTop: 2, fontVariant: ['tabular-nums'] },
  confirmButton: { alignSelf: 'stretch', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  confirmText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  fullScreenIconCircle: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  fullScreenTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center', marginTop: 8 },
});
