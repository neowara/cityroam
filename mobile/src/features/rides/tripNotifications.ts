import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { startActivityAsync } from 'expo-intent-launcher';

import { openPowerSaveModeSettings } from '@/features/rides/tripRecorder/location';

// Lifecycle notifications for trip recording.
//
// BOARD = telemetry / PHONE = GPS only means a ride can start, end, and be finalized
// entirely while the phone is in the user's pocket (backgrounded). The user asked for
// a heads-up in exactly those cases:
//   - auto-start        : "Ride started" (board wheel speed crossed the threshold)
//   - disconnect-stop   : "Trip recording stopped — board connection lost"
//   - finalize-summary  : the saved ride's headline numbers (distance, avg/max speed,
//                         battery, dominant mode, weather)
//
// Each kind gets its own Android channel (not one shared "Trip updates" channel) and
// its own in-app on/off toggle, so a rider can mute e.g. "Ride started" without losing
// "Ride saved" — both from the app's own Settings and from Android's own per-channel
// notification settings, which fall out of using real channels for free (sound,
// vibration, and Do Not Disturb overrides are all governed there, not reimplemented
// here).
//
// these are *lifecycle* notifications — they only make sense when the user is NOT
// looking at the app (a foregrounded ride already shows the LiveTripModule). So every
// post is gated on the app being backgrounded; a foregrounded app never notifies.
//
// Android 13+ requires the POST_NOTIFICATIONS runtime permission before any
// notification (including these) can be shown. ensureNotificationPermission() requests
// it; the app entry point calls it once at startup.
//
// Test-safety: expo-notifications is a native module with no jest-expo mock, and this
// module is imported (transitively, via the recorder) by many unit tests that never
// exercise notifications. So expo-notifications is required lazily *inside* the
// functions below, never at module scope — importing this file is always safe, and only
// an actual notify/permission call touches the native module (wrapped in try/catch so a
// missing/mocked native module degrades to a no-op rather than throwing).

type NotificationsModule = typeof import('expo-notifications');

/** Lazily resolve expo-notifications only when actually needed. */
function loadNotifications(): NotificationsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-notifications') as NotificationsModule;
  } catch {
    return null;
  }
}

// ---- App background tracking ------------------------------------------------

let isAppActive = AppState.currentState === 'active';
let appStateListenerAttached = false;

function attachAppStateListener() {
  if (appStateListenerAttached) return;
  appStateListenerAttached = true;
  AppState.addEventListener('change', (state) => {
    isAppActive = state === 'active';
  });
}

/** True when the app is currently backgrounded — the only time lifecycle
 * notifications should be shown. */
export function isAppBackgrounded(): boolean {
  return !isAppActive;
}

// ---- Notification kinds -----------------------------------------------------------

export type TripLifecycleKind = 'auto-start' | 'ride-ended' | 'finalize-summary' | 'power-save-warning';

/** Data the recorder has at the moment each lifecycle event fires. Weather is
 * backend-computed after save, so it's optional and filled in where available. */
export type TripLifecyclePayload = {
  /** finalize-summary only. */
  distanceKm?: number;
  avgSpeedKmh?: number;
  maxSpeedKmh?: number;
  durationSec?: number;
  batteryStartPct?: number | null;
  batteryEndPct?: number | null;
  /** Dominant mode label (e.g. "Eco") — recorder computes from modeSamples. */
  dominantMode?: string | null;
  /** WMO weather codes for the trip (backend-computed; optional here). */
  weatherCodes?: number[] | null;
  /** ride-ended and finalize-summary only. Set when the board disconnecting is what
   * ended the ride — there's no grace period (a lost board IS the ride ending), so
   * this folds what used to be a separate "connection lost" notification into the
   * ride-ended/summary ones instead of sending a distinct one for the same event. */
  endReason?: 'ble_disconnect' | null;
};

const KIND_META: Record<TripLifecycleKind, { channelId: string; channelName: string; channelDescription: string; enabledKey: string }> = {
  'auto-start': {
    channelId: 'trip-auto-start',
    channelName: 'Ride started',
    channelDescription: "When the board or scooter's own wheel speed starts a ride automatically.",
    enabledKey: 'turbo.notify.autoStart',
  },
  'ride-ended': {
    channelId: 'trip-ride-ended',
    channelName: 'Ride ended',
    channelDescription: 'The moment recording stops, including when the connection drops. Sent before "Ride saved".',
    enabledKey: 'turbo.notify.rideEnded',
  },
  'finalize-summary': {
    channelId: 'trip-finalize-summary',
    channelName: 'Ride saved',
    channelDescription: 'A summary of each ride once it has saved.',
    enabledKey: 'turbo.notify.finalizeSummary',
  },
  'power-save-warning': {
    channelId: 'trip-power-save-warning',
    channelName: 'Battery Saver during a ride',
    channelDescription: "Once per ride, when Battery Saver is on. Android throttles location while it's on, and apps can't opt out.",
    enabledKey: 'turbo.notify.powerSaveWarning',
  },
};

// One-time cleanup: 'disconnect-stop' used to be its own channel/toggle, folded into
// 'finalize-summary' above (the board disconnecting IS the ride ending, so one
// notification per ride is enough). Deletes the now-unused channel and its stored
// toggle so neither lingers as dead state; safe to call repeatedly (both are no-ops
// once already gone).
const LEGACY_DISCONNECT_STOP_CHANNEL_ID = 'trip-disconnect-stop';
const LEGACY_DISCONNECT_STOP_ENABLED_KEY = 'turbo.notify.disconnectStop';
function migrateLegacyDisconnectStopChannel(): void {
  const notifications = loadNotifications();
  if (notifications && Platform.OS === 'android') {
    notifications.deleteNotificationChannelAsync(LEGACY_DISCONNECT_STOP_CHANNEL_ID).catch(() => {});
  }
  AsyncStorage.removeItem(LEGACY_DISCONNECT_STOP_ENABLED_KEY).catch(() => {});
}

export async function getTripNotificationEnabled(kind: TripLifecycleKind): Promise<boolean> {
  const stored = await AsyncStorage.getItem(KIND_META[kind].enabledKey);
  return stored !== 'false'; // defaults on
}

// Mirrors the persisted value in memory so notifyTripLifecycle (called from deep
// inside tripRecorder's own timing-sensitive await chains) never has to await
// AsyncStorage on its hot path — it defaults to "on" until the real value loads,
// same default getTripNotificationEnabled itself uses.
const enabledCache = new Map<TripLifecycleKind, boolean>();

export async function setTripNotificationEnabled(kind: TripLifecycleKind, enabled: boolean): Promise<void> {
  enabledCache.set(kind, enabled);
  await AsyncStorage.setItem(KIND_META[kind].enabledKey, String(enabled));
}

(Object.keys(KIND_META) as TripLifecycleKind[]).forEach((kind) => {
  getTripNotificationEnabled(kind).then((enabled) => enabledCache.set(kind, enabled));
});

const ensuredChannels = new Set<TripLifecycleKind>();

/** Ensure this kind's Android notification channel exists (Android 8+). Idempotent. */
function ensureChannel(notifications: NotificationsModule, kind: TripLifecycleKind) {
  if (Platform.OS !== 'android' || ensuredChannels.has(kind)) return;
  ensuredChannels.add(kind);
  const meta = KIND_META[kind];
  notifications
    .setNotificationChannelAsync(meta.channelId, {
      name: meta.channelName,
      importance: notifications.AndroidImportance.DEFAULT,
      description: meta.channelDescription,
    })
    .catch(() => {});
}

/**
 * request the POST_NOTIFICATIONS runtime permission (Android 13+). No-op on
 * iOS/older Android where the permission is granted at install time. Returns whether
 * notifications are permitted. Safe to call repeatedly.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  const notifications = loadNotifications();
  if (!notifications) return false;

  if (Platform.OS === 'android' && Platform.Version >= 33) {
    const settings = await notifications.getPermissionsAsync();
    if (settings.granted) return true;
    if (settings.canAskAgain) {
      const req = await notifications.requestPermissionsAsync();
      return req.granted;
    }
    return false;
  }

  // iOS / pre-13 Android: no runtime prompt needed.
  return true;
}

/**
 * post a trip-lifecycle notification, but ONLY when the app is backgrounded.
 * Foregrounded rides are already visible on the LiveTripModule — notifying would be
 * redundant noise. Never throws: a missing native module, a denied permission, this
 * kind being turned off, or a foregrounded app all degrade to a silent no-op.
 */
export async function notifyTripLifecycle(kind: TripLifecycleKind, payload: TripLifecyclePayload = {}): Promise<void> {
  if (!isAppBackgrounded()) return;
  if (enabledCache.get(kind) === false) return;

  const notifications = loadNotifications();
  if (!notifications) return;

  try {
    const permission = await notifications.getPermissionsAsync();
    if (!permission.granted) return;

    ensureChannel(notifications, kind);

    const { title, body } = buildNotification(kind, payload);
    const channelId = KIND_META[kind].channelId;
    await notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: 'default',
        data: { kind },
      },
      // { channelId }, not `null`: a null trigger has no channelId field and falls
      // back to the app-wide default channel, which would put every kind's
      // notification on one channel regardless of this per-kind setup.
      trigger: Platform.OS === 'android' ? { channelId } : null,
    });
  } catch {
    // Notifications are best-effort — never let a posting failure surface.
  }
}

/** Compose the title/body for each lifecycle kind (summary from stored fields). */
function buildNotification(kind: TripLifecycleKind, p: TripLifecyclePayload): { title: string; body: string } {
  switch (kind) {
    case 'auto-start':
      return { title: 'Ride started', body: 'Cityroam is recording your ride.' };
    case 'ride-ended':
      return {
        title: 'Ride ended',
        body: p.endReason === 'ble_disconnect' ? 'Recording stopped. The connection was lost.' : 'Recording has stopped.',
      };
    case 'finalize-summary': {
      const parts: string[] = [];
      if (p.distanceKm != null) parts.push(`${p.distanceKm.toFixed(1)} km`);
      if (p.avgSpeedKmh != null) parts.push(`avg ${p.avgSpeedKmh.toFixed(1)} km/h`);
      if (p.maxSpeedKmh != null) parts.push(`max ${p.maxSpeedKmh.toFixed(1)} km/h`);
      if (p.durationSec != null && p.durationSec > 0) parts.push(`${Math.round(p.durationSec / 60)} min`);
      if (p.batteryEndPct != null) parts.push(`${Math.round(p.batteryEndPct)}% battery`);
      if (p.dominantMode) parts.push(`${p.dominantMode} mode`);
      if (p.endReason === 'ble_disconnect') parts.push('board disconnected');
      return {
        title: 'Ride saved',
        body: parts.length > 0 ? parts.join(' · ') : 'Your ride was saved.',
      };
    }
    case 'power-save-warning':
      return {
        title: 'Battery Saver is on',
        body: 'Location tracking may be reduced for the rest of this ride. Tap to turn it off.',
      };
  }
}

// power-save-warning is the one kind whose tap should do more than just open the
// app — its whole point is getting the rider to Battery Saver's own toggle screen,
// which Android exposes no in-app control for (see getPowerSaveModeStatus's doc in
// tripRecorder/location.ts). The other three kinds have nothing more useful to open
// than the app itself, which tapping a notification already does by default.
let responseListenerAttached = false;
function attachNotificationResponseListener(notifications: NotificationsModule) {
  if (responseListenerAttached) return;
  responseListenerAttached = true;
  notifications.addNotificationResponseReceivedListener((response) => {
    if (response.notification.request.content.data?.kind === 'power-save-warning') {
      openPowerSaveModeSettings().catch(() => {});
    }
  });
}

/**
 * Deep-links to Android's own per-channel notification settings screen (sound,
 * vibration, importance) — an app cannot change a channel's behaviour itself once
 * created, only the rider can, from here. Read from Constants.expoConfig rather than a
 * literal package id: that config is the actual source of truth the build itself uses,
 * so it can't drift the way a hand-typed package string can (see D2 in
 * DevicePowerModule.kt for what that class of bug looks like in practice). No-op
 * (silently) on non-Android — the concept doesn't exist there.
 */
export async function openNotificationChannelSettings(channelId: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  const packageName = Constants.expoConfig?.android?.package;
  if (!packageName) return;
  await startActivityAsync('android.settings.CHANNEL_NOTIFICATION_SETTINGS', {
    extra: {
      'android.provider.extra.APP_PACKAGE': packageName,
      'android.provider.extra.CHANNEL_ID': channelId,
    },
  });
}

export const NOTIFICATION_CHANNEL_IDS = {
  autoStart: KIND_META['auto-start'].channelId,
  rideEnded: KIND_META['ride-ended'].channelId,
  finalizeSummary: KIND_META['finalize-summary'].channelId,
  powerSaveWarning: KIND_META['power-save-warning'].channelId,
} as const;

/** Whether a channel is blocked in Android's own settings — an app can read this but
 * never change it back (see openNotificationChannelSettings's own comment). Null (not
 * false) when the channel doesn't exist yet (e.g. it's never been created because that
 * kind has never fired), which the caller should treat as "unknown, not blocked". */
export async function isChannelBlocked(channelId: string): Promise<boolean | null> {
  if (Platform.OS !== 'android') return false;
  const notifications = loadNotifications();
  if (!notifications) return null;
  try {
    const channel = await notifications.getNotificationChannelAsync(channelId);
    if (!channel) return null;
    return channel.importance === notifications.AndroidImportance.NONE;
  } catch {
    return null;
  }
}

/** Wire the module's AppState listener and the power-save-warning tap handler.
 * Called once from the app entry point. */
export function setupTripNotifications(): void {
  attachAppStateListener();
  migrateLegacyDisconnectStopChannel();
  const notifications = loadNotifications();
  if (notifications) attachNotificationResponseListener(notifications);
}
