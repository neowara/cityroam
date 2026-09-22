import * as SQLite from 'expo-sqlite';

import type { BoardSpeedSample, ModeSample, RoutePoint, Stop, TripCreate, VoltageSample } from '@/features/rides/tripTypes';

/** Local durability/retry queue for completed trips, not a full offline-first mirror.
 * Written the instant a trip ends, before any network call. `synced`/`backendId`
 * track whether the POST /trips landed; syncUnsyncedTrips() retries failures. Screens
 * still read from the backend via TanStack Query — this table is queue-only, not for display. */

const DB_NAME = 'turbo-trip-queue.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME).then(async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS trip_queue (
          localId INTEGER PRIMARY KEY AUTOINCREMENT,
          payload TEXT NOT NULL,
          synced INTEGER NOT NULL DEFAULT 0,
          backendId INTEGER,
          createdAt TEXT NOT NULL,
          lastError TEXT
        );
        CREATE TABLE IF NOT EXISTS trip_checkpoint (
          id INTEGER PRIMARY KEY,
          payload TEXT NOT NULL
        );
      `);
      return db;
    });
  }
  return dbPromise;
}

export async function enqueueTrip(trip: TripCreate): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    'INSERT INTO trip_queue (payload, synced, createdAt) VALUES (?, 0, ?)',
    JSON.stringify(trip),
    new Date().toISOString(),
  );
  return result.lastInsertRowId;
}

export async function markSynced(localId: number, backendId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE trip_queue SET synced = 1, backendId = ?, lastError = NULL WHERE localId = ?', backendId, localId);
}

/** Resolves the backend trip id a synced local queue row was assigned (see markSynced),
 * or null when the row isn't synced yet. Lets the widget's last-ride capture map a just-
 * finished ride onto its /trip/<id> deep link even though finalize only hands back the
 * local id. */
export async function getBackendIdForLocal(localId: number): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ backendId: number | null }>('SELECT backendId FROM trip_queue WHERE localId = ?', localId);
  return row?.backendId ?? null;
}

/** True when the queue already holds a trip whose clientTripId (start time in seconds) is
 * within a second of this one, which is how the backend decides two saves are the same ride. */
export async function hasQueuedTripNear(clientTripId: string): Promise<boolean> {
  const db = await getDb();
  const startSec = Number(clientTripId);
  const row = await db.getFirstAsync<{ found: number }>(
    "SELECT 1 AS found FROM trip_queue WHERE CAST(json_extract(payload, '$.clientTripId') AS INTEGER) BETWEEN ? AND ? LIMIT 1",
    startSec - 1,
    startSec + 1,
  );
  return row != null;
}

/** True when the queue holds a trip whose time span overlaps [startMs, endMs]. Start and
 * end are stored as ISO strings from toISOString(), which compare correctly as text. */
export async function hasQueuedTripOverlapping(startMs: number, endMs: number): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ found: number }>(
    "SELECT 1 AS found FROM trip_queue WHERE json_extract(payload, '$.startTime') < ? AND json_extract(payload, '$.endTime') > ? LIMIT 1",
    new Date(endMs).toISOString(),
    new Date(startMs).toISOString(),
  );
  return row != null;
}

export async function markSyncFailed(localId: number, error: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE trip_queue SET lastError = ? WHERE localId = ?', error, localId);
}

export type QueuedTrip = {
  localId: number;
  payload: TripCreate;
  synced: boolean;
  backendId: number | null;
  createdAt: string;
  lastError: string | null;
};

export async function getUnsyncedTrips(): Promise<QueuedTrip[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    localId: number;
    payload: string;
    synced: number;
    backendId: number | null;
    createdAt: string;
    lastError: string | null;
  }>('SELECT * FROM trip_queue WHERE synced = 0 ORDER BY createdAt ASC');

  return rows.map((row) => ({
    localId: row.localId,
    payload: JSON.parse(row.payload) as TripCreate,
    synced: false,
    backendId: row.backendId,
    createdAt: row.createdAt,
    lastError: row.lastError,
  }));
}

/** Single-row lookup for the trip detail screen's local-trip path (see
 * lib/localTrips.ts) — unlike getUnsyncedTrips, returns a row regardless of its
 * synced state, since a trip that's already synced by the time this is read (a
 * background retry landed while the screen was open) should still resolve instead of
 * 404ing. */
export async function getQueuedTripByLocalId(localId: number): Promise<QueuedTrip | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    localId: number;
    payload: string;
    synced: number;
    backendId: number | null;
    createdAt: string;
    lastError: string | null;
  }>('SELECT * FROM trip_queue WHERE localId = ?', localId);
  if (!row) return null;
  return {
    localId: row.localId,
    payload: JSON.parse(row.payload) as TripCreate,
    synced: row.synced === 1,
    backendId: row.backendId,
    createdAt: row.createdAt,
    lastError: row.lastError,
  };
}

/** A durable, periodically-refreshed snapshot of the CURRENTLY-recording trip, not the
 * completed-trip queue above — without it, an OS-killed process lost the whole ride
 * with nothing to recover. Single row (id=1); a row still present at app startup means
 * the previous session ended without finishing its trip. */
export type TripCheckpoint = {
  tripStartMs: number;
  wasManual: boolean;
  route: RoutePoint[];
  stops: Stop[];
  modeSamples: ModeSample[];
  voltageSamples: VoltageSample[];
  boardSpeedSamples: BoardSpeedSample[];
  distanceKm: number;
  maxSpeedKmh: number;
  batteryStartPct: number | null;
  odometerStartKm: number | null;
  // Rolling latest board telemetry (dp12 odometer / dp3 battery) captured at the last
  // checkpoint — recovery uses these for the end odometer/battery when the app dies
  // mid-ride (no live end-of-trip snapshot exists). Null for checkpoints written
  // before this field existed.
  latestOdometerKm: number | null;
  latestBatteryPct: number | null;
  lastUpdateMs: number;
};

export async function saveTripCheckpoint(checkpoint: TripCheckpoint): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO trip_checkpoint (id, payload) VALUES (1, ?)', JSON.stringify(checkpoint));
}

export async function getTripCheckpoint(): Promise<TripCheckpoint | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM trip_checkpoint WHERE id = 1');
  return row ? (JSON.parse(row.payload) as TripCheckpoint) : null;
}

export async function clearTripCheckpoint(): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM trip_checkpoint WHERE id = 1');
}
