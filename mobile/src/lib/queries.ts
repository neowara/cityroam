import { useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';

import { api } from '@/lib/api';
import { fetchVitalsForTrip, getLatestWeightKg } from '@/features/health/healthConnect';
import { getBleSnapshot, getLastKnownBatteryTelemetry } from '@/features/device/deviceLink';
import { getQueuedTripByLocalId, getUnsyncedTrips, markSynced } from '@/lib/db';
import { isLocalTripId, localIdFromTripId, queuedTripToDetail, queuedTripToSummary } from '@/features/rides/localTrips';
import { logEvent } from '@/lib/log';
import type { TripDetail } from '@/lib/types';
import { refreshLastRideAfterDelete } from '@/features/widget/widgetLastRide';

/** refetchOnWindowFocus is a web concept and doesn't fire on React Navigation's
 * tab-switch focus events; this restores that behavior. Skips the first focus since useQuery already fetches on mount. */
export function useRefetchOnFocus(refetch: () => void) {
  const hasFocusedBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (hasFocusedBefore.current) {
        refetch();
      } else {
        hasFocusedBefore.current = true;
      }
    }, [refetch]),
  );
}

// Named once, reused by both queryKeys below and the invalidateTrips/
// invalidateRangeEstimate helpers, so a future key-shape change only needs
// touching these two constants instead of every hand-typed literal.
const TRIPS_PREFIX = 'trips';
const RANGE_ESTIMATE_PREFIX = 'rangeEstimate';
const LIVE_RIDER_WEIGHT_PREFIX = 'liveRiderWeightKg';

// Centralized query keys/hooks — one place to invalidate from (e.g. after a future
// trip-save mutation invalidates ['trips']) instead of every screen re-deriving its
// own fetch/loading/error state and cache key by hand.
export const queryKeys = {
  snapshot: ['snapshot'] as const,
  // deviceId-suffixed so switching the trip filter refetches instead of
  // serving a different device's cached list; invalidateTrips() below still
  // invalidates every device-filtered variant at once (react-query key matching is
  // prefix-based).
  trips: (deviceId?: string | null) => [TRIPS_PREFIX, deviceId ?? 'all'] as const,
  trip: (id: number) => [TRIPS_PREFIX, id] as const,
  tripElevation: (id: number) => [TRIPS_PREFIX, id, 'elevation'] as const,
  tripByMode: (id: number) => [TRIPS_PREFIX, id, 'by-mode'] as const,
  deletedTrips: [TRIPS_PREFIX, 'deleted'] as const,
  // liveRiderWeightKg is the raw live Health Connect rider-weight reading sent to
  // the backend — keyed so a weight change refetches instead of serving a stale
  // cached estimate.
  rangeEstimate: (deviceId?: string | null, liveRiderWeightKg?: number | null, scenario: BatteryScenario = 'current') =>
    [RANGE_ESTIMATE_PREFIX, deviceId ?? 'all', liveRiderWeightKg ?? 'default', scenario] as const,
  // Health Connect is device-independent, so this key doesn't need a deviceId suffix.
  liveRiderWeightKg: [LIVE_RIDER_WEIGHT_PREFIX] as const,
  health: ['health'] as const,
};

export function invalidateTrips(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: [TRIPS_PREFIX] });
}

export function invalidateRangeEstimate(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: [RANGE_ESTIMATE_PREFIX] });
}

// Direct BLE is the only board connection now; getBleSnapshot is also
// used by tripRecorder.ts's own polling during a ride.
//
// refetchInterval: the LiveTripModule speedometer ("km/h now") and the Dashboard's
// battery/voltage read this query, and getBleSnapshot() reads the in-memory cached DPs
// (tuyaBleSession's state.dps) rather than poking the board — so re-reading it on a
// short interval is cheap and does NOT create a second board-polling timer (the trip
// recorder's 20s cadence and bleStatusRefresh's 30s foreground poll are the only
// things that actually query the board). Without this, the speedometer froze at the
// value from mount and never refreshed even while a ride was actively recording.
const SNAPSHOT_REFETCH_INTERVAL_MS = 2_000;
export function useSnapshot() {
  return useQuery({
    queryKey: queryKeys.snapshot,
    queryFn: getBleSnapshot,
    refetchInterval: SNAPSHOT_REFETCH_INTERVAL_MS,
  });
}

// deviceId is the persisted trip filter (useTripDeviceFilter), threaded
// through explicitly rather than read internally, so this stays a plain data hook
// testable without mocking AsyncStorage, and every screen shares one filter value
// without each needing its own subscription plumbing.
//
// A trip is a trip regardless of where it lives — merges in whatever's still sitting
// in the local offline queue (not yet uploaded, see lib/localTrips.ts) alongside the
// backend's list and sorts the combined result by date, same as if everything came
// from one source. The deviceId filter only applies to the backend call (a queued
// trip carries no deviceId client-side) — a locally-queued trip always shows
// regardless of the active filter, since hiding un-backed-up data because of an
// unrelated filter would be worse than a rare mismatched entry.
export function useTrips(deviceId?: string | null) {
  return useQuery({
    queryKey: queryKeys.trips(deviceId),
    queryFn: async () => {
      // Backend fetch failing must never hide the local queue — a Promise.all here would
      // do exactly that (the whole query rejects, the screen shows an error instead of a
      // trip list), in precisely the scenario (no backend connectivity) this offline view
      // exists for. Degrades to "no backend trips right now" instead.
      const [backendTrips, queuedTrips] = await Promise.all([
        api.listTrips(deviceId).catch((err) => {
          logEvent('trips', 'backend trip list fetch failed — showing local trips only', {
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }),
        getUnsyncedTrips(),
      ]);
      const local = queuedTrips.map(queuedTripToSummary);
      return [...local, ...backendTrips].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
    },
  });
}

export function useTrip(id: number) {
  // A negative id means "local trip_queue row, not yet uploaded" (see
  // lib/localTrips.ts) — read straight from SQLite instead of the backend. 0 is the
  // one invalid value (callers with no trip yet, e.g. Dashboard's `lastTrip?.id ?? 0`,
  // used to guard against a guaranteed-404 request every render before this existed).
  return useQuery({
    queryKey: queryKeys.trip(id),
    queryFn: async () => {
      if (isLocalTripId(id)) {
        const queued = await getQueuedTripByLocalId(localIdFromTripId(id));
        if (!queued) throw new Error('This trip is no longer queued on this device.');
        return queuedTripToDetail(queued);
      }
      return api.getTrip(id);
    },
    enabled: Number.isFinite(id) && id !== 0,
  });
}

/** Uploads a locally-queued trip on demand — the trip detail screen's "Sync trip with
 * server" action for a trip that failed to save (or hasn't yet) at ride-finish time.
 * Distinct from tripSync.ts's saveAndSyncTrip/syncUnsyncedTrips (which run at
 * ride-finish and app-foreground automatically): this is the explicit, user-triggered
 * retry for one specific trip, callable from anywhere the trip is already loaded. */
export function useSyncTrip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (localId: number): Promise<TripDetail> => {
      const queued = await getQueuedTripByLocalId(localId);
      if (!queued) throw new Error('This trip is no longer queued on this device.');
      const saved = await api.createTrip(queued.payload);
      await markSynced(localId, saved.id);
      return saved;
    },
    onSuccess: (saved, localId) => {
      invalidateTrips(queryClient);
      // The local-id cache entry no longer resolves to anything (the row is marked
      // synced, so getQueuedTripByLocalId's caller-facing "still queued" contract no
      // longer applies to it the same way) — drop it and seed the real one instead of
      // waiting on a refetch.
      queryClient.removeQueries({ queryKey: queryKeys.trip(-localId) });
      queryClient.setQueryData(queryKeys.trip(saved.id), saved);
    },
  });
}

// Lazy, on-demand fetch — only fires once the trip detail screen actually renders
// the elevation chart, since most trip views never scroll that far. The backend
// fetch is itself cached indefinitely per-coordinate (Open-Meteo elevation doesn't
// change), so revisiting the same trip's detail screen, or a different trip
// covering overlapping streets, doesn't re-hit the network either.
export function useTripElevation(id: number) {
  return useQuery({
    queryKey: queryKeys.tripElevation(id),
    queryFn: () => api.getTripElevation(id),
    enabled: Number.isFinite(id) && id > 0,
    staleTime: Infinity,
  });
}

// Same lazy/cached-indefinitely shape as useTripElevation above: only fires once
// the trip detail screen's by-mode module actually renders, and the underlying
// physics re-simulation over a fixed completed-trip route never changes, so
// there's nothing to ever refetch.
export function useTripByMode(id: number) {
  return useQuery({
    queryKey: queryKeys.tripByMode(id),
    queryFn: () => api.getTripByMode(id),
    enabled: Number.isFinite(id) && id > 0,
    staleTime: Infinity,
  });
}

export type BatteryTelemetry = { batteryPct: number | null; voltageV: number | null };

// "Range by mode" (and the trip planner's battery-based estimates) is viewable at
// either the board's current charge or a hypothetical full battery. 'current' feeds
// the live-or-last-known telemetry (see pickBatteryTelemetry); 'full' substitutes a
// hardcoded 100% with no voltage, since a full-battery scenario is a hypothetical —
// there's no real pack voltage to pair with it.
export type BatteryScenario = 'current' | 'full';

export const BATTERY_SCENARIO_OPTIONS: { value: BatteryScenario; label: string }[] = [
  { value: 'current', label: 'Current battery' },
  { value: 'full', label: 'Full battery' },
];

/** Pure selection logic behind useRangeEstimate's cache-fallback (extracted so it's
 * unit-testable without a QueryClient/BLE mock harness). Live wins whenever either
 * field is present; `lastKnown` is only consulted when live has neither, and `stale`
 * is only true when the fallback actually had something to offer (both null stays
 * non-stale "no data at all", same case getBleSnapshot's own no-dps branch means). */
export function pickBatteryTelemetry(live: BatteryTelemetry, lastKnown: BatteryTelemetry): BatteryTelemetry & { stale: boolean } {
  if (live.batteryPct != null || live.voltageV != null) {
    return { ...live, stale: false };
  }
  const stale = lastKnown.batteryPct != null || lastKnown.voltageV != null;
  return { ...lastKnown, stale };
}

/** Resolve the battery/voltage pair to send the backend for a given scenario. Shared by
 * the dashboard's useRangeEstimate and the trip planner's estimate mutation so both
 * always agree on what "current" vs "full" means. 'full' is a hardcoded 100% with no
 * voltage; 'current' is the live reading when the board is connected, else the last
 * known value (stale). */
export async function resolveBatteryForScenario(scenario: BatteryScenario): Promise<BatteryTelemetry & { stale: boolean }> {
  if (scenario === 'full') return { batteryPct: 100, voltageV: null, stale: false };
  const snap = await getBleSnapshot().catch(() => null);
  return pickBatteryTelemetry({ batteryPct: snap?.batteryPct ?? null, voltageV: snap?.voltageV ?? null }, getLastKnownBatteryTelemetry());
}

// Battery/voltage come from the phone's own live BLE reading, not a backend-side
// Tuya Cloud call. A board that isn't paired yet (or hasn't pushed data yet) just
// means null battery/voltage, same honest "not enough data" every mode already
// renders — never a failed query.
//
// getBleSnapshot() deliberately nulls telemetry on disconnect (see its own
// comment), and the backend can't turn a mode's km-per-% ratio into an actual km
// number without SOME battery/voltage reading. Falls back to the last
// successfully-read live value (getLastKnownBatteryTelemetry, the same persisted
// DP cache, just without the online gate) so the UI keeps showing a real number
// instead of "–" while disconnected; `stale` tells the UI whether what's shown is
// a live reading or a carried-over one, so it can badge it accordingly. The moment
// the board reconnects and pushes a fresh DP, react-query's next refetch
// (useRefetchOnFocus / the invalidateRangeEstimate calls already wired to BLE data
// changes) picks up live values again automatically — no manual refresh needed.
export function useRangeEstimate(deviceId?: string | null, liveRiderWeightKg?: number | null, scenario: BatteryScenario = 'current') {
  return useQuery({
    queryKey: queryKeys.rangeEstimate(deviceId, liveRiderWeightKg, scenario),
    queryFn: async () => {
      const { batteryPct, voltageV, stale } = await resolveBatteryForScenario(scenario);
      const result = await api.rangeEstimate({
        batteryPct: batteryPct ?? undefined,
        voltageV: voltageV ?? undefined,
        deviceId,
        liveRiderWeightKg: liveRiderWeightKg ?? undefined,
      });
      return { ...result, stale };
    },
  });
}

// The raw live Health Connect rider-weight reading — unfallbacked, still nullable.
// The backend owns combining this with the persisted/default rider weight and the
// per-device board weight (DeviceSetting.boardWeightKg) itself, so this hook
// doesn't need the account's persisted weight or the device's board-weight setting.
export function useLiveRiderWeightKg() {
  const { data } = useQuery({
    queryKey: queryKeys.liveRiderWeightKg,
    queryFn: () => getLatestWeightKg().catch(() => null),
    // Body weight does not change on the shared 15s cadence. getLatestWeightKg caches
    // to disk for a day as well; this stops the query layer from asking that often.
    staleTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  return data ?? null;
}

export function useDeletedTrips() {
  return useQuery({ queryKey: queryKeys.deletedTrips, queryFn: api.listDeletedTrips });
}

export function useDeleteTrip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteTrip(id),
    onSuccess: (_data, id) => {
      invalidateTrips(queryClient); // every device-filtered variant, not just queryKeys.trips(deviceId)
      queryClient.removeQueries({ queryKey: queryKeys.trip(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.deletedTrips });
      invalidateRangeEstimate(queryClient);
      // The widget's idle view caches a snapshot of whatever ride finished last — if that's
      // the one just deleted, it'd otherwise keep showing a ride that no longer exists
      // until some unrelated trip finishes and overwrites it.
      void refreshLastRideAfterDelete(id);
    },
  });
}

export function useRestoreDeletedTrips() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => api.restoreDeletedTrips(ids),
    onSuccess: () => {
      invalidateTrips(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.deletedTrips });
      invalidateRangeEstimate(queryClient);
    },
  });
}

export function useRefreshTripVitals(trip: TripDetail | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!trip) throw new Error('No trip loaded yet');
      const vitals = await fetchVitalsForTrip(new Date(trip.startTime), new Date(trip.endTime));
      const filteredVitals = Object.fromEntries(Object.entries(vitals).filter(([, value]) => value != null)) as Partial<{
        heartRateAvgBpm: number;
        heartRateMaxBpm: number;
        heartRateStartBpm: number;
        heartRateEndBpm: number;
        restingHeartRateBpm: number;
        heartRateVariabilityMs: number;
        steps: number;
      }>;
      return api.updateTripVitals(trip.id, filteredVitals);
    },
    onSuccess: () => {
      if (!trip) return;
      invalidateTrips(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.trip(trip.id) });
    },
  });
}
