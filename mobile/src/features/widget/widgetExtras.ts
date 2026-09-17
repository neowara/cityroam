import AsyncStorage from '@react-native-async-storage/async-storage';

import { api } from '@/lib/api';
import { MODE_ORDER, type Mode } from '@/lib/mode';
import { fetchCurrentWeather, type CurrentWeather } from '@/lib/weather';

/**
 * Two supplementary widget data sources that replaced the widget's now-removed static
 * map (its basemap and skew issues couldn't be verified in this environment, so it was
 * cut rather than shipped half-working):
 *
 *  - Last-ride extras (idle state): odometer, weather, and "what this ride would have
 *    cost in each mode" are all data the backend already saved/computed for that
 *    specific completed trip — GET /trips/<id> (odometerEndKm, feelsLikeC, windSpeedMs)
 *    and GET /trips/<id>/by-mode (the same physics re-simulation the trip detail
 *    screen's TripByModeModule shows), fetched directly here the moment the trip id is
 *    known (widgetLastRide.ts's captureLastRide/backfillLastRideTripId call
 *    fetchAndCacheTripExtras). None of this is "live" — it's the ride's own historical
 *    record, so there's no live GPS/BLE dependency for the idle state at all. Persisted
 *    and tagged with the trip id it's for, so a newer ride's cache never gets misread as
 *    belonging to whichever ride is currently shown.
 *  - Live weather (live-ride state only — the one genuinely live data source in this
 *    file, matching the live-ride widget's own nature): fetched independently here (not
 *    read off any screen's query cache — this module has no component lifecycle to hook
 *    into), keyed off the recorder's current GPS point. Not persisted — a stale reading
 *    from a past ride's location is actively misleading, not just absent.
 */

// Percent of battery this specific ride would have used in each mode (physics
// re-simulation over its actual route) — not a range-in-km estimate.
export type TripByModeCost = Partial<Record<Mode, number | null>>;

export type TripExtras = {
  cost: TripByModeCost;
  odometerKm: number | null;
  weatherTempC: number | null;
  weatherWindMs: number | null;
  // WMO weather code (lib/weather.ts's weatherMeta table) — picks the widget's
  // condition icon (sun/cloud/rain/snow/storm). A trip's weatherCodes is a sampled
  // array over the ride's duration; the first sample is representative enough for a
  // small icon, same "good enough, not a full breakdown" bar as everything else here.
  weatherCode: number | null;
};

const EMPTY_TRIP_EXTRAS: TripExtras = { cost: {}, odometerKm: null, weatherTempC: null, weatherWindMs: null, weatherCode: null };

const TRIP_EXTRAS_KEY = 'turbo.widget.tripExtras';

let tripExtrasTripId: number | null = null;
let tripExtras: TripExtras = EMPTY_TRIP_EXTRAS;
let tripExtrasInFlight: Promise<void> | null = null;
let tripExtrasInFlightFor: number | null = null;
let tripExtrasLastAttemptMs = 0;
let cachedLiveWeather: CurrentWeather | null = null;
let liveWeatherFetchedAtMs = 0;
let liveWeatherFetchedForKey = '';

/** The last ride's odometer/weather/mode-cost figures, scoped to the given trip id —
 * returns the empty shape for any other id (including while a fetch for a *different*,
 * newer ride is still in flight or failed), so a stale ride's numbers can never be
 * misread as belonging to the current one. */
export function getTripExtras(forTripId: number | null): TripExtras {
  return forTripId != null && forTripId === tripExtrasTripId ? tripExtras : EMPTY_TRIP_EXTRAS;
}

/** Fetches this specific ride's own saved odometer/weather (GET /trips/<id>, the same
 * request the trip detail screen makes) alongside "what it would have cost in each
 * mode" (GET /trips/<id>/by-mode, TripByModeModule's own request), and caches both
 * together keyed to that trip id. Called the moment a trip id becomes known
 * (captureLastRide / backfillLastRideTripId / a cold-start hydration that finds one
 * already cached), independent of whether the user ever opens that trip's detail
 * screen. A no-op (resolved immediately) if already cached for this id. Callers may
 * fire-and-forget or await the returned promise to push a fresh snapshot the moment it
 * resolves rather than waiting for some unrelated trigger to happen to fire. */
export function fetchAndCacheTripExtras(tripId: number): Promise<void> {
  if (tripExtrasTripId === tripId) return Promise.resolve();
  if (tripExtrasInFlight && tripExtrasInFlightFor === tripId) return tripExtrasInFlight;
  tripExtrasInFlightFor = tripId;
  tripExtrasLastAttemptMs = Date.now();
  tripExtrasInFlight = Promise.all([api.getTrip(tripId), api.getTripByMode(tripId)])
    .then(([trip, byMode]) => {
      const costFor = (m: Mode) =>
        m === byMode.actualMode && byMode.actualBatteryUsedPct != null
          ? byMode.actualBatteryUsedPct
          : (byMode.modes[m]?.estimatedBatteryUsedPct ?? null);
      const next: TripExtras = {
        cost: Object.fromEntries(MODE_ORDER.map((m) => [m, costFor(m)])),
        odometerKm: trip.odometerEndKm,
        weatherTempC: trip.feelsLikeC,
        weatherWindMs: trip.windSpeedMs,
        weatherCode: trip.weatherCodes?.[0] ?? null,
      };
      tripExtrasTripId = tripId;
      tripExtras = next;
      AsyncStorage.setItem(TRIP_EXTRAS_KEY, JSON.stringify({ tripId, extras: next })).catch(() => {});
    })
    .catch(() => {
      // Best-effort for this attempt — retryTripExtrasIfStale takes it from here rather
      // than leaving the widget at "–" for the rest of the process lifetime.
    })
    .finally(() => {
      tripExtrasInFlight = null;
      tripExtrasInFlightFor = null;
    });
  return tripExtrasInFlight;
}

// A failed attempt used to be terminal: fetchAndCacheTripExtras runs once at cold start,
// and if that lands before auth/network is ready the widget shows "–" for odometer,
// weather and every mode until the app is force-closed and relaunched. Long enough that
// a foreground return or the idle tick can't hammer the backend, short enough that the
// widget repairs itself within a session.
const TRIP_EXTRAS_RETRY_MS = 60_000;

/** Re-attempts the last-ride extras fetch when the cache is still empty for the ride the
 * widget is currently showing. Safe to call from any recurring trigger (foreground
 * return, the idle refresh tick) — it no-ops when the data is already cached, a fetch is
 * in flight, or the last attempt was too recent. */
export function retryTripExtrasIfStale(tripId: number | null): Promise<void> {
  if (tripId == null || tripExtrasTripId === tripId || tripExtrasInFlight) return Promise.resolve();
  if (Date.now() - tripExtrasLastAttemptMs < TRIP_EXTRAS_RETRY_MS) return Promise.resolve();
  return fetchAndCacheTripExtras(tripId);
}

/** Hydrates the last-ride extras cache from AsyncStorage. Call once at startup, same as
 * widgetLastRide's loadWidgetContext, so a cold start shows last session's figures
 * immediately instead of waiting on a fresh fetch. */
export async function loadWidgetExtras(): Promise<void> {
  const raw = await AsyncStorage.getItem(TRIP_EXTRAS_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    tripExtrasTripId = parsed.tripId ?? null;
    tripExtras = parsed.extras ?? EMPTY_TRIP_EXTRAS;
  } catch {
    // corrupt/old value — leave the cache empty rather than crash
  }
}

export function getCachedLiveWeather(): CurrentWeather | null {
  return cachedLiveWeather;
}

/** Clears the cached live weather when a ride ends, so a stale reading from that ride's
 * location can't linger into the next ride's first few pushes before a fresh fetch
 * lands for wherever the rider is now. */
export function clearCachedLiveWeather(): void {
  cachedLiveWeather = null;
  liveWeatherFetchedAtMs = 0;
  liveWeatherFetchedForKey = '';
}

const LIVE_WEATHER_REFRESH_MS = 15 * 60_000;

// Tracks an in-flight fetch separately from a *completed* one — see
// refreshLiveWeatherIfNeeded's own comment for why the two used to be conflated.
let liveWeatherInFlightForKey: string | null = null;
let liveWeatherInFlight: Promise<void> | null = null;

/** Fetches weather for the live-ride widget's hero-row badge — the one genuinely live
 * data point in this file — at most once per LIVE_WEATHER_REFRESH_MS and only when the
 * rounded lat/lon actually moved, mirroring lib/weather.ts's in-app "ongoing-trip"
 * lookup's own rounding/staleness policy (kept independent since this runs outside any
 * component's query cache). Callers may fire-and-forget or await the returned promise
 * to push a fresh snapshot the moment it resolves.
 *
 * The refresh cooldown is only armed on a genuinely successful result — a rejected
 * fetch (bug: this used to stamp liveWeatherFetchedForKey/AtMs *before* the fetch
 * even started, so a request that failed — e.g. no signal for the one GPS sample that
 * happened to trigger it — silently blocked every retry for the full 15-minute window
 * even once connectivity came back, for most of a typical ride) or a resolved-but-empty
 * one (fetchCurrentWeather returns null on a non-ok response) both leave the cooldown
 * untouched, so the very next call for this key retries immediately instead of waiting
 * out a window that never actually produced anything. Concurrent calls for the same key
 * join the same in-flight request rather than firing a duplicate. */
export function refreshLiveWeatherIfNeeded(lat: number, lon: number): Promise<void> {
  const roundedLat = Math.round(lat * 100) / 100;
  const roundedLon = Math.round(lon * 100) / 100;
  const key = `${roundedLat},${roundedLon}`;
  const now = Date.now();
  if (key === liveWeatherFetchedForKey && now - liveWeatherFetchedAtMs < LIVE_WEATHER_REFRESH_MS) return Promise.resolve();
  if (key === liveWeatherInFlightForKey && liveWeatherInFlight) return liveWeatherInFlight;

  liveWeatherInFlightForKey = key;
  const promise = fetchCurrentWeather(roundedLat, roundedLon)
    .then((result) => {
      if (result) {
        cachedLiveWeather = result;
        liveWeatherFetchedForKey = key;
        liveWeatherFetchedAtMs = Date.now();
      }
    })
    .catch(() => {
      // Best-effort — the widget's weather badge just stays hidden/stale on failure.
    })
    .finally(() => {
      if (liveWeatherInFlightForKey === key) {
        liveWeatherInFlightForKey = null;
        liveWeatherInFlight = null;
      }
    });
  liveWeatherInFlight = promise;
  return promise;
}
