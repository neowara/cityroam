import { api } from '@/lib/api';
import { enqueueTrip, getUnsyncedTrips, markSyncFailed, markSynced, setQueuedTripDeviceId } from '@/lib/db';
import { resolveTripDeviceId } from '@/features/rides/tripDevice';
import { logEvent } from '@/lib/log';
import type { TripCreate } from '@/features/rides/tripTypes';
import { backfillLastRideTripId } from '@/features/widget/widgetLastRide';

/** Thrown when the trip couldn't even be written to the local queue — distinct from a
 * queued trip failing to reach the backend (that's a normal, retryable synced:false),
 * this means the trip isn't durable anywhere yet and the caller's checkpoint-based
 * recovery (see tripRecorder.ts's finishTrip/recoverInterruptedTrip) is the only
 * remaining path back to it. */
export class LocalEnqueueError extends Error {
  constructor(cause: unknown) {
    super(`local trip queue write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'LocalEnqueueError';
  }
}

/** Queue-first: durably in SQLite before any network call, so a dropped connection
 * can't lose the trip. `onLocallyQueued` fires the instant the local enqueue succeeds,
 * before the network attempt below — the trips list would otherwise never have a
 * chance to show the local/offline entry at all: the network attempt can take a few
 * real seconds, during which nothing would be on screen, and then the trip would just
 * appear already in its final (synced or queued) state, indistinguishable from the
 * offline mechanic never having run. Callers should still invalidate once more after
 * this promise resolves, to flip the badge to its final state. */
export async function saveAndSyncTrip(
  trip: TripCreate,
  onLocallyQueued?: (localId: number) => void,
): Promise<{ localId: number; synced: boolean }> {
  let localId: number;
  try {
    localId = await enqueueTrip(trip);
  } catch (err) {
    // Rare — SQLite write failure (disk full, corrupt DB file, etc). Logged with the
    // real error so it's diagnosable, since nothing else will report this: the trip
    // never made it into trip_queue, so it won't show up in Settings' offline queue
    // either. Thrown (not swallowed) so finalizeTrip's caller knows to keep the
    // checkpoint around for recovery instead of treating this trip as durably saved.
    logEvent('trip-sync', 'local enqueue failed — trip not durably saved anywhere yet', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new LocalEnqueueError(err);
  }
  logEvent('trip-sync', 'enqueued locally', { localId, distanceKm: trip.distanceKm, durationSec: trip.durationSec });
  onLocallyQueued?.(localId);
  // Every trip belongs to one device. One saved before its device was known stays in the
  // queue, visible in the app, until the retry pass below can assign it.
  if (!trip.deviceId) {
    logEvent('trip-sync', 'held in the queue until its device is known', { localId });
    return { localId, synced: false };
  }
  try {
    const saved = await api.createTrip(trip);
    await markSynced(localId, saved.id);
    logEvent('trip-sync', 'synced to backend', { localId, backendId: saved.id });
    return { localId, synced: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markSyncFailed(localId, message);
    logEvent('trip-sync', 'sync to backend failed — queued for retry', { localId, error: message });
    return { localId, synced: false };
  }
}

let syncInFlight: Promise<{ attempted: number; succeeded: number }> | null = null;

/** Retries every trip still unsynced — call on app foreground/launch and after
 * Settings' connection test. A concurrent call joins the in-flight sync instead of
 * starting its own, avoiding a duplicate POST for the same trip. */
export function syncUnsyncedTrips(): Promise<{ attempted: number; succeeded: number }> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSync().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function runSync(): Promise<{ attempted: number; succeeded: number }> {
  const pending = await getUnsyncedTrips();
  if (pending.length > 0) logEvent('trip-sync', 'retrying queued trips', { count: pending.length });
  let succeeded = 0;
  for (const queued of pending) {
    try {
      let payload = queued.payload;
      if (!payload.deviceId) {
        const deviceId = await resolveTripDeviceId();
        if (!deviceId) {
          logEvent('trip-sync', 'still no device to assign, left in the queue', { localId: queued.localId });
          continue;
        }
        await setQueuedTripDeviceId(queued.localId, deviceId);
        payload = { ...payload, deviceId };
        logEvent('trip-sync', 'assigned the active device to a queued trip', { localId: queued.localId, deviceId });
      }
      const saved = await api.createTrip(payload);
      await markSynced(queued.localId, saved.id);
      // The widget's last-ride tap-through only knows a backend trip id if the ride
      // synced at the instant it finished (see widgetLastRide.ts's captureLastRide
      // call sites). A ride that finished offline and only syncs here, later, would
      // otherwise leave the widget's deep link permanently pointing at nothing —
      // backfill it now that the id exists. No-op if this isn't the ride the widget
      // currently has cached as its last ride.
      await backfillLastRideTripId(queued.localId, saved.id);
      logEvent('trip-sync', 'retry succeeded', { localId: queued.localId, backendId: saved.id });
      succeeded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markSyncFailed(queued.localId, message);
      logEvent('trip-sync', 'retry failed', { localId: queued.localId, error: message });
    }
  }
  return { attempted: pending.length, succeeded };
}
