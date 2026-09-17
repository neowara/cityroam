import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { logEvent } from '@/lib/log';
import { refreshLaunchLocationIfPermitted } from '@/features/rides/launchLocation';
import { startNativeRideCapture } from '@/features/rides/rideCore';

/**
 * "Leaving home" as a wake-up signal. A geofence EXIT transition is delivered by
 * Android even with the app process dead, and is one of the platform's own listed
 * exemptions for starting a foreground service from the background — so it can prime
 * native ride capture (and take a fresh location fix) well before the rider ever
 * reaches for the board, without any periodic polling.
 *
 * Deliberately does NOT start or end a ride on its own — a wrong "left home" guess
 * (false positive from GPS drift, a walk instead of a ride) is harmless by design: it
 * only wakes/prepares the app. A ride still starts exclusively on the board's own wheel
 * speed (dp2), same as every other path in this app (PHONE = GPS only, DEVICE =
 * telemetry).
 *
 * Home is set explicitly by the rider (Settings, or the debug Diagnostics screen once
 * that lands) rather than auto-derived from ride history — auto-derivation (clustering
 * past ride start/end points) is real, deliberately-scoped-out follow-up work, not an
 * oversight; a manual pin is a fully functional substitute and much lower-risk to ship
 * without on-device verification.
 */

export const HOME_GEOFENCE_TASK_NAME = 'turbo-home-geofence-task';
const HOME_REGION_KEY = 'turbo.homeGeofenceRegion';
const HOME_IDENTIFIER = 'home';

// Android's geofencing docs recommend >=100-150m for reliable transitions — below
// that, ordinary GPS/Wi-Fi position noise can flicker the region boundary. Deliberately
// tighter here anyway: a flickery EXIT just primes reconnection a bit early (wakes the
// app, arms BLE) rather than costing a wrong ride, since a geofence transition never
// starts or ends one — see homeGeofence's own doc comment above. Exported so Settings
// can explain the actual configured radius rather than a hardcoded number in copy.
export const DEFAULT_RADIUS_M = 50;

export type HomeRegion = { latitude: number; longitude: number; radiusM: number };

/**
 * Must run at module scope, same requirement as locationTask.ts's own
 * TaskManager.defineTask — needs to be registered before the app finishes loading so a
 * headless invocation after an app restart can find it. Imported once, early, from
 * app/_layout.tsx.
 */
TaskManager.defineTask(HOME_GEOFENCE_TASK_NAME, async ({ data, error }) => {
  if (error) {
    logEvent('trip', 'home geofence task error', { error: error.message, code: (error as { code?: unknown }).code });
    return;
  }
  const { eventType } = (data ?? {}) as { eventType?: Location.LocationGeofencingEventType };
  if (eventType !== Location.GeofencingEventType.Exit) return;
  logEvent('trip', 'left home area — priming native ride capture');
  startNativeRideCapture();
  // Fresh fix for the planner/current-trip view, in case the launch-time one (if any)
  // is stale by the time the rider actually opens the app. Permission-gated internally;
  // never prompts from this context (see refreshLaunchLocationIfPermitted's own doc).
  void refreshLaunchLocationIfPermitted();
});

export async function getHomeRegion(): Promise<HomeRegion | null> {
  const raw = await AsyncStorage.getItem(HOME_REGION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HomeRegion;
  } catch {
    return null;
  }
}

/** Sets (or replaces) the home geofence and starts watching it. Requires background
 * location permission — the caller is responsible for that being granted (see the
 * readiness checklist), same as every other background-location feature in this app. */
export async function setHomeRegion(latitude: number, longitude: number, radiusM: number = DEFAULT_RADIUS_M): Promise<void> {
  const region: HomeRegion = { latitude, longitude, radiusM };
  await AsyncStorage.setItem(HOME_REGION_KEY, JSON.stringify(region));
  await Location.startGeofencingAsync(HOME_GEOFENCE_TASK_NAME, [
    { identifier: HOME_IDENTIFIER, latitude, longitude, radius: radiusM, notifyOnEnter: true, notifyOnExit: true },
  ]);
  logEvent('trip', 'home geofence set', { radiusM });
}

export async function clearHomeRegion(): Promise<void> {
  await AsyncStorage.removeItem(HOME_REGION_KEY);
  await Location.hasStartedGeofencingAsync(HOME_GEOFENCE_TASK_NAME)
    .then((started) => (started ? Location.stopGeofencingAsync(HOME_GEOFENCE_TASK_NAME) : undefined))
    .catch(() => {});
}

/** Call once at app startup — re-asserts the geofence registration if a home area was
 * previously set (mirrors ensureForegroundServiceRunning's own re-assert-at-launch
 * pattern in tripRecorder/location.ts). No-op if none is set, or if already running. */
export async function ensureHomeGeofenceRunning(): Promise<void> {
  const region = await getHomeRegion();
  if (!region) return;
  const started = await Location.hasStartedGeofencingAsync(HOME_GEOFENCE_TASK_NAME).catch(() => false);
  if (started) return;
  await Location.startGeofencingAsync(HOME_GEOFENCE_TASK_NAME, [
    {
      identifier: HOME_IDENTIFIER,
      latitude: region.latitude,
      longitude: region.longitude,
      radius: region.radiusM,
      notifyOnEnter: true,
      notifyOnExit: true,
    },
  ]).catch((err) => logEvent('trip', 'ensureHomeGeofenceRunning failed', { error: err instanceof Error ? err.message : String(err) }));
}
