import { request } from '@/lib/api/client';

// Shared route/elevation point type returned by POST /range-estimate/to-destination —
// decimated server-side to at most MAX_ROUTE_POINTS, with per-point elevation from
// Open-Meteo when that lookup succeeded (null means "draw flat").
export type RoutePointElevation = {
  lat: number;
  lon: number;
  elevationM: number | null;
};

// Per-mode reachability answer for a specific A→B route. reachable / reachableRoundTrip
// are null when there's no battery reading to check against — same honest "not enough
// data" contract as the plain live estimate, never a failed request.
export type DestinationModeResult = {
  reachable: boolean | null;
  reachableRoundTrip: boolean | null;
  estimatedArrivalBatteryPct: number | null;
  estimatedRoundTripArrivalBatteryPct: number | null;
  estimatedEnergyWh: number | null;
  distanceKm: number | null;
  climbM: number | null;
};

// Current conditions at the route's start point — a live snapshot, distinct from a
// saved Trip's averaged-over-the-ride weatherCodes/etc. All fields null together
// means the lookup failed server-side, not "calm and dry".
export type WeatherConditions = {
  weatherCodes: number[] | null;
  feelsLikeC: number | null;
  windSpeedMs: number | null;
  windDirectionDeg: number | null;
  recentPrecipitationMm: number | null;
  wetRoadChancePct: number | null;
};

export type DestinationRangeResult = {
  batteryPct: number | null;
  distanceKm: number;
  modes: Record<string, DestinationModeResult>;
  // Named to match the backend's domain vocabulary (CONTEXT.md's "Snapped route") —
  // this is the OSRM road-matched path, not the raw GPS route.
  snappedRoute: RoutePointElevation[];
  weather: WeatherConditions;
  // Set only when elevation/climb data is missing specifically because Open-Meteo's
  // free elevation API is out of its hourly quota, so the UI can say why instead of
  // reading as "this route has no elevation." Null for every other case.
  elevationUnavailableReason: string | null;
};

export const rangeEstimateApi = {
  // The backend has no Bluetooth radio, so battery/voltage are supplied by the
  // caller (the phone's own live Direct BLE reading), not fetched server-side from
  // Tuya Cloud. Both optional: absent just means every mode comes back with a null
  // estimate, same "not enough data" the UI already renders.
  // deviceId is additive, same contract as listTrips above. A device with no trip
  // history of its own gets an empty/null profile, not a silent fallback to the
  // aggregate — avoids leaking one board's efficiency numbers into another's estimate.
  // liveRiderWeightKg is the phone's raw live Health Connect rider-weight reading,
  // unfallbacked — the backend combines it with the persisted/default rider and
  // board weight itself. Omitted/null = backend uses its own fallback.
  rangeEstimate: (params?: {
    batteryPct?: number | null;
    voltageV?: number | null;
    deviceId?: string | null;
    liveRiderWeightKg?: number | null;
  }) => {
    const query = new URLSearchParams();
    if (params?.batteryPct != null) query.set('batteryPct', String(params.batteryPct));
    if (params?.voltageV != null) query.set('voltageV', String(params.voltageV));
    if (params?.deviceId) query.set('deviceId', params.deviceId);
    if (params?.liveRiderWeightKg != null) query.set('liveRiderWeightKg', String(params.liveRiderWeightKg));
    const qs = query.toString();
    return request<{
      batteryPct: number | null;
      // Voltage-curve-derived state of charge — continuous resolution, not Tuya's
      // coarse whole-integer battery_percentage (see backend/app/services/battery_soc.py).
      batteryPctEstimatedFromVoltage: number | null;
      modes: Record<
        string,
        {
          estimatedRangeKm: number | null;
          // Heuristic confidence band — widens with no history, narrows as
          // sampleTripCount grows; the UI shows "20-25km" from these two.
          estimatedRangeKmLow: number | null;
          estimatedRangeKmHigh: number | null;
          estimatedRangeKmVoltage: number | null;
          estimatedMinutesLeft: number | null;
          batteryPctPerKm: number | null;
          avgSpeedKmh: number | null;
          maxSpeedKmh: number | null;
          sampleTripCount: number;
        }
      >;
    }>(`/range-estimate${qs ? `?${qs}` : ''}`);
  },

  // Routes a real A→B path server-side (self-hosted OSRM + Open-Meteo elevation +
  // weather) and returns per-mode reachability plus the decimated route polyline for
  // drawing. 503 when OSRM isn't configured; 400 when the destination is absurdly
  // far for an e-scooter trip — both surfaced as Error by request().
  rangeEstimateToDestination: (params: {
    startLat: number;
    startLon: number;
    destLat: number;
    destLon: number;
    batteryPct?: number | null;
    voltageV?: number | null;
    liveRiderWeightKg?: number | null;
    // User-entered board battery capacity (Settings) — the backend uses its server
    // default when omitted.
    batteryCapacityWh?: number | null;
    deviceId?: string | null;
  }) => {
    const query = new URLSearchParams();
    query.set('startLat', String(params.startLat));
    query.set('startLon', String(params.startLon));
    query.set('destLat', String(params.destLat));
    query.set('destLon', String(params.destLon));
    if (params.batteryPct != null) query.set('batteryPct', String(params.batteryPct));
    if (params.voltageV != null) query.set('voltageV', String(params.voltageV));
    if (params.liveRiderWeightKg != null) query.set('liveRiderWeightKg', String(params.liveRiderWeightKg));
    if (params.batteryCapacityWh != null) query.set('batteryCapacityWh', String(params.batteryCapacityWh));
    if (params.deviceId) query.set('deviceId', params.deviceId);
    const qs = query.toString();
    return request<DestinationRangeResult>(`/range-estimate/to-destination${qs ? `?${qs}` : ''}`, { method: 'POST' });
  },
};
