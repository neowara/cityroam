import AsyncStorage from '@react-native-async-storage/async-storage';

import { tripsApi } from '@/lib/api/trips';
import { getBackendIdForLocal } from '@/lib/db';
import type { TripDetail } from '@/lib/types';
import { fetchAndCacheTripExtras } from '@/features/widget/widgetExtras';

/**
 * The last-completed-ride summary the widget renders when no trip is live. The widget
 * is native RemoteViews and can't reach the backend or read JS memory, and the local
 * SQLite DB is queue-only (not a trip store), so the summary is captured at
 * trip-finalize time (tripRecorder.finishTrip / recoverInterruptedTrip) and persisted
 * here for widgetSync to fold into the snapshot.
 *
 * buildWidgetSnapshotJson() is synchronous, so the value lives in a module-level cache
 * that's hydrated from AsyncStorage at startup (loadWidgetContext). This module is a
 * leaf — both tripRecorder and widgetSync import it, so it must not import either of
 * them back.
 *
 * The widget's own font/accent appearance is a separate, independent concern — see
 * widgetAppearance.ts — not handled here.
 */

export type LastRideSummary = {
  // The trip_queue row id for this ride (see db.ts). Lets a later successful background
  // sync (tripSync.ts's runSync) find and backfill tripId below, even though it wasn't
  // known yet at capture time — see backfillLastRideTripId. Null for summaries backfilled
  // from a backend trip (lastRideFromTrip) rather than captured from a local finalize,
  // which have no local queue row to match against.
  localId: number | null;
  distanceKm: number;
  durationSec: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  batteryUsedPct: number | null;
  endEpochMs: number;
  stopsCount: number;
  // Backend trip id for the tap-to-open deep link (/trip/<id>). Null when the ride was
  // queued offline (no backend id yet) — the widget then falls back to opening the
  // app's dashboard until backfillLastRideTripId resolves it after a later sync.
  tripId: number | null;
};

const LAST_RIDE_KEY = 'turbo.widget.lastRide';

let lastRide: LastRideSummary | null = null;

const capturedListeners = new Set<() => void>();

export function getLastRide(): LastRideSummary | null {
  return lastRide;
}

/** Fires after a ride is captured so widgetSync can re-push the idle snapshot immediately. */
export function onLastRideCaptured(listener: () => void): () => void {
  capturedListeners.add(listener);
  return () => capturedListeners.delete(listener);
}

/** Re-syncs the cached last ride after a trip is deleted, so the widget doesn't keep
 * showing a ride that no longer exists. A no-op unless the deleted trip is the exact one
 * currently cached — deleting an older ride from history doesn't change what the widget's
 * idle view should show. */
export async function refreshLastRideAfterDelete(deletedTripId: number): Promise<void> {
  await loadWidgetContext();
  if (!lastRide || lastRide.tripId !== deletedTripId) return;
  await adoptMostRecentTripOrClear();
}

/** Confirms the cached last ride's backend trip still actually exists, and re-adopts
 * the backend's own figures for it either way. This is the app-launch counterpart to
 * refreshLastRideAfterDelete: that one only catches a delete that happens *while this
 * process is running and the delete goes through useDeleteTrip* — a ride deleted from
 * another session, or one that was already stale before this reconciliation existed,
 * leaves the cache pointing at a trip id that 404s forever otherwise (app/_layout.tsx's
 * cold-start backfill only fills in a *missing* tripId, it never re-checks one that's
 * already set). Only treats a confirmed 404 as "gone" — any other failure (offline,
 * transient 5xx) leaves the cache untouched rather than risk wiping a real ride because
 * the network hiccuped.
 *
 * Always re-adopts the backend's own summary for a confirmed-existing trip, not just its
 * existence — a ride captured locally at finalize time can end up not matching what
 * actually got stored (a duplicate save silently deduped into an earlier trip's row is
 * a real, confirmed way this happens: the widget showed a 7.3km/24min ride that no trip
 * in the list actually had, because that save's own distinct data was never the trip
 * finalizeTrip's clientTripId dedup kept). The backend is the source of truth for what a
 * trip actually is; the locally-captured snapshot is only ever a best-effort first guess. */
export async function reconcileLastRideWithBackend(): Promise<void> {
  await loadWidgetContext();
  // Captured before the awaited fetch below, and re-checked by reference after it —
  // captureLastRide/setLastRideTripId always replace lastRide with a new object
  // rather than mutating it, so this reliably detects a live finalize or another
  // backfill completing while this fetch was in flight. Applying a fetch result for
  // the OLD cached ride on top of whatever's current now would itself reintroduce
  // the same "cache doesn't match the backend" class of bug this function exists to fix.
  const before = lastRide;
  if (!before || before.tripId == null) return;
  try {
    const detail = await tripsApi.getTrip(before.tripId);
    if (lastRide === before) await captureLastRide({ ...lastRideFromTrip(detail), localId: before.localId });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('404') && lastRide === before) {
      await adoptMostRecentTripOrClear();
    }
  }
}

/** Finds the backend's current most-recent trip and adopts it as the cached last ride, or
 * clears the cache if no trips remain. Shared by refreshLastRideAfterDelete (a known trip
 * id just got deleted) and reconcileLastRideWithBackend (the cached one turned out to
 * already be gone). */
async function adoptMostRecentTripOrClear(): Promise<void> {
  const trips = await tripsApi.listTrips();
  const mostRecent = trips.reduce<(typeof trips)[number] | undefined>(
    (latest, t) => (!latest || new Date(t.endTime) > new Date(latest.endTime) ? t : latest),
    undefined,
  );
  if (!mostRecent) {
    await clearLastRide();
    return;
  }
  const detail = await tripsApi.getTrip(mostRecent.id);
  await captureLastRide(lastRideFromTrip(detail));
}

/** Clears the cached last ride and notifies listeners so the widget falls back to its
 * empty state, for the case where the deleted ride was the only one left. */
async function clearLastRide(): Promise<void> {
  lastRide = null;
  await AsyncStorage.removeItem(LAST_RIDE_KEY).catch(() => {});
  capturedListeners.forEach((listener) => listener());
}

export async function captureLastRide(summary: LastRideSummary): Promise<void> {
  lastRide = summary;
  await AsyncStorage.setItem(LAST_RIDE_KEY, JSON.stringify(summary)).catch(() => {});
  // Re-notifies once the fetch resolves (in addition to the immediate notify below) so
  // the widget's trip-by-mode row fills in promptly rather than waiting on some
  // unrelated push to happen to fire — same listener set, so this reuses widgetSync's
  // existing onLastRideCaptured → pushSnapshot wiring rather than adding a new one.
  if (summary.tripId != null) fetchAndCacheTripExtras(summary.tripId).then(() => capturedListeners.forEach((listener) => listener()));
  capturedListeners.forEach((listener) => listener());
}

/** Backfills the cached last-ride's backend trip id once a background/retry sync
 * (tripSync.ts's runSync) succeeds for a ride that was queued offline at finalize time
 * (captureLastRide was called with tripId: null then, since no backend id existed yet).
 * A no-op unless the currently-cached last ride is the exact ride that just synced —
 * matched by local queue row id, since a newer ride may have already replaced the cache.
 *
 * Awaits hydration first: a sync that lands before the cache has been read back from
 * AsyncStorage would otherwise find `lastRide` still null, no-op, and leave the id
 * permanently unresolvable — the queue row is marked synced by then, so runSync never
 * revisits it. */
export async function backfillLastRideTripId(localId: number, backendId: number): Promise<void> {
  await loadWidgetContext();
  if (!lastRide || lastRide.localId !== localId || lastRide.tripId != null) return;
  await setLastRideTripId(backendId);
}

/** Resolves a backend trip id onto the cached ride, adopting the backend's own
 * figures for it rather than just attaching the id — a duplicate save can be
 * silently deduped into a different, already-existing trip (clientTripId), so the id
 * resolved here doesn't guarantee the locally-captured summary is what actually got
 * stored (the same class of bug reconcileLastRideWithBackend exists to fix, just
 * reachable here via a background sync completing instead of app launch). Falls back
 * to attaching the id alone if the fetch fails (offline, transient error) — degrading
 * to the previous behaviour rather than losing the trip id resolution entirely.
 * `before`/reference-equality guard: see reconcileLastRideWithBackend's own comment. */
async function setLastRideTripId(backendId: number): Promise<void> {
  const before = lastRide;
  if (!before) return;
  try {
    const detail = await tripsApi.getTrip(backendId);
    if (lastRide !== before) return;
    lastRide = { ...lastRideFromTrip(detail), localId: before.localId };
  } catch {
    if (lastRide !== before) return;
    lastRide = { ...before, tripId: backendId };
  }
  await AsyncStorage.setItem(LAST_RIDE_KEY, JSON.stringify(lastRide)).catch(() => {});
  fetchAndCacheTripExtras(backendId).then(() => capturedListeners.forEach((listener) => listener()));
  capturedListeners.forEach((listener) => listener());
}

/** Maps a backend trip summary onto the widget's last-ride shape. Used to backfill the
 * idle view from the most recent trip for users who upgraded after the widget shipped and
 * so have no locally-captured last ride yet. Has no local queue row to match against
 * (it's read from the backend, not captured at local finalize time), so localId is null. */
export function lastRideFromTrip(trip: TripDetail): LastRideSummary {
  return {
    localId: null,
    distanceKm: trip.distanceKm,
    durationSec: trip.durationSec,
    maxSpeedKmh: trip.maxSpeedKmh,
    avgSpeedKmh: trip.avgSpeedKmh,
    batteryUsedPct: trip.batteryUsedPct,
    endEpochMs: Date.parse(trip.endTime),
    stopsCount: trip.stops.length,
    tripId: trip.id,
  };
}

/** Hydrates the last-ride cache from AsyncStorage. Call once at startup before the first
 * snapshot push so the widget doesn't flash an empty idle view. Memoized, and safe to
 * await from anywhere that needs the cache settled before reading it — several callers
 * (tripSync's backfill, the app's backend backfill) race this hydration and would draw
 * the wrong conclusion from a not-yet-populated cache. */
export function loadWidgetContext(): Promise<void> {
  if (!hydration) hydration = hydrate();
  return hydration;
}

let hydration: Promise<void> | null = null;

async function hydrate(): Promise<void> {
  const rawRide = await AsyncStorage.getItem(LAST_RIDE_KEY);
  // A ride captured while this read was in flight is strictly newer than what's on
  // disk — never clobber it with the stale value.
  if (!rawRide || lastRide) return;
  try {
    lastRide = JSON.parse(rawRide);
  } catch {
    // corrupt/old value — leave the cache empty rather than crash
    return;
  }
  await resolveTripIdFromQueue();
}

/** Recovers a missing backend trip id from the local queue. A ride that finished with
 * no connectivity is cached with `tripId: null`, and the one path that repairs it
 * (tripSync's backfill) only fires while the row is still pending — so a ride whose
 * sync succeeded without the backfill landing stays null forever, taking the widget's
 * odometer/weather/mode figures and its tap-through to the trip with it. The queue row
 * still holds the id, and reading it needs no network. */
async function resolveTripIdFromQueue(): Promise<void> {
  if (!lastRide || lastRide.tripId != null || lastRide.localId == null) return;
  const backendId = await getBackendIdForLocal(lastRide.localId).catch(() => null);
  if (backendId != null) await setLastRideTripId(backendId);
}
