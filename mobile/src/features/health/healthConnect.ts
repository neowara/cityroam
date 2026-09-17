import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getSdkStatus,
  initialize,
  requestPermission,
  getGrantedPermissions,
  readRecords,
  insertRecords,
  openHealthConnectSettings,
  SdkAvailabilityStatus,
  ExerciseType,
} from 'react-native-health-connect';

import { authApi, type MeResponse } from '@/lib/api';
import { logEvent } from '@/lib/log';
import type { RoutePoint } from '@/features/rides/tripTypes';

// Amazfit vitals come in via Health Connect (Zepp already writes there), not raw watch protocol. Purely on-device; only computed values reach the backend, via the normal trip sync payload.
const READ_TYPES = ['HeartRate', 'RestingHeartRate', 'Steps', 'HeartRateVariabilityRmssd', 'Weight'] as const;

// Health Connect has no skateboard/e-board exercise type; SKATING is the closest match.
const WRITE_TYPES = [
  { accessType: 'write' as const, recordType: 'ExerciseSession' as const },
  { accessType: 'write' as const, recordType: 'ExerciseRoute' as const },
];

export type VitalsResult = {
  heartRateAvgBpm: number | null;
  heartRateMaxBpm: number | null;
  heartRateStartBpm: number | null;
  heartRateEndBpm: number | null;
  restingHeartRateBpm: number | null;
  heartRateVariabilityMs: number | null;
  steps: number | null;
  weightKg: number | null;
};

const NULL_VITALS: VitalsResult = {
  heartRateAvgBpm: null,
  heartRateMaxBpm: null,
  heartRateStartBpm: null,
  heartRateEndBpm: null,
  restingHeartRateBpm: null,
  heartRateVariabilityMs: null,
  steps: null,
  weightKg: null,
};

/** Deep-links straight to this app's permission toggles inside the Health Connect app. */
export function openHealthConnectSettingsPage(): void {
  openHealthConnectSettings();
}

export async function isHealthConnectAvailable(): Promise<boolean> {
  try {
    const status = await getSdkStatus();
    return status === SdkAvailabilityStatus.SDK_AVAILABLE;
  } catch {
    return false;
  }
}

/** Explicit user action only (Settings button) — same reasoning as location permissions (tripRecorder.ts): don't surprise-launch a system permission flow on cold start. */
export async function requestHealthConnectPermissions(): Promise<{ granted: boolean }> {
  const available = await isHealthConnectAvailable();
  if (!available) return { granted: false };

  await initialize();
  const granted = await requestPermission(READ_TYPES.map((recordType) => ({ accessType: 'read' as const, recordType })));
  // A denied read is cached for a day like any other result, so clear it here rather
  // than making the rider wait a day to see a permission they just granted take effect.
  await invalidateWeightCache();
  return { granted: granted.length === READ_TYPES.length };
}

export async function getHealthConnectPermissionStatus(): Promise<boolean> {
  const available = await isHealthConnectAvailable();
  if (!available) return false;
  try {
    await initialize();
    const granted = await getGrantedPermissions();
    return READ_TYPES.every((rt) => granted.some((p) => 'recordType' in p && p.recordType === rt));
  } catch {
    return false;
  }
}

/** Same explicit-user-action reasoning as requestHealthConnectPermissions — a separate
 * grant from the read-vitals one above, since a user may want one without the other. */
export async function requestHealthConnectWritePermissions(): Promise<{ granted: boolean }> {
  const available = await isHealthConnectAvailable();
  if (!available) return { granted: false };

  await initialize();
  const granted = await requestPermission(WRITE_TYPES);
  return { granted: granted.length === WRITE_TYPES.length };
}

export async function getHealthConnectWritePermissionStatus(): Promise<boolean> {
  const available = await isHealthConnectAvailable();
  if (!available) return false;
  try {
    await initialize();
    const granted = await getGrantedPermissions();
    return WRITE_TYPES.every((wt) => granted.some((p) => p.accessType === 'write' && 'recordType' in p && p.recordType === wt.recordType));
  } catch {
    return false;
  }
}

/** Writes a finished ride to Health Connect as a workout. Best-effort, silent on
 * failure — a nice-to-have side effect that must never block the trip save itself. */
export async function writeExerciseSessionForTrip(
  startTime: Date,
  endTime: Date,
  distanceKm: number,
  route: RoutePoint[],
  clientTripId?: string,
): Promise<void> {
  const available = await isHealthConnectAvailable();
  if (!available) return;

  try {
    await initialize();
    const granted = await getHealthConnectWritePermissionStatus();
    if (!granted) return;

    // Health Connect rejects the ENTIRE insert when any route point falls outside the
    // session's [startTime, endTime] ("route can not be out of parent time range") —
    // and GPS fixes carry the GPS receiver's own clock, which can run slightly ahead
    // of the wall-clock endTime the session was built from. Stretch the session to
    // cover the data and drop points that precede it, so one skewed fix can't throw
    // away the whole workout write.
    let routeStartMs: number | null = null;
    let routeEndMs: number | null = null;
    for (const p of route) {
      if (routeStartMs == null || p.timestampMs < routeStartMs) routeStartMs = p.timestampMs;
      if (routeEndMs == null || p.timestampMs > routeEndMs) routeEndMs = p.timestampMs;
    }
    const sessionStartMs = Math.min(startTime.getTime(), routeStartMs ?? startTime.getTime());
    const sessionEndMs = Math.max(endTime.getTime(), routeEndMs ?? endTime.getTime());
    // Sorted and deduped by timestamp: the route array isn't guaranteed strictly
    // increasing (a tier handover keeps the outgoing watchPositionAsync subscription
    // alive until the incoming one delivers its first sample, so two subscriptions can
    // briefly feed the same route array during a handover or a GPS-stall self-heal
    // restart — see tripRecorder/location.ts's subscribeWatch). Health Connect's own
    // exercise-route write has been seen failing on real trips for no other visible
    // reason; out-of-order or duplicate timestamps are the leading suspect, since nothing
    // here previously enforced monotonicity before handing the route to the native module.
    const inWindowRoute = route
      .filter((p) => p.timestampMs >= sessionStartMs && p.timestampMs <= sessionEndMs)
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .filter((p, i, sorted) => i === 0 || p.timestampMs > sorted[i - 1].timestampMs);

    await insertRecords([
      {
        recordType: 'ExerciseSession',
        exerciseType: ExerciseType.SKATING,
        // Health Connect upserts on clientRecordId, so saving the same ride twice (live
        // finish, then native journal sync) updates one session instead of adding another.
        ...(clientTripId ? { metadata: { clientRecordId: `cityroam-ride-${clientTripId}`, clientRecordVersion: 1 } } : {}),
        title: `Cityroam ride · ${distanceKm.toFixed(1)} km`,
        startTime: new Date(sessionStartMs).toISOString(),
        endTime: new Date(sessionEndMs).toISOString(),
        // TS types mark these Length fields optional, but the native module throws InvalidLength
        // if any is missing on any route point — verticalAccuracy/altitude are always 0m placeholders since we don't track them.
        exerciseRoute:
          inWindowRoute.length >= 2
            ? {
                route: inWindowRoute.map((p) => ({
                  time: new Date(p.timestampMs).toISOString(),
                  latitude: p.lat,
                  longitude: p.lon,
                  horizontalAccuracy: { value: p.accuracyM ?? 0, unit: 'meters' as const },
                  verticalAccuracy: { value: 0, unit: 'meters' as const },
                  altitude: { value: 0, unit: 'meters' as const },
                })),
              }
            : undefined,
      },
    ]);
    logEvent('healthConnect', 'wrote exercise session', { distanceKm, points: inWindowRoute.length });
  } catch (err) {
    // The throwable's own class name, not just its message: react-native-health-connect's
    // native errors carry a specific type (e.g. InvalidLength, SecurityException) in the
    // name, and every failure seen here before now logged only the message, which for
    // several native error shapes is empty or generic ("Failed requirement.") on its own.
    logEvent('healthConnect', 'write exercise session failed', {
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
}

/** Fetched once at trip-save time for the trip's window. Weight is the
 * exception: latest WeightRecord at-or-before trip end, a trend snapshot not a
 * within-trip average. Degrades to all-null (never a misleading zero) if unavailable. */
export async function fetchVitalsForTrip(startTime: Date, endTime: Date): Promise<VitalsResult> {
  const available = await isHealthConnectAvailable();
  if (!available) return NULL_VITALS;

  try {
    await initialize();
    const window = {
      timeRangeFilter: { operator: 'between' as const, startTime: startTime.toISOString(), endTime: endTime.toISOString() },
    };

    const [heartRate, resting, steps, hrv, weight] = await Promise.all([
      readRecords('HeartRate', window).catch(() => ({ records: [] })),
      readRecords('RestingHeartRate', window).catch(() => ({ records: [] })),
      readRecords('Steps', window).catch(() => ({ records: [] })),
      readRecords('HeartRateVariabilityRmssd', window).catch(() => ({ records: [] })),
      // Weight: look back further than the trip window — it's a snapshot, not a
      // within-trip reading, and may not have been measured during the ride itself.
      readRecords('Weight', {
        timeRangeFilter: {
          operator: 'between',
          startTime: new Date(endTime.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
          endTime: endTime.toISOString(),
        },
      }).catch(() => ({ records: [] })),
    ]);

    const allBpm = heartRate.records.flatMap((r) => r.samples.map((s) => s.beatsPerMinute));
    const heartRateAvgBpm = allBpm.length ? Math.round(allBpm.reduce((a, b) => a + b, 0) / allBpm.length) : null;
    const heartRateMaxBpm = allBpm.length ? Math.max(...allBpm) : null;

    const hrSamples = heartRate.records
      .flatMap((r) => r.samples.map((s) => ({ time: new Date(s.time).getTime(), beatsPerMinute: s.beatsPerMinute })))
      .sort((a, b) => a.time - b.time);
    const heartRateStartBpm = hrSamples.length ? hrSamples[0].beatsPerMinute : null;
    const heartRateEndBpm = hrSamples.length ? hrSamples[hrSamples.length - 1].beatsPerMinute : null;

    const restingHeartRateBpm = resting.records.length ? resting.records[resting.records.length - 1].beatsPerMinute : null;
    const stepsTotal = steps.records.length ? steps.records.reduce((sum, r) => sum + r.count, 0) : null;
    const heartRateVariabilityMs = hrv.records.length ? hrv.records[hrv.records.length - 1].heartRateVariabilityMillis : null;

    const latestWeight = weight.records
      .slice()
      .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
      .at(-1);
    const weightKg = latestWeight ? latestWeight.weight.inKilograms : null;

    const result = {
      heartRateAvgBpm,
      heartRateMaxBpm,
      heartRateStartBpm,
      heartRateEndBpm,
      restingHeartRateBpm,
      heartRateVariabilityMs,
      steps: stepsTotal,
      weightKg,
    };
    logEvent('healthConnect', 'fetched vitals for trip', result);
    return result;
  } catch (err) {
    logEvent('healthConnect', 'fetch failed', { error: err instanceof Error ? err.message : String(err) });
    return NULL_VITALS;
  }
}

/** Latest rider weight from Health Connect (90-day lookback) — used to make range
 * estimates weight-accurate. Null on any failure/permission gap, never a
 * misleading 0; callers treat null as "weight unknown → omit weightKg" and let the
 * backend fall back to its reference total. */
export async function getLatestWeightKg(): Promise<number | null> {
  const cached = await readCachedWeight();
  if (cached !== undefined) return cached;
  const value = await fetchLatestWeightKg();
  await writeCachedWeight(value);
  return value;
}

/**
 * Rider weight changes on the scale of weeks, so it is read at most once a day.
 *
 * Without this it was read on essentially every screen mount and app focus — the shared
 * 15s staleTime is right for board and trip data but absurd for body weight — and each
 * miss logged a full permission stack trace, burying everything else in the debug log.
 * A failure is cached too, deliberately: the common failure is READ_WEIGHT simply not
 * being granted, which will not start working if asked again forty seconds later.
 */
const WEIGHT_CACHE_KEY = 'turbo.latestWeightKg';
const WEIGHT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** `undefined` means "no usable cache entry", distinct from a cached `null` reading. */
async function readCachedWeight(): Promise<number | null | undefined> {
  try {
    const raw = await AsyncStorage.getItem(WEIGHT_CACHE_KEY);
    if (!raw) return undefined;
    const { at, weightKg } = JSON.parse(raw) as { at: number; weightKg: number | null };
    if (!Number.isFinite(at) || Date.now() - at > WEIGHT_CACHE_TTL_MS) return undefined;
    return weightKg;
  } catch {
    return undefined;
  }
}

async function writeCachedWeight(weightKg: number | null): Promise<void> {
  await AsyncStorage.setItem(WEIGHT_CACHE_KEY, JSON.stringify({ at: Date.now(), weightKg })).catch(() => {});
}

/** Clears the cache so the next read hits Health Connect — for when the rider has just
 * granted the permission and should not wait a day to see it take effect. */
export async function invalidateWeightCache(): Promise<void> {
  await AsyncStorage.removeItem(WEIGHT_CACHE_KEY).catch(() => {});
}

async function fetchLatestWeightKg(): Promise<number | null> {
  const available = await isHealthConnectAvailable();
  if (!available) return null;
  try {
    await initialize();
    const now = new Date();
    const { records } = await readRecords('Weight', {
      timeRangeFilter: {
        operator: 'between',
        startTime: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        endTime: now.toISOString(),
      },
    });
    const latest = records
      .slice()
      .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
      .at(-1);
    const weightKg = latest ? latest.weight.inKilograms : null;
    logEvent('healthConnect', 'fetched latest weight', { weightKg });
    return weightKg;
  } catch (err) {
    logEvent('healthConnect', 'latest weight fetch failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Best-effort background sync of the latest Health Connect weight to the backend.
 * Reads the freshest on-device weight and pushes it via PUT /auth/me/weight
 * so estimates stay correct even when Health Connect is unreachable later. Silent on any
 * failure — never throws, never blocks a trip save. Returns the updated MeResponse from
 * the backend (so the caller can refresh its session state), or null when there was
 * nothing to sync / the sync failed.
 *
 * `persistedKg` is the rider weight the backend already has (the caller's session value).
 * When the live Health Connect weight equals it, there's nothing new to write and we skip
 * the PUT — the auto-trigger on every Settings mount/foreground return shouldn't hammer
 * the backend with no-op writes. The caller passes its own persisted value rather than
 * this module reaching into the auth session, keeping the layering clean (this file
 * stays a thin Health Connect adapter). */
export async function syncLatestWeightToBackend(persistedKg: number | null | undefined): Promise<MeResponse | null> {
  const weightKg = await getLatestWeightKg();
  if (weightKg == null) return null;
  // Change-guard: only write when the live reading actually differs from what the backend
  // already has. Equal weights (the common case on a foreground return) are a no-op.
  if (persistedKg != null && Math.abs(persistedKg - weightKg) < 0.01) return null;
  try {
    const me = await authApi.putWeight(weightKg);
    logEvent('healthConnect', 'synced latest weight to backend', { weightKg });
    return me;
  } catch (err) {
    logEvent('healthConnect', 'weight sync to backend failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
