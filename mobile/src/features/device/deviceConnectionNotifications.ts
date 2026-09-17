import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { logEvent } from '@/lib/log';
import { getSessionState } from '@/features/auth/auth';
import { deviceNounFor } from '@/features/device/deviceNoun';

/**
 * Connect/disconnect feedback via a real system notification instead of a hand-rolled
 * audio player (lib/sound.ts, removed). A notification channel is the platform's own
 * mechanism for this exact job — it's automatically silenced by Do Not
 * Disturb/ringer-silent the way a raw AudioPlayer playback never was without manually
 * reimplementing that check, and the rider gets a second, independent off-switch for
 * free: Android's own per-channel notification settings, no code here required for
 * that half of it.
 *
 * Test-safety: expo-notifications has no jest-expo mock, so it's required lazily
 * inside functions here, never at module scope — importing this file is always safe.
 * Same pattern as lib/tripNotifications.ts.
 */

type NotificationsModule = typeof import('expo-notifications');

function loadNotifications(): NotificationsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-notifications') as NotificationsModule;
  } catch {
    return null;
  }
}

const CONNECT_CHANNEL_ID = 'board-connect';
const DISCONNECT_CHANNEL_ID = 'board-disconnect';
export const BOARD_NOTIFICATION_CHANNEL_IDS = { connect: CONNECT_CHANNEL_ID, disconnect: DISCONNECT_CHANNEL_ID } as const;
// Fixed identifier, not one-per-event: connect/disconnect can happen many times in a
// ride (a dropout and reconnect, a power-cycle), and stacking a new notification per
// occurrence would fill the shade with noise. Re-using the id replaces the previous
// one, so there's only ever the current state showing.
const NOTIFICATION_ID = 'board-connection-state';

// Two independent toggles, not one shared flag — a rider may want to know the board
// connected (useful) without wanting a notification every time it drops for a moment
// mid-ride, or vice versa. The old single 'turbo.deviceConnectionNotificationsEnabled'
// key is left alone (neither read nor migrated): defaulting both new keys to "on"
// reproduces its "on" default for anyone who never touched the old combined toggle,
// and anyone who explicitly turned it off gets asked again once, which is an honest
// outcome for a setting that used to mean two different things silently.
const CONNECT_ENABLED_KEY = 'turbo.notify.boardConnect';
const DISCONNECT_ENABLED_KEY = 'turbo.notify.boardDisconnect';

function enabledKey(connected: boolean): string {
  return connected ? CONNECT_ENABLED_KEY : DISCONNECT_ENABLED_KEY;
}

export async function getBoardConnectionNotificationsEnabled(connected: boolean): Promise<boolean> {
  const stored = await AsyncStorage.getItem(enabledKey(connected));
  return stored !== 'false'; // defaults on
}

export async function setBoardConnectionNotificationsEnabled(connected: boolean, enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(enabledKey(connected), String(enabled));
}

let channelsEnsured = false;

/** Each channel's sound is fixed at creation time on Android — changing it later
 * requires a new channel id, not an update to this one. Idempotent otherwise. */
function ensureChannels(notifications: NotificationsModule) {
  if (Platform.OS !== 'android' || channelsEnsured) return;
  channelsEnsured = true;
  notifications
    .setNotificationChannelAsync(CONNECT_CHANNEL_ID, {
      name: 'Board connected',
      importance: notifications.AndroidImportance.DEFAULT,
      sound: 'connect.wav',
      description: 'Plays when your board or scooter connects.',
    })
    .catch(() => {});
  notifications
    .setNotificationChannelAsync(DISCONNECT_CHANNEL_ID, {
      name: 'Board disconnected',
      importance: notifications.AndroidImportance.DEFAULT,
      sound: 'disconnect.wav',
      description: 'Plays when your board or scooter disconnects.',
    })
    .catch(() => {});
}

/**
 * Posts (replacing any previous one) a connect/disconnect notification, unless the
 * rider has turned this off in-app. Never throws: a missing native module, a denied
 * permission, or the in-app toggle being off all degrade to a silent no-op — same
 * fire-and-forget contract as lib/haptics.ts and lib/tripNotifications.ts.
 */
export async function notifyBoardConnection(connected: boolean): Promise<void> {
  if (!(await getBoardConnectionNotificationsEnabled(connected))) return;

  const notifications = loadNotifications();
  if (!notifications) return;

  try {
    const permission = await notifications.getPermissionsAsync();
    if (!permission.granted) return;

    ensureChannels(notifications);

    const noun = deviceNounFor(getSessionState().productFamilies);
    const title = connected ? `${noun.Cap} connected` : `${noun.Cap} disconnected`;
    const soundFile = connected ? 'connect.wav' : 'disconnect.wav';
    const channelId = connected ? CONNECT_CHANNEL_ID : DISCONNECT_CHANNEL_ID;

    await notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_ID,
      content: {
        title,
        // iOS reads this directly; Android's actual sound comes from the channel
        // instead (set at channel-creation time above), but this is harmless there.
        sound: soundFile,
      },
      // { channelId } — not `null` — is what actually delivers immediately AND on a
      // specific non-default Android channel; `trigger: null` (immediate) has no
      // channelId field at all and would silently fall back to the app-wide default
      // channel (trip-lifecycle), losing the distinct connect/disconnect sounds this
      // whole module exists for. iOS ignores channelId entirely, so this is a no-op
      // there beyond still delivering immediately.
      trigger: Platform.OS === 'android' ? { channelId } : null,
    });
  } catch (err) {
    logEvent('board-notifications', 'failed to post connection notification', err instanceof Error ? err.message : String(err));
  }
}
