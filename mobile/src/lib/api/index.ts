// Barrel for the backend HTTP client — request logic lives in client.ts and the per-resource modules; this just re-exports.
import { healthApi } from '@/lib/api/health';
import { tripsApi } from '@/lib/api/trips';
import { rangeEstimateApi } from '@/lib/api/rangeEstimate';
import { logsApi, type LogEntry } from '@/lib/api/logs';
import { authApi, type LoginResponse, type MeResponse } from '@/lib/api/auth';
import { appReleaseApi, type LatestRelease } from '@/lib/api/appRelease';
import {
  devicesApi,
  PRODUCT_FAMILIES,
  DEFAULT_BRAND,
  type BoardCatalogEntry,
  type DeviceSetting,
  type DeviceSettingUpsert,
  type ProductFamily,
} from '@/lib/api/devices';

export {
  getUseCustomServer,
  setUseCustomServer,
  getServerAddress,
  setServerAddress,
  getSessionToken,
  setSessionToken,
  clearSessionToken,
  onSessionExpired,
  ApiNotConfiguredError,
} from '@/lib/api/client';

export type { TripSummary, TripDetail, DeletedTripSummary, InProgressTripPayload } from '@/lib/types';

export {
  healthApi,
  tripsApi,
  rangeEstimateApi,
  logsApi,
  authApi,
  devicesApi,
  appReleaseApi,
  PRODUCT_FAMILIES,
  DEFAULT_BRAND,
  type LogEntry,
  type LoginResponse,
  type MeResponse,
  type DeviceSetting,
  type DeviceSettingUpsert,
  type BoardCatalogEntry,
  type ProductFamily,
  type LatestRelease,
};

// The single `api` object every caller imports, assembled from the per-resource modules above.
export const api = {
  ...healthApi,
  ...tripsApi,
  ...rangeEstimateApi,
  ...logsApi,
  ...authApi,
  ...devicesApi,
  ...appReleaseApi,
};

export type BoardSnapshot = {
  online: boolean;
  deviceName: string | null;
  speedKmh: number | null;
  batteryPct: number | null;
  // Remote controller's own battery (dp102), distinct from the board's dp3 battery above.
  remoteBatteryPct: number | null;
  mileageOnceKm: number | null;
  mileageTotalKm: number | null;
  rideTimeOnceSec: number | null;
  voltageV: number | null;
  mode: string | null;
  headlightOn: boolean | null;
  cruiseOn: boolean | null;
  lockOn: boolean | null;
  unit: string | null;
};
