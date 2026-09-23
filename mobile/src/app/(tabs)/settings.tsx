import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { BackHandler, StyleSheet, TextInput, ScrollView, Switch, Linking, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import * as Sharing from 'expo-sharing';
import * as Location from 'expo-location';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Settings as SettingsIcon,
  Trash2,
  AlertTriangle,
  User,
  Bluetooth,
  Zap,
  HeartPulse,
  Palette,
  Bell,
  LayoutGrid,
  Wrench,
  ChevronRight,
  Globe,
  Info,
  Code,
  Mail,
  Check,
  type LucideIcon,
} from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { StatusDot } from '@/components/ui/StatusDot';
import { Card } from '@/components/ui/Card';
import { AppModal } from '@/components/ui/AppModal';
import { ChecklistModalBody } from '@/components/ui/ChecklistModalBody';
import { ConfirmModalBody } from '@/components/ui/ConfirmModalBody';
import { PressableScale } from '@/components/ui/PressableScale';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { BackgroundLocationDisclosure } from '@/features/rides/components/BackgroundLocationDisclosure';
import { FloatingBackHeader, PILL_TOP_OFFSET, PILL_CLEARANCE } from '@/components/ui/FloatingBackHeader';
import { GlassBackdrop } from '@/components/ui/GlassBackdrop';
import { NaveePairingCard } from '@/features/device/components/NaveePairingCard';
import { TuyaPairingCard } from '@/features/device/components/TuyaPairingCard';
import { EstimateSettingsCard } from '@/features/planner/components/EstimateSettingsCard';
import {
  getServerAddress,
  setServerAddress,
  getUseCustomServer,
  setUseCustomServer,
  api,
  authApi,
  DEFAULT_BRAND,
  PRODUCT_FAMILIES,
  type ProductFamily,
} from '@/lib/api';
import { updateSessionFromMe, useSession } from '@/features/auth/auth';
import { useDeviceNoun } from '@/features/device/deviceNoun';
import { useActiveDeviceBrand, useBleConnectionStatus } from '@/features/device/deviceLink';
import { RefreshBoardDataRow } from '@/features/device/components/RefreshBoardDataRow';
import { getUnsyncedTrips, type QueuedTrip } from '@/lib/db';
import { invalidateTrips, queryKeys, useDeletedTrips, useRestoreDeletedTrips } from '@/lib/queries';
import { useTripDeviceFilter } from '@/features/device/deviceFilter';
import { getAutoTrackingEnabled, setAutoTrackingEnabled } from '@/lib/settings';
import { getBackgroundSelfHealEnabled, setBackgroundSelfHealEnabled } from '@/features/device/backgroundSelfHeal';
import { formatDateTime } from '@/lib/dateFormat';
import {
  getBackgroundLocationPermissionStatus,
  getIgnoreBatteryOptimizationsStatus,
  getPowerSaveModeStatus,
  openPowerSaveModeSettings,
  recoverInterruptedTrip,
  requestBackgroundLocationPermission,
  requestIgnoreBatteryOptimizations,
  tripRecorder,
} from '@/features/rides/tripRecorder';
import { syncUnsyncedTrips } from '@/features/rides/tripSync';
import { exportLogForSharing } from '@/lib/log';
import {
  ACCENT_COLORS,
  ACCENT_LABELS,
  CONTAINER_LABELS,
  FONT_LABELS,
  useAppTheme,
  type AccentChoice,
  type ContainerStyle,
} from '@/lib/theme';
import {
  getWidgetAccent,
  getWidgetContainerStyle,
  getWidgetFont,
  getWidgetNeedle,
  loadWidgetAppearance,
  setWidgetAccent,
  setWidgetContainerStyle,
  setWidgetFont,
  setWidgetNeedle,
  type WidgetFontChoice,
  type WidgetNeedleChoice,
} from '@/features/widget/widgetAppearance';
import { WidgetPreview } from '@/features/widget/components/WidgetPreview';
import {
  getHealthConnectPermissionStatus,
  getHealthConnectWritePermissionStatus,
  isHealthConnectAvailable,
  openHealthConnectSettingsPage,
  requestHealthConnectPermissions,
  requestHealthConnectWritePermissions,
  syncLatestWeightToBackend,
} from '@/features/health/healthConnect';
import { useAppForegroundEffect } from '@/lib/useAppForeground';
import {
  getTripNotificationEnabled,
  setTripNotificationEnabled,
  isChannelBlocked,
  openNotificationChannelSettings,
  NOTIFICATION_CHANNEL_IDS,
} from '@/features/rides/tripNotifications';
import {
  getBoardConnectionNotificationsEnabled,
  setBoardConnectionNotificationsEnabled,
  BOARD_NOTIFICATION_CHANNEL_IDS,
} from '@/features/device/deviceConnectionNotifications';
import { getHomeRegion, setHomeRegion, clearHomeRegion, DEFAULT_RADIUS_M, type HomeRegion } from '@/features/rides/homeGeofence';

import type { GroupKey } from '@/features/settings/types';
import { choiceStyles, modalStyles, styles } from '@/features/settings/styles';
import { ChoiceRow } from '@/features/settings/components/ChoiceRow';
import { NotificationToggleRow } from '@/features/settings/components/NotificationToggleRow';
import { CheckForUpdatesRow } from '@/features/settings/components/CheckForUpdatesRow';

// The widget only ships precompiled layouts for these three fonts (no "Display" variant —
// its heavy display face has no widget-sized body-text form, mirroring theme.tsx's own
// body-text fallback for that choice). See widgetAppearance.ts / cityroam_widget_modern.xml.
const WIDGET_FONT_LABELS: Record<WidgetFontChoice, string> = { dash: 'Dashboard', modern: 'Modern', mono: 'Mono' };
const WIDGET_NEEDLE_LABELS: Record<WidgetNeedleChoice, string> = { accent: 'Accent', ink: 'Ink' };

type GroupMeta = {
  key: GroupKey;
  label: string;
  icon: LucideIcon;
  status?: string;
  content: ReactNode;
};

const GROUP_KEYS: GroupKey[] = [
  'account',
  'connection',
  'tracking',
  'notifications',
  'health',
  'appearance',
  'widget',
  'advanced',
  'about',
];

export default function SettingsScreen() {
  const router = useRouter();
  // Lets another screen (e.g. the Dashboard's "No device paired" tap) deep-link
  // straight into a detail view instead of landing on the hub.
  const { group: groupParam } = useLocalSearchParams<{ group?: string }>();
  const [openGroup, setOpenGroup] = useState<GroupKey | null>(null);

  useEffect(() => {
    if (groupParam && (GROUP_KEYS as string[]).includes(groupParam)) {
      setOpenGroup(groupParam as GroupKey);
    }
  }, [groupParam]);

  const { email, signOut, productFamilies, riderWeightKg } = useSession();
  const noun = useDeviceNoun();
  const [locationDisclosureOpen, setLocationDisclosureOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [useCustomServer, setUseCustomServerState] = useState(false);
  const [autoTracking, setAutoTracking] = useState(true);
  const [backgroundSelfHeal, setBackgroundSelfHeal] = useState(true);
  const [backgroundGranted, setBackgroundGranted] = useState(false);
  const [batteryOptimizationDisabled, setBatteryOptimizationDisabled] = useState(false);
  const [powerSaveModeOn, setPowerSaveModeOn] = useState(false);
  const [healthConnectAvailable, setHealthConnectAvailable] = useState(false);
  const [healthConnectGranted, setHealthConnectGranted] = useState(false);
  const [healthConnectWriteGranted, setHealthConnectWriteGranted] = useState(false);
  const [boardConnectNotify, setBoardConnectNotify] = useState(true);
  const [boardDisconnectNotify, setBoardDisconnectNotify] = useState(true);
  const [autoStartNotify, setAutoStartNotify] = useState(true);
  const [rideEndedNotify, setRideEndedNotify] = useState(true);
  const [finalizeSummaryNotify, setFinalizeSummaryNotify] = useState(true);
  const [powerSaveWarningNotify, setPowerSaveWarningNotify] = useState(true);
  const [autoStartChannelBlocked, setAutoStartChannelBlocked] = useState(false);
  const [rideEndedChannelBlocked, setRideEndedChannelBlocked] = useState(false);
  const [finalizeSummaryChannelBlocked, setFinalizeSummaryChannelBlocked] = useState(false);
  const [powerSaveWarningChannelBlocked, setPowerSaveWarningChannelBlocked] = useState(false);
  const [boardConnectChannelBlocked, setBoardConnectChannelBlocked] = useState(false);
  const [boardDisconnectChannelBlocked, setBoardDisconnectChannelBlocked] = useState(false);
  const [homeRegion, setHomeRegionState] = useState<HomeRegion | null>(null);
  const [settingHomeRegion, setSettingHomeRegion] = useState(false);
  const [homeRegionError, setHomeRegionError] = useState<string | null>(null);
  const { font, accent, containerStyle, accentColor, setFont, setAccent, setContainerStyle } = useAppTheme();
  // The widget's own font/accent, independent of the app's theme above — see
  // widgetAppearance.ts for why they're deliberately decoupled. Local component state
  // (not context) since this is the only screen that reads or edits it.
  const [widgetFont, setWidgetFontState] = useState<WidgetFontChoice>('dash');
  const [widgetAccent, setWidgetAccentState] = useState<AccentChoice>('orange');
  const [widgetNeedle, setWidgetNeedleState] = useState<WidgetNeedleChoice>('accent');
  const [widgetContainerStyle, setWidgetContainerStyleState] = useState<ContainerStyle>('matte');
  const textColor = useThemeColor({}, 'text');
  const placeholderColor = useThemeColor({ light: '#888', dark: '#777' }, 'text');
  const good = useThemeColor({}, 'good');
  const crit = useThemeColor({}, 'crit');
  const warn = useThemeColor({}, 'warn');
  const inkDim = useThemeColor({}, 'inkDim');
  const inkFaint = useThemeColor({}, 'inkFaint');
  const queryClient = useQueryClient();
  const [restoreModalVisible, setRestoreModalVisible] = useState(false);
  const [selectedRestoreIds, setSelectedRestoreIds] = useState<Set<number>>(new Set());
  // null = hidden; a string = the dialog is visible showing that error message.
  const [batteryErrorMessage, setBatteryErrorMessage] = useState<string | null>(null);
  const [powerSaveErrorMessage, setPowerSaveErrorMessage] = useState<string | null>(null);
  const { deviceId: activeDeviceId } = useTripDeviceFilter();
  const deletedTrips = useDeletedTrips(activeDeviceId);
  const restoreTrips = useRestoreDeletedTrips();

  const toggleRestoreSelection = (id: number) => {
    setSelectedRestoreIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allRestoreSelected = (deletedTrips.data?.length ?? 0) > 0 && selectedRestoreIds.size === deletedTrips.data?.length;
  const toggleSelectAllRestore = () => {
    setSelectedRestoreIds(allRestoreSelected ? new Set() : new Set(deletedTrips.data?.map((t) => t.id)));
  };

  useEffect(() => {
    getServerAddress().then(setAddress);
    getUseCustomServer().then(setUseCustomServerState);
    getAutoTrackingEnabled().then(setAutoTracking);
    getBackgroundSelfHealEnabled().then(setBackgroundSelfHeal);
    getBoardConnectionNotificationsEnabled(true).then(setBoardConnectNotify);
    getBoardConnectionNotificationsEnabled(false).then(setBoardDisconnectNotify);
    getTripNotificationEnabled('auto-start').then(setAutoStartNotify);
    getTripNotificationEnabled('ride-ended').then(setRideEndedNotify);
    getTripNotificationEnabled('finalize-summary').then(setFinalizeSummaryNotify);
    getTripNotificationEnabled('power-save-warning').then(setPowerSaveWarningNotify);
    isChannelBlocked(NOTIFICATION_CHANNEL_IDS.autoStart).then((blocked) => setAutoStartChannelBlocked(blocked === true));
    isChannelBlocked(NOTIFICATION_CHANNEL_IDS.rideEnded).then((blocked) => setRideEndedChannelBlocked(blocked === true));
    isChannelBlocked(NOTIFICATION_CHANNEL_IDS.finalizeSummary).then((blocked) => setFinalizeSummaryChannelBlocked(blocked === true));
    isChannelBlocked(NOTIFICATION_CHANNEL_IDS.powerSaveWarning).then((blocked) => setPowerSaveWarningChannelBlocked(blocked === true));
    isChannelBlocked(BOARD_NOTIFICATION_CHANNEL_IDS.connect).then((blocked) => setBoardConnectChannelBlocked(blocked === true));
    isChannelBlocked(BOARD_NOTIFICATION_CHANNEL_IDS.disconnect).then((blocked) => setBoardDisconnectChannelBlocked(blocked === true));
    getHomeRegion().then(setHomeRegionState);
    // widgetSync.ts also loads this at boot, but re-loading here is cheap and makes this
    // screen correct regardless of module import ordering.
    loadWidgetAppearance().then(() => {
      setWidgetFontState(getWidgetFont());
      setWidgetAccentState(getWidgetAccent());
      setWidgetNeedleState(getWidgetNeedle());
      setWidgetContainerStyleState(getWidgetContainerStyle());
    });
  }, []);

  // A detail view is local-state overlay, not a real pushed route, so it gets no back-stack
  // entry of its own — without this, hardware/gesture back while one is open would fall
  // through to the tab's own back behavior instead of returning to the hub.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!openGroup) return false;
      setOpenGroup(null);
      return true;
    });
    return () => sub.remove();
  }, [openGroup]);

  // Auto-checked, not a manual button — the app ships pointed at the real backend by default, so this just reflects live reachability.
  const health = useQuery({ queryKey: queryKeys.health, queryFn: api.health, refetchInterval: 30_000 });
  const bleStatus = useBleConnectionStatus();
  const activeBrand = useActiveDeviceBrand();

  // Re-checked on foreground return, since a system Settings trip is expected to change these without a manual refresh.
  useAppForegroundEffect(() => {
    isHealthConnectAvailable().then(setHealthConnectAvailable);
    getHealthConnectPermissionStatus().then(setHealthConnectGranted);
    getHealthConnectWritePermissionStatus().then(setHealthConnectWriteGranted);
    getBackgroundLocationPermissionStatus().then(setBackgroundGranted);
    setBatteryOptimizationDisabled(getIgnoreBatteryOptimizationsStatus());
    setPowerSaveModeOn(getPowerSaveModeStatus());
    isChannelBlocked(NOTIFICATION_CHANNEL_IDS.autoStart).then((blocked) => setAutoStartChannelBlocked(blocked === true));
    isChannelBlocked(NOTIFICATION_CHANNEL_IDS.rideEnded).then((blocked) => setRideEndedChannelBlocked(blocked === true));
    isChannelBlocked(NOTIFICATION_CHANNEL_IDS.finalizeSummary).then((blocked) => setFinalizeSummaryChannelBlocked(blocked === true));
    isChannelBlocked(NOTIFICATION_CHANNEL_IDS.powerSaveWarning).then((blocked) => setPowerSaveWarningChannelBlocked(blocked === true));
    isChannelBlocked(BOARD_NOTIFICATION_CHANNEL_IDS.connect).then((blocked) => setBoardConnectChannelBlocked(blocked === true));
    isChannelBlocked(BOARD_NOTIFICATION_CHANNEL_IDS.disconnect).then((blocked) => setBoardDisconnectChannelBlocked(blocked === true));
    // Best-effort background weight sync — push the freshest Health Connect
    // weight to the backend so estimates stay correct even when Health Connect is
    // unreachable later. Silent on failure; never blocks anything. On success the
    // returned MeResponse refreshes the session's persisted rider weight. The session's
    // current riderWeightKg is passed in as the change-guard: when the live reading
    // already matches what the backend has, the sync is a no-op (no redundant PUT).
    syncLatestWeightToBackend(riderWeightKg).then((me) => {
      if (me) updateSessionFromMe(me);
    });
  });

  const offlineQueue = useQuery({ queryKey: ['offline-trip-queue'], queryFn: getUnsyncedTrips });
  const syncNow = useMutation({
    mutationFn: syncUnsyncedTrips,
    onSuccess: () => {
      invalidateTrips(queryClient);
      offlineQueue.refetch();
    },
  });
  // Covers the rarer, worse case than the offline queue above: a trip that failed
  // before it ever reached local storage (see LocalEnqueueError in tripSync.ts) never
  // shows up in offlineQueue — its only path back is the on-disk checkpoint the
  // recorder writes throughout a ride, normally replayed automatically on the next app
  // foreground. This lets a rider force that retry now instead of waiting.
  // recoverInterruptedTrip() blindly finalizes whatever checkpoint is on disk — it has
  // no notion of "a ride is currently recording" (see tripRecorder.ts's docstring: it
  // exists for the post-crash/restart case, where nothing is). app/_layout.tsx's own
  // foreground-triggered call guards on state === 'idle' for exactly that reason; this
  // manual retry must too, or tapping it mid-ride would finalize the *in-progress* ride
  // as if it were an abandoned one — a premature, incomplete save, while the real ride
  // keeps recording and gets saved again (properly) when it actually finishes.
  const recorderState = useSyncExternalStore(tripRecorder.subscribe, tripRecorder.getSnapshot).state;
  const checkInterrupted = useMutation({
    mutationFn: async () => {
      if (tripRecorder.getSnapshot().state !== 'idle') {
        throw new Error("Can't check while a ride is recording. Finish or stop it first.");
      }
      return recoverInterruptedTrip();
    },
    onSuccess: (recovered) => {
      if (recovered) {
        invalidateTrips(queryClient);
        offlineQueue.refetch();
      }
    },
  });

  const saveAndTest = useMutation({
    mutationFn: async () => {
      await setServerAddress(address);
      return api.health();
    },
    onSuccess: () => {
      // Anything cached was fetched from the old server address, so it can't be trusted.
      queryClient.invalidateQueries();
    },
  });

  const logout = useMutation({ mutationFn: signOut });

  // Account-level product-family allow-list. The backend keeps only known
  // families and defaults an empty list back to ["tynee"]; the returned MeResponse
  // refreshes the session so the pairing/catalog UI re-gates immediately.
  const saveFamilies = useMutation({
    mutationFn: (families: string[]) => authApi.putFamilies(families),
    onSuccess: (me) => updateSessionFromMe(me),
  });

  const groups: GroupMeta[] = [
    {
      key: 'account',
      label: 'Account',
      icon: User,
      status: email || undefined,
      content: (
        <Card style={styles.cardGap}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Logged in as {email}</Text>
          </View>

          {/* One family at a time: a rider uses one machine, and the choice decides both
              what the app is allowed to pair and what it calls it throughout. */}
          <Text style={styles.label}>Product family</Text>
          <View style={choiceStyles.row}>
            {(Object.keys(PRODUCT_FAMILIES) as ProductFamily[]).map((family) => {
              const selected = productFamilies.includes(family);
              return (
                <PressableScale
                  key={family}
                  disabled={saveFamilies.isPending}
                  // Replaces rather than toggles: there is always exactly one, and
                  // tapping the selected chip off would leave the account with none.
                  onPress={() => !selected && saveFamilies.mutate([family])}
                  style={[choiceStyles.chip, selected && { borderColor: accentColor, backgroundColor: accentColor + '22' }]}>
                  <Text style={[choiceStyles.chipText, selected && { color: accentColor, fontWeight: '700' }]}>
                    {PRODUCT_FAMILIES[family]}
                  </Text>
                </PressableScale>
              );
            })}
          </View>
          <Text style={styles.note}>Which device brand do you ride? Sets what Cityroam pairs with.</Text>

          <PressableScale
            style={[styles.button, styles.buttonNoMargin, { backgroundColor: crit, opacity: logout.isPending ? 0.5 : 1 }]}
            disabled={logout.isPending}
            onPress={() => logout.mutate()}>
            <Text style={styles.buttonText}>{logout.isPending ? 'Logging out…' : 'Log out'}</Text>
          </PressableScale>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: `${noun.Cap} & Connection`,
      icon: Bluetooth,
      // Pairing/live-link status, not backend reachability — "Connected" alone
      // read as ambiguous between the two. Same state/labels as BleConnectionIndicator.
      status: !productFamilies.some((family) => family === DEFAULT_BRAND || family === 'navee')
        ? `${noun.Cap} pairing disabled`
        : !bleStatus.paired
          ? `${noun.Cap} not paired`
          : bleStatus.charging === true
            ? `${noun.Cap} charging`
            : bleStatus.online === true
              ? `Connected to ${noun.lower}`
              : bleStatus.searchingTimeout
                ? `Disconnected from ${noun.lower}`
                : 'Searching for device…',
      content: (
        <>
          <Text style={styles.section}>Backend server</Text>
          <Card style={styles.cardGap}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Connection</Text>
              <View style={[styles.statusRow, styles.statusRowInline]}>
                <StatusDot color={health.isError ? crit : good} />
                <Text style={[styles.status, styles.statusInline, health.isError && styles.statusError]}>
                  {health.isPending ? 'Checking…' : health.isError ? 'Unreachable' : 'Connected'}
                </Text>
              </View>
            </View>
            <Text style={styles.note}>Uses the Cityroam server by default. Nothing to set up.</Text>

            <View style={styles.row}>
              <Text style={styles.rowLabel}>Custom server address</Text>
              <Switch
                testID="customServerToggle"
                value={useCustomServer}
                onValueChange={(v) => {
                  setUseCustomServerState(v);
                  setUseCustomServer(v)
                    .then(() => queryClient.invalidateQueries())
                    .catch((err) => console.error('[useCustomServer]', err));
                }}
              />
            </View>
            <Text style={styles.note}>Only for development or a self-hosted server.</Text>

            {useCustomServer && (
              <>
                <Text style={styles.label}>Server address</Text>
                <TextInput
                  style={[styles.input, { color: textColor }]}
                  placeholder="https://cityroam.example.com"
                  placeholderTextColor={placeholderColor}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={address}
                  onChangeText={setAddress}
                />
                <PressableScale style={[styles.button, { backgroundColor: accentColor }]} onPress={() => saveAndTest.mutate()}>
                  <Text style={styles.buttonText}>Save & test connection</Text>
                </PressableScale>
                {saveAndTest.status !== 'idle' && (
                  <Text style={[styles.status, saveAndTest.isError && styles.statusError]}>
                    {saveAndTest.isPending ? 'Checking…' : saveAndTest.isError ? String((saveAndTest.error as Error).message) : 'Connected'}
                  </Text>
                )}
              </>
            )}
          </Card>

          <Text style={styles.section}>{noun.Cap} connection</Text>
          <Card style={styles.cardGap}>
            {(() => {
              const tuyaCard = (
                <>
                  <Text style={styles.note}>
                    Sign in with your Tuya account once to read your {noun.lower}&apos;s keys. After that Cityroam talks to it over
                    Bluetooth with no internet, and the Tuya app keeps working.
                  </Text>
                  <TuyaPairingCard />
                </>
              );
              const naveeCard = (
                <>
                  <Text style={styles.note}>
                    Sign in with your NAVEE account once so Cityroam can connect to your {noun.lower} over Bluetooth. After that no internet
                    is needed, and the NAVEE app keeps working.
                  </Text>
                  <NaveePairingCard />
                </>
              );
              // A paired device shows its own brand's card; with nothing paired, every
              // enabled brand offers its own sign-in.
              if (bleStatus.paired && activeBrand === 'navee') return naveeCard;
              if (bleStatus.paired && activeBrand === DEFAULT_BRAND) return tuyaCard;
              const tuya = productFamilies.includes(DEFAULT_BRAND);
              const navee = productFamilies.includes('navee');
              if (!tuya && !navee) {
                return <Text style={styles.note}>Enable Tynee or NAVEE under Account above to pair a {noun.lower}.</Text>;
              }
              return (
                <>
                  {tuya && tuyaCard}
                  {navee && naveeCard}
                </>
              );
            })()}
          </Card>
        </>
      ),
    },
    {
      key: 'tracking',
      label: 'Ride Tracking',
      icon: Zap,
      status: `Auto-tracking ${autoTracking ? 'on' : 'off'}`,
      content: (
        <>
          <Text style={styles.section}>Auto-tracking</Text>
          <Card style={styles.cardGap}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Detect rides automatically</Text>
              <Switch
                value={autoTracking}
                onValueChange={(v) => {
                  setAutoTracking(v);
                  setAutoTrackingEnabled(v).catch((err) => console.error('[autoTracking]', err));
                }}
              />
            </View>
            <Text style={styles.note}>The floating timer button always works regardless of this toggle.</Text>

            <View style={styles.row}>
              <Text style={styles.rowLabel}>Background tracking</Text>
              {backgroundGranted ? (
                <View style={[styles.statusRow, styles.statusRowInline]}>
                  <Check size={14} color={good} />
                  <Text style={[styles.status, styles.statusInline]}>Enabled</Text>
                </View>
              ) : (
                <PressableScale
                  style={[styles.smallButton, { backgroundColor: accentColor }]}
                  // Play requires the disclosure to immediately precede the runtime
                  // request, so the permission call lives behind it, never here.
                  onPress={() => setLocationDisclosureOpen(true)}>
                  <Text style={styles.smallButtonText}>Enable</Text>
                </PressableScale>
              )}
            </View>
            <Text style={styles.note}>
              Without this, a ride stops recording as soon as the screen locks. Choose &quot;Allow all the time&quot; on the system screen
              that follows.
            </Text>
            {!backgroundGranted && (
              <PressableScale onPress={() => Linking.openSettings()}>
                <Text style={[styles.linkText, { color: accentColor }]}>
                  Already said no once? Open this app's system settings directly →
                </Text>
              </PressableScale>
            )}

            <View style={styles.row}>
              <Text style={styles.rowLabel}>Battery optimization</Text>
              {batteryOptimizationDisabled ? (
                <View style={[styles.statusRow, styles.statusRowInline]}>
                  <StatusDot color={good} />
                  <Text style={[styles.status, styles.statusInline]}>Disabled</Text>
                </View>
              ) : (
                <PressableScale
                  style={[styles.smallButton, { backgroundColor: accentColor }]}
                  onPress={() =>
                    requestIgnoreBatteryOptimizations()
                      .then(() => setBatteryOptimizationDisabled(getIgnoreBatteryOptimizationsStatus()))
                      .catch((err) =>
                        setBatteryErrorMessage(
                          `Your phone declined this request${err instanceof Error && err.message ? `: ${err.message}` : ''}. Try Settings > Apps > Cityroam > Battery directly instead.`,
                        ),
                      )
                  }>
                  <Text style={styles.smallButtonText}>Disable</Text>
                </PressableScale>
              )}
            </View>
            <Text style={styles.note}>
              Some phones (Xiaomi, Samsung, and others) can stop location tracking mid-ride even with background tracking enabled above.
              Exempting the app from battery optimization prevents that.
            </Text>
            <Text style={styles.note}>
              On Samsung phones this exemption isn't enough on its own. Samsung keeps a separate "sleeping apps" list that can still suspend
              Cityroam in the background. Check Settings → Battery and device care → Background usage limits, and make sure Cityroam isn't
              listed under "Sleeping apps" or "Deep sleeping apps" (remove it if it is), then Settings → Apps → Cityroam → Battery → set to
              "Unrestricted."
            </Text>

            {/* System-wide Battery Saver, distinct from the per-app whitelist above — no in-app exemption exists, so this only detect-and-warns. */}
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Battery Saver</Text>
              {powerSaveModeOn ? (
                <View style={[styles.statusRow, styles.statusRowInline]}>
                  <StatusDot color={crit} />
                  <Text style={[styles.status, styles.statusInline, styles.statusError]}>On</Text>
                </View>
              ) : (
                <View style={[styles.statusRow, styles.statusRowInline]}>
                  <StatusDot color={good} />
                  <Text style={[styles.status, styles.statusInline]}>Off</Text>
                </View>
              )}
            </View>
            {powerSaveModeOn && (
              <>
                <Text style={[styles.note, styles.statusError]}>
                  Battery Saver is on. It's separate from battery optimization above, and while it's on Android can stop location tracking
                  during a ride. Turn it off before riding.
                </Text>
                <PressableScale
                  style={[styles.smallButton, { backgroundColor: accentColor, alignSelf: 'flex-start', marginTop: 4 }]}
                  onPress={() =>
                    openPowerSaveModeSettings().catch((err) =>
                      setPowerSaveErrorMessage(
                        `Try Settings > Battery > Battery Saver directly instead${err instanceof Error && err.message ? ` (${err.message})` : ''}.`,
                      ),
                    )
                  }>
                  <Text style={styles.smallButtonText}>Open Battery Saver settings</Text>
                </PressableScale>
              </>
            )}

            <View style={styles.row}>
              <Text style={styles.rowLabel}>Keep recording if Android kills the app</Text>
              <Switch
                value={backgroundSelfHeal}
                onValueChange={(v) => {
                  setBackgroundSelfHeal(v);
                  setBackgroundSelfHealEnabled(v).catch((err) => console.error('[backgroundSelfHeal]', err));
                }}
              />
            </View>
            <Text style={styles.note}>
              Android can still close the app during a long ride, even with everything above set up. Tracking then stays off until you open
              the app again. With this on, Android wakes the app about every 15 minutes (its minimum) to reconnect your {noun.lower} and
              resume tracking. It uses a little more battery. Turn it off if you'd rather reopen the app yourself.
            </Text>
          </Card>

          <Text style={styles.section}>Home area</Text>
          <Card style={styles.cardGap}>
            <Text style={styles.note}>
              Leaving this area wakes Cityroam in the background, even if Android has killed the app, so it's ready before you reach your{' '}
              {noun.lower}. It never starts a ride on its own; only your {noun.lower}'s own speed does that.
            </Text>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Home area</Text>
              {homeRegion ? (
                <View style={[styles.statusRow, styles.statusRowInline]}>
                  <StatusDot color={good} />
                  <Text style={[styles.status, styles.statusInline]}>Area set</Text>
                </View>
              ) : (
                <View style={[styles.statusRow, styles.statusRowInline]}>
                  <StatusDot color={crit} />
                  <Text style={[styles.status, styles.statusInline, styles.statusError]}>Not set</Text>
                </View>
              )}
            </View>
            <PressableScale
              style={[styles.button, styles.buttonNoMargin, { backgroundColor: accentColor, opacity: settingHomeRegion ? 0.5 : 1 }]}
              disabled={settingHomeRegion}
              onPress={() => {
                setHomeRegionError(null);
                if (homeRegion) {
                  clearHomeRegion().then(() => setHomeRegionState(null));
                  return;
                }
                // The geofence itself (startGeofencingAsync below) requires background
                // location, same permission the card above tracks — route through the
                // same disclosure-then-system-prompt flow rather than letting
                // startGeofencingAsync fail after a fix was already taken.
                if (!backgroundGranted) {
                  setLocationDisclosureOpen(true);
                  return;
                }
                setSettingHomeRegion(true);
                Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
                  .then((pos) => setHomeRegion(pos.coords.latitude, pos.coords.longitude))
                  .then(() => getHomeRegion())
                  .then(setHomeRegionState)
                  .catch((err) => {
                    console.error('[homeGeofence]', err);
                    setHomeRegionError(err instanceof Error ? err.message : String(err));
                  })
                  .finally(() => setSettingHomeRegion(false));
              }}>
              <Text style={styles.buttonText}>{settingHomeRegion ? 'Setting…' : homeRegion ? 'Clear' : 'Set home area'}</Text>
            </PressableScale>
            <Text style={[styles.note, { marginTop: 4 }]}>
              {homeRegion
                ? `A ${homeRegion.radiusM}m radius around your current location when you set it.`
                : `Uses your current location as the center of a ${DEFAULT_RADIUS_M}m radius.`}
            </Text>
            {homeRegionError ? <Text style={[styles.rowLabel, { color: crit }]}>{homeRegionError}</Text> : null}
          </Card>

          {/* User-entered weight/capacity sharpen range estimates beyond the backend defaults. */}
          <Text style={styles.section}>Range estimates</Text>
          <EstimateSettingsCard />
        </>
      ),
    },
    {
      key: 'notifications',
      label: 'Notifications',
      icon: Bell,
      status:
        !autoStartNotify &&
        !rideEndedNotify &&
        !finalizeSummaryNotify &&
        !powerSaveWarningNotify &&
        !boardConnectNotify &&
        !boardDisconnectNotify
          ? 'All off'
          : autoStartChannelBlocked ||
              rideEndedChannelBlocked ||
              finalizeSummaryChannelBlocked ||
              powerSaveWarningChannelBlocked ||
              boardConnectChannelBlocked ||
              boardDisconnectChannelBlocked
            ? 'Some blocked in Android'
            : undefined,
      content: (
        <>
          <Text style={styles.note}>
            Sound, vibration and Do Not Disturb for each notification below are set in Android's settings. Tap "Sound and vibration" under
            any of them to open that screen.
          </Text>

          <Text style={styles.section}>Rides</Text>
          <Card style={styles.cardGap}>
            <NotificationToggleRow
              label="Ride started"
              note="When a ride starts automatically."
              value={autoStartNotify}
              blocked={autoStartChannelBlocked}
              onValueChange={(v) => {
                setAutoStartNotify(v);
                void setTripNotificationEnabled('auto-start', v);
              }}
              onOpenChannelSettings={() => openNotificationChannelSettings(NOTIFICATION_CHANNEL_IDS.autoStart)}
            />
            <NotificationToggleRow
              label="Ride ended"
              note={`The moment recording stops, including when the ${noun.lower} disconnects. Sent right away, before “Ride saved”.`}
              value={rideEndedNotify}
              blocked={rideEndedChannelBlocked}
              onValueChange={(v) => {
                setRideEndedNotify(v);
                void setTripNotificationEnabled('ride-ended', v);
              }}
              onOpenChannelSettings={() => openNotificationChannelSettings(NOTIFICATION_CHANNEL_IDS.rideEnded)}
            />
            <NotificationToggleRow
              label="Ride saved"
              note="Distance, time and battery used once a ride finishes saving."
              value={finalizeSummaryNotify}
              blocked={finalizeSummaryChannelBlocked}
              onValueChange={(v) => {
                setFinalizeSummaryNotify(v);
                void setTripNotificationEnabled('finalize-summary', v);
              }}
              onOpenChannelSettings={() => openNotificationChannelSettings(NOTIFICATION_CHANNEL_IDS.finalizeSummary)}
            />
            <NotificationToggleRow
              label="Battery Saver during a ride"
              note="Once per ride, when Battery Saver is on. Android throttles location while it's on, and the app can't override that."
              value={powerSaveWarningNotify}
              blocked={powerSaveWarningChannelBlocked}
              onValueChange={(v) => {
                setPowerSaveWarningNotify(v);
                void setTripNotificationEnabled('power-save-warning', v);
              }}
              onOpenChannelSettings={() => openNotificationChannelSettings(NOTIFICATION_CHANNEL_IDS.powerSaveWarning)}
            />
          </Card>

          <Text style={styles.section}>{noun.Cap}</Text>
          <Card style={styles.cardGap}>
            <NotificationToggleRow
              label={`${noun.Cap} connected`}
              note={`When your ${noun.lower} connects.`}
              value={boardConnectNotify}
              blocked={boardConnectChannelBlocked}
              onValueChange={(v) => {
                setBoardConnectNotify(v);
                void setBoardConnectionNotificationsEnabled(true, v);
              }}
              onOpenChannelSettings={() => openNotificationChannelSettings(BOARD_NOTIFICATION_CHANNEL_IDS.connect)}
            />
            <NotificationToggleRow
              label={`${noun.Cap} disconnected`}
              note={`When your ${noun.lower} disconnects.`}
              value={boardDisconnectNotify}
              blocked={boardDisconnectChannelBlocked}
              onValueChange={(v) => {
                setBoardDisconnectNotify(v);
                void setBoardConnectionNotificationsEnabled(false, v);
              }}
              onOpenChannelSettings={() => openNotificationChannelSettings(BOARD_NOTIFICATION_CHANNEL_IDS.disconnect)}
            />
          </Card>
        </>
      ),
    },
    {
      key: 'health',
      label: 'Health & Data',
      icon: HeartPulse,
      status: !healthConnectAvailable ? 'Not available' : healthConnectGranted ? 'Health Connect enabled' : 'Health Connect disabled',
      content: (
        <>
          <Text style={styles.section}>Health sync</Text>
          <Card style={styles.cardGap}>
            {!healthConnectAvailable ? (
              <Text style={styles.note}>
                Health Connect isn't available on this device. Install it from the Play Store, or it's already part of the OS on Android
                14+.
              </Text>
            ) : (
              <>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Heart rate, steps, weight</Text>
                  {healthConnectGranted ? (
                    <View style={[styles.statusRow, styles.statusRowInline]}>
                      <StatusDot color={good} />
                      <Text style={[styles.status, styles.statusInline]}>Connected</Text>
                    </View>
                  ) : (
                    <PressableScale
                      style={[styles.smallButton, { backgroundColor: accentColor }]}
                      onPress={() => requestHealthConnectPermissions().then((r) => setHealthConnectGranted(r.granted))}>
                      <Text style={styles.smallButtonText}>Connect</Text>
                    </PressableScale>
                  )}
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Sync rides as workouts</Text>
                  {healthConnectWriteGranted ? (
                    <View style={[styles.statusRow, styles.statusRowInline]}>
                      <Check size={14} color={good} />
                      <Text style={[styles.status, styles.statusInline]}>Enabled</Text>
                    </View>
                  ) : (
                    <PressableScale
                      style={[styles.smallButton, { backgroundColor: accentColor }]}
                      onPress={() => requestHealthConnectWritePermissions().then((r) => setHealthConnectWriteGranted(r.granted))}>
                      <Text style={styles.smallButtonText}>Enable</Text>
                    </PressableScale>
                  )}
                </View>
                <Text style={styles.note}>
                  Each finished ride is logged as a Skating workout (Health Connect has no e-skate category) with its route, visible in
                  Health Connect and Google Fit.
                </Text>
                {!healthConnectGranted && (
                  <PressableScale onPress={openHealthConnectSettingsPage}>
                    <Text style={[styles.linkText, { color: accentColor }]}>Open Health Connect settings directly →</Text>
                  </PressableScale>
                )}
              </>
            )}
          </Card>

          <Text style={styles.section}>Offline trip queue</Text>
          <Card style={styles.cardGap}>
            {(offlineQueue.data?.length ?? 0) > 0 && (
              <View style={styles.cardGap}>
                {offlineQueue.data!.map((queued: QueuedTrip) => (
                  <View key={queued.localId} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowLabel}>
                        {formatDateTime(queued.payload.startTime)} · {queued.payload.distanceKm.toFixed(1)} km
                      </Text>
                      {queued.lastError && <Text style={[styles.note, styles.statusError]}>{queued.lastError}</Text>}
                    </View>
                    <Text style={[styles.status, styles.statusInline, queued.lastError ? styles.statusError : undefined]}>
                      {queued.lastError ? 'Failed' : 'Queued'}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            <PressableScale
              style={[styles.button, styles.buttonNoMargin, { backgroundColor: accentColor }]}
              onPress={() => syncNow.mutate()}>
              <Text style={styles.buttonText}>Sync now</Text>
            </PressableScale>
            {syncNow.status !== 'idle' && (
              <View style={styles.statusRow}>
                {syncNow.isSuccess && <StatusDot color={good} />}
                <Text style={[styles.status, styles.statusInline, syncNow.isError && styles.statusError]}>
                  {syncNow.isPending
                    ? 'Syncing…'
                    : syncNow.isError
                      ? String((syncNow.error as Error).message)
                      : `${syncNow.data?.succeeded ?? 0}/${syncNow.data?.attempted ?? 0} synced`}
                </Text>
              </View>
            )}
            <Text style={styles.note}>
              {(offlineQueue.data?.length ?? 0) > 0
                ? 'Trips saved without a connection upload automatically. Tap to retry now.'
                : 'Nothing waiting to upload. Trips saved without a connection show up here and upload automatically.'}
            </Text>
          </Card>

          <Card style={styles.cardGap}>
            <PressableScale
              style={[styles.button, styles.buttonNoMargin, { backgroundColor: accentColor, opacity: recorderState === 'idle' ? 1 : 0.5 }]}
              onPress={() => checkInterrupted.mutate()}
              disabled={recorderState !== 'idle' || checkInterrupted.isPending}>
              <Text style={styles.buttonText}>Check for an interrupted trip</Text>
            </PressableScale>
            {recorderState !== 'idle' && <Text style={styles.note}>A ride is recording. Finish or stop it first.</Text>}
            {checkInterrupted.status !== 'idle' && (
              <View style={styles.statusRow}>
                {checkInterrupted.isSuccess && <StatusDot color={checkInterrupted.data ? good : inkDim} />}
                <Text style={[styles.status, styles.statusInline, checkInterrupted.isError && styles.statusError]}>
                  {checkInterrupted.isPending
                    ? 'Checking…'
                    : checkInterrupted.isError
                      ? String((checkInterrupted.error as Error).message)
                      : checkInterrupted.data
                        ? 'Found and saved a trip that didn’t finish saving last time.'
                        : 'Nothing found. No ride was left half-saved.'}
                </Text>
              </View>
            )}
            <Text style={styles.note}>
              If saving fails the moment a ride ends, its data stays on the phone and Cityroam retries on the next launch. Use this to retry
              now.
            </Text>
          </Card>

          <Text style={styles.section}>Deleted trips</Text>
          <Card style={styles.cardGap}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Recoverable</Text>
              <Text style={[styles.status, styles.statusInline]}>{deletedTrips.data?.length ?? 0}</Text>
            </View>
            <Text style={styles.note}>Deleted trips stay recoverable for 7 days, then are removed for good.</Text>
            <PressableScale
              style={[
                styles.button,
                styles.buttonNoMargin,
                { backgroundColor: accentColor, opacity: !deletedTrips.data?.length ? 0.5 : 1 },
              ]}
              disabled={!deletedTrips.data?.length}
              onPress={() => {
                // Starts empty, not pre-checked — defaulting to everything selected meant tapping one trip silently restored all of them.
                setSelectedRestoreIds(new Set());
                setRestoreModalVisible(true);
              }}>
              <Text style={styles.buttonText}>Restore trips</Text>
            </PressableScale>
          </Card>
        </>
      ),
    },
    {
      key: 'appearance',
      label: 'Appearance',
      icon: Palette,
      status: `${FONT_LABELS[font]} · ${ACCENT_LABELS[accent]}`,
      content: (
        <Card style={styles.cardGap}>
          <Text style={styles.label}>Font</Text>
          <ChoiceRow options={FONT_LABELS} value={font} onChange={setFont} accentColor={accentColor} />
          <Text style={styles.label}>Accent</Text>
          <ChoiceRow options={ACCENT_LABELS} value={accent} onChange={setAccent} accentColor={accentColor} swatches={ACCENT_COLORS} />
          <Text style={styles.label}>Container style</Text>
          <ChoiceRow options={CONTAINER_LABELS} value={containerStyle} onChange={setContainerStyle} accentColor={accentColor} />
        </Card>
      ),
    },
    {
      key: 'widget',
      label: 'Home screen widget',
      icon: LayoutGrid,
      status: `${WIDGET_FONT_LABELS[widgetFont]} · ${ACCENT_LABELS[widgetAccent]} · ${WIDGET_NEEDLE_LABELS[widgetNeedle]}`,
      content: (
        <Card style={styles.cardGap}>
          <WidgetPreview />
          <Text style={styles.note}>
            The widget has its own look. Changing it doesn't change the app's appearance, and the other way round.
          </Text>
          <Text style={styles.label}>Font</Text>
          <ChoiceRow
            options={WIDGET_FONT_LABELS}
            value={widgetFont}
            onChange={(f) => {
              setWidgetFontState(f);
              setWidgetFont(f);
            }}
            accentColor={accentColor}
          />
          <Text style={styles.label}>Accent</Text>
          <ChoiceRow
            options={ACCENT_LABELS}
            value={widgetAccent}
            onChange={(a) => {
              setWidgetAccentState(a);
              setWidgetAccent(a);
            }}
            accentColor={accentColor}
            swatches={ACCENT_COLORS}
          />
          <Text style={styles.label}>Needle</Text>
          <ChoiceRow
            options={WIDGET_NEEDLE_LABELS}
            value={widgetNeedle}
            onChange={(n) => {
              setWidgetNeedleState(n);
              setWidgetNeedle(n);
            }}
            accentColor={accentColor}
          />
          <Text style={styles.label}>Container</Text>
          <ChoiceRow
            options={CONTAINER_LABELS}
            value={widgetContainerStyle}
            onChange={(c) => {
              setWidgetContainerStyleState(c);
              setWidgetContainerStyle(c);
            }}
            accentColor={accentColor}
          />
        </Card>
      ),
    },
    {
      key: 'advanced',
      label: 'Advanced',
      icon: Wrench,
      status: 'Debug tools',
      content: (
        <>
          <Text style={styles.section}>Debug log</Text>
          <Card style={styles.cardGap}>
            <PressableScale
              style={[styles.button, styles.buttonNoMargin, { backgroundColor: accentColor }]}
              onPress={() => router.push('/debug-console')}>
              <Text style={styles.buttonText}>Open debug console</Text>
            </PressableScale>
            <Text style={styles.note}>Watch the app's log live while you reproduce a problem.</Text>
            <PressableScale
              style={[styles.button, { backgroundColor: accentColor }]}
              onPress={() =>
                Sharing.isAvailableAsync()
                  .then((ok) =>
                    ok ? Sharing.shareAsync(exportLogForSharing()) : Promise.reject(new Error('Sharing not available on this device')),
                  )
                  .catch((err) => console.error('[share log]', err))
              }>
              <Text style={styles.buttonText}>Share debug log</Text>
            </PressableScale>
            <Text style={styles.note}>Share this after a ride if something looked wrong.</Text>
          </Card>

          {/* Re-reads keys/schema from the Tuya account — meaningless for a navee pairing, which has no account step at all. */}
          {productFamilies.includes(DEFAULT_BRAND) && (
            <>
              <Text style={styles.section}>{noun.Cap} data</Text>
              <RefreshBoardDataRow />
            </>
          )}
        </>
      ),
    },
    {
      key: 'about',
      label: 'About',
      icon: Info,
      status: `v${Constants.expoConfig?.version ?? '?'}`,
      content: (
        <>
          <Text style={styles.section}>Cityroam</Text>
          <Card style={styles.cardGap}>
            <Text style={styles.rowLabel}>Cityroam v{Constants.expoConfig?.version ?? '?'}</Text>
            <CheckForUpdatesRow />
            <Text style={styles.note}>
              A ride computer for electric {noun.lowerPlural}. Records rides, estimates remaining range, and reads and writes the{' '}
              {noun.lower}&apos;s own settings over Bluetooth.
            </Text>
            <PressableScale style={styles.linkRow} onPress={() => void Linking.openURL('https://github.com/neowara')}>
              <Code size={15} color={accentColor} />
              <Text style={[styles.link, { color: accentColor }]}>Developer: @neowara on GitHub</Text>
            </PressableScale>
            <PressableScale style={styles.linkRow} onPress={() => void Linking.openURL('https://cityroam.casa-verde.casa')}>
              <Globe size={15} color={accentColor} />
              <Text style={[styles.link, { color: accentColor }]}>cityroam.casa-verde.casa</Text>
            </PressableScale>
            <PressableScale style={styles.linkRow} onPress={() => void Linking.openURL('mailto:cityroamapp@casa-verde.casa')}>
              <Mail size={15} color={accentColor} />
              <Text style={[styles.link, { color: accentColor }]}>cityroamapp@casa-verde.casa</Text>
            </PressableScale>
          </Card>

          <Text style={styles.section}>Independence</Text>
          <Card style={styles.cardGap}>
            <Text style={styles.note}>
              Cityroam is an independent app. It isn't made, endorsed or supported by Tynee, NAVEE or Tuya, and isn't affiliated with any of
              them. Those names are their owners&apos; trademarks, used here only to say which hardware Cityroam works with.
            </Text>
            <Text style={styles.note}>
              {productFamilies.includes(DEFAULT_BRAND)
                ? `Cityroam includes no software from those companies. It connects to your ${noun.lower} over standard Bluetooth, using keys read from your own Tuya account. It doesn't unlock, bypass or modify anything on the ${noun.lower}, and the manufacturer's app keeps working alongside it.`
                : `Cityroam includes no software from those companies. It connects to your ${noun.lower} directly over Bluetooth. It doesn't unlock, bypass or modify anything on the ${noun.lower}, and the manufacturer's app keeps working alongside it.`}
            </Text>
          </Card>

          <Text style={styles.section}>Your data</Text>
          <Card style={styles.cardGap}>
            <Text style={styles.note}>
              Rides are recorded on this phone, so tracking works without a signal, and synced to your Cityroam account when one is
              available. Reinstalling the app or moving to a new phone restores them. Cityroam is free.
            </Text>
            <PressableScale style={styles.linkRow} onPress={() => router.push('/privacy-policy')}>
              <Text style={[styles.link, { color: accentColor, flex: 1 }]}>Privacy policy</Text>
              <ChevronRight size={16} color={accentColor} />
            </PressableScale>
          </Card>
        </>
      ),
    },
  ];

  const open = groups.find((g) => g.key === openGroup);

  return (
    <View style={styles.container}>
      {open ? (
        <GroupDetailScreen group={open} onClose={() => setOpenGroup(null)} />
      ) : (
        <SettingsHub groups={groups} onOpenGroup={setOpenGroup} inkDim={inkDim} inkFaint={inkFaint} accentColor={accentColor} />
      )}

      <BackgroundLocationDisclosure
        visible={locationDisclosureOpen}
        onDecline={() => setLocationDisclosureOpen(false)}
        onAccept={() => {
          // Closed first so the disclosure is never on screen at the same time as the
          // system prompt it is supposed to precede.
          setLocationDisclosureOpen(false);
          void requestBackgroundLocationPermission().then((r) => setBackgroundGranted(r.granted));
        }}
      />

      <AppModal visible={restoreModalVisible} onRequestClose={() => setRestoreModalVisible(false)} contentStyle={modalStyles.card}>
        <ChecklistModalBody
          icon={<Trash2 size={28} color={accentColor} />}
          title={(n) => `Restore ${n} trip${n === 1 ? '' : 's'}?`}
          bodyText="Tap a trip to include or exclude it."
          items={(deletedTrips.data ?? []).map((t) => ({
            key: t.id,
            label: `${new Date(t.startTime).toLocaleDateString()} · ${t.distanceKm.toFixed(1)} km`,
          }))}
          selectedKeys={selectedRestoreIds}
          onToggleItem={toggleRestoreSelection}
          onToggleSelectAll={toggleSelectAllRestore}
          confirmLabel={(n) => `Restore ${n || ''}`.trim()}
          confirmPending={restoreTrips.isPending}
          confirmPendingLabel="Restoring…"
          onConfirm={() => restoreTrips.mutate(Array.from(selectedRestoreIds), { onSuccess: () => setRestoreModalVisible(false) })}
        />
      </AppModal>

      <AppModal visible={batteryErrorMessage != null} onRequestClose={() => setBatteryErrorMessage(null)} contentStyle={modalStyles.card}>
        <ConfirmModalBody
          icon={<AlertTriangle size={26} color={warn} />}
          title="Could not open battery settings"
          body={batteryErrorMessage ?? ''}
          confirmLabel="Got it"
          onConfirm={() => setBatteryErrorMessage(null)}
        />
      </AppModal>

      <AppModal
        visible={powerSaveErrorMessage != null}
        onRequestClose={() => setPowerSaveErrorMessage(null)}
        contentStyle={modalStyles.card}>
        <ConfirmModalBody
          icon={<AlertTriangle size={26} color={warn} />}
          title="Could not open Battery Saver settings"
          body={powerSaveErrorMessage ?? ''}
          confirmLabel="Got it"
          onConfirm={() => setPowerSaveErrorMessage(null)}
        />
      </AppModal>
    </View>
  );
}

// Roughly the pill's own rendered height (paddingVertical 10*2 + ~22 icon/text line +
// borderWidth 1*2) plus a bit of breathing room before the first section — the
// ScrollView's top padding needs to clear this so content doesn't start underneath the
// floating pill, without reserving that space as permanent dead layout above the
// ScrollView (see PILL_TOP_OFFSET's own comment for why that reservation was the bug).
// Distance from the safe-area top to the pill's own top edge — kept in sync with
// headerFloat's inline marginTop below and PILL_CLEARANCE above so the ScrollView's
// padding and the pill's actual position never drift apart.

/** Full-screen "pushed" detail view for a category — copies debug-console.tsx's
 * header/scrim/glass treatment so it matches the rest of the app's pushed screens,
 * even though this is conditional rendering over local state rather than a real route.
 *
 * The pill floats over a full-height ScrollView (same pattern as FloatingTabBar's dock)
 * rather than sitting in normal flow above it — a normal-flow header reserves real
 * layout space that the ScrollView can never draw into, which is a permanent empty
 * band that visually reads as a solid "container" behind the pill once real (busier,
 * bordered) scrolled content is right below it. Floating the pill and letting the
 * ScrollView run the full screen height (with matching top padding so content starts
 * below the pill, not under it) means scrolled content genuinely passes behind/around
 * the pill instead of stopping short of it. */
function GroupDetailScreen({ group, onClose }: { group: GroupMeta; onClose: () => void }) {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.container}>
      <GlassBackdrop />
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + PILL_TOP_OFFSET + PILL_CLEARANCE }]}>
        {group.content}
      </ScrollView>
      <FloatingBackHeader icon={group.icon} title={group.label} onPress={onClose} />
    </View>
  );
}

function SettingsHub({
  groups,
  onOpenGroup,
  inkDim,
  inkFaint,
  accentColor,
}: {
  groups: GroupMeta[];
  onOpenGroup: (k: GroupKey) => void;
  inkDim: string;
  inkFaint: string;
  accentColor: string;
}) {
  // Falls back to the first group rather than a `!` assertion, so a future rename of the
  // 'account' key degrades gracefully instead of throwing at runtime.
  const account = groups.find((g) => g.key === 'account') ?? groups[0];
  const tiles = groups.filter((g) => g.key !== account.key);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ScreenHeader icon={SettingsIcon} title="Settings" />
      <PressableScale onPress={() => onOpenGroup('account')}>
        <Card style={dashStyles.accountCard}>
          <View style={[dashStyles.avatar, { backgroundColor: accentColor }]}>
            <Text style={dashStyles.avatarText}>{(account.status ?? '?').charAt(0).toUpperCase()}</Text>
          </View>
          <View style={dashStyles.accountText}>
            <Text style={dashStyles.accountEmail} numberOfLines={1}>
              {account.status}
            </Text>
            <Text style={[dashStyles.accountHint, { color: inkDim }]}>Tap to manage account</Text>
          </View>
          <ChevronRight size={18} color={inkFaint} />
        </Card>
      </PressableScale>

      <View style={dashStyles.grid}>
        {tiles.map((g) => {
          const Icon = g.icon;
          return (
            <PressableScale key={g.key} style={dashStyles.tileWrap} onPress={() => onOpenGroup(g.key)}>
              <Card style={dashStyles.tile}>
                <View style={[dashStyles.tileIconChip, { backgroundColor: accentColor + '22' }]}>
                  <Icon size={22} color={accentColor} />
                </View>
                <Text style={dashStyles.tileLabel} numberOfLines={2}>
                  {g.label}
                </Text>
                {g.status && (
                  <Text style={[dashStyles.tileStatus, { color: inkDim }]} numberOfLines={2}>
                    {g.status}
                  </Text>
                )}
              </Card>
            </PressableScale>
          );
        })}
      </View>
    </ScrollView>
  );
}

const dashStyles = StyleSheet.create({
  accountCard: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  accountText: { flex: 1, gap: 2 },
  accountEmail: { fontSize: 15, fontWeight: '600' },
  accountHint: { fontSize: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tileWrap: { flexGrow: 1, flexBasis: '47%', minWidth: 0 },
  // Fixed height, not minHeight — every tile matches regardless of label length
  // (a 2-line label like "Board & Connection" was otherwise stretching just that tile).
  // Must clear icon + a 2-line label + a 2-line status, or the status text clips at the
  // bottom of the fixed box (the Card clips overflow).
  tile: { alignItems: 'flex-start', gap: 6, height: 160 },
  tileIconChip: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { fontSize: 14, fontWeight: '700', marginTop: 2, lineHeight: 18, alignSelf: 'stretch' },
  tileStatus: { fontSize: 12, lineHeight: 16, flexShrink: 1, alignSelf: 'stretch' },
});
