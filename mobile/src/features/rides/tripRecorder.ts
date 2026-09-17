import * as Location from 'expo-location';
import { AppState } from 'react-native';

import RideCoreNative from '@modules/ride-core/src/RideCore';

import {
  ensureBleConnected,
  getBoardUsability,
  getPairedDeviceId,
  onDevicePaired,
  subscribeBleSession,
  subscribeToBleConnectionTransitions,
} from '@/features/device/deviceLink';
import { speedMsToKmh } from '@/lib/geo';
import { refreshLaunchLocationIfPermitted } from '@/features/rides/launchLocation';
import { flushRemoteLog, logEvent } from '@/lib/log';
import { shouldDiscardTrip, TripStateMachine, type TripEvent, type TripState } from '@/features/rides/tripStateMachine';
import type { RoutePoint } from '@/features/rides/tripTypes';
import { decodeScaled } from '@/features/device/boardValue';
import { api } from '@/lib/api';
import { getBackendIdForLocal, getTripCheckpoint } from '@/lib/db';
import { fetchVitalsForTrip, writeExerciseSessionForTrip } from '@/features/health/healthConnect';
import { finalizeTrip, type FinalizeDeps } from '@/features/rides/tripFinalize';
import { getNativeTripData } from '@/features/rides/rideCoreSync';
import { saveAndSyncTrip } from '@/features/rides/tripSync';
import { notifyTripLifecycle, type TripLifecyclePayload } from '@/features/rides/tripNotifications';
import { captureLastRide } from '@/features/widget/widgetLastRide';

import { computeTripDistanceKm } from '@/features/rides/tripRecorder/boardDistance';
import { clearCheckpoints, fromBackendPayload, writeCheckpoint } from '@/features/rides/tripRecorder/checkpoints';
import { decideGpsTierAction, type GpsTierAction } from '@/features/rides/tripRecorder/gpsTierPolicy';
import { createTripRecord, MIN_STOP_DURATION_SEC, type TripRecord } from '@/features/rides/tripRecorder/tripRecord';
import { createRideHealthTracker, type GpsFixSource } from '@/features/rides/tripRecorder/rideHealth';
import {
  ensureForegroundServiceRunning,
  getBackgroundLocationPermissionStatus,
  getIgnoreBatteryOptimizationsStatus,
  getPowerSaveModeStatus,
  initAutoTracking as initAutoTrackingCore,
  LOCATION_OPTIONS,
  LOCATION_TASK_NAME,
  nativeServiceHoldsLocation,
  openPowerSaveModeSettings,
  releaseForegroundServiceIfRedundant,
  requestBackgroundLocationPermission,
  requestIgnoreBatteryOptimizations,
  restartLocationWatch,
  setLocationWatchTier,
  startLocationWatch as startLocationWatchCore,
  stopLocationWatch,
} from '@/features/rides/tripRecorder/location';
import { CHECKPOINT_INTERVAL_MS } from '@/features/rides/tripRecorder/samplingCadence';

// Re-exported so existing callers keep importing from `@/lib/tripRecorder`.
export {
  getBackgroundLocationPermissionStatus,
  getIgnoreBatteryOptimizationsStatus,
  getPowerSaveModeStatus,
  LOCATION_TASK_NAME,
  openPowerSaveModeSettings,
  requestBackgroundLocationPermission,
  requestIgnoreBatteryOptimizations,
  stopLocationWatch,
};

// tripRecorder has no access to the QueryClient (created in app/_layout.tsx), so
// _layout.tsx subscribes here to invalidate queries the moment a save completes.
const saveListeners = new Set<() => void>();

export function onTripSaved(listener: () => void): () => void {
  saveListeners.add(listener);
  return () => saveListeners.delete(listener);
}

// True for the entire span of finishTrip's async body (set at entry, cleared in a
// finally) -- see recoverInterruptedTrip's own check on this for why it exists: the
// state machine resets to 'idle' synchronously, before finishTrip's async finalize
// even begins, so a plain `state === 'idle'` check (the pre-existing foreground-return
// guard in app/_layout.tsx) cannot distinguish "genuinely idle" from "this exact ride
// just ended and is still being finalized." A real, confirmed production bug: a slow
// end-of-ride board query left that window open long enough for the app's own recovery
// pass to finalize the same ride a second time. Module-level, not a TripRecorder field,
// since recoverInterruptedTrip is a standalone function with no reference to the
// singleton's internals.
let finalizeInFlight = false;

export function isFinalizeInFlight(): boolean {
  return finalizeInFlight;
}

// A recording trip whose GPS samples stop flowing is a dead ride in the making: the
// active-tier watch delivers fixes every ~3s, so a gap this long means the JS
// watchPositionAsync subscription died silently (a documented failure mode — its only
// other self-heal runs on app-foreground return, which never happens while the phone
// rides in a pocket). The periodic-work driver restarts it via the existing
// 'ensure_alive_while_recording' path.
const GPS_STALL_RESTART_MS = 45_000;
// A watch restart re-acquires satellites — retrying on every tick would keep resetting
// acquisition and could make the stall permanent.
const GPS_SELF_HEAL_THROTTLE_MS = 120_000;
// One stalled board snapshot must never suppress the durability checkpoint: the
// snapshot's own bounds are JS timers, which a locked phone pauses, so a stalled start
// snapshot held everything hostage in the wild. Past this deadline the next tick starts
// a fresh run; the stuck one is left to finish into the void.
const PERIODIC_RUN_STUCK_MS = 30_000;
// Same reasoning as PERIODIC_RUN_STUCK_MS, for handleAutoStartEvent's own in-flight
// guard: its bounded snapshotAt('start')/checkpoint() awaits are themselves JS timers,
// which a locked phone pauses — a real ride hit a start snapshot that only actually
// resolved ~28 minutes later, once the app returned to foreground. Until this existed,
// autoStartInFlight stayed stuck true for the rest of the session (only cleared in that
// same call's own `finally`), silently swallowing every subsequent auto_start: the
// pure TripStateMachine still flips its own state to 'riding' regardless (that
// mutation isn't gated on anything here), so the next real ride's board-speed samples
// never reached resetTripAccumulators at all — the record and tripStartMs stayed the
// previous ride's, and the next BLE disconnect finalized a single trip spanning both
// real rides under the first one's stale start time.
const AUTO_START_STUCK_MS = 30_000;

/** The finalizeTrip side-effect deps that don't vary between the live-finish and
 * crash-recovery callers — built once so the two call sites can't quietly drift. */
function buildFinalizeDeps(): FinalizeDeps {
  return {
    fetchVitals: fetchVitalsForTrip,
    writeExerciseSession: writeExerciseSessionForTrip,
    saveAndSync: saveAndSyncTrip,
    clearCheckpoints,
    notifyTripSaved: () => saveListeners.forEach((l) => l()),
    shouldDiscard: shouldDiscardTrip,
  };
}

/** Builds the finalize-summary notification payload from the finalized trip's
 * stored fields (distance, avg/max speed, duration, battery, dominant mode). Shared by
 * the live-finish path (finishTrip) and crash-recovery (recoverInterruptedTrip) so the
 * two can't drift. avgSpeedKmh is derived from distance/duration. Weather is
 * backend-computed after save and is intentionally omitted here — the notification is
 * fired from the recorder before the backend enriches the trip, so it can't know it yet
 * (see TripLifecyclePayload.weatherCodes). */
function buildFinalizeSummaryPayload(args: {
  distanceKm: number;
  durationSec: number;
  maxSpeedKmh: number;
  batteryStartPct: number | null;
  batteryEndPct: number | null;
  dominantMode: string | null;
  endReason?: 'ble_disconnect' | null;
}): TripLifecyclePayload {
  return {
    distanceKm: args.distanceKm,
    avgSpeedKmh: args.durationSec > 0 ? args.distanceKm / (args.durationSec / 3600) : 0,
    maxSpeedKmh: args.maxSpeedKmh,
    durationSec: args.durationSec,
    batteryStartPct: args.batteryStartPct,
    batteryEndPct: args.batteryEndPct,
    dominantMode: args.dominantMode,
    endReason: args.endReason ?? null,
  };
}

export type RecorderSnapshot = {
  state: TripState;
  // True once the current stop (if any) has lasted long enough to be a real stop, not
  // a momentary dip — see MIN_STOP_DURATION_SEC's own doc comment. Debounced UI signal
  // separate from `state === 'stopped'`, which flips instantly on any sub-3km/h blip
  // by design (it also drives GPS-jitter suppression, which needs to react immediately).
  isPausedForDisplay: boolean;
  // Epoch ms the current active trip started (0 while idle). Lets the home-screen widget
  // keep its elapsed clock self-advancing from wall-clock even if the JS process dies
  // mid-ride, mirroring how elapsedSec is derived here.
  tripStartEpochMs: number;
  elapsedSec: number;
  distanceKm: number;
  currentSpeedKmh: number;
  maxSpeedKmh: number;
  batteryStartPct: number | null;
  modesUsed: string[];
  route: RoutePoint[];
  lastSaveResult: 'synced' | 'queued-offline' | null;
  startBlockedReason: 'device-not-connected' | null;
  // Lets the Dashboard warn during a ride, not just after in the debug log.
  powerSaveModeOn: boolean;
};

type Listener = () => void;

/** What finishing a trip actually did — returned by endActive() so a manual "Finish
 * trip" tap can navigate to the saved trip or tell the user it didn't save, instead of
 * the live card just vanishing with no feedback either way. A failed save throws
 * instead (see finishTrip) so callers must handle both the resolved outcomes below and
 * a rejection. */
export type FinishOutcome =
  { outcome: 'saved'; localId: number; synced: boolean } | { outcome: 'discarded'; reason: 'too-short' | 'too-far' };

/** Routes every delivered location sample to the recorder's single ingestion point. */
const handleWatchSample = (loc: Location.LocationObject) => {
  tripRecorder
    .handleLocationSample(loc)
    .catch((err) => logEvent('trip', 'location watch sample handling failed', { error: err instanceof Error ? err.message : String(err) }));
};

/** Starts the foreground location watch (the reliable data path, see tripRecorder/location.ts) and wires samples into the recorder. No-op if already running. */
export function startLocationWatch(): Promise<void> {
  return startLocationWatchCore(handleWatchSample);
}

class TripRecorder {
  private machine = new TripStateMachine();
  private listeners = new Set<Listener>();
  // App-lifetime subscription to the shared BLE session (the recorder is a singleton
  // and this is set up once at startup), so it's never torn down — the boolean just
  // guards against double-subscribing.
  private bleSpeedTrackingStarted = false;
  // The recorder also subscribes once to BLE connection transitions so it can
  // start/stop the idle GPS watch as the board connects/disconnects. Same
  // app-lifetime pattern as bleSpeedTrackingStarted.
  private connectionGatedTrackingStarted = false;

  /** Max speed must be the highest the board's own speedometer (dp2) ever reports —
   * not a GPS-derived number. GPS lags and can spike (a low-accuracy fix can inflate
   * max speed with noise), and trip recording is entirely dependent on the board being
   * connected (an offline board auto-ends the trip), so the board's wheel-based sensor
   * is the only source of truth for speed. This subscribes to the shared BLE session so
   * every dp2 push — the same stream that drives the "now" speedometer — folds into
   * maxSpeedKmh in real time, rather than only catching dp2 on the 20s snapshot poll.
   * Idempotent; called once from initAutoTracking at app startup — but nothing is
   * necessarily paired yet at that point (a fresh install, or any launch before the
   * first pairing), so the initial attempt can find no devId to subscribe to.
   * onDevicePaired re-runs the attempt whenever a device becomes paired, closing that
   * gap without needing a devId at call time. */
  startBleSpeedTracking = () => {
    if (this.bleSpeedTrackingStarted) return;
    const attempt = () => {
      if (this.bleSpeedTrackingStarted) return;
      getPairedDeviceId().then((devId) => {
        if (!devId || this.bleSpeedTrackingStarted) return;
        this.bleSpeedTrackingStarted = true;
        subscribeBleSession(devId, (s) => {
          // Board push cadence — feeds the ride-health summary's dpPushCount/maxDpGapMs.
          // The liveness-ping interval decision this used to also feed lives natively now
          // (BoardBleClient's own dp2-based riding/idle heuristic), closer to where the
          // decision is actually made.
          if (s.dps) this.rideHealth.recordDpPush();
          // The board's rolling odometer (dp12) and battery (dp3) ride the same live dp
          // stream as speed — fold them into the record's latestOdometerKm/latestBatteryPct
          // so a checkpoint written while GPS is dead still carries the board's most recent
          // values (see TripRecord.onBoardTelemetry). dp12 is decodeScaled like the
          // snapshot's mileageTotalKm; dp3 is a raw percentage.
          const rawOdometer = s.dps?.['12'];
          const rawBattery = s.dps?.['3'];
          if (rawOdometer != null || rawBattery != null) {
            const odometerKm = rawOdometer != null ? decodeScaled(Number(rawOdometer), 1) : null;
            const batteryPct = rawBattery != null ? Number(rawBattery) : null;
            if ((odometerKm == null || Number.isFinite(odometerKm)) && (batteryPct == null || Number.isFinite(batteryPct))) {
              this.record.onBoardTelemetry({ odometerKm, batteryPct });
            }
          }
          const raw = s.dps?.['2'];
          if (raw == null) return;
          const speedKmh = decodeScaled(Number(raw), 1);
          if (!Number.isFinite(speedKmh)) return;
          // Folds into the record's boardSpeedKmh/maxSpeedKmh/lastBoardSpeedKmh/At — see
          // TripRecord.onBoardSpeed for the field-level comments.
          this.record.onBoardSpeed(speedKmh, Date.now());
          // Auto-start must fire the moment the board's wheel speed (dp2) clears the
          // threshold, driven directly from the board connection — not gated behind GPS
          // location samples flowing. Feeding the machine here, on the same dp2 stream
          // that drives the "now" speedometer, decouples the start decision from GPS
          // entirely: a board connected and moving >10 km/h whose GPS watch isn't
          // delivering samples (permission, a board that never confirmed usable,
          // background throttling) still auto-starts. GPS still supplies the route once
          // recording; it just no longer gates the start. handleLocationSample still
          // feeds the machine too (for the
          // riding/stopped route-freeze distinction and the BLE-disconnect auto-end while
          // recording) — feeding from both is safe: the machine only ever emits one
          // auto_start (it transitions to 'riding' on the first), and autoStartInFlight
          // guards the async reaction against re-entry.
          this.feedBoardSpeedToMachine(speedKmh);
          // Event-driven periodic work (checkpoints/snapshots/disconnect watchdog/GPS
          // self-heal) — the dp2 stream is the heartbeat that survives a locked phone,
          // where this class's own 1s interval is paused with the rest of the JS timers.
          this.drivePeriodicWorkFromEvents();
        });
      });
    };
    attempt();
    // Re-attempts every time a device becomes paired — the pre-fix version only ever
    // ran this once, at app startup, so a device paired later in the same process never
    // got a subscription at all.
    onDevicePaired(attempt);
  };

  /** Single choke point for "the machine emitted auto_end — finalize the ride" from the
   * fire-and-forget triggers (BLE transition, board-speed stream, event/timer watchdog).
   * handleLocationSample deliberately awaits its own finalize instead, so a sample that
   * ends the trip saves before the sample's own processing resolves. The machine has
   * already reset to idle by the time this runs, so re-entry can't double-finalize; the
   * only variation between triggers is the failure log's source tag. */
  private finalizeAutoEnd(event: Extract<TripEvent, { type: 'auto_end' }>, timestampMs: number, wasManual: boolean, source: string) {
    this.handleAutoEndEvent(event, timestampMs, wasManual).catch((err) =>
      logEvent('trip', `auto_end (${source}) handling failed`, { error: err instanceof Error ? err.message : String(err) }),
    );
  }

  /** Feeds the state machine a board wheel-speed (dp2) sample directly from the BLE
   * session subscription — the same stream that drives the "now" speedometer. Auto-start
   * must fire the moment the board clears the speed threshold, driven from the board
   * connection itself, NOT gated behind GPS location samples flowing (see
   * startBleSpeedTracking's comment for the full rationale). The BLE session callback is
   * synchronous, so the async auto-start reaction is fire-and-forget; autoStartInFlight
   * guards it against re-entry. */
  private feedBoardSpeedToMachine(speedKmh: number) {
    const now = Date.now();
    // Captured before onSample — an auto_end resets the machine to idle, which would
    // erase the manual-ness the finalize path needs.
    const wasManual = this.machine.getState() === 'manual';
    const event = this.machine.onSample(speedKmh, now, getBoardUsability() === 'offline');
    const autoStartStuck = this.autoStartInFlight && now - this.autoStartInFlightSinceMs >= AUTO_START_STUCK_MS;
    if (event?.type === 'auto_start' && (!this.autoStartInFlight || autoStartStuck)) {
      if (autoStartStuck) {
        logEvent('trip', 'auto_start: previous handleAutoStartEvent never completed — proceeding anyway', {
          stuckForMs: now - this.autoStartInFlightSinceMs,
        });
      }
      this.handleAutoStartEvent(now).catch((err) =>
        logEvent('trip', 'auto_start (board speed) handling failed', { error: err instanceof Error ? err.message : String(err) }),
      );
    } else if (event?.type === 'auto_end') {
      // The machine just decided the ride is over (the board flipped offline mid-ride
      // while dp2 pushes were still landing). Dropping this event — as this path used
      // to — reset the machine to idle with NO finalize: the recording silently died,
      // nothing saved, and the trip only reappeared via crash recovery at the next app
      // start. Same finalize the GPS-sample path already runs.
      this.finalizeAutoEnd(event, now, wasManual, 'board-speed');
    }
  }

  /** Reacts to a TripStateMachine `auto_start` event — the shared handler for both the
   * GPS-sample path (handleLocationSample) and the board-speed path
   * (feedBoardSpeedToMachine). Returns true when the trip actually started, false when
   * it was blocked (board not usable) — the caller returns early on false so it doesn't
   * keep processing the sample as if a trip were recording. */
  private async handleAutoStartEvent(timestampMs: number, gps?: { lat: number; lon: number }): Promise<boolean> {
    if (getBoardUsability() !== 'usable') {
      this.startBlockedReason = 'device-not-connected';
      logEvent('trip', 'auto_start blocked: device not connected', {
        speedKmh: this.record.boardSpeedKmh,
        lat: gps?.lat,
        lon: gps?.lon,
      });
      // The board reported wheel speed but isn't actually usable (e.g. it dropped
      // offline mid-sustain-window), so there's no board to ride — stop the watch and
      // cancel the auto-start sustain window. The next board_connected transition
      // restarts the idle watch. See gpsTierPolicy.ts.
      // Awaited, not fire-and-forget: this function's own contract (see the docstring
      // above) is that it stays genuinely async end-to-end, since the calling
      // TaskManager task reports "done" to Android the moment this returns and Android
      // can suspend the process right after.
      await this.applyGpsTierAction(decideGpsTierAction({ event: 'auto_start_blocked' }), 'auto_start_blocked');
      this.emit();
      return false;
    }
    logEvent('trip', 'auto_start', { speedKmh: this.record.boardSpeedKmh, lat: gps?.lat, lon: gps?.lon });
    // Battery Saver can throttle location delivery even though the trip "starts" fine — log it so an empty trip isn't a mystery.
    if (getPowerSaveModeStatus()) {
      logEvent('trip', 'power save mode is ON at trip start — location updates may be throttled or blocked');
    }
    this.startBlockedReason = null;
    // A ride auto-started — if the phone is in the user's pocket (backgrounded), tell
    // them. Fire-and-forget; gated on background inside.
    notifyTripLifecycle('auto-start').catch(() => {});
    this.autoStartInFlight = true;
    this.autoStartInFlightSinceMs = timestampMs;
    // Only the newest call owns the flag — matches periodicRunGeneration's own
    // reasoning: if this exact call is the one that was stuck long enough to let a
    // newer auto_start proceed anyway, this call finally completing afterward must not
    // clear the newer one's own in-flight window.
    const generation = ++this.autoStartGeneration;
    // Captured synchronously, before resetTripAccumulators (which wipes these to null
    // via record.begin()) and before the GPS-tier escalation await below, which can
    // itself run for a noticeable moment — see tripRecord.ts's seedStartTelemetry for
    // why this exact ordering matters: a real ride lost its correct pre-ride
    // odometer/battery reading to exactly this gap, ending up with a start baseline
    // captured ~54s into the ride instead of before it.
    const preStartOdometerKm = this.record.latestOdometerKm;
    const preStartBatteryPct = this.record.latestBatteryPct;
    try {
      // A trip is genuinely starting — upgrade GPS to full accuracy and stop the idle
      // poll loop (its job is over until the trip ends). See gpsTierPolicy.ts.
      await this.applyGpsTierAction(decideGpsTierAction({ event: 'trip_starting' }), 'auto_start');
      this.resetTripAccumulators(timestampMs);
      this.record.seedStartTelemetry({ odometerKm: preStartOdometerKm, batteryPct: preStartBatteryPct });
      // Push the new 'riding' state out to subscribers NOW, before the slow snapshot/
      // checkpoint work below. The GPS-sample path (handleLocationSample) emits on every
      // sample, so it never notices a delay here; but the board-speed path
      // (feedBoardSpeedToMachine) has no such trailing emit — if we only emitted after
      // the full async chain (which awaits a real board snapshot query, ~500ms+), an
      // auto-start driven purely by the BLE dp2 stream would leave the snapshot (and
      // therefore the LiveTripModule UI) stuck on 'idle' until that chain finished. The
      // user's requirement is that the recording module appears the moment the board is
      // connected and moving >10 km/h — so surface 'riding' immediately.
      this.emit();
      await this.record.snapshotAt(timestampMs, 'start');
      await this.checkpoint();
    } catch (err) {
      throw err;
    } finally {
      if (this.autoStartGeneration === generation) this.autoStartInFlight = false;
    }
    // Re-emit once the start snapshot/checkpoint have landed, so the UI reflects the
    // freshly-captured battery/odometer/speed fields rather than the pre-snapshot state.
    this.emit();
    return true;
  }

  /** Called from initAutoTracking's BLE connection transition subscription. Starts the
   * low-power idle GPS watch the moment the board confirms connected, and stops it when
   * the board disconnects — but only while idle. During a trip the watch must stay up
   * so handleLocationSample keeps driving the state machine, and a BLE disconnect is the
   * trip's only "this ride is over" signal — so while a trip is active a disconnect is
   * fed straight into the state machine (deviceOffline=true) to fire auto_end and
   * finalize the trip even when no GPS samples are flowing (background throttling, a
   * board that dropped mid-ride). Idempotent; safe to call on re-init. */
  handleBleConnectionTransition = (event: { type: 'connected' | 'disconnected' }) => {
    // Disconnect count + reconnect latency, for the ride-health summary — tracked
    // regardless of trip state (reset() at trip start zeroes it out for a ride that
    // starts mid-backoff), since a reconnect that happens to land while idle still
    // closes out a disconnect that may have started during the ride just ended.
    if (event.type === 'disconnected') this.rideHealth.recordDisconnect();
    else this.rideHealth.recordReconnect();
    // Live machine state, not the cached snapshot: emit() only runs while ticks/samples
    // flow, and both can be dead (paused background timers, a silently-dropped GPS
    // watch) by the time the disconnect arrives — a stale cached 'idle' here would
    // skip the auto-end entirely and strand the trip until crash recovery.
    const state = this.machine.getState();
    if (event.type === 'disconnected' && state !== 'idle') {
      // The board is gone mid-ride. Feed the machine an offline sample so it fires
      // auto_end (ble_disconnect) and the trip finalizes now — otherwise, with GPS
      // throttled in the background, nothing would ever end it. Fire-and-forget; the
      // async finalize is guarded against re-entry by the machine already being reset
      // to idle on the first auto_end.
      const endEvent = this.machine.onSample(0, Date.now(), true);
      if (endEvent?.type === 'auto_end') {
        this.finalizeAutoEnd(endEvent, Date.now(), state === 'manual', 'ble-transition');
      }
      return;
    }
    if (state !== 'idle') return;
    if (event.type === 'connected') {
      this.applyGpsTierAction(decideGpsTierAction({ event: 'board_connected' }), 'board_connected');
      // A board connecting means a trip is likely about to start — take a fresh
      // one-shot GPS fix now, in the background, instead of leaving LiveTripModule's
      // fallback position (see launchLocation.ts) sitting on whatever was cached at
      // app launch, possibly many minutes stale by the time the ride actually starts.
      // Cheap (one Balanced-accuracy fix, same cost as the existing app-launch one)
      // and this already flows straight to the live map: LiveTripModule subscribes to
      // this same cache. The "IfPermitted" variant never calls
      // requestForegroundPermissionsAsync itself — a connection event can fire while
      // the phone is locked/backgrounded with no foreground activity to safely show a
      // permission prompt against, so this only ever refreshes if permission is
      // already granted, silently no-op'ing otherwise. Fire-and-forget; a failure here
      // just leaves the existing cached fix in place, same as today.
      void refreshLaunchLocationIfPermitted();
    } else if (event.type === 'disconnected') {
      this.applyGpsTierAction(decideGpsTierAction({ event: 'board_disconnected' }), 'board_disconnected');
    }
  };

  /** Subscribes once to BLE connection transitions so the recorder can start/stop the
   * idle GPS watch as the board connects/disconnects. Same app-lifetime pattern as
   * startBleSpeedTracking — the recorder is a singleton and this is set up once at
   * startup, so it's never torn down; the boolean just guards against
   * double-subscribing. Idempotent; safe to call on re-init. */
  startConnectionGatedTracking = () => {
    if (this.connectionGatedTrackingStarted) return;
    this.connectionGatedTrackingStarted = true;
    subscribeToBleConnectionTransitions((event) => {
      // handleBleConnectionTransition gates on idle internally — during a trip the
      // watch must stay up so handleLocationSample keeps driving the state machine
      // (incl. BLE-disconnect auto-end), so the disconnect branch is a no-op then.
      this.handleBleConnectionTransition(event);
    });
    // The native SDK's autoConnect can bring the board online before this function ever
    // runs: it's wired up behind recoverInterruptedTrip() + getAutoTrackingEnabled()
    // resolving in app/_layout.tsx's startup effect, both async. If the board finished
    // connecting in that window, the idle GPS watch would never start, no location
    // samples would ever flow, and the board's wheel speed (dp2) would never get a
    // chance to drive auto-start since handleLocationSample (the only place that calls
    // machine.onSample) is never invoked.
    // Primary coverage is now structural: subscribeToBleConnectionTransitions replays the
    // last transition to a late subscriber (see connectionEvents.ts), so the subscribe
    // above fires this handler immediately with a 'connected' event if the board already
    // connected before this call. The getBoardUsability() check below is kept as harmless
    // belt-and-suspenders for the edge where no transition was ever recorded (lastTransition
    // null) yet the board is already usable.
    if (getBoardUsability() === 'usable') {
      this.handleBleConnectionTransition({ type: 'connected' });
    }
  };

  private tripStartMs = 0;
  // Owns route/stops/modeSamples/voltageSamples/boardSpeedSamples/distanceKm/
  // maxSpeedKmh/boardSpeedKmh/lastBoardSpeedKmh/lastBoardSpeedAtMs/batteryStartPct/
  // odometerStartKm/pendingStop/cadence — everything the trip's data so far consists
  // of. Deliberately one long-lived instance, not recreated per trip:
  // resetTripAccumulators calls record.begin(startMs), which resets everything except
  // boardSpeedKmh/lastBoardSpeedKmh/lastBoardSpeedAtMs — those are BLE-subscription-driven
  // (see startBleSpeedTracking) and must keep rolling across trip boundaries. Recreating
  // the instance per trip would reset those three too, causing a live-speed-reads-0
  // flicker at trip start.
  private record: TripRecord = createTripRecord();
  // Per-ride health bookkeeping (GPS fix counts/gaps, dp push cadence, disconnect
  // count + reconnect latency, app-state transitions) — logged as one 'ride-health'
  // line at finalize. See rideHealth.ts's own doc comment.
  private rideHealth = createRideHealthTracker();
  private lastSaveResult: RecorderSnapshot['lastSaveResult'] = null;
  private startBlockedReason: RecorderSnapshot['startBlockedReason'] = null;
  // Set by handleAutoEndEvent right before calling finishTrip when the board's
  // disconnect is what ended the ride; read and cleared by finishTrip itself, so it
  // never leaks into a later manual finish/end.
  private pendingEndReason: 'ble_disconnect' | null = null;
  private manualStartPromise: Promise<boolean> | null = null;
  private autoStartInFlight = false;
  // Wall-clock start of the current autoStartInFlight window — see
  // AUTO_START_STUCK_MS's own comment for why this exists.
  private autoStartInFlightSinceMs = 0;
  // Guards handleAutoStartEvent's own `finally` the same way periodicRunGeneration
  // guards periodicTick's — a stuck call finally completing must not clear a newer
  // call's own in-flight window out from under it.
  private autoStartGeneration = 0;
  // True from resetTripAccumulators (record.begin) until finishTrip. checkpoint() and
  // the event-driven driver gate on this: between the machine's synchronous riding
  // transition and the start path's awaited GPS-tier escalation, the record still holds
  // the PREVIOUS trip's accumulators — a checkpoint written in that window saves stale
  // data under the previous trip's start time, which recovery would resurrect as a
  // duplicate ride.
  private tripBegun = false;
  // Logs the first sample after start so a dead background task is visible within seconds, not after a full empty ride.
  private loggedFirstSampleForTrip = false;
  // Independent 1s tick keeps elapsedSec live even if samples stop arriving, and (since
  // the snapshot/checkpoint cadence is driven from this timer, not GPS samples) keeps
  // lastUpdateMs fresh and boardSpeedSamples accumulating even when GPS is dead — the
  // board's BLE stream keeps the JS runtime alive so this timer keeps firing.
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  // Guards periodicTick's async snapshot/checkpoint work so a slow snapshot can't
  // overlap the next 1s tick (the cadence is driven from this timer now, so without the
  // guard a slow board query could stack up behind every tick).
  private periodicRunInFlight = false;
  // Wall clock when the in-flight run started — the in-flight flag is only meaningful
  // with a deadline (see PERIODIC_RUN_STUCK_MS).
  private periodicRunStartedAtMs = 0;
  private periodicRunGeneration = 0;
  // Receive time (Date.now(), not the GPS clock) of the last GPS sample — drives the
  // GPS-stall watchdog. Anchored at trip start so a cold-starting watch doesn't trip it.
  private lastLocationSampleAtMs = 0;
  private lastGpsSelfHealAtMs = 0;
  private lastEventDrivenTickAtMs = 0;
  private lastEventDrivenCheckpointAtMs = 0;
  // Fires the power-save-warning notification at most once per ride — see
  // drivePeriodicWorkFromEvents. Reset at trip start (resetTripAccumulators) so a new
  // ride gets its own chance to warn, even if the rider turned Battery Saver off and
  // back on between rides.
  private powerSaveWarningNotifiedThisTrip = false;

  private snapshot: RecorderSnapshot = {
    state: 'idle',
    isPausedForDisplay: false,
    tripStartEpochMs: 0,
    elapsedSec: 0,
    distanceKm: 0,
    currentSpeedKmh: 0,
    maxSpeedKmh: 0,
    batteryStartPct: null,
    modesUsed: [],
    route: [],
    lastSaveResult: null,
    startBlockedReason: null,
    powerSaveModeOn: false,
  };

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RecorderSnapshot => this.snapshot;

  /**
   * True while a trip is being recorded (riding, stopped, or manual) — i.e. any state
   * other than idle. Lets other modules (e.g. bleStatusRefresh's foreground poll) ask
   * "is the trip recorder currently the owner of board refresh?" without reaching into
   * the snapshot's raw state string.
   */
  isTripActive = (): boolean => this.machine.getState() !== 'idle';

  /** App-foreground/background transition during a ride — one line item in the
   * ride-health summary. Fed by a module-scope AppState listener below (tripRecorder
   * is a plain singleton, not a component, so it can't use the useIsAppActive hook). */
  noteAppStateTransition = (): void => {
    this.rideHealth.recordAppStateTransition();
  };

  /** Fires the finalize-summary notification from the finalized trip's stored
   * fields (distance, avg/max speed, duration, battery, dominant mode). Gated on the
   * app being backgrounded inside notifyTripLifecycle. Fire-and-forget — a
   * notification must never block or fail the save path. */
  private notifyFinalizeSummary(
    distanceKm: number,
    durationSec: number,
    batteryEndPct: number | null,
    endReason: 'ble_disconnect' | null = null,
  ) {
    notifyTripLifecycle(
      'finalize-summary',
      buildFinalizeSummaryPayload({
        distanceKm,
        durationSec,
        maxSpeedKmh: this.record.maxSpeedKmh,
        batteryStartPct: this.record.batteryStartPct,
        batteryEndPct,
        dominantMode: this.record.dominantModeLabel(),
        endReason,
      }),
    ).catch(() => {});
  }

  private emit() {
    const pendingStop = this.record.pendingStop;
    this.snapshot = {
      state: this.machine.getState(),
      isPausedForDisplay: pendingStop != null && (Date.now() - pendingStop.startTimestampMs) / 1000 >= MIN_STOP_DURATION_SEC,
      tripStartEpochMs: this.tripStartMs,
      elapsedSec: this.tripStartMs ? Math.floor((Date.now() - this.tripStartMs) / 1000) : 0,
      distanceKm: this.record.distanceKm,
      currentSpeedKmh: this.record.liveSpeedKmh(),
      maxSpeedKmh: this.record.maxSpeedKmh,
      batteryStartPct: this.record.batteryStartPct,
      modesUsed: Array.from(new Set(this.record.modeSamples.map((s) => s.mode))),
      route: this.record.route,
      lastSaveResult: this.lastSaveResult,
      startBlockedReason: this.startBlockedReason,
      powerSaveModeOn: getPowerSaveModeStatus(),
    };
    // Same contract as lib/listenable.ts's notify: one throwing subscriber (React
    // store callbacks, widget sync) must not strand the rest — later listeners would
    // silently stop seeing this emit and every future one.
    this.listeners.forEach((l) => {
      try {
        l();
      } catch (err) {
        logEvent('trip', 'emit listener threw', { error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  private startTicking() {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => this.periodicTick(), 1000);
  }

  private stopTicking() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  /** Fired every 1s while a trip is active (the interval) AND from the BLE dp2 / GPS
   * sample event streams (drivePeriodicWorkFromEvents). Emits (keeps elapsedSec live),
   * runs the disconnect watchdog + GPS self-heal + event-driven durability checkpoint,
   * then drives the board-snapshot cadence. Driving all of it from the event streams,
   * not just this timer, is load-bearing: Android pauses JS timers while the app is
   * locked whenever no headless task is executing, and a stalled start snapshot (whose
   * bounds are those same timers) plus a silently-dead GPS watch once stopped every
   * checkpoint/snapshot for the rest of a real ride — while the board's dp2 stream
   * (pure native callbacks, no timers) kept flowing. The snapshot run itself is guarded
   * by periodicRunInFlight with a staleness deadline so a hung snapshot can't suppress
   * later runs forever. */
  private periodicTick() {
    this.emit();
    // Watchdogs + event-driven durability checkpoint — shared verbatim with the BLE/GPS
    // event streams (the 1s interval always passes the driver's 1s throttle).
    this.drivePeriodicWorkFromEvents();
    const now = Date.now();
    if (this.machine.getState() === 'idle') return;
    if (this.periodicRunInFlight && now - this.periodicRunStartedAtMs < PERIODIC_RUN_STUCK_MS) return;
    const { snapshotDue, checkpointDue } = this.record.cadenceTick(now);
    if (!snapshotDue && !checkpointDue) return;
    this.periodicRunInFlight = true;
    this.periodicRunStartedAtMs = now;
    const runGeneration = ++this.periodicRunGeneration;
    (async () => {
      try {
        if (checkpointDue) {
          // Durability first, deliberately: the checkpoint is a local SQLite write and
          // the one thing that bounds ride loss on a process kill, while the snapshot
          // is a BLE round trip that can stall for minutes. Writing it after the
          // snapshot meant one stalled query also froze every checkpoint for the rest
          // of the ride.
          await this.checkpoint();
        }
        if (snapshotDue) {
          // Piggyback reconnect attempts here since BleReconnectGate only fires on
          // app-foreground, which never happens while backgrounded for a ride.
          ensureBleConnected();
          await this.record.snapshotAt(now, 'periodic');
        }
      } catch (err) {
        logEvent('trip', 'periodic tick failed', { error: err instanceof Error ? err.message : String(err) });
      } finally {
        // Only the newest run owns the flag — a stale run finally-completing after the
        // deadline let a new run start must not clear the new run's guard.
        if (this.periodicRunGeneration === runGeneration) this.periodicRunInFlight = false;
      }
    })();
  }

  /** Event-driven survival work for the frozen-timer state: Android pauses JS timers
   * while the app is locked whenever no headless task is executing, but the BLE dp2
   * stream and GPS samples keep arriving — so this (throttled to 1s) is the heartbeat a
   * backgrounded ride can still rely on. Deliberately does NOT poll board snapshots:
   * a snapshot's own settle/retry bounds are those same paused timers, and snapshots
   * are telemetry enrichment, not durability — the 1s interval resumes that job the
   * moment timers run again. What must survive here: the BLE-disconnect watchdog
   * (end + save when the board drops), the GPS-stall self-heal (keep route points
   * flowing), and the durability checkpoint (bounds ride loss on a process kill). */
  private drivePeriodicWorkFromEvents() {
    const now = Date.now();
    if (now - this.lastEventDrivenTickAtMs < 1000) return;
    this.lastEventDrivenTickAtMs = now;
    // Fenced like checkpoint(): in the auto-start window the record still holds the
    // previous trip's data, so neither the watchdog nor the checkpoint may act on it.
    if (!this.tripBegun || this.machine.getState() === 'idle') return;

    // Same disconnect watchdog the timer tick runs — see periodicTick.
    if (getBoardUsability() === 'offline') {
      const wasManual = this.machine.getState() === 'manual';
      const endEvent = this.machine.onSample(0, now, true);
      if (endEvent?.type === 'auto_end') {
        this.finalizeAutoEnd(endEvent, now, wasManual, 'event-watchdog');
      }
      return;
    }

    // Same GPS-stall self-heal the timer tick runs — see periodicTick.
    if (now - this.lastLocationSampleAtMs >= GPS_STALL_RESTART_MS && now - this.lastGpsSelfHealAtMs >= GPS_SELF_HEAL_THROTTLE_MS) {
      this.lastGpsSelfHealAtMs = now;
      logEvent('trip', 'no GPS samples while recording — restarting the watch', { staleForMs: now - this.lastLocationSampleAtMs });
      void this.applyGpsTierAction(decideGpsTierAction({ event: 'ensure_alive_while_recording' }), 'gps-stall-self-heal').catch(() => {});
    }

    // Battery Saver's location cutoff has no app-level exemption (see
    // getPowerSaveModeStatus's own doc) — this only used to be checked once, at trip
    // start, so a rider whose phone entered Battery Saver mid-ride (or whose ride
    // auto-started before it turned on) got no warning at all, foregrounded or not. This
    // runs on the same ≤1s heartbeat as the watchdogs above, so it catches it turning on
    // at any point during a locked-phone ride, not just at the start. Once per ride:
    // repeating it every second for the rest of the ride would just be noise once the
    // rider has already been told. The dashboard's own pill (index.tsx) already covers
    // the foregrounded case live; this is what closes the gap for a backgrounded one.
    if (!this.powerSaveWarningNotifiedThisTrip && getPowerSaveModeStatus()) {
      this.powerSaveWarningNotifiedThisTrip = true;
      notifyTripLifecycle('power-save-warning').catch(() => {});
    }

    // Durability checkpoint on the same 60s floor as the cadence's own (independent
    // throttle, so a stalled snapshot in the timer path can never hold this one off).
    // Fire-and-forget with no in-flight guard: writeCheckpoint is an idempotent
    // single-row upsert, and an occasional overlap is cheaper than a lock.
    if (now - this.lastEventDrivenCheckpointAtMs >= CHECKPOINT_INTERVAL_MS) {
      this.lastEventDrivenCheckpointAtMs = now;
      this.checkpoint().catch((err) =>
        logEvent('trip', 'event-driven checkpoint failed', { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  private resetTripAccumulators(startMs: number) {
    this.tripStartMs = startMs;
    this.startTicking();
    // The record is now genuinely begun — checkpoint() and the event-driven driver
    // fence on this (see tripBegun's comment).
    this.tripBegun = true;
    // Anchors the GPS-stall watchdog to the trip's own start so a cold-starting watch
    // (no fix yet) doesn't trip it the moment recording begins.
    this.lastLocationSampleAtMs = startMs;
    // begin() resets the record's per-trip accumulators (route/stops/samples/distance/
    // max speed/cadence/pendingStop) in place — deliberately NOT a fresh
    // createTripRecord() instance here, since boardSpeedKmh/lastBoardSpeedKmh/
    // lastBoardSpeedAtMs must keep rolling across trip boundaries unchanged (see
    // TripRecord.begin's doc comment).
    this.record.begin(startMs);
    this.loggedFirstSampleForTrip = false;
    this.rideHealth.reset();
    this.powerSaveWarningNotifiedThisTrip = false;
    // Belt-and-suspenders: a new trip means any prior checkpoint is already stale.
    clearCheckpoints();
  }

  // Real, confirmed-in-production bug: every call site awaits a board snapshot
  // (record.snapshotAt) immediately before calling this — a snapshot that can stall
  // for minutes on a flaky BLE connection (see tripRecord.ts's SNAPSHOT_READ_TIMEOUT_MS
  // comment). Accepting the pre-stall timestamp as lastUpdateMs meant a checkpoint
  // written right after a stalled *start* snapshot recorded lastUpdateMs equal to
  // tripStartMs — an implied duration of exactly 0 — even though the ride had already
  // been running (and accumulating real GPS points) the whole time the snapshot was
  // stuck. If the app then died before a later checkpoint could overwrite that one
  // (plausible mid-ride, backgrounded, exactly when BLE is struggling), recovery read
  // the corrupted checkpoint and discarded a real ride as "too short" regardless of
  // its actual distance/points — confirmed directly against production logs: a real
  // ~7.5-minute, 2.21km, 110-point ride discarded with durationSec: 0. lastUpdateMs
  // must always be when this checkpoint is actually being written, never a timestamp
  // captured before whatever async work preceded the call.
  private async checkpoint() {
    // Fence against the auto-start window described on tripBegun — the timer tick and
    // the BLE/GPS event driver can both land there, and a stale checkpoint is worse
    // than none (recovery resurrects it as a duplicate ride).
    if (!this.tripBegun) return;
    const wasManual = this.machine.getState() === 'manual';
    await writeCheckpoint({
      tripStartMs: this.tripStartMs,
      wasManual,
      ...this.record.checkpointPayload(),
      lastUpdateMs: Date.now(),
    });
  }

  /** Executes a gpsTierPolicy decision — the ONLY place that calls
   * setLocationWatchTier/startLocationWatchCore/stopLocationWatch/cancelAutoStart in
   * response to a policy decision. `context` is purely for the error
   * log tag on a failed watch-tier change, so a failure is still traceable to which of
   * the policy's trigger events caused it. Returns a promise so call sites that need the
   * watch-tier change to land before proceeding (e.g. before resetting trip accumulators)
   * can await it, matching the pre-extraction call sites' own await/fire-and-forget split
   * exactly — the watch mutation itself is unchanged, only which function issues it. */
  private async applyGpsTierAction(action: GpsTierAction, context: string): Promise<void> {
    switch (action.watch.kind) {
      case 'set':
        try {
          // setLocationWatchTier() alone silently no-ops if watchOnSample was never
          // wired (location.ts's subscribeWatch: `if (!watchOnSample) return;`) —
          // reachable in a real, supported configuration (Settings > Auto-tracking off,
          // then a manual Start Trip tap), since watchOnSample is otherwise only set by
          // initAutoTracking() at app startup, which is itself gated on that same
          // toggle. startLocationWatchCore always wires watchOnSample and is a no-op on
          // an already-running subscription, so calling it first guarantees the
          // tier-switch below actually has something to switch.
          await startLocationWatchCore(handleWatchSample, action.watch.tier);
          await setLocationWatchTier(action.watch.tier);
        } catch (err) {
          logEvent('trip', `${context}: GPS tier change failed`, { error: err instanceof Error ? err.message : String(err) });
        }
        break;
      case 'start-if-idle':
        try {
          await startLocationWatchCore(handleWatchSample, action.watch.tier);
        } catch (err) {
          logEvent('trip', `${context}: GPS watch start failed`, { error: err instanceof Error ? err.message : String(err) });
        }
        break;
      case 'restart':
        try {
          await restartLocationWatch(handleWatchSample, action.watch.tier);
        } catch (err) {
          logEvent('trip', `${context}: GPS watch restart failed`, { error: err instanceof Error ? err.message : String(err) });
        }
        break;
      case 'stop':
        stopLocationWatch();
        break;
      case 'none':
        break;
    }
    if (action.cancelAutoStart) this.machine.cancelAutoStart();
  }

  /** Must stay genuinely async/awaited end-to-end: the calling TaskManager task
   * (locationTask.ts) reports "done" to Android the moment this returns, and Android
   * can suspend the process right after — fire-and-forget calls here used to get cut
   * off mid-flight (no mode samples, lost trip saves). */
  handleLocationSample = async (loc: Location.LocationObject, source: GpsFixSource = 'watch') => {
    const { latitude, longitude, speed, accuracy: accuracyM } = loc.coords;
    const timestampMs = loc.timestamp;
    const speedKmh = speedMsToKmh(speed);
    const prevState = this.machine.getState();

    if (!this.loggedFirstSampleForTrip) {
      this.loggedFirstSampleForTrip = true;
      logEvent('trip', 'first location sample since start', { speedKmh, accuracyM, state: prevState });
    }
    // Receive wall-clock, not the GPS clock — this anchors the GPS-stall watchdog.
    this.lastLocationSampleAtMs = Date.now();
    this.rideHealth.recordGpsFix(source, this.lastLocationSampleAtMs);

    // The board's wheel speed (dp2) is the sole driver of the idle -> auto_start
    // transition, fed directly from the BLE session subscription
    // (feedBoardSpeedToMachine) — not from GPS samples. So while idle we deliberately
    // do NOT feed the machine here: doing so would (a) re-gate auto-start behind GPS
    // samples flowing and (b) mix two independent clocks into the machine's single
    // sustain-window clock (BLE stamps Date.now(), GPS stamps loc.timestamp — a GPS
    // timestamp that lags the BLE anchor would reset the 3s sustain window and hold a
    // real start back).
    //
    // GPS samples only feed the machine once a trip is already recording (state != idle),
    // for the riding/stopped route-freeze distinction and the BLE-disconnect auto-end.
    // The speed fed is still the board's (this.record.boardSpeedKmh, kept current by
    // startBleSpeedTracking via record.onBoardSpeed). The route point below keeps the
    // raw GPS speed and its accuracy, so a consumer can judge the fix for itself.
    const state = this.machine.getState();
    let event: TripEvent | null = null;
    if (state !== 'idle') {
      event = this.machine.onSample(this.record.boardSpeedKmh, timestampMs, getBoardUsability() === 'offline');
    }

    if (event?.type === 'auto_start') {
      // Shared with the board-speed path (feedBoardSpeedToMachine) — see
      // handleAutoStartEvent. Returns false when the start was blocked (board not
      // usable); return early then so this sample isn't processed as if a trip were
      // recording (the blocked branch already reset the machine to idle).
      const started = await this.handleAutoStartEvent(timestampMs, { lat: latitude, lon: longitude });
      if (!started) return;
    }

    const isRecording = state === 'riding' || state === 'stopped' || state === 'manual';
    if (isRecording) {
      // What handleLocationSample's route.push/pendingStop block did before the
      // extraction — the state-machine-driving parts (prevState/state) stay here, only
      // the record's own bookkeeping moved into onGpsSample.
      this.record.onGpsSample(
        { lat: latitude, lon: longitude, timestampMs, speedKmh, accuracyM },
        {
          enteringStopped: prevState !== 'stopped' && state === 'stopped',
          leavingStopped: prevState === 'stopped' && state !== 'stopped',
          isStopped: state === 'stopped',
        },
      );
    }

    if (event?.type === 'auto_end') {
      await this.handleAutoEndEvent(event, timestampMs, prevState === 'manual');
    }

    this.emit();
    // Event-driven periodic work — see drivePeriodicWorkFromEvents. Deliberately after
    // the awaited auto-end above, so a sample that ends the trip still saves through
    // the awaited path before this fires.
    this.drivePeriodicWorkFromEvents();
  };

  /** Reacts to "the trip is over" — reached from handleLocationSample (a GPS sample
   * arriving after the state machine's stop timeout fired) and from
   * handleBleConnectionTransition (a BLE disconnect while a trip is active, which the
   * state machine turns into auto_end even with no GPS flowing). TripStateMachine owns
   * both timers and picks whichever fires first. Also reachable from a manual trip
   * (ble_disconnect only, see tripStateMachine.ts), so a manual trip doesn't keep
   * recording after the board dies. timestampMs is up to one of those timeouts late;
   * end at the actual stop time instead. */
  private async handleAutoEndEvent(event: Extract<TripEvent, { type: 'auto_end' }>, timestampMs: number, wasManual: boolean) {
    const realEndMs = this.record.pendingStop?.startTimestampMs ?? timestampMs;
    logEvent('trip', event.reason === 'ble_disconnect' ? 'auto_end (ble_disconnect)' : 'auto_end', {
      distanceKm: this.record.distanceKm,
      points: this.record.route.length,
      offlineForMs: event.offlineForMs ?? null,
      wasManual,
    });
    // "ble_disconnect" also reaches "Ride saved" below (read and cleared by
    // finishTrip), which is why that notification's body can say why it ended too —
    // "Ride ended" fires immediately here; "Ride saved" follows once finishTrip's
    // async save actually completes, which can take a moment.
    if (event.reason === 'ble_disconnect') this.pendingEndReason = 'ble_disconnect';
    notifyTripLifecycle('ride-ended', { endReason: event.reason === 'ble_disconnect' ? 'ble_disconnect' : null }).catch(() => {});
    this.record.finalizeStopIfAny(timestampMs);
    await this.finishTrip(realEndMs, wasManual);
  }

  /** Manual override — suspends automatic detection, bypasses the start threshold. */
  private startManualImpl = async () => {
    const timestampMs = Date.now();
    // Same staleness bypass as feedBoardSpeedToMachine's own auto_start guard (see
    // AUTO_START_STUCK_MS's doc comment) — without it, a stuck handleAutoStartEvent
    // call permanently blocks manual start too, with no recovery short of killing the
    // app: nothing else ever clears or bypasses this flag.
    const autoStartStuck = this.autoStartInFlight && timestampMs - this.autoStartInFlightSinceMs >= AUTO_START_STUCK_MS;
    if ((this.autoStartInFlight && !autoStartStuck) || getBoardUsability() !== 'usable') {
      this.startBlockedReason = 'device-not-connected';
      logEvent(
        'trip',
        this.autoStartInFlight ? 'manual_start blocked: trip start already in progress' : 'manual_start blocked: device not connected',
      );
      this.emit();
      return false;
    }
    logEvent('trip', 'manual_start');
    if (getPowerSaveModeStatus()) {
      logEvent('trip', 'power save mode is ON at trip start — location updates may be throttled or blocked');
    }
    this.startBlockedReason = null;
    // Finalize any in-progress auto-detected ride first, instead of silently wiping it.
    //
    // forceEnd() the state machine before calling finishTrip() (matching endActive()'s
    // ordering), not after: finishTrip re-throws on a finalizeTrip 'failed' outcome (a
    // Health Connect hiccup, a local SQLite write failure), and if that throw happened
    // before the state machine moved on, beginManual()/resetTripAccumulators() would be
    // skipped entirely — leaving the state machine and this.route/distanceKm/etc. stuck
    // on the old auto-detected trip, so the next GPS sample would silently accumulate
    // into that stale state as if the new manual trip were a continuation of the old
    // one, merging two rides into one saved trip. Doing forceEnd() first means the state
    // machine and accumulators always move on to the new manual trip regardless of
    // whether the superseded trip's finalize succeeded; a finalize failure there just
    // means its checkpoint survives for the existing recovery path, same as any other
    // finalize failure (see tripFinalize.ts).
    const priorState = this.machine.getState();
    if (priorState === 'riding' || priorState === 'stopped') {
      this.record.finalizeStopIfAny(timestampMs);
      this.machine.forceEnd();
      await this.finishTrip(timestampMs, false).catch((err) =>
        logEvent('trip', 'finalize of superseded auto trip failed — starting manual trip anyway', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    // Captured synchronously, before resetTripAccumulators (which wipes these to null
    // via record.begin()) -- same reasoning as handleAutoStartEvent's own comment.
    // Deliberately after the supersede-and-finalize branch above, not before: that
    // finalize's own end snapshot is itself a fresh, real reading from this same
    // board at this same moment, so it's a strictly better pre-start value than
    // whatever was rolling before it, not a risk to capturing "before the ride".
    const preStartOdometerKm = this.record.latestOdometerKm;
    const preStartBatteryPct = this.record.latestBatteryPct;
    this.machine.beginManual();
    // RideService can already have a native ride open for this same board (it
    // auto-starts independently of this JS state machine) — adopt its start time rather
    // than "now", or the two save paths compute different clientTripId keys for one
    // real ride and both the backend's exact-key and start/end-proximity dedupe can
    // miss. Only the trip's own start time is adjusted; timestampMs above (staleness
    // checks, the superseded auto trip's end) stays real "now". No-ops safely if the
    // native module is absent or nothing is open.
    let tripStartMs = timestampMs;
    try {
      const activeNativeRide = RideCoreNative.getActiveRide();
      if (activeNativeRide) tripStartMs = activeNativeRide.startMs;
    } catch {
      // Native module absent — falls back to "now".
    }
    this.resetTripAccumulators(tripStartMs);
    this.record.seedStartTelemetry({ odometerKm: preStartOdometerKm, batteryPct: preStartBatteryPct });
    if (!nativeServiceHoldsLocation()) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, LOCATION_OPTIONS).catch((err) =>
        logEvent('trip', 'startLocationUpdatesAsync failed', { error: err instanceof Error ? err.message : String(err) }),
      );
    }
    // A manual trip is a known start, not a wait-and-see — go straight to full accuracy
    // and stop the idle poll loop. Same decision as the auto_start path (see
    // gpsTierPolicy.ts) — startLocationWatch's own already-running no-op means the watch
    // is guaranteed live even if auto-tracking was off, since watchOnSample was wired up
    // once at app startup regardless.
    await this.applyGpsTierAction(decideGpsTierAction({ event: 'trip_starting' }), 'manual_start');
    // Push 'riding' out to subscribers now, before the slow snapshot/checkpoint below —
    // same reasoning as handleAutoStartEvent's own emit-before-snapshot above. Without
    // this, a manual Start tap while the board's mid-reconnect (queryDeviceStatus now
    // queued behind BleCommandQueue, see SNAPSHOT_QUERY_SEND_TIMEOUT_MS in
    // tripRecorder/tripRecord.ts) left the UI showing nothing for up to ~18s.
    this.emit();
    await this.record.snapshotAt(timestampMs, 'start');
    await this.checkpoint();
    this.emit();
    return true;
  };

  startManual = async () => {
    if (this.manualStartPromise) return false;
    const promise = this.startManualImpl();
    this.manualStartPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.manualStartPromise === promise) this.manualStartPromise = null;
    }
  };

  /** Ends whatever's currently active — a manual trip, or the FAB being used to cut an
   * auto-detected ride short instead of waiting out the stop timeout. Returns the save
   * outcome so a manual "Finish trip" tap can navigate to the saved trip or surface a
   * failure instead of it disappearing silently — callers MUST NOT fire-and-forget this. */
  endActive = async (): Promise<FinishOutcome> => {
    const timestampMs = Date.now();
    logEvent('trip', 'end_active', { distanceKm: this.record.distanceKm, points: this.record.route.length });
    this.record.finalizeStopIfAny(timestampMs);
    const event = this.machine.forceEnd();
    return this.finishTrip(timestampMs, event.type === 'manual_end');
  };

  /** Second line of defense against OEM battery-killers (Xiaomi/Samsung) tearing down
   * the foreground location service despite `killServiceOnDestroy: false` — called on
   * every foreground return during an active trip to detect and restart a dead task. */
  ensureLocationTrackingAlive = async () => {
    if (this.machine.getState() === 'idle') return;
    const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => null);
    if (isRunning === false && !nativeServiceHoldsLocation()) {
      logEvent('trip', 'location task self-heal: was dead, restarting', {});
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, LOCATION_OPTIONS).catch((err) =>
        logEvent('trip', 'location task self-heal restart failed', { error: err instanceof Error ? err.message : String(err) }),
      );
    }
    // Guarded by the idle check above — a trip is genuinely active here, so make sure
    // we're not stuck on the idle tier (also ensures the watch itself is alive). See
    // gpsTierPolicy.ts.
    await this.applyGpsTierAction(decideGpsTierAction({ event: 'ensure_alive_while_recording' }), 'ensure_alive_while_recording');
  };

  /** Back to the cheapest idle-time strategy the instant a trip is over (whatever the
   * outcome — saved/discarded): no continuous GPS watch, only the periodic activity poll
   * deciding when to escalate again. Permission-denied fallback keeps a continuous
   * idle-tier watch. See gpsTierPolicy.ts's 'trip_ended' decision. */
  private resumeIdleGpsStrategy() {
    // After a trip ends, whether to keep the idle GPS watch running depends purely on
    // whether the board is still connected/usable. If the board is still there (e.g. a
    // manual end), keep the idle watch so the next ride auto-starts; if the board is
    // gone (e.g. BLE-disconnect auto-end), stop GPS entirely until the board reconnects.
    // See gpsTierPolicy.ts's 'trip_ended' decision.
    this.applyGpsTierAction(decideGpsTierAction({ event: 'trip_ended', boardUsable: getBoardUsability() === 'usable' }), 'trip_ended');
  }

  /** Drops the expo-location service while idle once RideService holds location. */
  reconcileLocationService = async () => {
    if (this.machine.getState() !== 'idle') return;
    await releaseForegroundServiceIfRedundant();
  };

  private async finishTrip(endMs: number, wasManual: boolean): Promise<FinishOutcome> {
    // Set for this whole function's async body (cleared in the finally below) — see
    // finalizeInFlight's own module-level doc comment for why this exists.
    finalizeInFlight = true;
    try {
      // Captured before any other path through this function can overwrite it (e.g. a
      // manual Finish-trip tap moments after an unrelated disconnect).
      const endReason = this.pendingEndReason;
      this.pendingEndReason = null;
      this.tripBegun = false;
      this.stopTicking();
      this.resumeIdleGpsStrategy();
      // Every caller (endActive's "Finish trip" tap, auto-stop, the superseded-trip path
      // in startManualImpl) has already forced the state machine out of 'riding' by this
      // point, but nothing had emitted that yet — the end snapshot below is the same slow
      // BLE query as the start snapshot (see startManualImpl's own comment), so without
      // this, a Finish-trip tap looked like it did nothing for up to ~18s instead of
      // immediately reflecting that the trip actually stopped.
      this.emit();
      const durationSec = Math.max(0, Math.floor((endMs - this.tripStartMs) / 1000));

      // Everything past this snapshot (discard guard, save, sync, notify) lives in the
      // shared finalizeTrip module so this path and crash-recovery can't drift apart.
      //
      // A ble_disconnect end skips the query outright rather than awaiting it: the board
      // is already confirmed gone, so getBleSnapshot is guaranteed to report null
      // telemetry (see the fallback comment below) -- and the query's own settle/retry
      // bounds are JS timers that Android suspends the instant the board's own dp2 push
      // stream (what was keeping the JS runtime awake) stops. Awaiting it here left the
      // checkpoint uncleared for however long that hang lasted, wide open for the app's
      // own foreground recovery pass to finalize the same ride a second time the moment
      // the rider next opened the app. Nothing downstream needs it: the rolling
      // latestBatteryPct/latestOdometerKm fallback already covers exactly this case.
      const endSnap = endReason === 'ble_disconnect' ? null : await this.record.snapshotAt(endMs, 'end');
      // a board that goes offline right at ride-end (rider powers it off the
      // moment they step off) makes this final read come back fully empty — getBleSnapshot
      // deliberately reports null telemetry once a board is confirmed offline, so a stale
      // reading never looks live on the dashboard (see deviceLink's getBleSnapshot).
      // Correct for the dashboard; wrong here — the ride already happened, and "the board
      // hung up right as I finished" shouldn't blank out the whole trip's distance/battery-
      // used/efficiency when the last few real readings from moments earlier are still
      // sitting right there. Fall back to the trip's own rolling last-known telemetry
      // (latestOdometerKm/latestBatteryPct, updated on every successful read all ride
      // long) instead of recording null — a close-enough answer from seconds ago beats no
      // answer at all.
      const batteryEndPct = endSnap?.batteryPct ?? this.record.latestBatteryPct;
      const odometerEndKm = endSnap?.mileageTotalKm ?? this.record.latestOdometerKm;

      // Authoritative distance is board-sourced: the odometer delta (end − start) when
      // plausible, else boardSpeedSamples-integration. GPS distance integration is never
      // the source. snapshotAt above already folded the end sample into the record's
      // boardSpeedSamples, so the fallback is complete.
      const distanceKm = this.record.computeFinalDistance({ odometerEndKm });

      // Route, mode, and voltage sourced from the native ride journal when a matching
      // ride exists — RideLocationManager's own GPS request survives
      // the Activity lifecycle where the JS watch has real, measured gaps, and
      // RideService's dp handler captures mode/voltage on every BLE push regardless of
      // whether the phone's own JS timers are suspended (screen-locked), unlike
      // TripRecord.snapshotAt. Falls back to the JS-collected data when no native ride
      // matches closely enough (a build without ride-core prebuilt, or RideService
      // never having started this session), so a trip is never saved with no route or
      // samples at all.
      const collected = this.record.collect();
      const nativeData = getNativeTripData(this.tripStartMs);

      const outcome = await finalizeTrip(
        {
          tripStartMs: this.tripStartMs,
          endMs,
          wasManual,
          ...collected,
          route: nativeData?.route ?? collected.route,
          modeSamples: nativeData?.modeSamples ?? collected.modeSamples,
          voltageSamples: nativeData?.voltageSamples ?? collected.voltageSamples,
          batteryEndPct,
          odometerEndKm,
        },
        buildFinalizeDeps(),
      );

      if (outcome.outcome === 'discarded') {
        logEvent('trip', 'discarded (misclick guard)', { distanceKm, durationSec });
        logEvent('trip', 'ride-health', this.rideHealth.summary());
        this.emit();
        return { outcome: 'discarded', reason: outcome.reason };
      }

      if (outcome.outcome === 'failed') {
        // Re-throw so callers' existing try/catch handling still works.
        throw new Error(`trip finalization failed: ${outcome.reason}`);
      }

      const { localId, synced } = outcome.saved;
      this.lastSaveResult = synced ? 'synced' : 'queued-offline';
      logEvent('trip', 'saved', { localId, synced, distanceKm, durationSec });
      logEvent('trip', 'ride-health', this.rideHealth.summary());
      // Catches the remote log up now the ride is over, rather than waiting for the next
      // app-foreground return (which may be a while, if the rider's about to lock the
      // phone and walk inside) — see log.ts's flushRemoteLog for why this is batched at
      // all rather than a POST per line.
      void flushRemoteLog();
      // The ride was finalized and saved — if the phone is backgrounded, show the summary
      // (distance, avg/max speed, duration, battery, dominant mode). Fire-and-forget;
      // gated on background inside notifyTripLifecycle.
      this.notifyFinalizeSummary(distanceKm, durationSec, batteryEndPct, endReason);
      // Remember this ride as the widget's "last ride" for its idle view. Fire-and-forget;
      // the recorder's emit below re-pushes the snapshot with the new summary included.
      void this.captureLastRideSummary(distanceKm, durationSec, batteryEndPct, endMs, localId, synced);
      this.emit();
      return { outcome: 'saved', localId, synced };
    } finally {
      finalizeInFlight = false;
    }
  }

  /** Persists the just-saved ride as the widget's idle "last ride" summary, with its
   * downsampled route (for the widget's static map strip) and — when the ride synced —
   * the backend trip id (for the tap-to-open deep link). */
  private async captureLastRideSummary(
    distanceKm: number,
    durationSec: number,
    batteryEndPct: number | null,
    endMs: number,
    localId: number,
    synced: boolean,
  ) {
    const batteryStartPct = this.record.batteryStartPct;
    const batteryUsedPct = batteryStartPct != null && batteryEndPct != null ? Math.max(0, batteryStartPct - batteryEndPct) : null;
    const tripId = synced ? await getBackendIdForLocal(localId).catch(() => null) : null;
    return captureLastRide({
      localId,
      distanceKm,
      durationSec,
      maxSpeedKmh: this.record.maxSpeedKmh,
      avgSpeedKmh: durationSec > 0 ? distanceKm / (durationSec / 3600) : 0,
      batteryUsedPct,
      endEpochMs: endMs,
      stopsCount: this.record.stops.length,
      tripId,
    });
  }
}

export const tripRecorder = new TripRecorder();

// Every AppState change counts toward the current ride's health summary, whether or not
// a ride is actually active — noteAppStateTransition is cheap, and rideHealth.reset()
// at the next trip start zeroes the count out anyway.
AppState.addEventListener('change', () => tripRecorder.noteAppStateTransition());

/** Call once at app startup, before initAutoTracking. If the previous session was
 * killed mid-ride, finalizes the last SQLite checkpoint as a completed trip (rather
 * than attempting a full resume — TripStateMachine's internal timing state isn't
 * checkpointed). Checks local storage first, falling back to the backend's copy only
 * if the phone itself changed. Returns whether a trip was recovered and saved. */
export async function recoverInterruptedTrip(): Promise<boolean> {
  // A ride's own finishTrip() can still be mid-flight even though the state machine
  // has already reset to 'idle' -- see finalizeInFlight's own doc comment. The
  // pre-existing `state === 'idle'` guard some callers apply before calling this
  // (app/_layout.tsx's foreground-return effect) is structurally incapable of seeing
  // that: state resets to idle synchronously, before finishTrip's async body even
  // starts, so the guard passes and this function would otherwise finalize the exact
  // same ride finishTrip is still in the middle of saving. Checked here, not left to
  // callers, so every call site is covered uniformly.
  if (finalizeInFlight) {
    logEvent('trip', 'recovery skipped: a finalize is already in flight for this ride');
    return false;
  }
  let checkpoint = await getTripCheckpoint().catch(() => null);
  let source: 'local' | 'backend' = 'local';
  if (!checkpoint) {
    const backendCheckpoint = await api.getInProgressTrip().catch(() => null);
    if (backendCheckpoint) {
      checkpoint = fromBackendPayload(backendCheckpoint);
      source = 'backend';
    }
  }
  if (!checkpoint) return false;

  const durationSec = Math.max(0, Math.floor((checkpoint.lastUpdateMs - checkpoint.tripStartMs) / 1000));

  logEvent('trip', 'recovering interrupted trip', {
    source,
    distanceKm: checkpoint.distanceKm,
    durationSec,
    points: checkpoint.route.length,
  });

  try {
    // Recovery has no end-of-trip snapshot, but the checkpoint now carries the board's
    // rolling latest odometer/battery (dp12/dp3) captured at the last checkpoint — use
    // those as the end values when present. With a real odometerEndKm the authoritative
    // distance is the odometer delta; only when the checkpoint predates the rolling
    // fields (null) does it fall back to board-speed integration (see
    // computeTripDistanceKm) — the board is the primary distance source, never GPS.
    const odometerEndKm = checkpoint.latestOdometerKm ?? null;
    const batteryEndPct = checkpoint.latestBatteryPct ?? null;
    const distanceKm = computeTripDistanceKm({
      odometerStartKm: checkpoint.odometerStartKm,
      odometerEndKm,
      boardSpeedSamples: checkpoint.boardSpeedSamples,
    });
    // Same native-journal sourcing as the live finish path —
    // recovery's own checkpoint route/modeSamples/voltageSamples are the JS capture
    // path's, with the same gaps (a locked phone during the ride means the JS ticker
    // never ran, so the checkpoint may carry none of either).
    const nativeData = getNativeTripData(checkpoint.tripStartMs);
    const outcome = await finalizeTrip(
      {
        tripStartMs: checkpoint.tripStartMs,
        endMs: checkpoint.lastUpdateMs,
        wasManual: checkpoint.wasManual,
        route: nativeData?.route ?? checkpoint.route,
        stops: checkpoint.stops,
        modeSamples: nativeData?.modeSamples ?? checkpoint.modeSamples,
        voltageSamples: nativeData?.voltageSamples ?? checkpoint.voltageSamples,
        boardSpeedSamples: checkpoint.boardSpeedSamples,
        distanceKm,
        maxSpeedKmh: checkpoint.maxSpeedKmh,
        batteryStartPct: checkpoint.batteryStartPct,
        odometerStartKm: checkpoint.odometerStartKm,
        batteryEndPct,
        odometerEndKm,
      },
      buildFinalizeDeps(),
    );

    if (outcome.outcome === 'saved') {
      const { localId, synced } = outcome.saved;
      logEvent('trip', 'recovered trip saved', { localId, synced });
      // A recovered ride was finalized and saved. Recovery normally runs at cold start
      // (foreground), so this is usually a no-op — but if it ever runs while
      // backgrounded, show the summary. Gated on background inside notifyTripLifecycle.
      // batteryEndPct is the checkpoint's rolling latest (null when it predates the
      // field); the dominant mode isn't recomputed here (the checkpoint doesn't retain
      // modeSamples).
      notifyTripLifecycle(
        'finalize-summary',
        buildFinalizeSummaryPayload({
          distanceKm,
          durationSec,
          maxSpeedKmh: checkpoint.maxSpeedKmh,
          batteryStartPct: checkpoint.batteryStartPct,
          batteryEndPct,
          dominantMode: null,
        }),
      ).catch(() => {});
      // Remember the recovered ride as the widget's idle "last ride" summary. Fire-and-forget;
      // widgetSync re-pushes on capture so the idle view flips to it immediately.
      const batteryUsedPct =
        checkpoint.batteryStartPct != null && batteryEndPct != null ? Math.max(0, checkpoint.batteryStartPct - batteryEndPct) : null;
      const tripId = synced ? await getBackendIdForLocal(localId).catch(() => null) : null;
      void captureLastRide({
        localId,
        distanceKm,
        durationSec,
        maxSpeedKmh: checkpoint.maxSpeedKmh,
        avgSpeedKmh: durationSec > 0 ? distanceKm / (durationSec / 3600) : 0,
        batteryUsedPct,
        endEpochMs: checkpoint.lastUpdateMs,
        stopsCount: checkpoint.stops.length,
        tripId,
      });
      return true;
    }

    if (outcome.outcome === 'discarded') {
      logEvent('trip', 'recovered checkpoint discarded (too short)', { source, distanceKm: checkpoint.distanceKm, durationSec });
      return false;
    }

    // 'failed' — checkpoint stays in place so a later launch can retry.
    logEvent('trip', 'recovery failed', { error: `finalization failed: ${outcome.reason}` });
    return false;
  } catch (err) {
    logEvent('trip', 'recovery failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Call once at app startup — wires the started watch into the recorder. */
export async function initAutoTracking(): Promise<{ granted: boolean }> {
  const result = await initAutoTrackingCore(handleWatchSample);
  if (!result.granted) return result;

  // Start the foreground location service now, proactively, while app launch
  // guarantees a valid (Android-considers-it-"visible") foreground state — not
  // reactively later from subscribeWatch, which used to be the only place this
  // started and could just as easily fire from a board reconnecting or a trip
  // auto-starting while the phone is locked in a pocket. See
  // ensureForegroundServiceRunning's own doc comment in tripRecorder/location.ts for
  // the real production bug (confirmed against actual logs) this closes: Android 12+
  // refuses to start a *new* foreground service from the background, and without one
  // already running, Android's own background-location throttle silently cuts GPS
  // down to a few fixes per hour — independent of battery optimization/OEM
  // "sleeping apps" settings, which don't touch this at all.
  //
  // Gated on a board actually being paired (not necessarily connected) — a fresh
  // install with nothing paired yet still shouldn't show a permanent "tracking your
  // location" notification for no reason. Once a board IS paired, this always runs
  // at the next app launch regardless of whether that board is currently connected,
  // which is the whole point: the service must already be up *before* the risky
  // moment (a reconnect or auto-start happening while backgrounded), not started
  // reactively in response to it.
  //
  // Also re-checked on onDevicePaired, same reasoning as startBleSpeedTracking below —
  // nothing paired yet at this call means this initial check finds no devId, and
  // without the re-check the service would never start proactively for a device paired
  // later in the same process.
  //
  // Fire-and-forget; a failure here just means the reactive call in subscribeWatch
  // gets another shot once the app is next foregrounded, same as before this
  // existed. (Never rejects — ensureForegroundServiceRunning already logs and
  // swallows its own failure.)
  const startForegroundServiceIfPaired = () => {
    getPairedDeviceId().then((devId) => {
      if (devId) void ensureForegroundServiceRunning();
    });
  };
  startForegroundServiceIfPaired();
  onDevicePaired(startForegroundServiceIfPaired);
  // RideService is started alongside this and usually reaches the foreground a moment
  // later, so check once it has had time to.
  setTimeout(() => void tripRecorder.reconcileLocationService(), 15_000);

  // Folds every board dp2 speed push into max speed in real time (the board's own
  // speedometer is the only source of truth for speed — GPS is never used for max
  // speed). Idempotent, safe to call on re-init.
  tripRecorder.startBleSpeedTracking();

  // No continuous GPS watch and no motion-activity polling while idle. Instead,
  // subscribe once to BLE connection transitions and start/stop the idle GPS watch as
  // the board connects/disconnects — the moment the board confirms usable, the GPS
  // watch starts so location samples flow and the state machine's board-speed
  // threshold can auto-start; when the board disconnects while idle, GPS stops until it
  // reconnects. (While a trip is recording, samples must keep flowing so the
  // BLE-disconnect auto-end can fire, so the disconnect handler is guarded to only act
  // when idle.) Idempotent; safe to call on re-init.
  tripRecorder.startConnectionGatedTracking();
  return result;
}
