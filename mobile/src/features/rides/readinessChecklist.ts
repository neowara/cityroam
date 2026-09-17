/**
 * "Ready to record" checklist — every permission/setting a pocket ride actually depends
 * on, checked together instead of discovered one at a time by a silently-degraded ride.
 *
 * The 3.2.0 rename (com.neowara.turbo → com.neowara.cityroam) reset every one of these
 * on an existing install: Android treats a package-id change as a new app, so battery
 * optimization exemption and "Allow all the time" location both revert, and the
 * battery-optimization request itself was pointed at the dead pre-rename package id
 * until that was fixed (see DevicePowerModule.kt) — silently opening a settings screen
 * for an app that no longer exists. This is the detect-and-recover half of that fix: a
 * banner the rider can actually act on, not a ride that just quietly records less than
 * it should have.
 */

import * as Notifications from 'expo-notifications';

import { hasBlePermissions } from '@/features/device/deviceLink/permissions';
import {
  getBackgroundLocationPermissionStatus,
  getIgnoreBatteryOptimizationsStatus,
  getPowerSaveModeStatus,
} from '@/features/rides/tripRecorder/location';
import * as Location from 'expo-location';

export type ReadinessItemKey =
  'bluetooth' | 'preciseLocation' | 'backgroundLocation' | 'batteryOptimization' | 'notifications' | 'batterySaver';

export type ReadinessItem = {
  key: ReadinessItemKey;
  /** True means "ready" — the naming stays positive (granted/off) rather than
   * per-item-negated, so summing `.every(i => i.ready)` reads naturally. */
  ready: boolean;
};

export type ReadinessStatus = {
  items: ReadinessItem[];
  allReady: boolean;
};

async function preciseLocationGranted(): Promise<boolean> {
  const result = await Location.getForegroundPermissionsAsync();
  // Coarse-only ("Approximate") is still "granted" to Android, but the app needs a real
  // fix quality for a route worth recording.
  return result.granted && result.android?.accuracy !== 'coarse';
}

async function notificationsGranted(): Promise<boolean> {
  const settings = await Notifications.getPermissionsAsync();
  return settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

/** Reads every item's live status. Cheap — none of these prompt, they only read
 * current state — so it's safe to call on every foreground return, not just at launch. */
export async function getReadinessStatus(): Promise<ReadinessStatus> {
  const [bluetooth, preciseLocation, backgroundLocation, notifications] = await Promise.all([
    hasBlePermissions(),
    preciseLocationGranted(),
    getBackgroundLocationPermissionStatus(),
    notificationsGranted(),
  ]);
  const items: ReadinessItem[] = [
    { key: 'bluetooth', ready: bluetooth },
    { key: 'preciseLocation', ready: preciseLocation },
    { key: 'backgroundLocation', ready: backgroundLocation },
    { key: 'batteryOptimization', ready: getIgnoreBatteryOptimizationsStatus() },
    { key: 'notifications', ready: notifications },
    { key: 'batterySaver', ready: !getPowerSaveModeStatus() },
  ];
  return { items, allReady: items.every((i) => i.ready) };
}

export const READINESS_ITEM_COPY: Record<ReadinessItemKey, { title: string; body: string }> = {
  bluetooth: {
    title: 'Bluetooth permission',
    body: 'Needed to find and connect at all.',
  },
  preciseLocation: {
    title: 'Precise location',
    body: 'A route recorded at "approximate" accuracy is too coarse to be useful.',
  },
  backgroundLocation: {
    title: 'Allow location all the time',
    body: 'Without this, location stops the moment the screen locks.',
  },
  batteryOptimization: {
    title: 'Battery optimization off for Cityroam',
    body: 'Lets Cityroam reconnect and keep recording without being reopened.',
  },
  notifications: {
    title: 'Notifications allowed',
    body: 'Ride start/stop and connection alerts while your phone is locked.',
  },
  batterySaver: {
    title: 'Battery Saver off',
    body: 'System-wide Battery Saver can throttle location delivery even with everything above granted.',
  },
};
