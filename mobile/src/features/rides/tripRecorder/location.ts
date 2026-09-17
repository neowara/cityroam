import { ActivityAction, startActivityAsync } from 'expo-intent-launcher';
import * as Location from 'expo-location';

import { logEvent } from '@/lib/log';
import DevicePowerNative from '@modules/device-power/src/DevicePower';
import RideCoreNative from '@modules/ride-core/src/RideCore';

export const LOCATION_TASK_NAME = 'turbo-trip-location-task';

// watchPositionAsync (subscribeWatch below) is the real GPS data path, full stop —
// measured directly against a real ride's own ride-health line: 449 fixes through the
// watch, 0 through this task's own `locations` callback, for the same ride. Two
// contradictory claims used to sit in this file (this comment said the task was the
// only reliable source; LOCATION_OPTIONS's own comment already correctly said the
// task's callback never fires) — the measured log settles which one was right, and it
// wasn't this one. expo-location's Android activity lifecycle listener does remove
// every watchPositionAsync request the moment the app backgrounds and re-add it on
// foreground return (OnActivityEntersBackground → stopWatching(), see
// node_modules/expo-location/android/.../LocationModule.kt) — that part is accurate —
// but LOCATION_TASK_NAME's own background delivery isn't a working substitute for it in
// practice, so this task exists purely for its foreground-service side effect: Android
// refuses to *start* a new foreground service from the background (see
// ensureForegroundServiceRunning's own doc comment), so this task registers one, early,
// at app launch, and that registration is what actually keeps the watch itself able to
// keep running in the background. `onSample` is injected by the coordinator
// (tripRecorder.ts); the task's own callback (locationTask.ts) is genuinely wired to
// call it too, it simply never fires with any real data in practice — see
// LOCATION_OPTIONS's comment.
let locationWatchSubscription: Location.LocationSubscription | null = null;
let currentWatchTier: LocationWatchTier | null = null;
let watchOnSample: ((loc: Location.LocationObject) => void) | null = null;
// The outgoing subscription during a tier handover (see subscribeWatch) — tracked at
// module level, not just closed over, so stopLocationWatch can also remove it if a trip
// ends mid-handover instead of leaking it as a stray subscription still calling
// watchOnSample after the trip has already stopped.
let pendingOutgoing: Location.LocationSubscription | null = null;
// Bumped at the start of every subscribeWatch call, captured locally — bug: two
// overlapping calls (e.g. auto_start's 'active' escalation racing
// ensureLocationTrackingAlive's unconditional restartLocationWatch self-heal, both
// plausible around the same foreground-return moment) could each read
// locationWatchSubscription as the same stale "outgoing" before either had resolved
// its own (possibly minutes-long, see subscribeWatch's comment)
// Location.watchPositionAsync call. Whichever resolved *second* would overwrite
// locationWatchSubscription, silently orphaning the first call's subscription — still
// alive, still calling watchOnSample on every fix, referenced by nothing so nothing
// could ever remove() it, not even stopLocationWatch at trip end. See subscribeWatch's
// generation check below.
let subscribeGeneration = 0;

export type LocationWatchTier = 'idle' | 'active';

// On Android, expo-location maps BestForNavigation/Highest/High all to the
// SAME FusedLocationProviderClient PRIORITY_HIGH_ACCURACY (continuous GPS chip + sensor
// fusion) — only Balanced actually drops to PRIORITY_BALANCED_POWER_ACCURACY (network +
// coarse GPS). ~100m accuracy is plenty to detect a sustained 15km/h auto-start; full
// precision only matters once a trip is actually recording a route.
const IDLE_WATCH_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.Balanced,
  timeInterval: 3000,
  distanceInterval: 0,
};

const ACTIVE_WATCH_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  timeInterval: 3000,
  distanceInterval: 0,
};

/** Starts LOCATION_TASK_NAME's foreground-service registration if it isn't already
 * running — no-op otherwise. This is the ONLY thing that makes the "Cityroam is tracking
 * your location" notification appear (Android requires a visible, non-dismissible
 * notification for the entire lifetime of a running location foreground service —
 * that's an OS rule, not a choice made here).
 *
 * Exported so tripRecorder.ts's initAutoTracking can call this proactively at app
 * launch — a real, confirmed-in-production bug (not battery optimization, not OEM
 * "sleeping apps": Android's own background-location-limits doc says apps without an
 * active foreground service get location updates "only a few times each hour...
 * regardless of target SDK version," and that throttle is what a failed start here
 * falls back to). Android 12+ flatly refuses to *start* a new foreground service
 * while the app has no visible activity (ForegroundServiceStartNotAllowedException) —
 * this used to only ever be called reactively, from subscribeWatch, the moment a
 * board connects or a trip starts. Both of those can legitimately happen while the
 * phone is locked in a pocket (a board auto-reconnecting, or a trip auto-starting
 * from the board's own wheel speed) — exactly the case Android refuses, confirmed
 * directly against production logs ("Foreground service cannot be started when the
 * application is in the background", followed by several minutes of zero GPS
 * samples for an otherwise-real ride). Starting it once, early, during app launch —
 * a state Android always considers "visible enough" — sidesteps the restriction
 * entirely; subscribeWatch's own call stays as a no-op fallback for whichever path
 * happens to run first. */
/** True while the native RideService is in the foreground with the location type. That
 * already keeps location access alive in the background, so the expo-location service
 * isn't needed on top of it. Any doubt (module missing, call throws) answers false. */
export function nativeServiceHoldsLocation(): boolean {
  try {
    return RideCoreNative.hasLocationForeground();
  } catch {
    return false;
  }
}

export async function ensureForegroundServiceRunning(): Promise<void> {
  if (nativeServiceHoldsLocation()) return;
  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
  if (alreadyStarted) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, LOCATION_OPTIONS).catch((err) =>
    logEvent('trip', 'ensureForegroundServiceRunning failed', { error: err instanceof Error ? err.message : String(err) }),
  );
}

/** Tears down LOCATION_TASK_NAME's foreground-service registration. Deliberately
 * NOT called from stopLocationWatch any more (see the bug documented on
 * ensureForegroundServiceRunning above) — stopping it every time the board
 * disconnects, then needing to start it fresh again on the next reconnect or
 * auto-start, is exactly what created the unsafe "start from background" window.
 * Once started at app launch, the service now stays up for the app process's whole
 * lifetime; only the JS watchPositionAsync subscription (the actual GPS data path,
 * gated by tier/board-connection as before) starts and stops. The small ongoing cost
 * is one persistent low-priority notification while auto-tracking is enabled, traded
 * for GPS never again silently going dark for the length of a ride. Exported for a
 * genuinely deliberate full stop (e.g. auto-tracking turned off in Settings) — not
 * currently wired to anything, kept as the explicit opposite of
 * ensureForegroundServiceRunning for whenever that's needed. */
/** Stops the expo-location service when RideService already holds location. Left running,
 * it wakes the JS runtime several times a minute through JobScheduler for fixes nothing
 * uses. Callers must only use this while no trip is recording. */
export async function releaseForegroundServiceIfRedundant(): Promise<void> {
  if (!nativeServiceHoldsLocation()) return;
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
  if (!started) return;
  await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
    .then(() => logEvent('trip', 'stopped the expo-location service: RideService holds location'))
    .catch((err) =>
      logEvent('trip', 'stopping the expo-location service failed', { error: err instanceof Error ? err.message : String(err) }),
    );
}

export function stopForegroundService(): void {
  Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)
    .then((started) => {
      if (started) return Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    })
    .catch((err) => logEvent('trip', 'stopForegroundService failed', { error: err instanceof Error ? err.message : String(err) }));
}

// Starts the new subscription first and keeps the old one alive, still feeding
// handleLocationSample, until the new one proves itself with a real sample -- only
// then removes the old one. expo-location has no API to change accuracy on a live
// watch, so a naive remove-then-add leaves a gap while the new tier re-acquires --
// and escalating idle->active on trip start is exactly when that gap hurts most:
// Android's FusedLocationProviderClient re-acquiring at BestForNavigation from cold
// can take minutes, versus the idle-tier watch it replaced, which was already
// producing fixes every 3s. Worst case during the handover is a few extra
// Balanced-accuracy points, which carry their accuracy radius and are dropped from
// the drawn route by filterRouteSpikes; that's strictly better than a multi-minute
// gap with zero points.
async function subscribeWatch(tier: LocationWatchTier): Promise<void> {
  if (!watchOnSample) return;
  // Tying the foreground-service notification to this choke point (the one every
  // real watch-start goes through) means it only appears exactly when GPS is
  // actually running for a reason, rather than unconditionally from app launch.
  await ensureForegroundServiceRunning();
  const outgoing = locationWatchSubscription;
  pendingOutgoing = outgoing;
  const previousTier = currentWatchTier;
  currentWatchTier = tier;
  const myGeneration = ++subscribeGeneration;
  try {
    const incoming = await Location.watchPositionAsync(tier === 'active' ? ACTIVE_WATCH_OPTIONS : IDLE_WATCH_OPTIONS, (loc) => {
      // stopLocationWatch() may have already cleared watchOnSample (and removed both
      // subscriptions) while this handover was in flight — a stray callback from either
      // the outgoing or incoming subscription must not resurrect a stopped trip.
      if (!watchOnSample) return;
      if (pendingOutgoing) {
        pendingOutgoing.remove();
        pendingOutgoing = null;
      }
      watchOnSample(loc);
    });
    // A newer subscribeWatch call started (and may have already resolved) while this
    // one was still acquiring — this result lost the race. Installing it now would
    // silently overwrite/orphan whatever the newer call already set as
    // locationWatchSubscription; tear it down instead of leaking it.
    if (myGeneration !== subscribeGeneration) {
      incoming.remove();
      return;
    }
    locationWatchSubscription = incoming;
  } catch (err) {
    // Same race, the failure side: a stale call's catch must not roll back state a
    // newer, already-succeeded call has since moved on from.
    if (myGeneration === subscribeGeneration) {
      currentWatchTier = previousTier;
      pendingOutgoing = null;
    }
    logEvent('trip', 'startLocationWatch failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Starts the foreground watchPositionAsync subscription (the reliable data path, see
 * comment above) at the given tier — defaults to 'idle' (low-power) since callers that
 * already know a trip is starting pass 'active' explicitly. No-op if already running;
 * use setLocationWatchTier to change tier on an already-running watch. */
export async function startLocationWatch(
  onSample: (loc: Location.LocationObject) => void,
  tier: LocationWatchTier = 'idle',
): Promise<void> {
  watchOnSample = onSample;
  if (locationWatchSubscription) return;
  await subscribeWatch(tier);
}

/** Switches the running watch between idle/active accuracy tiers (see IDLE_WATCH_OPTIONS
 * above) — no-op if already at that tier. expo-location has no API to change accuracy on
 * a live subscription, so this starts a new one at the new tier and hands off from the
 * old one on its first sample (see subscribeWatch) rather than a straight remove-then-add,
 * which would leave GPS dark for however long the new tier takes to get its first fix. */
export async function setLocationWatchTier(tier: LocationWatchTier): Promise<void> {
  if (tier === currentWatchTier) return;
  await subscribeWatch(tier);
}

/** Unconditionally re-subscribes at the given tier, even if one's already running at
 * that same tier — unlike startLocationWatch/setLocationWatchTier, which both no-op in
 * that case (locationWatchSubscription is non-null / tier === currentWatchTier). Real
 * gap source: the JS watchPositionAsync subscription is the actual GPS data path (see
 * the module comment above) and can die silently mid-ride — an OEM battery killer, or
 * the OS's FusedLocationProviderClient itself lapsing — without the foreground-service
 * TaskManager task (a separate registration) or currentWatchTier changing at all. A
 * caller that only checks those two signals (the old ensureLocationTrackingAlive path)
 * can conclude "nothing to do" while the real subscription has been dead for minutes.
 * Reuses subscribeWatch's existing handover (the old subscription, dead or not, keeps
 * being referenced as pendingOutgoing until the new one delivers a real sample) so this
 * is always safe to call speculatively — a healthy watch just hands off to an
 * equally-healthy replacement with no gap, matching subscribeWatch's own guarantee. */
export async function restartLocationWatch(onSample: (loc: Location.LocationObject) => void, tier: LocationWatchTier): Promise<void> {
  watchOnSample = onSample;
  await subscribeWatch(tier);
}

export function stopLocationWatch(): void {
  locationWatchSubscription?.remove();
  locationWatchSubscription = null;
  currentWatchTier = null;
  // Also tears down a still-in-flight tier handover (see subscribeWatch) so its outgoing
  // subscription doesn't keep delivering stray samples after the trip has stopped; clearing
  // watchOnSample is what makes the handover callback's own guard a no-op if it fires later.
  pendingOutgoing?.remove();
  pendingOutgoing = null;
  watchOnSample = null;
  // Deliberately does NOT stop the foreground service any more — see
  // stopForegroundService's own doc comment for the bug this used to cause.
  // The JS watch (the actual GPS data path) has no more reason to run, but the
  // service registration stays up so the next board connect/trip auto-start never
  // needs to start one fresh from a potentially-backgrounded context.
}

// This task's own `locations` callback never fires (see comment above) — its
// only job is sustaining the foreground service, so its accuracy has zero effect on trip
// data quality. Balanced instead of BestForNavigation cuts its GPS cost for the entire
// time it's registered (whenever the JS watch is running — see
// ensureForegroundServiceRunning/stopForegroundService), with no downside since nothing
// reads its output.
export const LOCATION_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.Balanced,
  timeInterval: 3000,
  // distanceInterval filters at the FusedLocationProvider level on Android and can silently cut sample rate 3-4x; 0 relies on timeInterval alone.
  distanceInterval: 0,
  foregroundService: {
    notificationTitle: 'Cityroam',
    // Matches RideService's own notification wording so the two on screen read as one
    // product rather than two apps — this one goes away once the native ride journal
    // becomes the route source and this JS GPS watch is no longer needed.
    notificationBody: 'Recording your ride.',
    // false keeps the service alive until the trip ends — unset, Android can tear it down while backgrounded even with the JS runtime still alive.
    killServiceOnDestroy: false,
  },
};

/** Call once at app startup. Requests foreground-only location; deliberately does NOT
 * request background permission here — on Android 11+ that redirects straight into
 * system Settings with no in-app dialog, so it's opt-in via requestBackgroundLocationPermission on a real Settings button tap instead.
 *
 * Deliberately does NOT start the continuous foreground GPS watch itself —
 * idle-time GPS is gated on the board being connected (see tripRecorder.ts's
 * initAutoTracking connection subscription), so no GPS runs while idle and
 * disconnected. This function only registers `onSample`.
 *
 * Also deliberately does NOT start LOCATION_TASK_NAME's foreground-service task
 * here at app launch — the foreground service (and its notification, an Android OS
 * requirement for the life of the service) starts lazily from subscribeWatch, the
 * single choke point every real GPS-watch start goes through — so it appears only
 * once GPS is actually running for a reason (board-connected idle-arm or active
 * recording), and disappears via stopLocationWatch's stopForegroundService the
 * moment that's no longer true. */
export async function initAutoTracking(onSample: (loc: Location.LocationObject) => void): Promise<{ granted: boolean }> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return { granted: false };
  watchOnSample = onSample;
  return { granted: true };
}

/** Explicit user action only (e.g. a Settings button tap) — see the note on initAutoTracking. */
export async function requestBackgroundLocationPermission(): Promise<{ granted: boolean }> {
  const result = await Location.requestBackgroundPermissionsAsync();
  return { granted: result.status === 'granted' };
}

export async function getBackgroundLocationPermissionStatus(): Promise<boolean> {
  const result = await Location.getBackgroundPermissionsAsync();
  return result.status === 'granted';
}

/** Explicit user action only (a Settings button tap) — a real in-app dialog (not a
 * redirect), CAN be granted without leaving the app, unlike background location above.
 * Exempts the app from OEM battery-killers (Xiaomi/Samsung) that can stop the
 * foreground service regardless of correct app-level config, and is also one of the few
 * ways Android lets an app start a foreground service from the background at all — every
 * reconnect-without-reopening-the-app path this app relies on depends on this being
 * granted. No-op if already exempted.
 *
 * Routed through the native module (DevicePowerModule.kt), which builds the intent from
 * the real `context.packageName` — this used to go through expo-intent-launcher with a
 * hardcoded `com.neowara.turbo`, left over from before the 3.2.0 rename to
 * `com.neowara.cityroam`. That silently opened the settings screen for an app that no
 * longer exists: the dialog would still appear (Android doesn't validate the package
 * against what's installed before showing it), but granting it exempted nothing, since no
 * `com.neowara.turbo` app is installed to exempt. */
export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  try {
    await DevicePowerNative.requestIgnoreBatteryOptimizations();
  } catch (err) {
    logEvent('trip', 'requestIgnoreBatteryOptimizations failed', { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Needs a native call — PowerManager isn't exposed by expo-intent-launcher or any other installed package. See DevicePowerModule.kt. */
export function getIgnoreBatteryOptimizationsStatus(): boolean {
  return DevicePowerNative.isIgnoringBatteryOptimizations();
}

/** System-wide Battery Saver is a separate mechanism from the per-app
 * battery-optimization exemption above — no app-triggerable exemption exists for it,
 * so the mitigation is detect-and-warn. */
export function getPowerSaveModeStatus(): boolean {
  return DevicePowerNative.isPowerSaveModeOn();
}

/** No per-app exemption intent exists for system-wide Battery Saver, so this opens the toggle page directly instead of a generic Settings screen. */
export async function openPowerSaveModeSettings(): Promise<void> {
  try {
    await startActivityAsync(ActivityAction.BATTERY_SAVER_SETTINGS);
  } catch (err) {
    logEvent('trip', 'openPowerSaveModeSettings failed', { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
