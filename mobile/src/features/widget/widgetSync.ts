import { AppState } from 'react-native';

import CityroamWidget from '@modules/cityroam-widget/src/CityroamWidget';
import { tripRecorder } from '@/features/rides/tripRecorder';
import { getBleSessionState, getCachedDps } from '@/features/device/deviceLink/session';
import { getPairedDeviceId, subscribeBleSession } from '@/features/device/deviceLink';
// Straight from the events module rather than through lib/deviceLink's `export *` — that
// module is in a require cycle, and a subscriber bound through it can end up on a
// different instance from the emitter, receiving nothing.
import { subscribeToBleConnectionTransitions } from '@/features/device/deviceLink/connectionEvents';
import { decodeMode, modeLabel } from '@/lib/mode';
import { decodeScaled } from '@/features/device/boardValue';
import { GLOBAL_DP } from '@/features/device/boardDpLabels';
import {
  getWidgetAccentColor,
  getWidgetContainerStyle,
  getWidgetFont,
  getWidgetNeedle,
  loadWidgetAppearance,
  subscribeToWidgetAppearance,
} from '@/features/widget/widgetAppearance';
import { getLastRide, loadWidgetContext, onLastRideCaptured } from '@/features/widget/widgetLastRide';
import {
  clearCachedLiveWeather,
  fetchAndCacheTripExtras,
  getCachedLiveWeather,
  getTripExtras,
  loadWidgetExtras,
  refreshLiveWeatherIfNeeded,
  retryTripExtrasIfStale,
} from '@/features/widget/widgetExtras';

/**
 * Pushes the live trip + board-telemetry snapshot to the Android home-screen widget.
 *
 * The widget is rendered natively (CityroamWidgetProvider) and can't read JS memory, so this
 * module is the single JS producer: it folds the trip recorder's snapshot (state,
 * elapsed, distance, max speed) together with the live BLE session (battery, charging,
 * online, mode, board wheel speed) into one compact JSON object and hands it to
 * CityroamWidget.updateSnapshot, which persists it and re-renders every widget instance.
 *
 * Two triggers keep it live:
 *  1. tripRecorder.subscribe fires on every state transition AND the recorder's 1s tick
 *     while a trip is active — so an active ride updates the widget every second.
 *  2. A BLE session subscription fires whenever the board's telemetry changes (battery,
 *     mode, online) even when no trip is recording, so the idle widget's device row stays
 *     current.
 *
 * Runs at module scope (side effect on import), same pattern as lib/deviceLink/statusRefresh.ts
 * and lib/bleConnectionFeedback.ts — imported once, early, from app/_layout.tsx.
 */

/** True only when the DP map currently in memory came from the board itself over BLE
 * this session, on a link that is confirmed up.
 *
 * The widget must never present a last-known value as a live reading. Two things make
 * that easy to get wrong: `dps` is hydrated from AsyncStorage at startup, so a fully
 * populated map can be days old with no board in range; and `online` is null (not
 * false) until the first status event or push lands, so a "not confirmed offline"
 * check passes during exactly the window where the only values available are the
 * hydrated ones. Requiring a real push AND a confirmed-online link closes both. */
function boardIsReporting(): boolean {
  const session = getBleSessionState();
  return session.online === true && session.dpsLive;
}

/** The board's live telemetry (dp2 wheel speed, battery, mode). Every field is the
 * board's own reading over Direct BLE or null — never a cached or derived stand-in, so
 * the widget shows "–" rather than a plausible-looking stale number. */
function liveBoardTelemetry(): { speedKmh: number | null; batteryPct: number | null; mode: string | null } {
  if (!boardIsReporting()) {
    return { speedKmh: null, batteryPct: null, mode: null };
  }
  const dps = getCachedDps();

  let speedKmh: number | null = null;
  const rawSpeed = dps?.['2'];
  if (rawSpeed != null) {
    const speed = decodeScaled(Number(rawSpeed), 1);
    if (Number.isFinite(speed)) speedKmh = speed;
  }

  const rawBattery = dps?.[GLOBAL_DP.battery];
  const batteryPct = typeof rawBattery === 'number' ? rawBattery : null;

  const rawMode = dps?.[GLOBAL_DP.rideMode];
  const mode = typeof rawMode === 'string' && rawMode ? modeLabel(decodeMode(rawMode)) : null;

  return { speedKmh, batteryPct, mode };
}

/** The board's lifetime odometer (dp12), on the same live-only gate as the rest of the
 * telemetry. This used to be exempt so a last-known total could show while
 * disconnected, but a lifetime odometer is indistinguishable from a current one on
 * sight — a stale figure here reads as fact, not as history. */
function liveOdometerKm(): number | null {
  if (!boardIsReporting()) return null;
  const dps = getCachedDps();
  const raw = dps?.['12'];
  if (raw == null) return null;
  const km = decodeScaled(Number(raw), 1);
  return Number.isFinite(km) ? km : null;
}

/** Builds the flat JSON snapshot the native widget renders. Pure over the current
 * recorder + BLE session state, so it's unit-testable without driving real timers. */
export function buildWidgetSnapshotJson(): string {
  const rec = tripRecorder.getSnapshot();
  const session = getBleSessionState();
  const { speedKmh, batteryPct, mode } = liveBoardTelemetry();

  // The idle view renders the last completed ride (captured at finalize time — the widget
  // can't reach the backend), or a placeholder when none exists yet. Its odometer/weather/
  // mode-cost figures are that specific trip's own saved record (fetched once, not live —
  // see widgetExtras.ts's fetchAndCacheTripExtras), never a live GPS/BLE reading.
  const lastRide = getLastRide();
  const tripExtras = getTripExtras(lastRide?.tripId ?? null);
  const liveWeather = getCachedLiveWeather();

  // Distance/max-speed are, like current speed, board telemetry (dp2's running totals) —
  // and per the phone-side GPS watch being itself gated on the board connection (see
  // mobile/AGENTS.md's PHONE=GPS-only invariant), nothing is actually being tracked while
  // the board isn't reporting, so a frozen last number here would look live without being
  // live. Idle is exempt: those totals reset with the next trip regardless, not read by
  // the native side in the idle view anyway (it reads the separate lastRide* fields).
  const reporting = boardIsReporting();
  const liveTelemetryKnown = reporting && rec.state !== 'idle';

  const snapshot = {
    state: rec.state,
    // Lets the native widget keep its elapsed clock self-advancing from wall-clock while
    // a trip is active, so it keeps ticking even if the JS process dies mid-ride.
    tripStartEpochMs: rec.tripStartEpochMs,
    elapsedSec: rec.elapsedSec,
    // The board's dp2 wheel speed, straight from the live DP stream. The recorder's own
    // reading is the fallback only while a trip is running and the board hasn't sent a
    // dp2 value yet — it is the same dp2 stream with a short blip-tolerance window
    // (tripRecord.ts's liveSpeedKmh), never GPS. Null when the board isn't reporting.
    currentSpeedKmh: speedKmh ?? (liveTelemetryKnown ? rec.currentSpeedKmh : null),
    distanceKm: rec.state === 'idle' || liveTelemetryKnown ? rec.distanceKm : null,
    maxSpeedKmh: rec.state === 'idle' || liveTelemetryKnown ? rec.maxSpeedKmh : null,
    batteryPct,
    charging: session.charging,
    online: session.online,
    mode,
    // Live-state-only board lifetime odometer (dp12) — last-known value even while
    // disconnected (see liveOdometerKm's own comment for why). The idle state's odometer
    // is a different field below (lastRideOdometerKm) — that ride's own saved record,
    // not a live BLE reading.
    odometerKm: liveOdometerKm(),
    hasLastRide: lastRide != null,
    lastRideDistanceKm: lastRide?.distanceKm ?? 0,
    lastRideDurationSec: lastRide?.durationSec ?? 0,
    lastRideMaxSpeedKmh: lastRide?.maxSpeedKmh ?? 0,
    lastRideAvgSpeedKmh: lastRide?.avgSpeedKmh ?? 0,
    lastRideBatteryUsedPct: lastRide?.batteryUsedPct ?? null,
    lastRideEndEpochMs: lastRide?.endEpochMs ?? 0,
    lastRideStopsCount: lastRide?.stopsCount ?? 0,
    // Backend trip id for the idle tap-through to /trip/<id> (null when the ride never
    // synced, in which case tapping falls back to the launcher).
    lastRideTripId: lastRide?.tripId ?? null,
    // Everything below is that specific ride's own saved record (widgetExtras.ts's
    // fetchAndCacheTripExtras) — not live data. Null per field until the fetch resolves.
    lastRideOdometerKm: tripExtras.odometerKm,
    lastRideWeatherTempC: tripExtras.weatherTempC,
    lastRideWeatherWindMs: tripExtras.weatherWindMs,
    lastRideWeatherCode: tripExtras.weatherCode,
    ecoBatteryPct: tripExtras.cost.eco ?? null,
    rideBatteryPct: tripExtras.cost.ride ?? null,
    speedBatteryPct: tripExtras.cost.speed ?? null,
    turboBatteryPct: tripExtras.cost.turbo ?? null,
    // Live-state-only hero weather badge (widgetExtras.ts's refreshLiveWeatherIfNeeded) —
    // the one genuinely live data point in this file, matching the live-ride widget's own
    // nature. Null while idle (the idle badge uses lastRideWeatherTempC above instead) or
    // before the first fix-based fetch lands for this ride.
    weatherTempC: liveWeather?.feelsLikeC ?? null,
    weatherWindMs: liveWeather?.windSpeedMs ?? null,
    weatherCode: liveWeather?.weatherCode ?? null,
    // The widget's own appearance — independent of the app's theme.tsx, see widgetAppearance.ts.
    accentColor: getWidgetAccentColor(),
    font: getWidgetFont(),
    needle: getWidgetNeedle(),
    containerStyle: getWidgetContainerStyle(),
  };

  return JSON.stringify(snapshot);
}

/** The last ride's extras (odometer, weather, per-mode cost) are fetched once when the
 * trip id becomes known; a failure there used to leave the widget on "–" for the rest of
 * the process. Re-attempt on the same triggers that already re-push, and push again the
 * moment one succeeds. */
function retryStaleExtras(): void {
  const tripId = getLastRide()?.tripId ?? null;
  if (tripId == null) return;
  retryTripExtrasIfStale(tripId).then(() => {
    if (getTripExtras(tripId).odometerKm != null) pushSnapshot();
  });
}

// The recorder's 1s tick re-emits every second while a trip is active purely to keep
// elapsedSec live — that used to mean a native re-render (updateSnapshot persists JSON
// and re-renders every widget instance) once a second for the length of every ride, for
// a field (elapsed time) the widget already derives on its own from tripStartEpochMs
// (see buildWidgetSnapshotJson). Throttled to at most once a second by default; `force`
// bypasses it for the pushes that actually need to land immediately — a connection
// transition or a real ride-state change, not just the tick.
const PUSH_SNAPSHOT_THROTTLE_MS = 1_000;
let lastSnapshotPushMs = 0;
let snapshotPushTimer: ReturnType<typeof setTimeout> | null = null;

function pushSnapshot(force = false): void {
  const elapsed = Date.now() - lastSnapshotPushMs;
  if (!force && elapsed < PUSH_SNAPSHOT_THROTTLE_MS) {
    if (!snapshotPushTimer) {
      snapshotPushTimer = setTimeout(() => {
        snapshotPushTimer = null;
        pushSnapshotNow();
      }, PUSH_SNAPSHOT_THROTTLE_MS - elapsed);
    }
    return;
  }
  if (snapshotPushTimer) {
    clearTimeout(snapshotPushTimer);
    snapshotPushTimer = null;
  }
  pushSnapshotNow();
}

function pushSnapshotNow(): void {
  lastSnapshotPushMs = Date.now();
  try {
    CityroamWidget.updateSnapshot(buildWidgetSnapshotJson());
  } catch {
    // The native module may be absent on a build that hasn't been prebuilt with the
    // widget module (e.g. a dev client without the native side). Widget sync must never
    // crash the app — a missing widget is a cosmetic gap, not a reason to fail startup.
  }
}

// Live trip updates: fires on every state transition and the recorder's 1s tick. Weather
// here is the live-ride hero badge only (widgetExtras.ts's refreshLiveWeatherIfNeeded) —
// the idle state's weather comes from that ride's own saved record instead (see
// buildWidgetSnapshotJson's lastRideWeatherTempC), not a live fetch of any kind.
let lastSeenRecorderState: string | null = null;
tripRecorder.subscribe(() => {
  const rec = tripRecorder.getSnapshot();
  // A genuine state transition (idle -> riding, riding -> stopped, etc.) must land
  // immediately — the throttle above exists for the 1s tick re-emitting the SAME state,
  // not for this.
  const isRealTransition = rec.state !== lastSeenRecorderState;
  lastSeenRecorderState = rec.state;
  if (rec.state === 'idle') {
    // Clears the live-ride reading so it can't linger into the next ride's first few
    // pushes before a fresh fetch lands for the new ride's location.
    clearCachedLiveWeather();
  } else {
    const latestPoint = rec.route[rec.route.length - 1];
    if (latestPoint) refreshLiveWeatherIfNeeded(latestPoint.lat, latestPoint.lon).then(() => pushSnapshot());
  }
  pushSnapshot(isRealTransition);
});

// Board telemetry updates (battery/mode/online changes, live or idle). The session is
// registered per-device; resolve the active device first, mirroring how the trip recorder
// wires its own BLE subscription at startup.
getPairedDeviceId().then((devId) => {
  if (!devId) return;
  subscribeBleSession(devId, () => pushSnapshot());
});

// A connect/disconnect must swap what the widget shows (the header's dot/label, whether
// distance/max/avg read as live numbers or "–") the instant it happens — not whenever some
// other trigger next happens to fire. subscribeBleSession above already re-fires on every
// session field change including online, so this is largely covered already, but that's an
// incidental side effect of a blanket "anything changed" listener, not a guaranteed signal.
// This hooks the same dedicated connect/disconnect event bus tripRecorder.ts itself uses
// for its own reactive logic (haptics, the idle GPS watch), which also replays the last
// known transition to a new subscriber (connectionEvents.ts) — so this fires once
// immediately on import with the current state too, not just on future transitions.
subscribeToBleConnectionTransitions(() => pushSnapshot(true));

// The recorder only ticks while a trip is active, so on a cold start with no trip the
// widget would otherwise keep whatever stale state it persisted last. Hydrate the cached
// last-ride + the widget's own appearance first so the first idle snapshot isn't empty /
// the wrong look, then push an idle snapshot. Refresh again whenever the app returns to
// the foreground in case the widget went stale while the process was dead.
Promise.all([loadWidgetContext(), loadWidgetAppearance(), loadWidgetExtras()]).then(() => {
  // captureLastRide/backfillLastRideTripId trigger the trip-by-mode fetch when a ride is
  // newly finished or newly synced — but a ride hydrated here from a *previous* session's
  // cache went through neither of those paths this process lifetime, so without this it
  // would silently sit at "–" forever despite already having a resolvable trip id.
  const lastRide = getLastRide();
  if (lastRide?.tripId != null) fetchAndCacheTripExtras(lastRide.tripId).then(() => pushSnapshot());
  pushSnapshot();
});

// A ride finishing while idle (crash recovery at cold start, or a live finish that lands
// after the recorder's own emit) must flip the idle view to the new last ride immediately.
onLastRideCaptured(() => pushSnapshot());

// The widget has its own font/accent, independent of the app's theme (see
// widgetAppearance.ts) — a change on the widget's own settings screen must re-push
// immediately, otherwise the widget keeps its old look until some unrelated push (BLE/trip
// event, the 30s idle timer, or the next launch) happens to fire.
subscribeToWidgetAppearance(() => pushSnapshot(true));

// While idle the widget's device row only updates when a BLE telemetry change event fires
// — a connected-but-silent board would otherwise leave it stale for the whole session.
// Re-push on a slow cadence while the app is foregrounded so the idle row refreshes even
// with no change events. (During a trip the recorder's 1s tick already covers this, so the
// interval only needs to run while idle.) Gated on foreground like statusRefresh.ts so it
// can't refresh a screen nobody's looking at — and so it doesn't hold the process open in
// tests, where the app is never foregrounded.
const IDLE_REFRESH_INTERVAL_MS = 30_000;
let idleRefreshTimer: ReturnType<typeof setInterval> | null = null;
function startIdleRefresh(): void {
  if (idleRefreshTimer) return;
  idleRefreshTimer = setInterval(() => {
    retryStaleExtras();
    pushSnapshot();
  }, IDLE_REFRESH_INTERVAL_MS);
}
function stopIdleRefresh(): void {
  if (!idleRefreshTimer) return;
  clearInterval(idleRefreshTimer);
  idleRefreshTimer = null;
}
if (AppState.currentState === 'active') startIdleRefresh();
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    retryStaleExtras();
    pushSnapshot();
    startIdleRefresh();
  } else {
    stopIdleRefresh();
  }
});
