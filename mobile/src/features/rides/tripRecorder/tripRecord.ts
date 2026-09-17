import type { BoardSnapshot } from '@/lib/api';
import { getBleSnapshot, refreshDeviceStatus } from '@/features/device/deviceLink';
import { logEvent } from '@/lib/log';
import { modeLabel } from '@/lib/mode';
import type { BoardSpeedSample, ModeSample, RoutePoint, Stop, VoltageSample } from '@/features/rides/tripTypes';

import { computeTripDistanceKm, integrateBoardSpeedSamples } from '@/features/rides/tripRecorder/boardDistance';
import { SamplingCadence } from '@/features/rides/tripRecorder/samplingCadence';

/** Single owner for "the trip's data so far." Everything a recording trip
 * accumulates (route/stops/samples/distance/speed/battery/odometer) lives here, behind
 * one factory instead of ~20 independent `this.*` fields on TripRecorder re-listed
 * across resetTripAccumulators/checkpoint/finalize. Board telemetry still enters
 * through the same two paths it always has (the live dp2 push subscription and the
 * periodic snapshot poll) — they now both fold into this record via onBoardSpeed/
 * snapshotAt instead of touching TripRecorder's own fields directly. Pure structural
 * extraction: every constant/comment/timing below is unchanged from tripRecorder.ts. */

// Floor below which a momentary slow-down isn't worth logging as a stop marker.
// Exported: also used to debounce the live "Ride paused" UI (see tripRecorder.ts's
// emit()) — the state machine's own 'stopped' state flips instantly on any dip below
// STOP_SPEED_KMH (a traffic light glance, a bump) with no floor of its own, by design
// (it doubles as the GPS-jitter-suppression signal, which needs to react immediately,
// not debounced). Reusing this same constant means "Ride paused" only appears once a
// pause has gone on long enough that it would actually end up as a real stop marker.
export const MIN_STOP_DURATION_SEC = 20;

// The board's dp2 wheel speed is the live speed source, never GPS.
// A transient dp2 blip (a momentary 0, or a single dropped sample) must not make the
// speedometer drop to 0 — freeze the last real board speed through this grace window
// before letting it fall.
const LIVE_SPEED_GRACE_MS = 2_500;

// The dp2 push stream is far denser than the snapshot poll, so the board-speed time
// series is thinned to this spacing before being recorded. Dense enough that the
// distance integration stays accurate through acceleration and braking, sparse enough
// that a long ride's sample array stays a sane size to checkpoint and upload. Exported:
// rideCoreSync.ts reuses the same floor to thin the native journal's own per-dp-push
// mode/voltage/board-speed rows before they ever reach a chart or the backend.
export const BOARD_SPEED_SAMPLE_MIN_INTERVAL_MS = 5_000;

// pollSnapshotAt's active board query is best-effort: bound how long we wait for the
// query to be *sent* (queryDeviceStatus resolves once the request is dispatched, not
// when values land), then give the response a fixed moment to arrive via the normal
// onDpUpdate push before reading the snapshot. Both are bounded so a hung/failed query
// never blocks the snapshot -- it falls through to whatever's already cached.
//
// Real bug this once caused: queryDeviceStatus's underlying native call is now
// serialized through BleCommandQueue (Android only allows one GATT operation in
// flight at a time — see BleCommandQueue.kt), which means "dispatched" can now mean
// "sitting behind a pending reconnect attempt" for up to CONNECT_SLOT_MS (6s, see
// that file) before the query is even sent, not just its own round-trip. At the old
// 1000ms budget, a query queued behind a reconnect blew through this timeout before
// ever being dispatched, every time — an entire ride recorded with no mode/voltage
// samples and no odometerStartKm (confirmed against a real ride), while GPS/route and
// board-speed (which arrive via passive dp2 pushes, not this active query path) kept
// working fine, exactly the split symptom that gave this away. 6500ms covers one full
// worst-case queue wait plus a real round-trip margin.
const SNAPSHOT_QUERY_SEND_TIMEOUT_MS = 6_500;
const SNAPSHOT_RESPONSE_SETTLE_MS = 500;
// A single query+settle can still read a stale snapshot if the board's response to
// queryDeviceStatus races the settle window (the query only confirms the *request*
// was sent; the values arrive asynchronously). If the snapshot comes back with no
// fresh telemetry at all, re-query and wait again, up to this many extra attempts,
// before falling through to whatever's cached. Bounded so a genuinely-off board
// can't stall the snapshot loop. Only 1 (not 2) now that each attempt can itself take
// up to ~9s worst case (SNAPSHOT_QUERY_SEND_TIMEOUT_MS + SNAPSHOT_RESPONSE_SETTLE_MS +
// SNAPSHOT_READ_TIMEOUT_MS) — even at 1 retry, worst-case total is ~18.5s against the
// 20s snapshot cadence (SNAPSHOT_POLL_INTERVAL_MS in samplingCadence.ts), only ~1.5s of
// margin, not a comfortable one; periodicRunInFlight (tripRecorder.ts) just skips an
// overlapping tick rather than corrupting state if it's cut close, so this degrades
// gracefully rather than breaking, but a 2nd retry would make overlap the common case
// instead of a rare one.
const SNAPSHOT_RETRY_ATTEMPTS = 1;

// getBleSnapshot() itself (unlike refreshDeviceStatus above) had no bound at all — a
// real ride hit this: the board's connection was flaky enough that the read stalled
// for ~18 minutes, so the 'start' snapshot only resolved moments before the rider
// hit "Finish trip". The resulting odometerStartKm was captured at end-of-ride, not
// start, so the odometer delta came out ~0 and the whole 7km ride got silently
// discarded by the misclick guard. Bound the read so it can never stall the caller.
const SNAPSHOT_READ_TIMEOUT_MS = 2_000;

// If the 'start' snapshot's odometer reading lands later than this after the trip
// actually started, the board has likely moved enough that the reading no longer
// represents "at start" — using it as the odometer-delta baseline would understate
// (or, as above, zero out) the ride's real distance. Past this point, distance falls
// back to boardSpeedSamples integration instead (see computeTripDistanceKm).
const STALE_START_SNAPSHOT_MS = 60_000;

/** True when a snapshot carries any live telemetry (mode, voltage, or battery) — the
 * retry loop re-queries while this is false, since a snapshot with none of these
 * means the board's response to queryDeviceStatus hadn't landed yet and the read is
 * stale. A snapshot with at least one of them is fresh enough to record. */
function hasFreshTelemetry(snap: { mode: unknown; voltageV: unknown; batteryPct: unknown }): boolean {
  return snap.mode != null || snap.voltageV != null || snap.batteryPct != null;
}

/** The exact field set writeCheckpoint/finalizeTrip need out of the record — shared by
 * checkpointPayload() (mid-trip) and collect() (end-of-trip) so the two can't drift. */
export type TripRecordPayload = {
  route: RoutePoint[];
  stops: Stop[];
  modeSamples: ModeSample[];
  voltageSamples: VoltageSample[];
  boardSpeedSamples: BoardSpeedSample[];
  distanceKm: number;
  maxSpeedKmh: number;
  batteryStartPct: number | null;
  odometerStartKm: number | null;
  // Rolling latest board telemetry (dp12 odometer / dp3 battery), captured from the
  // live BLE stream and every snapshot so a checkpoint written with GPS dead still
  // carries the board's most recent odometer/battery for recovery's end values.
  latestOdometerKm: number | null;
  latestBatteryPct: number | null;
};

export type TripRecord = ReturnType<typeof createTripRecord>;

export function createTripRecord() {
  // Bumped by begin(). A snapshot that was waiting when a newer trip began (Android pauses
  // JS timers on a locked phone, so one can resolve hours later) must not write into it.
  let tripGeneration = 0;
  let route: RoutePoint[] = [];
  let stops: Stop[] = [];
  let modeSamples: ModeSample[] = [];
  let voltageSamples: VoltageSample[] = [];
  let boardSpeedSamples: BoardSpeedSample[] = [];
  let distanceKm = 0;
  let maxSpeedKmh = 0;
  // The board's latest wheel-based speed (dp2), kept live by startBleSpeedTracking via
  // onBoardSpeed. This is the authoritative motion signal the state machine
  // auto-starts/stops on.
  let boardSpeedKmh = 0;
  // The last *real* (moving) board dp2 speed and when it was seen, used to freeze
  // the live speed through a transient blip (see LIVE_SPEED_GRACE_MS).
  let lastBoardSpeedKmh = 0;
  let lastBoardSpeedAtMs = 0;
  let batteryStartPct: number | null = null;
  let odometerStartKm: number | null = null;
  // First dp12/dp3 the live BLE stream delivered THIS trip. The start snapshot that
  // normally sets batteryStartPct/odometerStartKm is an active BLE query — it can
  // stall far past its bound (a locked phone pauses the JS timers those bounds run
  // on) and arrive too late to trust, leaving both null for the whole trip: no
  // odometer start, no battery used, no efficiency. The first passively-pushed
  // values are the closest thing to trip-start telemetry and arrive whether or not
  // any query succeeds.
  let firstOdometerKm: number | null = null;
  let firstBatteryPct: number | null = null;
  // Rolling latest board telemetry (dp12 odometer / dp3 battery) seen this trip — kept
  // current by every snapshotAt AND the live BLE dp stream (onBoardTelemetry), so a
  // checkpoint written while GPS is dead still carries the board's most recent values.
  let latestOdometerKm: number | null = null;
  let latestBatteryPct: number | null = null;
  // Timestamp of the last dp2 sample appended to boardSpeedSamples by onBoardSpeed —
  // the dp2 push stream is far denser than the snapshot poll, so it's thinned to
  // BOARD_SPEED_SAMPLE_MIN_INTERVAL_MS before being recorded (see that constant).
  let lastBoardSpeedSampleAtMs = 0;
  let pendingStop: { lat: number; lon: number; startTimestampMs: number } | null = null;
  const cadence = new SamplingCadence();

  // Returned when getBleSnapshot() itself doesn't land within SNAPSHOT_READ_TIMEOUT_MS
  // — same shape getBleSnapshot() already uses for "board confirmed offline", since a
  // read that can't complete is functionally no different from one with nothing to read.
  const TIMED_OUT_SNAPSHOT: BoardSnapshot = {
    online: false,
    deviceName: null,
    speedKmh: null,
    batteryPct: null,
    remoteBatteryPct: null,
    mileageOnceKm: null,
    mileageTotalKm: null,
    rideTimeOnceSec: null,
    voltageV: null,
    mode: null,
    headlightOn: null,
    cruiseOn: null,
    lockOn: null,
    unit: null,
  };

  /** One query+settle+read cycle for snapshotAt — extracted so the retry loop can
   * re-run it without duplicating the bounded-wait logic. */
  async function queryAndReadSnapshot(): Promise<BoardSnapshot> {
    // Clear the timeout when refreshDeviceStatus wins the race, so a fast query doesn't
    // leave a dangling timer behind (a real leak on every snapshot, and it trips Jest's
    // open-handle detection in the real-timer trip tests).
    let queryTimer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      refreshDeviceStatus(),
      new Promise((resolve) => {
        queryTimer = setTimeout(resolve, SNAPSHOT_QUERY_SEND_TIMEOUT_MS);
      }),
    ]).catch(() => {});
    if (queryTimer) clearTimeout(queryTimer);
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_RESPONSE_SETTLE_MS));
    // Direct BLE is the only board connection, same source as Dashboard's useSnapshot().
    // Unlike refreshDeviceStatus above, getBleSnapshot() itself used to have no bound —
    // a stall inside it (AsyncStorage/native-bridge contention on a flaky connection)
    // could hang this whole call indefinitely instead of falling through to "no data".
    let readTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        getBleSnapshot(),
        new Promise<BoardSnapshot>((resolve) => {
          readTimer = setTimeout(() => resolve(TIMED_OUT_SNAPSHOT), SNAPSHOT_READ_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (readTimer) clearTimeout(readTimer);
    }
  }

  function payload(): TripRecordPayload {
    return {
      route,
      stops,
      modeSamples,
      voltageSamples,
      boardSpeedSamples,
      distanceKm,
      maxSpeedKmh,
      batteryStartPct,
      odometerStartKm,
      latestOdometerKm,
      latestBatteryPct,
    };
  }

  function finalizeStopIfAny(atMs: number): void {
    if (!pendingStop) return;
    const durationSec = Math.floor((atMs - pendingStop.startTimestampMs) / 1000);
    // Discard blips shorter than MIN_STOP_DURATION_SEC — corners/crosswalks, not real stops.
    if (durationSec >= MIN_STOP_DURATION_SEC) {
      stops.push({
        lat: pendingStop.lat,
        lon: pendingStop.lon,
        startTimestampMs: pendingStop.startTimestampMs,
        durationSec,
      });
    }
    pendingStop = null;
  }

  return {
    get route() {
      return route;
    },
    get stops() {
      return stops;
    },
    get modeSamples() {
      return modeSamples;
    },
    get voltageSamples() {
      return voltageSamples;
    },
    get boardSpeedSamples() {
      return boardSpeedSamples;
    },
    get distanceKm() {
      return distanceKm;
    },
    get maxSpeedKmh() {
      return maxSpeedKmh;
    },
    get boardSpeedKmh() {
      return boardSpeedKmh;
    },
    get batteryStartPct() {
      return batteryStartPct;
    },
    get odometerStartKm() {
      return odometerStartKm;
    },
    get latestOdometerKm() {
      return latestOdometerKm;
    },
    get latestBatteryPct() {
      return latestBatteryPct;
    },
    /** The in-progress stop being timed out (or null) — read by TripRecorder's
     * auto_end handler to prefer the actual stop time over a late timeout tick. */
    get pendingStop() {
      return pendingStop;
    },

    /** Replaces the accumulator-reset half of the old resetTripAccumulators — NOT the
     * ticking/clearCheckpoints side-effects, those stay owned by TripRecorder. `startMs`
     * is accepted for symmetry with the caller's own reset (tripStartMs itself remains a
     * TripRecorder-owned field, not part of the record) and isn't otherwise used here.
     * Note boardSpeedKmh/lastBoardSpeedKmh/lastBoardSpeedAtMs are deliberately NOT reset
     * — matches the pre-extraction behavior, where the live BLE-driven board speed rolls
     * across trip boundaries rather than resetting to 0 on every new trip. */
    begin(startMs: number): void {
      void startMs;
      tripGeneration++;
      route = [];
      stops = [];
      modeSamples = [];
      voltageSamples = [];
      boardSpeedSamples = [];
      distanceKm = 0;
      maxSpeedKmh = 0;
      cadence.reset();
      pendingStop = null;
      // Reset alongside the rolling telemetry above -- this record is one long-lived
      // instance reused across every trip in the app's session (see the module's own
      // doc comment), and these two previously were NOT reset here: a trip whose own
      // start baseline never got set (both the 'start' snapshot and the first-seen
      // fallback came up empty) would silently inherit the PREVIOUS trip's
      // odometerStartKm/batteryStartPct instead of genuinely having none. That bug was
      // invisible as long as every real trip's own snapshotAt('start') eventually
      // overwrote whatever was here; seedStartTelemetry's "only fill if still null"
      // contract below depends on these actually being null at the start of every trip,
      // not just the app's very first one.
      odometerStartKm = null;
      batteryStartPct = null;
      latestOdometerKm = null;
      latestBatteryPct = null;
      firstOdometerKm = null;
      firstBatteryPct = null;
      lastBoardSpeedSampleAtMs = 0;
    },

    /** Seeds the trip's start baseline (odometerStartKm/batteryStartPct) from
     * telemetry the live BLE stream already delivered BEFORE this trip began. Call
     * immediately after begin() resets the accumulators for a new trip, with values
     * the caller captured synchronously before begin() ran (begin() wipes
     * latestOdometerKm/latestBatteryPct to null, and any async gap before this runs
     * risks the trip's own dp12/dp3 pushes racing ahead of it and being mistaken for
     * "pre-ride" values). This is the primary source for the start baseline, not a
     * fallback: the board keeps pushing dp12/dp3 every few seconds regardless of trip
     * state, so a value seen moments before auto_start is always at least as
     * trustworthy as (and normally much earlier than) whatever the 'start' snapshot's
     * own live BLE query manages to read back -- a real ride had that query land
     * ~54s after the true start, which is exactly the gap this closes. Only fills
     * (never overwrites) so a caller with nothing to seed -- e.g. the app's very
     * first ride, before any dp12/dp3 has ever arrived -- leaves both null for
     * snapshotAt('start') to fill instead. */
    seedStartTelemetry(telemetry: { odometerKm: number | null; batteryPct: number | null }): void {
      if (odometerStartKm == null && telemetry.odometerKm != null) odometerStartKm = telemetry.odometerKm;
      if (batteryStartPct == null && telemetry.batteryPct != null) batteryStartPct = telemetry.batteryPct;
    },

    /** What handleLocationSample's route.push/pendingStop block does today — but NOT
     * the state-machine-driving parts (the caller works out enteringStopped/
     * leavingStopped/isStopped from its own prevState/state transition and passes them
     * in). `point.speedKmh`/`accuracyM` are geometry-only fields on the route point,
     * never used for distance/speed metrics (BOARD = telemetry / PHONE = GPS only). */
    onGpsSample(point: RoutePoint, transition: { enteringStopped: boolean; leavingStopped: boolean; isStopped: boolean }): void {
      if (transition.enteringStopped) {
        pendingStop = { lat: point.lat, lon: point.lon, startTimestampMs: point.timestampMs };
      } else if (transition.leavingStopped) {
        finalizeStopIfAny(point.timestampMs);
      }

      // Freeze route while 'stopped' (waiting out the auto-end timeout) — otherwise
      // stationary GPS jitter trails the route off the real stop point.
      if (!transition.isStopped) {
        route.push(point);
        // Distance is NOT integrated from GPS here. BOARD = telemetry / PHONE = GPS only:
        // distance comes from the board odometer delta at finalize, with
        // boardSpeedSamples-integration as the fallback. The live distanceKm estimate is
        // updated from board speed samples in snapshotAt; GPS contributes only the
        // route's lat/lon geometry (and its speedKmh field for geometry, never metrics).
        // Max speed is likewise board-only (dp2), folded in by the BLE session
        // subscription (onBoardSpeed) and snapshotAt.
      }
    },

    /** Max speed must be the highest the board's own speedometer (dp2) ever reports,
     * not a GPS-derived number — GPS lags and can spike (a low-accuracy fix once
     * inflated max to an impossible 43.8 km/h). Folds every dp2 push into maxSpeedKmh
     * in real time, rather than only catching a reading on the periodic snapshot poll. */
    onBoardSpeed(speedKmh: number, timestampMs: number): void {
      boardSpeedKmh = speedKmh;
      maxSpeedKmh = Math.max(maxSpeedKmh, speedKmh);
      // The board's dp2 wheel speed is the live speed source. Track the last *real*
      // (moving) reading and when it was seen so the live speed can freeze through a
      // transient blip (momentary 0 / dropped sample) instead of dropping to 0.
      if (speedKmh > 0) {
        lastBoardSpeedKmh = speedKmh;
        lastBoardSpeedAtMs = timestampMs;
      }
      // The dp2 push stream is the board's own speed time series — thin it into
      // boardSpeedSamples (BOARD_SPEED_SAMPLE_MIN_INTERVAL_MS) so the distance time
      // series keeps accumulating from the live board stream even when GPS snapshots
      // aren't running (GPS dead in background). Recompute the live distance estimate
      // from the (now longer) series so distanceKm stays fresh without a snapshot.
      if (timestampMs - lastBoardSpeedSampleAtMs >= BOARD_SPEED_SAMPLE_MIN_INTERVAL_MS) {
        lastBoardSpeedSampleAtMs = timestampMs;
        boardSpeedSamples.push({ timestampMs, speedKmh });
        distanceKm = integrateBoardSpeedSamples(boardSpeedSamples);
      }
      // No GPS escalation on board motion here: the GPS watch already runs at the
      // idle tier whenever the board is connected (see initAutoTracking's connection
      // subscription), so samples flow and the state machine's board-speed threshold
      // can confirm the auto-start without a separate escalation path.
    },

    /** Folds the board's live odometer (dp12) / battery (dp3) into the rolling latest
     * telemetry, so a checkpoint written while GPS snapshots aren't running still
     * carries the board's most recent values for recovery's end odometer/battery. Also
     * remembers the FIRST values seen — snapshotAt('start') falls back to them when its
     * own query stalled/answered telemetry-less (see firstOdometerKm's comment). */
    onBoardTelemetry(telemetry: { odometerKm: number | null; batteryPct: number | null }): void {
      if (telemetry.odometerKm != null) {
        if (firstOdometerKm == null) firstOdometerKm = telemetry.odometerKm;
        latestOdometerKm = telemetry.odometerKm;
      }
      if (telemetry.batteryPct != null) {
        if (firstBatteryPct == null) firstBatteryPct = telemetry.batteryPct;
        latestBatteryPct = telemetry.batteryPct;
      }
    },

    /** Exactly what pollSnapshotAt did before the extraction, including
     * queryAndReadSnapshot, hasFreshTelemetry, and the retry loop — folding results
     * into modeSamples/voltageSamples/boardSpeedSamples/distanceKm/maxSpeedKmh. */
    async snapshotAt(timestampMs: number, tag: 'start' | 'periodic' | 'end'): Promise<BoardSnapshot | null> {
      const generation = tripGeneration;
      try {
        // Reading straight from the DP cache risks staleness: every mode/voltage sample
        // would only be as fresh as whatever the board last decided to push, not what
        // it's actually reporting right now. Actively query first, then give the
        // response a moment to land (queryDeviceStatus only confirms the *request* was
        // sent -- the real values still arrive asynchronously through the normal
        // onDpUpdate push). Both waits are bounded and best-effort: a hung/failed query,
        // or one whose response doesn't land in time, still falls through to whatever's
        // already cached -- never blocks/fails the snapshot over a query that didn't
        // answer in time.
        //
        // A single query+settle can still read a stale snapshot if the board's response
        // races the settle window. If the snapshot comes back with no fresh telemetry at
        // all, re-query and wait again (bounded by SNAPSHOT_RETRY_ATTEMPTS) before
        // falling through to whatever's cached — a board that's genuinely up but slow to
        // answer gets a second chance instead of a telemetry-less sample.
        let snap = await queryAndReadSnapshot();
        for (let attempt = 0; attempt < SNAPSHOT_RETRY_ATTEMPTS && !hasFreshTelemetry(snap); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_RESPONSE_SETTLE_MS));
          snap = await queryAndReadSnapshot();
        }
        if (generation !== tripGeneration) {
          logEvent('snapshot', `${tag} snapshot dropped: a newer trip started while it was waiting`, {
            captureDelayMs: Date.now() - timestampMs,
          });
          return null;
        }
        if (tag === 'start') {
          // Measured from the trip's own real start (the same timestampMs this call
          // was given), not from when this particular query began (calledAtMs, the
          // original measure here). GPS-tier escalation runs before the 'start'
          // snapshot is even requested (see handleAutoStartEvent), so by the time this
          // function is entered the ride can already be tens of seconds old — a real
          // ride hit a ~54s gap this way, comfortably inside calledAtMs's own view of
          // "fresh" (the query+retry loop itself was fast) while the reading it
          // returned no longer represented the ride's actual start.
          const captureDelayMs = Date.now() - timestampMs;
          if (captureDelayMs > STALE_START_SNAPSHOT_MS) {
            // The board has likely moved by now — an odometer reading this late no
            // longer represents "at start". Leave odometerStartKm/batteryStartPct to
            // whatever seedStartTelemetry (called synchronously at auto_start, before
            // this query was even issued) or the first-seen live-stream fallback below
            // already provided, rather than clobbering either with a stale reading.
            logEvent('snapshot', 'start snapshot arrived too late to trust for distance', { captureDelayMs });
          } else {
            // Only fills a still-null baseline: seedStartTelemetry is the primary
            // source now (see its own doc comment), set synchronously at auto_start
            // before this query was even issued — a snapshot landing after that must
            // never overwrite an already-correct pre-ride reading with a later,
            // already-stale one.
            if (odometerStartKm == null && snap.mileageTotalKm != null) odometerStartKm = snap.mileageTotalKm;
            if (batteryStartPct == null && snap.batteryPct != null) batteryStartPct = snap.batteryPct;
          }
          // First passively-pushed dp12/dp3 beats null: slightly later than the true
          // trip start, but a real board reading from within the ride's first minute.
          if (batteryStartPct == null && firstBatteryPct != null) batteryStartPct = firstBatteryPct;
          if (odometerStartKm == null && firstOdometerKm != null) odometerStartKm = firstOdometerKm;
        }
        // Keep the rolling latest telemetry current from every snapshot regardless of
        // tag — the board's odometer/battery at the most recent read is what recovery
        // should use for end values when the app dies mid-ride.
        if (snap.mileageTotalKm != null) latestOdometerKm = snap.mileageTotalKm;
        if (snap.batteryPct != null) latestBatteryPct = snap.batteryPct;
        if (snap.mode) modeSamples.push({ timestampMs, mode: snap.mode, batteryPct: snap.batteryPct });
        if (snap.voltageV != null) voltageSamples.push({ timestampMs, voltage: snap.voltageV });
        // Board wheel-speed (dp2) time series — the board is the primary speed source for
        // physics (BOARD = telemetry / PHONE = GPS only). Captured on the same snapshot
        // cadence as mode/voltage and uploaded as boardSpeedSamples for the backend's
        // range/efficiency math. The live distanceKm estimate is also board-sourced: it
        // integrates these samples (the authoritative value is the odometer delta at
        // finalize, see computeTripDistanceKm).
        if (snap.speedKmh != null) {
          boardSpeedSamples.push({ timestampMs, speedKmh: snap.speedKmh });
          distanceKm = integrateBoardSpeedSamples(boardSpeedSamples);
        }
        // Max speed: the board's own wheel-based speed sensor (dp2, snap.speedKmh) is far
        // more accurate than GPS for an e-scooter — GPS lags and underreports, which is why
        // the "now" speedometer (board sensor) read 30 while max (GPS-only) was stuck at
        // 27.5. Fold the board's reading into max speed here (the real-time dp2 stream is
        // folded in separately by onBoardSpeed). GPS no longer contributes to max
        // speed at all — a low-accuracy GPS fix once inflated it to an impossible 43.8 km/h.
        if (snap.speedKmh != null) maxSpeedKmh = Math.max(maxSpeedKmh, snap.speedKmh);
        logEvent('snapshot', tag, { batteryPct: snap.batteryPct, voltageV: snap.voltageV, mode: snap.mode, speedKmh: snap.speedKmh });
        return snap;
      } catch (err) {
        // Board offline shouldn't kill GPS recording — trip still saves, minus this data point.
        logEvent('snapshot', `${tag} failed`, { error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },

    /** The exact field set writeCheckpoint needs today. */
    checkpointPayload(): TripRecordPayload {
      return payload();
    },

    /** checkpointPayload()'s field set with the live distanceKm/maxSpeedKmh as they
     * stand right now — matches exactly what finalizeTrip's TripDraft-shaped input
     * needs out of the record (the caller layers tripStartMs/endMs/wasManual/
     * batteryEndPct/odometerEndKm on top, and typically calls computeFinalDistance()
     * first so distanceKm reflects the odometer-delta-authoritative value). */
    collect(): TripRecordPayload {
      return payload();
    },

    /** The live speed shown is the board's dp2 wheel speed, never GPS. Freeze the last
     * real board speed through LIVE_SPEED_GRACE_MS so a transient blip (momentary 0 /
     * dropped sample) doesn't make the speedometer drop to 0. If the board has been
     * silent longer than the grace window, the trip would already have ended on BLE
     * disconnect — report 0. */
    liveSpeedKmh(): number {
      if (Date.now() - lastBoardSpeedAtMs <= LIVE_SPEED_GRACE_MS) {
        return lastBoardSpeedKmh;
      }
      return 0;
    },

    /** Most-frequent mode across the trip's modeSamples, as a display label — mirrors
     * the backend's dominantMode computation (count per mode, highest wins). Used for
     * the finalize-summary notification. */
    dominantModeLabel(): string | null {
      if (modeSamples.length === 0) return null;
      const counts = new Map<string, number>();
      for (const s of modeSamples) counts.set(s.mode, (counts.get(s.mode) ?? 0) + 1);
      let best: string | null = null;
      let bestCount = 0;
      for (const [mode, count] of counts) {
        if (count > bestCount) {
          best = mode;
          bestCount = count;
        }
      }
      return best ? modeLabel(best) : null;
    },

    finalizeStopIfAny,

    /** Thin wrapper over the cadence instance. */
    cadenceTick(timestampMs: number) {
      return cadence.tick(timestampMs);
    },

    /** Wraps computeTripDistanceKm using the record's own odometerStartKm/
     * boardSpeedSamples, updating and returning the record's distanceKm. Authoritative
     * distance is board-sourced: the odometer delta (end − start) when
     * plausible, else boardSpeedSamples-integration. GPS distance integration is never
     * the source. */
    computeFinalDistance(opts: { odometerEndKm: number | null }): number {
      distanceKm = computeTripDistanceKm({
        odometerStartKm,
        odometerEndKm: opts.odometerEndKm,
        boardSpeedSamples,
      });
      return distanceKm;
    },
  };
}
