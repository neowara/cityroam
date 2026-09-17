// Option 1 (connection-gated idle) — "single GPS fix on app launch".
//
// The strict architecture is PHONE = GPS ONLY: the phone is responsible exclusively
// for location data, and it must not run a continuous GPS watch while idle (that's
// deferred until the board connects). But the trip planner and the "current trip" /
// map views still want to show the rider's position the moment they open the app,
// without each screen firing its own getCurrentPositionAsync (which is slow — a cold
// fix can take seconds — and duplicates work across screens).
//
// So we take exactly ONE getCurrentPositionAsync at app launch, cache the result, and
// let any screen read it synchronously. This is a single, one-shot fix — NOT a watch,
// NOT a poll — so it costs one GPS acquisition at startup and nothing more. Screens
// that need a fresher position (e.g. the planner's "locate me" button) can call
// refreshLaunchLocation() to take another one-shot fix and update the shared cache.
//
// This module is deliberately tiny and dependency-free (no React) so it can be called
// from the app-startup effect in app/_layout.tsx and read from any screen.

import * as Location from 'expo-location';

export type LaunchLocation = { lat: number; lon: number; accuracyM: number | null; timestampMs: number };

// The single cached fix from app launch (or the last refreshLaunchLocation()).
let cached: LaunchLocation | null = null;
// Guards against two callers racing to fire the one-shot fix at the same instant.
let inFlight: Promise<LaunchLocation | null> | null = null;

const listeners = new Set<(loc: LaunchLocation | null) => void>();

function toLaunchLocation(pos: Location.LocationObject): LaunchLocation {
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracyM: pos.coords.accuracy ?? null,
    timestampMs: pos.timestamp,
  };
}

function setCached(loc: LaunchLocation | null): void {
  cached = loc;
  listeners.forEach((l) => l(loc));
}

/** Synchronously read the cached launch fix (null until the one-shot fix lands). */
export function getCachedLaunchLocation(): LaunchLocation | null {
  return cached;
}

/** Subscribe to cache updates — fires with the new value (null on failure) whenever
 * the one-shot fix lands or refreshLaunchLocation() replaces it. Returns an
 * unsubscribe function. */
export function subscribeLaunchLocation(listener: (loc: LaunchLocation | null) => void): () => void {
  listeners.add(listener);
  // Deliver the current value immediately so a late subscriber doesn't wait for the
  // next refresh to learn what's already cached.
  if (cached) listener(cached);
  return () => listeners.delete(listener);
}

/** Takes exactly ONE getCurrentPositionAsync (Balanced — plenty for showing where the
 * rider is; full precision is only needed once a trip is actually recording) and caches
 * the result. Concurrent callers share a single in-flight fix rather than each firing
 * their own. Returns the cached fix, or null if permission is denied / the fix fails. */
export async function refreshLaunchLocation(): Promise<LaunchLocation | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setCached(null);
        return null;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const loc = toLaunchLocation(pos);
      setCached(loc);
      return loc;
    } catch {
      setCached(null);
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Same one-shot refresh as refreshLaunchLocation, but only if foreground location
 * permission is already granted — never calls requestForegroundPermissionsAsync
 * itself. For callers that can fire from a context with no foreground activity to
 * safely show a permission dialog against (e.g. a BLE connection event, which can
 * happen while the phone is locked/backgrounded) — requesting a runtime permission
 * there is undefined behavior on Android (ActivityCompat.requestPermissions needs a
 * resumed Activity). getForegroundPermissionsAsync only reads the current status, it
 * never prompts, so this is always safe to call from any context. No-op (returns the
 * existing cache, doesn't touch it) if permission isn't already granted. */
export async function refreshLaunchLocationIfPermitted(): Promise<LaunchLocation | null> {
  let status: string;
  try {
    status = (await Location.getForegroundPermissionsAsync()).status;
  } catch {
    return cached;
  }
  if (status !== 'granted') return cached;
  return refreshLaunchLocation();
}

/** Test hook — clears the cache and listener set so a fresh module state can be
 * simulated between tests. */
export function __resetLaunchLocationForTests(): void {
  cached = null;
  inFlight = null;
  listeners.clear();
}
